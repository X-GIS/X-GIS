// ═══ Data-driven fill on the RHI path — the variant Material + per-tile feat_data ═══
//
// #1592. On the RHI/WebGL2 backend there was no mechanism by which a per-feature
// fill colour could reach a pixel: `renderFillsRhi` built ONE fill Material from
// `emitPolygonWgsl(null, …)` / `emitPolygonGlslStages(null, …)`, and its bind group
// carried a single `uniform` entry — so the only colour sink was the CPU-resolved
// `u.fill_color`, which is null by construction for `fill match(…)`. This owner is
// that missing half: the per-VARIANT Material (the composed fill expression, in the
// language THIS device reads) and the per-TILE feat_data buffer the expression
// indexes by the stride-28 vertex `feature_id`.
//
// WHY IT WORKS HERE NOW AND DID NOT BEFORE. WebGL2 has no storage buffers, and the
// composer emits feat_data as a storage binding. #1647/#1648 closed that: the GLSL
// backend lowers storage bindings to data textures by default, so
// `emitPolygonGlslStages(variantWithFeatData, false)` emits both stages with no
// opt-in flag and the fragment reads `feat_data` through `texelFetch`. The same
// lowering is what already carries the tile-point path's three storage buffers
// (point-material.ts) — this is that proven route applied to the fill.
//
// IT DOES NOT GO THROUGH pipeline-factory. That factory's `webgl2` early return
// (#834 S4's inert GL2_VARIANT_SENTINEL) governs the WebGPU-NATIVE per-style
// pipelines; the RHI fill draw resolves its pipeline from the `Material` instead
// (`executeItems`), so the variant program is built here and the sentinel stays
// untouched. Removing that return would build native pipelines against a device
// this backend does not have.
//
// WHAT IS STILL NOT SUPPORTED, and loudly: a variant that samples the PALETTE
// atlas (`gradient()` / `categorical()` — `fillUsesPalette`, `paletteColorGradients`,
// `paletteScalarGradients`) or routes paint through a COMPUTE kernel. Both need
// resources this path does not bind yet (the atlas upload is skipped on webgl2 in
// map.ts, and the compute output buffers come from a WebGPU-only dispatcher), and a
// Material whose group omits them would fail to link rather than draw wrong.
// `rhiVariantFillSupported` is that fence, and the caller keeps #1583's warning for
// everything behind it — a narrower gap, still named, never silent.

import type { RhiBindGroup, RhiBindLayoutEntry, RhiBuffer, RhiDevice } from '@xgis/engine'
import type { Material } from '@xgis/engine'
import { emitPolygonWgsl, emitPolygonGlslStages } from '../shaders/dsl/polygon'
import { buildFlatFillMaterials, type FillMaterialInputs } from './material/polygon-fill-material'
import { wgslFor, glslStagesFor } from './material/wgsl-for'
import { toComposerVariant } from './polygon-shader-cache'
import { packPerTileFeatureData } from './feature-data-pack'
import { polygonUniformBytes } from './polygon-uniform-slots'
import type { ShaderVariantInfo } from './renderer-types'

/** Can this variant's fill be drawn by the RHI variant path?
 *
 *  True requires BOTH halves to be reachable: a composed fill expression (a variant
 *  that `toComposerVariant` reduces to null is the default-uniform shader, which the
 *  plain fill Material already draws) and no resource this path cannot bind — the
 *  palette atlas or a compute kernel's output. Exported so the caller can keep the
 *  #1583 warning pointed at exactly the residue. */
export function rhiVariantFillSupported(v: ShaderVariantInfo | null | undefined): boolean {
  if (!v || v.fillIsDefault) return false
  if (!toComposerVariant(v)) return false
  if (v.fillUsesPalette || v.strokeUsesPalette) return false
  if (v.paletteColorGradients.length > 0 || v.paletteScalarGradients.length > 0) return false
  if ((v.computeBindings?.length ?? 0) > 0) return false
  return true
}

/** The bind-group shape of the variant fill Material. Binding 0 is the shared
 *  polygon Uniforms ring (dynamic — one slot per tile draw, exactly as the plain
 *  fill Material binds it); binding 1 is feat_data, present only when the variant
 *  actually indexes it. The entry is NAMED because WebGL2 pairs reflection entries
 *  by name, not by order (#783) — an unnamed storage entry would silently bind to
 *  whichever sampler the linker happened to order first. */
function groupsFor(needsFeat: boolean): RhiBindLayoutEntry[][] {
  const entries: RhiBindLayoutEntry[] = [
    { binding: 0, kind: 'uniform', dynamic: true, name: 'Uniforms' },
  ]
  if (needsFeat) entries.push({ binding: 1, kind: 'storage', name: 'feat_data' })
  return [entries]
}

export class RhiFillVariantPath {
  /** Variant Materials, keyed by the compiler's pipeline cache key. That key already
   *  uniquely identifies a variant's emitted shader (it keys the WGSL memo in
   *  polygon-shader-cache), so one Material per key is exactly one per distinct
   *  program — a style with three data-driven layers links three, not one per frame. */
  private readonly mats = new Map<string, Material>()
  /** Per-tile feat_data, keyed `${variantKey}|${tileKey}:${sliceLayer}`. The variant
   *  key is IN the key because the packed rows are a function of that variant's
   *  `featureFields` order — two layers over the same tile with different fields pack
   *  different bytes, and sharing one buffer would feed one of them the other's
   *  columns. The tail is verbatim the store's eviction `handleKey`, so `releaseTile`
   *  is a suffix match against the key the eviction path already hands out. */
  private readonly tiles = new Map<string, { feat: RhiBuffer; ring: RhiBuffer; bg: RhiBindGroup }>()

  constructor(
    private readonly rhi: RhiDevice,
    private readonly format: string,
    /** The POLYGON_FILL vertex layout, converted by the CALLER. This module holds no
     *  `@xgis/rhi-webgpu` import on purpose — map/src reaches the concrete backend
     *  only at the root (the #991 adapter ratchet), and the renderer already has the
     *  converted layout for its plain fill Material. The type is DERIVED from the
     *  builder this value is handed to rather than restated: restating it would both
     *  name a raw-WebGPU type here (#991's other ratchet) and open a second authority
     *  for one shape. */
    private readonly vertexLayout: NonNullable<FillMaterialInputs['vertexLayout']>,
  ) {}

  /** The GROUND fill Material for this variant, or null when the variant is not
   *  drawable here (`rhiVariantFillSupported`).
   *
   *  GROUND, not flat, for the reason the plain twin documents: render() substitutes
   *  the depth-disabled ground pipeline for every flat fill when nothing extrudes, so
   *  a depth-testing twin would let the fragment's per-feature depth jitter — not
   *  style order — decide which of two overlapping fills survives. */
  materialFor(variant: ShaderVariantInfo | null | undefined): Material | null {
    if (!rhiVariantFillSupported(variant)) return null
    const v = variant!
    const hit = this.mats.get(v.key)
    if (hit) return hit
    const composed = toComposerVariant(v)
    const mat = buildFlatFillMaterials({
      rhi: this.rhi,
      shader: wgslFor(this.rhi, () => emitPolygonWgsl(composed, false)),
      ...glslStagesFor(this.rhi, () => emitPolygonGlslStages(composed, false)),
      format: this.format,
      sampleCount: 1,
      rhiGroups: groupsFor(v.needsFeatureBuffer),
      vertexLayout: this.vertexLayout,
      pickEnabled: false,
    }).ground
    this.mats.set(v.key, mat)
    return mat
  }

  /** The bind group for ONE tile's draw: the shared uniform ring plus this tile's
   *  feat_data. Built once per (variant, slice, tile) and rebuilt when the ring
   *  buffer identity changes — a ring GROW swaps `rhiBuffer`, and a group still
   *  pointing at the retired buffer would draw a stale tile's uniforms (the
   *  iter-349 "land flashes water-blue" class, which is why the plain fill twin
   *  re-keys on `buf` too).
   *
   *  Returns null when the tile has no packable feature data — the caller skips that
   *  tile rather than drawing it through a group with an unbound storage entry. */
  tileBindGroup(
    mat: Material,
    ring: RhiBuffer,
    variant: ShaderVariantInfo,
    sliceLayer: string,
    tileKey: number,
    featureProps: ReadonlyMap<number, Record<string, unknown>> | undefined,
  ): RhiBindGroup | null {
    if (!variant.needsFeatureBuffer) {
      // No feat_data in this variant's group — the uniform-only group is
      // ring-scoped, so cache it under the variant alone.
      return this.uniformOnlyGroup(mat, ring, variant.key)
    }
    const cacheKey = `${variant.key}|${tileKey}:${sliceLayer}`
    const cached = this.tiles.get(cacheKey)
    if (cached && cached.ring === ring) return cached.bg
    const packed = packPerTileFeatureData(
      featureProps,
      variant.featureFields,
      variant.categoryOrder,
    )
    if (!packed) return null
    // Reuse the tile's existing buffer across a ring grow — only the GROUP is stale
    // there, and the packed bytes are identical.
    const feat =
      cached?.feat ??
      this.rhi.createBuffer({
        size: Math.max(packed.data.byteLength, 16),
        usage: 'storage',
        writable: true,
        label: `rhi-fill-feat-${sliceLayer}-${tileKey}`,
      })
    if (!cached) this.rhi.writeBuffer(feat, 0, packed.data)
    const bg = this.rhi.createBindGroup(mat.layout(0), [
      { binding: 0, resource: { buffer: ring, offset: 0, size: polygonUniformBytes() } },
      { binding: 1, resource: { buffer: feat } },
    ])
    this.tiles.set(cacheKey, { feat, ring, bg })
    return bg
  }

  /** Group cache for a variant that composes a fill expression but reads no
   *  per-feature data (a zoom-only / constant-folded variant): same single uniform
   *  entry as the plain fill twin, but against the VARIANT Material's layout. */
  private readonly uniformOnly = new Map<string, { ring: RhiBuffer; bg: RhiBindGroup }>()
  private uniformOnlyGroup(mat: Material, ring: RhiBuffer, variantKey: string): RhiBindGroup {
    const hit = this.uniformOnly.get(variantKey)
    if (hit && hit.ring === ring) return hit.bg
    const bg = this.rhi.createBindGroup(mat.layout(0), [
      { binding: 0, resource: { buffer: ring, offset: 0, size: polygonUniformBytes() } },
    ])
    this.uniformOnly.set(variantKey, { ring, bg })
    return bg
  }

  /** Drop one tile's feat_data across every variant that packed it. Takes the store's
   *  own eviction `handleKey` (`${tileKey}:${sliceLayer}`) — the buffers are per-tile
   *  and would otherwise outlive the tile they describe for the life of the map. */
  releaseTile(handleKey: string): void {
    const suffix = `|${handleKey}`
    for (const [k, v] of this.tiles) {
      if (k.endsWith(suffix)) {
        this.rhi.destroyBuffer(v.feat)
        this.tiles.delete(k)
      }
    }
  }

  destroy(): void {
    for (const v of this.tiles.values()) this.rhi.destroyBuffer(v.feat)
    this.tiles.clear()
    this.uniformOnly.clear()
    for (const m of this.mats.values()) m.destroy()
    this.mats.clear()
  }
}
