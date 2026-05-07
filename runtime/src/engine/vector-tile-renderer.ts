// ═══ Vector Tile Renderer (GPU Layer) ═══
// Renders vector tiles from a TileCatalog to WebGPU.
// Data loading/caching/sub-tiling is handled by TileCatalog.
// This class manages GPU buffers, bind groups, and draw calls only.

import type { GPUContext } from './gpu'
import type { Camera } from './camera'
import type { ShowCommand } from './renderer'
import { visibleTilesFrustum, visibleTilesFrustumSampled, sortByPriority } from '../loader/tiles'
import { classifyTile, computeProtectedKeys, type TileDecision } from './tile-decision'
import { generateWallMesh, quantizePolygonVertices } from './polygon-mesh'
import { tileKey, tileKeyParent, tileKeyChildren, type PropertyTable } from '@xgis/compiler'
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
  /** Timestamp (performance.now) at upload. Available for diagnostics
   *  and future tile-fade implementations. */
  uploadTimeMs: number
}

// Per-VTR GPU tile cache cap on UNIQUE tile keys. With sliced
// sources (PMTiles N-layer) one tile = N entries × ~7 buffers.
// Capping at 256 unique keys × 4 typical layers × 7 = ~7K live GPU
// buffers — well within Chrome's tolerance now that the previous
// STATUS_BREAKPOINT root causes are fixed (vertexKey int32 overflow
// inflating vertex counts, missing per-layer decoder filter
// loading 10+ unused slices per tile, duplicate LoadCommands
// spawning 4× orphan VTRs all hammering GPU).
const MAX_GPU_TILES_DESKTOP = 256
/** Mobile cap on UNIQUE tile keys held in gpuCache. Real-device
 *  iPhone inspector showed gpu cache at 733 entries (146 unique
 *  keys × 5 layers = 730 entries) for a 256-unique cap — plenty
 *  of GPU memory retained while only ~50 unique keys were on
 *  screen. 64 unique × 5 layers = 320 entries puts the resident
 *  GPU footprint at roughly 1/2.3 of the desktop ceiling without
 *  forcing visible-tile thrash (visible viewport on a mobile
 *  canvas is 10-20 unique keys at any settled zoom). */
const MAX_GPU_TILES_MOBILE = 64
function getMaxGpuTiles(): number {
  const w = (typeof window !== 'undefined' ? window.innerWidth : 0) || 0
  return w > 0 && w <= 900 ? MAX_GPU_TILES_MOBILE : MAX_GPU_TILES_DESKTOP
}
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
/** Mobile-specific upload budget — main-thread `buildLineSegments`
 *  runs synchronously on every doUploadTile for the XGVT-binary path
 *  (PMTiles' worker decode bypasses it). Capping mobile uploads to
 *  1/frame stretches the CPU work over more frames so a flurry of
 *  zoom-out fetches can't stall the render loop. Tile catch-up takes
 *  ~4× the wall time, but visible during gestures (settled state
 *  is identical). User-reported heat + forced refresh on mobile
 *  during fast pinch zoom motivated this; addresses the synchronous
 *  CPU spike that the GPU buffer pool change alone could not. */
function uploadBudgetFor(canvasW: number, canvasH: number): number {
  // Test hook: spec sets `globalThis.__XGIS_UPLOAD_BUDGET` to force
  // queue-deferred uploads on every render call so the parent-walk
  // fallback path is exercised deterministically. Production paths
  // never set this, so the constant lookup is a single property read.
  const o = (globalThis as { __XGIS_UPLOAD_BUDGET?: number }).__XGIS_UPLOAD_BUDGET
  if (typeof o === 'number') return o
  return Math.max(canvasW, canvasH) <= 900 ? 1 : MAX_UPLOADS_PER_FRAME
}

// ═══ Renderer ═══

const UNIFORM_SLOT = 256
const UNIFORM_SIZE = 160

/** 2π × Earth radius (m). One full mercator wrap. tile_extent_m at
 *  any zoom z is this constant divided by 2^z (vs_main_quantized
 *  dequant scale). */
const TWO_PI_R_EARTH = 2 * Math.PI * 6378137

/** Cesium replacement-invariant ancestor protection depth. Caps the
 *  number of pyramid levels above each visible tile that are held
 *  pinned in the catalog cache. 4 covers the typical fallback walk
 *  depth (1-2 levels of parent miss + headroom) without letting the
 *  protected set explode at deep zoom. */
const ANCESTOR_PROTECT_DEPTH = 4

// Polygon mesh quantization + wall generation moved to engine/
// polygon-mesh.ts so the math is unit-testable independent of GPU
// state. See `quantizePolygonVertices` + `generateWallMesh`.

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
  /** Pending cz advance — populated when the camera crosses a
   *  zoom-transition threshold but the target LOD's tiles aren't
   *  yet cached. The render keeps drawing at the OLD cz (so the
   *  user sees the previous LOD over-zoomed instead of blank tiles)
   *  until either every visible tile at `target` is cached OR
   *  `READINESS_TIMEOUT_MS` elapses. Cleared on advance + on any
   *  frame the threshold is no longer crossed. */
  private _czPendingAdvance: { target: number, since: number } | null = null
  private stableKeys: number[] = []
  /** Camera idle detection — prefetch is suppressed while the
   *  camera is actively moving (pinch zoom, pan) to keep mobile
   *  GPU + bandwidth budget on visible-only work. The moment the
   *  camera stops changing, the suppression times out and Tier 2
   *  + adjacent prefetch resume. User report: rapid pinch zoom-out
   *  + pan caused thermal throttling and forced refreshes; the
   *  GPU upload churn from prefetch on every frame was a major
   *  contributor on top of the visible-tile work. */
  private _lastCamSnap: { zoom: number; cx: number; cy: number; t: number } | null = null
  private _lastCamMoveAt = 0
  /** GPU buffer pool — keyed by `{powerOfTwoBucketSize}:{usage}`.
   *  doUploadTile and evictGPUTiles together create + destroy 5+
   *  GPUBuffers per tile, several times per frame on mobile during
   *  fast pinch/pan. Each createBuffer / destroy is a GPU driver
   *  call; pooling lets us hand a freed buffer straight back to
   *  the next acquire instead of round-tripping through the
   *  driver. Buckets are powers of two from 2 KB → 4 MB so size-
   *  fit reuse works across tiles with similar feature density.
   *  Cap per bucket prevents the pool itself from holding GPU
   *  memory hostage. */
  private _bufferPool = new Map<string, GPUBuffer[]>()
  private static readonly _BUFFER_POOL_CAP_PER_BUCKET = 16
  private static _bufferBucketSize(size: number): number {
    let bucket = 2048
    while (bucket < size) bucket *= 2
    return bucket
  }
  private acquireBuffer(size: number, usage: GPUBufferUsageFlags, label: string): GPUBuffer {
    const bucket = VectorTileRenderer._bufferBucketSize(size)
    const key = `${bucket}:${usage}`
    const pool = this._bufferPool.get(key)
    if (pool && pool.length > 0) return pool.pop()!
    return this.device.createBuffer({ size: bucket, usage, label })
  }
  private releaseBuffer(buf: GPUBuffer | null | undefined): void {
    if (!buf) return
    const key = `${buf.size}:${buf.usage}`
    let pool = this._bufferPool.get(key)
    if (!pool) { pool = []; this._bufferPool.set(key, pool) }
    if (pool.length < VectorTileRenderer._BUFFER_POOL_CAP_PER_BUCKET) {
      pool.push(buf)
    } else {
      buf.destroy()
    }
  }
  /** Hot-path scratch collections — reused across render() calls
   *  to avoid per-frame Set/Map allocations. Each is `.clear()`'d
   *  before use; the same instance is fine because multi-render-
   *  per-frame is sequential (one ShowCommand at a time, and each
   *  render's lifetime is bounded by the function call). Total
   *  per-frame allocation drop: 5 × 4 layers ≈ 20 collections
   *  removed from the GC nursery. */
  private _scratchActiveKeys = new Set<number>()
  private _scratchSliceCachedMemo = new Map<number, boolean>()
  private _scratchParentKeysSet = new Set<number>()
  private _scratchMergedStableKeys = new Set<number>()
  private _scratchProtectedKeys = new Set<number>()
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
  /** 3D extrusion height (metres) for the current `render()` call. Set
   *  per-show; uniform written per-tile from this. MVP: 50 m for the
   *  `buildings` MVT slice, 0 elsewhere. Future: per-feature data-
   *  driven via PropertyTable + style `extrude:` syntax. */
  private currentExtrudeHeight = 0
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
    this._frameDrawnByZoom.clear()
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
    if (this._gpuCacheCount > getMaxGpuTiles()) this.evictGPUTiles()
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
      const guard = this._scratchProtectedKeys
      guard.clear()
      computeProtectedKeys(this.stableKeys, ANCESTOR_PROTECT_DEPTH, tileKeyParent, guard)
      this.source.evictTiles(guard)
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
  /** Per-decision counts from the last render() call. Always tracked
   *  (cheap — Map of ~7 string keys). Exposed via
   *  `getLastDecisionCounts()` for inspector / console diagnosis.
   *  Reset on every render() entry. */
  private _lastDecisionCounts: Map<string, number> = new Map()

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

  /** Diagnostic — per-decision tile count from the last completed
   *  `render()` call. Always populated (small cost, single counter
   *  Map per VTR). Inspector / browser-console consumers query this
   *  to see what each visible tile was resolved as:
   *
   *    primary             — drew via layerCache hit
   *    parent-fallback     — cached ancestor pushed
   *    child-fallback      — deck.gl best-available children stretch
   *    overzoom-parent     — over-zoom fast-path parent at maxLevel
   *    drop-empty-slice    — sliced source: this layer empty here
   *    drop-no-archive     — tile not in archive index
   *    pending             — fetch issued, no fallback found yet
   *    queued-no-fb (BUG)  — uploadTile queued, no fallback (49d4801)
   */
  getLastDecisionCounts(): Record<string, number> {
    return Object.fromEntries(this._lastDecisionCounts)
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
  /** Per-zoom drawn-tile count for the inspector's "drawn by zoom"
   *  display. Distinguishes tiles ACTUALLY rendered this frame from
   *  tiles merely retained in gpuCache. The zoom keyspace is small
   *  (~22 zoom levels max) so a Map cleared each frame is cheap. */
  private _frameDrawnByZoom: Map<number, number> = new Map()

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
    //
    // Polygon vertex pipeline:
    //   * Top face: DSFUN F32×5 → quantized u16×2 + f32 stride 8
    //     (60 % byte reduction). is_top flag in bit 15 of x for
    //     extruded layers so the shader lifts to z=extrude_height_m.
    //   * Side walls (extruded layers only): emit per-edge wall
    //     quads from the polygon ring data and concat onto the top
    //     vertex/index buffers. is_top alternates 0/1 for the
    //     bottom/top wall corners.
    const tileExtentM = TWO_PI_R_EARTH / Math.pow(2, data.tileZoom)
    const isExtruded = sourceLayer === 'buildings'
    const topVerts = quantizePolygonVertices(data.vertices, tileExtentM, { isTop: isExtruded })
    const topVertexCount = topVerts.byteLength / 8
    let polyVerts: ArrayBuffer = topVerts
    let polyIndices: Uint32Array = data.indices
    if (isExtruded && data.polygons && data.polygons.length > 0) {
      // Tile origin in mercator metres — needed because polygon ring
      // coords are absolute mercator, not tile-local.
      const DEG2RAD = Math.PI / 180
      const R = 6378137
      const tileMx = (data.tileWest) * DEG2RAD * R
      const clampLat = Math.max(-85.051129, Math.min(85.051129, data.tileSouth))
      const tileMy = Math.log(Math.tan(Math.PI / 4 + clampLat * DEG2RAD / 2)) * R
      const wall = generateWallMesh(data.polygons, tileExtentM, tileMx, tileMy)
      // Concat vertex buffer
      const combined = new Uint8Array(topVerts.byteLength + wall.vertices.byteLength)
      combined.set(new Uint8Array(topVerts), 0)
      combined.set(new Uint8Array(wall.vertices), topVerts.byteLength)
      polyVerts = combined.buffer
      // Concat index buffer with offset for wall indices
      polyIndices = new Uint32Array(data.indices.length + wall.indices.length)
      polyIndices.set(data.indices, 0)
      for (let i = 0; i < wall.indices.length; i++) {
        polyIndices[data.indices.length + i] = wall.indices[i] + topVertexCount
      }
    }
    const vertexBuffer = this.acquireBuffer(
      Math.max(polyVerts.byteLength * 3, 12),
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      'tile-vertices',
    )
    this.device.queue.writeBuffer(vertexBuffer, 0, polyVerts)

    const indexBuffer = this.acquireBuffer(
      Math.max(polyIndices.byteLength * 3, 4),
      GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      'tile-indices',
    )
    this.device.queue.writeBuffer(indexBuffer, 0, polyIndices)

    let lineVertexBuffer: GPUBuffer | null = null
    let lineIndexBuffer: GPUBuffer | null = null
    if (data.lineVertices.length > 0) {
      lineVertexBuffer = this.acquireBuffer(
        data.lineVertices.byteLength,
        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        'tile-line-vertices',
      )
      this.device.queue.writeBuffer(lineVertexBuffer, 0, data.lineVertices)

      lineIndexBuffer = this.acquireBuffer(
        data.lineIndices.byteLength,
        GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        'tile-line-indices',
      )
      this.device.queue.writeBuffer(lineIndexBuffer, 0, data.lineIndices)
    }

    // Outline indices (polygon edges, reuses polygon vertex buffer)
    let outlineIndexBuffer: GPUBuffer | null = null
    let outlineIndexCount = 0
    if (data.outlineIndices && data.outlineIndices.length > 0) {
      outlineIndexBuffer = this.acquireBuffer(
        Math.max(data.outlineIndices.byteLength, 4),
        GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        'tile-outline-indices',
      )
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
      indexCount: polyIndices.length,
      lineVertexBuffer, lineIndexBuffer,
      lineIndexCount: data.lineIndices.length,
      outlineIndexBuffer, outlineIndexCount,
      outlineSegmentBuffer, outlineSegmentCount, outlineSegmentBindGroup,
      lineSegmentBuffer, lineSegmentCount, lineSegmentBindGroup,
      tileWest: data.tileWest, tileSouth: data.tileSouth,
      tileWidth: data.tileWidth, tileHeight: data.tileHeight,
      tileZoom: data.tileZoom,
      lastUsedFrame: this.frameCount,
      uploadTimeMs: performance.now(),
    })
    this._gpuCacheCount++

    // Drop main-thread copies of GPU-resident SDF segment buffers.
    // These are 45 % of catalog memory on a fully-warm world-scale
    // cache (measured at 180 MB / 401 MB total in
    // _pmtiles-stress-leak.spec.ts). They were retained only as a
    // worker-decoded handoff to the upload step; the GPU buffers
    // are now the source of truth. If the GPU side gets evicted
    // and a re-upload is needed later, buildLineSegments
    // (main thread, ~few ms per tile) regenerates them on demand —
    // a vastly better trade than the steady-state heap cost.
    data.prebuiltLineSegments = undefined
    data.prebuiltOutlineSegments = undefined

    // Drop the raw polygon rings too — these are RingPolygon[] (plain
    // JS nested arrays) retained only for sub-tile generation when
    // visible zoom exceeds archive maxLevel. At sub-archive zooms (the
    // common case: PMTiles maxLevel = 15, user is at z=8-14) sub-tile
    // gen never fires, so the rings are pure overhead — and they're
    // big: real-device iPhone inspector at Tokyo z=9.1 showed 4 tiles
    // × ~73 MB total, with rings the dominant share. The over-zoom
    // path (catalog.generateSubTile) already has a fallback for
    // missing polygons via outlineIndices (legacy dash-phase reset
    // recurs there but visible content stays correct), so drop is
    // safe — just at the cost of slightly worse over-zoom dash
    // continuity at z > maxLevel, a corner of the camera space the
    // app rarely sits in.
    data.polygons = undefined
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

    // Cap upload budget for mobile viewports. beginFrame() initialised
    // it to MAX_UPLOADS_PER_FRAME; we tighten it here once we know the
    // canvas size. Multi-render-per-frame: same VTR sees this clamp
    // on every layer's render call, so the cap is shared across the
    // frame's layer iterations (not multiplied).
    const _frameBudget = uploadBudgetFor(canvasWidth, canvasHeight)
    if (this._uploadBudget > _frameBudget) this._uploadBudget = _frameBudget

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

    // Hoisted: visibleTilesFrustum inputs needed both by the readiness
    // gate (in hysteresis below) and by the main visible-tile selection
    // further down. Cheap pure derivations; safe to compute once up here.
    const strokeOffsetPx_h = Math.abs(show.strokeOffset ?? 0)
    const strokeWidthPx_h = show.strokeWidth ?? 1
    const alignDeltaPx_h = show.strokeAlign === 'inset' || show.strokeAlign === 'outset'
      ? strokeWidthPx_h / 2 : 0
    const offsetMarginPx = Math.ceil(strokeOffsetPx_h + alignDeltaPx_h + strokeWidthPx_h / 2 + 2)
    const selectorProj = projType === 0
      ? mercatorProj
      : { name: 'non-mercator', forward: mercatorProj.forward, inverse: mercatorProj.inverse }

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
    // Camera-idle detection. Tier 2 + adjacent prefetch are
    // suppressed for IDLE_GRACE_MS after the last detected camera
    // movement so rapid pinch / pan doesn't drown mobile GPU + net
    // budget in speculative LOD/edge fetches that the user is
    // about to invalidate anyway. 200 ms catches the gesture's
    // settle moment without delaying prefetch on a deliberate
    // pause. Movement threshold: > 0.005 zoom or > 1 m centre
    // delta — well above floating-point noise, well below any
    // visible navigation step.
    const IDLE_GRACE_MS = 200
    const nowCam = performance.now()
    if (this._lastCamSnap) {
      const dz = Math.abs(camera.zoom - this._lastCamSnap.zoom)
      const dx = Math.abs(camera.centerX - this._lastCamSnap.cx)
      const dy = Math.abs(camera.centerY - this._lastCamSnap.cy)
      if (dz > 0.005 || dx > 1 || dy > 1) {
        this._lastCamMoveAt = nowCam
      }
    }
    this._lastCamSnap = { zoom: camera.zoom, cx: camera.centerX, cy: camera.centerY, t: nowCam }
    const cameraIdle = nowCam - this._lastCamMoveAt > IDLE_GRACE_MS

    const HYST_MARGIN = 0.1
    // Readiness-gate timeout: once a transition is "wanted" (camera
    // has crossed the hysteresis threshold), we hold the OLD cz —
    // so the user keeps seeing the previous LOD over-zoomed — until
    // every visible tile at the new LOD is cached. That prevents
    // blank-canvas flashes during fast zoom moves. The timeout is
    // a safety net for hung networks / unbounded archives: after
    // 5 s of holding, advance anyway so the user isn't stuck on a
    // permanently-stale LOD if the upstream is broken.
    const READINESS_TIMEOUT_MS = 5_000
    const z = camera.zoom
    let cz: number
    if (this._hysteresisZ < 0) {
      cz = Math.round(z)
      this._czPendingAdvance = null
    } else if (Math.abs(Math.round(z) - this._hysteresisZ) > 4) {
      // Bulk camera move (URL hash, programmatic camera reset,
      // jumpTo). The gate is designed for incremental user-driven
      // transitions; for jumps spanning more than ~4 LODs we'd
      // otherwise spend ~1 s per LOD climbing step-by-step, which
      // looks broken. Snap straight to target and let the normal
      // visible-tile pipeline + parent walk render whatever
      // ancestors happen to be cached on the way.
      cz = Math.round(z)
      this._czPendingAdvance = null
    } else {
      cz = this._hysteresisZ
      const target = Math.round(z)
      let wantAdvance = false
      const zoomingIn = target > cz && z > cz + 0.5 + HYST_MARGIN
      const zoomingOut = target < cz && z < cz - 0.5 + HYST_MARGIN
      if (zoomingIn) wantAdvance = true
      else if (zoomingOut) {
        // Zoom-out: do NOT gate. Holding cz at the higher LOD while
        // the camera shows a lower zoom forces visibleTilesFrustum
        // to enumerate hundreds of small tiles to cover the now-
        // much-larger viewport — measured 140 → 92 tilesVisible
        // peak in _mobile-zoom-out-load.spec.ts (35 % drop). User
        // reported severe heat + forced page refresh on mobile; the
        // tile fan-out is the underlying GPU/CPU stressor. The
        // reason gating helped in the zoom-IN direction was that
        // one parent tile covers the whole viewport over-zoomed,
        // producing 1-30 visible tiles. Zoom-out has no such
        // symmetry: a parent tile does NOT compose from cached
        // children in our render pipeline, so holding the child cz
        // means rendering children-of-children until the parent
        // fetches. Just advance; the parent walk magnifies the
        // nearest cached ancestor (or fetches if needed) — same
        // mechanism the renderer uses for any cache miss.
        cz = target
        this._czPendingAdvance = null
      }

      // Per-layer minzoom skip: layers like protomaps `roads` (z≥6)
      // and `buildings` (z≥14) carry no features below their minzoom.
      // When the gate's step LOD is below that floor, no fetch will
      // ever satisfy `hasTileData(k, sliceLayer)` and the gate would
      // stall forever. Treat below-minzoom steps as already ready —
      // catalog has nothing to wait on.
      const layerRange = sliceLayer
        ? this.source.getLayerZoomRange?.(sliceLayer)
        : null
      if (wantAdvance) {
        const now = performance.now()
        // Step-by-step advance: never jump cz multiple LODs in one
        // frame. The gate examines readiness of cz±1 (one step
        // toward target) and advances only that one LOD; on the
        // next frame, cz±1 → cz±2 if the next step is ready, and
        // so on. Two reasons we don't jump straight to target:
        //   1. Multi-LOD jumps (URL hash sets zoom=16 from initial
        //      camera at zoom=1) would force the gate to wait for
        //      z=16 cached, but we only fetch what's at currentZ
        //      → cz=1 forever, fetching z=1 only. Stepping makes
        //      cz climb through LODs as each becomes ready.
        //   2. Single-step keeps the user's view transitioning
        //      smoothly (cz=13 → 14 → 15 → 16) instead of stalling
        //      at the old LOD until the final target is fully
        //      cached.
        const step = target > cz ? cz + 1 : cz - 1
        // Timer tracks the whole transition (target stays fixed
        // until camera.zoom rounds to a different integer). step
        // changes every time we advance one LOD, so resetting the
        // timer on step change would let us never time out — the
        // 4 sourceLayer renders per frame can each see slightly
        // different cz, churning step → since constantly reset. We
        // bind to `target` so the 5 s safety net actually applies
        // across the full transition.
        if (!this._czPendingAdvance || this._czPendingAdvance.target !== target) {
          this._czPendingAdvance = { target, since: now }
        }
        // Readiness check at the STEP LOD (cz±1), not target.
        // Below-minzoom step → instantly ready (no data exists to
        // wait on).
        const belowLayerMinzoom = !!(layerRange && step < layerRange.minzoom)
        const aboveLayerMaxzoom = !!(layerRange && step > layerRange.maxzoom)
        let total = 0, ready = 0
        let stepTiles: ReturnType<typeof visibleTilesFrustum> = []
        if (!belowLayerMinzoom && !aboveLayerMaxzoom) {
          stepTiles = (camera.pitch ?? 0) < 30
            ? visibleTilesFrustumSampled(
                camera, selectorProj, step,
                canvasWidth, canvasHeight, offsetMarginPx,
              )
            : visibleTilesFrustum(
                camera, selectorProj, step,
                canvasWidth, canvasHeight, offsetMarginPx,
              )
          for (const t of stepTiles) {
            if (t.z !== step) continue
            total++
            // Catalog-level cache check (no sourceLayer arg) — any
            // layer slice cached counts as "tile fetched". Per-layer
            // check would stall forever on tiles where this layer
            // has no features (e.g. buildings slice absent in a
            // water-only z=14 cell), since the backend never emits
            // acceptResult for empty-feature layers.
            if (this.source!.hasTileData(tileKey(t.z, t.x, t.y))) ready++
          }
        }
        const stepReady = belowLayerMinzoom || aboveLayerMaxzoom
          || total === 0 || ready === total
        const timedOut = now - this._czPendingAdvance.since > READINESS_TIMEOUT_MS

        if (stepReady || timedOut) {
          cz = step
          // Don't null out — next frame may want to step again
          // toward the still-distant target. The step-change branch
          // above will reset the timer for the new step.
          if (cz === target) this._czPendingAdvance = null
        } else {
          // Hold at the current cz, but kick off prefetch for the
          // step LOD so it can ready up. Tier 2 prefetch further
          // down does the same for cz+1 in zoom-in, but it's gated
          // on `camera.zoom > currentZ + 0.5` which is always
          // true here, so the two paths overlap harmlessly. We
          // still issue here directly because Tier 2 only fires
          // every 6 frames, while we want the prefetch to start
          // on the very first held frame.
          const stepKeys: number[] = []
          for (const t of stepTiles) {
            if (t.z !== step) continue
            stepKeys.push(tileKey(t.z, t.x, t.y))
          }
          if (stepKeys.length > 0) this.source.prefetchTiles(stepKeys)
        }
      } else {
        this._czPendingAdvance = null
      }
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
    // (Culling margin + selectorProj hoisted above the hysteresis
    // block so the readiness gate can call visibleTilesFrustum at
    // the target LOD without duplicating the derivation. See those
    // definitions for the rationale on margin sizing + projection
    // shim.)
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
      // Phase 2 dispatch: Mapbox / MapLibre screen-space-sample-grid
      // for low-pitch (single zoom, cap-free, aspect-ratio-invariant);
      // Cesium-style quadtree DFS for high-pitch where mixed-LOD is
      // required for the horizon. 30° is the industry split.
      const _pitchDeg = camera.pitch ?? 0
      tiles = _pitchDeg < 30
        ? visibleTilesFrustumSampled(
            camera,
            selectorProj,
            currentZ,
            canvasWidth,
            canvasHeight,
            offsetMarginPx,
          )
        : visibleTilesFrustum(
            camera,
            selectorProj,
            currentZ,
            canvasWidth,
            canvasHeight,
            offsetMarginPx,
          )

      // Phase 2 selector-shape invariant. The Mapbox/MapLibre sampled
      // selector emits single-zoom results — every tile.z must equal
      // currentZ. The Cesium DFS selector emits mixed-LOD. Catches
      // future dispatch regressions that route flat-pitch through the
      // DFS path (which would re-introduce the cap-fill mid-z giant
      // class of bugs that Phase 2 fixed).
      if ((globalThis as { __XGIS_INVARIANTS?: boolean }).__XGIS_INVARIANTS && _pitchDeg < 30) {
        for (const t of tiles) {
          if (t.z !== currentZ) {
            throw new Error(
              `[XGIS INVARIANT] flat-pitch (${_pitchDeg.toFixed(1)}°) selector emitted `
              + `tile z=${t.z} expected currentZ=${currentZ}. The dispatch should be `
              + `routing to visibleTilesFrustumSampled which is single-zoom by design.`,
            )
          }
        }
      }
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
    // 3D extrusion MVP: hard-code building height for the protomaps
    // `buildings` MVT slice. Future: read from show.extrude property
    // (style-parser change) and / or per-feature via PropertyTable.
    this.currentExtrudeHeight = show.sourceLayer === 'buildings' ? 50 : 0
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
    const sliceCachedMemo = this._scratchSliceCachedMemo
    sliceCachedMemo.clear()
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
    const parentKeysSet = this._scratchParentKeysSet
    parentKeysSet.clear()
    // Tracks whether ANY visible tile went through the in-archive
    // (normal) path. When false, the prefetch loop + primary
    // renderTileKeys are pure no-ops (every neededKey is over-zoom
    // so gpuCache.get returns null for all of them) and we can
    // skip them entirely.
    let anyInArchive = false

    // Per-tile decision tracker. Each visible tile resolves to one of:
    //   'primary'         — layerCache hit, will draw
    //   'parent-fallback' — cached ancestor pushed to fallbackKeys
    //   'child-fallback'  — cached child (deck.gl best-available) pushed
    //   'overzoom-parent' — over-zoom fast path pushed parent at maxLevel
    //   'queued-no-fb'    — uploadTile queued, NO fallback (= BUG)
    //   'drop-empty-slice'— sliced source layer has no features here
    //   'drop-no-archive' — tile not in archive index, no ancestor either
    //   'pending'         — fetch issued, no fallback found (cold area)
    //
    // Always populated (lightweight: array of constant-string refs).
    // The invariant-throw at end of loop is gated on
    // `globalThis.__XGIS_INVARIANTS`; the per-decision count summary
    // (exposed via `getLastDecisionCounts()`) is always available.
    const _tileDecisions: (string | undefined)[] = new Array(tiles.length)
    const _inv = (globalThis as { __XGIS_INVARIANTS?: boolean }).__XGIS_INVARIANTS

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
      // Per-tile resolution via the pure `classifyTile` classifier
      // (engine/tile-decision.ts). The classifier returns ONE explicit
      // TileDecision; the side-effect application below pushes
      // fallbackKeys, requests uploads, and bumps counters per the
      // decision kind. Replaces the previous inline ~150-line cascade
      // of `if … continue` branches that two regressions
      // (commit-49d4801, commit-71dd401) lived inside.
      const decision: TileDecision = classifyTile({
        visible: tiles[i],
        visibleKey: key,
        maxLevel,
        parentAtMaxLevel: parentAtMaxLevel[i],
        archiveAncestor: archiveAncestor[i],
        layerCache,
        hasSliceInCatalog: sliceCached,
        hasAnySliceInCatalog: (k) => this.source!.hasTileData(k),
        hasEntryInIndex: (k) => this.source!.hasEntryInIndex(k),
        sliceLayer,
      })
      _tileDecisions[i] = decision.kind === 'queued-with-fallback' ? decision.fallback.kind : decision.kind

      if (decision.kind === 'overzoom-parent') {
        fallbackKeys.push(decision.parentKey)
        fallbackOffsets.push(worldOffDeg[i])
        if (decision.parentNeedsFetch) {
          parentKeysSet.add(decision.parentKey)
        } else if (decision.parentNeedsUpload) {
          const data = this.source.getTileData(decision.parentKey, sliceLayer)
          if (data) this.doUploadTile(decision.parentKey, data, sliceLayer)
        }
        continue
      }

      anyInArchive = true
      if (decision.kind === 'primary') continue
      if (decision.kind === 'drop-empty-slice') continue
      if (decision.kind === 'drop-no-archive') {
        const t = tiles[i]
        const wKey = `no-ancestor:${t.z}/${t.x}/${t.y}`
        if (!this.tileDropWarnings.has(wKey)) {
          this.tileDropWarnings.add(wKey)
          console.warn(`[VTR tile-drop] no ancestor found for ${t.z}/${t.x}/${t.y} — dropping from render (maxLevel=${maxLevel}).`)
        }
        continue
      }

      // queued-with-fallback wraps an inner fallback decision. The
      // outer kind triggers a uploadTile (queued behind the per-
      // frame budget); the inner is the visual fill until the
      // upload lands. Unwrap and process the inner uniformly.
      let inner: TileDecision = decision
      if (decision.kind === 'queued-with-fallback') {
        this.uploadTile(key, this.source.getTileData(key, sliceLayer)!, sliceLayer)
        inner = decision.fallback
      }

      if (inner.kind === 'parent-fallback') {
        if (inner.parentNeedsUpload) {
          // Ancestor upload BYPASSES the per-frame budget. Fallback
          // parents are the visual safety net for every visible
          // tile currently uncached on GPU. Without the immediate
          // upload, renderTileKeys finds no gpuCache entry and the
          // tile draws as a black hole. (See _high-pitch-flicker
          // regression case.)
          this.doUploadTile(inner.parentKey, this.source.getTileData(inner.parentKey, sliceLayer)!, sliceLayer)
        }
        fallbackKeys.push(inner.parentKey)
        fallbackOffsets.push(worldOffDeg[i])
      } else if (inner.kind === 'child-fallback') {
        for (const ck of inner.childrenNeedingUpload) {
          const childData = this.source.getTileData(ck, sliceLayer)
          if (childData) this.doUploadTile(ck, childData, sliceLayer)
        }
        for (const ck of inner.childKeys) {
          fallbackKeys.push(ck)
          fallbackOffsets.push(worldOffDeg[i])
        }
      } else if (inner.kind === 'pending') {
        if (inner.requestKey !== null) toLoad.push(inner.requestKey)
        this._missedTiles++
      }
    }

    // ── Production invariant — visibility/fallback consistency check ──
    // Fires if any visible tile reached the end of the per-tile loop
    // with `queued-no-fb` (the commit-49d4801 white-flash bug class)
    // or with no decision at all (un-tracked code path). Pending +
    // intentional drops are allowed; primary / fallback resolutions
    // are allowed. The bug pattern is: catalog has data, primary
    // can't draw (queued upload), AND no per-tile fallback was
    // pushed. Unlike the global fallbackKeys check, this is per-tile
    // so a fallback pushed by a NEIGHBOURING tile (sharing the same
    // ancestor) does NOT mask the bug here.
    if (_inv) {
      for (let i = 0; i < tiles.length; i++) {
        const d = _tileDecisions[i]
        if (d === 'queued-no-fb' || d === undefined) {
          const t = tiles[i]
          throw new Error(
            `[XGIS INVARIANT] tile ${t.z}/${t.x}/${t.y} layer="${sliceLayer}" `
            + `decision=${d ?? 'untracked'}. The per-tile loop resolved this tile `
            + `without a primary draw or a per-tile fallback push. This is the bug `
            + `class fixed by commit 49d4801 (uploadTile queue + continue skipping `
            + `the parent-walk fallback).`,
          )
        }
      }
    }

    // Always-on per-decision summary for inspector / console diagnosis.
    // Reset to start fresh each render() call so consumers see THIS
    // layer's distribution. Tilly with `getLastDecisionCounts()`.
    this._lastDecisionCounts.clear()
    for (let i = 0; i < tiles.length; i++) {
      const d = _tileDecisions[i] ?? 'untracked'
      this._lastDecisionCounts.set(d, (this._lastDecisionCounts.get(d) ?? 0) + 1)
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
        // Keep already-loading ancestors in parentKeysSet so they
        // stay in `activeKeys` for cancelStale's protection check.
        // Excluding them here meant a parent in flight got dropped
        // from the next frame's active set → cancelStale aborted
        // it → cold-start at high zoom (z=14) never resolved
        // (regression repro: _pmtiles-zoom14-blank.spec.ts). The
        // catalog's requestTiles dedupes loadingTiles internally,
        // so re-adding here costs only a Set membership check.
        if (pk >= 0 && !sliceCached(pk)) {
          parentKeysSet.add(pk)
        }
      }
    }
    // Load parents first, then current zoom tiles
    const parentKeys = [...parentKeysSet]

    // Cancel in-flight fetches the camera has moved past. Active set =
    // anything we still need this frame: current visible (neededKeys)
    // + their parent fallbacks (parentKeys) + the parents that fast
    // path & in-archive walk pushed into fallbackKeys. Without this,
    // every frame leaves a trail of zombie fetches behind — the
    // user pans / zooms past a tile while its bytes are still on the
    // wire, and by the time the bytes arrive the catalog has moved
    // on, but bandwidth + worker capacity already paid for the
    // round-trip. cancelStale clips that trail by aborting the
    // network transfers and dropping decode-queued bytes for keys
    // the catalog no longer wants. Backends without cancellation
    // (XGVT-binary, GeoJSON-runtime) are no-ops.
    if (this.source.cancelStale) {
      const activeKeys = this._scratchActiveKeys
      activeKeys.clear()
      for (const k of neededKeys) activeKeys.add(k)
      for (const k of parentKeys) activeKeys.add(k)
      for (const k of fallbackKeys) activeKeys.add(k)
      this.source.cancelStale(activeKeys)
    }

    // Visible-tile fetches: ALWAYS issued, like parentKeys. The
    // earlier `cameraIdle` gate here was a heat mitigation that
    // turned out to be too aggressive — at flat pitch on a settled
    // camera, the gate was leaving 11 of 12 visible z=currentZ
    // tiles uncached, so the canvas filled but with a parent-walk
    // (z=currentZ-1) fallback stripe (regression repro:
    // _mobile-detail-uniformity.spec.ts).
    //
    // The cancelStale mechanism above already abort-frees in-flight
    // fetches whose keys leave the active set during a gesture, so
    // the per-frame fetch traffic is self-trimmed without an extra
    // gate. Heat protection now relies entirely on the concurrency
    // caps (MAX_INFLIGHT, MAX_CONCURRENT_LOADS) + the prefetch /
    // step-prefetch idle gates, not on suppressing visible-fetch
    // start.
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
      // Visual debug hook: when `globalThis.__XGIS_FALLBACK_RED = true` is
      // set, override the fallback fill colour to bright red. Lets the
      // user visually confirm whether parent/child fallback is actually
      // rendering during a "white flash" — if red is visible, the bug
      // is downstream of fallback rendering (e.g., later layer covering
      // it, alpha = 0, render order); if no red appears, the fallback
      // path itself is dropping the tile.
      const _debugRed = (globalThis as { __XGIS_FALLBACK_RED?: boolean }).__XGIS_FALLBACK_RED
      let _origR = 0, _origG = 0, _origB = 0
      if (_debugRed) {
        _origR = this.uniformF32[16]
        _origG = this.uniformF32[17]
        _origB = this.uniformF32[18]
        this.uniformF32[16] = 1.0
        this.uniformF32[17] = 0.0
        this.uniformF32[18] = 0.0
      }
      this.renderTileKeys(fallbackKeys, pass, fillPipelineFallback, linePipelineFallback!, projCenterLon, projCenterLat, fallbackOffsets, lineLayerOffset, phase, layerCache)
      if (_debugRed) {
        this.uniformF32[16] = _origR
        this.uniformF32[17] = _origG
        this.uniformF32[18] = _origB
      }
    }


    // Prefetch adjacent + next zoom (every 10th frame, idle only).
    // While the camera is actively moving the prefetched edge tiles
    // are likely to be invalidated within ~100 ms of being fetched
    // — wasted bandwidth + GPU upload pressure on mobile.
    if (cameraIdle && this.frameCount % 10 === 0) {
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
    if (cameraIdle && this.frameCount % 6 === 0) {
      let prefetchZ = -1
      if (camera.zoom > currentZ + 0.5 && currentZ + 1 <= maxSubTileZ) {
        prefetchZ = currentZ + 1
      } else if (camera.zoom < currentZ && currentZ - 1 >= 0) {
        prefetchZ = currentZ - 1
      }
      if (prefetchZ >= 0) {
        const prefetchTiles = (camera.pitch ?? 0) < 30
          ? visibleTilesFrustumSampled(
              camera, selectorProj, prefetchZ,
              canvasWidth, canvasHeight, offsetMarginPx,
            )
          : visibleTilesFrustum(
              camera, selectorProj, prefetchZ,
              canvasWidth, canvasHeight, offsetMarginPx,
            )
        const prefetchKeys: number[] = []
        for (const t of prefetchTiles) {
          const k = tileKey(t.z, t.x, t.y)
          // Skip already-loaded keys; KEEP already-loading ones in the
          // intent set so catalog's _prefetchKeys protection covers
          // them across cancelStale calls. catalog.requestTiles
          // dedupes loadingTiles internally, so passing duplicates is
          // free. Without the in-flight keys here, the second
          // prefetch round (6 frames later) would yield an empty
          // array → catalog's age-out clears the shield → next frame
          // aborts the still-in-flight prefetch.
          if (!sliceCached(k)) {
            prefetchKeys.push(k)
          }
        }
        if (prefetchKeys.length > 0) {
          this.source.prefetchTiles(prefetchKeys)
        }
      }
    }

    // Track stable tile set for eviction protection and point rendering.
    // IMPORTANT: include fallbackKeys too — those tiles' buffers are bound
    // in bind groups used by the draw calls we just recorded. Evicting them
    // now would destroy their buffers before `queue.submit()` runs, causing
    // "Buffer used in submit while destroyed" validation errors.
    if (fallbackKeys.length > 0) {
      const merged = this._scratchMergedStableKeys
      merged.clear()
      for (const k of neededKeys) merged.add(k)
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
      // tile_extent_m (38) — tile-local Mercator-meter extent at this
      // tile's zoom. vs_main_quantized dequants pos_norm via this.
      // 2π × R / 2^z; we cache R × 2π once per VTR.
      this.uniformF32[38] = TWO_PI_R_EARTH / Math.pow(2, cached.tileZoom)
      // extrude_height_m (39) — 3D building extrusion height in
      // metres. Set in render() from show.sourceLayer (MVP: hard-
      // coded for `buildings`, 0 elsewhere). Per-feature heights
      // via PropertyTable + style `extrude:` syntax are a follow-up.
      this.uniformF32[39] = this.currentExtrudeHeight

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
      const tz = cached.tileZoom
      if (typeof tz === 'number') {
        this._frameDrawnByZoom.set(tz, (this._frameDrawnByZoom.get(tz) ?? 0) + 1)
      }
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
    if (byTileKey.size <= getMaxGpuTiles()) return

    // Eviction policy: only this frame's stableKeys are protected.
    //
    // The previous policy ALSO blanket-protected every tileZoom ≤
    // sourceMaxLevel (i.e. every archived ancestor). On a PMTiles
    // archive with maxLevel = 15, that meant essentially every cached
    // tile was protected — the cap stopped doing anything. Real-device
    // iPhone inspector showed gpuCache 317 entries past the 256 cap
    // because of this. Same fix as the catalog evictTiles change
    // earlier in this series: visible-frame protection (stableKeys =
    // neededKeys ∪ fallbackKeys) covers every ancestor sub-tile gen
    // actually needs THIS frame; ancestors for non-visible regions
    // are recoverable by re-fetch + GPU re-upload when the camera
    // returns to them — at the cost of a brief load shimmer, which
    // is far preferable to thermal throttle.
    const protectedKeys = this._scratchProtectedKeys
    protectedKeys.clear()
    for (const k of this.stableKeys) protectedKeys.add(k)

    const evictable: { tk: number; lastUsed: number; slots: string[] }[] = []
    for (const [tk, bucket] of byTileKey) {
      if (protectedKeys.has(tk)) continue
      evictable.push({ tk, lastUsed: bucket.lastUsed, slots: bucket.slots })
    }
    evictable.sort((a, b) => a.lastUsed - b.lastUsed)

    const toEvict = byTileKey.size - getMaxGpuTiles()
    for (let i = 0; i < toEvict && i < evictable.length; i++) {
      const ev = evictable[i]
      for (const slot of ev.slots) {
        const inner = this.gpuCache.get(slot)
        if (!inner) continue
        const tile = inner.get(ev.tk)
        if (!tile) continue
        // Pool the buffers instead of destroying — evictGPUTiles
        // is the hot path during fast pinch/pan, where the next
        // upload almost certainly needs same-size buffers. Pool
        // caps prevent unbounded GPU memory retention.
        this.releaseBuffer(tile.vertexBuffer)
        this.releaseBuffer(tile.indexBuffer)
        this.releaseBuffer(tile.lineVertexBuffer)
        this.releaseBuffer(tile.lineIndexBuffer)
        this.releaseBuffer(tile.outlineIndexBuffer)
        // SDF segment buffers are owned by lineRenderer's path;
        // keep destroying directly.
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
