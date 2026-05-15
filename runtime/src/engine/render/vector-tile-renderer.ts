// ═══ Vector Tile Renderer (GPU Layer) ═══
// Renders vector tiles from a TileCatalog to WebGPU.
// Data loading/caching/sub-tiling is handled by TileCatalog.
// This class manages GPU buffers, bind groups, and draw calls only.

import type { GPUContext } from '../gpu/gpu'
import { DEBUG_OVERDRAW } from '../debug-flags'
import { Camera } from '../projection/camera'
import type { ShowCommand } from './renderer'
import { interpolateZoom } from './renderer'
import type { ResolvedShow } from './resolved-show'
import { visibleTilesFrustum, visibleTilesFrustumSampled, sortByPriority } from '../../data/tile-select'
import { visibleTilesSSE } from '../../loader/tiles-sse'
import {
  classifyTile, computeProtectedKeys,
  type TileDecision,
} from '../tile-decision'
import { PrefetchScheduler } from './prefetch-scheduler'
import {
  generateWallMesh,
  generateWallMeshExtruded,
  quantizePolygonVertices,
  quantizePolygonVerticesExtruded,
} from '../../core/polygon-mesh'
import { tileKey, tileKeyParent, tileKeyChildren, tileKeyUnpack, type PropertyTable } from '@xgis/compiler'
import { StagingBufferPool, asyncWriteBuffer } from '../gpu/staging-buffer-pool'
import { WORLD_MERC, TILE_PX } from '../gpu/gpu-shared'
import { PriorityQueue } from '../../core/priority-queue'
import type { ShaderVariant } from '@xgis/compiler'
import type { TileCatalog } from '../../data/tile-catalog'
import type { TileData } from '../../data/tile-types'
import { computeSliceKey } from '../../data/eval/filter-eval'
import { mercator as mercatorProj, type Projection } from '../projection/projection'
import type { PointRenderer } from './point-renderer'
import { buildLineSegments, type LineRenderer } from './line-renderer'
import { parseHexColor } from '../feature-helpers'
import { ComputeDispatcher } from '../gpu/compute'
import { ComputeLayerHandle } from './compute-layer-handle'

// ═══ Types ═══

/** Layer draw phase — replaces the prior `translucentLines: boolean` flag.
 *  'all' draws fill + stroke in one pass (opaque default).
 *  'fills'/'strokes' split across a main pass and an offscreen MAX-blend
 *  pass so translucent strokes don't accumulate alpha across overlapping
 *  geometry. 'fills' + 'strokes' together == 'all'. */
export type LayerDrawPhase = 'all' | 'fills' | 'strokes' | 'oit-fill'

interface GPUTile {
  vertexBuffer: GPUBuffer
  indexBuffer: GPUBuffer
  indexCount: number
  /** Per-vertex z (world metres) for extruded polygons. When non-null,
   *  the fill path binds the `*Extruded` pipeline and feeds this as
   *  vertex buffer slot 1; vertex bit 15 of x is unused on this code
   *  path (z carries the bottom-vs-top distinction directly). Null on
   *  flat polygon tiles. */
  zBuffer: GPUBuffer | null
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
  /** Per-tile feat_data buffer for MVT/PMTiles data-driven paint
   *  expressions (e.g. OFM Bright landuse `class` match). Each tile's
   *  featId space is local; the polygon vertex stride-8 `f32 fid`
   *  indexes into this buffer's `featureCount × fieldCount` floats.
   *  Built from `data.featureProps` when the renderer has captured a
   *  variant requiring feature data (`latestVariantFields.length > 0`).
   *  Null for tiles without per-feature data (GeoJSON path, or MVT
   *  slices whose consumer shows don't author data-driven paint). */
  featureDataBuffer: GPUBuffer | null
  /** Bind group pairing this tile's `featureDataBuffer` with the shared
   *  `uniformRing`. Used in place of the source-level `tileBgFeature`
   *  when present. Null when `featureDataBuffer` is null. */
  featureBindGroup: GPUBindGroup | null
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
function uploadBudgetFor(canvasW: number, canvasH: number, dpr: number = 1): number {
  // Test hook: spec sets `globalThis.__XGIS_UPLOAD_BUDGET` to force
  // queue-deferred uploads on every render call so the parent-walk
  // fallback path is exercised deterministically. Production paths
  // never set this, so the constant lookup is a single property read.
  const o = (globalThis as { __XGIS_UPLOAD_BUDGET?: number }).__XGIS_UPLOAD_BUDGET
  if (typeof o === 'number') return o
  // Mobile classification is a perceptual concept — must use CSS
  // pixels. A DPR=3 phone's device-pixel canvas is 1290×2235, which
  // would (incorrectly) flip the `max > 900` test to "desktop" and
  // bump the budget from 1 to 4 uploads/frame — exactly the spike
  // the function exists to prevent.
  return Math.max(canvasW, canvasH) / dpr <= 900 ? 1 : MAX_UPLOADS_PER_FRAME
}

// ═══ Renderer ═══

const UNIFORM_SLOT = 256
// Bind-group binding range size. Must be ≥ the WGSL Uniforms struct
// size of every shader that reads this binding (polygon, line, point,
// raster — see renderer.ts / line-renderer.ts / point-renderer.ts).
// Polygon Uniforms is 192 bytes (48 floats: 36 base + 4 clip_bounds +
// 4 zoom-block + 4 pad), so the binding must be at least 192.
// UNIFORM_SLOT (256 bytes/slot) keeps headroom for future struct
// growth without re-tuning. WGSL spec requires multiple of 16.
// Grew 176 → 192 when `zoom: f32` joined for P3 palette gradient
// sampling — the variant shader reads `u.zoom` to map zoom into the
// gradient atlas's U coord (see emitColorGradientSample).
const UNIFORM_SIZE = 192

/** 2π × Earth radius (m). One full mercator wrap. tile_extent_m at
 *  any zoom z is this constant divided by 2^z (vs_main_quantized
 *  dequant scale). */
const TWO_PI_R_EARTH = 2 * Math.PI * 6378137

/** Cesium replacement-invariant ancestor protection depth. Caps the
 *  number of pyramid levels above each visible tile that are held
 *  pinned in the catalog cache. 22 matches `firstIndexedAncestor`'s
 *  MAX_WALK (DSFUN zoom ceiling) so the entire chain from leaf to
 *  root is protected — "parents are never evicted before their
 *  children arrive" (Cesium replace-refinement rule #2). Sibling
 *  visibles share the bulk of their chain, so the unique-key count
 *  scales as O(visible + log2(visible) × depth), not visible × depth;
 *  measured ~30-50 unique ancestors at z=14 over a typical viewport,
 *  well inside the 100/200 MB catalog cap. The previous value (4)
 *  left mid-zoom ancestors (z=3..z=N-5) unprotected and they were
 *  evicted during fast zoom-in even though they were the last
 *  available fallback before the pinned skeleton at z=0..2/3. */
const ANCESTOR_PROTECT_DEPTH = 22

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
  currentProjection: import('../projection/projection').Projection | null = null
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
  /** Speculative prefetch routes (sibling-of-visible + pan-direction
   *  speculation). Owns the frame-stable camera snapshot that the
   *  velocity-vector projection depends on; updated exactly once per
   *  frame inside `pumpPrefetch`. */
  private readonly prefetchScheduler = new PrefetchScheduler()
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
  // Sized to UNIFORM_SIZE (= WGSL Uniforms struct size). Grew from
  // 160 → 176 when `clip_bounds: vec4<f32>` was added at offset 160.
  // Out-of-bounds typed-array writes are silent no-ops in JS, so a
  // mismatch here = uniform never reaches the GPU = shader reads
  // garbage at the new offset. Keep this in lockstep with WGSL.
  private uniformDataBuf = new ArrayBuffer(UNIFORM_SIZE)
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
  /** Extrude routing for the current `render()` call.
   *   - 'none': flat polygon, no z lift
   *   - 'uniform': all features at currentExtrudeHeight (flat pipeline,
   *     is_top * u.extrude_height_m in WGSL)
   *   - 'per-feature': per-vertex z from the slice's heights map
   *     (extruded pipeline, vertex buffer slot 1)
   *  Set in render() from the layer's `extrude:` style; consumed by
   *  renderTileKeys when picking the fill pipeline. */
  private currentExtrudeMode: 'none' | 'uniform' | 'per-feature' = 'none'
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

  // Global feature data buffer (GeoJSON path: one PropertyTable per
  // source covers all sub-tiles since featIds are global). MVT/PMTiles
  // path keeps this null and builds per-tile featureDataBuffer / bind
  // group on tile upload instead — each PMTiles tile carries its own
  // 0-based featId space, so a shared source-level table can't index.
  private featureDataBuffer: GPUBuffer | null = null
  private featureBindGroupLayout: GPUBindGroupLayout | null = null

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
  private latestVariant: import('@xgis/compiler').ShaderVariant | null = null
  private latestComputePlan: readonly import('@xgis/compiler').ComputePlanEntry[] | undefined
  private latestRenderNodeIndex: number | undefined
  /** Per-tile compute handles for THIS VTR's variant. Keyed by the
   *  `tileKey:sourceLayer` string the tile uploader already uses for
   *  the layer cache, so handle lifetime tracks the tile's bind
   *  group lifetime. Cleared from `destroy()` + on tile eviction. */
  private computeHandlesByTile = new Map<string, import('./compute-layer-handle').ComputeLayerHandle>()
  /** Singleton ComputeDispatcher shared by every per-tile handle.
   *  Lazy-created on first compute-variant attach so non-compute
   *  scenes don't pay any allocation. */
  private computeDispatcher: import('../gpu/compute').ComputeDispatcher | null = null

  // Per-frame draw stats
  private renderedDraws = new Map<number | string, { polyCount: number; lineCount: number; vertexCount: number }>()
  // DIAG: filled in by render() at the start of each show, read by
  // renderTileKeys when pushing per-tile drawIndexed entries into the
  // trace. Both fields are flag-gated and zero-cost when the trace
  // isn't armed.
  private lastTraceSlice: string | null = null
  private lastTracePhase: string | null = null
  /** Deduped tile-drop warnings. Key format: "<reason>:<z>/<x>/<y>". Once
   *  per session per key; prevents flood when panning/zooming over an area
   *  that has no data at the current level. */
  private tileDropWarnings = new Set<string>()
  private _missedTiles = 0 // tiles with no fallback this frame

  /** Pipeline pair for tiles with per-feature extrude heights (i.e.
   *  `cached.zBuffer != null`). The orchestrator (renderer.ts) sets
   *  these once at init via `setExtrudedPipelines`; VTR swaps them in
   *  for the fill draw when the cached tile carries a z buffer. Null
   *  before `setExtrudedPipelines` runs — flat-only render still works
   *  because the branch checks `cached.zBuffer` first. */
  private fillPipelineExtruded: GPURenderPipeline | null = null
  private fillPipelineExtrudedFallback: GPURenderPipeline | null = null
  /** Ground-layer fill pipelines — depth test/write disabled.
   *  Selected when `currentExtrudeMode === 'none'` so coplanar
   *  ground polygons (water, landuse, roads-as-fill, etc.) resolve
   *  via painter's order instead of the layer_depth_offset NDC
   *  bias hack. Null until setGroundPipelines runs. */
  private fillPipelineGround: GPURenderPipeline | null = null
  private fillPipelineGroundFallback: GPURenderPipeline | null = null
  /** OIT translucent extrude pipeline — Weighted-Blended OIT MRT
   *  output. Selected when render() runs with phase='oit-fill'
   *  (translucent extrude bucket). Null until setOITPipeline runs. */
  private fillPipelineExtrudedOIT: GPURenderPipeline | null = null

  constructor(ctx: GPUContext) {
    this.device = ctx.device
    this.stagingPool = new StagingBufferPool(ctx.device)
  }

  /** Tiered MAP_WRITE | COPY_SRC pool used by the async upload path
   *  (`doUploadTileAsync`). The sync `doUploadTile` keeps using
   *  `device.queue.writeBuffer` for mid-render fallback uploads where
   *  data must be on GPU before the next render command — those can't
   *  await without splitting the render pass. The pool is shared across
   *  the lifetime of the VTR; tier sizes match common tile shapes. */
  private stagingPool: StagingBufferPool

  /** Provide the per-feature extrusion fill pipelines. Called once
   *  per frame from map.ts immediately before render() so VTR can
   *  pick between flat and extruded fill paths on a per-tile basis
   *  without threading another parameter through `render()`. */
  setExtrudedPipelines(main: GPURenderPipeline, fallback: GPURenderPipeline): void {
    this.fillPipelineExtruded = main
    this.fillPipelineExtrudedFallback = fallback
  }

  /** Provide the depth-disabled ground-layer fill pipelines. Same
   *  shader as the regular fill, but the depth state is OFF so
   *  painter's order between ground polygons is decided by GPU
   *  command order — the way painter's order is supposed to work,
   *  without log-depth precision noise + layer_depth_offset
   *  arithmetic fighting at coplanar fragments. */
  setGroundPipelines(main: GPURenderPipeline, fallback: GPURenderPipeline): void {
    this.fillPipelineGround = main
    this.fillPipelineGroundFallback = fallback
  }

  /** Provide the OIT translucent extrude pipeline. Used when
   *  render() runs with phase='oit-fill': translucent buildings
   *  draw their fills into the accum + revealage MRT pair so a
   *  later compose pass can blend them order-independently onto
   *  the opaque framebuffer. */
  setOITPipeline(p: GPURenderPipeline): void {
    this.fillPipelineExtrudedOIT = p
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

  /** Hand the scene's compute plan to the VTR so per-tile feature
   *  uploads can attach a `ComputeLayerHandle`. The renderNodeIndex
   *  is intentionally NOT captured here — it's captured atomically
   *  with the variant inside `buildFeatureDataBuffer` so the two
   *  can't drift across shows that share a VTR (the previous design
   *  let a non-compute show's setComputeContext mutate
   *  latestRenderNodeIndex while latestVariant still pointed at a
   *  prior compute show — variant.computeBindings.length=1 + plan
   *  filter at non-matching idx = 0 → ComputeLayerHandle throw). */
  setComputePlan(
    plan: readonly import('@xgis/compiler').ComputePlanEntry[] | undefined,
  ): void {
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

  /** P3 Step 3c — set palette atlas resources used by binding 2 + 4
   *  on the polygon bind-group layout. Caller (MapRenderer) hands
   *  the 1×1 stub by default; once `uploadPalette` lands the real
   *  atlas, the same call rebuilds the tile bind groups in place. */
  setPaletteResources(colorAtlasView: GPUTextureView, sampler: GPUSampler): void {
    this.paletteColorAtlasView = colorAtlasView
    this.paletteSampler = sampler
    this.rebuildTileBindGroups()
  }
  private paletteColorAtlasView: GPUTextureView | null = null
  private paletteSampler: GPUSampler | null = null

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
    // Palette bindings 2/4 are part of mr-baseBindGroupLayout /
    // mr-featureBindGroupLayout. Defer bind-group construction until
    // both palette resources are wired so we don't ever build a
    // group missing those entries.
    if (!this.paletteColorAtlasView || !this.paletteSampler) return
    this.tileBgDefault = this.device.createBindGroup({
      label: 'vtr-tileBg-default',
      layout: this.baseBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformRing, offset: 0, size: UNIFORM_SIZE } },
        { binding: 2, resource: this.paletteColorAtlasView },
        { binding: 4, resource: this.paletteSampler },
      ],
    })
    if (this.featureBindGroupLayout && this.featureDataBuffer) {
      this.tileBgFeature = this.device.createBindGroup({
        label: 'vtr-tileBg-feature',
        layout: this.featureBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformRing, offset: 0, size: UNIFORM_SIZE } },
          { binding: 1, resource: { buffer: this.featureDataBuffer } },
          { binding: 2, resource: this.paletteColorAtlasView },
          { binding: 4, resource: this.paletteSampler },
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
    /** Tile keys flagged `fallbackOnly` by the selector — protected
     *  from eviction (folded into stableKeys) but never rendered
     *  as primaries. Empty when the selector emits no fallback-only
     *  inject (e.g. low-pitch / sampled selector). */
    protectedAncestors: number[]
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
    // Reset the frame-scoped miss counter here so multiple render()
    // calls within the frame accumulate into one total (see render()).
    this._missedTiles = 0
    this._frameTilesVisible = 0
    this._frameDrawCalls = 0
    this._frameTriangles = 0
    this._frameLines = 0
    this._frameVertices = 0
    this._frameDrawnByZoom.clear()
    this._frameClassifyMemo.clear()
    // Reset the per-frame upload counter + replay any uploads that
    // got held over by the previous frame's cap. Without this, a
    // 80+ slice scene (Bright) bursts hundreds of uploads into one
    // rAF callback and the JS thread spends ~300 ms per frame in
    // staging-buffer copies. See `_uploadsThisFrame` for context.
    this.resetUploadFrameCap()
    // Frame tile cache invalidates on each new frame via the
    // currentFrameId comparison in render(); explicit null isn't
    // strictly needed, but releasing the GC reference here lets the
    // previous frame's tile array drop sooner if the ShowCommand
    // list shrinks (e.g. layer toggle).
    this._frameTileCache = null
    // Retired rings are NO LONGER explicitly destroyed here. The
    // previous frame's `queue.submit()` was called before the rAF
    // callback that fired this `beginFrame`, so validation already
    // passed — but a separate code path (teardownSource → VTR.destroy
    // mid-frame, or a setBindGroup call that captured a ring just
    // before grow) can still race the destroy ahead of submit, which
    // surfaces as "Buffer vtr-uniform-ring used in submit while
    // destroyed" on OFM Bright load (user-reported 2026-05-14).
    //
    // Replaced with a plain array clear: drop our refs, let JS GC +
    // the WebGPU implementation's internal refcount free the underlying
    // GPU resource at the right time. Bounded memory cost — ring grows
    // double capacity, so the retired pool tops out at log2(maxCap)
    // buffers (a handful, ~MB-scale transient).
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

  /** Frame-scope anticipatory prefetch. Called by `map.ts:renderFrame`
   *  exactly ONCE per wall-clock frame (right after the per-source
   *  `beginFrame` loop), NOT inside `render()` — the bucket scheduler
   *  invokes `render()` per ShowCommand, which on dense styles reaches
   *  ~80 calls per frame; re-firing prefetch in that loop would flood
   *  `_evictShield`, race visible-tile fetches for the catalog's
   *  concurrency budget, and corrupt the velocity vector that route 2
   *  depends on (whose frame-stable snapshot lives inside
   *  PrefetchScheduler).
   *
   *  Both routes (sibling prefetch + pan-direction speculation) live
   *  in `PrefetchScheduler`; this method is a thin delegate that wires
   *  in VTR's frame-tile cache as the visible-tile signal source. */
  pumpPrefetch(
    camera: Camera,
    projType: number,
    canvasWidth: number,
    canvasHeight: number,
    dpr: number,
  ): void {
    if (!this.source) return
    // We need a populated `_frameTileCache.neededKeys` to do anything
    // — the cache is filled by the first `render()` call each frame,
    // so on the very first frame after attach (before any render()
    // ran) we silently skip and pick up next frame.
    const cache = this._frameTileCache
    if (!cache) return
    this.prefetchScheduler.pump(
      this.source, cache, camera, projType, canvasWidth, canvasHeight, dpr,
    )
  }

  /** Async-upload priority queue. Replaces the previous in-place sort
   *  + per-frame writeBuffer-budget loop. `maxJobs` caps how many tile
   *  uploads can be in flight concurrently (each holding 5-7 staging
   *  buffers); the rest wait their turn. Items are string IDs
   *  (`${key}:${sourceLayer}`) so the queue's identity-based dedup
   *  catches duplicate enqueues across frames; the actual TileData
   *  lives in `uploadItemData`. The queue's priorityCallback is wired
   *  per-frame to the same distance closure that drives fetch — closer
   *  tiles dispatch first.
   *
   *  Async path replaces the writeBuffer-budget reasoning (which was
   *  about preventing JS-thread stalls): mapAsync doesn't block JS, so
   *  the only meaningful cap is staging-buffer concurrency. */
  private uploadQueue = new PriorityQueue<string, void>()
  private uploadItemData = new Map<string, { key: number; data: TileData; sourceLayer: string }>()

  /** Per-frame distSq memo + cached camera centre. distSq runs O(N log N)
   *  times per upload-queue sort and once per fetch-priority dispatch;
   *  the camera is constant for the whole frame, so cache the (key →
   *  distance²) lookup across every render() call in the same frame.
   *  Cleared in beginFrame. Without this hoist, the per-render allocation
   *  of a fresh Map + closure happened ~80 times per frame on Bright
   *  (one per ShowCommand) and the memo never actually shared across
   *  layers. */
  private _distMemo = new Map<number, number>()
  private _distMemoCamX = NaN
  private _distMemoCamY = NaN
  /** Stable closure that reads `_distMemo` + camera centre on the
   *  instance — installed ONCE on the upload queue + source, never
   *  re-allocated per render. */
  /** Sentinel — once we install the stable comparators on a queue,
   *  skip re-installing on every render(). Doesn't prevent a fresh
   *  source / queue swap (next render sees a different identity).
   *  Without this, `priorityCallback = …` runs 80× per frame for free
   *  but the `setFetchPriority` callback path also runs 80×. */
  private _installedPriorityFns: PriorityQueue<string, void> | null = null

  private _distSqStable = (key: number): number => {
    const cached = this._distMemo.get(key)
    if (cached !== undefined) return cached
    const [tz, tx, ty] = tileKeyUnpack(key)
    const n = (1 << tz) >>> 0
    const PI_R = Math.PI * 6378137
    const tileX = ((tx + 0.5) / n) * 2 * PI_R - PI_R
    const tileY = (1 - 2 * (ty + 0.5) / n) * PI_R
    const dx = tileX - this._distMemoCamX
    const dy = tileY - this._distMemoCamY
    const d2 = dx * dx + dy * dy
    // Cesium replace-refinement priority: shallow zooms ALWAYS win.
    // Without the level offset, distance-only priority deprioritizes
    // ancestor fetches (z=0 root tile centred at lon/lat 0,0 is far
    // from a Japan-centred camera, so it ranked LAST behind the 871
    // closer z=7 visible-tile requests on the user's repro). Adding
    // tz × LEVEL_OFFSET guarantees a z=N tile sorts before any z=N+1
    // regardless of camera distance; intra-level distance tiebreaks
    // still apply via d2. LEVEL_OFFSET is set well above max(d²) ≈
    // (2π·R)² ≈ 1.6e15 so the level term dominates without overflow.
    const LEVEL_OFFSET = 1e16
    const priority = tz * LEVEL_OFFSET + d2
    this._distMemo.set(key, priority)
    return priority
  }

  /** Per-frame dispatch counter. Phase C removed the count-based
   *  upload budget on the assumption that mapAsync would prevent
   *  JS-thread stalls. Bench (Bright at z=14 Tokyo, 2026-05-08):
   *  pre-Phase-C 7 ms median, post 80-300 ms — even with maxJobs=1
   *  the JS thread spends most of the frame in writeBuffer / staging
   *  copy, because every job's completion microtask immediately
   *  dispatches the next, and the queue drains hundreds of items in
   *  ONE rAF callback. The per-frame cap below restores the bound
   *  on `uploadTile` calls that actually start work this frame.
   *  Overflow is held in `_heldUploads` and replayed at beginFrame. */
  private _uploadsThisFrame = 0
  private _heldUploads: { key: number; data: TileData; sourceLayer: string }[] = []
  private _heldUploadIds = new Set<string>()
  /** Mirror of `_heldUploads`'s tile keys (sliceLayer-collapsed)
   *  used by `classifyTile`'s `hasOtherSliceHeld` predicate to keep
   *  every layer of a single tile on the same fallback level until
   *  the slowest slice catches up. Without this set, the upload cap
   *  staggers per-MVT-layer slice arrival across frames and the
   *  renderer ends up with `primary` z=N landcover next to
   *  `parent-fallback` z=N-1 transportation in the same screen
   *  region — visually jarring. The set is rebuilt at
   *  `resetUploadFrameCap` so any items the replay re-defers are
   *  re-tracked, while peers that successfully upload drop out. */
  private _heldUploadKeys = new Set<number>()
  /** Per-decision counts from the last render() call. Always tracked
   *  (cheap — Map of ~7 string keys). Exposed via
   *  `getLastDecisionCounts()` for inspector / console diagnosis.
   *  Reset on every render() entry. */
  private _lastDecisionCounts: Map<string, number> = new Map()

  /** The outer render-on-demand loop calls this to know whether it still
   *  needs to tick — if tiles are queued or actively uploading the
   *  scene hasn't actually converged yet, even though no user input
   *  is flowing. */
  hasPendingUploads(): boolean {
    return this.uploadQueue.running
  }

  /** Diagnostic: queue depth for inspectPipeline() snapshots. */
  getPendingUploadCount(): number {
    return this.uploadQueue.size() + this.uploadQueue.activeCount()
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
          tile.featureDataBuffer?.destroy()
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

  /** Iterate every visible point feature in this tile source's
   *  current frame's stableKeys. Calls `fn` with absolute Mercator
   *  meters + a feature-property bag for each point. Used by the
   *  TextStage label path so per-feature labels (`label-["{.name}"]`
   *  on a vector-tile layer) can resolve text + project anchors
   *  without re-implementing the tile cache iteration here.
   *
   *  No-op for sources without point geometry (polygon-only layers
   *  return zero-length pointVertices arrays). */
  forEachLabelFeature(
    sliceLayer: string | undefined,
    fn: (mercX: number, mercY: number, props: Record<string, unknown>) => void,
  ): void {
    if (!this.source) return
    const table = this.source.getPropertyTable()
    const fieldNames = table?.fieldNames ?? []
    const values = table?.values ?? []
    const DEG2RAD = Math.PI / 180
    const R = 6378137
    const LAT_LIMIT = 85.051129
    const clampLat = (v: number): number => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, v))

    // Walk BOTH neededKeys (camera-visible) AND stableKeys (broader
    // cache) for label features. We previously walked only neededKeys
    // to avoid label density mismatch when zoom-9 ancestors served as
    // fallback for missing zoom-14 tiles — but that exclusion HIDES
    // opposite-world tiles which only become cached after the camera
    // has panned past the antimeridian, while their features still
    // need label emissions on the current side via the caller's
    // projectLonLatCopies wrap. Visible repro (2026-05-13 OFM Bright
    // zoom=0.5/lon=175): tile 1/1/0 (east hemisphere, camera-near)
    // only carries antimeridian-wrap copies of Western-Hemisphere
    // features (Canada/UK/Portugal at mercX=±WORLD_MERC_HALF). With
    // neededKeys-only iteration the wrap copies were the ONLY anchors
    // emitted; the caller's name-dedup then permanently skipped the
    // real centroids living in tile 1/0/0 (camera-far). Drop wrap
    // copies in the emit step below AND broaden the tile set so the
    // real centroids are visited.
    //
    // DEDUP across world copies. Both `neededKeys` and stable copies
    // repeat the same canonical tileKey once per world copy. For
    // LABELS the caller in map.ts handles world-copy enumeration via
    // projectLonLatCopies, so iterating each tile's pointVertices N
    // times here only produces N× duplicate addLabel submissions at
    // the same canonical screen positions. With N=5 (full mercator
    // wrap) and the collision pass's "first place wins" greedy logic,
    // the duplicates create N² overdraw and can leak through the
    // dedup when bbox padding rounds inconsistently across iterations.
    // Visiting each tile ONCE here matches the per-feature iteration
    // count to the rendered label count.
    const rawLabelKeys: number[] = []
    if (this._frameTileCache?.neededKeys) rawLabelKeys.push(...this._frameTileCache.neededKeys)
    rawLabelKeys.push(...this.stableKeys)
    // ALWAYS dedupe — stableKeys (the fallback path when neededKeys is
    // empty during early-frame loading) can also contain the same
    // canonical tileKey N times across world copies, and without the
    // dedupe we emit N labels per feature → duplicate country names
    // stacked at the same screen position.
    const labelKeys = [...new Set(rawLabelKeys)]
    for (const key of labelKeys) {
      const tileData = this.source.getTileData(key, sliceLayer)
      if (!tileData?.pointVertices || tileData.pointVertices.length < 5) continue
      const ptv = tileData.pointVertices
      const tileMercX = tileData.tileWest * DEG2RAD * R
      const tileMercY = Math.log(Math.tan(Math.PI / 4 + clampLat(tileData.tileSouth) * DEG2RAD / 2)) * R
      // Prefer per-tile featureProps (PMTiles MVT path — each tile
      // carries its own properties Map). Fall back to the catalog-
      // level PropertyTable (XGVT path — pre-built shared table
      // indexed by global featId).
      const tileProps = tileData.featureProps
      // PMTiles MVT often carries antimeridian-wrap COPIES of point
      // features as separate vertices with the SAME featId — e.g.,
      // "North Atlantic Ocean" gets 3 points (lng=-40 real centroid +
      // lng=180 + lng=-180 wrap copies) so the polygon renderer can
      // draw it at any visible world copy. For LABELS each feature
      // should emit ONCE at its real centroid — the map.ts projector
      // handles world wrap itself, so emitting the wrap copies here
      // would stack duplicate country names at antimeridian-edge
      // positions.
      //
      // First pass: collect the BEST point per featId (the one whose
      // mercator-X falls strictly inside the world ±WORLD_MERC/2,
      // preferring centres away from the antimeridian seam). Second
      // pass emits in featId-encounter order so callers see a
      // deterministic sequence.
      const WORLD_MERC_HALF = 20037508.342789244  // π × earth_radius
      const ANTIMERIDIAN_TOL = 1.0  // metres; tile-edge wrap copies sit at exactly ±half
      const bestByFeatId = new Map<number, { mercX: number; mercY: number; firstIdx: number }>()
      for (let i = 0; i < ptv.length; i += 5) {
        const ptMxLocal = ptv[i] + ptv[i + 2]
        const ptMyLocal = ptv[i + 1] + ptv[i + 3]
        const featId = ptv[i + 4] | 0
        const mercX = tileMercX + ptMxLocal
        const mercY = tileMercY + ptMyLocal
        const isInner = Math.abs(Math.abs(mercX) - WORLD_MERC_HALF) > ANTIMERIDIAN_TOL
        const existing = bestByFeatId.get(featId)
        if (!existing) {
          bestByFeatId.set(featId, { mercX, mercY, firstIdx: i })
        } else if (isInner) {
          // Real centroid beats any wrap-edge copy already stored.
          const existingIsInner = Math.abs(Math.abs(existing.mercX) - WORLD_MERC_HALF) > ANTIMERIDIAN_TOL
          if (!existingIsInner) bestByFeatId.set(featId, { mercX, mercY, firstIdx: existing.firstIdx })
        }
      }
      // Emit in featId-first-encounter order for caller determinism.
      const ordered = [...bestByFeatId.entries()].sort((a, b) => a[1].firstIdx - b[1].firstIdx)
      for (const [featId, pt] of ordered) {
        // SKIP antimeridian-edge anchors. When a tile only contains
        // wrap copies of a feature (e.g., the East-Hemisphere tile
        // 1/1/0 carries Canada's wrap copy at mercX=+WORLD_MERC_HALF
        // so its polygon can render at the world's right edge), the
        // bestByFeatId selection above falls back to the wrap copy
        // because no inner alternative exists in THIS tile. Emitting
        // those copies as label anchors makes the caller's cross-tile
        // name-dedup (map.ts:3089 emittedPointNames) latch on to the
        // first one it sees — typically the camera-near tile's wrap
        // copy — and PERMANENTLY skip the real centroid living in the
        // opposite-world tile. Visible symptom (2026-05-13 OFM Bright
        // at zoom=0.5/lon=175): Canada, UK, Portugal, Mexico, Brazil
        // etc. all stack at the antimeridian column on screen.
        //
        // The caller (map.ts) handles world-copy projection through
        // `projectLonLatCopies` starting from the real centroid, so
        // wrap copies as label anchors are pure noise. Drop them.
        const atAntimeridian = Math.abs(Math.abs(pt.mercX) - WORLD_MERC_HALF) <= ANTIMERIDIAN_TOL
        if (atAntimeridian) continue

        let props: Record<string, unknown>
        if (tileProps) {
          props = tileProps.get(featId) ?? {}
        } else {
          const row = values[featId] as readonly (number | string | boolean | null)[] | undefined
          props = {}
          if (row) {
            for (let f = 0; f < fieldNames.length; f++) props[fieldNames[f]!] = row[f]
          }
        }
        fn(pt.mercX, pt.mercY, props)
      }
    }
  }

  /** Walk per-tile line geometry and emit one label anchor per UNIQUE
   *  feature (keyed by the stride-10 lineVertices' featId at index 4).
   *  Used when LabelDef.placement === 'line' so road / waterway names
   *  appear along their geometry instead of at a polygon-style centroid.
   *
   *  Callback receives BOTH segment endpoints in absolute mercator
   *  metres so the caller can project them through the active camera
   *  and compute a screen-space rotation angle (mercator-space angle
   *  diverges from screen-space at non-zero pitch or rotated bearing).
   *
   *  Per-feature segment selection: picks the LONGEST mercator
   *  segment within the tile rather than the first one encountered.
   *  First-segment was visibly broken on curved/multi-segment roads —
   *  the picked segment was usually a tiny clip-corner fragment whose
   *  tangent didn't match the road's overall direction, producing
   *  labels rotated arbitrarily and stuck at the tile boundary. The
   *  longest segment is the natural "main run" of the road inside
   *  the tile: representative tangent, midpoint sits along the
   *  visible road body. Mapbox's full anchor-on-curve placement
   *  remains a follow-up; this is a 90% solution for one-label-per-
   *  road maps. */
  forEachLineLabelFeature(
    sliceLayer: string | undefined,
    fn: (
      p1MercX: number, p1MercY: number,
      p2MercX: number, p2MercY: number,
      props: Record<string, unknown>,
    ) => void,
  ): void {
    if (!this.source) return
    const table = this.source.getPropertyTable()
    const fieldNames = table?.fieldNames ?? []
    const values = table?.values ?? []
    const DEG2RAD = Math.PI / 180
    const R = 6378137
    const LAT_LIMIT = 85.051129
    const clampLat = (v: number): number => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, v))
    const STRIDE = 10  // [mx_h, my_h, mx_l, my_l, feat_id, arc, tin_x, tin_y, tout_x, tout_y]

    // Same visible-only walk as forEachLabelFeature — see comment
    // there for the 30× iteration-count win at Bright z=14 and the
    // world-copy dedup rationale.
    const rawLabelKeys = this._frameTileCache?.neededKeys ?? this.stableKeys
    const labelKeys = rawLabelKeys.length > 0 ? [...new Set(rawLabelKeys)] : rawLabelKeys
    // Reusable across tiles to avoid per-tile Map allocation churn.
    // Holds the longest segment seen so far for each featId in the
    // CURRENT tile's iteration; cleared at tile boundary.
    const best = new Map<number, { a: number; b: number; len2: number }>()
    for (const key of labelKeys) {
      const tileData = this.source.getTileData(key, sliceLayer)
      if (!tileData?.lineVertices || !tileData?.lineIndices) continue
      const lv = tileData.lineVertices
      const li = tileData.lineIndices
      if (lv.length < STRIDE * 2 || li.length < 2) continue
      const tileMercX = tileData.tileWest * DEG2RAD * R
      const tileMercY = Math.log(Math.tan(Math.PI / 4 + clampLat(tileData.tileSouth) * DEG2RAD / 2)) * R
      const tileProps = tileData.featureProps
      best.clear()
      for (let i = 0; i < li.length; i += 2) {
        const a = li[i]! * STRIDE
        const b = li[i + 1]! * STRIDE
        const featId = lv[a + 4]! | 0
        // Defensive: a degenerate segment with mismatched featIds
        // would produce a label spanning two roads. Skip rather than
        // emit garbage.
        if ((lv[b + 4]! | 0) !== featId) continue
        // Squared mercator length is fine for max-comparison and
        // avoids a sqrt per segment.
        const dx = (lv[b]! + lv[b + 2]!) - (lv[a]! + lv[a + 2]!)
        const dy = (lv[b + 1]! + lv[b + 3]!) - (lv[a + 1]! + lv[a + 3]!)
        const len2 = dx * dx + dy * dy
        const cur = best.get(featId)
        if (cur === undefined || len2 > cur.len2) {
          best.set(featId, { a, b, len2 })
        }
      }
      for (const [featId, { a, b }] of best) {
        // DSFUN tile-local high+low → tile-local mercator → absolute.
        const ax = tileMercX + lv[a]! + lv[a + 2]!
        const ay = tileMercY + lv[a + 1]! + lv[a + 3]!
        const bx = tileMercX + lv[b]! + lv[b + 2]!
        const by = tileMercY + lv[b + 1]! + lv[b + 3]!
        let props: Record<string, unknown>
        if (tileProps) {
          props = tileProps.get(featId) ?? {}
        } else {
          const row = values[featId] as readonly (number | string | boolean | null)[] | undefined
          props = {}
          if (row) {
            for (let f = 0; f < fieldNames.length; f++) props[fieldNames[f]!] = row[f]
          }
        }
        fn(ax, ay, bx, by, props)
      }
    }
  }

  /** Iterate visible line-feature polylines (Mapbox `symbol-placement:
   *  line` with `symbol-spacing`). Unlike `forEachLineLabelFeature`
   *  which collapses each feature to its longest segment, this method
   *  yields the FULL polyline so the caller can walk it in screen
   *  space and place a label every `spacing` pixels.
   *
   *  Polylines are grouped by featId AND segment-chain continuity:
   *  `tessellateLineToArrays` writes consecutive segments
   *  `(0,1),(1,2),(2,3),…` so we detect chain breaks via index
   *  discontinuity. A MultiLineString feature produces multiple
   *  polyline calls (one per part).
   *
   *  Coordinates are absolute mercator metres — the caller projects
   *  to screen and decides spacing in pixels. */
  forEachLineLabelPolyline(
    sliceLayer: string | undefined,
    fn: (
      polylineMercX: Float64Array,
      polylineMercY: Float64Array,
      props: Record<string, unknown>,
    ) => void,
  ): void {
    if (!this.source) return
    const table = this.source.getPropertyTable()
    const fieldNames = table?.fieldNames ?? []
    const values = table?.values ?? []
    const DEG2RAD = Math.PI / 180
    const R = 6378137
    const LAT_LIMIT = 85.051129
    const clampLat = (v: number): number => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, v))
    const STRIDE = 10

    // Same dedup rationale as forEachLabelFeature — see comment there.
    const rawLabelKeys = this._frameTileCache?.neededKeys ?? this.stableKeys
    const labelKeys = rawLabelKeys.length > 0 ? [...new Set(rawLabelKeys)] : rawLabelKeys
    // Reusable buffers grown as needed — most polylines fit in 32 verts.
    let xs = new Float64Array(64)
    let ys = new Float64Array(64)
    for (const key of labelKeys) {
      const tileData = this.source.getTileData(key, sliceLayer)
      if (!tileData?.lineVertices || !tileData?.lineIndices) continue
      const lv = tileData.lineVertices
      const li = tileData.lineIndices
      if (lv.length < STRIDE * 2 || li.length < 2) continue
      const tileMercX = tileData.tileWest * DEG2RAD * R
      const tileMercY = Math.log(Math.tan(Math.PI / 4 + clampLat(tileData.tileSouth) * DEG2RAD / 2)) * R
      const tileProps = tileData.featureProps

      // Walk segments, accumulate runs that form a contiguous polyline
      // (same feat_id AND segment[i].endIdx === segment[i+1].startIdx).
      // Emit each run as one polyline call.
      //
      // PER-TILE dedupe by featId: a road feature often breaks into
      // multiple disjoint polyline runs inside a single tile (its
      // geometry sliced by tile clip + non-monotone segment ordering),
      // and emitting a label run for each one stacks the same road
      // name 3-5× on top of itself at high zoom. We collect ALL runs
      // for each featId in this tile, keep the LONGEST one (most
      // representative of the road's true direction + the run least
      // likely to be a corner clip artifact), and emit only that.
      // Cross-tile dedupe is a separate concern handled in map.ts via
      // featId-Set tracking — featIds are tile-local in PMTiles MVT.
      type RunEntry = { xs: Float64Array; ys: Float64Array; len: number; props: Record<string, unknown> }
      const tileRuns = new Map<number, RunEntry>()
      let runFeatId = -1
      let runEndIdx = -1
      let runLen = 0  // number of vertices in xs/ys
      let runProps: Record<string, unknown> | null = null
      const flushRun = () => {
        if (runProps !== null && runLen >= 2) {
          let total = 0
          for (let j = 0; j < runLen - 1; j++) {
            const dxR = xs[j + 1]! - xs[j]!
            const dyR = ys[j + 1]! - ys[j]!
            total += Math.sqrt(dxR * dxR + dyR * dyR)
          }
          const existing = tileRuns.get(runFeatId)
          if (!existing || existing.len < total) {
            tileRuns.set(runFeatId, {
              xs: xs.slice(0, runLen),
              ys: ys.slice(0, runLen),
              len: total,
              props: runProps,
            })
          }
        }
        runLen = 0
        runProps = null
        runEndIdx = -1
      }
      const lookupProps = (featId: number): Record<string, unknown> => {
        if (tileProps) return tileProps.get(featId) ?? {}
        const row = values[featId] as readonly (number | string | boolean | null)[] | undefined
        const props: Record<string, unknown> = {}
        if (row) {
          for (let f = 0; f < fieldNames.length; f++) props[fieldNames[f]!] = row[f]
        }
        return props
      }
      const ensureCap = (need: number) => {
        if (need <= xs.length) return
        let cap = xs.length
        while (cap < need) cap *= 2
        const nx = new Float64Array(cap)
        const ny = new Float64Array(cap)
        nx.set(xs); ny.set(ys)
        xs = nx; ys = ny
      }

      for (let i = 0; i < li.length; i += 2) {
        const aIdx = li[i]!
        const bIdx = li[i + 1]!
        const a = aIdx * STRIDE
        const b = bIdx * STRIDE
        const featId = lv[a + 4]! | 0
        if ((lv[b + 4]! | 0) !== featId) continue

        const startsNewRun = featId !== runFeatId || aIdx !== runEndIdx
        if (startsNewRun) {
          flushRun()
          runFeatId = featId
          runProps = lookupProps(featId)
          ensureCap(2)
          xs[0] = tileMercX + lv[a]! + lv[a + 2]!
          ys[0] = tileMercY + lv[a + 1]! + lv[a + 3]!
          xs[1] = tileMercX + lv[b]! + lv[b + 2]!
          ys[1] = tileMercY + lv[b + 1]! + lv[b + 3]!
          runLen = 2
        } else {
          ensureCap(runLen + 1)
          xs[runLen] = tileMercX + lv[b]! + lv[b + 2]!
          ys[runLen] = tileMercY + lv[b + 1]! + lv[b + 3]!
          runLen += 1
        }
        runEndIdx = bIdx
      }
      flushRun()
      // Emit the best (longest) run per featId for this tile.
      for (const run of tileRuns.values()) {
        fn(run.xs, run.ys, run.props)
      }
    }
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
    // P4 compute resources: per-tile ComputeLayerHandle instances
    // own (feat / out / count) buffer trios. Free them before the
    // legacy buffer loop so device memory is reclaimed in one pass.
    for (const handle of this.computeHandlesByTile.values()) {
      handle.destroy()
    }
    this.computeHandlesByTile.clear()
    for (const inner of this.gpuCache.values()) {
      for (const tile of inner.values()) {
        tile.vertexBuffer?.destroy()
        tile.indexBuffer?.destroy()
        tile.lineVertexBuffer?.destroy()
        tile.lineIndexBuffer?.destroy()
        tile.outlineIndexBuffer?.destroy()
        tile.outlineSegmentBuffer?.destroy()
        tile.lineSegmentBuffer?.destroy()
        tile.featureDataBuffer?.destroy()
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
  /** Per-slice memo of classifyTile() decisions, keyed by sliceLayer.
   *  In bright-style maps an MVT source (`openmaptiles`) backs 81
   *  shows that resolve to ~13 distinct (sourceLayer + filter)
   *  slices. Without this memo every show re-runs the per-tile
   *  decision tree → 81 × 150 visible tiles = 12k classifyTile
   *  calls per frame at over-zoom. With it ≤ 13 × 150 = 1950
   *  calls. Cleared in beginFrame; populated lazily on first
   *  render() per (slice, tile-key). Safe across shows of the same
   *  slice because the decision inputs (layerCache + index +
   *  catalog) only change via this same render call's uploads,
   *  which we re-apply identically to subsequent same-slice shows. */
  private _frameClassifyMemo: Map<string, Map<number, TileDecision>> = new Map()

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
  buildFeatureDataBuffer(
    variant: ShaderVariant,
    featureBindGroupLayout: GPUBindGroupLayout,
    renderNodeIndex?: number,
  ): void {
    // Capture variant requirements regardless of PropertyTable state so
    // the per-tile feature-buffer path (MVT/PMTiles) has the field list
    // + categoryOrder needed at tile upload time. Without this, MVT
    // tiles with featureProps had no schema to pack and rendered as
    // missing fills (OFM Bright landuse `class` match).
    this.latestVariantFields = variant.featureFields
    this.latestVariantCategoryOrder = (variant.categoryOrder as Record<string, readonly string[]>) ?? {}
    this.featureBindGroupLayout = featureBindGroupLayout
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

    const table = this.source?.getPropertyTable()
    if (!table || variant.featureFields.length === 0 || table.values.length === 0) {
      // No source-level PropertyTable available (PMTiles backend leaves
      // it empty by design). Per-tile path will handle on uploadTile.
      return
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
          // Legacy path: variant doesn't expose category order (e.g.
          // shader uses `categorical()` palette, not `match()`). Sort
          // unique data values alphabetically; matches the historic
          // assignment behaviour.
          const uniqueVals = new Set<string>()
          for (const row of table.values) {
            const v = row[fi]
            if (typeof v === 'string') uniqueVals.add(v)
          }
          const sorted = [...uniqueVals].sort()
          sorted.forEach((v, i) => map.set(v, i))
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

    // Build the shared feature-bound tile bind group
    this.rebuildTileBindGroups()

    console.log(`[X-GIS] Feature data buffer: ${featureCount} features × ${fieldCount} fields`)
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
  private buildPerTileFeatureData(
    featureProps: ReadonlyMap<number, Record<string, unknown>> | undefined,
    handleKey: string = '',
  ): { buffer: GPUBuffer; bindGroup: GPUBindGroup } | null {
    if (!featureProps || featureProps.size === 0) return null
    if (this.latestVariantFields.length === 0) return null
    if (!this.featureBindGroupLayout || !this.uniformRing) return null

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
        const unique = new Set<string>()
        for (const props of featureProps.values()) {
          const v = props[fieldName]
          if (typeof v === 'string') unique.add(v)
        }
        const sorted = [...unique].sort()
        sorted.forEach((v, i) => map.set(v, i))
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
    if (!this.paletteColorAtlasView || !this.paletteSampler) return null

    // P4 compute path: when the captured variant carries
    // computeBindings, build (or refresh) a per-tile
    // ComputeLayerHandle for this (variant, tile) pair and append
    // its output buffer entries to the bind group. Legacy (no
    // computeBindings) shows skip this entirely — the bind group
    // stays at the legacy 4-entry shape.
    let extraComputeEntries: { binding: number; resource: { buffer: GPUBuffer } }[] = []
    if (this.latestVariant
      && (this.latestVariant.computeBindings?.length ?? 0) > 0
      && this.latestComputePlan
      && this.latestRenderNodeIndex !== undefined
      && handleKey) {
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
      handle!.uploadFromProps(
        (fid: number) => featureProps.get(fid) ?? null,
        featureCount,
      )
      // Append the handle's bind-group entries (compute output
      // storage buffer at binding 16 by default).
      const compEntries = handle!.getBindGroupEntries()
      if (compEntries) extraComputeEntries = compEntries
    }

    const bindGroup = this.device.createBindGroup({
      label: 'per-tile-feature-bg',
      layout: this.featureBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformRing, offset: 0, size: UNIFORM_SIZE } },
        { binding: 1, resource: { buffer } },
        { binding: 2, resource: this.paletteColorAtlasView },
        { binding: 4, resource: this.paletteSampler },
        ...extraComputeEntries,
      ],
    })

    return { buffer, bindGroup }
  }

  /** Route uploads through the priority queue. Every call enqueues an
   *  async dispatch via `doUploadTileAsync`; the queue caps concurrent
   *  uploads via `maxJobs` (set per-frame from `uploadBudgetFor`).
   *  Same-key + same-layer dedup uses the queue's identity Map.
   *
   *  Mid-render fallback uploads still go directly to `doUploadTile`
   *  (sync) — they need data on GPU before the next render command in
   *  the same call. Queued uploads tolerate the mapAsync round-trip
   *  because the visible-set's fallback ancestor covers the gap. */
  private uploadTile(key: number, data: TileData, sourceLayer = ''): void {
    if (this.getLayerCache(sourceLayer)?.has(key)) return
    const id = `${key}:${sourceLayer}`
    if (this.uploadQueue.has(id)) return
    if (this._heldUploadIds.has(id)) return  // already deferred to next frame

    // Per-frame SLICE-upload cap. Phase A/B/C made `uploadTile` per-
    // SLICE not per-tile, so a single visible tile in an 80-layer
    // style (Bright) generates ~80 uploadTile calls. Empirically
    // (z=14 Tokyo, OpenFreeMap Bright):
    //   cap=24 → pitch=0 182 ms / pitch=40 514 ms / pitch=80 1066 ms
    //   cap=4  → pitch=0 190 ms / pitch=40 150 ms / pitch=80  339 ms
    // Higher cap drains more this frame but each dispatched upload's
    // sync portion (~5 ms staging copy + writeBuffer encode) blocks
    // the JS thread, so the per-frame budget grows. cap=4 is the
    // sweet spot: convergence is bounded but per-frame stall is
    // tolerable. Mobile gets 1 (matches the prior `uploadBudgetFor`
    // mobile floor for the same per-CPU-cost reasoning).
    const cap = (typeof window !== 'undefined' && window.innerWidth <= 900) ? 1 : 4
    if (this._uploadsThisFrame >= cap) {
      this._heldUploads.push({ key, data, sourceLayer })
      this._heldUploadIds.add(id)
      this._heldUploadKeys.add(key)
      return
    }
    this._uploadsThisFrame++

    this.uploadItemData.set(id, { key, data, sourceLayer })
    this.uploadQueue.add(id, async () => {
      const item = this.uploadItemData.get(id)
      this.uploadItemData.delete(id)
      if (!item) return
      await this.doUploadTileAsync(item.key, item.data, item.sourceLayer)
    }).catch((err: unknown) => {
      this.uploadItemData.delete(id)
      console.error('[upload queue]', err)
    })
  }

  /** Release the per-frame upload slot counter and replay any tiles
   *  held over from the previous frame. Called from beginFrame. */
  private resetUploadFrameCap(): void {
    this._uploadsThisFrame = 0
    if (this._heldUploads.length === 0) return
    // Replay up to the cap. Items beyond the cap remain held for the
    // following frame.
    const held = this._heldUploads
    this._heldUploads = []
    this._heldUploadIds.clear()
    this._heldUploadKeys.clear()
    for (const item of held) {
      // Re-deferrals (cap exceeded again) repopulate _heldUploadKeys
      // via the push branch above; successful uploads simply leave
      // the key out of the rebuilt set.
      this.uploadTile(item.key, item.data, item.sourceLayer)
    }
  }

  /** Kick the upload queue. The queue auto-schedules via `queueMicrotask`
   *  on every `add` and on every job completion, so this is mostly a
   *  no-op in steady state — only useful as an explicit flush point if
   *  the caller wants the queue to consider its current state right
   *  now (e.g. immediately after a burst of `uploadTile` calls). */
  private drainPendingUploads(): void {
    this.uploadQueue.tryRunJobs()
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
    // Slices that carried per-feature `render_height` / `height` from
    // the MVT decode path get the extruded vertex layout: walls + a
    // parallel z attribute. Slices without heights data stay on the
    // single-VB flat layout — render-time decides the actual lift via
    // the layer's `extrude:` keyword (uniform mode just reads is_top
    // and applies u.extrude_height_m). The previous heuristic
    // (`sourceLayer === 'buildings'`) is replaced — slices route
    // entirely off the data they carry, and per-layer control lives
    // in the style language now.
    const useFeatureHeights = data.heights !== undefined && data.heights.size > 0
    // Per-feature mode: `polygon-mesh.ts:226` does
    // `heights.get(fid) ?? defaultHeight`. The default is what
    // features WITHOUT a height entry render at — and the language
    // contract is now "extrude only when the data says so".
    // Author-controlled fallbacks (e.g. `extrude: .height ?? 50`)
    // are evaluated in the worker and end up IN the heights map;
    // the engine itself doesn't fabricate one.
    const fallbackHeight = 0
    let polyVerts: ArrayBuffer
    let polyIndices: Uint32Array
    let zAttribute: Float32Array | null = null
    if (useFeatureHeights && data.polygons) {
      const top = quantizePolygonVerticesExtruded(data.vertices, tileExtentM, data.heights!, fallbackHeight)
      const topVertexCount = top.vertices.byteLength / 8
      const DEG2RAD = Math.PI / 180
      const R = 6378137
      const tileMx = data.tileWest * DEG2RAD * R
      const clampLat = Math.max(-85.051129, Math.min(85.051129, data.tileSouth))
      const tileMy = Math.log(Math.tan(Math.PI / 4 + clampLat * DEG2RAD / 2)) * R
      const wall = generateWallMeshExtruded(data.polygons, tileExtentM, tileMx, tileMy, data.heights!, fallbackHeight, data.bases, 0)
      const combined = new Uint8Array(top.vertices.byteLength + wall.vertices.byteLength)
      combined.set(new Uint8Array(top.vertices), 0)
      combined.set(new Uint8Array(wall.vertices), top.vertices.byteLength)
      polyVerts = combined.buffer
      polyIndices = new Uint32Array(data.indices.length + wall.indices.length)
      polyIndices.set(data.indices, 0)
      for (let i = 0; i < wall.indices.length; i++) {
        polyIndices[data.indices.length + i] = wall.indices[i] + topVertexCount
      }
      zAttribute = new Float32Array(top.z.length + wall.z.length)
      zAttribute.set(top.z, 0)
      zAttribute.set(wall.z, top.z.length)
    } else {
      // Flat slice: no heights data → no walls. The is_top bit stays
      // clear so a layer with `extrude: 50` on this slice silently
      // renders flat (no height lift) — preferable to fabricating
      // walls without source-data direction. If users hit this case
      // they need to source data with a `render_height` / `height`
      // property.
      polyVerts = quantizePolygonVertices(data.vertices, tileExtentM, { isTop: false })
      polyIndices = data.indices
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

    let zBuffer: GPUBuffer | null = null
    if (zAttribute) {
      zBuffer = this.acquireBuffer(
        Math.max(zAttribute.byteLength, 4),
        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        'tile-z-attr',
      )
      this.device.queue.writeBuffer(zBuffer, 0, zAttribute)
    }

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
        // Main-thread fallback: pass heights + EXTRUDE_FALLBACK_HEIGHT_M
        // so this code path matches the worker pre-build (mvt-worker /
        // pmtiles-backend). Otherwise outlines for tiles built here
        // would drop to z=0 even on extruded layers and get occluded
        // by their own walls — same symptom the worker-side fix
        // (heights ?? defaultHeight) addresses.
        const segData = data.prebuiltOutlineSegments
          ?? buildLineSegments(
            data.outlineVertices, data.outlineLineIndices, 10,
            tileWidthMerc, tileHeightMerc,
            data.heights && data.heights.size > 0 ? data.heights : undefined,
            undefined, undefined,
            0,
          )
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
          segData = buildLineSegments(
            data.lineVertices, data.lineIndices, lineStride,
            tileWidthMerc, tileHeightMerc,
            data.heights && data.heights.size > 0 ? data.heights : undefined,
            undefined, undefined,
            0,
          )
        }
        lineSegmentBuffer = this.lineRenderer.uploadSegmentBuffer(segData)
        lineSegmentCount = data.lineIndices.length / 2
        lineSegmentBindGroup = this.lineRenderer.createLayerBindGroup(lineSegmentBuffer)
      }
    }

    // Per-tile feat_data buffer for MVT/PMTiles data-driven paint.
    // Builds only when a variant requiring per-feature data has bound
    // to this renderer (latestVariantFields captured) AND the worker
    // emitted featureProps for this slice. GeoJSON path skips (uses
    // source-level featureDataBuffer instead).
    // Compute-handle keying matches the legacy `${key}:${sourceLayer}`
    // identity already used by the upload queue + held set, so the
    // handle's lifetime tracks the tile's bind-group lifetime.
    const perTileFeat = this.buildPerTileFeatureData(data.featureProps, `${key}:${sourceLayer}`)

    layerCache.set(key, {
      vertexBuffer, indexBuffer,
      indexCount: polyIndices.length,
      zBuffer,
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
      featureDataBuffer: perTileFeat?.buffer ?? null,
      featureBindGroup: perTileFeat?.bindGroup ?? null,
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

  /** Async variant of `doUploadTile`. Routes the 5-7 GPU buffer writes
   *  through the staging pool's `mapAsync` path, so the JS thread
   *  yields between mapAsync round-trips and concurrent uploads can
   *  overlap CPU work on subsequent tiles. Used by `drainPendingUploads`
   *  for the queued (background) upload path. The sync `doUploadTile`
   *  above stays put for mid-render fallback uploads where data must
   *  be on GPU before the next render command in the same call.
   *
   *  Body mirrors `doUploadTile` line-for-line apart from:
   *    - one command encoder per tile
   *    - writeBuffer → asyncWriteBuffer (pooled mapAsync)
   *    - lineRenderer.uploadSegmentBuffer → uploadSegmentBufferAsync
   *    - submit + bulk-release at the end
   *  Code dup is acceptable: the alternative (parameterising over a
   *  writer callable) breaks the mid-render path because `await`
   *  defers to a microtask even for resolved promises, and the
   *  fallback ancestor uploads need to land before the calling
   *  renderTileKeys reads `layerCache`. */
  private async doUploadTileAsync(key: number, data: TileData, sourceLayer = ''): Promise<void> {
    const layerCache = this.getOrCreateLayerCache(sourceLayer)
    if (layerCache.has(key)) return

    const tileExtentM = TWO_PI_R_EARTH / Math.pow(2, data.tileZoom)
    const useFeatureHeights = data.heights !== undefined && data.heights.size > 0
    const fallbackHeight = 0
    let polyVerts: ArrayBuffer
    let polyIndices: Uint32Array
    let zAttribute: Float32Array | null = null
    if (useFeatureHeights && data.polygons) {
      const top = quantizePolygonVerticesExtruded(data.vertices, tileExtentM, data.heights!, fallbackHeight)
      const topVertexCount = top.vertices.byteLength / 8
      const DEG2RAD = Math.PI / 180
      const R = 6378137
      const tileMx = data.tileWest * DEG2RAD * R
      const clampLat = Math.max(-85.051129, Math.min(85.051129, data.tileSouth))
      const tileMy = Math.log(Math.tan(Math.PI / 4 + clampLat * DEG2RAD / 2)) * R
      const wall = generateWallMeshExtruded(data.polygons, tileExtentM, tileMx, tileMy, data.heights!, fallbackHeight, data.bases, 0)
      const combined = new Uint8Array(top.vertices.byteLength + wall.vertices.byteLength)
      combined.set(new Uint8Array(top.vertices), 0)
      combined.set(new Uint8Array(wall.vertices), top.vertices.byteLength)
      polyVerts = combined.buffer
      polyIndices = new Uint32Array(data.indices.length + wall.indices.length)
      polyIndices.set(data.indices, 0)
      for (let i = 0; i < wall.indices.length; i++) {
        polyIndices[data.indices.length + i] = wall.indices[i] + topVertexCount
      }
      zAttribute = new Float32Array(top.z.length + wall.z.length)
      zAttribute.set(top.z, 0)
      zAttribute.set(wall.z, top.z.length)
    } else {
      polyVerts = quantizePolygonVertices(data.vertices, tileExtentM, { isTop: false })
      polyIndices = data.indices
    }

    // One command encoder per tile — all the copyBufferToBuffer ops
    // below batch into a single submit at the end, minimising queue
    // submission overhead.
    const encoder = this.device.createCommandEncoder({ label: `tile-upload-${key}` })
    const releases: Array<() => void> = []

    const vertexBuffer = this.acquireBuffer(
      Math.max(polyVerts.byteLength * 3, 12),
      GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      'tile-vertices',
    )
    const indexBuffer = this.acquireBuffer(
      Math.max(polyIndices.byteLength * 3, 4),
      GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      'tile-indices',
    )

    // Kick off the staging-buffer mapAsync for vertex + index in
    // parallel, then await both. mapAsync round-trips overlap, so
    // the wall-clock cost is one round-trip (not N).
    const writeHandles: Array<Promise<{ release: () => void }>> = []
    writeHandles.push(asyncWriteBuffer(this.stagingPool, encoder, vertexBuffer, 0, polyVerts))
    writeHandles.push(asyncWriteBuffer(this.stagingPool, encoder, indexBuffer, 0, polyIndices))

    let zBuffer: GPUBuffer | null = null
    if (zAttribute) {
      zBuffer = this.acquireBuffer(
        Math.max(zAttribute.byteLength, 4),
        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        'tile-z-attr',
      )
      writeHandles.push(asyncWriteBuffer(this.stagingPool, encoder, zBuffer, 0, zAttribute))
    }

    let lineVertexBuffer: GPUBuffer | null = null
    let lineIndexBuffer: GPUBuffer | null = null
    if (data.lineVertices.length > 0) {
      lineVertexBuffer = this.acquireBuffer(
        data.lineVertices.byteLength,
        GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        'tile-line-vertices',
      )
      writeHandles.push(asyncWriteBuffer(this.stagingPool, encoder, lineVertexBuffer, 0, data.lineVertices))

      lineIndexBuffer = this.acquireBuffer(
        data.lineIndices.byteLength,
        GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        'tile-line-indices',
      )
      writeHandles.push(asyncWriteBuffer(this.stagingPool, encoder, lineIndexBuffer, 0, data.lineIndices))
    }

    let outlineIndexBuffer: GPUBuffer | null = null
    let outlineIndexCount = 0
    if (data.outlineIndices && data.outlineIndices.length > 0) {
      outlineIndexBuffer = this.acquireBuffer(
        Math.max(data.outlineIndices.byteLength, 4),
        GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        'tile-outline-indices',
      )
      writeHandles.push(asyncWriteBuffer(this.stagingPool, encoder, outlineIndexBuffer, 0, data.outlineIndices))
      outlineIndexCount = data.outlineIndices.length
    }

    // SDF line segment buffers — same logic as sync path but routed
    // through `uploadSegmentBufferAsync` so the segment-buffer write
    // shares this tile's staging pool + encoder.
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
      if (data.outlineVertices && data.outlineVertices.length > 0
          && data.outlineLineIndices && data.outlineLineIndices.length > 0) {
        const segData = data.prebuiltOutlineSegments
          ?? buildLineSegments(
            data.outlineVertices, data.outlineLineIndices, 10,
            tileWidthMerc, tileHeightMerc,
            data.heights && data.heights.size > 0 ? data.heights : undefined,
            undefined, undefined,
            0,
          )
        const seg = await this.lineRenderer.uploadSegmentBufferAsync(segData, encoder, this.stagingPool)
        outlineSegmentBuffer = seg.buffer
        releases.push(seg.release)
        outlineSegmentCount = data.outlineLineIndices.length / 2
        outlineSegmentBindGroup = this.lineRenderer.createLayerBindGroup(outlineSegmentBuffer)
      }
      if (data.lineIndices.length > 0 && data.lineVertices.length > 0) {
        let segData: Float32Array
        if (data.prebuiltLineSegments) {
          segData = data.prebuiltLineSegments
        } else {
          let lineStride: 6 | 10 = 6
          if (data.lineIndices.length > 0) {
            let maxIdx = 0
            for (let li = 0; li < data.lineIndices.length; li++) {
              if (data.lineIndices[li] > maxIdx) maxIdx = data.lineIndices[li]
            }
            const vertCount = maxIdx + 1
            if (vertCount > 0 && data.lineVertices.length / vertCount >= 10) lineStride = 10
          }
          segData = buildLineSegments(
            data.lineVertices, data.lineIndices, lineStride,
            tileWidthMerc, tileHeightMerc,
            data.heights && data.heights.size > 0 ? data.heights : undefined,
            undefined, undefined,
            0,
          )
        }
        const seg = await this.lineRenderer.uploadSegmentBufferAsync(segData, encoder, this.stagingPool)
        lineSegmentBuffer = seg.buffer
        releases.push(seg.release)
        lineSegmentCount = data.lineIndices.length / 2
        lineSegmentBindGroup = this.lineRenderer.createLayerBindGroup(lineSegmentBuffer)
      }
    }

    // Wait for every staging write to land in its mapped range +
    // copyBufferToBuffer to be encoded. After this, the encoder holds
    // every copy command for the tile.
    const settled = await Promise.all(writeHandles)
    for (const h of settled) releases.push(h.release)

    // Single submit per tile. The GPU now consumes staging → dst.
    this.device.queue.submit([encoder.finish()])
    // Return staging slots to the pool. Subsequent borrows on these
    // slots will mapAsync, which natively waits for the just-submitted
    // copy to finish before re-mapping for write.
    for (const release of releases) release()

    // Race guard: another upload (e.g. parallel doUploadTileAsync for
    // the same key, or a synchronous mid-render fallback) may have
    // populated the cache while we were awaiting. Skip the second set.
    if (layerCache.has(key)) return

    // Per-tile feat_data — same rationale as the sync path.
    // Compute-handle keying matches the legacy `${key}:${sourceLayer}`
    // identity already used by the upload queue + held set, so the
    // handle's lifetime tracks the tile's bind-group lifetime.
    const perTileFeat = this.buildPerTileFeatureData(data.featureProps, `${key}:${sourceLayer}`)

    layerCache.set(key, {
      vertexBuffer, indexBuffer,
      indexCount: polyIndices.length,
      zBuffer,
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
      featureDataBuffer: perTileFeat?.buffer ?? null,
      featureBindGroup: perTileFeat?.bindGroup ?? null,
    })
    this._gpuCacheCount++

    // Same memory-cleanup as sync path.
    data.prebuiltLineSegments = undefined
    data.prebuiltOutlineSegments = undefined
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
     *  - 'strokes': outlines + line features only — used by BOTH the
     *               translucent offscreen MAX-blend pass (where it
     *               needs `pipelineMax`) and the opaque-bucket case
     *               where an OIT-extruded layer kept its outlines on
     *               the main pass (regular `pipeline`). The caller
     *               disambiguates via `translucentLines`. */
    phase: LayerDrawPhase = 'all',
    /** Backing-buffer:CSS-pixel ratio for the canvas. Tile budget /
     *  mobile classification / subdivide threshold are perceptual
     *  CSS-pixel concepts and must stay DPR-invariant; without this
     *  param a DPR=3 phone gets 9× more tiles loaded than a DPR=1
     *  desktop at the same logical viewport size. */
    dpr: number = 1,
    /** Depth-disabled (`STENCIL_WRITE_NO_DEPTH`) ground pipeline
     *  matching `bindGroupLayout` — used for `extrude.kind === 'none'`
     *  layers so coplanar painter's-order resolves without depth-test
     *  fighting. When omitted (e.g. legacy callers, tests), VTR falls
     *  back to the renderer-level `fillPipelineGround` which is base-
     *  layout only. */
    fillPipelineGroundOverride?: GPURenderPipeline,
    fillPipelineGroundFallbackOverride?: GPURenderPipeline,
    /** True when the caller's pass is the translucent offscreen
     *  MAX-blend RT (no depth attachment) — line draws must use
     *  `pipelineMax`. False (default) when the pass has a depth
     *  attachment (opaque bucket); line draws use the regular
     *  `pipeline`. The opaque bucket can also reach `phase ===
     *  'strokes'` for OIT-extruded layers whose outlines stayed
     *  on the main pass (fully opaque even though the fill is
     *  translucent), so phase alone isn't enough to dispatch. */
    translucentBucket: boolean = false,
    /** Per-frame ResolvedShow snapshot — required as of Phase 4c-final.
     *  Carries every zoom × time-resolved paint scalar / RGBA the
     *  draw path needs. The bucket scheduler (`classifyVectorTileShows`)
     *  is the sole authority that builds these; map.ts forwards them
     *  to every `VTR.render` call. New consumers MUST read paint values
     *  from here — `show.*` paint fields stay around for trace +
     *  introspection only. */
    resolvedShow: ResolvedShow,
  ): void {
    if (!this.source?.hasData()) return
    const index = this.source.getIndex()
    if (!index) return

    // Sliced-source slot for this layer. PMTiles emits per-show
    // slices when the source-attach config carries `showSlices` —
    // the slice key combines `sourceLayer` with a stable hash of
    // the layer's `filter:` AST so xgis layers that share a source
    // layer but have different filters get DIFFERENT slices (only
    // matching features). Without filter or for legacy sources
    // (XGVT-binary, GeoJSON-runtime, no-filter PMTiles shows),
    // sliceKey collapses to plain `sourceLayer` ('' for single-
    // layer sources) — preserving back-compat.
    const sliceLayer = computeSliceKey(show.sourceLayer ?? '', show.filterExpr?.ast ?? null)
    // DIAG: capture per-frame draw order so the cross-tile depth
    // question ("is buildings actually drawn LAST?") is answered from
    // runtime behaviour rather than architectural reading. The Map's
    // beginFrame resets `__xgisDrawOrderTrace = []`; map.ts dumps it
    // after the frame and clears the flag. Production paths stay
    // silent unless the flag is set.
    if (typeof window !== 'undefined') {
      const trace = (window as unknown as { __xgisDrawOrderTrace?: Array<{
        seq: number; slice: string; phase: string; extrude: string; tileKey?: number; isFill?: boolean
      }> }).__xgisDrawOrderTrace
      if (trace) {
        // Stash for the per-tile drawIndexed entries renderTileKeys
        // is about to push.
        this.lastTraceSlice = sliceLayer
        this.lastTracePhase = phase
      } else {
        this.lastTraceSlice = null
        this.lastTracePhase = null
      }
    }
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
    // Skip the draw when the variant pipeline expects feature layout
    // but no feature bind group is available ANYWHERE — the GeoJSON
    // path satisfies this with the source-level `this.tileBgFeature`;
    // the MVT/PMTiles path satisfies it with per-tile `cached.feature
    // BindGroup`s built at upload time. Returning unconditionally on
    // `!this.tileBgFeature` was the OFM Bright school-fill bug — MVT
    // path leaves `this.tileBgFeature` null by design (PMTiles
    // PropertyTable is empty), so the compound landuse `class` match
    // variant's render() never reached its tile loop. Per-tile feature
    // groups are tested inside the loop via `cached.featureBindGroup`.
    if (bindGroupLayout !== this.baseBindGroupLayout
        && !this.tileBgFeature
        && this.latestVariantFields.length === 0) return

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
    // Stroke width — zoom × time already collapsed by the bucket
    // scheduler. ResolvedShow is the SOLE per-frame source.
    const strokeWidthPx_h = resolvedShow.strokeWidth
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

    // Was 0.1 — added originally to suppress iOS-Safari pinch-zoom
    // jitter at the integer-half boundary (camera.zoom oscillates
    // 4.49 ↔ 4.51 producing a 4 ↔ 5 cz flip every frame). User
    // 2026-05-12 review: MapLibre advances tile-zoom at the exact
    // round boundary (z=4.5 → tile-z=5) so X-GIS at z=4.6 was still
    // serving the lower-z tile while MapLibre had already switched.
    // Match the reference: zero margin = pure Math.round semantics.
    // The jitter case is now handled by IDLE_GRACE_MS suppression
    // of speculative fetches during active gestures — actually
    // selecting the right cz still matters for what gets rendered.
    const HYST_MARGIN = 0
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
      // Promote to the next LOD as soon as the camera crosses z+0.3
      // — user-requested 2026-05-12 ("MapLibre seems to load the
      // next tile a level earlier"). Pure Math.round (advance at
      // z+0.5) felt visibly behind MapLibre at z=N.3 framings where
      // ML's geometry already used the finer tile.
      cz = Math.floor(z + 0.7)
      this._czPendingAdvance = null
    } else if (Math.abs(Math.floor(z + 0.7) - this._hysteresisZ) > 4) {
      // Bulk camera move (URL hash, programmatic camera reset,
      // jumpTo). The gate is designed for incremental user-driven
      // transitions; for jumps spanning more than ~4 LODs we'd
      // otherwise spend ~1 s per LOD climbing step-by-step, which
      // looks broken. Snap straight to target and let the normal
      // visible-tile pipeline + parent walk render whatever
      // ancestors happen to be cached on the way.
      // Promote to the next LOD as soon as the camera crosses z+0.3
      // — user-requested 2026-05-12 ("MapLibre seems to load the
      // next tile a level earlier"). Pure Math.round (advance at
      // z+0.5) felt visibly behind MapLibre at z=N.3 framings where
      // ML's geometry already used the finer tile.
      cz = Math.floor(z + 0.7)
      this._czPendingAdvance = null
    } else {
      cz = this._hysteresisZ
      const target = Math.floor(z + 0.7)
      let wantAdvance = false
      // Tile-LOD advance threshold lowered to z + 0.3 (was 0.5):
      // promote 1 LOD earlier so X-GIS's rendered detail matches
      // MapLibre's "1 level higher" appearance at z=N.3 framings.
      const zoomingIn = target > cz && z > cz + 0.3 + HYST_MARGIN
      const zoomingOut = target < cz && z < cz - 0.7 + HYST_MARGIN
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
          // Readiness gate uses the SAME selector as the main render
          // path (SSE default since `1ab9ab0`). Falling back to the
          // old frustum / sampled selectors here would (a) duplicate
          // tile-selection cost — the user's profile flagged this as
          // 33 % of frame time during zoom transitions, classifyTile
          // + visit + toScreen all in `tiles.ts` — and (b) emit a
          // DIFFERENT tile set than the renderer asks for, so the
          // readiness check wouldn't actually predict the renderer's
          // demand. SSE is faster AND consistent.
          stepTiles = visibleTilesSSE(
            camera, selectorProj, step,
            canvasWidth, canvasHeight, offsetMarginPx, dpr,
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
    // Clamp cz at sourceMaxLevel BEFORE recording hysteresis or
    // deriving currentZ — otherwise the selector still requests
    // z > maxLevel tiles (via the `step` derivation at line 1357)
    // and we re-enter the over-zoom path we're trying to avoid.
    //
    // Beyond archive maxLevel, sub-tile generation recursively
    // clips parent geometry into virtual children — same data,
    // smaller tile rect. The rendered RESULT is visually identical
    // to drawing the parent directly because no new detail enters
    // from the archive past maxLevel.
    //
    // The user-reported Tokyo z=17.07 issue (osm_style, archive
    // maxLevel=15) reproduced as foreground rendered as oversized
    // ancestor blocks because the deep over-zoom chain
    // (z=17 → z=16 → z=15) was sub-tile-gen-throttled and most
    // tiles fell back two-three levels. iOS Safari additionally
    // failed to render the polygon fills altogether (likely a
    // TBDR / sub-tile-gen pipeline incompatibility, unverified
    // without device access). Capping at maxLevel sends the
    // selector requests directly to archive-loadable tiles —
    // foreground draws as primary z=maxLevel with no sub-tile-gen
    // path and no fallback chain.
    //
    // Cost: lose sub-tile-gen's coordinate-precision benefit at
    // extreme over-zoom. DSFUN precision in a z=15 tile-local
    // frame is ~mm at z=22 anyway (TILE_EXTENT / 2^7 ≈ 0.3 m / f32
    // mantissa bits remaining), well below visible pixel scale.
    // The win: foreground always draws actual archived geometry
    // instead of an artefact-prone clip pyramid.
    const sourceMaxLevel = this.source.maxLevel
    if (cz > sourceMaxLevel) cz = sourceMaxLevel
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
    let protectedAncestors: number[] = []
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
      protectedAncestors = cache.protectedAncestors
      worldOffDeg = cache.worldOffDeg
      parentAtMaxLevel = cache.parentAtMaxLevel
      archiveAncestor = cache.archiveAncestor
    } else {
      // Phase 3 selector: Cesium-style screen-space-error DFS at every
      // pitch — supersedes the prior split (sampled-grid for low pitch,
      // quadtree-DFS for high pitch). SSE is projection-invariant by
      // construction (perceptual error metric), so a single algorithm
      // covers the full pitch range without the pitchMul kludge or the
      // 30° industry-split heuristic. A/B measured Bright at z=14 Tokyo:
      //
      //   pitch=  0°  frustum 15.5 ms / SSE  7.2 ms  (2.1× faster)
      //   pitch= 40°  frustum 25.4 ms / SSE  7.0 ms  (3.6×)
      //   pitch= 60°  frustum 67.0 ms / SSE 16.3 ms  (4.1×)
      //   pitch= 80°  frustum 66.6 ms / SSE 55.2 ms  (1.2×)
      //
      // SSE is now default. `__XGIS_USE_SSE_SELECTOR = false` rolls
      // back to the prior frustum + sampled pair as a safety hatch
      // (real-browser visual regression escape valve while Phase 3
      // bakes in usage).
      const _pitchDeg = camera.pitch ?? 0
      const sseDisabled = typeof window !== 'undefined'
        && (window as unknown as { __XGIS_USE_SSE_SELECTOR?: boolean }).__XGIS_USE_SSE_SELECTOR === false
      tiles = !sseDisabled
        ? visibleTilesSSE(
            camera,
            selectorProj,
            currentZ,
            canvasWidth,
            canvasHeight,
            offsetMarginPx,
            dpr,
          )
        : _pitchDeg < 30
        ? visibleTilesFrustumSampled(
            camera,
            selectorProj,
            currentZ,
            canvasWidth,
            canvasHeight,
            offsetMarginPx,
            dpr,
          )
        : visibleTilesFrustum(
            camera,
            selectorProj,
            currentZ,
            canvasWidth,
            canvasHeight,
            offsetMarginPx,
            dpr,
          )

      // Phase 2 selector-shape invariant — single-zoom emission was
      // an artefact of the Mapbox/MapLibre sampled-grid path and only
      // applied when that selector was active. Phase 3's SSE selector
      // emits mixed-LOD at every pitch by design, so the invariant
      // only fires on the sseDisabled fallback path.
      if (sseDisabled
          && (globalThis as { __XGIS_INVARIANTS?: boolean }).__XGIS_INVARIANTS
          && _pitchDeg < 30) {
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
      // `fallbackOnly: true` tiles from the selector (the high-pitch
      // parent inject in `visibleTilesFrustum`) exist solely to keep
      // the parent slice resident under eviction pressure — they MUST
      // NOT enter `neededKeys` or they'd be promoted to PRIMARY draws
      // (STENCIL_WRITE, compare='always') and overlap their own
      // children at the same screen pixels, blowing up triangle
      // counts. Strip them out into a separate `protectedAncestors`
      // list that the eviction policy folds into `stableKeys` later.
      const protectedAncestors: number[] = []
      const renderTiles: typeof tiles = []
      for (const t of tiles) {
        if (t.fallbackOnly) {
          protectedAncestors.push(tileKey(t.z, t.x, t.y))
        } else {
          renderTiles.push(t)
        }
      }
      tiles = renderTiles
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
        tiles, neededKeys, protectedAncestors, worldOffDeg,
        maxLevel,
        parentAtMaxLevel, archiveAncestor,
      }
    }

    const frame = camera.getFrameView(canvasWidth, canvasHeight, dpr)
    const mvp = frame.matrix
    this.logDepthFc = frame.logDepthFc

    // Cache color parsing — only reparse if show properties changed.
    //
    // Animation override: if `resolvedFillRgba` / `resolvedStrokeRgba` is
    // set, the classifier has already interpolated this frame's value from
    // a keyframes block. Use it directly — skipping both the hex cache
    // check AND the hex parse. The cached base color stays intact so a
    // subsequent static frame can re-use it.
    // Opacity is already resolved (zoom × time) by the bucket
    // scheduler — ResolvedShow is the SOLE per-frame source.
    this.currentOpacity = resolvedShow.opacity
    this.currentPickId = show.pickId ?? 0
    // 3D extrusion: driven by the layer's `extrude:` style keyword.
    //   * `extrude: 50`     → constant uniform path (currentExtrudeHeight)
    //   * `extrude: .height` → per-feature path (vertex z attribute);
    //     uniform mirror still set for fallback display when a tile
    //     slice has no `heights` map (e.g. archive missing the field
    //     for that zoom). Explicit, layer-local control replaces the
    //     prior `sourceLayer === 'buildings'` heuristic.
    if (show.extrude && show.extrude.kind === 'constant') {
      this.currentExtrudeHeight = show.extrude.value
      this.currentExtrudeMode = 'uniform'
    } else if (show.extrude && show.extrude.kind === 'feature') {
      this.currentExtrudeHeight = show.extrude.fallback
      this.currentExtrudeMode = 'per-feature'
    } else {
      this.currentExtrudeHeight = 0
      this.currentExtrudeMode = 'none'
    }
    // Per-frame resolved fill RGBA — animated stops were already
    // collapsed by the bucket scheduler. ResolvedShow is the SOLE
    // per-frame source; static hex still flows via show.fill below
    // when the ShowCommand declared a `kind: 'constant'` fill.
    const resolvedFill = resolvedShow.fill
    if (resolvedFill) {
      this.cachedFillColor[0] = resolvedFill[0]
      this.cachedFillColor[1] = resolvedFill[1]
      this.cachedFillColor[2] = resolvedFill[2]
      this.cachedFillColor[3] = resolvedFill[3]
      this.cachedShowFill = ''
    } else if (show.fill !== this.cachedShowFill) {
      this.cachedShowFill = show.fill ?? ''
      const raw = show.fill ? parseHexColor(show.fill) : null
      this.cachedFillColor[0] = raw ? raw[0] : 0
      this.cachedFillColor[1] = raw ? raw[1] : 0
      this.cachedFillColor[2] = raw ? raw[2] : 0
      this.cachedFillColor[3] = raw ? raw[3] : 0
    }
    const resolvedStroke = resolvedShow.stroke
    if (resolvedStroke) {
      this.cachedStrokeColor[0] = resolvedStroke[0]
      this.cachedStrokeColor[1] = resolvedStroke[1]
      this.cachedStrokeColor[2] = resolvedStroke[2]
      this.cachedStrokeColor[3] = resolvedStroke[3]
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
    uf[18] = this.cachedFillColor[2]; uf[19] = this.cachedFillColor[3] * this.currentOpacity
    uf[20] = this.cachedStrokeColor[0]; uf[21] = this.cachedStrokeColor[1]
    uf[22] = this.cachedStrokeColor[2]; uf[23] = this.cachedStrokeColor[3] * this.currentOpacity
    uf[24] = projType; uf[25] = projCenterLon; uf[26] = projCenterLat; uf[27] = 0

    // Allocate + write SDF line layer slot for this render() call. All
    // drawSegments() calls below will use this same byte offset.
    // In 'fills' phase no drawSegments runs, so skip the allocation entirely
    // to avoid ring-slot churn, redundant pattern-param warnings, and any
    // incidental validation surface in the translucent fill pre-pass.
    let lineLayerOffset = 0
    if (this.lineRenderer && phase !== 'fills') {
      // Pure-zoom stroke-width stops (Mapbox `paint.line-width:
      // ["interpolate", curve, ["zoom"], …]`) recompute per frame
      // against camera.zoom — so a line widens smoothly as the user
      // zooms inside one tile-zoom level. The static `show.strokeWidth`
      // is the lower.ts default (1); we override it here. Per-feature
      // widths (compound merge → `strokeWidthExpr`) still go through
      // the worker bake + segment slot.
      // Pre-resolved by bucket-scheduler (zoom × time → plain scalar).
      const strokeWidthPx = resolvedShow.strokeWidth
      const mpp = (WORLD_MERC / TILE_PX) / Math.pow(2, camera.zoom)
      const capMap = { butt: 0, round: 1, square: 2, arrow: 3 } as const
      const joinMap = { miter: 0, round: 1, bevel: 2 } as const
      // Default cap/join = round. Round is a stable circle SDF that fills
      // corners and chain ends correctly at any angle. Miter/bevel require
      // explicit opt-in via `stroke-linejoin-miter` / `stroke-linecap-butt`.
      const cap = capMap[show.linecap ?? 'round']
      const join = joinMap[show.linejoin ?? 'round']
      const miterLimit = show.miterlimit ?? 4.0
      // Dash values are in LINE-WIDTH UNITS (Mapbox spec:
      // "The lengths are later multiplied by the line width").
      // A `[2, 3]` dash on a 4-px line is 8 px dash + 12 px gap;
      // the same dash on a 6-px line is 12 + 18. Earlier the code
      // treated dash values as raw pixels, which produced near-
      // invisible dashes on thin admin-boundary / bridge-casing
      // lines (boundary_3 has [1,1] dash + 1-2 px width — without
      // the multiply, 1-px dashes against a 1-px line gave near-
      // continuous coverage and looked solid).
      const dashWidthScalePx = strokeWidthPx_h
      const dash = (show.dashArray && show.dashArray.length >= 2)
        ? {
            array: show.dashArray.map(v => v * dashWidthScalePx * mpp),
            offset: resolvedShow.dashOffset * dashWidthScalePx * mpp,
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
      const layerOpacity = phase === 'strokes' ? 1.0 : this.currentOpacity

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
        show.strokeBlur ?? 0,
      )
    }

    // neededKeys + worldOffDeg + parentAtMaxLevel + archiveAncestor
    // already computed (and cached frame-wide) above. Per-tile loop
    // and prefetch loop both read those arrays directly — no need
    // for a per-render `closestExistingByI` mirror, since the
    // sliceLayer-independent ancestor result is identical across
    // every same-frame ShowCommand render.
    let fallbackKeys: number[] = []
    let fallbackOffsets: number[] = []
    /** Parallel to `fallbackKeys`: the visible-tile key each fallback
     *  push is FILLING FOR. When a parent z=11 ancestor renders as
     *  fallback for a missing visible z=15 child, the per-tile clip
     *  mask uniform must clip the parent's geometry to the visible
     *  z=15 child's mercator bounds — otherwise the parent's data
     *  spills over neighboring children (some primary-loaded with
     *  their OWN buildings, causing cross-z depth fights). */
    let fallbackVisibleKeys: number[] = []
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

    // Per-frame slice memo: 81 shows in bright resolve to ~13 distinct
    // slices, so without this we run classifyTile 81× per visible tile
    // even though the inputs only vary by sliceLayer. See field decl.
    let sliceMemo = this._frameClassifyMemo.get(sliceLayer)
    if (!sliceMemo) {
      sliceMemo = new Map()
      this._frameClassifyMemo.set(sliceLayer, sliceMemo)
    }


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
      let decision: TileDecision | undefined = sliceMemo.get(key)
      if (!decision) {
        decision = classifyTile({
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
          // Coherence: any peer slice for this tile still queued blocks
          // primary in this layer too, so all consumers transition
          // together. See _heldUploadKeys field doc.
          hasOtherSliceHeld: this._heldUploadKeys.has(key),
        })
        sliceMemo.set(key, decision)
      }
      _tileDecisions[i] = decision.kind === 'queued-with-fallback' ? decision.fallback.kind : decision.kind

      if (decision.kind === 'overzoom-parent') {
        fallbackKeys.push(decision.parentKey)
        fallbackOffsets.push(worldOffDeg[i])
        fallbackVisibleKeys.push(key)
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
        fallbackVisibleKeys.push(key)
        // Advance the fetch frontier — without this push the parent
        // fallback covers the area visually forever but the proper-z
        // tile is never fetched, so the rendering stalls one z
        // coarser than the source supports. catalog.requestTiles
        // dedupes against `loadingTiles` so repeat pushes per frame
        // collapse to one in-flight fetch.
        if (inner.wantsRequestKey !== null) toLoad.push(inner.wantsRequestKey)
      } else if (inner.kind === 'child-fallback') {
        for (const ck of inner.childrenNeedingUpload) {
          const childData = this.source.getTileData(ck, sliceLayer)
          if (childData) this.doUploadTile(ck, childData, sliceLayer)
        }
        for (const ck of inner.childKeys) {
          fallbackKeys.push(ck)
          fallbackOffsets.push(worldOffDeg[i])
          fallbackVisibleKeys.push(key)
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
      // Rule 1 (replace refinement): classifyFallback's pending branch
      // routes the request to the SHALLOWEST uncached ancestor, which
      // can sit between the pinned skeleton (z=0..2/3) and the visible
      // zoom (e.g. z=5 when skeleton ends at z=2). Without unioning
      // toLoad, the next frame's cancelStale sees those mid-chain
      // ancestors as "stale" (not in needed/parent/fallback/skeleton/
      // prefetch sets) and aborts the in-flight fetch — top-down
      // loading then never converges, the request loops forever
      // between fire and abort.
      for (const k of toLoad) activeKeys.add(k)
      this.source.cancelStale(activeKeys)
    }

    // Update the fetch-queue priority comparator with the current
    // camera centre BEFORE issuing requestTiles. The PriorityQueue
    // re-sorts on every dispatch using whatever comparator is set, so
    // the first job picked from the queue right after this is the
    // closest tile to the camera. World-copy offsets aren't carried in
    // the tile-key (only z/x/y), so a tile's distance is computed
    // against the central-world-copy mercator centre — adequate for
    // priority ordering since all visible copies of the same tile
    // sort together. Backends without a queue (XGVT-binary, GeoJSON)
    // ignore this hook.
    // Update fetch + upload priority comparators with the current
    // camera centre. Wired through stable instance closures
    // (`_distSqStable`) — re-allocating a fresh closure + Map per
    // render() call (called ~80 times per frame on 80-layer styles)
    // dominated the JS-thread slice before this hoist. The memo on
    // `_distMemo` actually shares the lookup across every render() in
    // the frame now, instead of starting empty each time.
    if (this._distMemoCamX !== camera.centerX || this._distMemoCamY !== camera.centerY) {
      this._distMemoCamX = camera.centerX
      this._distMemoCamY = camera.centerY
      // Camera moved → previously-sorted items now compare against
      // different distances. Force the next uploadQueue.sort() to
      // re-execute (the per-frame idempotency skip would otherwise
      // keep the stale ordering when the queue's items haven't
      // changed since last frame).
      this.uploadQueue.markDirty()
      this._distMemo.clear()
    }
    if (this._installedPriorityFns !== this.uploadQueue) {
      this.source.setFetchPriority(this._distSqStable)
      const itemData = this.uploadItemData
      const distSq = this._distSqStable
      this.uploadQueue.priorityCallback = (a, b) => {
        const ia = itemData.get(a), ib = itemData.get(b)
        if (!ia || !ib) return 0
        return distSq(ib.key) - distSq(ia.key)
      }
      this._installedPriorityFns = this.uploadQueue
    }
    this.uploadQueue.maxJobs = uploadBudgetFor(canvasWidth, canvasHeight, dpr)

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
      // Ground-layer fill (`extrude.kind === 'none'`) uses the
      // depth-disabled pipeline so coplanar layers resolve via
      // painter's order. Layers with `extrude:` keep the regular
      // depth-write pipeline; the per-feature extruded path takes
      // its own branch inside renderTileKeys.
      //
      // Pick the depth-disabled ground pipeline whose layout matches
      // the show's bind-group layout. Two cases:
      //   • Show is base-layout (no variant feature buffer): use the
      //     renderer-level default `fillPipelineGround` (base-only).
      //   • Show is variant + featureBindGroupLayout: use the
      //     `fillPipelineGroundOverride` the caller built for THIS
      //     variant (matches layout). When that's absent (very old
      //     caller / test stub), fall back to `fillPipeline` and
      //     accept depth-write — better z-fighting than a layout
      //     mismatch that drops the whole encoder.
      const groundIsBase = bindGroupLayout === this.baseBindGroupLayout
      // ?debug=overdraw: VTR's internal `fillPipelineGround` targets the
      // swapchain format, but the caller's `fillPipelineGroundOverride`
      // is the r16float debug variant. Always prefer the override here
      // so the entire opaque pass agrees on the r16float attachment.
      const groundForLayout: GPURenderPipeline | null = DEBUG_OVERDRAW
        ? (fillPipelineGroundOverride ?? fillPipeline)
        : (groundIsBase
            ? this.fillPipelineGround
            : (fillPipelineGroundOverride ?? null))
      const mainFill = this.currentExtrudeMode === 'none' && groundForLayout !== null
        ? groundForLayout
        : fillPipeline
      this.renderTileKeys(neededKeys, pass, mainFill, linePipeline, projCenterLon, projCenterLat, worldOffDeg, lineLayerOffset, phase, layerCache, this.fillPipelineExtruded, bindGroupLayout, translucentBucket)
    }

    // Render fallback ancestors (stencil test) — with world offsets for wrapping
    if (fillPipelineFallback && fallbackKeys.length > 0) {
      // Sort ascending by z (smallest-z first → deepest-z last). Where
      // multiple z-level parents overlap in screen space (z=11 parent
      // covers area that z=14 parent also covers), the deepest z draws
      // last and wins LEQUAL fragment competition. Without this the
      // simpler-geometry parent could occlude the more-detailed one
      // depending on fallbackKeys insertion order.
      //
      // No dedup: an earlier commit (004af0f) deduped by (key, offset)
      // tuple so identical parent renders ran ONCE instead of N times.
      // That was correct under the old binary stencil model where every
      // render of the same parent produced identical pixels. Reverted
      // here because the per-tile stencil clip mask (follow-up commit)
      // makes each push render with a DIFFERENT visible-tile clip area —
      // each push corresponds to a unique visible-tile fallback fill, so
      // dedup'ing them would erase coverage of N-1 visible tiles.
      if (fallbackKeys.length > 1) {
        const indexed: { k: number; o: number; vk: number; z: number }[] = []
        for (let i = 0; i < fallbackKeys.length; i++) {
          const k = fallbackKeys[i]
          // Extract z from tileKey: tileKey = 4^z + morton(x,y).
          let z = 0
          while (Math.pow(4, z + 1) <= k) z++
          indexed.push({ k, o: fallbackOffsets[i], vk: fallbackVisibleKeys[i], z })
        }
        indexed.sort((a, b) => a.z - b.z)
        fallbackKeys = indexed.map(c => c.k)
        fallbackOffsets = indexed.map(c => c.o)
        fallbackVisibleKeys = indexed.map(c => c.vk)
      }
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
      // Same layout-matched ground pickup as the primary path —
      // base layout uses the renderer-level fallback ground; feature
      // layout uses the variant's fallback ground override.
      const fallbackGroundIsBase = bindGroupLayout === this.baseBindGroupLayout
      const fallbackGroundForLayout: GPURenderPipeline | null = DEBUG_OVERDRAW
        ? (fillPipelineGroundFallbackOverride ?? fillPipelineFallback ?? null)
        : (fallbackGroundIsBase
            ? this.fillPipelineGroundFallback
            : (fillPipelineGroundFallbackOverride ?? null))
      const fallbackFill = this.currentExtrudeMode === 'none' && fallbackGroundForLayout !== null
        ? fallbackGroundForLayout
        : fillPipelineFallback
      this.renderTileKeys(fallbackKeys, pass, fallbackFill, linePipelineFallback!, projCenterLon, projCenterLat, fallbackOffsets, lineLayerOffset, phase, layerCache, this.fillPipelineExtrudedFallback, bindGroupLayout, translucentBucket, fallbackVisibleKeys)
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
              canvasWidth, canvasHeight, offsetMarginPx, dpr,
            )
          : visibleTilesFrustum(
              camera, selectorProj, prefetchZ,
              canvasWidth, canvasHeight, offsetMarginPx, dpr,
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
    if (fallbackKeys.length > 0 || protectedAncestors.length > 0) {
      const merged = this._scratchMergedStableKeys
      merged.clear()
      for (const k of neededKeys) merged.add(k)
      for (const k of fallbackKeys) merged.add(k)
      // Selector-injected fallback-only ancestors (currently the
      // high-pitch parent inject) — protected from eviction so they
      // stay resident and the eviction-driven foreground ancestor-
      // block regression doesn't reappear under the mobile cap.
      for (const k of protectedAncestors) merged.add(k)
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
      pointRenderer.flushTilePoints(pass, camera, projType, projCenterLon, projCenterLat, canvasWidth, canvasHeight, show, dpr)
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
    fillPipelineExtruded: GPURenderPipeline | null,
    fillBindGroupLayout: GPUBindGroupLayout,
    /** Same disambiguation as the public render() — `'strokes'`
     *  phase is reused by both the offscreen translucent pass and
     *  the opaque-bucket OIT-extrude post-pass; the caller tells
     *  us which so we pick `pipelineMax` (no-depth offscreen) vs
     *  `pipeline` (regular depth-bearing). */
    translucentBucket: boolean = false,
    /** When provided (fallback path), index-parallel to `keys`. Each
     *  entry is the VISIBLE tile this fallback render is filling for
     *  — its mercator bounds become the per-tile clip mask written to
     *  uniform `clip_bounds` so the fallback parent's geometry is
     *  clipped to the visible tile's screen area. When null (primary
     *  path), the sentinel "-1e30" is written and the fragment shader
     *  skips the discard test. */
    visibleKeysForClip: number[] | null = null,
  ): void {
    const drawFills = phase !== 'strokes'
    const drawStrokes = phase !== 'fills' && phase !== 'oit-fill'
    // `phase === 'strokes'` reaches us from two passes — the
    // translucent offscreen MAX-blend pass (no depth) and the
    // opaque OIT-extrude post-pass (with depth). Use the caller's
    // explicit `translucentBucket` to pick the right line pipeline;
    // the offscreen one (`pipelineMax`) is incompatible with a
    // depth-bearing pass and trips frame validation otherwise.
    const translucentLines = phase === 'strokes' && translucentBucket
    const isOitFill = phase === 'oit-fill'
    // Pick the bind group whose layout matches the FILL pipeline's
    // expected layout. Two pitfalls the previous `feature ?? default`
    // rule failed to handle in mixed-layer sources:
    //
    //   • Variant pipeline expects featureBindGroupLayout (data-driven
    //     match()/interpolate()) but featureDataBuffer hasn't been
    //     uploaded yet → tileBgFeature is null → the old guard at
    //     line ~1130 returns early. Still correct.
    //   • Variant pipeline expects baseBindGroupLayout (constant
    //     fill — water singleton in osm_style) but a SIBLING layer
    //     in the same source already created tileBgFeature →
    //     tileBgFeature is non-null → old rule chose feature BG →
    //     2-binding BG against 1-binding pipeline → validation
    //     error "Bind group layout of pipeline layout does not match
    //     layout of bind group set at group index 0", encoder.finish()
    //     fails, NOTHING renders. This was the osm_style demo break.
    //
    // Lines always use baseBindGroupLayout (assertion further below
    // is preserved). Strokes get the same uniform-only layout via
    // currentLineTileBg.
    const fillBg = fillBindGroupLayout === this.baseBindGroupLayout
      ? this.tileBgDefault
      : this.tileBgFeature
    // For featureBindGroupLayout the source-level `tileBgFeature` is
    // null in the MVT/PMTiles path (each tile owns its own
    // featureBindGroup). Don't early-return on that case — per-tile
    // bind group resolution happens inside the keys loop. baseBindGroup
    // is constant-fill and never per-tile, so its absence still aborts.
    if (fillBindGroupLayout === this.baseBindGroupLayout && !fillBg) return
    if (!this.uniformRing) return
    // Stroke draws are batched and emitted AFTER every fill in this
    // pass has written depth, so per-tile outlines depth-test against
    // the layer's full geometry (not just whatever was drawn before
    // this tile in the per-tile loop). Without this, an extruded
    // building's roof outline would get overwritten by a later tile's
    // wall fill at the same pixel.
    const strokeQueue: { cached: GPUTile; slotOffset: number }[] = []
    for (let ki = 0; ki < keys.length; ki++) {
      const key = keys[ki]
      // For world copies: allow same key to render at different positions
      const worldOff = worldOffsets?.[ki] ?? 0
      // In fallback dispatch the same parent tile renders separately for
      // each visible child — each draw needs its own clip_bounds. Without
      // the visibleKey component the dedup folded all four (parent, visible)
      // pairs into the first one, so 3 of 4 visible tiles silently
      // skipped (Korea fill-drop bug, 2026-05-10): only the first
      // dispatch's clip_bounds rect actually let any fragment through.
      const visibleKey = visibleKeysForClip?.[ki] ?? -1
      const drawKey: number | string = visibleKey >= 0
        ? `${key}:${worldOff}:${visibleKey}`
        : worldOff === 0 ? key : key + worldOff * 1000000
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
      // clip_bounds (40-43) — per-tile mercator clip rect (west,
      // south, east, north). When `visibleKeysForClip` is provided
      // (fallback path), each draw clips to the visible tile it's
      // FILLING for — a parent z=11 ancestor rendered for a missing
      // z=15 child only draws within the z=15 child's mercator
      // extent, instead of overflowing into adjacent z=15 tiles
      // that have their OWN buildings. Sentinel west=-1e30 means
      // "no clip" for the primary path (fragment shader skips the
      // discard test).
      // Skip per-tile clip when the parent is z=0 root: at that
      // zoom the tile's data covers the WHOLE world, and the visible-
      // tile-selector's habit of returning only one z=1 child (e.g.
      // SE quadrant) at low camera zoom would clip the parent to
      // that quadrant — visible symptom: hero map shows only Africa
      // + Australia. Skipping the clip lets the parent render the
      // entire world for every visible-key fallback at z=0 (some
      // overdraw, but visually correct). The clip mechanism remains
      // active for higher-zoom fallback (z>0 parents do NOT contain
      // adjacent visible tiles' data so cross-tile spill is real).
      const parentIsRoot = cached.tileZoom === 0
      if (visibleKeysForClip && !parentIsRoot) {
        const visibleKey = visibleKeysForClip[ki]
        const [vz, vx, vy] = tileKeyUnpack(visibleKey)
        const vn = Math.pow(2, vz)
        const vWestLon = (vx / vn) * 360 - 180 + worldOff
        const vEastLon = ((vx + 1) / vn) * 360 - 180 + worldOff
        const vNorthLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * vy / vn))) * 180 / Math.PI
        const vSouthLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (vy + 1) / vn))) * 180 / Math.PI
        this.uniformF32[40] = Math.fround(vWestLon * DEG2RAD * R)
        this.uniformF32[41] = Math.fround(Math.log(Math.tan(Math.PI / 4 + clampLat(vSouthLat) * DEG2RAD / 2)) * R)
        this.uniformF32[42] = Math.fround(vEastLon * DEG2RAD * R)
        this.uniformF32[43] = Math.fround(Math.log(Math.tan(Math.PI / 4 + clampLat(vNorthLat) * DEG2RAD / 2)) * R)
      } else {
        // Sentinel: no clip. Fragment shader's `clip_bounds.x > -1e29`
        // gate skips the discard test entirely.
        this.uniformF32[40] = -1e30
        this.uniformF32[41] = 0
        this.uniformF32[42] = 0
        this.uniformF32[43] = 0
      }

      // zoom (44) — per-frame camera zoom. Read by the palette
      // gradient sample (P3 Step 3c): the variant shader maps
      // (zoom - zMin) / span into the gradient atlas's U coord. The
      // surrounding 3 floats (45-47) are struct alignment padding
      // and stay zero. Total uniform struct size = 192 bytes
      // (UNIFORM_SIZE constant above). `this.lastZoom` is the cached
      // frame zoom set by VTR.render's caller before renderTileKeys
      // dispatches — camera isn't in this closure's scope.
      this.uniformF32[44] = this.lastZoom
      this.uniformF32[45] = 0
      this.uniformF32[46] = 0
      this.uniformF32[47] = 0

      // Allocate a fresh ring slot for this tile × layer × world-copy draw.
      const slotOffset = this.allocUniformSlot()
      // allocUniformSlot may have grown the ring → tileBgDefault /
      // tileBgFeature were rebuilt; re-resolve fillBg against the
      // FILL pipeline's layout (set by render() caller). Lines always
      // use baseBindGroupLayout, so currentLineTileBg is always the
      // default BG.
      //
      // For the feature-pipeline path prefer the tile-owned bind group
      // when present (MVT/PMTiles per-tile featureDataBuffer). The
      // source-level `this.tileBgFeature` is the GeoJSON path's
      // global-PropertyTable bind group; using it for MVT would index
      // a different (zero-filled) buffer and silently mis-route every
      // feature to the variant shader's fallback arm.
      const currentTileBg = fillBindGroupLayout === this.baseBindGroupLayout
        ? this.tileBgDefault!
        : (cached.featureBindGroup ?? this.tileBgFeature!)
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
        // Pipeline selection — three opaque paths + OIT:
        //  * 'oit-fill' phase: translucent extrude → OIT MRT pipe
        //  * per-feature extrude (opaque): vs_main_quantized_extruded + zBuffer
        //  * uniform / ground (opaque): pre-selected `fillPipeline`
        const useOitPipe = isOitFill
          && cached.zBuffer !== null
          && this.fillPipelineExtrudedOIT !== null
        // DIAG: log per-tile drawIndexed for the current trace if armed.
        // Granular enough to verify the cross-tile order claim
        // ("all tiles' 2D before any 3D") rather than just per-show
        // sequencing. Pipeline decision is computed below — if the
        // trace is armed we record the routing here for diagnosis.
        if (typeof window !== 'undefined') {
          const trace = (window as unknown as { __xgisDrawOrderTrace?: Array<{
            seq: number; slice: string; phase: string; extrude: string;
            tileKey?: number; isFill?: boolean;
            pipelineRoute?: 'oit' | 'extrude' | 'fill' | 'skip';
            hasZBuffer?: boolean;
          }> }).__xgisDrawOrderTrace
          if (trace) {
            // Pipeline route is determined a few lines below — but the
            // logic is mirrored here so we can record it before
            // dispatch. Skip path: OIT requested but useOitPipe failed.
            const willSkip = isOitFill && !useOitPipe
            const route: 'oit' | 'extrude' | 'fill' | 'skip' =
              willSkip ? 'skip'
              : useOitPipe ? 'oit'
              : (this.currentExtrudeMode === 'per-feature' && cached.zBuffer !== null)
                ? 'extrude'
                : 'fill'
            trace.push({
              seq: trace.length,
              slice: this.lastTraceSlice ?? '?',
              phase: this.lastTracePhase ?? '?',
              extrude: this.currentExtrudeMode === 'none' ? 'none' : 'feature',
              tileKey: key,
              isFill: true,
              pipelineRoute: route,
              hasZBuffer: cached.zBuffer !== null,
            })
          }
        }
        // CRITICAL: in the OIT pass, the render pass attachments are
        // the rgba16float / r16float MRT pair, not the main color +
        // pick attachments. Falling through to `fillPipeline` here
        // would attach an OPAQUE-targets pipeline to the OIT pass and
        // trip "Attachment state of RenderPipeline is not compatible
        // with RenderPassEncoder" at every frame's submit. This used
        // to fire when (a) cached.zBuffer was null on a fallback
        // ancestor tile of an extruded slice or (b) setOITPipeline
        // hadn't run yet. Either way: skip the draw rather than
        // emit an incompatible pipeline. Visual cost: a translucent
        // building's loading frames may show no fallback ancestor
        // until the primary tile arrives — minor and transient.
        if (isOitFill && !useOitPipe) {
          // strokes for this tile still queue below — only the fill
          // is being skipped here.
          if (drawStrokes) strokeQueue.push({ cached, slotOffset })
          continue
        }
        // OPAQUE extrude variant of the same skip rule: when the show
        // declares per-feature extrude but THIS tile's slice was
        // compiled without a zBuffer (e.g., a fallback parent slice
        // uploaded before the extrude show wired its per-feature
        // heights, or a parent tile whose worker compile predated the
        // per-feature config), falling through to `fillPipeline` would
        // render the polygons FLAT at z=0 — producing the user-visible
        // "tile-boundary building height mismatch" bug where a child
        // tile's 3D building meets a flat-projected fallback polygon.
        // The flat polygon depth-tests against the 3D one and wins or
        // loses unpredictably depending on pitch / camera angle. Skip
        // instead: showing no fallback building briefly is far less
        // visually broken than showing a flat one. Strokes still draw.
        const wantsExtrude = !isOitFill
          && this.currentExtrudeMode === 'per-feature'
          && fillPipelineExtruded !== null
        if (wantsExtrude && cached.zBuffer === null) {
          if (drawStrokes) strokeQueue.push({ cached, slotOffset })
          continue
        }
        const useExtrudedPipe = !isOitFill
          && this.currentExtrudeMode === 'per-feature'
          && cached.zBuffer !== null
          && fillPipelineExtruded !== null
        // Debug=overdraw: collapse OIT + extruded paths onto the
        // single overdraw pipeline supplied as `fillPipeline`. The
        // OIT / extruded variants target their own formats which
        // don't match the r16float accumulator attached to this pass.
        const activePipe = DEBUG_OVERDRAW
          ? fillPipeline
          : (useOitPipe
              ? this.fillPipelineExtrudedOIT!
              : useExtrudedPipe
                ? fillPipelineExtruded!
                : fillPipeline)
        pass.setPipeline(activePipe)
        pass.setBindGroup(0, currentTileBg, [slotOffset])
        pass.setVertexBuffer(0, cached.vertexBuffer)
        if (useOitPipe || useExtrudedPipe) pass.setVertexBuffer(1, cached.zBuffer!)
        pass.setIndexBuffer(cached.indexBuffer, 'uint32')
        pass.drawIndexed(cached.indexCount)
      }

      // Strokes (polygon outlines + line features) deferred to a
      // SECOND pass after every fill in this layer has written depth.
      // With per-tile interleaving (fill→stroke→next-tile-fill) the
      // outline of an earlier tile gets clobbered by a later tile's
      // fill at coplanar / overlapping pixels — DEPTH_READ_ONLY lines
      // don't write depth, so subsequent extruded fills run depth-
      // test against the last fill's depth (not the line's), then
      // overwrite the outline color. Recording the slot offset here
      // lets the deferred stroke pass reuse the same uniform slot
      // without re-doing the per-tile bind-group setup.
      if (drawStrokes && this.lineRenderer
          && (cached.outlineSegmentCount > 0 || cached.lineSegmentCount > 0)) {
        strokeQueue.push({ cached, slotOffset })
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
    // Second pass: emit every queued stroke draw now that all fills
    // for this layer have written depth. Outline + line-feature
    // drawSegments calls run against the layer's complete depth
    // buffer; with DEPTH_READ_ONLY they don't disturb later layers'
    // depth tests, but their occlusion against THIS layer's own
    // 3D geometry is now correct regardless of tile iteration order.
    if (strokeQueue.length > 0 && this.lineRenderer) {
      const currentLineTileBg2 = this.tileBgDefault!
      for (let i = 0; i < strokeQueue.length; i++) {
        const { cached, slotOffset } = strokeQueue[i]
        if (cached.outlineSegmentCount > 0 && cached.outlineSegmentBindGroup) {
          this.lineRenderer.drawSegments(pass, currentLineTileBg2, cached.outlineSegmentBindGroup, cached.outlineSegmentCount, slotOffset, lineLayerOffset, translucentLines)
        }
        if (cached.lineSegmentCount > 0 && cached.lineSegmentBindGroup) {
          this.lineRenderer.drawSegments(pass, currentLineTileBg2, cached.lineSegmentBindGroup, cached.lineSegmentCount, slotOffset, lineLayerOffset, translucentLines)
        }
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
        this.releaseBuffer(tile.zBuffer)
        this.releaseBuffer(tile.lineVertexBuffer)
        this.releaseBuffer(tile.lineIndexBuffer)
        this.releaseBuffer(tile.outlineIndexBuffer)
        // SDF segment buffers are owned by lineRenderer's path;
        // keep destroying directly. Same for per-tile feature data —
        // not pool-friendly because its size depends on each tile's
        // unique feature count + variant schema.
        tile.outlineSegmentBuffer?.destroy()
        tile.lineSegmentBuffer?.destroy()
        tile.featureDataBuffer?.destroy()
        inner.delete(ev.tk)
        this._gpuCacheCount--
      }
    }
  }
}

