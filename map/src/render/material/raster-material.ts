// ═══ Raster adapter over the generic Material ═══
//
// Builds the generic Material from the raster descriptor + owns the raster-only
// bits (linear sampler, the per-texture global bind-group cache) + an inline
// builder that turns visible tiles into generic DrawItems. The pipeline/layouts/
// pool/global-uniform + the draw loop are the shared generic core (material.ts).

import type {
  RhiDevice,
  RhiBindGroup,
  RhiTexture,
  RhiTextureView,
  RhiBindLayoutEntry,
} from '@xgis/engine'
import { wrapWebGpuTextureView } from '@xgis/rhi-webgpu'
import { Material, executeItems, type DrawItem } from '@xgis/engine'
import { emitRasterWgsl, buildRasterModule, rasterGridVertexCount } from '../../shaders/dsl/raster'
import { rasterTileBytes, rasterUniformBytes } from '../raster-uniform-slots'
import { emitGlslStages } from '@xgis/shader-dsl'
import { pickedModuleGlslId, pickedModuleWgslId } from '../../shaders/baked/ids'
import { glslStagesFor, wgslFor } from './wgsl-for'

/** One raster tile to draw: its texture + 64-byte per-tile uniform. The texture is
 *  backend-agnostic: a raw `GPUTexture` (the WebGPU pilot — bridged to a view here)
 *  or an `RhiTexture` (the forced-WebGL2 path — built via `rhi.createTexture`). The
 *  draper resolves either to an `RhiTextureView` once per texture (cached). */
export interface RasterTile {
  texture: GPUTexture | RhiTexture
  tileBytes: Float32Array
  /** #1040 — this tile's surface grid subdivision N (rasterGridN). The draw count
   *  is rasterGridVertexCount(N): a globe z0 tile is 128×128, flat / high-z is 8×8.
   *  MUST equal the N packed into the per-tile uniform's `grid.x` lane. */
  gridN: number
}

// ── The raster program's bind-group shape, in ONE place (#2539) ──
//
// Written three times before this: the non-pick material, the pick material, and
// hillshade's — which is the moment ADR-0013 says to extract rather than copy again.
// It is also the correct single authority independently of the ratchet: all three run
// the SAME `vs_tile`, so a group-0 that differs between them is a bug by definition,
// and the pick variant differs from the non-pick one only in its colour targets.
//
// `vertexVisible` on the DEM pair is REQUIRED, not decorative: WebGPU checks the
// entry point's stage against the layout's visibility and rejects the pipeline outright
// — "Entry point's stage (ShaderStage::Vertex) is not in the binding visibility in the
// layout (ShaderStage::Fragment)". It is opt-IN because WebGPU counts sampled textures
// PER STAGE, so widening every texture would charge the vertex budget for bindings no
// vertex reads (rhi.ts's own reasoning; particle advection is the other caller).
//
// The DEM is in the layout whether or not a terrain source is configured: the shader
// samples it unconditionally — a per-tile branch on residency would be lane-divergent —
// and multiplies by `tile.dem_sub.w`, which is 0 when no DEM covers the tile. So the
// binding must ALWAYS be satisfiable, which is what `demStub()` exists for.
/** The DEM texture + sampler the shared `vs_tile` reads elevation from. Exported so
 *  hillshade's own group 0 carries the identical pair rather than a second copy. */
export const DEM_VERTEX_BIND_ENTRIES: readonly RhiBindLayoutEntry[] = [
  { binding: 4, kind: 'texture', name: 'dem_tex', vertexVisible: true },
  { binding: 5, kind: 'sampler', vertexVisible: true },
]
/** Group 0 of the raster program: global uniform, tile colour texture + its sampler,
 *  then the DEM pair. Both raster materials (pick and non-pick) use it verbatim. */
const RASTER_GROUP0: RhiBindLayoutEntry[] = [
  { binding: 0, kind: 'uniform' },
  { binding: 1, kind: 'texture', name: 'tex' },
  { binding: 2, kind: 'sampler' },
  ...DEM_VERTEX_BIND_ENTRIES,
]
/** Group 1: the per-tile uniform, fed from the material's pool. */
const RASTER_TILE_GROUP: RhiBindLayoutEntry[] = [{ binding: 0, kind: 'uniform' }]

export class RasterDraper {
  /** Release the GPU objects this draper owns (#1578). Called by `rebuildForQuality()`
   *  before the reference is dropped — a quality flip is live-session churn, not teardown,
   *  so nothing else would ever reclaim these. */
  destroy(): void {
    this.material.destroy()
    this._pickMaterial?.destroy()
    this._pickMaterial = undefined
    this.rhi.destroySampler(this.linearSampler.sampler)
    this.rhi.destroySampler(this.nearestSampler.sampler)
    // #2539 — the DEM stub is device-lifetime but owned HERE, so it is released
    // here; a texture created lazily and never destroyed is the same leak shape
    // `dropTexture` exists to prevent one level down.
    if (this._demStubTex) this.rhi.destroyTexture(this._demStubTex)
    this._demStubTex = null
    this._demStubView = null
    this.globalBGByTex.clear()
    this.viewByTex.clear()
  }

  private readonly material: Material // non-pick: single colour target
  // pick pass: colour + rg32uint pick MRT (writes 0 — raster isn't pickable). LAZY — built on the
  // first pick draw so the non-pick path (incl. the WebGl2 checker, which fail-closes on an
  // rg32uint MRT) never triggers the pick pipeline.
  private _pickMaterial?: Material
  private readonly linearSampler
  private readonly nearestSampler
  private _demStubTex: RhiTexture | null = null
  private _demStubView: RhiTextureView | null = null
  // Cached global bind group per texture → per `${pick}${resampling}` key. The non-pick /
  // pick Materials have distinct global uniforms + layouts, and `raster-resampling` toggles
  // the sampler, so the bind group is keyed by both.
  private readonly globalBGByTex = new Map<GPUTexture | RhiTexture, Map<string, RhiBindGroup>>()
  /** View cache keyed on the (stable) texture handle — a `GPUTexture.createView()`
   *  or `rhi.createView(rhiTex)` is made ONCE per texture, not per frame. */
  private readonly viewByTex = new Map<GPUTexture | RhiTexture, RhiTextureView>()

  constructor(
    private readonly rhi: RhiDevice,
    private readonly format: string,
    private readonly sampleCount: number,
  ) {
    // WGSL for WebGPU; split GLSL ES for WebGl2Device (createPipeline picks by backend).
    // Raster is texture-only (uniform + texture + sampler) — no storage buffers — so the
    // GLSL emit needs no data-texture emulation.
    //
    // #2539 — the second half of that sentence used to read "group 0's single UBO +
    // single texture bind correctly by ORDER (no reflection name needed)", and it was
    // true for exactly as long as there was ONE texture. The DEM makes two, and
    // rhi-webgl2 refuses the group outright rather than mis-binding it: "bind-group
    // layout has 2 sampler-uniform entries but bindings 1, 4 are unnamed — WebGL2 pairs
    // unnamed entries BY ORDER within one reflection class". Both texture entries below
    // therefore carry the shader's own reflection name.
    //
    // #1473 residue — this site kept the pre-`wgsl-for.ts` shape after every sibling
    // draper moved: it emitted the WGSL unconditionally (dead weight on a WebGL2 device)
    // and lowered the module ONCE PER STAGE. Both halves now route through the thunk
    // seam, so each device pays for exactly the language it reads and the GLSL pair
    // shares one lowering. The BYTES a WebGL2 device receives are unchanged:
    // `emitGlslStages` is byte-identical to two `emitGlslModule` calls (shader-dsl's
    // glsl-stages-parity pins it) — only which work runs changes.
    this.material = new Material(rhi, {
      shader: wgslFor(rhi, () => emitRasterWgsl(false), pickedModuleWgslId('raster', false)),
      vsEntry: 'vs_tile',
      fsEntry: 'fs_tile',
      ...glslStagesFor(rhi, () => emitGlslStages(buildRasterModule(false)), {
        vertex: pickedModuleGlslId('raster', false, 'vertex'),
        fragment: pickedModuleGlslId('raster', false, 'fragment'),
      }),
      format: format as 'bgra8unorm',
      sampleCount,
      groups: [RASTER_GROUP0, RASTER_TILE_GROUP],
      // #2134 — fs_tile now always emits PREMULTIPLIED colour (raster.ts);
      // raster_params.y (written per-caller by writeRasterFrameUniform) says
      // whether that premultiply is a real texel multiply (drape) or a no-op
      // mix(c.a,1,0)=c.a (every straight-alpha source), so BOTH source kinds
      // need this same premultiplied blend state.
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'premult' }],
      variants: [{ depthWrite: false, depthCompare: 'always', label: 'raster-pipeline-rhi' }],
      pool: { group: 1, slotSize: rasterTileBytes() }, // 48 — the canonical TileUniforms size
      // Reflect-derived (was a hardcoded 160) so it tracks the 'Uniforms' struct —
      // it grew 160→176 for the DSFUN cam_ecef_center_l low half (z18+ raster-jitter
      // fix) and a stale literal here would under-size the UBO and truncate the write.
      globalUniformSize: rasterUniformBytes(),
    })
    // #1436 — trilinear + anisotropic. `mipmap: 'linear'` blends BETWEEN levels (without it a
    // chain still bands at the level switch); anisotropy is what keeps the horizon sharp rather
    // than mush, because a pixel at pitch covers a long thin ellipse in texel space and an
    // isotropic tap must blur the long axis down to the short one. 16 is the WebGPU floor and
    // the point past which the visual return is nil; the WebGL2 twin clamps to its driver and
    // degrades to plain trilinear where the extension is missing.
    this.linearSampler = {
      sampler: rhi.createSampler({
        mag: 'linear',
        min: 'linear',
        mipmap: 'linear',
        maxAnisotropy: 16,
      }),
    }
    this.nearestSampler = { sampler: rhi.createSampler({ mag: 'nearest', min: 'nearest' }) }
  }

  /** The 1×1 DEM every draw binds when no elevation covers it (D5 INC-3, #2539).
   *
   *  Its CONTENT does not matter and that is the point: `tile.dem_sub.w` is 0 in
   *  exactly the cases this is bound, so whatever decodes out of it is multiplied by
   *  0.0 before it reaches a vertex. It exists to satisfy WebGPU's "every binding in
   *  the layout must be filled" rule — the same job `pipeline-factory.ts`'s palette
   *  stub does — not to supply a height. All-zero bytes rather than a sentinel so a
   *  read that somehow escaped the multiply would be a flat surface, not a spike.
   *
   *  Device-lifetime and created on first draw, so a map with no raster layer never
   *  allocates it. */
  private demStub(): RhiTextureView {
    if (!this._demStubView) {
      const tex = this.rhi.createTexture({
        width: 1,
        height: 1,
        format: 'rgba8unorm',
        usage: ['sample', 'copy-dst'],
        label: 'raster-dem-stub',
      })
      this.rhi.writeTexture(tex, new Uint8Array([0, 0, 0, 255]), 4, 1, 1)
      this._demStubTex = tex
      this._demStubView = this.rhi.createView(tex)
    }
    return this._demStubView
  }

  /** Lazily build the pick-pass Material (colour + rg32uint MRT). Deferred so the non-pick path —
   *  including the WebGl2 checker, which fail-closes on an rg32uint MRT — never builds it.
   *
   *  #1473 residue — this site additionally built the pick module TWICE (once per stage);
   *  it is built once and lowered once now. Same thunk seam, same byte-for-byte GLSL. */
  private pickMat(): Material {
    return (this._pickMaterial ??= new Material(this.rhi, {
      shader: wgslFor(this.rhi, () => emitRasterWgsl(true), pickedModuleWgslId('raster', true)),
      vsEntry: 'vs_tile',
      fsEntry: 'fs_tile',
      ...glslStagesFor(this.rhi, () => emitGlslStages(buildRasterModule(true)), {
        vertex: pickedModuleGlslId('raster', true, 'vertex'),
        fragment: pickedModuleGlslId('raster', true, 'fragment'),
      }),
      format: this.format as 'bgra8unorm',
      sampleCount: this.sampleCount,
      groups: [RASTER_GROUP0, RASTER_TILE_GROUP],
      // #2134 — pick twin of the colour-target blend fix above; same fs_tile,
      // same premultiplied emit.
      colorTargets: [
        { format: this.format as 'bgra8unorm', blend: 'premult' },
        { format: 'rg32uint' },
      ],
      variants: [{ depthWrite: false, depthCompare: 'always', label: 'raster-pick-pipeline-rhi' }],
      pool: { group: 1, slotSize: rasterTileBytes() }, // 48 — the canonical TileUniforms size
      // Reflect-derived (was a hardcoded 160) so it tracks the 'Uniforms' struct —
      // it grew 160→176 for the DSFUN cam_ecef_center_l low half (z18+ raster-jitter
      // fix) and a stale literal here would under-size the UBO and truncate the write.
      globalUniformSize: rasterUniformBytes(),
    }))
  }

  /** Resolve a tile texture to an RHI view, once per texture. A WebGPU `GPUTexture`
   *  is bridged via `wrapWebGpuTextureView(createView())`; an `RhiTexture` (forced-
   *  WebGL2) goes through `rhi.createView`. Discriminated by the presence of the native
   *  `.createView` method — the `__rhi` brand is COMPILE-TIME only (the runtime WebGl2Device
   *  handle has no such property), so `'__rhi' in texture` is always false at runtime. */
  private viewOf(texture: GPUTexture | RhiTexture): RhiTextureView {
    let view = this.viewByTex.get(texture)
    if (!view) {
      view =
        typeof (texture as { createView?: unknown }).createView === 'function'
          ? wrapWebGpuTextureView((texture as GPUTexture).createView())
          : this.rhi.createView(texture as RhiTexture)
      this.viewByTex.set(texture, view)
    }
    return view
  }

  private globalBG(
    material: Material,
    texture: GPUTexture | RhiTexture,
    nearest: boolean,
    pick: boolean,
  ): RhiBindGroup {
    let m = this.globalBGByTex.get(texture)
    if (!m) {
      m = new Map()
      this.globalBGByTex.set(texture, m)
    }
    const key = `${pick ? 'p' : 'n'}${nearest ? 'N' : 'L'}`
    let bg = m.get(key)
    if (!bg) {
      bg = this.rhi.createBindGroup(material.layout(0), [
        { binding: 0, resource: { buffer: material.globalUniform! } },
        { binding: 1, resource: { view: this.viewOf(texture) } },
        { binding: 2, resource: nearest ? this.nearestSampler : this.linearSampler },
        // #2539 — raster imagery has no DEM of its own yet (draping imagery over
        // terrain is the next increment), so this is always the stub; the sampler is
        // NEAREST because a bilinear blend of PACKED DEM bytes decodes to garbage,
        // and pinning it here means the sampler is right by construction the day a
        // real DEM arrives rather than by remembering to change it.
        { binding: 4, resource: { view: this.demStub() } },
        { binding: 5, resource: this.nearestSampler },
      ])
      m.set(key, bg)
    }
    return bg
  }

  /** Invalidate a texture's cached view + global bind group(s). EVERY owner that
   *  destroys a tile / bake texture (raster evict, drape re-bake / evict / destroy)
   *  MUST call this: `viewByTex` / `globalBGByTex` are keyed by the texture OBJECT,
   *  so without invalidation they are append-only and retain a dead view + bind
   *  group per destroyed texture — an unbounded per-texture leak, and a latent
   *  aliasing hazard the instant a texture source ever hands back a recycled
   *  object (the cache would then bind that object's STALE view). Making the caches
   *  track texture lifetime keeps them correct by construction. No-op when the
   *  texture was never cached (e.g. evicted before it drew). */
  dropTexture(texture: RasterTile['texture']): void {
    this.viewByTex.delete(texture)
    this.globalBGByTex.delete(texture)
  }

  /** Build draw items from visible tiles + issue them through the generic executor.
   *  `poolBase` (#1142) offsets the per-tile pool slots: the raster tile renderer
   *  draws ALL tiles in one call per frame (base 0), but the vector drape issues
   *  one draw() PER slice-layer into the same per-frame submit and passes a
   *  frame-monotonic base so a later slice's per-tile uniforms don't overwrite an
   *  earlier slice's still-in-flight (deferred-writeBuffer) pool buffers. */
  draw(
    pass: import('@xgis/engine').RhiRenderPass,
    globalBytes: BufferSource,
    tiles: ReadonlyArray<RasterTile>,
    nearest = false,
    pick = false,
    poolBase = 0,
  ): void {
    const material = pick ? this.pickMat() : this.material
    material.writeGlobal(globalBytes)
    const items: DrawItem[] = tiles.map((t) => ({
      variant: 0,
      bindGroups: [this.globalBG(material, t.texture, nearest, pick), null],
      poolBytes: t.tileBytes,
      count: rasterGridVertexCount(t.gridN),
      indexed: false,
    }))
    executeItems(material, pass, items, poolBase)
  }
}
