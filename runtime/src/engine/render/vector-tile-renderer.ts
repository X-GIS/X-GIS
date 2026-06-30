// ═══ Vector Tile Renderer (GPU Layer) ═══
// Renders vector tiles from a TileCatalog to WebGPU.
// Data loading/caching/sub-tiling is handled by TileCatalog.
// This class manages GPU buffers, bind groups, and draw calls only.

import type { GPUContext } from '../gpu/gpu'
import { DEBUG_OVERDRAW } from '../debug-flags'
import { Camera } from '../projection/camera'
import type { ShowCommand } from './renderer'
import { variantProducesFill } from './renderer-helpers'
import { polygonUniformSlots, polygonUniformBytes, polygonUniformStride } from './polygon-uniform-slots'
import { writeFrameProjectionUniform } from './frame-projection-uniform'
import { xlog } from '../log'
import { markStart as perfMarkStart, markEnd as perfMarkEnd } from '../__profile__/perf-marks'
import { recordFillDraw, type FillRhiState } from './material/polygon-fill-material'

// f32 slot indices of the polygon 'Uniforms' struct, sourced from reflect() of the SAME
// IR the shader is emitted from (NOT hand-coded magic numbers — those silently drift from
// the DSL struct). The CPU Float32Array packer (`this.uniformF32[...]` / `uf[...]` below)
// writes at US.<field>; a struct change reflows these mechanically. See polygon-uniform-slots.ts.
//
// LAZY: polygonUniformSlots() builds + reflects the polygon module, which needs
// configureProjections() to have run (projection-injection) — NOT true at module-load time.
// A memoising Proxy defers the reflect() to the first `US.<field>` read (a render, post-init);
// the slot map resolves once + caches, so the 73 packer sites stay plain `US.<field>`.
let _uSlots: Readonly<Record<string, number>> | null = null
const US = new Proxy({} as Record<string, number>, {
  get: (_t, k: string) => (_uSlots ??= polygonUniformSlots().slot)[k],
})
import type { ResolvedShow } from './resolved-show'
import { structuralHashKey } from '../_cache/structural-key'
import type { BundleKeyState } from '../_cache/bundle-cache-key'
import {
  classifyTile, computeProtectedKeys, computeZoomDirectionPrefetchKeys,
  type TileDecision,
} from '../tile-decision'
import { PrefetchScheduler } from './prefetch-scheduler'
import { LabelFeatureSource } from './label-feature-source'
import { FrameDrawStats } from './frame-draw-stats'
import { TileSelectionCache } from './tile-selection-cache'
import { FeatureDataBinder } from './feature-data-binder'
import { GpuTileStore } from './gpu-tile-store'
import { BindGroupRegistry } from './bind-group-registry'
import {
  generateWallMeshExtrudedECEF,
} from '../../core/polygon-mesh'
import { tileKeyParent, tileKeyUnpack, type PropertyTable } from '@xgis/compiler'
import { StagingBufferPool, asyncWriteBuffer } from '../gpu/staging-buffer-pool'
import { GPUArena } from '../gpu/gpu-arena'
import { BundleCache, type BundleEncodeDescriptor } from './bundle-cache'
import { isPickEnabled, getSampleCount } from '../gpu/gpu'
import { WORLD_MERC, TILE_PX } from '../gpu/gpu-shared'
import { PriorityQueue, PriorityQueueItemRemovedError } from '../../core/priority-queue'
import type { ShaderVariant } from '@xgis/compiler'
import type { TileCatalog } from '../../data/tile-catalog'
import type { TileData } from '../../data/tile-types'
import { computeSliceKey } from '../../data/eval/filter-eval'
import { mercator as mercatorProj, getProjection, type Projection } from '../projection/projection'
import { SELECTOR_PROJ_NAMES } from '../projection/projections-table'
import type { PointRenderer } from './point-renderer'
import { buildLineSegments, type LineRenderer } from './line-renderer'
import { parseHexColor } from '../feature-helpers'
import type { GPUTile, LayerDrawPhase } from './vector-tile-renderer-types'
import { getMaxGpuTiles, uploadBudgetFor } from './vector-tile-renderer-helpers'
import { UniformRing } from './uniform-ring'

// projType (camera.projType / proj_params.x) → projection registry name,
// for building the projection-aware `selectorProj`. Index 0 (mercator) and
// 7 (globe) are handled separately (globe has no flat-projection entry).
// Derived from the single-source PROJECTIONS table (excludes globe).

// ═══ Types ═══

// Type/interface declarations live in vector-tile-renderer-types.ts.
// `LayerDrawPhase` is part of the public module surface, so it is
// re-exported here to keep imports of `./vector-tile-renderer` working
// unchanged. It is also imported above so the in-body parameter
// annotations can reference it (a bare `export type { … } from` only
// re-exports — it does not bind the name in local scope).
// `GPUTile` is internal-only (imported above).
export type { LayerDrawPhase }

// GPU tile cache caps + per-frame upload budget helpers
// (getMaxGpuTiles / uploadBudgetFor) live in
// vector-tile-renderer-helpers.ts and are imported above.

// ═══ Renderer ═══

// Polygon Uniforms byte size / dynamic-offset stride are read LAZILY via
// polygonUniformBytes() / polygonUniformStride() (memoised) at ctor/draw time —
// NOT module-level `const`s. polygonUniformBytes() reflects the polygon module =
// a projection emit, which throws until configureProjections() has run (post-GPU-
// init); a module-level const evaluated at IMPORT and crashed the whole map init
// ("configureProjections() must be called before any projection emit"). The bind
// range must be ≥ every shader that reads binding 0 (polygon, line, raster).

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

/** Mapbox `*-translate-anchor`: viewport (default) returns the [dx,dy]
 *  CSS-px offset unchanged (screen-space, historical behaviour); map
 *  rotates it by the map bearing so it tracks the MAP world axes
 *  (MapLibre map-anchor). Pure 2D rotation; no allocation when the
 *  offset is zero or anchor is viewport. */
export function rotateTranslateForAnchor(
  dx: number, dy: number, anchorMap: boolean | undefined, bearingDeg: number,
): [number, number] {
  if (!anchorMap || (dx === 0 && dy === 0)) return [dx, dy]
  const r = (bearingDeg * Math.PI) / 180
  const c = Math.cos(r), s = Math.sin(r)
  return [dx * c - dy * s, dx * s + dy * c]
}

// Polygon extruded wall + roof mesh generation lives in core/
// polygon-mesh.ts so the math is unit-testable independent of GPU
// state. See `generateWallMeshExtrudedECEF`. (The Mercator-DSFUN
// `quantizePolygonVertices*` + `generateWallMesh*` paths were retired
// in Phase 2 PR 2c.2 — tile vertices arrive as ECEF-DSFUN stride-9
// floats from the compiler tiler and upload directly.)

export class VectorTileRenderer {
  private device: GPUDevice
  private source: TileCatalog | null = null

  /** Max tile level of the backing source (0 if none), for camera zoom
   *  clamping in the render loop. */
  get sourceMaxLevel(): number {
    return this.source?.maxLevel ?? 0
  }
  currentProjection: import('../projection/projection').Projection | null = null
  /** Resident GPU tile set (Cluster A — the memory core): the nested
   *  `${tileKey}|${sourceLayer}` cache map, the three GPUArenas (poly
   *  vertex / poly index / z-buffer), the pooled GPU buffer recycler, the
   *  unique-key + byte-aware LRU eviction (#218 fix), the OOM Lane-B forced
   *  eviction, and the deferred post-submit arena compaction. VTR holds it
   *  as an injected collaborator and keeps thin forwarders for the external
   *  surface (`getCacheSize`); the uploader (Cluster B) + the render hot
   *  loop call THROUGH it. The store holds NO VTR back-reference —
   *  `stableKeys` (E) + the compute-handle release hook (D, bound to
   *  `_featureBinder.releaseTile`) + the upload-active probe (B) arrive as
   *  call arguments. */
  private readonly _store: GpuTileStore
  /** Base bind-group + fill-pipeline resource registry (Cluster C — the
   *  "thin-C" final decomposition unit). Owns the two source-level bind
   *  groups (`tileBgDefault`/`tileBgFeature`), the base bind-group layout,
   *  the palette/sprite atlas views/sampler, the bind-group rebuild epoch,
   *  and ALL fill-pipeline field pairs + their setters. VTR keeps thin
   *  forwarders for the external setter surface (renderer.ts/map.ts/
   *  source-manager.ts/render-loop.ts) and coordinates the onGrow
   *  single-trigger fan-out (base rebuild then per-tile rebuild). The
   *  registry holds NO reference to VTR/FeatureDataBinder/GpuTileStore —
   *  it receives the uniform-ring buffer + feature layout + feature data
   *  buffer as `rebuildBase` call arguments. Constructed in the constructor
   *  (after `this.device` is assigned). */
  private readonly _bindGroups: BindGroupRegistry
  /** The Cluster-D compute-handle release hook handed to the store's
   *  eviction path (the `7b31ce52` free order). A single pre-bound arrow
   *  so the store never imports FeatureDataBinder nor holds a VTR
   *  reference, and eviction never allocates a fresh closure per call. */
  private readonly _releaseTileHook = (handleKey: string): void => {
    this._featureBinder.releaseTile(handleKey)
  }
  private getLayerCache(sourceLayer: string): Map<number, GPUTile> | undefined {
    return this._store.getLayer(sourceLayer)
  }
  private getOrCreateLayerCache(sourceLayer: string): Map<number, GPUTile> {
    return this._store.getOrCreateLayer(sourceLayer)
  }
  /** Back-compat read-only view of the resident GPU tile cache for the
   *  browser-injected e2e leak/hit-rate probes (`_pmtiles-stress-leak`,
   *  `_continuous-wheel-zoom`, `_mobile-overdraw-flat-pitch`,
   *  `_osm-style-merge-proof`, `_user-scenario-capture`,
   *  `_openfreemap-bright-overzoom`) that read `renderer.gpuCache`
   *  (`.get`/`.size`/`.values`). The cache itself moved onto the
   *  GpuTileStore (Cluster A); this getter forwards the live Map so those
   *  probes keep working unchanged. No production hot-loop reads this — the
   *  per-tile loop hoists the inner Map via `getLayerCache` once/frame. */
  get gpuCache(): Map<string, Map<number, GPUTile>> {
    return this._store.cache()
  }
  private frameCount = 0
  private lastZoom = -1
  /** Continuous camera.zoom cached by render() for slot 44 (u.zoom).
   *  Distinct from lastZoom (integer tile-selection zoom) so polygon
   *  zoom-interp fills + palette gradients interpolate, not snap. */
  private currentCameraZoom = 0
  private stableKeys: number[] = []
  /** Per-frame visible-tile selection + zoom-transition hysteresis +
   *  readiness gate (Cluster E-selection). Owns `_frameTileCache`, the
   *  cross-frame `_hysteresisZ`/`_czPendingAdvance` state, the
   *  camera-idle snapshot, the gate SSE memo, and the selection-only
   *  hot-path scratch arrays. Touches ZERO GPU state — VTR calls
   *  `selectForFrame` once per render() and consumes the returned
   *  Selection; `stableKeys` stays on VTR (read by eviction + labels). */
  private readonly _selection = new TileSelectionCache()
  /** Speculative prefetch routes (sibling-of-visible + pan-direction
   *  speculation). Owns the frame-stable camera snapshot that the
   *  velocity-vector projection depends on; updated exactly once per
   *  frame inside `pumpPrefetch`. */
  private readonly prefetchScheduler = new PrefetchScheduler()
  /** CPU label-feature extraction (Cluster F). Owns the label scratch
   *  collections + line-label run cache + per-frame FrameArena. VTR
   *  keeps thin forwarders (forEachLabelFeature etc.) so callers are
   *  unchanged; this collaborator touches ZERO GPU state. */
  private readonly _labelSource = new LabelFeatureSource()
  private readonly _drawStats = new FrameDrawStats()
  /** Pooled GPU buffer acquire/release — thin forwarders to the
   *  GpuTileStore (Cluster A owner). The pool keyed by
   *  `{powerOfTwoBucketSize}:{usage}` lives on the store; doUploadTile +
   *  eviction hand freed line/outline buffers straight back to the next
   *  acquire instead of round-tripping through the GPU driver. */
  private acquireBuffer(size: number, usage: GPUBufferUsageFlags, label: string): GPUBuffer {
    return this._store.acquireBuffer(size, usage, label)
  }
  private releaseBuffer(buf: GPUBuffer | null | undefined): void {
    this._store.releaseBuffer(buf)
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
  /** iter-255 (Plan AAA A.2) — per-frame scratch array for the
   *  `_tileDecisions` diagnostic. Same `.length = N` reset pattern
   *  as iter-254 parentAtMaxLevel. */
  private readonly _scratchTileDecisions: (string | undefined)[] = []
  // Sized to UNIFORM_SIZE (= WGSL Uniforms struct size). Shrunk from
  // 256 → 192 in PR 2d.5 closeout when the legacy Mercator `mvp` slot
  // was retired (the surviving `mvp` slot IS the ECEF-MVP).
  // Out-of-bounds typed-array writes are silent no-ops in JS, so a
  // mismatch here = uniform never reaches the GPU = shader reads
  // garbage at the new offset. Keep this in lockstep with WGSL.
  private uniformDataBuf = new ArrayBuffer(polygonUniformBytes())
  private uniformF32 = new Float32Array(this.uniformDataBuf) // reusable view over full uniform
  /** Reusable u32 view over the same uniform buffer — used to write
   *  `pick_id` (u32). After PR 2d.5 closeout the field sits at f32 slot
   *  36 (byte offset 144) — shifted -16 by the legacy mvp removal. */
  private uniformU32 = new Uint32Array(this.uniformDataBuf)
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
  /** Mapbox `fill-extrusion-base` wall-bottom z (metres). Default 0
   *  matches a flat-base building flush with z=0. Constant form
   *  (show.extrudeBase.kind === 'constant') pulls the value; feature
   *  form falls back to the constant `fallback` for the uniform
   *  mirror (per-feature base would require a second vertex
   *  attribute, deferred). */
  private currentExtrudeBase = 0
  /** Mapbox fill-translate — pre-baked from CSS px to NDC-per-pixel.
   *  Set at render() time when show.fillTranslateX/Y are non-zero
   *  using the current canvasWidth/Height. The vertex shader
   *  multiplies by clip.w so the screen-space offset stays
   *  pixel-constant regardless of depth. 0 = no translate (default). */
  private currentFillTranslateNdcX = 0
  private currentFillTranslateNdcY = 0
  /** Mapbox line-translate — pre-baked from CSS px to NDC-per-pixel.
   *  Set at render() time when show.strokeTranslateX/Y are non-zero.
   *  Passed to writeLayerSlot → packed into line uniform buf[47/48]. */
  private currentStrokeTranslateNdcX = 0
  private currentStrokeTranslateNdcY = 0
  /** Mapbox fill-antialias / fill-extrusion-vertical-gradient opt-out
   *  flags, baked per-show in render() and packed into the polygon
   *  uniform's spare cam_ecef_off_{h,l}.w lanes (f32 55 / 59). 1 =
   *  current behavior (default), 0 = the feature is disabled. Float (not
   *  bool) because the slot is an f32 the WGSL reads via `!= 0`. */
  private currentFillAntialias = 1
  private currentFillVerticalGradient = 1
  /** WS-9 — top-level fill-extrusion light, pushed each frame from the
   *  render loop (host._light). Defaults = MapLibre/Mapbox default so an
   *  untouched renderer is byte-identical to the pre-WS-9 baked consts.
   *  position = [radius, azimuth°, polar°] (Mapbox spec); the packer
   *  converts it to an (East,North,Up) direction then rotates into ECEF by
   *  the camera-anchor basis (same path the old fixed light used). */
  private _lightPosition: [number, number, number] = [1.15, 210, 30]
  private _lightIntensity = 0.5
  private _lightColor: [number, number, number] = [1, 1, 1]
  /** iter-183 — fill-pattern Stage 2 per-show flag. Set true when the
   *  current `render()` call's show has a resolved pattern UV bbox +
   *  the pattern pipeline is wired. Per-tile uniform writes use this
   *  to decide whether slot 46/47 carries fill-translate NDC values
   *  or the pattern repeat in Mercator metres. */
  private _patternUniformActive = false
  private _patternRepeatMX = 1
  private _patternRepeatMY = 1
  /** iter-185 — line-pattern Stage 2 per-show flag. True when the
   *  current `render()` call's show has a resolved line-pattern UV
   *  bbox + repeat AND lineRenderer is wired. Read by the deferred
   *  drawSegments() pass to route through `pipelinePattern`. */
  private _linePatternActiveForShow = false
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
  private uniformRing: UniformRing | null = null
  // The two source-level tile bind groups (`tileBgDefault` /
  // `tileBgFeature`) live on the BindGroupRegistry (Cluster C); read via
  // `_bindGroups.baseGroup()` / `.featureGroup()` in the hot loop.

  // SDF line renderer (set externally)
  private lineRenderer: LineRenderer | null = null

  // P1.6 — the polygon flat-fill RHI Material twins + the native pipeline refs they map to (set once
  // from PipelineFactory). recordFillDraw consumes it behind __xgisVtrFillViaRhi.
  private _fillRhi: FillRhiState | null = null
  setFillRhi(state: FillRhiState | null): void { this._fillRhi = state }

  /** Data-driven feature buffer + per-tile feature bind groups + compute
   *  paint (Cluster D). Owns `featureDataBuffer`, the captured
   *  `latestVariant*` schema, the per-tile `ComputeLayerHandle` lifetime,
   *  and the `featureBindGroupLayout`. VTR keeps thin forwarders
   *  (`buildFeatureDataBuffer`/`setComputePlan`/`dispatchComputePass`/
   *  `hasFeatureData`) for external callers; the per-tile rebuild
   *  (`rebuildPerTileGroups`) is CALLED by `_onUniformRingGrow` (the
   *  single `UniformRing.onGrow` fan-out, base→per-tile) — the binder never
   *  registers its own onGrow nor references VTR/gpuCache (they arrive as
   *  call args).
   *  Constructed in the constructor (after `this.device` is assigned). */
  private readonly _featureBinder: FeatureDataBinder

  // Per-frame draw stats + diagnostics + dedup + trace stash live on the
  // FrameDrawStats collaborator (Cluster G). See `_drawStats` above.
  // The fill-pipeline field pairs (extruded / ground / OIT / pattern) +
  // their setters live on the BindGroupRegistry (Cluster C). See
  // `_bindGroups` above + the thin forwarders below.

  constructor(ctx: GPUContext) {
    this.device = ctx.device
    this.format = ctx.format
    this.stagingPool = new StagingBufferPool(ctx.device)
    this.bundleCache = new BundleCache(ctx.device)
    this._featureBinder = new FeatureDataBinder(ctx.device)
    this._store = new GpuTileStore(ctx.device)
    this._bindGroups = new BindGroupRegistry(ctx.device)
  }

  /** iter-218 (Phase RB.B.6) — swapchain color format. Captured from
   *  the GPUContext so bundle descriptors can declare the correct
   *  color attachment format. */
  private format: GPUTextureFormat
  /** iter-218 — per-show RenderBundle cache. Encodes draw commands
   *  once + replays via `executeBundles([bundle])` on stable scenes
   *  (idle camera / slow pan). Invalidated by cache key composition:
   *  any tile set change OR gpuCache change OR pipeline rebuild
   *  produces a different key → re-encode. */
  private bundleCache: BundleCache

  /** Polygon vertex/index arena getters — thin forwarders to the
   *  GpuTileStore (Cluster A owner). The arenas (poly vertex / poly index
   *  / z-buffer) + their capacity consts + the pending-compaction flag +
   *  the retired-buffer pool all live on the store; the uploader lazy-
   *  inits via these getters on first `doUploadTile`/`doUploadTileAsync`
   *  and binds every tile from the same underlying GPUBuffer with per-tile
   *  offsets. */
  private getOrCreatePolyVertexArena(): GPUArena {
    return this._store.polyVertexArenaOrCreate()
  }
  private getOrCreatePolyIndexArena(): GPUArena {
    return this._store.polyIndexArenaOrCreate()
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
    this._bindGroups.setExtrudedPipelines(main, fallback)
  }

  /** WS-9 — set the fill-extrusion light (top-level style concern, not
   *  per-show). The render loop pushes host._light into every VTR each
   *  frame; omitted fields keep their current value. Cheap (3 scalar
   *  stores); the packer consumes them per tile uniform write. */
  setLight(light: { position?: [number, number, number]; intensity?: number; color?: [number, number, number] }): void {
    if (light.position) this._lightPosition = light.position
    if (typeof light.intensity === 'number') this._lightIntensity = light.intensity
    if (light.color) this._lightColor = light.color
  }

  /** Provide the depth-disabled ground-layer fill pipelines. Same
   *  shader as the regular fill, but the depth state is OFF so
   *  painter's order between ground polygons is decided by GPU
   *  command order — the way painter's order is supposed to work,
   *  without log-depth precision noise + layer_depth_offset
   *  arithmetic fighting at coplanar fragments. */
  setGroundPipelines(main: GPURenderPipeline, fallback: GPURenderPipeline): void {
    this._bindGroups.setGroundPipelines(main, fallback)
  }

  /** iter-183 — fill-pattern Stage 2 pattern ground pipelines. Caller
   *  hands the `fillPipelinePatternGround` + fallback pair built by
   *  MapRenderer. VTR selects them in place of the regular ground
   *  pipelines when `show.fillPatternUV` is populated (the iconStage
   *  has resolved the sprite atlas UV bbox via map.ts). */
  setPatternPipelines(main: GPURenderPipeline, fallback: GPURenderPipeline): void {
    this._bindGroups.setPatternPipelines(main, fallback)
  }

  /** iter-186 — fill-extrusion-pattern Stage 2 variants. Mirror of
   *  setPatternPipelines for the extruded (per-feature z attribute)
   *  vertex path. */
  setPatternExtrudedPipelines(main: GPURenderPipeline, fallback: GPURenderPipeline): void {
    this._bindGroups.setPatternExtrudedPipelines(main, fallback)
  }

  /** Provide the OIT translucent extrude pipeline. Used when
   *  render() runs with phase='oit-fill': translucent buildings
   *  draw their fills into the accum + revealage MRT pair so a
   *  later compose pass can blend them order-independently onto
   *  the opaque framebuffer. */
  setOITPipeline(p: GPURenderPipeline): void {
    this._bindGroups.setOITPipeline(p)
  }

  /** Connect to a data source */
  setSource(source: TileCatalog): void {
    this.source = source
    // Immediate GPU upload — no queue delay, no flickering
    source.onTileLoaded = (key, data, sourceLayer) => {
      this.uploadTile(key, data, sourceLayer)
    }
  }

  /** Set bind group layout (must be called before tiles arrive). Thin
   *  forwarder — the base layout lives on the BindGroupRegistry (Cluster C);
   *  the uniform-ring `ensureUniformRing` side effect stays on VTR (the ring
   *  is VTR-owned, plan §5 DO-NOT-SPLIT #1). */
  setBindGroupLayout(layout: GPUBindGroupLayout): void {
    this._bindGroups.setBindGroupLayout(layout)
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
    this._featureBinder.setComputePlan(plan)
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
    this._featureBinder.dispatchComputePass(encoder, timestampWritesProvider)
  }

  /** P3 Step 3c — set palette atlas resources used by binding 2 + 4
   *  on the polygon bind-group layout. Caller (MapRenderer) hands
   *  the 1×1 stub by default; once `uploadPalette` lands the real
   *  atlas, the same call rebuilds the tile bind groups in place. Thin
   *  forwarder — the palette resources live on the BindGroupRegistry
   *  (Cluster C); the `_onUniformRingGrow` fan-out rebuilds BOTH the base
   *  groups AND the per-tile feature groups so a palette change propagates
   *  exactly as the old `rebuildTileBindGroups()` did. */
  setPaletteResources(colorAtlasView: GPUTextureView, sampler: GPUSampler): void {
    this._bindGroups.setPaletteResources(colorAtlasView, sampler)
    this._onUniformRingGrow()
  }

  /** iter-181 — fill-pattern Stage 2 infra mirror of
   *  setPaletteResources. Sprite atlas texture at binding 5; sampler
   *  reuses `paletteSampler` at binding 4. Stub 1×1 white via the
   *  initial MapRenderer.setSpriteAtlas push; replaced when the
   *  IconStage finishes loading the real sprite atlas. Thin forwarder
   *  (registry-owned resource + base/per-tile fan-out, as above). */
  setSpriteAtlasView(view: GPUTextureView): void {
    this._bindGroups.setSpriteAtlasView(view)
    this._onUniformRingGrow()
  }

  private ensureUniformRing(): void {
    if (this.uniformRing) return
    this.uniformRing = new UniformRing(this.device, polygonUniformStride(), 1024, 'vtr-uniform-ring', () => this._onUniformRingGrow())
    this.uniformRing.ensure()
  }

  /** The SINGLE `UniformRing.onGrow` fan-out (also fired by the palette /
   *  sprite-atlas setters). One trigger, base → per-tile order (plan §5
   *  DO-NOT-SPLIT #3, the iter-348/349 stale-colour fix). VTR coordinates;
   *  the BindGroupRegistry rebuilds the BASE source-level groups (Cluster C)
   *  and the FeatureDataBinder rebuilds the PER-TILE feature groups
   *  (Cluster D). Neither owns the onGrow wire — VTR does. The ring buffer +
   *  feature layout + feature data buffer + palette resources arrive as
   *  call arguments, so neither collaborator holds a VTR reference.
   *
   *  iter-226 — the base rebuild replaces `tileBgDefault`/`tileBgFeature`
   *  (new refs) and bumps the bind-group epoch so stale RenderBundles miss.
   *  iter-349 — the per-tile feature bind groups (data-driven MVT tiles)
   *  bind the same ring at binding 0; after a grow they'd keep referencing
   *  the OLD (retired, then destroyed-next-frame) ring → data-driven fills
   *  read stale uniform colours (the user-reported high-pitch "land flashes
   *  water-blue" while moving). Rebuilding both against the new ring fixes
   *  it; the order (base then per-tile) is preserved from the prior inline
   *  `rebuildTileBindGroups`. */
  private _onUniformRingGrow(): void {
    const ringBuf = this.uniformRing?.buffer
    this._bindGroups.rebuildBase(
      ringBuf,
      this._featureBinder.featureBindGroupLayout(),
      this._featureBinder.featureDataBufferHandle(),
    )
    this._featureBinder.rebuildPerTileGroups(this._store.cache(), ringBuf, this._bindGroups.paletteResources())
  }

  /** Frame ID set by `beginFrame(frameId)`, threaded through to
   *  `source.resetCompileBudget(frameId)` so the catalog's per-frame
   *  budget can short-circuit duplicate resets when one source feeds
   *  multiple layer ShowCommands within the same frame. */
  private currentFrameId = 0

  beginFrame(frameId: number = 0): void {
    this.currentFrameId = frameId
    this.uniformRing?.resetSlot()
    // iter-243 (Plan AAA B.2) — reset per-frame scratch arena
    // before any forEachLineLabelPolyline calls. The previous
    // frame's xs/ys views become invalid here, but callers don't
    // retain them across frames (they reslice into tileRuns
    // cache which copies into permanent storage). The arena now
    // lives on the _labelSource collaborator (Cluster F).
    this._labelSource.beginFrame()
    // Reset the frame-scoped miss counter + draw accumulators here so
    // multiple render() calls within the frame accumulate into one
    // total (see render()). Does NOT clear renderedDraws (render-scoped).
    this._drawStats.beginFrame()
    this._diagFillsThisFrame = 0 // DIAGNOSTIC draw cap (window.__xgisMaxTiles)
    // iter-255 (Plan AAA A.2) — clear inner Maps in place instead
    // of dropping them. Outer Map retained; inner Maps' hash
    // buckets reused next frame. Pre-iter-255 each frame's first
    // `_frameClassifyMemo.get(slice)` returned undefined → new
    // Map(). At ~13 distinct slices per Bright frame = ~13
    // Map allocations / frame.
    for (const inner of this._frameClassifyMemo.values()) inner.clear()
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
    this._selection.invalidateFrame()
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
    this.uniformRing?.takeRetired()
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
    //
    // The retired-buffer drain + the count/byte high-water evict trigger +
    // the deferred compaction drain all live on the GpuTileStore (Cluster A
    // owner) and run, in that exact order, inside `runFrameMaintenance` —
    // the post-submit safe window. `stableKeys` (E) + the compute-handle
    // release hook (D) + the upload-active probe (B) are passed in so the
    // store references neither VTR nor the upload queue.
    const compacted = this._store.runFrameMaintenance(
      this.stableKeys,
      this._releaseTileHook,
      () => this.uploadQueue.activeCount() > 0,
    )
    // Compaction swapped each tile's vertex/index buffer to a fresh packed
    // buffer + retired the old one (destroyed next maintenance pass). Cached
    // render bundles recorded the OLD buffer ref (recordTileFill setVertexBuffer)
    // and neither uploadEpoch nor bindGroupEpoch — the only compaction-relevant
    // bundle-key fields — changed, so a stale bundle would replay against the
    // retired buffer (UAF / wrong draw). Drop every cached bundle so the next
    // frame re-encodes against the live buffer; invalidation runs a full frame
    // before the retired buffer is destroyed. Mirrors the async-upload path's
    // buffer-identity guard. (Bundles are default-OFF; this is a latent-UAF fix.)
    if (compacted) this.bundleCache.invalidateAll()
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
    const cache = this._selection.frameTileCache()
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

  /** Set by destroy() before the arenas are torn down. In-flight
   *  `doUploadTileAsync` coroutines suspended on the staging mapAsync
   *  round-trip re-check this after their awaits and bail out WITHOUT
   *  submitting — otherwise their `queue.submit` would reference the
   *  now-destroyed poly-vertex/index arena buffer ("used in submit
   *  while destroyed"). See destroy() + doUploadTileAsync's pre-submit
   *  guard. */
  private _destroyed = false

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
  /** DIAGNOSTIC ONLY — count of fill draws emitted this frame, used by the
   *  `window.__xgisMaxTiles` per-frame draw cap in `recordTileFill`. Lets the
   *  perf A/B test "fewer DRAWS = faster?" by capping the actual GPU draw
   *  calls (the selection cap is defeated by fallback/ancestor back-fill, so
   *  it never reduced draw count). Reset each frame in `beginFrame`. */
  private _diagFillsThisFrame = 0
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
    return this._drawStats.getLastDecisionCounts()
  }

  private allocUniformSlot(): number {
    return this.uniformRing!.allocSlot()
  }

  /** Copy a per-tile uniform block into the staging mirror at the given
   *  ring byte offset and extend the dirty range. Replaces the old
   *  per-draw `device.queue.writeBuffer` call inside renderTileKeys. */
  private stageUniformSlot(slotOffset: number, src: ArrayBuffer): void {
    this.uniformRing!.stageSlot(slotOffset, src)
  }

  /** Upload the accumulated uniform-ring bytes as a SINGLE writeBuffer,
   *  then mark the dirty range empty. WebGPU schedules the copy before
   *  any command buffer submitted afterwards, so calling this at end of
   *  each renderTileKeys (i.e. still within the pass encoding window) is
   *  correct — the subsequent pass.end → encoder.finish → queue.submit
   *  sees the updated ring contents. */
  private flushUniformStaging(): void {
    this.uniformRing?.flush()
  }

  /** Provide the shared SDF line renderer (set by map.ts after GPU init). */
  setLineRenderer(lr: LineRenderer): void {
    const wasNull = this.lineRenderer === null
    this.lineRenderer = lr
    // If tiles were uploaded before LineRenderer was available they have no
    // segment buffers — force re-upload so outlines/lines render on next frame.
    if (wasNull && this._store.cacheCount() > 0) {
      // P4 compute path — gpuCache is being cleared wholesale, so every
      // per-tile ComputeLayerHandle is now orphaned. Free + clear them
      // here (Cluster D, VTR-owned) BEFORE the store wipes its cache; the
      // store's per-tile buffer-destroy loop goes through arenas, not
      // _releaseTileSlots, so it never touches these compute handles — the
      // two buffer sets are disjoint, so the relative order is moot.
      this._featureBinder.releaseAllComputeHandles()
      // The store destroys every per-tile line/outline/feature buffer,
      // resets all three arenas (keep GPU buffers alive for next upload),
      // and clears the cache + count — the Cluster-A half of the reset.
      this._store.resetForReupload()
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
    this._labelSource.forEachLabel(
      this.source, this.stableKeys, this._selection.frameTileCache()?.neededKeys, sliceLayer, fn,
    )
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
    this._labelSource.forEachLineLabel(
      this.source, this.stableKeys, this._selection.frameTileCache()?.neededKeys, sliceLayer, fn,
    )
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
    this._labelSource.forEachLineLabelPolyline(
      this.source, this.stableKeys, this._selection.frameTileCache()?.neededKeys, sliceLayer, fn,
    )
  }

  hasFeatureData(): boolean {
    return this._featureBinder.hasFeatureData()
  }

  getCacheSize(): number {
    return this._store.cacheCount()
  }

  /** iter-288 — FLICKER class diagnostic. Returns a per-frame
   *  partition of where the visible-tile set stands:
   *
   *    needed         — last frame's `_frameTilesVisible` (visible
   *                     unique tile count emitted by the per-tile
   *                     loop, sum across all sliceLayers)
   *    missed         — `_missedTiles`: tiles classified as 'pending'
   *                     (no fallback resolved this frame)
   *    gpuUnique      — `_gpuCacheCount`: unique (sliceLayer, key)
   *                     pairs resident on GPU
   *    catalogCached  — catalog.getCacheSize() (CPU-side dataCache
   *                     entries)
   *    catalogLoading — catalog.getPendingLoadCount() (in-flight
   *                     fetches)
   *    uploadQueued   — VTR's uploadQueue.size (decoded but not yet
   *                     uploaded to GPU; bounded by uploadBudgetFor)
   *    gpuCapDesktop  — current MAX_GPU_TILES (256 desktop / 64
   *                     mobile); FLICKER fires when needed > cap
   *                     AND fallback walk doesn't resolve
   *
   *  Cheap; only Map.size + integer reads. Designed for `__xgisMap`
   *  shell-injection from a Playwright probe or a manual user
   *  capture during the FLICKER repro:
   *
   *      window.__xgisMap.getTileLoadDiagnostic()
   *
   *  User reported (memory `project_water_low_zoom_iter271`):
   *  z=5 mercator burst → 'FLICKER 140 tiles z=5 gpuCache=62'.
   *  The accessor surfaces every term in that decomposition so the
   *  next focused-fix iter can attribute the missed tiles to a
   *  specific bottleneck (fetch saturation vs upload saturation vs
   *  cap eviction). */
  getTileLoadDiagnostic(): {
    needed: number
    missed: number
    gpuUnique: number
    catalogCached: number
    catalogLoading: number
    uploadQueued: number
    gpuCap: number
  } {
    return {
      needed: this._drawStats.needed(),
      missed: this._drawStats.missed(),
      gpuUnique: this._store.cacheCount(),
      catalogCached: this.source?.getCacheSize?.() ?? 0,
      catalogLoading: this.source?.getPendingLoadCount?.() ?? 0,
      uploadQueued: this.uploadQueue.size(),
      gpuCap: getMaxGpuTiles(),
    }
  }

  /** Tear down all GPU resources owned by this renderer.
   *  Used when a source is being replaced (setSourceData) or the
   *  whole map is disposed. After destroy() the renderer is dead —
   *  create a new VectorTileRenderer if another upload is needed. */
  destroy(): void {
    // Mark torn-down FIRST so any in-flight async upload that is
    // suspended on the staging mapAsync round-trip will, on resume,
    // skip its `queue.submit` instead of copying into a destroyed
    // arena buffer (the "used in submit while destroyed" UAF). Then
    // drop every still-QUEUED upload (not yet dispatched) so no new
    // coroutine can start and capture the arena buffer after this
    // point. ACTIVE coroutines are handled by the pre-submit guard in
    // doUploadTileAsync via the _destroyed flag.
    this._destroyed = true
    this.uploadQueue.removeByFilter(() => true)
    this.uploadItemData.clear()
    // P4 compute resources: per-tile ComputeLayerHandle instances
    // own (feat / out / count) buffer trios. Free them before the
    // legacy buffer loop so device memory is reclaimed in one pass.
    this._featureBinder.releaseAllComputeHandles()
    // Cluster-A teardown: destroy every per-tile line/outline/feature
    // buffer, clear the cache + count, destroy all three arenas, and
    // drain any compaction-retired buffers — the eviction/teardown half
    // of destroy, now owned by the GpuTileStore.
    this._store.destroy()

    this._featureBinder.destroy()

    this.uniformRing?.destroy()
    this.uniformRing = null
  }

  // Frame-scoped draw accumulators (_frameTilesVisible,
  // _frameGlobeTilesSelected, _frameDrawCalls/_frameTriangles/
  // _frameLines/_frameVertices, _frameDrawnByZoom) live on the
  // FrameDrawStats collaborator (Cluster G). See `_drawStats`.
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

  getDrawStats(): { drawCalls: number; vertices: number; triangles: number; lines: number; tilesVisible: number; missedTiles: number; globeTilesSelected: number } {
    return this._drawStats.getDrawStats()
  }

  /** iter-222 — BundleCache stats accessor. Returns lifetime
   *  hit/miss counters across all (slice, phase, key-set, gen,
   *  attachment) variants this VTR has cached. Map.ts aggregates
   *  across all VT sources + bg renderer for the global stats.
   *  iter-228 widens to also report LRU evictions so the global
   *  panel can surface cap pressure. */
  getBundleStats(): { hits: number; misses: number; evictions: number } {
    const s = this.bundleCache.getStats()
    return { hits: s.hits, misses: s.misses, evictions: s.evictions }
  }

  /** Build per-feature GPU storage buffer from PropertyTable. Thin
   *  forwarder — the data-driven feature buffer + variant-schema capture
   *  live on the FeatureDataBinder (Cluster D). VTR supplies the source
   *  PropertyTable and rebuilds `tileBgFeature` afterward (via the registry
   *  base rebuild + per-tile fan-out) only when a source-level buffer was
   *  actually built — matching the original early-return-before-rebuild on
   *  the PMTiles path. */
  buildFeatureDataBuffer(
    variant: ShaderVariant,
    featureBindGroupLayout: GPUBindGroupLayout,
    renderNodeIndex?: number,
  ): void {
    const builtSourceBuffer = this._featureBinder.buildFeatureDataBuffer(
      variant, featureBindGroupLayout, this.source?.getPropertyTable(), renderNodeIndex,
    )
    if (builtSourceBuffer) {
      // Build the shared feature-bound tile bind group
      this._onUniformRingGrow()
    }
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
      // PriorityQueueItemRemovedError is the expected outcome when
      // `cancelStaleUploads` drops a queued upload (camera has moved
      // past the target tile). It's a normal flow signal, not an
      // error — surface the others.
      if (err instanceof PriorityQueueItemRemovedError) return
      xlog.error('[upload queue]', err)
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

  /** Drop queued uploads for tiles the camera has moved past. Mirrors
   *  the source-side `cancelStale` (which drops in-flight FETCHES) for
   *  the renderer-side GPU upload queue. The two queues are unrelated:
   *  cancelStale aborts network/decode work; this drops staging-buffer
   *  writes whose target tile is no longer visible.
   *
   *  Bug class this fixes: under fast zoom + pan, every visible tile
   *  along the way queued an `uploadTile` job. With ~80 layers per
   *  style and several hundred frames of camera motion, the queue
   *  accumulates hundreds of stale uploads that maxJobs=4-8 dispatches
   *  per frame can't drain. Meanwhile each new visible tile gets a
   *  fresh upload job queued BEHIND the stale ones — so the new
   *  visible tile never reaches the GPU and classifyTile keeps
   *  returning parent-fallback for it. Visual symptom: parent's
   *  simplified low-zoom geometry painted as "stale fill" that
   *  persists across pan / zoom long past when it should have been
   *  replaced. (User-reported: Korea Positron, fast zoom + pan,
   *  red fallback regions visible 8+ s after settle.)
   *
   *  `activeKeys` is the same set the source-side cancelStale uses —
   *  union of visible / parent / fallback / toLoad keys. Items
   *  outside this set are safe to drop; either they're for tiles the
   *  camera has left behind (won't be drawn this frame) or they're
   *  prefetch / pending entries we'll re-queue on the next render if
   *  they become relevant again.
   *
   *  Also walks `_heldUploads` (cap-deferred queue) since stale items
   *  could be sitting there too. */
  cancelStaleUploads(activeKeys: ReadonlySet<number>): void {
    const itemData = this.uploadItemData
    // Filter the queue first — `removeByFilter` is O(N) and rejects the
    // dropped items' promises with PriorityQueueItemRemovedError. The
    // queue.add caller's `.catch` clause (see uploadTile) already
    // handles that error class as a silent drop.
    const staleIds: string[] = []
    for (const [id, item] of itemData) {
      if (!activeKeys.has(item.key)) staleIds.push(id)
    }
    if (staleIds.length === 0 && this._heldUploads.length === 0) return
    if (staleIds.length > 0) {
      const staleSet = new Set(staleIds)
      this.uploadQueue.removeByFilter(id => staleSet.has(id))
      for (const id of staleIds) {
        const item = itemData.get(id)
        // The dropped upload was the only thing that would have nulled
        // these prebuilt SDF segment buffers (doUploadTile does it post-
        // upload). The TileData stays in the catalog's dataCache, but
        // `TileCatalog.sizeOfTileData` deliberately OMITS prebuilt
        // segments (it assumes they're nulled after upload) — so a
        // retained multi-MB segment buffer is uncounted by `_cachedBytes`
        // and the byte-cap eviction under-fires. Null them here to keep
        // the size-omission invariant true; buildLineSegments rebuilds
        // them on a later re-upload exactly as the post-upload null relies on.
        if (item) VectorTileRenderer._releasePrebuiltSegments(item.data)
        itemData.delete(id)
      }
    }
    // Compact _heldUploads in-place. _heldUploadIds + _heldUploadKeys
    // are rebuilt from the survivors so the coherence guard in
    // classifyTile (`hasOtherSliceHeld`) stays accurate.
    if (this._heldUploads.length > 0) {
      const kept: typeof this._heldUploads = []
      this._heldUploadIds.clear()
      this._heldUploadKeys.clear()
      for (const item of this._heldUploads) {
        if (activeKeys.has(item.key)) {
          kept.push(item)
          this._heldUploadIds.add(`${item.key}:${item.sourceLayer}`)
          this._heldUploadKeys.add(item.key)
        } else {
          // Same uncounted-bytes leak as the queued-drop path above — a
          // held item that gets dropped keeps its prebuilt segments
          // forever otherwise. Null them so `sizeOfTileData`'s omission
          // stays accurate.
          VectorTileRenderer._releasePrebuiltSegments(item.data)
        }
      }
      this._heldUploads = kept
    }
  }

  /** Null a TileData's prebuilt SDF segment buffers. Used by
   *  `cancelStaleUploads` when it drops a queued / held upload whose
   *  TileData stays in the catalog: the buffers are rebuilt on demand by
   *  `buildLineSegments` at the next upload, and `TileCatalog.sizeOfTileData`
   *  assumes they're absent for cached tiles, so leaving them set would
   *  under-count `_cachedBytes` and stall byte-cap eviction. */
  private static _releasePrebuiltSegments(data: TileData): void {
    data.prebuiltLineSegments = undefined
    data.prebuiltOutlineSegments = undefined
  }

  /** Lane B — atomic polygon vertex+index arena alloc. Allocates the
   *  vertex slot first, then the index slot; if the index alloc throws
   *  (arena OOM) the already-claimed vertex slot is freed so a failed
   *  pair NEVER leaks. Returns null on any failure (caller runs forced
   *  eviction + retry, then warn-and-skip). Shared by BOTH the sync
   *  `doUploadTile` and async `doUploadTileAsync` paths so the two routes
   *  cannot diverge in OOM handling (the async path is the primary tile-
   *  streaming route — the crash repro goes through it). */
  private _allocPolyPair(
    vArena: GPUArena, iArena: GPUArena, vBytes: number, iBytes: number,
  ): { v: number; i: number } | null {
    let v: number | null = null
    try {
      v = vArena.alloc(vBytes)
      const i = iArena.alloc(iBytes)
      return { v, i }
    } catch {
      if (v !== null) vArena.free(v, vBytes)  // no partial leak
      return null
    }
  }

  private doUploadTile(key: number, data: TileData, sourceLayer = ''): void {
    const layerCache = this.getOrCreateLayerCache(sourceLayer)
    if (layerCache.has(key)) return // already uploaded

    // Lane B backstop — doUploadTile must NEVER throw out of render().
    // Beyond the inner allocPair guard (polygon vertex/index), the
    // line / outline acquireBuffer + lineRenderer.uploadSegmentBuffer
    // paths can also throw under GPU memory exhaustion. The outer
    // try/catch degrades ANY such throw to skip-this-tile (warn-once,
    // un-cached → retried next frame). Orphan-leak guard (option b):
    // if the throw lands AFTER the polygon vertex/index alloc but
    // BEFORE layerCache.set, those slots would never be recorded →
    // never freed. We track both offsets + their byte lengths in
    // let-vars (offset −1 = unset) and free any assigned slot in the
    // catch via the store arenas (`_store.polyVertexArenaOrNull()` /
    // `polyIndexArenaOrNull()` — created once an offset is assigned).
    let polyVertexOffset = -1
    let polyIndexOffset = -1
    let polyVertexFreeBytes = 0
    let polyIndexFreeBytes = 0
    // Hoisted OUTSIDE the try (mirror of doUploadTileAsync) so the catch
    // backstop can free buffers acquired before a pre-cache throw — else
    // those line/index + segment buffers leak VRAM.
    let lineVertexBuffer: GPUBuffer | null = null
    let lineIndexBuffer: GPUBuffer | null = null
    let outlineIndexBuffer: GPUBuffer | null = null
    let outlineSegmentBuffer: GPUBuffer | null = null
    let lineSegmentBuffer: GPUBuffer | null = null
    try {
    // Label every per-tile buffer so writeBuffer attribution in the
    // diagnostic suite can separate tile-upload churn from per-frame
    // uniform writes. Cost is zero — label is a GPU debug string.
    //
    // Polygon vertex pipeline (Phase 2 PR 2c.2 — ECEF-DSFUN):
    //   * Flat slices: `data.vertices` is the tiler's stride-9 ECEF-DSFUN
    //     buffer (`[ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, fid, abs_lon,
    //     abs_lat]` per vertex, 36 bytes). Uploaded directly — no runtime
    //     re-quantization. Indices come straight from `data.indices`.
    //   * Extruded slices: `generateWallMeshExtrudedECEF` emits an
    //     interleaved stride-14 ECEF-DSFUN buffer (walls + roof, 56
    //     bytes / vertex; layout in `polygon-mesh.ts`'s ECEF block).
    //     `data.vertices` / `data.indices` are NOT consumed in this
    //     branch — the wall-mesh generator owns the full extruded
    //     geometry. Per-vertex height + face_normal + is_top live IN
    //     the unified buffer, so no parallel z buffer.
    // Slices that carried per-feature `render_height` / `height` from
    // the MVT decode path route through the extruded generator; slices
    // without heights stay on the flat-fill ECEF stride-9 layout. The
    // previous heuristic (`sourceLayer === 'buildings'`) is replaced —
    // slices route entirely off the data they carry, and per-layer
    // control lives in the style language now.
    const useFeatureHeights = data.heights !== undefined && data.heights.size > 0
    let polyVerts: ArrayBuffer
    let polyIndices: Uint32Array
    // PR 2f per-tile quantized-position dequant params (flat: from `data`;
    // extruded: from the runtime wall-mesh). Written into the per-tile uniform.
    let dequantScale: number
    let dequantHalf: number
    if (useFeatureHeights && data.polygons) {
      // ECEF tile-corner anchor — must match the compiler tiler's
      // `tileEcefCenter` (`packECEFPolygonVertices`'s RTC origin) so
      // the unified extruded buffer stays in the same DSFUN frame as
      // the surrounding flat-fill tiles. WGS84 ellipsoidal math
      // (cross-package import from runtime/projection forbidden in
      // the worker thread; mirrors `tileEcefCenterFromMerc`).
      const A_ = 6378137
      const F_ = 1 / 298.257223563
      const E2_ = F_ * (2 - F_)
      const DEG2RAD = Math.PI / 180
      const clampLat = Math.max(-85.051129, Math.min(85.051129, data.tileSouth))
      const tileMx = data.tileWest * DEG2RAD * A_
      const tileMy = Math.log(Math.tan(Math.PI / 4 + clampLat * DEG2RAD / 2)) * A_
      const tileLonRad = tileMx / A_
      const tileLatRad = 2 * Math.atan(Math.exp(tileMy / A_)) - Math.PI / 2
      const sinLat = Math.sin(tileLatRad)
      const cosLat = Math.cos(tileLatRad)
      const N = A_ / Math.sqrt(1 - E2_ * sinLat * sinLat)
      const tileEcefCenter: readonly [number, number, number] = [
        N * cosLat * Math.cos(tileLonRad),
        N * cosLat * Math.sin(tileLonRad),
        N * (1 - E2_) * sinLat,
      ]
      const mesh = generateWallMeshExtrudedECEF(
        data.polygons, data.heights!, data.bases,
        tileMx, tileMy, tileEcefCenter,
      )
      polyVerts = mesh.vertices.buffer.slice(
        mesh.vertices.byteOffset,
        mesh.vertices.byteOffset + mesh.vertices.byteLength,
      ) as ArrayBuffer
      polyIndices = mesh.indices
      // PR 2f: extruded dequant params computed post-lift by the wall-mesh.
      dequantScale = mesh.dequantScale
      dequantHalf = mesh.dequantHalf
    } else {
      // Flat slice: tiler already emitted the quantized ECEF layout
      // (stride 28 bytes, #398) — pass through unchanged. `data.vertices` is a
      // typed-array view; `slice` copies into a fresh ArrayBuffer the arena
      // can accept. The companion per-tile dequant params travel on `data`.
      polyVerts = data.vertices.buffer.slice(
        data.vertices.byteOffset,
        data.vertices.byteOffset + data.vertices.byteLength,
      ) as ArrayBuffer
      polyIndices = data.indices
      dequantScale = data.dequantScale
      dequantHalf = data.dequantHalf
    }
    // Phase 6a.2 (iter-208) — polygon vertex now allocates from the
    // shared arena. The arena's underlying GPUBuffer is set as
    // `cached.vertexBuffer`; per-tile `polyVertexOffset` +
    // `polyVertexByteLength` carry the sub-range. Mirrors stayed
    // for the async path below + the eviction `arena.free` call.
    const polyVertexArena = this.getOrCreatePolyVertexArena()
    // Phase 6a.3 (iter-209) — polygon index from shared arena.
    const polyIndexArena = this.getOrCreatePolyIndexArena()
    const polyVertexByteLength = Math.max(polyVerts.byteLength, 12)
    const polyIndexByteLength = Math.max(polyIndices.byteLength, 4)

    // Lane B — alloc-fail safety net. Without this, the arena overflow
    // throw propagates out of doUploadTile → out of render() → kills the
    // frame every frame. _allocPolyPair allocs vertex then index; on an
    // index-fail it frees the already-claimed vertex slot so a failed
    // pair never leaks. On the first failure we run a forced, count-
    // bypassing byte-eviction (drops LRU UNPROTECTED tiles — stableKeys
    // stay resident so the visible frame survives) on BOTH arenas, then
    // retry ONCE. If the retry still fails the tile is left un-cached
    // (returns before layerCache.set), so the next frame's classifyTile
    // re-decides upload — the desired retry-later behaviour. Non-OOM
    // path is unchanged: _allocPolyPair succeeds first try, same offsets +
    // writeBuffer order as before. Shared with doUploadTileAsync so both
    // upload routes have identical OOM behaviour.
    let pair = this._allocPolyPair(polyVertexArena, polyIndexArena, polyVertexByteLength, polyIndexByteLength)
    if (pair === null) {
      perfMarkStart('vtr.evict')
      this._store.forceEvictBytes(polyVertexArena, polyVertexByteLength, this.stableKeys, this._releaseTileHook)
      this._store.forceEvictBytes(polyIndexArena, polyIndexByteLength, this.stableKeys, this._releaseTileHook)
      perfMarkEnd('vtr.evict')
      pair = this._allocPolyPair(polyVertexArena, polyIndexArena, polyVertexByteLength, polyIndexByteLength)
    }
    if (pair === null) {
      const wKey = `arena-oom:${sourceLayer}:${key}`
      if (!this._drawStats.hasWarned(wKey)) {
        this._drawStats.markWarned(wKey)
        xlog.warn(`[VTR arena-oom] poly arena out of capacity uploading tile ${key} (${sourceLayer || 'base'}); skipping this frame, will retry. vBytes=${polyVertexByteLength} iBytes=${polyIndexByteLength}`)
      }
      return
    }
    polyVertexOffset = pair.v
    polyIndexOffset = pair.i
    polyVertexFreeBytes = polyVertexByteLength
    polyIndexFreeBytes = polyIndexByteLength
    const vertexBuffer = polyVertexArena.buffer
    const indexBuffer = polyIndexArena.buffer
    this.device.queue.writeBuffer(vertexBuffer, polyVertexOffset, polyVerts)
    this.device.queue.writeBuffer(indexBuffer, polyIndexOffset, polyIndices)

    // Phase 2 PR 2c.2 — the parallel z attribute is retired. Per-vertex
    // height + face_normal + is_top now live inside the unified
    // stride-14 vertex buffer emitted by `generateWallMeshExtrudedECEF`.
    // The cache schema keeps `zBuffer`-shaped fields populated with
    // sentinel values so downstream layer-routing logic compiles; the
    // extruded vertex layout no longer binds a second buffer.
    const zBuffer: GPUBuffer | null = null
    const zBufferOffset = 0
    const zBufferByteLength = 0

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
    let outlineSegmentCount = 0
    let outlineSegmentBindGroup: GPUBindGroup | null = null
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
    const perTileFeat = this._featureBinder.buildPerTileFeatureData(
      data.featureProps, this.uniformRing?.buffer, this._bindGroups.paletteResources(), `${key}:${sourceLayer}`)

    layerCache.set(key, {
      vertexBuffer, polyVertexOffset, polyVertexByteLength, indexBuffer,
      polyIndexOffset, polyIndexByteLength,
      indexCount: polyIndices.length,
      zBuffer, zBufferOffset, zBufferByteLength, extruded: useFeatureHeights && !!data.polygons,
      lineVertexBuffer, lineIndexBuffer,
      lineIndexCount: data.lineIndices.length,
      outlineIndexBuffer, outlineIndexCount,
      outlineSegmentBuffer, outlineSegmentCount, outlineSegmentBindGroup,
      lineSegmentBuffer, lineSegmentCount, lineSegmentBindGroup,
      tileWest: data.tileWest, tileSouth: data.tileSouth,
      tileWidth: data.tileWidth, tileHeight: data.tileHeight,
      tileZoom: data.tileZoom,
      dequantScale, dequantHalf,
      lastUsedFrame: this.frameCount,
      uploadTimeMs: performance.now(),
      featureDataBuffer: perTileFeat?.buffer ?? null,
      featureBindGroup: perTileFeat?.bindGroup ?? null,
      // iter-226 — strictly-monotonic per-tile upload counter for
      // RenderBundle cache key composition (see _tileUploadEpoch).
      uploadEpoch: this._store.nextUploadEpoch(),
    })
    this._store.incrementCount()

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
    } catch (e) {
      // Backstop: a throw from line / outline acquireBuffer,
      // uploadSegmentBuffer, or any other GPU-memory-exhaustion path
      // reaching here means layerCache.set did not run, so the polygon
      // vertex/index slots claimed by allocPair are orphaned. Free any
      // assigned offset (option b) before degrading to skip-this-tile.
      const vArena = this._store.polyVertexArenaOrNull()
      const iArena = this._store.polyIndexArenaOrNull()
      if (polyVertexOffset >= 0 && vArena !== null) {
        vArena.free(polyVertexOffset, polyVertexFreeBytes)
      }
      if (polyIndexOffset >= 0 && iArena !== null) {
        iArena.free(polyIndexOffset, polyIndexFreeBytes)
      }
      // Line/outline/segment buffers acquired before the throw were never
      // cached either — free them too (mirror of async cleanupLineBuffers;
      // no double-free: the happy path exits the try without this catch).
      this.releaseBuffer(lineVertexBuffer)
      this.releaseBuffer(lineIndexBuffer)
      this.releaseBuffer(outlineIndexBuffer)
      outlineSegmentBuffer?.destroy()
      lineSegmentBuffer?.destroy()
      const wKey = `upload-throw:${sourceLayer}:${key}`
      if (!this._drawStats.hasWarned(wKey)) {
        this._drawStats.markWarned(wKey)
        xlog.warn(`[VTR upload] doUploadTile threw for tile ${key} (${sourceLayer || 'base'}); skipping. ${(e as Error)?.message ?? e}`)
      }
    }
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

    // Phase 2 PR 2c.2 — ECEF-DSFUN upload (mirror of `doUploadTile`'s sync
    // path; see that function's comment block for the per-stride layout
    // contract). Flat slices pass `data.vertices` through unchanged;
    // extruded slices route through `generateWallMeshExtrudedECEF` for the
    // unified walls + roof stride-14 buffer.
    const useFeatureHeights = data.heights !== undefined && data.heights.size > 0
    let polyVerts: ArrayBuffer
    let polyIndices: Uint32Array
    // PR 2f per-tile quantized-position dequant params (see sync path).
    let dequantScale: number
    let dequantHalf: number
    if (useFeatureHeights && data.polygons) {
      const A_ = 6378137
      const F_ = 1 / 298.257223563
      const E2_ = F_ * (2 - F_)
      const DEG2RAD = Math.PI / 180
      const clampLat = Math.max(-85.051129, Math.min(85.051129, data.tileSouth))
      const tileMx = data.tileWest * DEG2RAD * A_
      const tileMy = Math.log(Math.tan(Math.PI / 4 + clampLat * DEG2RAD / 2)) * A_
      const tileLonRad = tileMx / A_
      const tileLatRad = 2 * Math.atan(Math.exp(tileMy / A_)) - Math.PI / 2
      const sinLat = Math.sin(tileLatRad)
      const cosLat = Math.cos(tileLatRad)
      const N = A_ / Math.sqrt(1 - E2_ * sinLat * sinLat)
      const tileEcefCenter: readonly [number, number, number] = [
        N * cosLat * Math.cos(tileLonRad),
        N * cosLat * Math.sin(tileLonRad),
        N * (1 - E2_) * sinLat,
      ]
      const mesh = generateWallMeshExtrudedECEF(
        data.polygons, data.heights!, data.bases,
        tileMx, tileMy, tileEcefCenter,
      )
      polyVerts = mesh.vertices.buffer.slice(
        mesh.vertices.byteOffset,
        mesh.vertices.byteOffset + mesh.vertices.byteLength,
      ) as ArrayBuffer
      polyIndices = mesh.indices
      dequantScale = mesh.dequantScale
      dequantHalf = mesh.dequantHalf
    } else {
      polyVerts = data.vertices.buffer.slice(
        data.vertices.byteOffset,
        data.vertices.byteOffset + data.vertices.byteLength,
      ) as ArrayBuffer
      polyIndices = data.indices
      dequantScale = data.dequantScale
      dequantHalf = data.dequantHalf
    }

    // One command encoder per tile — all the copyBufferToBuffer ops
    // below batch into a single submit at the end, minimising queue
    // submission overhead.
    const encoder = this.device.createCommandEncoder({ label: `tile-upload-${key}` })
    const releases: Array<() => void> = []

    // Phase 6a.2 (iter-208) — async upload mirror of sync path. Both
    // paths allocate from the same polyVertexArena so eviction
    // behaviour matches regardless of upload route.
    const polyVertexArena = this.getOrCreatePolyVertexArena()
    const polyVertexByteLength = Math.max(polyVerts.byteLength, 12)
    // Phase 6a.3 — async index also from arena.
    const polyIndexArena = this.getOrCreatePolyIndexArena()
    const polyIndexByteLength = Math.max(polyIndices.byteLength, 4)

    // Lane B — alloc-fail safety net, mirroring the sync path EXACTLY so
    // the primary (async) tile-streaming route can never crash the loop.
    // _allocPolyPair claims vertex then index, freeing the vertex slot if
    // the index alloc throws (no partial leak). On first failure run a
    // forced count-bypassing byte-eviction on BOTH arenas, then retry once;
    // on persistent failure leave the tile un-cached (warn-once) so the
    // next frame's classifyTile re-decides upload.
    let pair = this._allocPolyPair(polyVertexArena, polyIndexArena, polyVertexByteLength, polyIndexByteLength)
    if (pair === null) {
      perfMarkStart('vtr.evict')
      this._store.forceEvictBytes(polyVertexArena, polyVertexByteLength, this.stableKeys, this._releaseTileHook)
      this._store.forceEvictBytes(polyIndexArena, polyIndexByteLength, this.stableKeys, this._releaseTileHook)
      perfMarkEnd('vtr.evict')
      pair = this._allocPolyPair(polyVertexArena, polyIndexArena, polyVertexByteLength, polyIndexByteLength)
    }
    if (pair === null) {
      const wKey = `arena-oom:${sourceLayer}:${key}`
      if (!this._drawStats.hasWarned(wKey)) {
        this._drawStats.markWarned(wKey)
        xlog.warn(`[VTR arena-oom] poly arena out of capacity uploading tile ${key} (${sourceLayer || 'base'}); skipping this frame, will retry. vBytes=${polyVertexByteLength} iBytes=${polyIndexByteLength}`)
      }
      return
    }
    const polyVertexOffset = pair.v
    const polyIndexOffset = pair.i
    const vertexBuffer = polyVertexArena.buffer
    const indexBuffer = polyIndexArena.buffer
    // Track whether the just-claimed poly slots have been handed off to
    // layerCache yet. Until handoff, ANY early-return (race guard) or throw
    // (acquireBuffer / uploadSegmentBufferAsync / encoder.finish / submit)
    // must free them, else they leak permanently — pinning liveBytes > 0
    // and blocking reclaimIfDrained forever. The outer try/catch backstop
    // below frees on throw; the race-guard frees on early-return.
    let polySlotsCached = false

    // Declared OUTSIDE the try so the catch backstop below can reach them.
    // A throw mid-acquire (e.g. the 2nd acquireBuffer / uploadSegmentBufferAsync)
    // can leave some of these populated; the catch must free them too.
    let lineVertexBuffer: GPUBuffer | null = null
    let lineIndexBuffer: GPUBuffer | null = null
    let outlineIndexBuffer: GPUBuffer | null = null
    let outlineSegmentBuffer: GPUBuffer | null = null
    let lineSegmentBuffer: GPUBuffer | null = null
    // Bail-site cleanup: the three early-returns below (UAF/compaction guard,
    // same-key race guard, catch backstop) all return BEFORE layerCache.set,
    // so the line/outline buffers acquired above + the segment buffers built
    // below are never recorded in the cache entry and _releaseTileSlots can
    // never reach them — they leak VRAM. Each bail site calls this first to
    // return the pooled index/vertex buffers + destroy the lineRenderer-owned
    // segment buffers. Same order/guards as _releaseTileSlots; all null for
    // synthetic sources (no lineRenderer / empty line data).
    const cleanupLineBuffers = () => {
      this.releaseBuffer(lineVertexBuffer)
      this.releaseBuffer(lineIndexBuffer)
      this.releaseBuffer(outlineIndexBuffer)
      outlineSegmentBuffer?.destroy()
      lineSegmentBuffer?.destroy()
    }

    try {

    // Kick off the staging-buffer mapAsync for vertex + index in
    // parallel, then await both. mapAsync round-trips overlap, so
    // the wall-clock cost is one round-trip (not N).
    const writeHandles: Array<Promise<{ release: () => void }>> = []
    writeHandles.push(asyncWriteBuffer(this.stagingPool, encoder, vertexBuffer, polyVertexOffset, polyVerts))
    writeHandles.push(asyncWriteBuffer(this.stagingPool, encoder, indexBuffer, polyIndexOffset, polyIndices))

    // Phase 2 PR 2c.2 — parallel z attribute retired (see sync path
    // comment). Cache schema keeps sentinel values populated.
    const zBuffer: GPUBuffer | null = null
    const zBufferOffset = 0
    const zBufferByteLength = 0

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
    let outlineSegmentCount = 0
    let outlineSegmentBindGroup: GPUBindGroup | null = null
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

    // UAF guard: a synchronous teardown (e.g. a projection band-change
    // calling setBackgroundFill(null) → teardownSource → destroy()) can
    // land inside the staging mapAsync suspension above. If it did, the
    // captured `vertexBuffer`/`indexBuffer` (= the poly arena buffers,
    // VTR:2175-2176) have been destroyed, and the encoder's
    // copyBufferToBuffer targets them — submitting would raise
    // "Buffer poly-vertex-arena/poly-index-arena used in submit while
    // destroyed". Bail WITHOUT submitting; return the staging slots to
    // the (shared, still-live) pool so they aren't leaked. The dead
    // arenas were already destroyed+nulled by destroy(), so the claimed
    // poly slots need no free (the whole arena is gone).
    // ALSO bail if a COMPACTION (the post-merge arena defrag) swapped an arena
    // buffer out from under us while we were suspended: `_compactPolyArenas`
    // replaces `arena.buffer` with a fresh packed buffer and RETIRES the old one
    // (destroyed a frame later via _retiredArenaBuffers), and our claimed slot
    // offsets moved. The captured `vertexBuffer`/`indexBuffer` are then a stale/
    // retired buffer, so this copy's submit would raise the same UAF (the
    // `_destroyed` flag does NOT trip — compaction is not teardown). A buffer-
    // identity check covers BOTH cases (teardown nulls the arena; compaction
    // replaces .buffer); the un-cached tile is re-uploaded into the live buffer
    // next frame.
    if (
      this._destroyed ||
      this._store.polyVertexArenaOrNull()?.buffer !== vertexBuffer ||
      this._store.polyIndexArenaOrNull()?.buffer !== indexBuffer
    ) {
      for (const release of releases) release()
      cleanupLineBuffers()
      return
    }

    // Single submit per tile. The GPU now consumes staging → dst.
    this.device.queue.submit([encoder.finish()])
    // Return staging slots to the pool. Subsequent borrows on these
    // slots will mapAsync, which natively waits for the just-submitted
    // copy to finish before re-mapping for write.
    for (const release of releases) release()

    // Race guard: another upload (e.g. parallel doUploadTileAsync for
    // the same key, or a synchronous mid-render fallback) may have
    // populated the cache while we were awaiting. Skip the second set —
    // but FIRST free the poly vertex/index slots this call claimed. Those
    // offsets were never recorded in layerCache (the winning upload owns
    // the cache entry + its own slots), so without this free they leak
    // permanently and pin liveBytes > 0, blocking reclaimIfDrained forever.
    if (layerCache.has(key)) {
      polyVertexArena.free(polyVertexOffset, polyVertexByteLength)
      polyIndexArena.free(polyIndexOffset, polyIndexByteLength)
      cleanupLineBuffers()
      return
    }

    // Per-tile feat_data — same rationale as the sync path.
    // Compute-handle keying matches the legacy `${key}:${sourceLayer}`
    // identity already used by the upload queue + held set, so the
    // handle's lifetime tracks the tile's bind-group lifetime.
    const perTileFeat = this._featureBinder.buildPerTileFeatureData(
      data.featureProps, this.uniformRing?.buffer, this._bindGroups.paletteResources(), `${key}:${sourceLayer}`)

    layerCache.set(key, {
      vertexBuffer, polyVertexOffset, polyVertexByteLength, indexBuffer,
      polyIndexOffset, polyIndexByteLength,
      indexCount: polyIndices.length,
      zBuffer, zBufferOffset, zBufferByteLength, extruded: useFeatureHeights && !!data.polygons,
      lineVertexBuffer, lineIndexBuffer,
      lineIndexCount: data.lineIndices.length,
      outlineIndexBuffer, outlineIndexCount,
      outlineSegmentBuffer, outlineSegmentCount, outlineSegmentBindGroup,
      lineSegmentBuffer, lineSegmentCount, lineSegmentBindGroup,
      tileWest: data.tileWest, tileSouth: data.tileSouth,
      tileWidth: data.tileWidth, tileHeight: data.tileHeight,
      tileZoom: data.tileZoom,
      dequantScale, dequantHalf,
      lastUsedFrame: this.frameCount,
      uploadTimeMs: performance.now(),
      featureDataBuffer: perTileFeat?.buffer ?? null,
      featureBindGroup: perTileFeat?.bindGroup ?? null,
      // iter-226 — see sync upload-path for rationale.
      uploadEpoch: this._store.nextUploadEpoch(),
    })
    this._store.incrementCount()
    // Poly slots are now owned by the cache entry — the backstop must NOT
    // free them.
    polySlotsCached = true

    // Same memory-cleanup as sync path.
    data.prebuiltLineSegments = undefined
    data.prebuiltOutlineSegments = undefined
    data.polygons = undefined
    } catch (e) {
      // Backstop (mirror of the sync path's outer try/catch): a throw from
      // acquireBuffer / uploadSegmentBufferAsync / encoder.finish / submit
      // reaching here means layerCache.set did not run, so the polygon
      // vertex/index slots claimed by _allocPolyPair are orphaned. Free them
      // (unless already handed to the cache) before degrading to skip-this-
      // tile (warn-once, un-cached → retried a later frame). This guarantees
      // doUploadTileAsync can never reject-with-leak.
      if (!polySlotsCached) {
        polyVertexArena.free(polyVertexOffset, polyVertexByteLength)
        polyIndexArena.free(polyIndexOffset, polyIndexByteLength)
        // The line/outline/segment buffers acquired before the throw were
        // never handed to the cache either — free them with the poly slots.
        cleanupLineBuffers()
      }
      const wKey = `upload-throw:${sourceLayer}:${key}`
      if (!this._drawStats.hasWarned(wKey)) {
        this._drawStats.markWarned(wKey)
        xlog.warn(`[VTR upload] doUploadTileAsync threw for tile ${key} (${sourceLayer || 'base'}); skipping. ${(e as Error)?.message ?? e}`)
      }
    }
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
    fillPipelineFallback: GPURenderPipeline | undefined,
    linePipelineFallback: GPURenderPipeline | undefined,
    pointRenderer: PointRenderer | null | undefined,
    /** Which draws to emit for this layer.
     *  - 'all':     fills + strokes in the current pass (opaque default)
     *  - 'fills':   polygon fills only (main pass, baked opacity)
     *  - 'strokes': outlines + line features only — used by BOTH the
     *               translucent offscreen MAX-blend pass (where it
     *               needs `pipelineMax`) and the opaque-bucket case
     *               where an OIT-extruded layer kept its outlines on
     *               the main pass (regular `pipeline`). The caller
     *               disambiguates via `translucentLines`. */
    phase: LayerDrawPhase,
    /** Backing-buffer:CSS-pixel ratio for the canvas. Tile budget /
     *  mobile classification / subdivide threshold are perceptual
     *  CSS-pixel concepts and must stay DPR-invariant; without this
     *  param a DPR=3 phone gets 9× more tiles loaded than a DPR=1
     *  desktop at the same logical viewport size. */
    dpr: number,
    /** Depth-disabled (`STENCIL_WRITE_NO_DEPTH`) ground pipeline
     *  matching `bindGroupLayout` — used for `extrude.kind === 'none'`
     *  layers so coplanar painter's-order resolves without depth-test
     *  fighting. Pass `undefined` to fall back to the renderer-level
     *  `fillPipelineGround` (base-layout only — for legacy / test
     *  paths). */
    fillPipelineGroundOverride: GPURenderPipeline | undefined,
    fillPipelineGroundFallbackOverride: GPURenderPipeline | undefined,
    /** True when the caller's pass is the translucent offscreen
     *  MAX-blend RT (no depth attachment) — line draws must use
     *  `pipelineMax`. False when the pass has a depth attachment
     *  (opaque bucket); line draws use the regular `pipeline`. The
     *  opaque bucket can also reach `phase === 'strokes'` for
     *  OIT-extruded layers whose outlines stayed on the main pass
     *  (fully opaque even though the fill is translucent), so phase
     *  alone isn't enough to dispatch. */
    translucentBucket: boolean,
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
    // Inline GeoJSON shows lack explicit `sourceLayer`; the tilingPool
    // emits MVT bytes with `_layer = sourceName`, so VTR must look up
    // by `targetName` to match. Without this fallback, filtered shows
    // (wealthy/top_economies in filter_gdp) computed sliceLayer='__hash'
    // while the worker emitted 'countries__hash' — mismatch dropped
    // their tiles silently. show-source-maps.ts mirrors this fallback
    // so the worker emits keys matching what VTR will look up.
    const effectiveSourceLayer = show.sourceLayer || show.targetName || ''
    const sliceLayer = computeSliceKey(effectiveSourceLayer, show.filterExpr?.ast ?? null)
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
        this._drawStats.setTrace(sliceLayer, phase)
      } else {
        this._drawStats.setTrace(null, null)
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
    if (bindGroupLayout !== this._bindGroups.baseLayout()
        && !this._bindGroups.featureGroup()
        && this._featureBinder.latestVariantFieldsLength() === 0) return

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
    this._drawStats.resetRenderedDraws()
    // _missedTiles is FRAME-scoped, not render-scoped — beginFrame()
    // resets it to 0. Multiple render() calls within one frame
    // (one per ShowCommand for sliced sources like PMTiles 4-layer)
    // ACCUMULATE into the same counter so map.ts's
    // hasPendingSourceWork sees the true frame total. Resetting
    // here would have clobbered earlier layers' miss counts and
    // falsely signaled "no work pending" when only the last
    // layer happened to converge first.
    this.ensureUniformRing()
    // Promote pending uploads first — they're strictly older than anything
    // this frame's tile walk will queue, so servicing them now keeps the
    // "filling in" order correct (near-z-to-current first).
    this.drainPendingUploads()

    const maxLevel = this.source.maxLevel
    // DSFUN precision lets sub-tiles work at any camera zoom. Clamp to 22
    // to match the camera's universal maxZoom, not the old maxLevel+6.
    // (Still used downstream by the Tier-2 prefetch gate below; the
    // selection method recomputes its own copy internally.)
    const maxSubTileZ = 22

    // Hoisted: visibleTilesFrustum inputs needed both by the selection
    // collaborator (passed into selectForFrame) and by the Tier-2
    // prefetch gate further down. Cheap pure derivations; safe to
    // compute once up here.
    const strokeOffsetPx_h = Math.abs(show.strokeOffset ?? 0)
    // Stroke width — zoom × time already collapsed by the bucket
    // scheduler. ResolvedShow is the SOLE per-frame source.
    const strokeWidthPx_h = resolvedShow.strokeWidth
    const alignDeltaPx_h = show.strokeAlign === 'inset' || show.strokeAlign === 'outset'
      ? strokeWidthPx_h / 2 : 0
    const offsetMarginPx = Math.ceil(strokeOffsetPx_h + alignDeltaPx_h + strokeWidthPx_h / 2 + 2)
    // Projection-aware tile selection: the flat selectors project tile
    // corners through THIS projection's forward (relative to the projected
    // centre), matching the GPU vertex path, so equirect / natural_earth
    // select the right tiles at the poles + dateline (previously they used
    // Mercator's forward and went blank at high latitude — user report
    // project_projection_issues_2026_05_18 #4). Built with the same centre
    // (projCenterLon/Lat) the GPU uses as proj_params.y/z. The azimuthal
    // family (3/4/5), oblique (6) and globe (7) sphere-route, so their
    // selectorProj is unused — fall back to mercatorProj (globe has no
    // flat-projection entry in the registry).
    const selectorProj: Projection = (projType >= 1 && projType <= 6)
      ? getProjection(SELECTOR_PROJ_NAMES[projType]!, projCenterLon, projCenterLat)
      : mercatorProj

    // Per-frame visible-tile selection + zoom-transition hysteresis +
    // readiness gate. The selection collaborator owns the cross-frame
    // hysteresis/readiness state + the per-frame tile memo + the
    // selection scratch arrays; it touches ZERO GPU state. It returns
    // null when this layer's currentZ falls below the slice minzoom
    // (the per-MVT-layer cull that used to `return` inline here) —
    // skip the render() for this ShowCommand in that case.
    const sel = this._selection.selectForFrame(
      camera, projType, projCenterLon, projCenterLat,
      canvasWidth, canvasHeight, dpr,
      this.currentFrameId, this.source, sliceLayer, offsetMarginPx, maxLevel,
      this._drawStats,
    )
    if (!sel) return
    const {
      tiles, neededKeys, protectedAncestors, worldOffDeg,
      parentAtMaxLevel, archiveAncestor, currentZ, cameraIdle,
    } = sel

    if (currentZ !== this.lastZoom) this.lastZoom = currentZ
    this.currentCameraZoom = camera.zoom

    // Display-projection MVP: `getViewForProjection` returns the flat 2D
    // Mercator-plane MVP for flat Mercator (projType 0) and the ECEF-MVP
    // for 3D / globe (and, in Phase 1, every other projType). The polygon /
    // line VS branches on `proj_params.x` to consume the matching matrix
    // (flat → `project(abs)−cam` 2D-plane metres; 3D → ECEF-RTC). The
    // returned `matrix` reference is overwritten by the next call from the
    // same camera — copy into the uniform mirror immediately. Both paths
    // return the same far-plane in non-globe mode, so `logDepthFc` matches.
    const frame = camera.getViewForProjection(projType, canvasWidth, canvasHeight, dpr)
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
    // Mapbox `fill-extrusion-base` — wall BOTTOM z. Constant form
    // packs into u.extrude_base_m; feature form falls back to the
    // declared fallback for the uniform mirror (per-feature base
    // needs its own attribute, deferred). Absent → 0 (flat ground).
    if (show.extrudeBase && show.extrudeBase.kind === 'constant') {
      this.currentExtrudeBase = show.extrudeBase.value
    } else if (show.extrudeBase && show.extrudeBase.kind === 'feature') {
      this.currentExtrudeBase = show.extrudeBase.fallback
    } else {
      this.currentExtrudeBase = 0
    }
    // Mapbox fill-/line-translate — bake CSS px → NDC-per-pixel (`2 /
    // canvasDim`); vertex shader multiplies by clip.w so the offset stays
    // pixel-constant after the perspective divide. WS-1 reads the PER-FRAME
    // resolved offset from ResolvedShow (zoom-interp shapes already collapsed
    // to a scalar; constant forms pass through). translate-anchor=map:
    // rotateTranslateForAnchor rotates (dx,dy) by the map bearing so the
    // offset tracks the MAP world axes (MapLibre map-anchor). Default
    // anchor=viewport returns (dx,dy) untouched → byte-identical historical
    // screen-space path. (Pitch foreshortening of a map-anchored offset is
    // not reproduced by this clip-space bake; bearing rotation is the flat
    // behaviour.)
    const bearingDeg = camera.bearing ?? 0
    const [ftx, fty] = rotateTranslateForAnchor(
      resolvedShow.fillTranslateX, resolvedShow.fillTranslateY, show.fillTranslateAnchorMap, bearingDeg)
    this.currentFillTranslateNdcX = ftx !== 0 ? (ftx * 2) / canvasWidth : 0
    this.currentFillTranslateNdcY = fty !== 0 ? (fty * 2) / canvasHeight : 0
    const [ltx, lty] = rotateTranslateForAnchor(
      resolvedShow.strokeTranslateX, resolvedShow.strokeTranslateY, show.strokeTranslateAnchorMap, bearingDeg)
    this.currentStrokeTranslateNdcX = ltx !== 0 ? (ltx * 2) / canvasWidth : 0
    this.currentStrokeTranslateNdcY = lty !== 0 ? (lty * 2) / canvasHeight : 0
    // Mapbox fill-antialias / fill-extrusion-vertical-gradient opt-outs.
    // Default (undefined / true) → 1 (current behavior, byte-identical).
    // Explicit false → 0; the WGSL gates the rim-smoothstep / vertical-
    // gradient ramp on `!= 0`. Packed into cam_ecef_off_{h,l}.w below.
    this.currentFillAntialias = show.fillAntialias === false ? 0 : 1
    this.currentFillVerticalGradient = show.fillExtrusionVerticalGradient === false ? 0 : 1
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
    // the variant pipeline (fillIsDefault === false), so cachedFillColor
    // can be [0,0,0,0] yet the draw is still meaningful — must keep it.
    // Phase 2.5 US-002 — the legacy default-uniform string compare on
    // variantFillExpr moved to the typed `fillIsDefault` sentinel flag,
    // exposed via the shared variantProducesFill() helper.
    this._skipFillDraw = !variantProducesFill(show.shaderVariant) && this.cachedFillColor[3] <= 0.005

    // Write uniforms directly via cached Float32Array view (no new typed array allocations)
    const uf = this.uniformF32
    uf.set(mvp, US.mvp) // mvp (16 floats) — ECEF-MVP (post PR 2d.5)
    // iter-183 — fill-pattern Stage 2 packs the sprite atlas UV bbox
    // into the fill_color slot instead of the resolved RGBA.
    // fs_fill_pattern reads (u0, v0, u1, v1) from u.fill_color. The
    // pattern repeat in metres is written to the fill_translate slots below
    // (overriding the fill-translate NDC values). Both overrides
    // apply ONLY when the show has a resolved pattern bbox + the
    // pattern pipeline path is wired by the caller (setPatternPipelines).
    const patternUV = show.fillPatternUV
    const patternRepeat = show.fillPatternRepeatM
    const patternSlotsActive = patternUV != null && patternRepeat != null
      && this._bindGroups.patternGroundPipeline() !== null
    if (patternSlotsActive) {
      uf[US.fill_color] = patternUV![0]; uf[US.fill_color + 1] = patternUV![1]
      uf[US.fill_color + 2] = patternUV![2]; uf[US.fill_color + 3] = patternUV![3]
      this._patternUniformActive = true
      this._patternRepeatMX = patternRepeat![0]
      this._patternRepeatMY = patternRepeat![1]
    } else {
      uf[US.fill_color] = this.cachedFillColor[0]; uf[US.fill_color + 1] = this.cachedFillColor[1]
      uf[US.fill_color + 2] = this.cachedFillColor[2]; uf[US.fill_color + 3] = this.cachedFillColor[3] * this.currentOpacity
      this._patternUniformActive = false
    }
    // iter-185 — line-pattern Stage 2 packs the sprite atlas UV bbox
    // into the stroke_color slot (20-23). fs_line_pattern reads
    // (u0, v0, u1, v1) from tile.stroke_color. Pattern shows trade
    // their solid stroke colour for the atlas sample; documented in
    // the line-pattern partial → supported promotion (iter 186).
    const linePatternSlotsActive = show.linePatternUV != null
      && show.linePatternRepeatM != null
      && this.lineRenderer != null
    this._linePatternActiveForShow = linePatternSlotsActive
    if (linePatternSlotsActive) {
      const lu = show.linePatternUV!
      uf[US.stroke_color] = lu[0]; uf[US.stroke_color + 1] = lu[1]; uf[US.stroke_color + 2] = lu[2]; uf[US.stroke_color + 3] = lu[3]
    } else {
      uf[US.stroke_color] = this.cachedStrokeColor[0]; uf[US.stroke_color + 1] = this.cachedStrokeColor[1]
      uf[US.stroke_color + 2] = this.cachedStrokeColor[2]; uf[US.stroke_color + 3] = this.cachedStrokeColor[3] * this.currentOpacity
    }
    // proj_params + globe_eye written TOGETHER (frame-invariant; coupled so the
    // #600 "projection set, eye forgotten" leak is unrepresentable). frame.eye is
    // the globe/ECEF camera position (undefined off the globe → globe_eye zero).
    writeFrameProjectionUniform(uf, projType, projCenterLon, projCenterLat, frame.eye)

    // Allocate + write SDF line layer slot for this render() call. All
    // drawSegments() calls below will use this same byte offset.
    // In 'fills' phase no drawSegments runs, so skip the allocation entirely
    // to avoid ring-slot churn, redundant pattern-param warnings, and any
    // incidental validation surface in the translucent fill pre-pass.
    let lineLayerOffset = 0
    // Mapbox `line-gap-width` double-draw second offset. When
    // show.strokeGapWidth > 0 the line renders as TWO parallel
    // strokes; this holds the second layer-slot uniform offset.
    // -1 sentinel = no second draw (single-line legacy path).
    let lineLayerOffsetGap = -1
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
      // Mapbox GL spec defaults for OMITTED line-cap/join/miter-limit:
      // butt / miter / 2 (the converter emits a utility only when the layer
      // SETS them). Sharp miters bevel-fall-back in line-segment-build.ts.
      const cap = capMap[show.linecap ?? 'butt']
      const join = joinMap[show.linejoin ?? 'miter']
      const miterLimit = show.miterlimit ?? 2.0
      // Mapbox line-round-limit (default 1.05). Unset → 0, which the line
      // shader reads as "use the historical round-join fold threshold"
      // (byte-identical to pre-feature behaviour); a positive value scales
      // that threshold by round_limit / 1.05.
      const roundLimit = show.roundLimit ?? 0
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
      // WS-1 — prefer the PER-FRAME resolved dash array (zoom-interp STEP)
      // over the static one; constant dash falls through unchanged.
      const dashSrc = resolvedShow.dashArray ?? show.dashArray
      const dash = (dashSrc && dashSrc.length >= 2)
        ? {
            array: dashSrc.map(v => v * dashWidthScalePx * mpp),
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

      // Mapbox line-gap-width: render the line as TWO parallel
      // strokes with perpendicular offsets ±(gap + stroke) / 2.
      // OFM Liberty waterway_tunnel is the only fixture hit. Zero or
      // absent gap stays on the legacy single-line path. The half-
      // offset is added/subtracted from `effectiveOffset` so existing
      // alignment + explicit offset stack correctly (a line authored
      // with stroke-offset-right-2 + line-gap-width:6 + line-width:1
      // ends up with one stroke at offset 2 + 3.5 = 5.5 and one at
      // offset 2 − 3.5 = −1.5).
      const gapWidth = show.strokeGapWidth ?? 0
      const halfGap = gapWidth > 0 ? (gapWidth + strokeWidthPx) / 2 : 0

      // iter-185 — line-pattern Stage 2 override. When the show has a
      // resolved pattern repeat, replace strokeColor.r / .a with the
      // x / y repeat metres (fs_line_pattern reads layer.color.r/.a
      // as repeat axes). Stage 1 resolvedStrokeRgba is lost on the
      // pattern path, but the sprite atlas sample provides the visual
      // colour band — documented Stage 2 trade-off (mirror of
      // fill-pattern's fill_color slot reuse).
      const linePatternActive = show.linePatternUV != null && show.linePatternRepeatM != null
      const lineSlotColor: [number, number, number, number] = linePatternActive
        ? [show.linePatternRepeatM![0], 0, 0, show.linePatternRepeatM![1]]
        : [this.cachedStrokeColor[0], this.cachedStrokeColor[1], this.cachedStrokeColor[2], this.cachedStrokeColor[3]]

      lineLayerOffset = this.lineRenderer.writeLayerSlot(
        lineSlotColor,
        strokeWidthPx,
        layerOpacity,
        mpp,
        cap,
        join,
        miterLimit,
        dash,
        patternSlots,
        effectiveOffset + halfGap,
        canvasHeight,
        show.strokeBlur ?? 0,
        dpr,
        this.currentStrokeTranslateNdcX,
        this.currentStrokeTranslateNdcY,
        roundLimit,
      )
      if (gapWidth > 0) {
        lineLayerOffsetGap = this.lineRenderer.writeLayerSlot(
          [this.cachedStrokeColor[0], this.cachedStrokeColor[1], this.cachedStrokeColor[2], this.cachedStrokeColor[3]],
          strokeWidthPx,
          layerOpacity,
          mpp,
          cap,
          join,
          miterLimit,
          dash,
          patternSlots,
          effectiveOffset - halfGap,
          canvasHeight,
          show.strokeBlur ?? 0,
          dpr,
          this.currentStrokeTranslateNdcX,
          this.currentStrokeTranslateNdcY,
          roundLimit,
        )
      }
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
    // iter-255 — scratch reuse + length reset. Clear prior values
    // by setting indices to undefined inside the loop below
    // (decision always assigned per tile in the for loop).
    const _tileDecisions = this._scratchTileDecisions
    _tileDecisions.length = tiles.length
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
          // Non-empty predicate: single-layer GeoJSON stores an empty
          // placeholder (zero geometry) under the default '' slice for
          // tiles with no features; hasTileData reports it as cached.
          // Report it as NOT-cached here so the empty default slice
          // classifies as drop-empty instead of queued-with-fallback.
          hasNonEmptySliceInCatalog: (k) => {
            if (layerCache.has(k)) return true
            const d = this.source!.getTileData(k, sliceLayer)
            return !!d && (d.vertices.length > 0 || d.lineVertices.length > 0 || (d.pointVertices?.length ?? 0) > 0 || !!d.fullCover)
          },
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
          perfMarkStart('vtr.upload')
          if (data) this.doUploadTile(decision.parentKey, data, sliceLayer)
          perfMarkEnd('vtr.upload')
        }
        continue
      }

      anyInArchive = true
      if (decision.kind === 'primary') continue
      if (decision.kind === 'drop-empty-slice') continue
      if (decision.kind === 'drop-no-archive') {
        const t = tiles[i]
        const wKey = `no-ancestor:${t.z}/${t.x}/${t.y}`
        if (maxLevel > 0 && !this._drawStats.hasWarned(wKey)) {
          this._drawStats.markWarned(wKey)
          xlog.warn(`[VTR tile-drop] no ancestor found for ${t.z}/${t.x}/${t.y} — dropping from render (maxLevel=${maxLevel}).`)
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
          perfMarkStart('vtr.upload')
          this.doUploadTile(inner.parentKey, this.source.getTileData(inner.parentKey, sliceLayer)!, sliceLayer)
          perfMarkEnd('vtr.upload')
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
          perfMarkStart('vtr.upload')
          if (childData) this.doUploadTile(ck, childData, sliceLayer)
          perfMarkEnd('vtr.upload')
        }
        for (const ck of inner.childKeys) {
          fallbackKeys.push(ck)
          fallbackOffsets.push(worldOffDeg[i])
          fallbackVisibleKeys.push(key)
        }
      } else if (inner.kind === 'pending') {
        if (inner.requestKey !== null) toLoad.push(inner.requestKey)
        this._drawStats.recordMissedTile()
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
    this._drawStats.clearDecisionCounts()
    for (let i = 0; i < tiles.length; i++) {
      const d = _tileDecisions[i] ?? 'untracked'
      this._drawStats.incDecisionCount(d)
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
    {
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
      if (this.source.cancelStale) this.source.cancelStale(activeKeys)
      // Same active-set for the renderer-side upload queue. Without
      // this, the queue accumulates hundreds of stale `uploadTile`
      // jobs across fast zoom+pan and per-frame maxJobs (4-8) can't
      // drain fast enough — new visible tiles never reach the GPU and
      // parent-fallback fills persist. See cancelStaleUploads doc.
      this.cancelStaleUploads(activeKeys)
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
      const groundIsBase = bindGroupLayout === this._bindGroups.baseLayout()
      // ?debug=overdraw: VTR's internal `fillPipelineGround` targets the
      // swapchain format, but the caller's `fillPipelineGroundOverride`
      // is the r16float debug variant. Always prefer the override here
      // so the entire opaque pass agrees on the r16float attachment.
      const groundForLayout: GPURenderPipeline | null = DEBUG_OVERDRAW
        ? (fillPipelineGroundOverride ?? fillPipeline)
        : (groundIsBase
            ? this._bindGroups.groundPipeline()
            : (fillPipelineGroundOverride ?? null))
      // iter-183 — fill-pattern Stage 2 routing. When the show has a
      // resolved pattern UV bbox AND the variant pipeline path isn't
      // active AND we're not in DEBUG_OVERDRAW (r16float surface),
      // swap the ground pipeline for the pattern variant. The pattern
      // pipeline uses the same base bindGroupLayout, so it's only
      // valid on the `groundIsBase` path; variant + feature-data
      // pattern shows fall through to the generic fillPipeline
      // (visual fallback to solid Stage-1 colour, not crash).
      const patternActive = !DEBUG_OVERDRAW
        && groundIsBase
        && show.fillPatternUV != null
        && this._bindGroups.patternGroundPipeline() !== null
      const groundChoice = patternActive
        ? this._bindGroups.patternGroundPipeline()
        : groundForLayout
      const mainFill = this.currentExtrudeMode === 'none' && groundChoice !== null
        ? groundChoice
        : fillPipeline
      // iter-186 — fill-extrusion-pattern Stage 2: when the extruded
      // pattern pipeline is wired and the show has a resolved pattern
      // UV bbox, route per-feature extruded draws to the pattern
      // variant. Same gate as the ground path.
      const extrudedPatternActive = !DEBUG_OVERDRAW
        && groundIsBase
        && show.fillPatternUV != null
        && this._bindGroups.patternExtrudedPipeline() !== null
      const extrudedPipeline = extrudedPatternActive
        ? this._bindGroups.patternExtrudedPipeline()
        : this._bindGroups.extrudedPipeline()
      // iter-220 (Phase RB.B.8) — bundle wrap for the primary
      // opaque pass call. Gated to the main opaque attachment
      // context (excludes OIT, debug overdraw, translucent stroke
      // bucket, the standalone strokes phase). Cache key includes
      // every input that affects the recorded draws OR the bundle
      // descriptor; the next miss re-encodes from scratch.
      //
      // Hit path: re-runs renderTileKeys for state side effects
      // (uniform staging, strokeQueue population) but
      // `_skipFillDrawForBundle` + `_skipStrokeDrawForBundle` mute
      // the actual draw emit. `executeBundles([bundle])` replays
      // the cached commands.
      //
      // Miss path: getOrEncode runs renderTileKeys with the
      // bundle encoder. State side effects + draws recorded into
      // the bundle. `executeBundles` replays into the real pass.
      // iter-270 — bundle ONLY when every needed tile is in layer
      // cache. Partial-set bundles caused the user-reported flicker
      // (2026-05-21 OFM Bright import + wheel zoom):
      //
      //   1. Fast zoom selects new neededKeys; tiles A,B not loaded yet.
      //   2. Bundle encodes — recordTileFill skips A,B (cache miss
      //      inside per-tile loop), records draws for already-loaded
      //      C,D only.
      //   3. Bundle cached under key with ueXor reflecting only C,D's
      //      uploadEpochs (the iter-226 comment "tiles not yet in
      //      layerCache contribute 0" was the design gap).
      //   4. Frame N+1: same neededKeys, same ueXor (A,B still loading,
      //      C,D unchanged) → cache HIT → replays the partial bundle
      //      with A,B missing → polygon fills disappear for A,B until
      //      they finally upload + bump ueXor.
      //   5. Strokes don't hit this because `phase === 'strokes'` skips
      //      the bundle path entirely (line 4303 below), and the
      //      fallback ancestor path is also bundled with the same gap.
      //
      // Gating shouldBundle on the all-loaded invariant eliminates the
      // partial-encode case. During fast zoom we fall through to a
      // direct renderTileKeys call (no bundle, no cache); steady-state
      // (all tiles loaded) keeps the iter-226 97.6% hit rate.
      // iter-277 — bundle path RE-DISABLED. iter-276 re-enable based
      // on iter-275 invariant gate was wrong: gate only tested SINGLE
      // STATIC SCREENSHOT per scene, missed interactive cases.
      // User screenshot iPhone OFM Bright z=7.53/36.97/127.46 + pitch
      // 3.6 shows MOSTLY EMPTY canvas (polygons + lines almost all
      // missing on X-GIS pane). Bundle replay during interactive
      // navigation / pitch produces broken state.
      //
      // Default OFF. Override:
      //   __XGIS_BUNDLE_FORCE_ON = true   to force enable (testing only)
      let allTilesLoaded = true
      for (let i = 0; i < neededKeys.length; i++) {
        if (!layerCache.get(neededKeys[i]!)) { allTilesLoaded = false; break }
      }
      const _bundleForceOn = (globalThis as { __XGIS_BUNDLE_FORCE_ON?: boolean })
        .__XGIS_BUNDLE_FORCE_ON === true
      const shouldBundle = _bundleForceOn
        && !DEBUG_OVERDRAW
        && !translucentBucket
        && phase !== 'strokes'
        && phase !== 'oit-fill'
        && allTilesLoaded
      if (shouldBundle) {
        // iter-281 — structural cache key. Replaces the iter-226 +
        // iter-271 manual concat (kh + ueXor + woh + rebuildEpoch +
        // pickOn + samples + pipeline labels) with a single
        // structuralHashKey() over a typed state literal. Adding a
        // new dependency below = one new property; the hash adapts
        // automatically and downstream cache invalidates correctly
        // without any string-template churn. See _cache/structural-
        // key.ts for the pattern rationale.
        const pickOn = isPickEnabled()
        const samples = getSampleCount()
        const epochs: number[] = new Array(neededKeys.length)
        for (let i = 0; i < neededKeys.length; i++) {
          epochs[i] = layerCache.get(neededKeys[i]!)!.uploadEpoch
        }
        // iter-283 — `satisfies BundleKeyState` enforces every
        // property of the contract is filled. Adding a new dimension
        // to BundleKeyState breaks BOTH call sites here (primary +
        // fallback) until the literal is updated.
        const keyState = {
          sliceLayer,
          phase,
          // Order significant — neededKeys is iteration order, the
          // same order the bundle records draws in.
          neededKeys: neededKeys.slice(),
          epochs,
          worldOffsets: worldOffDeg ? worldOffDeg.map(o => Math.round(o * 1e3)) : null,
          bindGroupEpoch: this._bindGroups.epoch(),
          pickOn,
          samples,
          mainPipelineLabel: mainFill.label ?? null,
          linePipelineLabel: linePipeline.label ?? null,
        } as const satisfies BundleKeyState
        const cacheKey = `vt:${sliceLayer}:${phase}:${structuralHashKey(keyState)}`
        const desc: BundleEncodeDescriptor = {
          colorFormats: pickOn ? [this.format, 'rg32uint'] : [this.format],
          depthStencilFormat: 'depth24plus-stencil8',
          sampleCount: samples,
          depthReadOnly: false,
          stencilReadOnly: false,
          label: cacheKey,
        }
        let wasMiss = false
        const bundle = this.bundleCache.getOrEncode(cacheKey, desc, encoder => {
          wasMiss = true
          this._skipFillDrawForBundle = false
          this._skipStrokeDrawForBundle = false
          this.renderTileKeys(neededKeys, encoder, mainFill, linePipeline, projCenterLon, projCenterLat, worldOffDeg, lineLayerOffset, lineLayerOffsetGap, phase, layerCache, extrudedPipeline, bindGroupLayout, translucentBucket)
        })
        if (!wasMiss) {
          // Cache hit: replay path. Re-run renderTileKeys for state
          // side effects with both skip flags TRUE — recordTileFill
          // + drawSegments no-op; uniform staging + strokeQueue
          // population still happens.
          this._skipFillDrawForBundle = true
          this._skipStrokeDrawForBundle = true
          this.renderTileKeys(neededKeys, pass, mainFill, linePipeline, projCenterLon, projCenterLat, worldOffDeg, lineLayerOffset, lineLayerOffsetGap, phase, layerCache, extrudedPipeline, bindGroupLayout, translucentBucket)
          this._skipFillDrawForBundle = false
          this._skipStrokeDrawForBundle = false
        }
        pass.executeBundles([bundle])
      } else {
        this.renderTileKeys(neededKeys, pass, mainFill, linePipeline, projCenterLon, projCenterLat, worldOffDeg, lineLayerOffset, lineLayerOffsetGap, phase, layerCache, extrudedPipeline, bindGroupLayout, translucentBucket)
      }
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
        _origR = this.uniformF32[US.fill_color]
        _origG = this.uniformF32[US.fill_color + 1]
        _origB = this.uniformF32[US.fill_color + 2]
        this.uniformF32[US.fill_color] = 1.0
        this.uniformF32[US.fill_color + 1] = 0.0
        this.uniformF32[US.fill_color + 2] = 0.0
      }
      // Same layout-matched ground pickup as the primary path —
      // base layout uses the renderer-level fallback ground; feature
      // layout uses the variant's fallback ground override.
      const fallbackGroundIsBase = bindGroupLayout === this._bindGroups.baseLayout()
      const fallbackGroundForLayout: GPURenderPipeline | null = DEBUG_OVERDRAW
        ? (fillPipelineGroundFallbackOverride ?? fillPipelineFallback ?? null)
        : (fallbackGroundIsBase
            ? this._bindGroups.groundPipelineFallback()
            : (fillPipelineGroundFallbackOverride ?? null))
      // iter-183 — fill-pattern Stage 2 fallback routing (mirror of
      // the primary path above).
      const fallbackPatternActive = !DEBUG_OVERDRAW
        && fallbackGroundIsBase
        && show.fillPatternUV != null
        && this._bindGroups.patternGroundPipelineFallback() !== null
      const fallbackGroundChoice = fallbackPatternActive
        ? this._bindGroups.patternGroundPipelineFallback()
        : fallbackGroundForLayout
      const fallbackFill = this.currentExtrudeMode === 'none' && fallbackGroundChoice !== null
        ? fallbackGroundChoice
        : fillPipelineFallback
      // iter-186 — fill-extrusion-pattern fallback path mirror.
      const fallbackExtrudedPatternActive = !DEBUG_OVERDRAW
        && fallbackGroundIsBase
        && show.fillPatternUV != null
        && this._bindGroups.patternExtrudedPipelineFallback() !== null
      const fallbackExtrudedPipeline = fallbackExtrudedPatternActive
        ? this._bindGroups.patternExtrudedPipelineFallback()
        : this._bindGroups.extrudedPipelineFallback()
      // iter-221 (Phase RB.B.9) — fallback path bundle wrap. Mirror
      // of iter-220's primary-call wrap, applied to the
      // fallbackKeys renderTileKeys invocation. Same gate + same
      // cache key shape, plus the fallback-specific
      // `fallbackVisibleKeys` hash so the per-tile clip_bounds
      // (set from `visibleKeysForClip`) is part of the invalidation
      // surface. Tiles + visibleKeys + offsets together fully
      // describe the recorded draws.
      // iter-270 — mirror the primary path's all-loaded gate. Fallback
      // keys are by construction picked from layerCache, but a fallback
      // entry could in principle be evicted between selection and
      // bundle encode (LRU under tight cap). Cheap guard avoids the
      // same partial-set replay class of bug.
      let fbAllLoaded = true
      for (let i = 0; i < fallbackKeys.length; i++) {
        if (!layerCache.get(fallbackKeys[i]!)) { fbAllLoaded = false; break }
      }
      // iter-277 — fallback path also RE-DISABLED.
      const _fbBundleForceOn = (globalThis as { __XGIS_BUNDLE_FORCE_ON?: boolean })
        .__XGIS_BUNDLE_FORCE_ON === true
      const fbShouldBundle = _fbBundleForceOn
        && !DEBUG_OVERDRAW
        && !translucentBucket
        && phase !== 'strokes'
        && phase !== 'oit-fill'
        && !_debugRed
        && fbAllLoaded
      if (fbShouldBundle) {
        // iter-281 — structural cache key (mirrors primary path; see
        // _cache/structural-key.ts).
        const fbPickOn = isPickEnabled()
        const fbSamples = getSampleCount()
        const fbEpochs: number[] = new Array(fallbackKeys.length)
        for (let i = 0; i < fallbackKeys.length; i++) {
          fbEpochs[i] = layerCache.get(fallbackKeys[i]!)?.uploadEpoch ?? 0
        }
        const fbKeyState = {
          sliceLayer,
          phase,
          // Fallback bundle has no `neededKeys` (the primary side),
          // only fallback tile keys; populate both for uniform shape
          // — the structural hash treats null + the array distinctly.
          neededKeys: fallbackKeys.slice(),
          fallbackKeys: fallbackKeys.slice(),
          fallbackVisibleKeys: fallbackVisibleKeys ? fallbackVisibleKeys.slice() : null,
          epochs: fbEpochs,
          worldOffsets: fallbackOffsets ? fallbackOffsets.map(o => Math.round(o * 1e3)) : null,
          bindGroupEpoch: this._bindGroups.epoch(),
          pickOn: fbPickOn,
          samples: fbSamples,
          mainPipelineLabel: fallbackFill.label ?? null,
          linePipelineLabel: linePipelineFallback?.label ?? null,
        } as const satisfies BundleKeyState
        const fbCacheKey = `vt-fb:${sliceLayer}:${phase}:${structuralHashKey(fbKeyState)}`
        const fbDesc: BundleEncodeDescriptor = {
          colorFormats: fbPickOn ? [this.format, 'rg32uint'] : [this.format],
          depthStencilFormat: 'depth24plus-stencil8',
          sampleCount: fbSamples,
          depthReadOnly: false,
          stencilReadOnly: false,
          label: fbCacheKey,
        }
        let fbWasMiss = false
        const fbBundle = this.bundleCache.getOrEncode(fbCacheKey, fbDesc, encoder => {
          fbWasMiss = true
          this._skipFillDrawForBundle = false
          this._skipStrokeDrawForBundle = false
          this.renderTileKeys(fallbackKeys, encoder, fallbackFill, linePipelineFallback!, projCenterLon, projCenterLat, fallbackOffsets, lineLayerOffset, lineLayerOffsetGap, phase, layerCache, fallbackExtrudedPipeline, bindGroupLayout, translucentBucket, fallbackVisibleKeys)
        })
        if (!fbWasMiss) {
          this._skipFillDrawForBundle = true
          this._skipStrokeDrawForBundle = true
          this.renderTileKeys(fallbackKeys, pass, fallbackFill, linePipelineFallback!, projCenterLon, projCenterLat, fallbackOffsets, lineLayerOffset, lineLayerOffsetGap, phase, layerCache, fallbackExtrudedPipeline, bindGroupLayout, translucentBucket, fallbackVisibleKeys)
          this._skipFillDrawForBundle = false
          this._skipStrokeDrawForBundle = false
        }
        pass.executeBundles([fbBundle])
      } else {
        this.renderTileKeys(fallbackKeys, pass, fallbackFill, linePipelineFallback!, projCenterLon, projCenterLat, fallbackOffsets, lineLayerOffset, lineLayerOffsetGap, phase, layerCache, fallbackExtrudedPipeline, bindGroupLayout, translucentBucket, fallbackVisibleKeys)
      }
      if (_debugRed) {
        this.uniformF32[US.fill_color] = _origR
        this.uniformF32[US.fill_color + 1] = _origG
        this.uniformF32[US.fill_color + 2] = _origB
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
      // Tile-set math extracted to tile-decision.computeZoomDirectionPrefetchKeys
      // (pure, unit-tested). Guard + prefetchTiles side-effect stay inline so
      // execution order/throttle is byte-identical to the prior inline block.
      const prefetchKeys = computeZoomDirectionPrefetchKeys({
        camera,
        cameraZoom: camera.zoom,
        currentZ,
        maxSubTileZ,
        projType: (camera as { projType?: number }).projType ?? 0,
        globeMode: camera.globeMode,
        centerX: camera.centerX,
        centerY: camera.centerY,
        pitch: camera.pitch ?? 0,
        bearing: camera.bearing ?? 0,
        canvasWidth,
        canvasHeight,
        dpr,
        selectorProj,
        offsetMarginPx,
        isCached: sliceCached,
      })
      if (prefetchKeys.length > 0) {
        this.source.prefetchTiles(prefetchKeys)
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
    // Detect "this layer authors point style" across every SizeValue
    // shape. `sizeValueToShape` collapses 'none' to null and emits a
    // typed shape for everything else (constant / data-driven /
    // zoom-interpolated / time-interpolated), so checking
    // `paintShapes.size != null` is the single source of truth.
    // Pre-fix the gate only saw `show.size` (constant) and
    // `show.sizeExpr` (data-driven), so zoom- / time-interpolated
    // sizes flowed past as "no point style" and never drew —
    // fixture_size_zoom surfaced this with `size-[interpolate(zoom,
    // 0, 30, 20, 80)]`. Keep `show.shape` in the OR — shapes can carry
    // point intent independent of a declared size.
    const hasPointStyle = show.paintShapes?.circle.size != null || show.shape !== null
    if (hasPointStyle && pointRenderer && typeof pointRenderer.addTilePoint === 'function') {
      // Phase 2 PR 2d.2 — read ECEF DSFUN stride-9:
      // [ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, feat_id, abs_lon, abs_lat]
      for (const key of this.stableKeys) {
        const tileData = this.source!.getTileData(key, sliceLayer)
        if (!tileData?.pointVertices || tileData.pointVertices.length < 13) continue
        const ptv = tileData.pointVertices
        for (let i = 0; i < ptv.length; i += 13) {
          pointRenderer.addTilePoint(
            ptv[i], ptv[i + 1], ptv[i + 2],   // ex_h, ey_h, ez_h
            ptv[i + 3], ptv[i + 4], ptv[i + 5], // ex_l, ey_l, ez_l
            ptv[i + 6],                          // feat_id
            ptv[i + 7], ptv[i + 8],              // abs_lon, abs_lat (cull)
            ptv[i + 9], ptv[i + 10], ptv[i + 11], ptv[i + 12], // merc DSFUN mx_h,mx_l,my_h,my_l
          )
        }
      }
      pointRenderer.flushTilePoints(pass, camera, projType, projCenterLon, projCenterLat, canvasWidth, canvasHeight, show, dpr)
    }
  }

  /** iter-217 (Phase RB.B.5) — flag set by a future caller to gate
   *  the recordTileFill draw emit. When true, recordTileFill skips
   *  the 6 GPU commands (bundle replay handles them instead). The
   *  caller still runs renderTileKeys for per-frame state side
   *  effects (uniform staging, strokeQueue population) — only the
   *  fill-draw recording is bypassed.
   *
   *  Default false. Pixel-match identical to iter-216 when no
   *  caller flips it. iter-218 introduces the actual bundle wrap
   *  that sets this true during the replay path. */
  private _skipFillDrawForBundle: boolean = false

  /** iter-219 (Phase RB.B.7) — sibling of `_skipFillDrawForBundle`
   *  for the stroke (drawSegments) draws emitted at the tail of
   *  renderTileKeys. When the bundle includes strokes (phase ===
   *  'all' on the opaque pass), a cache-hit replay path that
   *  re-runs renderTileKeys for state side effects must NOT
   *  re-emit strokes to the real pass — `executeBundles([bundle])`
   *  already replays them. This flag gates the two `drawSegments`
   *  call sites inside renderTileKeys (one for outlines, one for
   *  lines). Default false. */
  private _skipStrokeDrawForBundle: boolean = false

  /** iter-216 (Phase RB.B.4) — bundle-compatible per-tile fill draw
   *  recording. The 6 GPU commands here are EXACTLY the subset
   *  accepted by both `GPURenderPassEncoder` and
   *  `GPURenderBundleEncoder`, so a future iter (iter-217+) can
   *  pass a `GPURenderBundleEncoder` instead of a render pass to
   *  build a cached bundle without re-tracing the per-tile
   *  conditionals (OIT / extruded / pattern routes).
   *
   *  Side-effect free besides the GPU commands — `slotOffset` is
   *  pre-resolved by the caller (`allocUniformSlot` + stage), and
   *  `cached` carries the arena offsets (iter-208/209/210 Phase
   *  6a). When `bindZBuffer` is true, slot 1 is bound to the
   *  z-arena slice (extruded / OIT-extrude paths).
   *
   *  Pipeline gating (OIT vs extruded vs ground) stays in the
   *  caller — the choice is reflected in `pipeline` + `bindZBuffer`.
   *
   *  iter-217 — early-returns when `_skipFillDrawForBundle` is true
   *  so the caller's bundle-replay path can run renderTileKeys for
   *  state side effects without re-recording the draws (bundle
   *  already carries them). */
  private recordTileFill(
    encoder: GPURenderPassEncoder | GPURenderBundleEncoder,
    pipeline: GPURenderPipeline,
    tileBg: GPUBindGroup,
    slotOffset: number,
    cached: GPUTile,
    bindZBuffer: boolean,
  ): void {
    if (this._skipFillDrawForBundle) return
    // DIAGNOSTIC ONLY — `window.__xgisMaxTiles` caps the actual fill DRAWS per
    // frame (nearest-first, since the draw loop visits camera-priority order),
    // so the perf A/B truly tests "fewer draws = faster". Unlike the selection
    // cap (defeated by fallback back-fill), this reduces the real GPU draw
    // count. No-op when unset → production behaviour byte-identical.
    if (typeof window !== 'undefined') {
      const cap = (window as { __xgisMaxTiles?: number | null }).__xgisMaxTiles
      if (typeof cap === 'number' && cap >= 0) {
        if (this._diagFillsThisFrame >= cap) return
        this._diagFillsThisFrame++
      }
    }
    // The fill draw — raw, or routed through the RHI Material seam — lives in polygon-fill-material.ts
    // (recordFillDraw) so this renderer stays under its size ratchet. The arena vertex/index sub-ranges
    // + the optional extrude z-buffer (slot 1) are carried on `cached`; the stencil ref + the bundle
    // skip stay here, one level up.
    recordFillDraw(this._fillRhi, encoder, pipeline, tileBg, slotOffset, cached, bindZBuffer)
  }

  /** iter-214 (Phase RB.B.3) — `pass` parameter type widened to also
   *  accept `GPURenderBundleEncoder` so a future caller can record
   *  the per-tile draw loop into a cached bundle. Every method this
   *  function calls on `pass` (`setPipeline`, `setBindGroup`,
   *  `setVertexBuffer`, `setIndexBuffer`, `drawIndexed`) is in BOTH
   *  interfaces' common subset. The pass-only calls
   *  (`setStencilReference`) live ONE level up in the calling site
   *  (line ~4077 / ~4167) so they wrap any future bundle replay. */
  private renderTileKeys(
    keys: number[],
    pass: GPURenderPassEncoder | GPURenderBundleEncoder,
    fillPipeline: GPURenderPipeline,
    _linePipeline: GPURenderPipeline,
    projCenterLon: number,
    projCenterLat: number,
    worldOffsets: number[] | undefined,
    lineLayerOffset: number,
    /** Second layer-slot uniform offset for line-gap-width double-
     *  draw. -1 sentinel = single-line legacy path (no second draw).
     *  When ≥ 0, the strokeQueue iterates twice — once per offset —
     *  producing the two parallel strokes that compose a road casing. */
    lineLayerOffsetGap: number,
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
    const fillBg = fillBindGroupLayout === this._bindGroups.baseLayout()
      ? this._bindGroups.baseGroup()
      : this._bindGroups.featureGroup()
    // For featureBindGroupLayout the source-level `tileBgFeature` is
    // null in the MVT/PMTiles path (each tile owns its own
    // featureBindGroup). Don't early-return on that case — per-tile
    // bind group resolution happens inside the keys loop. baseBindGroup
    // is constant-fill and never per-tile, so its absence still aborts.
    if (fillBindGroupLayout === this._bindGroups.baseLayout() && !fillBg) return
    if (!this.uniformRing?.buffer) return
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
      if (this._drawStats.hasDrawn(drawKey)) continue
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
      // iter-183/185 — when a pattern is active, render() packed the sprite
      // atlas UV bbox into the fill_color slot (fill, v1 = fill_color.a) / the
      // stroke_color slot (line, v1 = stroke_color.a). The fragment shader reads
      // fill_color.a / stroke_color.a as the pattern's v1; clobbering it with the
      // alpha here corrupts the UV (black/garbage pattern). Same guard as the
      // fill_translate slots below — only write the alpha when NO pattern owns the slot.
      if (!this._patternUniformActive) this.uniformF32[US.fill_color + 3] = baseFillA
      if (!this._linePatternActiveForShow) this.uniformF32[US.stroke_color + 3] = baseStrokeA
      // u.opacity for shader variants is written at index 34 (offset 136 in
      // the post PR 2d.5 192-byte layout) in the DSFUN uniform block, below
      // — keep it off the pre-tile pack so we only write it once per slot.

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

      // cam_h (28-29), cam_l (30-31) — offsets 112..127 (post PR 2d.5)
      this.uniformF32[US.cam_h] = camRelXH
      this.uniformF32[US.cam_h + 1] = camRelYH
      this.uniformF32[US.cam_l] = camRelXL
      this.uniformF32[US.cam_l + 1] = camRelYL

      // Camera-relative RTC (ECEF): off = tileEcefCenter − cameraCenter, DSFUN
      // hi/lo at uniform floats 52-54 / 56-58. The polygon VS adds this to
      // ecef_rtc so it projects vertex−cameraCenter through the camera-at-ENU-
      // origin MVP — fixes the 'one spot' collapse (_ecef-render-position gate).
      // ECEF is world-copy-independent on the sphere, so worldOff is NOT
      // applied here (unlike the Mercator cam_h/cam_l).
      //
      // FRAME CONSISTENCY (globe z14 blank-tiles fix): the tile vertices +
      // tileEcefCenter are packed on the WGS84 ELLIPSOID (packECEFPolygonVertices
      // → tileEcefCenterFromMerc → lonLatToECEF, E2≠0). cameraCenter MUST use
      // the SAME ellipsoid, or `off` carries the ellipsoid−sphere discrepancy
      // (~21.5 km at Tokyo lat 35.68°). That offset is sub-pixel at low zoom
      // (0.8 px @ z1.5 → globe renders) but explodes with zoom (4396 px @ z14),
      // throwing every deep-zoom tile thousands of pixels off-screen → blank.
      // Previously cameraCenter used a SPHERE (plain R, no E2) — the mismatch.
      // Both terms on the ellipsoid makes `off` a pure ellipsoid-frame delta
      // (≈ km, frame-consistent); the residual sphere-MVP error is only the
      // ellipsoid−sphere of the LOCAL patch (≈ tens of m = a few px at z14,
      // within the documented 1.7 px ECEF-MVP parity tolerance).
      const E2_ECEF = (1 / 298.257223563) * (2 - 1 / 298.257223563)
      const tLatR = clampLat(cached.tileSouth) * DEG2RAD
      const tLonR = cached.tileWest * DEG2RAD
      const tSin = Math.sin(tLatR), tCos = Math.cos(tLatR)
      const tN = R / Math.sqrt(1 - E2_ECEF * tSin * tSin)
      const camLatR = clampLat(projCenterLat) * DEG2RAD
      const camLonR = projCenterLon * DEG2RAD
      const camSin = Math.sin(camLatR), camCos = Math.cos(camLatR)
      const cN = R / Math.sqrt(1 - E2_ECEF * camSin * camSin)
      const offX = tN * tCos * Math.cos(tLonR) - cN * camCos * Math.cos(camLonR)
      const offY = tN * tCos * Math.sin(tLonR) - cN * camCos * Math.sin(camLonR)
      const offZ = tN * (1 - E2_ECEF) * tSin - cN * (1 - E2_ECEF) * camSin
      const hi = (v: number) => Math.fround(v)
      this.uniformF32[US.cam_ecef_off_h] = hi(offX); this.uniformF32[US.cam_ecef_off_l] = Math.fround(offX - hi(offX))
      this.uniformF32[US.cam_ecef_off_h + 1] = hi(offY); this.uniformF32[US.cam_ecef_off_l + 1] = Math.fround(offY - hi(offY))
      this.uniformF32[US.cam_ecef_off_h + 2] = hi(offZ); this.uniformF32[US.cam_ecef_off_l + 2] = Math.fround(offZ - hi(offZ))
      // Mapbox opt-out flags ride the spare .w lanes of the two
      // cam_ecef_off vec4s (the VS only reads .xyz, so .w is free):
      //   cam_ecef_off_h.w (f32 55) = fill-antialias    (1 default, 0 = off)
      //   cam_ecef_off_l.w (f32 59) = fill-extrusion-vertical-gradient
      // Zero-cost when both are at their default 1 (current render path).
      this.uniformF32[US.cam_ecef_off_h + 3] = this.currentFillAntialias
      this.uniformF32[US.cam_ecef_off_l + 3] = this.currentFillVerticalGradient

      // light_dir_ecef (60-62) — #420. The extrude VS dots the per-vertex ECEF
      // face_normal against this; the raw MapLibre light (0.288,-0.498,0.996)
      // is a tile/viewport-frame constant, so against an ECEF normal it gave
      // arbitrary per-face brightness (roof mid, one wall spikes to 1, rest at
      // the 0.5 dark floor). Rotate it as (East,North,Up) into ECEF by the
      // camera-anchor ENU→ECEF basis — the SAME basis polygon-mesh.ts uses for
      // the wall/roof normals (East=(-sLon,cLon,0), North=(-sLat·cLon,
      // -sLat·sLon,cLat), Up=(cLat·cLon,cLat·sLon,sLat)) → roof brightest,
      // walls in MapLibre's band (CPU-oracle confirmed). .w (63) spare.
      const camSinLon = Math.sin(camLonR), camCosLon = Math.cos(camLonR)
      // WS-9 — convert the Mapbox light position [radius, azimuth°, polar°]
      // to an (East,North,Up) direction via MapLibre's sphericalToCartesian
      // (azimuth +90° so 0° points north). The default [1.15,210,30]
      // reproduces the old baked (0.288,-0.498,0.996).
      const [lRad, lAz, lPol] = this._lightPosition
      const lAzR = (lAz + 90) * DEG2RAD, lPolR = lPol * DEG2RAD
      const LE = lRad * Math.cos(lAzR) * Math.sin(lPolR)
      const LN = lRad * Math.sin(lAzR) * Math.sin(lPolR)
      const LU = lRad * Math.cos(lPolR)
      this.uniformF32[US.light_dir_ecef] = Math.fround(LE * (-camSinLon) + LN * (-camSin * camCosLon) + LU * (camCos * camCosLon))
      this.uniformF32[US.light_dir_ecef + 1] = Math.fround(LE * (camCosLon) + LN * (-camSin * camSinLon) + LU * (camCos * camSinLon))
      this.uniformF32[US.light_dir_ecef + 2] = Math.fround(/* LE*0 */ LN * (camCos) + LU * (camSin))
      // WS-9 — intensity → light_dir_ecef.w (slot 63); colour → RGBA8 packed
      // into light_color_packed (slot 50). The extrude VS reads both; all
      // other variants ignore them. Default (0.5, white) = pre-WS-9 consts.
      this.uniformF32[US.light_dir_ecef + 3] = this._lightIntensity
      const lc = this._lightColor
      const lr8 = Math.max(0, Math.min(255, Math.round(lc[0] * 255)))
      const lg8 = Math.max(0, Math.min(255, Math.round(lc[1] * 255)))
      const lb8 = Math.max(0, Math.min(255, Math.round(lc[2] * 255)))
      // unpack4x8unorm order: .x = byte 0 (LSB) = r, … so pack r|g<<8|b<<16.
      this.uniformU32[US.light_color_packed] = (lr8 | (lg8 << 8) | (lb8 << 16) | (255 << 24)) >>> 0

      // (proj_params + globe_eye are frame-invariant — written once per frame in
      // render() via writeFrameProjectionUniform, and persist in this.uniformF32
      // across every per-tile slot stage, exactly like proj_params always has.)

      // tile_origin_merc (32-33) + opacity (34) + log_depth_fc (35)
      // — offsets 128..143. log_depth_fc was cached by camera.getRTCMatrix
      // and is shared across every tile drawn this frame.
      this.uniformF32[US.tile_origin_merc] = Math.fround(tileMercX)
      this.uniformF32[US.tile_origin_merc + 1] = Math.fround(tileMercY)
      this.uniformF32[US.opacity] = this.currentOpacity ?? 1.0
      this.uniformF32[US.log_depth_fc] = this.logDepthFc
      // pick_id (36) — packed (instanceId<<16)|layerId. instanceId is
      // 0 for now; future WORLD_COPIES instancing will pack it here.
      // Cached on the show by XGISMap after LayerIdRegistry.register().
      this.uniformU32[US.pick_id] = this.currentPickId
      // layer_depth_offset (37) — per-layer NDC-z bias to disambiguate
      // coplanar fills under log-depth (filter_gdp at pitch=46.5 z-fight
      // bug, 2026-05-04). 1e-3 per layer was empirically chosen to
      // overcome the log-depth precision compression at moderate pitch
      // (~10 effective bits at 85°). Layer index = pickId & 0xFFFF —
      // pickIds are assigned in style declaration order so this matches
      // the bucket scheduler's draw order.
      this.uniformF32[US.layer_depth_offset] = (this.currentPickId & 0xFFFF) * 1e-3
      // tile_extent_m (38) — tile-local Mercator-meter extent at this
      // tile's zoom. vs_main_quantized dequants pos_norm via this.
      // 2π × R / 2^z; we cache R × 2π once per VTR.
      this.uniformF32[US.tile_extent_m] = TWO_PI_R_EARTH / Math.pow(2, cached.tileZoom)
      // extrude_height_m (39) — 3D building extrusion height in
      // metres. Set in render() from show.sourceLayer (MVP: hard-
      // coded for `buildings`, 0 elsewhere). Per-feature heights
      // via PropertyTable + style `extrude:` syntax are a follow-up.
      this.uniformF32[US.extrude_height_m] = this.currentExtrudeHeight
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
        this.uniformF32[US.clip_bounds] = Math.fround(vWestLon * DEG2RAD * R)
        this.uniformF32[US.clip_bounds + 1] = Math.fround(Math.log(Math.tan(Math.PI / 4 + clampLat(vSouthLat) * DEG2RAD / 2)) * R)
        this.uniformF32[US.clip_bounds + 2] = Math.fround(vEastLon * DEG2RAD * R)
        this.uniformF32[US.clip_bounds + 3] = Math.fround(Math.log(Math.tan(Math.PI / 4 + clampLat(vNorthLat) * DEG2RAD / 2)) * R)
      } else {
        // Sentinel: no clip. Fragment shader's `clip_bounds.x > -1e29`
        // gate skips the discard test entirely.
        this.uniformF32[US.clip_bounds] = -1e30
        this.uniformF32[US.clip_bounds + 1] = 0
        this.uniformF32[US.clip_bounds + 2] = 0
        this.uniformF32[US.clip_bounds + 3] = 0
      }

      // zoom (44) — per-frame CONTINUOUS camera zoom (camera.zoom),
      // cached by render() into this.currentCameraZoom. Read by the
      // palette gradient sample (P3 Step 3c) + zoom-interp fills: the
      // variant shader maps (zoom - zMin) / span into the gradient
      // atlas's U coord. MUST be the fractional camera zoom — using
      // the integer this.lastZoom (tile-selection zoom) snaps fills +
      // gradients at integer boundaries instead of interpolating.
      this.uniformF32[US.zoom] = this.currentCameraZoom
      // extrude_base_m (45) — wall bottom z (Mapbox
      // `fill-extrusion-base`). Reuses the first `_pad_zoom_*` slot
      // without growing the uniform struct past 192 bytes.
      this.uniformF32[US.extrude_base_m] = this.currentExtrudeBase
      // fill-translate NDC-per-px (fill_translate_x/y slots) — pre-baked at
      // render() time using canvasWidth/Height. Vertex shader
      // applies via clip += offset * clip.w so the pixel offset
      // stays constant regardless of depth. iter-183 — pattern shows
      // overwrite the same slots with the pattern repeat in Mercator
      // metres (fs_fill_pattern reads u.fill_translate as repeat_m
      // for the world-anchored UV). Pattern shows cannot also use
      // fill-translate; documented Stage 2 trade-off.
      if (this._patternUniformActive) {
        this.uniformF32[US.fill_translate_x] = this._patternRepeatMX
        this.uniformF32[US.fill_translate_y] = this._patternRepeatMY
      } else {
        this.uniformF32[US.fill_translate_x] = this.currentFillTranslateNdcX
        this.uniformF32[US.fill_translate_y] = this.currentFillTranslateNdcY
      }

      // tile_dequant_scale (48) + tile_dequant_half (49) — PR 2f per-tile
      // quantized-position dequant. The polygon VS reconstructs each ECEF
      // RTC axis as `q = f32(hi)*65536 + f32(lo); axis = q*scale - half`.
      // These are per-tile (flat: tiler-computed; extruded: wall-mesh-
      // computed post-lift) so they MUST ride the per-tile uniform slot —
      // never a batched draw (confirmed: setBindGroup uses a per-tile
      // dynamic slotOffset, one alloc per tile in this loop).
      this.uniformF32[US.tile_dequant_scale] = cached.dequantScale
      this.uniformF32[US.tile_dequant_half] = cached.dequantHalf

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
      // Feature-layout fill: per-tile (MVT) or source-level (GeoJSON) feature bg.
      // Either can be transiently null (e.g. a frame after a projection switch);
      // binding null with a dynamic offset corrupts the whole encoder (every
      // later draw + finish() fail → black screen) → resolve null, skip below.
      const currentTileBg: GPUBindGroup | null = fillBindGroupLayout === this._bindGroups.baseLayout()
        ? this._bindGroups.baseGroup()!
        : (cached.featureBindGroup ?? this._bindGroups.featureGroup() ?? null)
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
          && cached.extruded
          && this._bindGroups.extrudedOITPipeline() !== null
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
              : (this.currentExtrudeMode === 'per-feature' && cached.extruded)
                ? 'extrude'
                : 'fill'
            trace.push({
              seq: trace.length,
              slice: this._drawStats.traceSlice() ?? '?',
              phase: this._drawStats.tracePhase() ?? '?',
              extrude: this.currentExtrudeMode === 'none' ? 'none' : 'feature',
              tileKey: key,
              isFill: true,
              pipelineRoute: route,
              hasZBuffer: cached.extruded,
            })
          }
        }
        // CRITICAL: in the OIT pass, the render pass attachments are
        // the rgba16float / r16float MRT pair, not the main color +
        // pick attachments. Falling through to `fillPipeline` here
        // would attach an OPAQUE-targets pipeline to the OIT pass and
        // trip "Attachment state of RenderPipeline is not compatible
        // with RenderPassEncoder" at every frame's submit. This used
        // to fire when (a) cached.extruded was false on a fallback
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
        if (wantsExtrude && !cached.extruded) {
          if (drawStrokes) strokeQueue.push({ cached, slotOffset })
          continue
        }
        const useExtrudedPipe = !isOitFill
          && this.currentExtrudeMode === 'per-feature'
          && cached.extruded
          && fillPipelineExtruded !== null
        // Debug=overdraw: collapse OIT + extruded paths onto the
        // single overdraw pipeline supplied as `fillPipeline`. The
        // OIT / extruded variants target their own formats which
        // don't match the r16float accumulator attached to this pass.
        const activePipe = DEBUG_OVERDRAW
          ? fillPipeline
          : (useOitPipe
              ? this._bindGroups.extrudedOITPipeline()!
              : useExtrudedPipe
                ? fillPipelineExtruded!
                : fillPipeline)
        // Phase RB.B.4 (iter-216) — bundle-compatible draw recording
        // extracted to `recordTileFill`. The 6 GPU commands below
        // (setPipeline, setBindGroup, setVertexBuffer ×1-2,
        // setIndexBuffer, drawIndexed) are the EXACT subset that
        // GPURenderBundleEncoder accepts. Encapsulating them lets a
        // future iter (iter-217) route through a bundle encoder
        // without re-tracing the conditionals.
        // Skip if feature bg not ready — never bind null (see note above).
        if (currentTileBg) {
          this.recordTileFill(
            pass, activePipe, currentTileBg, slotOffset, cached,
            /* bindZBuffer */ useOitPipe || useExtrudedPipe,
          )
        }
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
      // Mark the dedup key AND fold the per-frame accumulator increments
      // (sum across all render() calls within one frame so getDrawStats()
      // reflects the FRAME total for sliced sources rather than the last
      // layer's stats). Same arithmetic/order as the prior inline block.
      this._drawStats.markDrawn(drawKey, cached.indexCount, cached.lineIndexCount, vc, cached.tileZoom)
    }
    // Second pass: emit every queued stroke draw now that all fills
    // for this layer have written depth. Outline + line-feature
    // drawSegments calls run against the layer's complete depth
    // buffer; with DEPTH_READ_ONLY they don't disturb later layers'
    // depth tests, but their occlusion against THIS layer's own
    // 3D geometry is now correct regardless of tile iteration order.
    if (strokeQueue.length > 0 && this.lineRenderer && !this._skipStrokeDrawForBundle) {
      // iter-219 (Phase RB.B.7) — `_skipStrokeDrawForBundle` gates
      // these two drawSegments call sites. When set true by the
      // bundle replay path, both calls are skipped — the cached
      // bundle's executeBundles already replays the stroke draws.
      // strokeQueue side effects (push from per-tile loop) remain
      // populated for any non-bundle path or stats.
      const currentLineTileBg2 = this._bindGroups.baseGroup()!
      // line-gap-width double-draw: when the second offset slot was
      // written, iterate the strokeQueue with each offset. Single-line
      // (default) draws once. The second pass uses the SAME segment
      // data — only the layer-slot uniform's offset_m differs.
      const offsets = lineLayerOffsetGap >= 0
        ? [lineLayerOffset, lineLayerOffsetGap]
        : [lineLayerOffset]
      for (const lo of offsets) {
        for (let i = 0; i < strokeQueue.length; i++) {
          const { cached, slotOffset } = strokeQueue[i]
          if (cached.outlineSegmentCount > 0 && cached.outlineSegmentBindGroup) {
            this.lineRenderer.drawSegments(pass, currentLineTileBg2, cached.outlineSegmentBindGroup, cached.outlineSegmentCount, slotOffset, lo, translucentLines, this._linePatternActiveForShow)
          }
          if (cached.lineSegmentCount > 0 && cached.lineSegmentBindGroup) {
            this.lineRenderer.drawSegments(pass, currentLineTileBg2, cached.lineSegmentBindGroup, cached.lineSegmentCount, slotOffset, lo, translucentLines, this._linePatternActiveForShow)
          }
        }
      }
    }
    // Emit accumulated per-tile uniforms as one writeBuffer. Still
    // before queue.submit() — the encoded draws read the fresh ring
    // data by WebGPU's submit-ordering guarantees.
    this.flushUniformStaging()
  }

}

