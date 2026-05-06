// ═══ Vector Tile Renderer (GPU Layer) ═══
// Renders vector tiles from a TileCatalog to WebGPU.
// Data loading/caching/sub-tiling is handled by TileCatalog.
// This class manages GPU buffers, bind groups, and draw calls only.

import type { GPUContext } from './gpu'
import type { Camera } from './camera'
import type { ShowCommand } from './renderer'
import { visibleTilesFrustum, sortByPriority } from '../loader/tiles'
import { tileKey, tileKeyParent, type PropertyTable } from '@xgis/compiler'
import type { ShaderVariant } from '@xgis/compiler'
import type { TileCatalog } from '../data/tile-catalog'
import type { TileData } from '../data/tile-types'
import { mercator as mercatorProj } from './projection'
import type { PointRenderer } from './point-renderer'
import { buildLineSegments, type LineRenderer } from './line-renderer'

// ═══ Types ═══

/** Layer draw phase — replaces the prior `translucentLines: boolean` flag.
 *  'all' draws fill + stroke in one pass (opaque default).
 *  'fills'/'strokes' split across a main pass and an offscreen MAX-blend
 *  pass so translucent strokes don't accumulate alpha across overlapping
 *  geometry. 'fills' + 'strokes' together == 'all'. */
export type LayerDrawPhase = 'all' | 'fills' | 'strokes'

interface GPUTile {
  vertexBuffer: GPUBuffer
  indexBuffer: GPUBuffer
  indexCount: number
  lineVertexBuffer: GPUBuffer | null
  lineIndexBuffer: GPUBuffer | null
  lineIndexCount: number
  outlineIndexBuffer: GPUBuffer | null
  outlineIndexCount: number
  // SDF line segment buffers for polygon outlines and line features
  outlineSegmentBuffer: GPUBuffer | null
  outlineSegmentCount: number
  outlineSegmentBindGroup: GPUBindGroup | null
  lineSegmentBuffer: GPUBuffer | null
  lineSegmentCount: number
  lineSegmentBindGroup: GPUBindGroup | null
  tileWest: number
  tileSouth: number
  tileWidth: number
  tileHeight: number
  tileZoom: number
  lastUsedFrame: number
  firstShownFrame: number // for fade-in animation
}

// Per-VTR GPU tile cache cap on UNIQUE tile keys. With sliced
// sources (PMTiles N-layer) one tile = N entries × ~7 buffers.
// Capping at 256 unique keys × 4 typical layers × 7 = ~7K live GPU
// buffers — well within Chrome's tolerance now that the previous
// STATUS_BREAKPOINT root causes are fixed (vertexKey int32 overflow
// inflating vertex counts, missing per-layer decoder filter
// loading 10+ unused slices per tile, duplicate LoadCommands
// spawning 4× orphan VTRs all hammering GPU).
const MAX_GPU_TILES = 256
/** Max tiles promoted from data cache to GPU per frame. Chosen empirically:
 *  crossing a z-boundary produces ~16 newly-visible tiles, and uploading
 *  them all in one frame caused ~250 ms stalls (perf-scenarios benchmark,
 *  wb_peak 552 calls / 8.4 MB in a single frame). 3 per frame spreads the
 *  work across ~5–6 frames → worst spike drops to <50 ms with the cache
 *  reaching full visibility in ~100 ms. Raise if you see noticeable
 *  "filling in" during pans on fast connections. */
/** Per-frame tile upload cap. Bumped to 4 after the over-zoom
 *  per-layer sub-tile fix made all 4 layers actually generate
 *  sub-tiles (previously only the first one did due to the
 *  hasTileData(key) skip bug). At 4 layers × ~30 visible sub-tiles
 *  = 120 slices to upload at over-zoom; 2/frame took ~1 s to fill
 *  ≈ visible flicker as fallback gets progressively replaced.
 *  4/frame halves convergence time to ~0.5 s while keeping GPU
 *  buffer creation rate (~1700/sec) below Chrome's STATUS_BREAKPOINT
 *  threshold even under 4-layer load. */
const MAX_UPLOADS_PER_FRAME = 4

// ═══ Renderer ═══

const UNIFORM_SLOT = 256
const UNIFORM_SIZE = 160

export class VectorTileRenderer {
  private device: GPUDevice
  private source: TileCatalog | null = null

  /** Max tile level of the backing source (0 if none), for camera zoom
   *  clamping in the render loop. */
  get sourceMaxLevel(): number {
    return this.source?.maxLevel ?? 0
  }
  currentProjection: import('./projection').Projection | null = null
  /** GPU tile cache keyed by `${tileKey}|${sourceLayer}`. The `sourceLayer`
   *  segment is the MVT layer slot — '' for single-layer sources
   *  (XGVT-binary, GeoJSON-runtime, sub-tiles), MVT layer name for
   *  per-layer slices (PMTiles). One tile key may have N entries here,
   *  one per xgis layer's `sourceLayer` filter. */
  /** Nested cache: outer key = MVT source-layer slot ('' for single-
   *  layer sources), inner key = numeric tile key. Lets the per-frame
   *  hot path fetch the inner Map once per `render()` call and then
   *  do pure numeric `has`/`get` lookups, eliminating composite-string
   *  allocation in the per-tile loop (was ~1.6 k allocations/frame at
   *  z=22 over Seoul × 4 PMTiles layers). */
  private gpuCache = new Map<string, Map<number, GPUTile>>()
  /** Total entries across all inner maps. Mirrors what the old flat
   *  `gpuCache.size` reported; used by eviction trigger, cache-size
   *  diagnostics, and the setLineRenderer reset guard. */
  private _gpuCacheCount = 0
  private getLayerCache(sourceLayer: string): Map<number, GPUTile> | undefined {
    return this.gpuCache.get(sourceLayer)
  }
  private getOrCreateLayerCache(sourceLayer: string): Map<number, GPUTile> {
    let m = this.gpuCache.get(sourceLayer)
    if (!m) { m = new Map(); this.gpuCache.set(sourceLayer, m) }
    return m
  }
  private frameCount = 0
  private lastZoom = -1
  /** Hysteresis state for currentZ: persists across frames so the
   *  integer LOD doesn't oscillate when fractional zoom hovers near
   *  an integer boundary (pinch zoom can wiggle within ±0.05). See
   *  the currentZ derivation in render() for the threshold logic. */
  private _hysteresisZ = -1
  private stableKeys: number[] = []
  private uniformDataBuf = new ArrayBuffer(160)
  private uniformF32 = new Float32Array(this.uniformDataBuf) // reusable view over full uniform
  /** Reusable u32 view over the same uniform buffer — used to write
   *  `pick_id` (u32) into the trailing 16-byte slot at offset 144. */
  private uniformU32 = new Uint32Array(this.uniformDataBuf)
  private lastBindGroupLayout: GPUBindGroupLayout | null = null
  /** Uniform-only layout — stays pinned to the base `bindGroupLayout`
   *  even when `render()` swaps `lastBindGroupLayout` for a variant layout. */
  private baseBindGroupLayout: GPUBindGroupLayout | null = null
  private cachedFillColor = [0, 0, 0, 0]
  private cachedStrokeColor = [0, 0, 0, 0]
  private cachedShowFill = ''
  private cachedShowStroke = ''
  private currentOpacity = 1.0
  /** Set per render() from `show.pickId` so renderTileKeys can stamp every
   *  per-tile uniform with the layer's pick ID. 0 = unregistered (sentinel
   *  → pickAt returns null). */
  private currentPickId = 0
  /** Set per render() when the resolved fill is invisible AND no shader
   *  variant computes a per-feature fill — `renderTileKeys` skips the
   *  polygon `drawIndexed` in that case (no-op fragment work). */
  private _skipFillDraw = false
  /** Log-depth factor for the current frame, sampled from camera at the
   *  start of render(). Packed into slot 35 of every tile uniform. */
  private logDepthFc = 0

  // ── Uniform ring (dynamic-offset) ──
  // Shared across all tiles + world copies + layers in a frame. Each draw
  // gets a fresh 256-byte slot, preventing multi-layer writeBuffer clobber.
  private uniformRing: GPUBuffer | null = null
  private uniformRingCapacity = 1024 // slots — 256 KB initial
  /** Staging mirror of the uniform ring. We accumulate every tile's
   *  per-draw uniform into this CPU-side buffer during a render pass
   *  and emit ONE writeBuffer at the end instead of one-per-tile. In
   *  the fixture-audit translucent_stroke scenario the per-tile
   *  writeBuffer count dropped from ~34k to a handful per frame. */
  private uniformStaging = new Uint8Array(this.uniformRingCapacity * UNIFORM_SLOT)
  /** Inclusive-exclusive byte range that's been written to uniformStaging
   *  but not yet copied to the GPU ring. */
  private uniformDirtyLo = 0
  private uniformDirtyHi = 0
  private uniformSlot = 0
  /** Tile bind group referencing the ring with dynamic offset (uniform only). */
  private tileBgDefault: GPUBindGroup | null = null
  /** Tile bind group referencing the ring + feature storage (variant shaders). */
  private tileBgFeature: GPUBindGroup | null = null

  // SDF line renderer (set externally)
  private lineRenderer: LineRenderer | null = null

  // Global feature data buffer (shared across all tiles)
  private featureDataBuffer: GPUBuffer | null = null
  private featureBindGroupLayout: GPUBindGroupLayout | null = null

  // Per-frame draw stats
  private renderedDraws = new Map<number, { polyCount: number; lineCount: number; vertexCount: number }>()
  /** Deduped tile-drop warnings. Key format: "<reason>:<z>/<x>/<y>". Once
   *  per session per key; prevents flood when panning/zooming over an area
   *  that has no data at the current level. */
  private tileDropWarnings = new Set<string>()
  private _missedTiles = 0 // tiles with no fallback this frame

  constructor(ctx: GPUContext) {
    this.device = ctx.device
  }

  /** Connect to a data source */
  setSource(source: TileCatalog): void {
    this.source = source
    // Immediate GPU upload — no queue delay, no flickering
    source.onTileLoaded = (key, data, sourceLayer) => {
      this.uploadTile(key, data, sourceLayer)
    }
  }

  /** Set bind group layout (must be called before tiles arrive) */
  setBindGroupLayout(layout: GPUBindGroupLayout): void {
    this.lastBindGroupLayout = layout
    this.baseBindGroupLayout = layout
    this.ensureUniformRing()
  }

  private ensureUniformRing(): void {
    if (this.uniformRing) return
    this.uniformRing = this.device.createBuffer({
      size: this.uniformRingCapacity * UNIFORM_SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'vtr-uniform-ring',
    })
    this.rebuildTileBindGroups()
  }

  private rebuildTileBindGroups(): void {
    if (!this.uniformRing || !this.baseBindGroupLayout) return
    this.tileBgDefault = this.device.createBindGroup({
      layout: this.baseBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformRing, offset: 0, size: UNIFORM_SIZE } }],
    })
    if (this.featureBindGroupLayout && this.featureDataBuffer) {
      this.tileBgFeature = this.device.createBindGroup({
        layout: this.featureBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformRing, offset: 0, size: UNIFORM_SIZE } },
          { binding: 1, resource: { buffer: this.featureDataBuffer } },
        ],
      })
    } else {
      this.tileBgFeature = null
    }
  }

  /** Ring buffers retired mid-frame because of capacity grow. Destroyed on
   *  the NEXT beginFrame() so the in-flight submit that still references
   *  them via bind groups completes without hitting "used in submit while
   *  destroyed". */
  private retiredUniformRings: GPUBuffer[] = []

  /** Frame ID set by `beginFrame(frameId)`, threaded through to
   *  `source.resetCompileBudget(frameId)` so the catalog's per-frame
   *  budget can short-circuit duplicate resets when one source feeds
   *  multiple layer ShowCommands within the same frame. */
  private currentFrameId = 0

  /** Cache of `visibleTilesFrustum()` + the derived neededKeys /
   *  worldOffsets arrays. With one source feeding N layer
   *  ShowCommands, each VTR.render() invocation would otherwise
   *  re-compute the same tile selection N times — the camera and
   *  canvas can't change between renders within a frame. Profiling
   *  showed pmtiles_layered (4 layers) burning ~30 ms / frame on
   *  redundant frustum walks. Cache keyed by frameId + culling
   *  margin (different stroke widths produce slightly different
   *  margins; a hit requires both to match). */
  private _frameTileCache: {
    frameId: number
    marginPx: number
    currentZ: number
    tiles: ReturnType<typeof visibleTilesFrustum>
    neededKeys: number[]
    worldOffDeg: number[]
    /** Source's `maxLevel` at the time the cache was populated.
     *  parentAtMaxLevel + archiveAncestor are computed against this
     *  level — if the source's archive depth changes between renders
     *  within a frame (rare but possible during initial load), the
     *  cache invalidates. */
    maxLevel: number
    /** For each tile i: when `tiles[i].z > maxLevel`, the maxLevel
     *  ancestor key (the over-zoom fallback parent). Else `-1`.
     *  Sliced layer-independent — depends only on tile coord +
     *  source maxLevel, so all 4 ShowCommands sharing this source
     *  read the same value. Eliminates the per-render
     *  `for (pz>maxLevel) parentKey = tileKeyParent(parentKey)`
     *  walk that dominated the per-tile loop at over-zoom. */
    parentAtMaxLevel: number[]
    /** For each tile i: the highest indexed ancestor (closest to
     *  the tile) found via `hasEntryInIndex` walk. `-1` if no
     *  ancestor is in the index. Sliced layer-independent —
     *  `hasEntryInIndex` is a property of the source index, not
     *  any layer's GPU/data cache. Replaces three quarters of the
     *  in-archive per-tile walk (`hasAnyAncestor` + `closestExisting`
     *  derived from this; only `cachedAncestorKey` still needs a
     *  per-layer `sliceCached` walk). */
    archiveAncestor: number[]
  } | null = null

  beginFrame(frameId: number = 0): void {
    this.currentFrameId = frameId
    this.uniformSlot = 0
    this._uploadBudget = MAX_UPLOADS_PER_FRAME
    // Reset the frame-scoped miss counter here so multiple render()
    // calls within the frame accumulate into one total (see render()).
    this._missedTiles = 0
    this._frameTilesVisible = 0
    this._frameDrawCalls = 0
    this._frameTriangles = 0
    this._frameLines = 0
    this._frameVertices = 0
    // Frame tile cache invalidates on each new frame via the
    // currentFrameId comparison in render(); explicit null isn't
    // strictly needed, but releasing the GC reference here lets the
    // previous frame's tile array drop sooner if the ShowCommand
    // list shrinks (e.g. layer toggle).
    this._frameTileCache = null
    // Safe to destroy rings that were grown out of last frame: by now the
    // previous frame's command buffer has been submitted and its GPU-side
    // lifetime is the device's responsibility, not the buffer handle.
    for (const b of this.retiredUniformRings) b.destroy()
    this.retiredUniformRings.length = 0
    // Same safety window applies to tile-buffer eviction. Eviction used to
    // run inline at the end of render() (`this.gpuCache.size > MAX_GPU_TILES`
    // check after the per-frame draws were encoded). The bucket scheduler
    // calls render() multiple times per frame (once per opaque layer plus
    // once per translucent layer), so an eviction in call N could destroy
    // buffers still bound by encoded-but-not-yet-submitted commands from
    // call N−1, producing "Buffer used in submit while destroyed"
    // validation errors on translucent_lines and other multi-layer
    // demos. Defer to the start of the next frame: the previous frame's
    // queue.submit() has returned by now, so destroying these buffers
    // can't poison any in-flight submit.
    // Trigger conservatively — gpuCache.size counts composite (key, layer)
    // entries, but the cap evictGPUTiles enforces is on UNIQUE TILE KEYS.
    // A sliced source can have ~4× the entries-per-tile, so we may enter
    // evictGPUTiles below the cap; it short-circuits correctly in that case.
    if (this._gpuCacheCount > MAX_GPU_TILES) this.evictGPUTiles()
    // CPU-side TileCatalog eviction. Without this the dataCache grew
    // unbounded for the lifetime of the session — VTR's gpuCache
    // capped GPU memory but every parsed-and-decoded tile's
    // TileData (vertex + index + line + outline + polygon-rings
    // arrays) stayed pinned in JS heap. evictTiles protects the
    // current frame's stableKeys + indexed ancestors (≤ maxLevel)
    // so visible tiles + their fallback chain survive; only
    // off-screen leaves get dropped. Same safe-window as the GPU
    // eviction (runs after prev frame's submit), so a re-render
    // walking the parent chain can always find a cached ancestor.
    if (this.source && this.stableKeys.length > 0) {
      this.source.evictTiles(new Set(this.stableKeys))
    }
  }

  /** Per-frame upload budget. uploadTile() is expensive — it creates ~5–7
   *  GPU buffers AND runs `buildLineSegments` (CPU) twice per tile. A LOD
   *  boundary crossing can easily queue 16+ new tiles in a single frame;
   *  without a cap that lands as one ~250 ms stall (measured) with a
   *  multi-MB writeBuffer burst. Excess uploads are deferred to next
   *  frame via `_pendingUploads`, keeping per-frame work bounded. */
  private _uploadBudget = 3
  private _pendingUploads: { key: number; data: TileData; sourceLayer: string }[] = []

  /** The outer render-on-demand loop calls this to know whether it still
   *  needs to tick — if tiles are queued for upload the scene hasn't
   *  actually converged yet, even though no user input is flowing. */
  hasPendingUploads(): boolean {
    return this._pendingUploads.length > 0
  }

  /** Diagnostic: queue depth for inspectPipeline() snapshots. */
  getPendingUploadCount(): number {
    return this._pendingUploads.length
  }

  private allocUniformSlot(): number {
    if (this.uniformSlot >= this.uniformRingCapacity) this.growUniformRing(this.uniformSlot + 1)
    return this.uniformSlot++ * UNIFORM_SLOT
  }

  private growUniformRing(minSlots: number): void {
    let newCap = this.uniformRingCapacity
    while (newCap < minSlots) newCap *= 2
    // Don't destroy the old ring immediately — it may still be bound to
    // commands already recorded in the current command encoder. Retire it
    // to be destroyed at the start of the next frame (after submit).
    if (this.uniformRing) this.retiredUniformRings.push(this.uniformRing)
    this.uniformRingCapacity = newCap
    this.uniformRing = this.device.createBuffer({
      size: newCap * UNIFORM_SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'vtr-uniform-ring',
    })
    // Resize the CPU staging buffer in lockstep; preserve already-written
    // bytes so a grow mid-pass doesn't lose pending uniforms.
    const grown = new Uint8Array(newCap * UNIFORM_SLOT)
    grown.set(this.uniformStaging.subarray(0, Math.min(this.uniformStaging.length, grown.length)))
    this.uniformStaging = grown
    this.rebuildTileBindGroups()
  }

  /** Copy a per-tile uniform block into the staging mirror at the given
   *  ring byte offset and extend the dirty range. Replaces the old
   *  per-draw `device.queue.writeBuffer` call inside renderTileKeys. */
  private stageUniformSlot(slotOffset: number, src: ArrayBuffer): void {
    this.uniformStaging.set(new Uint8Array(src, 0, Math.min(src.byteLength, UNIFORM_SLOT)), slotOffset)
    const hi = slotOffset + UNIFORM_SLOT
    if (this.uniformDirtyHi === this.uniformDirtyLo) {
      this.uniformDirtyLo = slotOffset
      this.uniformDirtyHi = hi
    } else {
      if (slotOffset < this.uniformDirtyLo) this.uniformDirtyLo = slotOffset
      if (hi > this.uniformDirtyHi) this.uniformDirtyHi = hi
    }
  }

  /** Upload the accumulated uniform-ring bytes as a SINGLE writeBuffer,
   *  then mark the dirty range empty. WebGPU schedules the copy before
   *  any command buffer submitted afterwards, so calling this at end of
   *  each renderTileKeys (i.e. still within the pass encoding window) is
   *  correct — the subsequent pass.end → encoder.finish → queue.submit
   *  sees the updated ring contents. */
  private flushUniformStaging(): void {
    if (this.uniformDirtyHi === this.uniformDirtyLo || !this.uniformRing) return
    const lo = this.uniformDirtyLo, hi = this.uniformDirtyHi
    this.device.queue.writeBuffer(
      this.uniformRing, lo,
      this.uniformStaging.buffer, this.uniformStaging.byteOffset + lo, hi - lo,
    )
    this.uniformDirtyLo = 0
    this.uniformDirtyHi = 0
  }

  /** Provide the shared SDF line renderer (set by map.ts after GPU init). */
  setLineRenderer(lr: LineRenderer): void {
    const wasNull = this.lineRenderer === null
    this.lineRenderer = lr
    // If tiles were uploaded before LineRenderer was available they have no
    // segment buffers — force re-upload so outlines/lines render on next frame.
    if (wasNull && this._gpuCacheCount > 0) {
      for (const inner of this.gpuCache.values()) {
        for (const tile of inner.values()) {
          tile.vertexBuffer?.destroy()
          tile.indexBuffer?.destroy()
          tile.lineVertexBuffer?.destroy()
          tile.lineIndexBuffer?.destroy()
          tile.outlineIndexBuffer?.destroy()
          tile.outlineSegmentBuffer?.destroy()
          tile.lineSegmentBuffer?.destroy()
        }
      }
      this.gpuCache.clear()
      this._gpuCacheCount = 0
    }
  }

  /** Whether data is available */
  hasData(): boolean {
    return this.source?.hasData() ?? false
  }

  getBounds(): [number, number, number, number] | null {
    return this.source?.getBounds() ?? null
  }

  getPropertyTable(): PropertyTable | undefined {
    return this.source?.getPropertyTable()
  }

  hasFeatureData(): boolean {
    return this.featureDataBuffer !== null
  }

  getCacheSize(): number {
    return this._gpuCacheCount
  }

  /** Tear down all GPU resources owned by this renderer.
   *  Used when a source is being replaced (setSourceData) or the
   *  whole map is disposed. After destroy() the renderer is dead —
   *  create a new VectorTileRenderer if another upload is needed. */
  destroy(): void {
    for (const inner of this.gpuCache.values()) {
      for (const tile of inner.values()) {
        tile.vertexBuffer?.destroy()
        tile.indexBuffer?.destroy()
        tile.lineVertexBuffer?.destroy()
        tile.lineIndexBuffer?.destroy()
        tile.outlineIndexBuffer?.destroy()
        tile.outlineSegmentBuffer?.destroy()
        tile.lineSegmentBuffer?.destroy()
      }
    }
    this.gpuCache.clear()
    this._gpuCacheCount = 0

    this.featureDataBuffer?.destroy()
    this.featureDataBuffer = null

    this.uniformRing?.destroy()
    this.uniformRing = null

    for (const r of this.retiredUniformRings) r.destroy()
    this.retiredUniformRings = []
  }

  /** Frame-scoped accumulators (reset in beginFrame, updated in
   *  render). renderedDraws can't be reused for `tilesVisible`
   *  because multiple render() calls within a frame must each clear
   *  their own dedup set (drawKey collision would mute subsequent
   *  layers' draws of the SAME world-tile + worldOff). These
   *  counters track the FRAME total across all layer renders. */
  private _frameTilesVisible = 0
  private _frameDrawCalls = 0
  private _frameTriangles = 0
  private _frameLines = 0
  private _frameVertices = 0

  getDrawStats(): { drawCalls: number; vertices: number; triangles: number; lines: number; tilesVisible: number; missedTiles: number } {
    return {
      drawCalls: this._frameDrawCalls,
      vertices: this._frameVertices,
      triangles: this._frameTriangles,
      lines: this._frameLines,
      tilesVisible: this._frameTilesVisible,
      missedTiles: this._missedTiles,
    }
  }

  /** Build per-feature GPU storage buffer from PropertyTable */
  buildFeatureDataBuffer(variant: ShaderVariant, featureBindGroupLayout: GPUBindGroupLayout): void {
    const table = this.source?.getPropertyTable()
    if (!table || variant.featureFields.length === 0) return

    this.featureBindGroupLayout = featureBindGroupLayout
    const fieldCount = variant.featureFields.length
    const featureCount = table.values.length
    const data = new Float32Array(featureCount * fieldCount)

    const catMaps = new Map<string, Map<string, number>>()
    for (const fieldName of variant.featureFields) {
      const fi = table.fieldNames.indexOf(fieldName)
      if (fi >= 0 && table.fieldTypes[fi] === 'string') {
        const uniqueVals = new Set<string>()
        for (const row of table.values) {
          const v = row[fi]
          if (typeof v === 'string') uniqueVals.add(v)
        }
        const sorted = [...uniqueVals].sort()
        const map = new Map<string, number>()
        sorted.forEach((v, i) => map.set(v, i))
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

    // Build the shared feature-bound tile bind group
    this.rebuildTileBindGroups()

    console.log(`[X-GIS] Feature data buffer: ${featureCount} features × ${fieldCount} fields`)
  }

  /** Upload CPU tile data to GPU buffers */
  /** Route uploads through the frame budget — uploadTile is a misnomer
   *  kept for backwards call-sites; the real work happens in
   *  doUploadTile once a slot is granted. Beyond the budget the tile
   *  sits in `_pendingUploads` and picks up on subsequent frames. */
  private uploadTile(key: number, data: TileData, sourceLayer = ''): void {
    if (this.getLayerCache(sourceLayer)?.has(key)) return
    if (this._uploadBudget <= 0) {
      // De-dupe: if this key is already queued, drop the duplicate —
      // the cache check above catches re-entry of a completed upload,
      // but a pending one still counts.
      if (!this._pendingUploads.some(p => p.key === key && p.sourceLayer === sourceLayer)) {
        this._pendingUploads.push({ key, data, sourceLayer })
      }
      return
    }
    this._uploadBudget--
    this.doUploadTile(key, data, sourceLayer)
  }

  /** Drain as many pending uploads as fit in the remaining frame budget.
   *  Called once per render pass just before we enumerate `neededKeys`
   *  so newly-visible tiles get a chance at the budget even when the
   *  queue piled up during a LOD jump. */
  private drainPendingUploads(): void {
    while (this._uploadBudget > 0 && this._pendingUploads.length > 0) {
      const next = this._pendingUploads.shift()!
      if (this.getLayerCache(next.sourceLayer)?.has(next.key)) continue
      this._uploadBudget--
      this.doUploadTile(next.key, next.data, next.sourceLayer)
    }
  }

  private doUploadTile(key: number, data: TileData, sourceLayer = ''): void {
    const layerCache = this.getOrCreateLayerCache(sourceLayer)
    if (layerCache.has(key)) return // already uploaded

    // Label every per-tile buffer so writeBuffer attribution in the
    // diagnostic suite can separate tile-upload churn from per-frame
    // uniform writes. Cost is zero — label is a GPU debug string.
    const vertexBuffer = this.device.createBuffer({
      size: Math.max(data.vertices.byteLength * 3, 12),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      label: 'tile-vertices',
    })
    this.device.queue.writeBuffer(vertexBuffer, 0, data.vertices)

    const indexBuffer = this.device.createBuffer({
      size: Math.max(data.indices.byteLength * 3, 4),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      label: 'tile-indices',
    })
    this.device.queue.writeBuffer(indexBuffer, 0, data.indices)

    let lineVertexBuffer: GPUBuffer | null = null
    let lineIndexBuffer: GPUBuffer | null = null
    if (data.lineVertices.length > 0) {
      lineVertexBuffer = this.device.createBuffer({
        size: data.lineVertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: 'tile-line-vertices',
      })
      this.device.queue.writeBuffer(lineVertexBuffer, 0, data.lineVertices)

      lineIndexBuffer = this.device.createBuffer({
        size: data.lineIndices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        label: 'tile-line-indices',
      })
      this.device.queue.writeBuffer(lineIndexBuffer, 0, data.lineIndices)
    }

    // Outline indices (polygon edges, reuses polygon vertex buffer)
    let outlineIndexBuffer: GPUBuffer | null = null
    let outlineIndexCount = 0
    if (data.outlineIndices && data.outlineIndices.length > 0) {
      outlineIndexBuffer = this.device.createBuffer({
        size: Math.max(data.outlineIndices.byteLength, 4),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        label: 'tile-outline-indices',
      })
      this.device.queue.writeBuffer(outlineIndexBuffer, 0, data.outlineIndices)
      outlineIndexCount = data.outlineIndices.length
    }

    // SDF line segment buffers (for polygon outlines + line features).
    // buildLineSegments now reads DSFUN-stride vertex buffers and needs the
    // tile extent in Mercator meters so its tile-boundary detection keeps
    // seamless joins across tile edges.
    let outlineSegmentBuffer: GPUBuffer | null = null
    let outlineSegmentCount = 0
    let outlineSegmentBindGroup: GPUBindGroup | null = null
    let lineSegmentBuffer: GPUBuffer | null = null
    let lineSegmentCount = 0
    let lineSegmentBindGroup: GPUBindGroup | null = null
    if (this.lineRenderer) {
      const SEG_DEG2RAD = Math.PI / 180
      const SEG_R = 6378137
      const SEG_LAT_LIMIT = 85.051129
      const clampSegLat = (v: number) => Math.max(-SEG_LAT_LIMIT, Math.min(SEG_LAT_LIMIT, v))
      const tileMercXWest = data.tileWest * SEG_DEG2RAD * SEG_R
      const tileMercXEast = (data.tileWest + data.tileWidth) * SEG_DEG2RAD * SEG_R
      const tileMercYSouth = Math.log(Math.tan(Math.PI / 4 + clampSegLat(data.tileSouth) * SEG_DEG2RAD / 2)) * SEG_R
      const tileMercYNorth = Math.log(Math.tan(Math.PI / 4 + clampSegLat(data.tileSouth + data.tileHeight) * SEG_DEG2RAD / 2)) * SEG_R
      const tileWidthMerc = tileMercXEast - tileMercXWest
      const tileHeightMerc = tileMercYNorth - tileMercYSouth
      // Polygon outlines: every tile source now ships stride-10 outline
      // vertices with global arc_start (GeoJSON tiler, binary .xgvt
      // decoder, and runtime sub-tile generator all use the same
      // augmentRingWithArc + clipLineToRect helpers). Line features go
      // through the same SDF pipeline. The legacy stride-5 outline-
      // indices-into-fill-vertices path is gone.
      if (data.outlineVertices && data.outlineVertices.length > 0
          && data.outlineLineIndices && data.outlineLineIndices.length > 0) {
        // PMTiles MVT worker pre-builds segments off-thread; reuse if
        // present, else build now on the main thread (XGVT-binary path).
        const segData = data.prebuiltOutlineSegments
          ?? buildLineSegments(data.outlineVertices, data.outlineLineIndices, 10, tileWidthMerc, tileHeightMerc)
        outlineSegmentBuffer = this.lineRenderer.uploadSegmentBuffer(segData)
        outlineSegmentCount = data.outlineLineIndices.length / 2
        outlineSegmentBindGroup = this.lineRenderer.createLayerBindGroup(outlineSegmentBuffer)
      }
      if (data.lineIndices.length > 0 && data.lineVertices.length > 0) {
        let segData: Float32Array
        if (data.prebuiltLineSegments) {
          segData = data.prebuiltLineSegments
        } else {
          // Line features: detect stride from vertex data length / vertex count.
          // Stride 10 includes precomputed tangent_in/out for cross-tile joins;
          // stride 6 is the legacy format without tangents.
          let lineStride: 6 | 10 = 6
          if (data.lineIndices.length > 0) {
            let maxIdx = 0
            for (let li = 0; li < data.lineIndices.length; li++) {
              if (data.lineIndices[li] > maxIdx) maxIdx = data.lineIndices[li]
            }
            const vertCount = maxIdx + 1
            if (vertCount > 0 && data.lineVertices.length / vertCount >= 10) lineStride = 10
          }
          segData = buildLineSegments(data.lineVertices, data.lineIndices, lineStride, tileWidthMerc, tileHeightMerc)
        }
        lineSegmentBuffer = this.lineRenderer.uploadSegmentBuffer(segData)
        lineSegmentCount = data.lineIndices.length / 2
        lineSegmentBindGroup = this.lineRenderer.createLayerBindGroup(lineSegmentBuffer)
      }
    }

    layerCache.set(key, {
      vertexBuffer, indexBuffer,
      indexCount: data.indices.length,
      lineVertexBuffer, lineIndexBuffer,
      lineIndexCount: data.lineIndices.length,
      outlineIndexBuffer, outlineIndexCount,
      outlineSegmentBuffer, outlineSegmentCount, outlineSegmentBindGroup,
      lineSegmentBuffer, lineSegmentCount, lineSegmentBindGroup,
      tileWest: data.tileWest, tileSouth: data.tileSouth,
      tileWidth: data.tileWidth, tileHeight: data.tileHeight,
      tileZoom: data.tileZoom,
      lastUsedFrame: this.frameCount,
      firstShownFrame: this.frameCount,
    })
    this._gpuCacheCount++
  }

  /** Render visible tiles into a render pass */
  render(
    pass: GPURenderPassEncoder,
    camera: Camera,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
    show: ShowCommand,
    fillPipeline: GPURenderPipeline,
    linePipeline: GPURenderPipeline,
    _uniformBuffer: GPUBuffer,
    bindGroupLayout: GPUBindGroupLayout,
    fillPipelineFallback?: GPURenderPipeline,
    linePipelineFallback?: GPURenderPipeline,
    pointRenderer?: PointRenderer | null,
    /** Which draws to emit for this layer.
     *  - 'all':     fills + strokes in the current pass (opaque default)
     *  - 'fills':   polygon fills only (main pass, baked opacity)
     *  - 'strokes': outlines + line features only (offscreen MAX-blend pass) */
    phase: LayerDrawPhase = 'all',
  ): void {
    if (!this.source?.hasData()) return
    const index = this.source.getIndex()
    if (!index) return

    // Sliced-source slot for this layer. PMTiles emits per-MVT-layer
    // slices keyed by layer name in the catalog; xgis layers with a
    // `sourceLayer` filter pick the matching slice. Single-layer
    // sources (XGVT-binary, GeoJSON-runtime) always emit '' (default).
    const sliceLayer = show.sourceLayer ?? ''
    // Pre-fetch this layer's gpuCache slot once. Hot-path lookups
    // become pure numeric Map.has/get — no composite-string alloc per
    // tile. Use getOrCreate so the reference stays valid even if this
    // is the first frame to upload a tile for this slice layer
    // (otherwise mid-render compileTileOnDemand → uploadTile would
    // create a fresh inner Map and our captured `undefined` would go
    // stale). Empty inner Maps for unused layers cost only a Map
    // allocation, no per-tile work.
    const layerCache = this.getOrCreateLayerCache(sliceLayer)

    // Variant-pipeline guard. The pipeline expects the bind group layout
    // passed in via `bindGroupLayout`. For shader variants that need the
    // feature buffer (match() / interpolate() etc.), the layout is
    // `featureBindGroupLayout` — but `tileBgFeature` is built lazily,
    // AFTER the async geojson worker compile resolves and the property
    // table is set on the source (map.ts:1082-1084). Between layer
    // registration and that resolution, frames render with the variant
    // pipeline but only `tileBgDefault` is available, producing
    // "Bind group layout of pipeline layout does not match layout of
    // bind group" validation errors (~5 per frame on fixture_picking
    // until the worker resolves). Skip the draw until feature bg is
    // ready — the layer simply pops in late, same as any tile-load gap.
    if (bindGroupLayout !== this.baseBindGroupLayout && !this.tileBgFeature) return

    this.frameCount++
    // Pass the FRAME-level id (set by beginFrame from map's
    // _frameCount, monotonic across render-loop ticks). The
    // catalog short-circuits if the same id has already reset
    // its budget this frame — without this, every ShowCommand
    // sharing the source would reset the counters → each layer
    // would get a fresh sub-tile budget → 4× more sub-tile clips
    // per frame than intended → GPU buffer creation burst →
    // Chrome STATUS_BREAKPOINT at over-zoom.
    this.source.resetCompileBudget(this.currentFrameId)
    this.renderedDraws.clear()
    // _missedTiles is FRAME-scoped, not render-scoped — beginFrame()
    // resets it to 0. Multiple render() calls within one frame
    // (one per ShowCommand for sliced sources like PMTiles 4-layer)
    // ACCUMULATE into the same counter so map.ts's
    // hasPendingSourceWork sees the true frame total. Resetting
    // here would have clobbered earlier layers' miss counts and
    // falsely signaled "no work pending" when only the last
    // layer happened to converge first.
    this.lastBindGroupLayout = bindGroupLayout
    this.ensureUniformRing()
    // Promote pending uploads first — they're strictly older than anything
    // this frame's tile walk will queue, so servicing them now keeps the
    // "filling in" order correct (near-z-to-current first).
    this.drainPendingUploads()

    const { centerX, centerY } = camera
    const R = 6378137
    const centerLon = (centerX / R) * (180 / Math.PI)
    const centerLat = (2 * Math.atan(Math.exp(centerY / R)) - Math.PI / 2) * (180 / Math.PI)

    const maxLevel = this.source.maxLevel
    // DSFUN precision lets sub-tiles work at any camera zoom. Clamp to 22
    // to match the camera's universal maxZoom, not the old maxLevel+6.
    const maxSubTileZ = 22
    // Round-based currentZ with anti-oscillation hysteresis. Diagnosis:
    // pinch-zoom input on iOS Safari delivers fractional camera.zoom
    // updates that wiggle within ±0.05 around the integer-half
    // boundary (e.g., 4.49 ↔ 4.51), and `Math.round` flips currentZ
    // 4 ↔ 5 each frame — forcing a wholesale tile-set swap that
    // the user perceives as flicker.
    //
    // Hysteresis: the LOD switch threshold is offset by ±HYST_MARGIN
    // from the half-integer, so once zoom crosses 4.5 going up,
    // currentZ stays 5 until zoom drops below 4.4 (asymmetric on the
    // way back). Sub-frame jitter within the dead zone leaves
    // currentZ alone.
    //
    // We deliberately keep `Math.round` semantics (not floor) so the
    // user sees the higher-detail LOD as soon as zoom is closer to
    // it than to the lower one. Floor would magnify the lower LOD
    // until the integer boundary, visibly losing detail at fractional
    // zooms (verified against the smoke-test bucket_order baseline,
    // which renders at zoom 0.75 — floor would drop currentZ to 0,
    // losing the country-boundary detail z=1 carries).
    const HYST_MARGIN = 0.1
    const z = camera.zoom
    let cz: number
    if (this._hysteresisZ < 0) {
      cz = Math.round(z)
    } else {
      cz = this._hysteresisZ
      const target = Math.round(z)
      if (target > cz && z > cz + 0.5 + HYST_MARGIN) cz = target
      else if (target < cz && z < cz - 0.5 + HYST_MARGIN) cz = target
    }
    this._hysteresisZ = cz
    const currentZ = Math.max(0, Math.min(maxSubTileZ, cz))

    // Per-MVT-layer minzoom culling — when the source publishes
    // metadata.vector_layers (PMTiles), each layer's `minzoom` is
    // a HARD bound below which the archive carries no features for
    // it (protomaps v4: roads z≥6, buildings z≥14). Skip render()
    // entirely below that threshold: no missed-tile bookkeeping,
    // no sub-tile gen, no fetches, no FLICKER chatter.
    //
    // `maxzoom` is intentionally NOT used as a cull bound — it's
    // a SOFT bound on raw archive data, but sub-tile generation
    // continues to upscale the maxzoom data for over-zoom views.
    // Culling on maxzoom would freeze rendering past z=15 on
    // protomaps v4 (every layer reports maxzoom=15), defeating the
    // whole over-zoom pipeline.
    if (sliceLayer) {
      const range = this.source.getLayerZoomRange?.(sliceLayer)
      if (range && currentZ < range.minzoom) {
        return
      }
    }

    if (currentZ !== this.lastZoom) this.lastZoom = currentZ

    // Quadtree-based frustum selection works at every pitch, including 0.
    // The legacy AABB-based `visibleTiles` path silently drifted from the
    // VTR cache pipeline and broke at low pitch, so it is no longer used.
    //
    // Culling margin: the default 0.25×canvas envelope misses tiles whose
    // centerline data is outside the viewport but whose RENDERED stroke
    // reaches in via `stroke-offset-N`. Add `|offset| + strokeWidth + aa`
    // in pixels so those tiles are still loaded and drawn.
    const strokeOffsetPx = Math.abs(show.strokeOffset ?? 0)
    const strokeWidthPx = show.strokeWidth ?? 1
    const alignDeltaPx = show.strokeAlign === 'inset' || show.strokeAlign === 'outset'
      ? strokeWidthPx / 2 : 0
    // Round to int so the per-layer margin variance (water 2.25,
    // roads 2.5 in pmtiles_layered) doesn't poison the frame-tile
    // cache key. ceil because we'd rather over-cull than miss tiles
    // whose stroke clips into the viewport. For 4 layers all with
    // small strokes this collapses to one shared cache hit instead
    // of 2 misses + 2 hits.
    const offsetMarginPx = Math.ceil(strokeOffsetPx + alignDeltaPx + strokeWidthPx / 2 + 2)
    // Projection-aware world-copy gate. `this.currentProjection` is
    // declared but never assigned (legacy field — no caller wires it),
    // so the previous `?? mercatorProj` always picked Mercator and
    // worldCopiesFor() returned the full ±2 wrap even under
    // orthographic. visibleTilesFrustum only reads `.name` on the
    // projection arg; pass a `{ name }` shim driven by projType so
    // non-Mercator gets single world. Same pattern as raster-renderer
    // (commit 14aee7d).
    const selectorProj = projType === 0
      ? mercatorProj
      : { name: 'non-mercator', forward: mercatorProj.forward, inverse: mercatorProj.inverse }
    // Frame-scoped cache: every layer render in the same frame
    // produces the same visible-tile set unless the culling margin
    // differs (per-layer stroke width). marginPx is part of the cache
    // key — typical demos have the same margin across layers (small
    // strokes) so all renders past the first hit. profiled: pmtiles_
    // layered (4 layers) used to spend ~30 ms / frame redundantly
    // walking visibleTilesFrustum + sortByPriority + tileKey loop.
    let tiles: ReturnType<typeof visibleTilesFrustum>
    let neededKeys: number[]
    let worldOffDeg: number[]
    let parentAtMaxLevel: number[]
    let archiveAncestor: number[]
    const cache = this._frameTileCache
    if (cache && cache.frameId === this.currentFrameId
        && cache.marginPx === offsetMarginPx
        && cache.currentZ === currentZ
        && cache.maxLevel === maxLevel) {
      tiles = cache.tiles
      neededKeys = cache.neededKeys
      worldOffDeg = cache.worldOffDeg
      parentAtMaxLevel = cache.parentAtMaxLevel
      archiveAncestor = cache.archiveAncestor
    } else {
      tiles = visibleTilesFrustum(
        camera,
        selectorProj,
        currentZ,
        canvasWidth,
        canvasHeight,
        offsetMarginPx,
      )
      const n = Math.pow(2, currentZ)
      const ctX = Math.floor((centerLon + 180) / 360 * n)
      const ctY = Math.floor((1 - Math.log(Math.tan(centerLat * Math.PI / 180) + 1 / Math.cos(centerLat * Math.PI / 180)) / Math.PI) / 2 * n)
      sortByPriority(tiles, ctX, ctY)
      // Build neededKeys + worldOffsets + sliceLayer-INDEPENDENT
      // ancestor lookups in one pass so the entire derived set
      // caches together. parentAtMaxLevel + archiveAncestor depend
      // only on (tile coord, source maxLevel, source index) — none
      // of which vary across same-frame ShowCommand renders, so all
      // 4 layers reuse the precomputed arrays. This is the
      // sliceLayer-independent half of the per-tile parent walk
      // hoisted out of the hot path.
      neededKeys = []
      worldOffDeg = []
      parentAtMaxLevel = new Array(tiles.length)
      archiveAncestor = new Array(tiles.length)
      // Per-frame-populate hasEntry memo. Adjacent tiles share
      // ancestors so memoization keeps the index lookup count
      // sub-linear in tiles.length.
      const ancestorMemo = new Map<number, boolean>()
      const ancestorHasEntry = (k: number): boolean => {
        let v = ancestorMemo.get(k)
        if (v === undefined) {
          v = this.source!.hasEntryInIndex(k)
          ancestorMemo.set(k, v)
        }
        return v
      }
      for (let i = 0; i < tiles.length; i++) {
        const tz = tiles[i].z
        const k = tileKey(tz, tiles[i].x, tiles[i].y)
        neededKeys.push(k)
        const ox = tiles[i].ox ?? tiles[i].x
        const tileN = Math.pow(2, tz)
        worldOffDeg.push((ox - tiles[i].x) * (360 / tileN))
        if (tz > maxLevel) {
          // Over-zoom: walk to maxLevel ancestor. Coordinate-only;
          // archive existence is checked per-layer via sliceCached.
          let pk = k
          for (let pz = tz; pz > maxLevel; pz--) pk = tileKeyParent(pk)
          parentAtMaxLevel[i] = pk
          archiveAncestor[i] = -1
        } else {
          parentAtMaxLevel[i] = -1
          // In-archive: walk parents until first hasEntry hit.
          // First hit is highest indexed ancestor (closestExisting).
          let pk = k
          let found = -1
          for (let pz = tz - 1; pz >= 0; pz--) {
            pk = tileKeyParent(pk)
            if (ancestorHasEntry(pk)) { found = pk; break }
          }
          archiveAncestor[i] = found
        }
      }
      this._frameTileCache = {
        frameId: this.currentFrameId,
        marginPx: offsetMarginPx,
        currentZ,
        tiles, neededKeys, worldOffDeg,
        maxLevel,
        parentAtMaxLevel, archiveAncestor,
      }
    }

    const frame = camera.getFrameView(canvasWidth, canvasHeight)
    const mvp = frame.matrix
    this.logDepthFc = frame.logDepthFc

    // Cache color parsing — only reparse if show properties changed.
    //
    // Animation override: if `resolvedFillRgba` / `resolvedStrokeRgba` is
    // set, the classifier has already interpolated this frame's value from
    // a keyframes block. Use it directly — skipping both the hex cache
    // check AND the hex parse. The cached base color stays intact so a
    // subsequent static frame can re-use it.
    const opacity = show.opacity ?? 1.0
    this.currentOpacity = opacity
    this.currentPickId = show.pickId ?? 0
    if (show.resolvedFillRgba) {
      this.cachedFillColor[0] = show.resolvedFillRgba[0]
      this.cachedFillColor[1] = show.resolvedFillRgba[1]
      this.cachedFillColor[2] = show.resolvedFillRgba[2]
      this.cachedFillColor[3] = show.resolvedFillRgba[3]
      this.cachedShowFill = ''
    } else if (show.fill !== this.cachedShowFill) {
      this.cachedShowFill = show.fill ?? ''
      const raw = show.fill ? parseHexColor(show.fill) : null
      this.cachedFillColor[0] = raw ? raw[0] : 0
      this.cachedFillColor[1] = raw ? raw[1] : 0
      this.cachedFillColor[2] = raw ? raw[2] : 0
      this.cachedFillColor[3] = raw ? raw[3] : 0
    }
    if (show.resolvedStrokeRgba) {
      this.cachedStrokeColor[0] = show.resolvedStrokeRgba[0]
      this.cachedStrokeColor[1] = show.resolvedStrokeRgba[1]
      this.cachedStrokeColor[2] = show.resolvedStrokeRgba[2]
      this.cachedStrokeColor[3] = show.resolvedStrokeRgba[3]
      this.cachedShowStroke = ''
    } else if (show.stroke !== this.cachedShowStroke) {
      this.cachedShowStroke = show.stroke ?? ''
      const raw = show.stroke ? parseHexColor(show.stroke) : null
      this.cachedStrokeColor[0] = raw ? raw[0] : 0
      this.cachedStrokeColor[1] = raw ? raw[1] : 0
      this.cachedStrokeColor[2] = raw ? raw[2] : 0
      this.cachedStrokeColor[3] = raw ? raw[3] : 0
    }

    // Skip the fill drawIndexed entirely when we KNOW nothing visible will
    // be produced. Two cases qualify:
    //   1. show.fill is undefined AND no shader variant computes the fill
    //      from feature data (e.g. multi_layer's `borders | stroke-* opacity-80`
    //      gets routed through the opaque bucket as fillPhase='fills' but
    //      declared no fill at all).
    //   2. show.fill resolved to a color whose alpha is effectively 0.
    // BUT a data-driven `fill match(...)` produces colors entirely inside
    // the variant pipeline (fillExpr != 'u.fill_color'), so cachedFillColor
    // can be [0,0,0,0] yet the draw is still meaningful — must keep it.
    const variantFillExpr = show.shaderVariant?.fillExpr
    const variantProducesFill = !!variantFillExpr && variantFillExpr !== 'u.fill_color'
    this._skipFillDraw = !variantProducesFill && this.cachedFillColor[3] <= 0.005

    // Write uniforms directly via cached Float32Array view (no new typed array allocations)
    const uf = this.uniformF32
    uf.set(mvp, 0) // offset 0: mvp (16 floats)
    uf[16] = this.cachedFillColor[0]; uf[17] = this.cachedFillColor[1]
    uf[18] = this.cachedFillColor[2]; uf[19] = this.cachedFillColor[3] * opacity
    uf[20] = this.cachedStrokeColor[0]; uf[21] = this.cachedStrokeColor[1]
    uf[22] = this.cachedStrokeColor[2]; uf[23] = this.cachedStrokeColor[3] * opacity
    uf[24] = projType; uf[25] = projCenterLon; uf[26] = projCenterLat; uf[27] = 0

    // Allocate + write SDF line layer slot for this render() call. All
    // drawSegments() calls below will use this same byte offset.
    // In 'fills' phase no drawSegments runs, so skip the allocation entirely
    // to avoid ring-slot churn, redundant pattern-param warnings, and any
    // incidental validation surface in the translucent fill pre-pass.
    let lineLayerOffset = 0
    if (this.lineRenderer && phase !== 'fills') {
      const strokeWidthPx = show.strokeWidth ?? 1
      const mpp = (40075016.686 / 256) / Math.pow(2, camera.zoom)
      const capMap = { butt: 0, round: 1, square: 2, arrow: 3 } as const
      const joinMap = { miter: 0, round: 1, bevel: 2 } as const
      // Default cap/join = round. Round is a stable circle SDF that fills
      // corners and chain ends correctly at any angle. Miter/bevel require
      // explicit opt-in via `stroke-linejoin-miter` / `stroke-linecap-butt`.
      const cap = capMap[show.linecap ?? 'round']
      const join = joinMap[show.linejoin ?? 'round']
      const miterLimit = show.miterlimit ?? 4.0
      // DSL dash values default to pixels (matching stroke-width convention).
      // Convert to Mercator meters here so the shader's meter-based arc_pos
      // comparison renders the pattern at a consistent on-screen size across
      // zoom levels. TODO: add explicit unit suffixes (20m_10m, 20km_5km) to
      // the parser if real-world length dashes are needed later.
      const dash = (show.dashArray && show.dashArray.length >= 2)
        ? {
            array: show.dashArray.map(v => v * mpp),
            offset: (show.dashOffset ?? 0) * mpp,
          }
        : null



      // Resolve patterns: shape name → registry ID; unit name → flag code.
      const unitMap = { m: 0, px: 1, km: 2, nm: 3 } as const
      const anchorMap = { repeat: 0, start: 1, end: 2, center: 3 } as const
      const patternSlots = (show.patterns ?? [])
        .slice(0, 3)
        .map(p => ({
          shapeId: this.lineRenderer!.resolveShapeId(p.shape),
          spacing: p.spacing,
          spacingUnit: unitMap[p.spacingUnit ?? 'm'],
          size: p.size,
          sizeUnit: unitMap[p.sizeUnit ?? 'm'],
          offset: p.offset ?? 0,
          offsetUnit: unitMap[p.offsetUnit ?? 'm'],
          startOffset: p.startOffset ?? 0,
          anchor: anchorMap[p.anchor ?? 'repeat'],
        }))
        .filter(p => p.shapeId > 0)

      // In translucent mode the offscreen RT must hold the FULL color +
      // stroke alpha (no opacity multiply). The composite step then blends
      // with the layer opacity. Otherwise we'd double-apply opacity.
      // In 'strokes' phase the offscreen RT holds the FULL color + stroke
      // alpha (no opacity multiply). The composite step then blends with the
      // layer opacity — otherwise we'd double-apply it.
      const layerOpacity = phase === 'strokes' ? 1.0 : opacity

      // Resolve stroke alignment to an effective offset. Inset/outset
      // shift by ±half_width; combines additively with explicit
      // stroke-offset-N (so users can fine-tune around the baseline).
      const explicitOffset = show.strokeOffset ?? 0
      const alignDelta = show.strokeAlign === 'inset'
        ? strokeWidthPx / 2
        : show.strokeAlign === 'outset'
          ? -strokeWidthPx / 2
          : 0
      const effectiveOffset = explicitOffset + alignDelta

      lineLayerOffset = this.lineRenderer.writeLayerSlot(
        [this.cachedStrokeColor[0], this.cachedStrokeColor[1], this.cachedStrokeColor[2], this.cachedStrokeColor[3]],
        strokeWidthPx,
        layerOpacity,
        mpp,
        cap,
        join,
        miterLimit,
        dash,
        patternSlots,
        effectiveOffset,
        canvasHeight,
      )
    }

    // neededKeys + worldOffDeg + parentAtMaxLevel + archiveAncestor
    // already computed (and cached frame-wide) above. Per-tile loop
    // and prefetch loop both read those arrays directly — no need
    // for a per-render `closestExistingByI` mirror, since the
    // sliceLayer-independent ancestor result is identical across
    // every same-frame ShowCommand render.
    const fallbackKeys: number[] = []
    const fallbackOffsets: number[] = []
    const toLoad: number[] = []
    // Memoize sliceCached lookups across the per-tile + prefetch loops
    // within this render. Adjacent visible tiles share ancestors so
    // without memo the same parent key gets queried per layer slot.
    // hasEntryInIndex is no longer memoized at render scope — the
    // frame cache populate runs the only memoized walk now (see
    // archiveAncestor[] above), and the few remaining direct
    // hasEntryInIndex calls in the per-tile loop hit case-6 paths
    // that fire at most once per tile per render.
    const sliceCachedMemo = new Map<number, boolean>()
    const sliceCached = (k: number): boolean => {
      let v = sliceCachedMemo.get(k)
      if (v === undefined) {
        v = layerCache.has(k)
            || this.source!.hasTileData(k, sliceLayer)
        sliceCachedMemo.set(k, v)
      }
      return v
    }

    // parentKeysSet is the prefetch queue. Hoisted ahead of the
    // main per-tile loop so the over-zoom fast path can populate it
    // for parents that need fetching, instead of duplicating the
    // queue logic.
    const parentKeysSet = new Set<number>()
    // Tracks whether ANY visible tile went through the in-archive
    // (normal) path. When false, the prefetch loop + primary
    // renderTileKeys are pure no-ops (every neededKey is over-zoom
    // so gpuCache.get returns null for all of them) and we can
    // skip them entirely.
    let anyInArchive = false

    for (let i = 0; i < tiles.length; i++) {
      const key = neededKeys[i]
      const tileZi = tiles[i].z

      // ── OVER-ZOOM FAST PATH ──
      // For tiles past archive maxLevel, every layer renders the
      // parent at maxLevel as camera-magnified fallback (no sub-tile
      // gen — Mapbox-style). Skip the entire per-tile body: no
      // gpuCache.has chain, no hasTileData chain, no parent-walk
      // (we know the destination is exactly maxLevel ancestor), no
      // compileTileOnDemand call. Just walk up by tileKeyParent and
      // push the fallback. Profiled: dropped per-tile loop time on
      // pmtiles_layered z=22 from 6.4 ms → ~1 ms per render.
      if (tileZi > maxLevel) {
        // parentKey precomputed at frame-cache populate time, shared
        // across all 4 ShowCommands feeding this VTR. Replaces the
        // per-render `tileKeyParent` walk that dominated tile-loop
        // CPU time.
        const parentKey = parentAtMaxLevel[i]
        fallbackKeys.push(parentKey)
        fallbackOffsets.push(worldOffDeg[i])
        // Ensure parent reaches gpuCache so renderTileKeys finds it.
        // sliceCached(parentKey) covers gpuCache OR dataCache; the
        // explicit gpuCache.has below distinguishes "needs upload
        // from dataCache" vs "already on GPU".
        if (!sliceCached(parentKey)) {
          parentKeysSet.add(parentKey)
        } else if (!layerCache.has(parentKey)) {
          const data = this.source.getTileData(parentKey, sliceLayer)
          if (data) this.doUploadTile(parentKey, data, sliceLayer)
        }
        continue
      }
      // ── END FAST PATH ──

      anyInArchive = true
      if (layerCache.has(key)) continue

      if (this.source.hasTileData(key, sliceLayer)) {
        this.uploadTile(key, this.source.getTileData(key, sliceLayer)!, sliceLayer)
        continue
      }

      // Sliced source: tile WAS loaded (some slice cached) but this
      // layer's MVT source-layer has no features here. Common case at
      // low zoom — `roads`/`buildings` typically only exist at z>=8/14
      // in protomaps v4. Skip silently; no fallback walk, no miss
      // count, no FLICKER warning. The layer simply has nothing to
      // draw on this tile.
      //
      // BUT only when we're INSIDE the archive's zoom range
      // (tileZ ≤ maxLevel). At over-zoom, sub-tile generation is
      // PER-LAYER — each layer must clip its own slice from the
      // parent independently. Without the `tileZ <= maxLevel`
      // gate, the FIRST layer to generate a sub-tile populates
      // hasTileData(key)=true → subsequent layers see "loaded"
      // and skip their sub-tile gen → only one layer renders at
      // over-zoom (user-reported "tiles disappear at z=15.5+
      // — only water visible").
      if (sliceLayer && tiles[i].z <= maxLevel && this.source.hasTileData(key)) continue

      let foundCached = false
      // closestExisting + hasAnyAncestor come from the frame cache —
      // both are sliceLayer-independent (they only depend on source
      // index topology, not any layer's GPU/data cache state). Per-
      // layer, only `cachedAncestorKey` (the highest ancestor whose
      // SLICE is loaded) still requires a walk.
      const closestExisting = archiveAncestor[i]
      const hasAnyAncestor = closestExisting >= 0
      let cachedAncestorKey = -1
      const tileZ = tiles[i].z
      {
        // Per-layer walk: find the highest ancestor cached for this
        // sliceLayer. First sliceCached hit is the highest (walk
        // climbs from tile parent upward); break immediately. The
        // hasEntry side of the walk is gone — already in the frame
        // cache as `archiveAncestor[i]`.
        let walkKey = key
        for (let pz = tileZ - 1; pz >= 0; pz--) {
          walkKey = tileKeyParent(walkKey)
          if (sliceCached(walkKey)) { cachedAncestorKey = walkKey; break }
        }
      }

      if (cachedAncestorKey >= 0) {
        const parentKey = cachedAncestorKey
        if (!layerCache.has(parentKey)) {
          // Ancestor uploads BYPASS the per-frame budget. Rationale:
          // fallback parents are the visual safety net for every over-
          // zoom child currently needing render. There are at most
          // a handful of unique ancestor keys in a frame (log₂(N)
          // pyramid depth × frustum span), so unconditional upload
          // adds minimal GPU work. If the budget throttles them
          // behind sub-tile uploads, `fallbackKeys.push(parentKey)`
          // below still emits a draw — but `renderTiles` then finds
          // no `gpuCache.get(parentKey)` and the tile renders as a
          // black hole. Caught by _high-pitch-flicker.spec.ts's
          // "below-horizon renders SOME geometry" assertion (0/18576
          // non-black pixels in the ground-sample region pre-fix).
          this.doUploadTile(parentKey, this.source.getTileData(parentKey, sliceLayer)!, sliceLayer)
        }

        if (tileZ > maxLevel) {
          // Over-zoom: Mapbox/MapLibre semantic — archive data is
          // capped at maxLevel, so the camera-magnified parent IS
          // the visual representation. Sub-tile clipping only
          // re-clips the same data into smaller tile bounds (no
          // detail gain), introducing per-tile GPU buffer creates,
          // upload-queue churn, and visible "fill in" flicker
          // during pan. We just push the parent as fallback and
          // let the projection scale it up.
          //
          // compileTileOnDemand still runs because backends WITH
          // compileSync (GeoJSON-runtime) genuinely produce finer
          // tiles at higher z by re-tessellating raw geometry
          // — for them, sub-tile is a real refinement. PMTiles +
          // similar archive backends without compileSync return
          // false here, naturally falling through to fallback.
          this.source.compileTileOnDemand(key)
          const cachedSub = layerCache.get(key)
          if (cachedSub) {
            foundCached = true
            const hasGeom =
              cachedSub.indexCount > 0 ||
              cachedSub.lineSegmentCount > 0 ||
              cachedSub.outlineSegmentCount > 0
            if (!hasGeom) {
              fallbackKeys.push(parentKey)
              fallbackOffsets.push(worldOffDeg[i])
            }
          } else {
            // Parent magnification path. NOT counted as "missed" —
            // the parent IS the rendering at over-zoom and nothing
            // is pending. hasPendingUploads() still triggers a
            // re-render for compile-on-demand backends (GeoJSON)
            // when their uploadTile queue is non-empty, so
            // convergence still works without the missedTiles bump.
            fallbackKeys.push(parentKey)
            fallbackOffsets.push(worldOffDeg[i])
            foundCached = true
          }
        } else {
          fallbackKeys.push(parentKey)
          fallbackOffsets.push(worldOffDeg[i]) // same world offset as the child
          foundCached = true
        }
      }

      if (!hasAnyAncestor && !this.source.hasEntryInIndex(key)) {
        const t = tiles[i]
        const wKey = `no-ancestor:${t.z}/${t.x}/${t.y}`
        if (!this.tileDropWarnings.has(wKey)) {
          this.tileDropWarnings.add(wKey)
          console.warn(`[VTR tile-drop] no ancestor found for ${t.z}/${t.x}/${t.y} — dropping from render (maxLevel=${maxLevel}).`)
        }
        continue
      }

      if (!foundCached) {
        if (this.source.hasEntryInIndex(key)) {
          toLoad.push(key)
        } else if (closestExisting >= 0) {
          toLoad.push(closestExisting)
        }
        this._missedTiles++
      }
    }

    // Request missing tiles BEFORE drawing — on-demand tiles compile synchronously
    // and become available in gpuCache within the same frame.
    //
    // Parent prefetch delegates the walk to `firstIndexedAncestor` so
    // the logic is CPU-testable and unified across call sites. The old
    // inline loop capped at 2 levels, which silently dropped every
    // descendant whose real parent lived more than 2 levels up — at
    // z=20 over a maxLevel=5 source, that meant the z=5 parent was
    // never prefetched, VTR drew nothing, and FLICKER fired sustainedly.
    //
    // Set-based dedup: hundreds of z=20 tiles share a single z=5
    // ancestor, so we request it once per frame.
    // parentKeysSet declared above (hoisted for over-zoom fast path).
    // Skip the prefetch loop entirely when EVERY tile was handled by
    // the over-zoom fast path — fast path already populated
    // parentKeysSet for any parents needing fetch, and the per-tile
    // hasEntry/sliceCached calls in this loop would all be redundant
    // (all currentZ keys are out-of-archive, all parents already
    // checked above). Same idea as the primary-renderTileKeys skip
    // below.
    // Anticipatory parent prefetch for IN-ARCHIVE tiles only. The
    // toLoad branch from the legacy prefetch loop is gone: per-tile
    // case 6 already pushes `key`/`closestExisting` into toLoad with
    // the same `hasEntryInIndex` guard, so a second push here was
    // pure duplication (the catalog dedupes against `loadingTiles`
    // but the JS overhead of re-iterating + re-checking still cost
    // ~0.5 ms / render at z=21.6 over Seoul). For over-zoom tiles
    // the fast path already enqueued the maxLevel parent into
    // parentKeysSet, so we skip them entirely — only in-archive
    // tiles whose own ancestor needs prefetching reach the body.
    if (anyInArchive) {
      for (let i = 0; i < neededKeys.length; i++) {
        if (parentAtMaxLevel[i] >= 0) continue
        const pk = archiveAncestor[i]
        if (pk >= 0 && !sliceCached(pk) && !this.source!.isLoading(pk)) {
          parentKeysSet.add(pk)
        }
      }
    }
    // Load parents first, then current zoom tiles
    const parentKeys = [...parentKeysSet]
    if (parentKeys.length > 0) this.source.requestTiles(parentKeys)
    if (toLoad.length > 0) this.source.requestTiles(toLoad)

    // After on-demand compile, newly available tiles may need upload
    for (const key of toLoad) {
      if (!layerCache.has(key) && this.source!.hasTileData(key, sliceLayer)) {
        this.uploadTile(key, this.source!.getTileData(key, sliceLayer)!, sliceLayer)
      }
    }

    // NOW draw (tiles are guaranteed in gpuCache if they compiled synchronously)

    // Render current zoom tiles (stencil write) — with world copy offsets.
    // Translucent line passes have NO depth/stencil attachment, so skip the
    // stencil reference call there.
    //
    // Skip primary renderTileKeys when no tile went through the in-
    // archive path: every neededKey is over-zoom so its gpuCache.get
    // returns null inside renderTileKeys (none of them are populated;
    // fast path uploads only PARENTS, never the over-zoom keys
    // themselves). The function's loop would iterate every key just
    // to `continue`, burning N method calls + N drawKey computations
    // per layer for zero output.
    if (anyInArchive) {
      if (phase !== 'strokes') pass.setStencilReference(1)
      this.renderTileKeys(neededKeys, pass, fillPipeline, linePipeline, projCenterLon, projCenterLat, worldOffDeg, lineLayerOffset, phase, layerCache)
    }

    // Render fallback ancestors (stencil test) — with world offsets for wrapping
    if (fillPipelineFallback && fallbackKeys.length > 0) {
      if (phase !== 'strokes') pass.setStencilReference(0)
      this.renderTileKeys(fallbackKeys, pass, fillPipelineFallback, linePipelineFallback!, projCenterLon, projCenterLat, fallbackOffsets, lineLayerOffset, phase, layerCache)
    }

    // Prefetch adjacent + next zoom (every 10th frame)
    if (this.frameCount % 10 === 0) {
      this.source.prefetchAdjacent(tiles, currentZ)
    }

    // Tier 2: zoom-direction prefetch.
    //
    // When the user is mid-zoom toward an integer boundary, request
    // the *next* LOD's visible tiles in the background so they're
    // GPU-resident by the time `currentZ` actually advances. Without
    // this, the integer boundary still produces a brief
    // missed-tile spike + parent-fallback period — visible as a
    // detail "pop" on the user's screen even with floor-based
    // currentZ + hysteresis (Tier 1).
    //
    // Triggers (only one fires per frame, never both — direction is
    // mutually exclusive at any instant):
    //   * Zoom-in:   camera.zoom > currentZ + 0.5 → prefetch z=cz+1
    //   * Zoom-out:  camera.zoom < currentZ      → prefetch z=cz-1
    //                (cz - 0.3 is the hysteresis switch threshold,
    //                so once user crosses below cz, the prior LOD
    //                is what they're heading toward)
    //
    // Throttled to every 6 frames (~100 ms) to keep
    // visibleTilesFrustum's quadtree walk amortised — the prefetch
    // doesn't need per-frame freshness because the camera typically
    // moves slowly relative to the rAF cadence.
    if (this.frameCount % 6 === 0) {
      let prefetchZ = -1
      if (camera.zoom > currentZ + 0.5 && currentZ + 1 <= maxSubTileZ) {
        prefetchZ = currentZ + 1
      } else if (camera.zoom < currentZ && currentZ - 1 >= 0) {
        prefetchZ = currentZ - 1
      }
      if (prefetchZ >= 0) {
        const prefetchTiles = visibleTilesFrustum(
          camera, selectorProj, prefetchZ,
          canvasWidth, canvasHeight, offsetMarginPx,
        )
        const prefetchKeys: number[] = []
        for (const t of prefetchTiles) {
          const k = tileKey(t.z, t.x, t.y)
          // Skip already-loaded / already-loading — the catalog's
          // requestTiles dedupes too, but doing the cheap check here
          // saves the array allocation when we're already converged.
          if (!sliceCached(k) && !this.source!.isLoading(k)) {
            prefetchKeys.push(k)
          }
        }
        if (prefetchKeys.length > 0) {
          this.source.requestTiles(prefetchKeys)
        }
      }
    }

    // Track stable tile set for eviction protection and point rendering.
    // IMPORTANT: include fallbackKeys too — those tiles' buffers are bound
    // in bind groups used by the draw calls we just recorded. Evicting them
    // now would destroy their buffers before `queue.submit()` runs, causing
    // "Buffer used in submit while destroyed" validation errors.
    if (fallbackKeys.length > 0) {
      const merged = new Set<number>(neededKeys)
      for (const k of fallbackKeys) merged.add(k)
      this.stableKeys = [...merged]
    } else {
      this.stableKeys = neededKeys
    }

    // GPU cache eviction is deferred to beginFrame() — see the comment
    // there for why mid-frame eviction races with the bucket scheduler's
    // multi-render-per-frame pattern. Cache may transiently hold a few
    // tiles above MAX_GPU_TILES between frames; bounded by the per-frame
    // upload budget, so memory pressure is unaffected.

    // Render tile-based points via PointRenderer (if available).
    // Tile point vertices are DSFUN stride 5: [mx_h, my_h, mx_l, my_l, feat_id]
    // in tile-local Mercator meters. We reconstruct f64-equivalent tile-local
    // meters via (h + l) on the TS side and subtract the camera's tile-local
    // position to get a small, f32-safe camera-relative offset.
    //
    // Skip when the layer hasn't opted into point rendering (no size,
    // no shape, no size expression). PMTiles MVT layers like
    // 'buildings' carry centroid Point features alongside polygons —
    // without this guard, a polygon-only layer like
    // `layer buildings { | fill-stone-700 stroke-stone-500 stroke-0.5 }`
    // would draw circle dots over every building centroid using
    // PointRenderer's default style (the user reported these as
    // "POI points appearing without being declared").
    const hasPointStyle = show.size !== null || show.shape !== null || show.sizeExpr !== null
    if (hasPointStyle && pointRenderer && typeof pointRenderer.addTilePoint === 'function') {
      const DEG2RAD = Math.PI / 180
      const R = 6378137
      const LAT_LIMIT = 85.051129
      const clampLat = (v: number) => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, v))
      const camMercX = projCenterLon * DEG2RAD * R
      const camMercY = Math.log(Math.tan(Math.PI / 4 + clampLat(projCenterLat) * DEG2RAD / 2)) * R

      for (const key of this.stableKeys) {
        const tileData = this.source!.getTileData(key, sliceLayer)
        if (!tileData?.pointVertices || tileData.pointVertices.length < 5) continue
        const ptv = tileData.pointVertices
        const tileMercX = tileData.tileWest * DEG2RAD * R
        const tileMercY = Math.log(Math.tan(Math.PI / 4 + clampLat(tileData.tileSouth) * DEG2RAD / 2)) * R
        const camRelX = camMercX - tileMercX // camera in tile-local Mercator frame (f64)
        const camRelY = camMercY - tileMercY
        for (let i = 0; i < ptv.length; i += 5) {
          // Reconstruct tile-local merc from DSFUN high+low pair
          const ptMxLocal = ptv[i] + ptv[i + 2]
          const ptMyLocal = ptv[i + 1] + ptv[i + 3]
          pointRenderer.addTilePoint(ptMxLocal - camRelX, ptMyLocal - camRelY, ptv[i + 4])
        }
      }
      pointRenderer.flushTilePoints(pass, camera, projType, projCenterLon, projCenterLat, canvasWidth, canvasHeight, show)
    }
  }

  private renderTileKeys(
    keys: number[],
    pass: GPURenderPassEncoder,
    fillPipeline: GPURenderPipeline,
    linePipeline: GPURenderPipeline,
    projCenterLon: number,
    projCenterLat: number,
    worldOffsets: number[] | undefined,
    lineLayerOffset: number,
    phase: LayerDrawPhase,
    layerCache: Map<number, GPUTile>,
  ): void {
    const drawFills = phase !== 'strokes'
    const drawStrokes = phase !== 'fills'
    const translucentLines = phase === 'strokes'
    const tileBg = this.tileBgFeature ?? this.tileBgDefault
    if (!tileBg || !this.uniformRing) return
    for (let ki = 0; ki < keys.length; ki++) {
      const key = keys[ki]
      // For world copies: allow same key to render at different positions
      const worldOff = worldOffsets?.[ki] ?? 0
      const drawKey = worldOff === 0 ? key : key + worldOff * 1000000 // unique draw key per copy
      if (this.renderedDraws.has(drawKey)) continue
      const cached = layerCache.get(key)
      if (!cached) continue

      cached.lastUsedFrame = this.frameCount

      // Tile pop-in: new tiles appear immediately at full opacity.
      // A fade-in used to ramp alpha 0→1 over ~10 frames, but that made
      // each newly-loaded tile visually EMPTY for 10 frames (no fallback
      // once the child is cached), producing a continuous flicker during
      // active zoom as tiles finish loading one by one. Instant pop-in is
      // visually cleaner and matches the loading sequence's natural cadence.
      const baseFillA = this.cachedFillColor[3] * (this.currentOpacity ?? 1.0)
      const baseStrokeA = this.cachedStrokeColor[3] * (this.currentOpacity ?? 1.0)
      this.uniformF32[19] = baseFillA
      this.uniformF32[23] = baseStrokeA
      // u.opacity for shader variants is written at index 34 (offset 136)
      // in the DSFUN uniform block, below — keep it off the pre-tile pack so
      // we only write it once per slot.

      // DSFUN uniform pack:
      // cam_h/cam_l = splitF64(cam_merc - tile_origin_merc) so the GPU
      // subtraction (pos_h - cam_h) + (pos_l - cam_l) cancels tile-origin
      // magnitude and yields camera-relative meters at f64-equivalent
      // precision regardless of camera zoom.
      const DEG2RAD = Math.PI / 180
      const R = 6378137
      const MERC_LIMIT = 85.051129
      const clampLat = (v: number) => Math.max(-MERC_LIMIT, Math.min(MERC_LIMIT, v))
      // Vertex data is in Mercator meters regardless of current projection:
      // the tiler always pre-projects to Mercator. Non-Mercator reprojection
      // happens in the shader via abs merc → lon/lat → project().
      const tileMercX = (cached.tileWest + worldOff) * DEG2RAD * R
      const tileMercY = Math.log(Math.tan(Math.PI / 4 + clampLat(cached.tileSouth) * DEG2RAD / 2)) * R
      const camMercX = projCenterLon * DEG2RAD * R
      const camMercY = Math.log(Math.tan(Math.PI / 4 + clampLat(projCenterLat) * DEG2RAD / 2)) * R
      const camRelX = camMercX - tileMercX // f64 cancellation
      const camRelY = camMercY - tileMercY

      const camRelXH = Math.fround(camRelX)
      const camRelXL = Math.fround(camRelX - camRelXH)
      const camRelYH = Math.fround(camRelY)
      const camRelYL = Math.fround(camRelY - camRelYH)

      // cam_h (28-29), cam_l (30-31) — offsets 112..127
      this.uniformF32[28] = camRelXH
      this.uniformF32[29] = camRelYH
      this.uniformF32[30] = camRelXL
      this.uniformF32[31] = camRelYL

      // tile_origin_merc (32-33) + opacity (34) + log_depth_fc (35)
      // — offsets 128..143. log_depth_fc was cached by camera.getRTCMatrix
      // and is shared across every tile drawn this frame.
      this.uniformF32[32] = Math.fround(tileMercX)
      this.uniformF32[33] = Math.fround(tileMercY)
      this.uniformF32[34] = this.currentOpacity ?? 1.0
      this.uniformF32[35] = this.logDepthFc
      // pick_id (36) — packed (instanceId<<16)|layerId. instanceId is
      // 0 for now; future WORLD_COPIES instancing will pack it here.
      // Cached on the show by XGISMap after LayerIdRegistry.register().
      this.uniformU32[36] = this.currentPickId
      // layer_depth_offset (37) — per-layer NDC-z bias to disambiguate
      // coplanar fills under log-depth (filter_gdp at pitch=46.5 z-fight
      // bug, 2026-05-04). 1e-3 per layer was empirically chosen to
      // overcome the log-depth precision compression at moderate pitch
      // (~10 effective bits at 85°). Layer index = pickId & 0xFFFF —
      // pickIds are assigned in style declaration order so this matches
      // the bucket scheduler's draw order.
      this.uniformF32[37] = (this.currentPickId & 0xFFFF) * 1e-3

      // Allocate a fresh ring slot for this tile × layer × world-copy draw.
      const slotOffset = this.allocUniformSlot()
      // Ring may have grown in allocUniformSlot — use current (rebuilt) bind groups.
      const currentTileBg = this.tileBgFeature ?? this.tileBgDefault!
      const currentLineTileBg = this.tileBgDefault!
      // Stage the slot into the CPU-side mirror instead of issuing one
      // writeBuffer per tile; the mirror is flushed in a single call at
      // the end of this renderTileKeys invocation.
      this.stageUniformSlot(slotOffset, this.uniformDataBuf)

      // Polygon fills — skipped in 'strokes' phase (offscreen line-only RT).
      // ALSO skipped when render() flagged this layer as having an
      // effectively-invisible fill (no shader variant + zero alpha). Common
      // case: multi_layer's `borders | stroke-* opacity-80` gets routed
      // into the opaque bucket as fillPhase='fills' but declared no fill —
      // the fragment shader was rasterising every covered pixel just to
      // write α=0. Skipping the whole draw saves ~2-3 ms of GPU per frame
      // on multi_layer-class scenes. Data-driven `fill match(...)` is NOT
      // skipped (variant pipeline computes color in shader, cached uniform
      // alpha may be zero even when the draw is meaningful).
      if (drawFills && cached.indexCount > 0 && !this._skipFillDraw) {
        pass.setPipeline(fillPipeline)
        pass.setBindGroup(0, currentTileBg, [slotOffset])
        pass.setVertexBuffer(0, cached.vertexBuffer)
        pass.setIndexBuffer(cached.indexBuffer, 'uint32')
        pass.drawIndexed(cached.indexCount)
      }

      // Polygon outlines via SDF line renderer — skipped in 'fills' phase.
      if (drawStrokes && this.lineRenderer && cached.outlineSegmentCount > 0 && cached.outlineSegmentBindGroup) {
        this.lineRenderer.drawSegments(pass, currentLineTileBg, cached.outlineSegmentBindGroup, cached.outlineSegmentCount, slotOffset, lineLayerOffset, translucentLines)
      }

      // Line features via SDF line renderer — skipped in 'fills' phase.
      if (drawStrokes && this.lineRenderer && cached.lineSegmentCount > 0 && cached.lineSegmentBindGroup) {
        this.lineRenderer.drawSegments(pass, currentLineTileBg, cached.lineSegmentBindGroup, cached.lineSegmentCount, slotOffset, lineLayerOffset, translucentLines)
      }

      const vc = cached.indexCount + cached.lineIndexCount
      this.renderedDraws.set(drawKey, { polyCount: cached.indexCount, lineCount: cached.lineIndexCount, vertexCount: vc })
      // Frame-scoped accumulators (sum across all render() calls
      // within one frame so getDrawStats() reflects the FRAME total
      // for sliced sources rather than the last layer's stats).
      this._frameTilesVisible++
      this._frameVertices += vc
      if (cached.indexCount > 0) { this._frameDrawCalls++; this._frameTriangles += Math.floor(cached.indexCount / 3) }
      if (cached.lineIndexCount > 0) { this._frameDrawCalls++; this._frameLines += Math.floor(cached.lineIndexCount / 2) }
    }
    // Emit accumulated per-tile uniforms as one writeBuffer. Still
    // before queue.submit() — the encoded draws read the fresh ring
    // data by WebGPU's submit-ordering guarantees.
    this.flushUniformStaging()
  }

  /** Drop LRU tiles past MAX_GPU_TILES and destroy their GPU buffers.
   *  ONLY called from `beginFrame()` so the previous frame's
   *  `queue.submit()` has already returned — destroying buffers here
   *  cannot poison an in-flight submit. Calling this from inside
   *  `render()` (the old behaviour) raced the bucket scheduler's
   *  multi-render-per-frame pattern; see beginFrame() for the full
   *  story. */
  private evictGPUTiles(): void {
    // Cap is on UNIQUE TILE KEYS, not composite (key, layer) entries —
    // a sliced source (PMTiles water/roads/buildings/...) generates
    // ~4 entries per tile, so a per-entry cap would let 100 visible
    // tiles × 4 layers = 400 entries blow MAX_GPU_TILES = 512 with
    // only 128 unique tiles. That under-counts what's actually visible
    // and triggers thrash. Counting unique keys keeps "tiles in flight"
    // bounded by tile geometry, not layer count. Slices share lifetime
    // — once a tile leaves the viewport every layer's slice is
    // irrelevant, so they evict together.
    // Aggregate per-tile-key entries across all layer slots. Each
    // bucket records the slot names (so we can drop the per-slot
    // entries together) and the latest lastUsedFrame across slots.
    const byTileKey = new Map<number, { lastUsed: number; tileZoom: number; slots: string[] }>()
    for (const [slot, inner] of this.gpuCache) {
      for (const [tk, tile] of inner) {
        let bucket = byTileKey.get(tk)
        if (!bucket) {
          bucket = { lastUsed: tile.lastUsedFrame, tileZoom: tile.tileZoom, slots: [] }
          byTileKey.set(tk, bucket)
        }
        bucket.slots.push(slot)
        if (tile.lastUsedFrame > bucket.lastUsed) bucket.lastUsed = tile.lastUsedFrame
      }
    }
    if (byTileKey.size <= MAX_GPU_TILES) return

    // Protect indexed ancestors (tileZoom ≤ sourceMaxLevel) plus
    // the current frame's stableKeys. Indexed ancestors are the
    // fallback backbone — every over-zoom sub-tile relies on its
    // nearest indexed ancestor staying in gpuCache.
    const sourceMaxLevel = this.source?.maxLevel ?? 4
    const safeBelow = Math.max(4, sourceMaxLevel)
    const protectedKeys = new Set(this.stableKeys)

    const evictable: { tk: number; lastUsed: number; slots: string[] }[] = []
    for (const [tk, bucket] of byTileKey) {
      if (protectedKeys.has(tk)) continue
      if (bucket.tileZoom <= safeBelow) continue
      evictable.push({ tk, lastUsed: bucket.lastUsed, slots: bucket.slots })
    }
    evictable.sort((a, b) => a.lastUsed - b.lastUsed)

    const toEvict = byTileKey.size - MAX_GPU_TILES
    for (let i = 0; i < toEvict && i < evictable.length; i++) {
      const ev = evictable[i]
      for (const slot of ev.slots) {
        const inner = this.gpuCache.get(slot)
        if (!inner) continue
        const tile = inner.get(ev.tk)
        if (!tile) continue
        tile.vertexBuffer.destroy()
        tile.indexBuffer.destroy()
        tile.lineVertexBuffer?.destroy()
        tile.lineIndexBuffer?.destroy()
        tile.outlineIndexBuffer?.destroy()
        tile.outlineSegmentBuffer?.destroy()
        tile.lineSegmentBuffer?.destroy()
        inner.delete(ev.tk)
        this._gpuCacheCount--
      }
    }
  }
}

// ═══ Helpers ═══

function parseHexColor(hex: string): [number, number, number, number] {
  let r = 0, g = 0, b = 0, a = 1
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
  } else if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16) / 255
    g = parseInt(hex.slice(3, 5), 16) / 255
    b = parseInt(hex.slice(5, 7), 16) / 255
  } else if (hex.length === 9) {
    r = parseInt(hex.slice(1, 3), 16) / 255
    g = parseInt(hex.slice(3, 5), 16) / 255
    b = parseInt(hex.slice(5, 7), 16) / 255
    a = parseInt(hex.slice(7, 9), 16) / 255
  }
  return [r, g, b, a]
}
