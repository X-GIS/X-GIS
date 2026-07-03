// ═══ FeatureDataBinder — data-driven feature buffer + per-tile feature
//     bind groups + compute paint dispatch ═══
//
// Extracted from VectorTileRenderer (Cluster D per
// .omc/plans/vtr-decomposition-2026-06-09.md §1 + the U2/U3/U4
// re-sequencing decision .omc/plans/vtr-u2-u4-resequence-2026-06-09.md,
// where this lands FIRST as "U2-prime"). This owner holds the FEATURE
// half of the bind-group rebuild: the source-level data-driven feature
// buffer, the per-tile feature bind-group construction (MVT/PMTiles
// 0-based featId space), the per-tile `ComputeLayerHandle` lifetime, and
// the compute-paint dispatch.
//
// VTR injects it as `private readonly _featureBinder = new
// FeatureDataBinder(device)` and keeps THIN FORWARDERS for the external
// callers (`buildFeatureDataBuffer`/`setComputePlan`/`hasFeatureData` from
// map.ts, `dispatchComputePass` from render-loop.ts) so their signatures
// are unchanged.
//
// THE CRITICAL SEAM — `rebuildPerTileGroups` is the entangled half of the
// iter-349 stale-colour fix ("land flashes water-blue at high pitch"). It
// is CALLED by VTR's `rebuildTileBindGroups` (the SINGLE `UniformRing.onGrow`
// trigger) — the binder NEVER registers its own onGrow handler and NEVER
// stores a back-reference to VTR or its gpuCache. The cached-tiles iterator,
// the current ring buffer, and the palette/sprite resources arrive as CALL
// ARGUMENTS. The compute-output entries (`handle.getBindGroupEntries()`)
// stay LAST in the entries array. Pinned by `feature-bindgroup-rebuild.test.ts`.

import { ComputeDispatcher } from '@xgis/engine'
import { ComputeLayerHandle } from './compute-layer-handle'
import type { ShaderVariant } from '@xgis/compiler'
import type { GPUTile } from './vector-tile-renderer-types'
import { polygonUniformSlots } from './polygon-uniform-slots'

// Bind-group binding range size for binding 0 (the uniform ring). Derived
// lazily from reflect(buildPolygonModule()) — the SAME IR the shader is emitted
// from — so a struct change reflows the bind size automatically. NOT a hand
// constant: hand constants silently diverge when the DSL struct grows.
function uniformSize(): number {
  return polygonUniformSlots().slots * 4
}

/** Palette / sprite atlas resources passed per-call into the per-tile
 *  rebuild + carried at `buildPerTileFeatureData` time. These live on VTR
 *  (Cluster C, extracted later); the binder receives them as arguments so
 *  it never holds a VTR reference. All three are required to build a valid
 *  feature bind group (palette bindings 2/4, sprite binding 5) — a null in
 *  any of them short-circuits the rebuild (setup-time call before the atlas
 *  is wired). */
export interface PaletteResources {
  paletteColorAtlasView: GPUTextureView | null
  paletteSampler: GPUSampler | null
  spriteAtlasView: GPUTextureView | null
}

/** #723 — stable, tile-independent categorical palette id. FNV-1a of the
 *  value, masked to 23 bits so it round-trips EXACTLY through the f32
 *  `feat_data` slot (f32 mantissa is 24 bits); the `categorical()` shader
 *  applies `% <palette>` (shader-gen.ts:227) to land it in a palette slot.
 *  The prior code used the ALPHABETICAL RANK of the values present in a
 *  single tile, so the same value mapped to a different slot depending on
 *  which other values shared the tile — a `categorical()` fill therefore
 *  changed colour across zoom/pan (issue #723). An id that is a pure
 *  function of the value is identical in every tile by construction. */
export function stableCategoryId(v: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < v.length; i++) h = Math.imul(h ^ v.charCodeAt(i), 0x01000193)
  return (h >>> 0) & 0x7fffff
}

/** Build a value→id map for a `categorical()` field that has NO compile-time
 *  `categoryOrder` (i.e. the palette path, not `match()`). The id is
 *  `stableCategoryId(value)` — a pure function of the value, NOT the
 *  per-tile / per-source rank. Shared by the per-tile and source-level
 *  packers so both agree on a value's colour. See #723. */
export function buildCategoryMap(values: Iterable<string>): Map<string, number> {
  const map = new Map<string, number>()
  for (const v of values) if (!map.has(v)) map.set(v, stableCategoryId(v))
  return map
}

export class FeatureDataBinder {
  private device: GPUDevice

  // Global feature data buffer (GeoJSON path: one PropertyTable per
  // source covers all sub-tiles since featIds are global). MVT/PMTiles
  // path keeps this null and builds per-tile featureDataBuffer / bind
  // group on tile upload instead — each PMTiles tile carries its own
  // 0-based featId space, so a shared source-level table can't index.
  private featureDataBuffer: GPUBuffer | null = null
  private _featureBindGroupLayout: GPUBindGroupLayout | null = null

  // Latest data-driven variant requirements captured when a show with
  // `needsFeatureBuffer` binds to this renderer (via
  // `buildFeatureDataBuffer` or the per-tile equivalent). Used at tile
  // upload time so the worker-emitted `data.featureProps` can be packed
  // into a per-tile feat_data buffer indexed by the polygon vertex
  // stride-8 `fid`. Empty when no data-driven paint expr is wired.
  private latestVariantFields: readonly string[] = []
  private latestVariantCategoryOrder: Record<string, readonly string[]> = {}
  /** Compute path (P4) — captured at `buildFeatureDataBuffer` time
   *  when the show's variant carries `computeBindings`. Drives
   *  per-tile `ComputeLayerHandle` construction inside
   *  `buildPerTileFeatureData`. All three null when the variant has
   *  no compute paint (legacy path, no behaviour change). */
  private latestVariant: ShaderVariant | null = null
  private latestComputePlan: readonly import('@xgis/compiler').ComputePlanEntry[] | undefined
  private latestRenderNodeIndex: number | undefined
  /** Per-tile compute handles for THIS VTR's variant. Keyed by the
   *  `tileKey:sourceLayer` string the tile uploader already uses for
   *  the layer cache, so handle lifetime tracks the tile's bind
   *  group lifetime. Cleared from `destroy()` + on tile eviction. */
  private computeHandlesByTile = new Map<string, ComputeLayerHandle>()
  /** Singleton ComputeDispatcher shared by every per-tile handle.
   *  Lazy-created on first compute-variant attach so non-compute
   *  scenes don't pay any allocation. */
  private computeDispatcher: ComputeDispatcher | null = null

  constructor(device: GPUDevice) {
    this.device = device
  }

  /** The captured data-driven feature bind-group layout, or null before a
   *  variant has bound. Read by VTR's base `rebuildTileBindGroups` to
   *  compose `tileBgFeature` (a forward C→D read). */
  featureBindGroupLayout(): GPUBindGroupLayout | null {
    return this._featureBindGroupLayout
  }

  /** The source-level feature data buffer (GeoJSON path), or null in the
   *  MVT/PMTiles per-tile path. Read by VTR's base `rebuildTileBindGroups`
   *  to compose `tileBgFeature`. */
  featureDataBufferHandle(): GPUBuffer | null {
    return this.featureDataBuffer
  }

  /** Number of captured data-driven feature fields. Read by VTR's render
   *  skip-check (`=== 0` means no MVT per-tile feature path is wired). */
  latestVariantFieldsLength(): number {
    return this.latestVariantFields.length
  }

  /** Hand the scene's compute plan to the binder so per-tile feature
   *  uploads can attach a `ComputeLayerHandle`. The renderNodeIndex
   *  is intentionally NOT captured here — it's captured atomically
   *  with the variant inside `buildFeatureDataBuffer` so the two
   *  can't drift across shows that share a VTR (the previous design
   *  let a non-compute show's setComputeContext mutate
   *  latestRenderNodeIndex while latestVariant still pointed at a
   *  prior compute show — variant.computeBindings.length=1 + plan
   *  filter at non-matching idx = 0 → ComputeLayerHandle throw). */
  setComputePlan(plan: readonly import('@xgis/compiler').ComputePlanEntry[] | undefined): void {
    this.latestComputePlan = plan
  }

  /** Run every attached compute kernel onto the encoder. Call ONCE
   *  per frame from the orchestrator (map.ts) BEFORE the first
   *  beginRenderPass — the fragment shader reads the kernel's output
   *  buffer at draw time and must see populated data.
   *
   *  No-op when no compute handle is attached (every legacy non-
   *  compute VTR call site stays at zero cost). */
  dispatchComputePass(
    encoder: GPUCommandEncoder,
    timestampWritesProvider?: { computeWrites(): GPUComputePassTimestampWrites | null } | null,
  ): void {
    if (this.computeHandlesByTile.size === 0) return
    for (const handle of this.computeHandlesByTile.values()) {
      handle.dispatch(encoder, timestampWritesProvider)
    }
  }

  hasFeatureData(): boolean {
    return this.featureDataBuffer !== null
  }

  /** Recreate every cached per-tile feature bind group against the
   *  CURRENT uniform ring + feature data buffer (+ stable compute output
   *  entries). Called from VTR's `rebuildTileBindGroups` so a uniform-ring
   *  grow doesn't strand data-driven tiles on the retired ring. The cached
   *  tiles iterator (`gpuCache`), the current `ringBuf`, and the palette
   *  resources arrive as arguments — the binder never references VTR. No-op
   *  until the atlas/palette resources are wired or when no per-tile groups
   *  exist (setup-time calls hit an empty cache). Grows are rare (ring
   *  capacity doubles + persists), so the O(cached tiles) cost is paid
   *  at most once per capacity level. */
  rebuildPerTileGroups(
    gpuCache: Map<string, Map<number, GPUTile>>,
    ringBuf: GPUBuffer | null | undefined,
    palette: PaletteResources,
  ): void {
    if (
      !ringBuf ||
      !this._featureBindGroupLayout ||
      !palette.paletteColorAtlasView ||
      !palette.paletteSampler ||
      !palette.spriteAtlasView
    )
      return
    for (const [sourceLayer, layerCache] of gpuCache) {
      for (const [tileKey, tile] of layerCache) {
        if (!tile.featureBindGroup || !tile.featureDataBuffer) continue
        // Compute output buffers (binding 16+) are unaffected by a ring
        // grow; re-fetch from the per-tile handle so the entry list
        // matches what buildPerTileFeatureData produced.
        const handle = this.computeHandlesByTile.get(`${tileKey}:${sourceLayer}`)
        const compEntries = handle?.getBindGroupEntries() ?? []
        tile.featureBindGroup = this.device.createBindGroup({
          label: 'per-tile-feature-bg',
          layout: this._featureBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: ringBuf, offset: 0, size: uniformSize() } },
            { binding: 1, resource: { buffer: tile.featureDataBuffer } },
            { binding: 2, resource: palette.paletteColorAtlasView },
            { binding: 4, resource: palette.paletteSampler },
            { binding: 5, resource: palette.spriteAtlasView },
            { binding: 6, resource: palette.paletteSampler },
            ...compEntries,
          ],
        })
      }
    }
  }

  /** Build per-feature GPU storage buffer from PropertyTable. Returns
   *  `true` when a source-level `featureDataBuffer` was (re)built so VTR
   *  rebuilds `tileBgFeature` against it; `false` on the MVT/PMTiles path
   *  (no source PropertyTable — per-tile buffers handle it on uploadTile),
   *  matching the original early-return-before-rebuild behaviour. */
  buildFeatureDataBuffer(
    variant: ShaderVariant,
    featureBindGroupLayout: GPUBindGroupLayout,
    propertyTable: import('@xgis/compiler').PropertyTable | undefined,
    renderNodeIndex?: number,
  ): boolean {
    // Capture variant requirements regardless of PropertyTable state so
    // the per-tile feature-buffer path (MVT/PMTiles) has the field list
    // + categoryOrder needed at tile upload time. Without this, MVT
    // tiles with featureProps had no schema to pack and rendered as
    // missing fills (OFM Bright landuse `class` match).
    this.latestVariantFields = variant.featureFields
    this.latestVariantCategoryOrder =
      (variant.categoryOrder as Record<string, readonly string[]>) ?? {}
    this._featureBindGroupLayout = featureBindGroupLayout
    // Capture variant + renderNodeIndex ATOMICALLY when the show's
    // paint routes through the P4 compute path. Per-tile handle
    // construction in `buildPerTileFeatureData` reads BOTH and
    // throws on drift — capturing them together prevents the
    // cross-show drift bug where a subsequent non-compute show
    // would mutate `latestRenderNodeIndex` while leaving
    // `latestVariant` pointing at a prior compute show's variant.
    if ((variant.computeBindings?.length ?? 0) > 0) {
      this.latestVariant = variant
      this.latestRenderNodeIndex = renderNodeIndex
    } else {
      this.latestVariant = null
      this.latestRenderNodeIndex = undefined
    }

    const table = propertyTable
    if (!table || variant.featureFields.length === 0 || table.values.length === 0) {
      // No source-level PropertyTable available (PMTiles backend leaves
      // it empty by design). Per-tile path will handle on uploadTile.
      return false
    }

    const fieldCount = variant.featureFields.length
    const featureCount = table.values.length
    const data = new Float32Array(featureCount * fieldCount)

    const catMaps = new Map<string, Map<string, number>>()
    for (const fieldName of variant.featureFields) {
      const fi = table.fieldNames.indexOf(fieldName)
      if (fi >= 0 && table.fieldTypes[fi] === 'string') {
        // PRIMARY source of category IDs: the shader's compile-time
        // pattern list (`variant.categoryOrder[field]`). Without this
        // path, the runtime fell back to "alphabetical sort of unique
        // values in THIS tile's data" — which collides with the
        // shader's IDs whenever the data is a proper subset of the
        // pattern set. For OFM Bright's compound `landuse__merged_4`
        // (cemetery/hospital/school/railway), a tile containing only
        // school features would otherwise assign school=0, matching
        // the shader's cemetery branch and painting school polygons
        // in cemetery green. With this stable map, school is always
        // ID 3 regardless of which subset of values the tile carries.
        const compileTimeOrder = variant.categoryOrder?.[fieldName]
        const map = new Map<string, number>()
        if (compileTimeOrder && compileTimeOrder.length > 0) {
          compileTimeOrder.forEach((v, i) => map.set(v, i))
          // Append any unexpected values (e.g. data has a new class the
          // style didn't author for) at the END so they map to indices
          // outside the shader's if-else range — those features fall
          // through to the fallback colour, matching the match()
          // expression's `_` default arm intent.
          const uniqueVals = new Set<string>()
          for (const row of table.values) {
            const v = row[fi]
            if (typeof v === 'string' && !map.has(v)) uniqueVals.add(v)
          }
          let next = compileTimeOrder.length
          for (const v of [...uniqueVals].sort()) map.set(v, next++)
        } else {
          // #723 — variant doesn't expose category order (shader uses the
          // `categorical()` palette, not `match()`). Assign each value a
          // STABLE palette id that is a pure function of the value
          // (stableCategoryId), identical to the per-tile packer, so a
          // categorical fill's colour never depends on which values are
          // present. (Was: per-tile/-source alphabetical rank.)
          const vals: string[] = []
          for (const row of table.values) {
            const v = row[fi]
            if (typeof v === 'string') vals.push(v)
          }
          for (const [v, id] of buildCategoryMap(vals)) map.set(v, id)
        }
        catMaps.set(fieldName, map)
      }
    }

    for (let i = 0; i < featureCount; i++) {
      const row = table.values[i]
      for (let j = 0; j < fieldCount; j++) {
        const fieldName = variant.featureFields[j]
        const fi = table.fieldNames.indexOf(fieldName)
        if (fi < 0) continue
        const val = row[fi]
        const catMap = catMaps.get(fieldName)
        if (catMap && typeof val === 'string') {
          data[i * fieldCount + j] = catMap.get(val) ?? 0
        } else {
          data[i * fieldCount + j] = typeof val === 'number' ? val : 0
        }
      }
    }

    this.featureDataBuffer = this.device.createBuffer({
      size: Math.max(data.byteLength, 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'feature-data',
    })
    this.device.queue.writeBuffer(this.featureDataBuffer, 0, data)

    console.log(`[X-GIS] Feature data buffer: ${featureCount} features × ${fieldCount} fields`)
    return true
  }

  /** Build a per-tile feat_data buffer + bind group from MVT/PMTiles
   *  worker output (`data.featureProps`). The source-level PropertyTable
   *  is permanently empty for PMTiles backends — each tile owns its
   *  own 0-based featId space, so a single shared buffer can't index
   *  them all. Returned buffer is sized by the tile's actual feature
   *  count (not a global maximum), uses the captured variant field +
   *  categoryOrder schema, and binds to the shared `uniformRing` so
   *  per-tile dynamic offsets still work.
   *
   *  Returns null when there's nothing to build (no variant captured
   *  yet, no per-tile properties, layout missing) so the caller can
   *  skip the buffer-allocate call entirely. */
  buildPerTileFeatureData(
    featureProps: ReadonlyMap<number, Record<string, unknown>> | undefined,
    ringBuf: GPUBuffer | null | undefined,
    palette: PaletteResources,
    handleKey: string = '',
  ): { buffer: GPUBuffer; bindGroup: GPUBindGroup } | null {
    if (!featureProps || featureProps.size === 0) return null
    if (this.latestVariantFields.length === 0) return null
    if (!this._featureBindGroupLayout || !ringBuf) return null

    const fields = this.latestVariantFields
    const fieldCount = fields.length
    // featId is tile-local but not necessarily contiguous (worker
    // may filter out features). Size the buffer by (max featId + 1)
    // so vertex-side `feat_data[fid]` indexing stays direct without a
    // featId → row mapping table. Unfilled slots default to 0 which
    // matches the variant shader's fallback arm.
    let maxFid = -1
    for (const fid of featureProps.keys()) {
      if (fid > maxFid) maxFid = fid
    }
    const featureCount = maxFid + 1
    if (featureCount <= 0) return null

    const data = new Float32Array(featureCount * fieldCount)

    // Per-field categorical maps — same compile-time-order-first logic
    // as the source-level path so the shader's if-else chain IDs match.
    const catMaps = new Map<string, Map<string, number>>()
    for (const fieldName of fields) {
      const order = this.latestVariantCategoryOrder[fieldName]
      const map = new Map<string, number>()
      if (order && order.length > 0) {
        order.forEach((v, i) => map.set(v, i))
        // Unknown values get IDs beyond the if-else range → fallback arm.
        const unseen = new Set<string>()
        for (const props of featureProps.values()) {
          const v = props[fieldName]
          if (typeof v === 'string' && !map.has(v)) unseen.add(v)
        }
        let next = order.length
        for (const v of [...unseen].sort()) map.set(v, next++)
      } else {
        // #723 — categorical() palette id is a pure function of the value
        // (stableCategoryId), NOT the per-tile alphabetical rank, so the
        // same value gets the same palette slot in every tile / at every
        // zoom instead of shifting with the tile's value-subset.
        const vals: string[] = []
        for (const props of featureProps.values()) {
          const v = props[fieldName]
          if (typeof v === 'string') vals.push(v)
        }
        for (const [v, id] of buildCategoryMap(vals)) map.set(v, id)
      }
      catMaps.set(fieldName, map)
    }

    for (const [fid, props] of featureProps) {
      for (let j = 0; j < fieldCount; j++) {
        const fieldName = fields[j]!
        const val = props[fieldName]
        const catMap = catMaps.get(fieldName)
        if (catMap && typeof val === 'string') {
          data[fid * fieldCount + j] = catMap.get(val) ?? 0
        } else if (typeof val === 'number') {
          data[fid * fieldCount + j] = val
        }
      }
    }
    // DEBUG: when `__xgisForceClassId` is set on globalThis, every
    // feat_data entry gets the same ID. Lets us isolate fid-mapping
    // bugs from shader-emit bugs — if every polygon paints with the
    // forced class's color, the bind path is correct and the issue is
    // upstream (worker fid vs featureProps key); if some polygons stay
    // unpainted, the issue is in the bind / shader.

    const buffer = this.device.createBuffer({
      size: Math.max(data.byteLength, 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'per-tile-feature-data',
    })
    this.device.queue.writeBuffer(buffer, 0, data)

    // mr-featureBindGroupLayout requires palette bindings 2 + 4
    // (added in P3 Step 3c). When the renderer hasn't pushed palette
    // resources yet, return null buffer so the caller falls back to
    // a non-feature pipeline rather than producing an invalid group.
    if (!palette.paletteColorAtlasView || !palette.paletteSampler || !palette.spriteAtlasView)
      return null

    // P4 compute path: when the captured variant carries
    // computeBindings, build (or refresh) a per-tile
    // ComputeLayerHandle for this (variant, tile) pair and append
    // its output buffer entries to the bind group. Legacy (no
    // computeBindings) shows skip this entirely — the bind group
    // stays at the legacy 4-entry shape.
    let extraComputeEntries: { binding: number; resource: { buffer: GPUBuffer } }[] = []
    if (
      this.latestVariant &&
      (this.latestVariant.computeBindings?.length ?? 0) > 0 &&
      this.latestComputePlan &&
      this.latestRenderNodeIndex !== undefined &&
      handleKey
    ) {
      // Lazy-init the dispatcher on first compute attach.
      if (!this.computeDispatcher) {
        this.computeDispatcher = new ComputeDispatcher({ device: this.device } as never)
      }
      // Build or refresh the handle for THIS tile.
      let handle = this.computeHandlesByTile.get(handleKey)
      if (!handle) {
        handle = new ComputeLayerHandle(
          this.computeDispatcher,
          this.latestVariant,
          this.latestComputePlan,
          this.latestRenderNodeIndex,
        )
        this.computeHandlesByTile.set(handleKey, handle)
      }
      // Upload feature props through the handle. featureProps is a
      // Map<fid, props>; the handle's packer takes a `getProps(fid)`
      // closure so we adapt.
      let maxFid = -1
      for (const fid of featureProps.keys()) if (fid > maxFid) maxFid = fid
      const featureCount = maxFid + 1
      handle!.uploadFromProps((fid: number) => featureProps.get(fid) ?? null, featureCount)
      // Append the handle's bind-group entries (compute output
      // storage buffer at binding 16 by default).
      const compEntries = handle!.getBindGroupEntries()
      if (compEntries) extraComputeEntries = compEntries
    }

    const bindGroup = this.device.createBindGroup({
      label: 'per-tile-feature-bg',
      layout: this._featureBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: ringBuf, offset: 0, size: uniformSize() } },
        { binding: 1, resource: { buffer } },
        { binding: 2, resource: palette.paletteColorAtlasView },
        { binding: 4, resource: palette.paletteSampler },
        { binding: 5, resource: palette.spriteAtlasView },
        { binding: 6, resource: palette.paletteSampler },
        ...extraComputeEntries,
      ],
    })

    return { buffer, bindGroup }
  }

  /** Free + drop the per-tile ComputeLayerHandle for an evicted tile.
   *  Keyed `${tileKey}:${sourceLayer}`. Called by VTR's `_releaseTileSlots`
   *  AFTER the tile's `featureDataBuffer` is destroyed — preserving the
   *  `7b31ce52` eviction-free order so its buffers are reclaimed and
   *  `dispatchComputePass` stops iterating over the evicted tile every
   *  frame. No-op when the tile carried no compute handle. */
  releaseTile(handleKey: string): void {
    const handle = this.computeHandlesByTile.get(handleKey)
    if (handle) {
      handle.destroy()
      this.computeHandlesByTile.delete(handleKey)
    }
  }

  /** Free + clear every per-tile ComputeLayerHandle. Called by VTR when
   *  the entire gpuCache is wiped (setLineRenderer re-upload) or torn down
   *  (destroy) — the per-tile release loops there go through arenas, not
   *  `_releaseTileSlots`, so they never touch these handles individually. */
  releaseAllComputeHandles(): void {
    for (const h of this.computeHandlesByTile.values()) h.destroy()
    this.computeHandlesByTile.clear()
  }

  /** Tear down the source-level feature data buffer. Called from VTR's
   *  `destroy()`. Compute handles are freed separately via
   *  `releaseAllComputeHandles` (ordered with the legacy buffer loop). */
  destroy(): void {
    this.featureDataBuffer?.destroy()
    this.featureDataBuffer = null
  }
}
