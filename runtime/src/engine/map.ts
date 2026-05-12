// ═══ X-GIS Map — 전체를 연결하는 엔트리포인트 ═══

import { Lexer, Parser, lower, optimize, emitCommands, evaluate, deserializeXGB, resolveImportsAsync, resolveUtilities, resolveColor, tileKey as compilerTileKey, type Program } from '@xgis/compiler'
import type * as AST from '@xgis/compiler'
import { BackgroundRenderer } from './render/background-renderer'
import { getSharedGeoJSONCompilePool } from '../data/workers/geojson-compile-pool'
import { initGPU, resizeCanvas, GPU_PROF, getSampleCount, getMaxDpr, isPickEnabled, type GPUContext } from './gpu/gpu'
import { DEBUG_OVERDRAW } from './debug-flags'
import { OIT_ACCUM_FORMAT, OIT_REVEALAGE_FORMAT, WORLD_MERC, WORLD_COPIES, TILE_PX } from './gpu/gpu-shared'
import { QUALITY, updateQuality, onQualityChange, type QualityConfig } from './gpu/quality'
import { GPUTimer } from './gpu/gpu-timer'
import { Camera } from './projection/camera'
import { MapRenderer, interpolateZoom, interpolateZoomRgba, type ShowCommand } from './render/renderer'
import {
  classifyVectorTileShows as classifyVectorTileShowsImpl,
  groupOpaqueBySource as groupOpaqueBySourceImpl,
  planFrameSchedule,
  type ClassifiedShow as ExternalClassifiedShow,
  type OpaqueGroup as ExternalOpaqueGroup,
} from './render/bucket-scheduler'
import { interpret, type SceneCommands } from './interpreter'
import { lonLatToMercator, type GeoJSONFeatureCollection } from '../loader/geojson'
import { isTileTemplate } from '../data/tile-select'
import { computeSliceKey } from '../data/eval/filter-eval'
import { RasterRenderer } from './render/raster-renderer'
import { PointRenderer } from './render/point-renderer'
import { ShapeRegistry } from './text/sdf-shape'
import { LineRenderer } from './render/line-renderer'
import { PanZoomController, type Controller } from './controller'
import { CanvasRenderer } from './render/canvas-renderer'
import { VectorTileRenderer } from './render/vector-tile-renderer'
import { TextStage } from './text/text-stage'
import {
  LayerIdRegistry, XGISLayer, ListenerRegistry,
  type XGISFeature, type XGISFeatureEvent, type XGISFeatureEventType, type XGISFeatureListener,
} from './layer'
import { EventDispatcher } from './event-dispatcher'
import { TileCatalog } from '../data/tile-catalog'
import { buildShowSourceMaps, type ShowSourceMaps } from './show-source-maps'
import {
  parseHexColor, hexToRgba, featureAnchor,
  applyFilter, applyGeometry,
} from './feature-helpers'
import {
  inspectMapPipeline, captureMapSnapshot, replayMapSnapshot,
  type PipelineInspection, type MapSnapshot, type ReplayResult,
} from './diagnostics'
import { attachPMTilesSource, prewarmVectorTileSource, detectVectorTileFormat } from '../loader/vector-tile-loader'
import { StatsTracker, StatsPanel, type RenderStats } from './stats'
import { toU32Id, pointPatchToFeatureCollection, type PointPatch } from './id-resolver'
import type { GeoJSONFeature } from '../loader/geojson'
// reprojector.ts preserved for future tile-coordinate RTT approach

interface VariantPipelines {
  fillPipeline: GPURenderPipeline
  fillPipelineGround?: GPURenderPipeline
  linePipeline: GPURenderPipeline
  fillPipelineFallback?: GPURenderPipeline
  fillPipelineGroundFallback?: GPURenderPipeline
  linePipelineFallback?: GPURenderPipeline
  // pointer-events: none mirrors (writeMask:0 on the pick attachment).
  fillPipelineNoPick?: GPURenderPipeline
  fillPipelineGroundNoPick?: GPURenderPipeline
  linePipelineNoPick?: GPURenderPipeline
  fillPipelineFallbackNoPick?: GPURenderPipeline
  fillPipelineGroundFallbackNoPick?: GPURenderPipeline
  linePipelineFallbackNoPick?: GPURenderPipeline
}

// ClassifiedShow + OpaqueGroup live in bucket-scheduler.ts so they're
// importable by tests. Local aliases keep the rest of map.ts terse.
type ClassifiedShow = ExternalClassifiedShow
type OpaqueGroup = ExternalOpaqueGroup

/** Structured return type of `XGISMap.inspectPipeline()`. Every field
 *  reports LIVE runtime state (not a simulation) so CPU debug sessions
 *  can correlate a specific frame's tile-selection decisions with the
 *  cache / budget pressure that drove them. */
/** Map.addOverlay options. The text + anchor are required; everything
 *  else has sensible defaults. */
export interface TextOverlayOptions {
  /** Display string. Use `text-transform` via `.transform`. */
  text: string
  /** Geo anchor [lon, lat]. The map projects per frame. */
  anchor: [number, number]
  /** Font size in display pixels. Default 14. */
  size?: number
  /** RGBA fill color (0..1 per channel). Default white. */
  color?: [number, number, number, number]
  /** Optional halo for legibility over busy backgrounds. */
  halo?: { color: [number, number, number, number]; width: number }
  /** Font key to look up in the runtime's font registry. */
  font?: string
  /** Mapbox `text-transform` post-processing. */
  transform?: 'none' | 'uppercase' | 'lowercase'
}

interface TextOverlay {
  text: string
  lon: number
  lat: number
  size: number
  color: [number, number, number, number]
  halo?: { color: [number, number, number, number]; width: number }
  font?: string
  transform?: 'none' | 'uppercase' | 'lowercase'
}

export interface TextOverlayHandle {
  /** Remove the overlay. Idempotent. */
  remove(): void
}


/** Filter the xgis source DSL's `type:` field down to the values
 *  `detectVectorTileFormat` understands. XGIS source `type` can also
 *  be 'raster' / 'geojson' / 'auto' / undefined / arbitrary user string,
 *  none of which are vector tile kinds — return undefined so the
 *  detector falls through to URL-extension sniffing. */
function asVectorTileKind(t: string | undefined): 'pmtiles' | 'tilejson' | 'xgvt' | 'auto' | undefined {
  return t === 'pmtiles' || t === 'tilejson' || t === 'xgvt' || t === 'auto' ? t : undefined
}

export class XGISMap {
  private ctx!: GPUContext
  private camera: Camera
  private renderer!: MapRenderer
  private rasterRenderer!: RasterRenderer
  /** Optional GPU pass timer. Null when timestamp-query is unsupported or
   *  `?gpuprof=1` is not set. When set, the FIRST opaque sub-pass each
   *  frame is timed; samples drain to `getGpuTimings()`. */
  gpuTimer: GPUTimer | null = null
  private pointRenderer!: PointRenderer
  private shapeRegistry: ShapeRegistry | null = null
  private lineRenderer: LineRenderer | null = null
  private running = false
  private projectionName = 'mercator'
  private controller: Controller | null = null

  // Canvas 2D fallback
  private canvasRenderer: CanvasRenderer | null = null
  private useCanvas2D = false

  // SDF text overlay stage. Lazy — first `addOverlay` call instantiates.
  private textStage: TextStage | null = null
  private overlays: TextOverlay[] = []

  // Vector tile sources + renderers (per .xgvt source)
  private vtSources = new Map<string, { source: TileCatalog; renderer: VectorTileRenderer }>()
  private vectorTileShows: { sourceName: string; show: SceneCommands['shows'][0]; pipelines: VariantPipelines | null; layout: GPUBindGroupLayout | null }[] = []
  private vtVariantPipelines: VariantPipelines | null = null

  // Raw data for re-projection
  private rawDatasets = new Map<string, GeoJSONFeatureCollection>()
  private showCommands: SceneCommands['shows'] = []

  /** Stable u16 IDs assigned to each layer in `addLayer` order. Stamped
   *  into the pick texture's G channel via per-layer uniform `pick_id`.
   *  Reset on `rebuildLayers()` so re-projections get a fresh deterministic
   *  assignment. */
  private layerIds = new LayerIdRegistry()

  /** Public DOM-style layer wrappers, keyed by layer name. Reset in
   *  `rebuildLayers()` so a re-projection produces fresh wrappers around
   *  the new ShowCommand objects (the old ones are gone — keeping a
   *  stale wrapper would silently no-op). Same name registered twice in
   *  one rebuild returns the same wrapper. */
  private xgisLayers = new Map<string, XGISLayer>()

  /** Pointer event dispatcher — bridges PanZoomController's onClick /
   *  onPointerMove callbacks to per-layer addEventListener handlers via
   *  pickAt + the layer registry. Built once in `switchController` and
   *  reused across re-projections. */
  private eventDispatcher: EventDispatcher | null = null

  /** Map-level listener registry — `map.addEventListener('click', h)`
   *  receives every layer hit, like document-level event delegation.
   *  Layer-level dispatch runs first; map-level fires only if no
   *  `preventDefault` was called there. */
  private mapListeners = new ListenerRegistry()

  /** Set whenever the user (or hash sync) explicitly positions the
   *  camera so the post-compile bounds-fit knows not to clobber it.
   *  Reset to `false` at the start of each `run()` so a fresh load
   *  gets the data-fit behaviour. Toggled from:
   *   - `markCameraPositioned()` (public, called by demo-runner after
   *     applyHashToCamera)
   *   - any pan/zoom/rotate gesture in PanZoomController via the
   *     `onPointerMove` / wheel hooks
   *   - `setProjection()` */
  private _cameraExplicitlyPositioned = false

  // External-injection update state (see setSourceData / updateFeature)
  private _pendingPatches = new Map<string, Map<number, { geometry?: GeoJSONFeature['geometry']; properties?: Record<string, unknown> }>>()
  private _pendingFlushHandle: number | null = null
  private _unknownSourceWarned = new Set<string>()
  // Lazy featureId → feature index per source, so flushPendingUpdates can
  // patch in O(patches) instead of O(features). Invalidated on setSourceData
  // (full replace) and rebuilt on demand.
  private _featureIndex = new Map<string, Map<number, GeoJSONFeature>>()

  // Stencil buffer for tile overlap masking
  private stencilTexture: GPUTexture | null = null

  // MSAA 4x render target
  private msaaTexture: GPUTexture | null = null
  // Weighted-Blended OIT render targets. Allocated to canvas size at
  // single sample (compose pass blends onto the resolved main color
  // afterwards). accumTexture: rgba16float — sum of (color × α ×
  // weight, α × weight). revealageTexture: r16float — Π(1 - α). The
  // pair is enough to recover an order-independent approximation of
  // alpha blending in a single translucent draw pass.
  private oitAccumTexture: GPUTexture | null = null
  private oitRevealageTexture: GPUTexture | null = null
  /** `?debug=overdraw` accumulator — every renderer's debug pipeline
   *  writes 1.0 (additive) to this r16float target instead of the
   *  swapchain. A final compose pass colormaps the result to RGBA. */
  private overdrawAccumTexture: GPUTexture | null = null
  private msaaWidth = 0
  private msaaHeight = 0

  // Pick (GPU hover/click) — secondary color attachment that every main-pass
  // pipeline writes `vec2<u32>(feature_id, instance_id)` into. 1-tex design
  // with RG32Uint keeps per-pass overhead to a single extra color-attachment
  // descriptor and 8 bytes/pixel of VRAM. Always allocated (not opt-in) so
  // pipelines have a stable target format; `map.pickAt()` reads back a 1×1
  // at the pointer location via async mapAsync. Kept at single-sample
  // regardless of SAMPLE_COUNT — picking wants deterministic, non-resolved IDs.
  private pickTexture: GPUTexture | null = null
  /** Reusable MAP_READ buffer pool for pickAt() readbacks. Each entry holds
   *  exactly 8 bytes (one RG32Uint pixel) — a ring keeps mapAsync latency
   *  off the hot path. */
  private pickReadbackPool: { buf: GPUBuffer; inUse: boolean }[] = []

  // Stats inspector
  private _stats = new StatsTracker()
  private _statsPanel: StatsPanel | null = null
  /** Last frame (per source) we logged a FLICKER warning. Throttles the
   *  warning to at most once every 60 frames (~1s at 60fps) so normal
   *  on-demand loading doesn't flood the overlay. */
  private _flickerLastFrame = new Map<string, number>()
  /** First frame (per source) at which missedTiles became non-zero. We
   *  expect a burst during the initial 30-ish frames after a source is
   *  added — worker compile lands, then the viewport's leaf tiles
   *  compile on demand at 2/frame. Warning during that window is noise;
   *  a real FLICKER (GPU cache eviction churn, tile-drop regression)
   *  sustains past that horizon. */
  private _flickerFirstFrame = new Map<string, number>()
  private _frameCount = 0
  // Bumped from 60 → 240 (4 s @ 60 fps) — PMTiles world-scale
  // archives at z=0/z=1 trigger massive worker compiles (water +
  // earth polygons spanning the planet) that legitimately take
  // 2–4 seconds on first-load before any slice arrives. The shorter
  // grace fired stale FLICKER warnings for the entire load period
  // even though everything was working as designed.
  private static readonly FLICKER_GRACE_FRAMES = 240
  /** Ring buffer of recent FLICKER dispatches across ALL sources,
   *  keyed by wall-clock time so `inspectPipeline()` can show what
   *  happened in the last few seconds. Capped at 32 entries — the
   *  60-frame throttle keeps the write rate low, so 32 covers ~30s
   *  of the worst sustained case. */
  private _flickerLog: { ts: number; source: string; missed: number; z: number; cache: number }[] = []
  private static readonly FLICKER_LOG_CAP = 32
  /** Wall-clock animation origin captured on the first rendered frame.
   *  `performance.now() - _startTime` yields the elapsed milliseconds
   *  fed into every time-interpolated value (opacity today, more
   *  properties in future PRs). Null until first renderFrame. */
  private _startTime: number | null = null
  private _elapsedMs = 0
  /** Earth-surface fill color resolved from `background { fill: ... }`.
   *  Forwarded to BackgroundRenderer after GPU init. null = no
   *  background block declared, canvas clearValue dominates. */
  private _backgroundColor: [number, number, number, number] | null = null
  private backgroundRenderer: BackgroundRenderer | null = null

  // ── Idle-render skip ──
  // Before this, `renderLoop` called `renderFrame()` every rAF (~60Hz) even
  // when nothing changed. On mobile the SDF line shader + mobile GPU is
  // heavy enough that a static minimal.xgis map pegged the tile units for
  // zero visual benefit ("엄청난 랙"). Now we compare camera state + canvas
  // size each tick and skip the frame when the signature matches, the
  // scene has no time-based animation, and no external invalidate is
  // pending. Any camera input, data push, or active animation resumes
  // per-frame rendering naturally.
  private _needsRender = true
  private _sceneHasAnimation = false
  private _lastSigZoom = NaN
  private _lastSigCX = NaN
  private _lastSigCY = NaN
  private _lastSigBearing = NaN
  private _lastSigPitch = NaN
  private _lastSigW = 0
  private _lastSigH = 0
  /** Explicit render trigger for code paths that change state outside the
   *  camera (setSourceData, updateFeature, tile load completion, etc.). */
  invalidate(): void { this._needsRender = true }

  constructor(private canvas: HTMLCanvasElement) {
    this.camera = new Camera(0, 20, 2)
  }

  /** Get current rendering stats */
  get stats(): RenderStats { return this._stats.get() }

  /** Public read/write access to the camera (for URL hash, etc). */
  getCamera(): Camera { return this.camera }

  /** Read the currently-active quality config (live — mutated by
   *  `setQuality`). Returns a shallow copy so callers can't accidentally
   *  mutate the internal object. */
  getQuality(): QualityConfig { return { ...QUALITY } }

  /** Snapshot of everything a human needs to debug the tile pipeline
   *  at CPU level: camera state, per-source cache/budget state,
   *  current draw stats, and the recent FLICKER history. Call from
   *  DevTools console (`__xgisMap.inspectPipeline()`) or a CPU test
   *  after driving the map into a specific state.
   *
   *  Structured return so `JSON.stringify()` produces a copy-pasteable
   *  report. Nothing here allocates GPU work — safe to call every
   *  frame if needed. */
  inspectPipeline(): PipelineInspection { return inspectMapPipeline(this) }

  /** Change any combination of quality knobs at runtime. The map figures
   *  out which parts are cheap (DPR — next resizeCanvas applies) vs
   *  expensive (MSAA, picking — every renderer recompiles its pipelines
   *  and any render-target textures are reallocated on the next frame).
   *
   *  - `maxDpr`, `interactionDpr`: applied on next resizeCanvas tick
   *  - `msaa`, `picking`: triggers per-renderer `rebuildForQuality()` +
   *    invalidates `msaaTexture` / `stencilTexture` / `pickTexture` so
   *    they get reallocated at the correct sampleCount the next frame
   *
   *  MSAA and picking are deliberately combined in one path because
   *  enabling `picking` also forces `msaa = 1` (uint RTs can't coexist
   *  with a multisample color attachment without a custom resolve
   *  shader — see quality.ts).
   *
   *  Example:
   *  ```ts
   *  map.setQuality({ picking: true })    // enable hover / click picking
   *  map.setQuality({ maxDpr: 1 })        // downscale to 1× for perf
   *  map.setQuality({ msaa: 4 })          // crank edge AA back up
   *  ``` */
  setQuality(patch: Partial<QualityConfig>): void {
    const before: QualityConfig = { ...QUALITY }
    updateQuality(patch)
    const after = QUALITY
    const msaaChanged = before.msaa !== after.msaa
    const pickingChanged = before.picking !== after.picking
    const dprChanged = before.maxDpr !== after.maxDpr || before.interactionDpr !== after.interactionDpr

    if (msaaChanged || pickingChanged) {
      // Force next renderFrame to recreate msaa / stencil / pick
      // textures at the new sampleCount. The existing size-change gate
      // (`msaaWidth !== w`) won't trip on its own since width/height
      // are unchanged, so we zero it to force a re-alloc.
      this.msaaWidth = 0
      this.msaaHeight = 0
      this.renderer.rebuildForQuality()
      this.rasterRenderer.rebuildForQuality()
      this.lineRenderer?.rebuildForQuality()
      this.pointRenderer?.rebuildForQuality()
      // Drop per-show variant pipeline refs so the bucket-scheduler
      // falls back to the defaults (which we just rebuilt). Without
      // this, `vectorTileShows[i].pipelines` would still point at the
      // OLD variant pipelines that have the wrong target count — the
      // bucket-scheduler hands them to VTR.render() and WebGPU rejects
      // the pass as "Attachment state of RenderPipeline ... is not
      // compatible with RenderPassEncoder". They'll be re-built lazily
      // on the next draw when `getOrCreateVariantPipelines` sees a
      // shaderCache miss.
      for (const entry of this.vectorTileShows) entry.pipelines = null
      // VTRs hold their own references to the renderer's `extruded`
      // and `ground` pipelines (set once at attach time). After a
      // rebuild those references go stale — same pipeline-attachment-
      // mismatch panic, just one indirection deeper. Re-wire every
      // VTR to the freshly built pipelines.
      for (const { renderer: vtRenderer } of this.vtSources.values()) {
        vtRenderer.setExtrudedPipelines(
          this.renderer.fillPipelineExtruded,
          this.renderer.fillPipelineExtrudedFallback,
        )
        vtRenderer.setGroundPipelines(
          this.renderer.fillPipelineGround,
          this.renderer.fillPipelineGroundFallback,
        )
        vtRenderer.setOITPipeline(this.renderer.fillPipelineExtrudedOIT)
      }
    }
    if (dprChanged) {
      // Canvas resize picks up the new DPR cap on the next frame.
      this._lastSigW = 0
      this._lastSigH = 0
    }
    this.invalidate()
  }

  /** Read the feature + instance ID under the given CSS pixel coordinate.
   *  Requires the map to be built with `?picking=1` — otherwise returns
   *  null immediately (no pick RT exists). Async because readback from a
   *  GPU texture has a ~1-frame latency via `mapAsync`.
   *
   *  - Returns `{ featureId, instanceId }` when a feature covers the pixel
   *  - Returns `null` when the pick pixel is (0, 0) (no feature / basemap)
   *  - `featureId` matches what `lower.ts` assigned to the geometry part
   *    (usually the feature's index in its source GeoJSON / tile)
   *  - `instanceId` is 0 until WORLD_COPIES instancing ships (future)
   *
   *  Pool reuse: the staging buffer ring avoids allocating per call, so
   *  hover scenarios (60 Hz pickAt) stay cheap. */
  async pickAt(clientX: number, clientY: number): Promise<{ featureId: number; layerId: number; instanceId: number } | null> {
    if (!this.pickTexture || !this.ctx) return null
    const canvas = this.ctx.canvas
    const rect = canvas.getBoundingClientRect()
    // Convert CSS coords → physical pixels (match the dpr used for the
    // framebuffer size). Clamp into bounds; out-of-canvas → null.
    const px = Math.floor((clientX - rect.left) * (canvas.width / rect.width))
    const py = Math.floor((clientY - rect.top) * (canvas.height / rect.height))
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null

    // Rent a staging buffer. Each slot is 8 bytes (one RG32Uint pixel,
    // padded to minimum 256-byte row per WebGPU's copy alignment). We
    // over-allocate to 256 so bytesPerRow is valid.
    let slot = this.pickReadbackPool.find(s => !s.inUse)
    if (!slot) {
      slot = {
        buf: this.ctx.device.createBuffer({
          size: 256,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          label: 'pick-readback',
        }),
        inUse: false,
      }
      this.pickReadbackPool.push(slot)
    }
    slot.inUse = true

    const encoder = this.ctx.device.createCommandEncoder({ label: 'pick-copy' })
    encoder.copyTextureToBuffer(
      { texture: this.pickTexture, origin: { x: px, y: py } },
      { buffer: slot.buf, bytesPerRow: 256, rowsPerImage: 1 },
      { width: 1, height: 1 },
    )
    this.ctx.device.queue.submit([encoder.finish()])

    try {
      await slot.buf.mapAsync(GPUMapMode.READ, 0, 8)
      const view = new Uint32Array(slot.buf.getMappedRange(0, 8))
      const featureId = view[0]
      // G channel packs (instanceId << 16) | layerId — see LayerIdRegistry.
      const packed = view[1]
      slot.buf.unmap()
      const layerId = packed & 0xffff
      const instanceId = (packed >>> 16) & 0xffff
      // Both featureId=0 and layerId=0 are sentinels: featureId=0 means "no
      // feature drew here" (raster-only / background), layerId=0 means "no
      // pickable layer drew here" (e.g., graticule, or Phase 3's
      // pointer-events:none with writeMask=0 yields 0 because the slot was
      // never written). Either is a miss.
      if (featureId === 0 || layerId === 0) return null
      return { featureId, layerId, instanceId }
    } finally {
      slot.inUse = false
    }
  }

  /** Show/hide the stats inspector panel */
  showInspector(show = true): void {
    if (show && !this._statsPanel) {
      this._statsPanel = new StatsPanel()
    } else if (!show && this._statsPanel) {
      this._statsPanel.destroy()
      this._statsPanel = null
    }
  }

  /** Change projection at runtime — GPU uniform only, no re-tessellation! */
  setProjection(name: string): void {
    const prevProj = this.projectionName
    this.projectionName = name

    // Adjust zoom for different projection scale
    // Globe projections (ortho/azimuthal/stereo) need wider view
    const isGlobe = (n: string) => ['orthographic', 'azimuthal_equidistant', 'stereographic'].includes(n)
    if (!isGlobe(prevProj) && isGlobe(name)) {
      this.camera.zoom = Math.min(this.camera.zoom, 1.5)
    } else if (isGlobe(prevProj) && !isGlobe(name)) {
      this.camera.zoom = Math.max(this.camera.zoom, 1.5)
    }
    this.invalidate()
  }

  getProjectionName(): string {
    return this.projectionName
  }

  /** Attach a per-label debug hook for the text stage. The hook fires
   *  once per addLabel / addCurvedLineLabel submission (BEFORE
   *  collision) and receives the final text + screen-pixel anchor.
   *  The playground wires this up when the URL hash contains
   *  `labels-debug` to render a DOM overlay — useful on mobile where
   *  console scripting isn't available. The hook can be cleared by
   *  passing `undefined`. Lazy-binds: if the text stage isn't built
   *  yet (no label show has been processed), the hook is captured
   *  here and attached when the stage is constructed. */
  setLabelDebugHook(hook: ((text: string, ax: number, ay: number, kind: 'point' | 'curve') => void) | undefined): void {
    this._pendingLabelDebugHook = hook
    this.textStage?.setLabelDebugHook(hook)
  }
  private _pendingLabelDebugHook?: ((text: string, ax: number, ay: number, kind: 'point' | 'curve') => void) | undefined

  private switchController(): void {
    this.controller?.detach()
    // Always PanZoom — panning moves camera = projection center moves
    // All projections center on camera position via GPU shader
    this.controller = new PanZoomController()
    // Build the dispatcher lazily — we need it BEFORE controller.attach
    // so the events object captures a stable reference. Re-projections
    // call switchController again; reusing the same dispatcher keeps
    // hover state across the rebuild instead of forcing a synthetic
    // mouseleave on every projection swap.
    if (!this.eventDispatcher) {
      this.eventDispatcher = new EventDispatcher({
        pickAt: (x, y) => this.pickAt(x, y),
        getLayerById: (id) => this.getLayerByPickId(id),
        buildFeature: (layerId, featureId) => this.buildFeatureForEvent(layerId, featureId),
        clientToLngLat: (x, y) => this.clientToLngLat(x, y),
        getCanvasRect: () => this.canvas.getBoundingClientRect(),
        dispatchMapEvent: (e) => this._dispatchMapEvent(e),
        mapHasListeners: (t) => this.mapListeners.has(t),
      })
    }
    const dispatcher = this.eventDispatcher
    this.controller.attach(
      this.canvas, this.camera,
      () => ({ projectionName: this.projectionName }),
      {
        onClick: (x, y, e) => { void dispatcher.handleClick(x, y, e) },
        onPointerMove: (x, y, e) => { dispatcher.handleMove(x, y, e) },
        onPointerLeave: (e) => { dispatcher.handlePointerLeave(e) },
        // Any drag, rotate, or wheel zoom is the user explicitly
        // positioning the camera — disable the post-compile bounds-fit
        // auto-snap so the user doesn't get yanked back to whole-world
        // view when the next tile compile lands.
        onPointerDown: (x, y, e) => {
          this._cameraExplicitlyPositioned = true
          void dispatcher.handlePointerDown(x, y, e)
        },
        onPointerUp: (x, y, e) => { void dispatcher.handlePointerUp(x, y, e) },
        onWheel: (x, y, e) => {
          this._cameraExplicitlyPositioned = true
          void dispatcher.handleWheel(x, y, e)
        },
      },
    )
  }

  /** Mark the camera as user-positioned so the next post-compile
   *  bounds-fit no-ops. Demo runners + apps call this after they
   *  apply a deep-link hash position (e.g. `#z/lat/lon/bearing/pitch`)
   *  so the requested view survives the worker compile completing. */
  markCameraPositioned(): void {
    this._cameraExplicitlyPositioned = true
  }

  /** Test seam — the bounds-fit gate that runs when a GeoJSON worker
   *  compile lands. Extracted from the inline `.then()` branch so the
   *  decision is CPU-testable without spinning up a WebGPU device or
   *  driving a real worker pool. `apply` receives the camera-snap
   *  effect ONLY when the gate opens (i.e., the camera has NOT been
   *  explicitly positioned via hash / setView / pointer interaction).
   *  The inline `.then()` now calls this helper so runtime + tests see
   *  identical gating.
   *
   *  Return value: `true` when the fit ran, `false` when it was
   *  suppressed — so tests can assert the suppression behaviour
   *  directly. */
  _runBoundsFitGate(apply: () => void): boolean {
    if (this._cameraExplicitlyPositioned) return false
    apply()
    return true
  }

  /** Read-only flag so tests can assert the state machine without
   *  reaching into private fields. Not part of the public API. */
  get _cameraPositionedFlag(): boolean {
    return this._cameraExplicitlyPositioned
  }

  /** Reverse-resolve a layerId from the pick texture into its public
   *  XGISLayer wrapper. Returns null for the sentinel `0` and any ID
   *  that no longer maps to a registered layer (post-clearLayers). */
  private getLayerByPickId(layerId: number): XGISLayer | null {
    if (layerId === 0) return null
    const name = this.layerIds.getName(layerId)
    if (!name) return null
    return this.xgisLayers.get(name) ?? null
  }

  /** Build the rich feature payload for an event hit. Falls back to an
   *  ID-only feature when the source's `_featureIndex` doesn't carry
   *  full properties (e.g., .xgvt-loaded tile sources without a parsed
   *  property table). */
  private buildFeatureForEvent(layerId: number, featureId: number): XGISFeature | null {
    const layerName = this.layerIds.getName(layerId)
    if (!layerName) return null
    const layer = this.xgisLayers.get(layerName)
    if (!layer) return null
    // Find the source by walking vectorTileShows for the show this layer
    // wraps. Phase 4 only supports GeoJSON sources (in `_featureIndex`);
    // .xgvt sources land in Phase 5 with property-table reverse mapping.
    const entry = this.vectorTileShows.find(e => (e.show.layerName ?? e.show.targetName) === layerName)
    const sourceName = entry?.show.targetName ?? layerName
    const props = this.lookupFeatureProperties(sourceName, featureId)
    return {
      id: featureId,
      source: sourceName,
      layer: layerName,
      properties: props ?? {},
    }
  }

  /** Look up properties for `featureId` in `sourceName`'s GeoJSON
   *  feature index. Builds the index on first access using the same
   *  `feature-id-fallback` resolver the compile worker uses
   *  (`feature.id` → `properties.id` → array index), so the IDs the
   *  GPU encoded into the pick texture match the lookup keys here.
   *  Returns null when the source isn't a GeoJSON dataset or the ID
   *  isn't found. */
  private lookupFeatureProperties(sourceName: string, featureId: number): Record<string, unknown> | null {
    const data = this.rawDatasets.get(sourceName)
    if (!data) return null
    let index = this._featureIndex.get(sourceName)
    if (!index) {
      index = new Map()
      for (let i = 0; i < data.features.length; i++) {
        const f = data.features[i]
        const id = toU32Id(f.id ?? f.properties?.id ?? i)
        index.set(id, f)
      }
      this._featureIndex.set(sourceName, index)
    }
    const feature = index.get(featureId)
    return (feature?.properties as Record<string, unknown>) ?? null
  }

  /** Convert a CSS-coordinate point to longitude/latitude using the
   *  current camera. Phase 4 supports Mercator; other projections
   *  return null for now (the dispatcher coerces to NaN, NaN). */
  private clientToLngLat(clientX: number, clientY: number): readonly [number, number] | null {
    if (!this.ctx) return null
    const canvas = this.ctx.canvas
    const rect = canvas.getBoundingClientRect()
    // Map CSS coords → physical pixels for unproject (which works in
    // physical-pixel framebuffer space).
    const px = (clientX - rect.left) * (canvas.width / rect.width)
    const py = (clientY - rect.top) * (canvas.height / rect.height)
    const dpr = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1
    const rtc = this.camera.unprojectToZ0(px, py, canvas.width, canvas.height, dpr)
    if (!rtc) return null
    // RTC coords are camera-relative meters in projection space. For
    // Mercator (the most common path) we add cameraCenter to get
    // absolute Mercator meters then invert to lng/lat. Other projections
    // need a per-projection inverse — Phase 5 work.
    if (this.projectionName !== 'mercator') return null
    const R = 6378137
    const merc_x = rtc[0] + this.camera.centerX
    const merc_y = rtc[1] + this.camera.centerY
    const lon = (merc_x / R) * (180 / Math.PI)
    const lat = (2 * Math.atan(Math.exp(merc_y / R)) - Math.PI / 2) * (180 / Math.PI)
    return [lon, lat]
  }

  /** Load and run an X-GIS program */
  async run(source: string, baseUrl = ''): Promise<void> {
    // Reset the e2e ready signal for this load. The smoke test polls
    // __xgisReady after triggering navigation; the previous demo's
    // `true` would falsely satisfy the wait if we didn't clear it.
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __xgisReady?: boolean }).__xgisReady = false
    }
    // Reset the user-positioned flag — a fresh source should default
    // to bounds-fit unless the caller explicitly positions the camera
    // afterwards (via setView, hash sync, or pointer interaction).
    this._cameraExplicitlyPositioned = false

    // Promote baseUrl to an absolute URL. `new URL(path, base)` requires
    // `base` to be absolute — passing a bare path like '/data/' throws
    // TypeError: Invalid base URL. Accepts '', '/data/', relative URLs, or
    // fully-qualified URLs.
    const absBase = (() => {
      if (typeof window === 'undefined') return baseUrl  // SSR / tests
      if (!baseUrl) return window.location.href
      try { return new URL(baseUrl, window.location.href).href }
      catch { return window.location.href }
    })()

    // 0. Kick off GPU init in parallel with the synchronous IR
    // pipeline. `initGPU()` is dominated by `requestDevice()` which
    // takes 100-500 ms on cold start; sequencing it after the parse
    // path (which itself takes only ~10-15 ms) wasted that wall time.
    // Now the device promise is in flight while we lex / parse / lower
    // / emit, and the await down at step 2 is mostly a no-op once IR
    // finishes. Saves ~10-15 ms on every cold load, more if any future
    // IR pass grows.
    //
    // GPU init has no dependency on the IR result — it just needs
    // `this.canvas`. Errors propagate exactly as before via the awaited
    // catch.
    const gpuInit = initGPU(this.canvas).catch(err => {
      // Hold the rejection here so the await below converts it to a
      // sync throw at the same call site as the previous code. We
      // don't want unhandled-rejection noise if step 1 errors out
      // before step 2 awaits.
      return err as Error
    })

    // 1. Parse → resolve imports (async fetch) → IR → Commands
    const tokens = new Lexer(source).tokenize()
    let ast = new Parser(tokens).parse()

    // Resolve any `import { ... } from "..."` statements via fetch.
    // Errors are logged (via console.error → in-page overlay) so future
    // module-resolution failures aren't opaque on iOS.
    const resolver = async (path: string): Promise<string | null> => {
      let url: string
      try { url = new URL(path, absBase).href }
      catch (e) {
        console.error(`[X-GIS import] cannot build URL for "${path}" against base "${absBase}":`, (e as Error).message)
        return null
      }
      try {
        const resp = await fetch(url)
        if (!resp.ok) {
          console.error(`[X-GIS import] fetch ${url} failed: ${resp.status} ${resp.statusText}`)
          return null
        }
        return await resp.text()
      } catch (e) {
        console.error(`[X-GIS import] fetch ${url} threw:`, (e as Error).message)
        return null
      }
    }
    // Output collector: any inline GeoJSON `source.data` objects found
    // inside an imported Mapbox style get stashed here. Seeded into
    // rawDatasets after the source-load Promise.all so the first
    // rebuildLayers includes the features (no extra rebuild). Without
    // this, inline data was silently dropped — host had to know to
    // call setSourceData() manually.
    const inlineGeoJSON = new Map<string, unknown>()
    if (ast.body.some(s => s.kind === 'ImportStatement')) {
      ast = await resolveImportsAsync(ast, absBase, resolver, { inlineGeoJSON })
    }

    // Use IR pipeline for new syntax, fallback to legacy interpreter
    const hasNewSyntax = ast.body.some(s => s.kind === 'SourceStatement' || s.kind === 'LayerStatement')
    let commands
    if (hasNewSyntax) {
      const scene = lower(ast)
      // Surface compiler diagnostics to the console — silent failures
      // (e.g. deprecated z<N>: modifier silently dropped) become loud
      // so the user notices instead of debugging "why isn't this
      // applying?" through the renderer. Each diagnostic carries an
      // X-GIS<NNNN> code so the message is greppable.
      for (const d of scene.diagnostics ?? []) {
        const prefix = d.severity === 'warn'
          ? `[X-GIS ${d.code ?? 'diag'} warn]`
          : `[X-GIS ${d.code ?? 'diag'} info]`
        const lineSuffix = d.line ? ` (line ${d.line})` : ''
        if (d.severity === 'warn') console.warn(`${prefix}${lineSuffix} ${d.message}`)
        else console.log(`${prefix}${lineSuffix} ${d.message}`)
      }
      commands = emitCommands(optimize(scene, ast))
    } else {
      commands = interpret(ast)
    }

    // background { fill: <color> } — Mapbox-style earth-surface fill.
    // Implemented as a fullscreen-quad pre-pass via BackgroundRenderer:
    // depth-test ALWAYS, depth-write OFF, stencil writeMask 0. Doesn't
    // interact with the layer depth/stencil bookkeeping at all, so
    // user layers paint freely on top with no z-fight even at high
    // pitch under log-depth precision compression. Color lookup:
    // utility lines first (`| fill-sky-900` → resolveUtilities →
    // hex), then style properties (`fill: sky-900` or `fill: #082f49`).
    // StyleProperty stores the raw string; `sky-900` resolves via
    // resolveColor(); bare `#rrggbb` passes through.
    //
    // Trade-off: in non-Mercator projections this also paints "space"
    // outside the projected globe. Acceptable for the projections
    // currently shipped (Mercator + 2D variants); globe-style
    // projections will need a sphere proxy on top of this.
    let bgColor: string | null = null
    for (const stmt of ast.body) {
      if (stmt.kind !== 'BackgroundStatement') continue
      const items: AST.UtilityItem[] = []
      for (const line of stmt.utilities) items.push(...line.items)
      const resolved = resolveUtilities(items)
      let color: string | null = resolved.fill ?? null
      for (const sp of stmt.styleProperties) {
        if (sp.name !== 'fill') continue
        const raw = sp.value
        if (raw.startsWith('#')) color = raw
        else {
          const hex = resolveColor(raw)
          if (hex) color = hex
        }
      }
      if (color) bgColor = color
    }
    if (bgColor) this._backgroundColor = parseHexColor(bgColor)

    console.log('[X-GIS] Parsed:', commands.loads.length, 'loads,', commands.shows.length, 'shows')

    // Prewarm PMTiles archive caches in parallel with the rest of init
    // (GPU adapter + shader pipeline compilation below). The archive
    // open does 2 sequential HTTP round trips (header + metadata, ~100-
    // 400 ms total) that the data-load loop later awaits. Kicking them
    // off here means by the time the load loop runs, the cache hit is
    // already there and the header/metadata await is a no-op.
    //
    // Fire-and-forget: errors are surfaced when the attach path later
    // awaits the same cached promise. We only prewarm clearly PMTiles
    // URLs (`*.pmtiles` or declared `type: pmtiles`); TileJSON has its
    // own dispatch with no shared cache yet.
    let anyVectorTile = false
    for (const load of commands.loads) {
      // URL resolution must match the data-load loop below exactly so
      // the cache hit lands. Loop uses `baseUrl + load.url` for
      // relative paths; mirror that here.
      const url = load.url.startsWith('http') || load.url.startsWith('/') ? load.url : baseUrl + load.url
      const declaredType = (load as { type?: string }).type
      // Prewarm only the formats that route through the MVT decode
      // worker pool — `prewarmVectorTileSource` is a no-op for XGVT
      // and for unknown URLs, which is exactly what we want here.
      const format = detectVectorTileFormat(url, asVectorTileKind(declaredType))
      if (format === 'pmtiles' || format === 'tilejson') {
        prewarmVectorTileSource(url, format)
        anyVectorTile = true
      }
    }
    // Prewarm the MVT decode worker pool when ANY load needs it. Each
    // worker takes 10-50 ms to spawn its JS context; lazy-spawning on
    // first compile pays that cost serially after the first byte
    // arrives. Pre-spawning here lets the workers initialise in
    // parallel with PMTiles header round trips and shader compile.
    if (anyVectorTile) {
      // Async import to keep the worker-pool module out of the path
      // for pure-GeoJSON demos that never touch MVT decode.
      void import('../data/workers/mvt-worker-pool').then(m => m.prewarmMvtWorkerPool()).catch(() => undefined)
    }


    // 2. Await the GPU init that was kicked off at step 0. By now the
    // request has either resolved (typical case — IR finished after
    // requestDevice) or is about to. Same fallback path as before for
    // unsupported environments.
    try {
      const result = await gpuInit
      if (result instanceof Error) throw result
      this.ctx = result
      this.renderer = new MapRenderer(this.ctx)
      this.rasterRenderer = new RasterRenderer(this.ctx)
      this.backgroundRenderer = new BackgroundRenderer(this.ctx)
      if (this._backgroundColor) this.backgroundRenderer.setFill(this._backgroundColor)
      if (GPU_PROF) this.gpuTimer = new GPUTimer(this.ctx)
      try {
        this.pointRenderer = new PointRenderer(this.ctx)
        this.shapeRegistry = new ShapeRegistry(this.ctx.device)
        // Register user-defined symbols from DSL under the `user:` namespace
        // so they shadow built-ins of the same name instead of being silently
        // dropped by the duplicate-name guard in `addShape`.
        for (const sym of commands.symbols ?? []) {
          for (const path of sym.paths) {
            this.shapeRegistry.addUserShape(sym.name, path)
          }
        }
        this.shapeRegistry.uploadToGPU()
        this.pointRenderer.setShapeRegistry(this.shapeRegistry)
      } catch (e) { console.warn('[X-GIS] PointRenderer init failed:', e) }

      // SDF line renderer (shared by all VTR instances)
      try {
        this.lineRenderer = new LineRenderer(this.ctx, this.renderer.bindGroupLayout)
        if (this.shapeRegistry) this.lineRenderer.setShapeRegistry(this.shapeRegistry)
      } catch (e) { console.warn('[X-GIS] LineRenderer init failed:', e) }
      // VT sources/renderers created per .xgvt file in the load loop
      this.useCanvas2D = false
    } catch (err) {
      console.warn('[X-GIS] WebGPU unavailable, falling back to Canvas 2D:', (err as Error).message)
      this.canvasRenderer = new CanvasRenderer(this.canvas)
      this.useCanvas2D = true
    }


    // 3. Load data — all sources in parallel. Sequential awaits used to
    // serialize 4-source demos into ~4x the total wall-clock time (each
    // source had to finish its index + preload decompression before the
    // next started). Promise.all lets index fetches overlap and lets
    // tile decompressions interleave on the main thread.

    // Pre-compute the five per-source attach-time maps the data-load
    // loop hands to PMTilesBackend (used MVT layer filter, extrude AST,
    // stroke-width / stroke-colour overrides, slice descriptors). See
    // engine/show-source-maps.ts for what each map carries and why
    // the worker needs them. Pure function over commands.shows —
    // ~1 ms total even on the dense 80-show Bright style.
    const {
      usedSourceLayers,
      extrudeExprsBySource,
      extrudeBaseExprsBySource,
      strokeWidthExprsBySource,
      strokeColorExprsBySource,
      showSlicesBySource,
    } = buildShowSourceMaps(commands.shows)

    // Per-load attach: dispatch by format (raster URL vs vector tile
    // archive vs inline-empty vs GeoJSON URL). Body lives on
    // `this._attachOneSource` so this loop reads as flat orchestration.
    // cameraFit state is boxed in an object so the parallel loads
    // share the same "first source that knows its bounds wins" gate.
    const cameraFitState = { fit: false }
    await Promise.all(commands.loads.map(load =>
      this._attachOneSource(load, baseUrl, {
        usedSourceLayers,
        extrudeExprsBySource,
        extrudeBaseExprsBySource,
        strokeWidthExprsBySource,
        strokeColorExprsBySource,
        showSlicesBySource,
      }, cameraFitState),
    ))

    // Seed inline GeoJSON captured from imported Mapbox styles. Direct
    // rawDatasets write (not setSourceData) because rebuildLayers runs
    // unconditionally a few lines below — calling setSourceData here
    // would fire a redundant retile.
    for (const [id, fc] of inlineGeoJSON) {
      if (this.rawDatasets.has(id)) {
        this.rawDatasets.set(id, fc as GeoJSONFeatureCollection)
      } else {
        console.warn(`[X-GIS] Inline GeoJSON for unknown source "${id}" — dropping. (Mapbox style sources didn't emit a matching load command.)`)
      }
    }

    this.showCommands = commands.shows
    this._sceneHasAnimation = commands.shows.some(s =>
      !!s.timeOpacityStops || !!s.timeFillStops || !!s.timeStrokeStops ||
      !!s.timeStrokeWidthStops || !!s.timeSizeStops || !!s.timeDashOffsetStops
    )
    this._needsRender = true

    // Prewarm shader-variant pipelines BEFORE rebuildLayers so the
    // GPU driver compiles them in parallel with the rest of init.
    // Without this, `rebuildLayers` calls the synchronous
    // `getOrCreateVariantPipelines` (createRenderPipeline) which
    // returns a handle but defers driver compile to first draw —
    // showing up as a >1 s `(idle)` block on the first post-ready
    // frame for variant-heavy demos (filter_gdp at z=8 Europe).
    // `createRenderPipelineAsync` lets the driver work in the
    // background so the frame budget recovers.
    if (!this.useCanvas2D) {
      const variants: import('@xgis/compiler').ShaderVariant[] = []
      const seen = new Set<string>()
      for (const show of this.showCommands) {
        const v = show.shaderVariant
        if (v && (v.preamble || v.needsFeatureBuffer) && v.key && !seen.has(v.key)) {
          seen.add(v.key)
          variants.push(v)
        }
      }
      if (variants.length > 0) {
        try {
          await this.renderer.prewarmShaderVariantsAsync(variants as unknown as Parameters<MapRenderer['prewarmShaderVariantsAsync']>[0])
        } catch (e) {
          console.warn('[X-GIS] shader prewarm failed (falling back to lazy compile on first draw):', (e as Error).message)
        }
      }
    }

    // 4. Build render layers + fit camera
    if (this.useCanvas2D) {
      this.rebuildLayersCanvas2D()
    } else {
      this.rebuildLayers()
    }

    // 5. Setup controller
    this.switchController()

    // 6. Start render loop
    this.running = true
    if (this.useCanvas2D) {
      this.renderLoopCanvas2D()
    } else {
      this.renderLoop()
    }

    console.log(`[X-GIS] Map running (${this.useCanvas2D ? 'Canvas 2D fallback' : 'WebGPU'})`)

    // Expose a ready signal for headless e2e / smoke tests. The test
    // harness (playground/e2e/smoke.spec.ts) polls window.__xgisReady
    // to know when a demo has completed its initial load and entered
    // the render loop. Gated on `typeof window` so SSR / Node tests
    // don't trip over the global.
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __xgisReady?: boolean }).__xgisReady = true
      // Expose a deterministic scene-snapshot helper. Captures the
      // camera state, the per-source GPU tile cache, the in-flight
      // render-order trace, and a pixel-data hash. Designed for
      // regression testing of bugs that depend on subtle render-
      // ordering / tile-routing decisions (e.g. the 3D building
      // depth-sort bug). Re-runs that produce the same camera + same
      // tile cache + same draw order should produce the same hash —
      // any drift signals a behaviour change.
      const self = this
      const w = window as unknown as {
        __xgisSnapshot?: () => Promise<unknown>
        __xgisStartDrawOrderTrace?: () => void
        __xgisReplaySnapshot?: (snap: unknown, opts?: unknown) => Promise<unknown>
        __xgisDrawOrderTrace?: unknown[]
      }
      w.__xgisSnapshot = () => self.captureSnapshot()
      w.__xgisStartDrawOrderTrace = () => {
        w.__xgisDrawOrderTrace = []
      }
      w.__xgisReplaySnapshot = (snap, opts) => self.replaySnapshot(
        snap as Parameters<typeof self.replaySnapshot>[0],
        opts as Parameters<typeof self.replaySnapshot>[1] | undefined,
      )
    }
  }

  /** Build a deterministic snapshot of the current scene state.
   *  Includes:
   *    - Camera state (lon/lat/zoom/bearing/pitch + viewport)
   *    - Per-vector-source: list of GPU-cached tile keys, queue depths
   *    - Render-order trace (must be armed via `__xgisStartDrawOrderTrace`
   *      BEFORE the frame to capture; otherwise empty)
   *    - SHA-256 hash of the canvas pixel data
   *
   *  Call from a test scenario to assert deterministic behaviour or
   *  to capture a "broken" snapshot for diagnosis.
   */
  async captureSnapshot(): Promise<MapSnapshot> { return captureMapSnapshot(this) }

  /** Replay a captured snapshot — see diagnostics.replayMapSnapshot. */
  async replaySnapshot(snap: Parameters<typeof replayMapSnapshot>[1], opts?: Parameters<typeof replayMapSnapshot>[2]): Promise<ReplayResult> {
    return replayMapSnapshot(this, snap, opts)
  }

  /** Attach one declared `load:` from the parsed program — dispatches
   *  by URL/format into the four supported branches:
   *    1. raster tile template (`{z}/{x}/{y}` URL)        → store URL string
   *    2. vector tile archive (.pmtiles / .tilejson / .xgvt) → spin up
   *       per-source TileCatalog + VectorTileRenderer, attach via the
   *       unified vector-tile-loader, register vtSources entry
   *    3. inline-empty source (`url: ''`)                 → empty FeatureCollection
   *    4. GeoJSON URL                                      → fetch + JSON parse
   *
   *  The five preprocessed maps from `buildShowSourceMaps` flow into
   *  the vector-tile branch only — nothing else uses them. cameraFit
   *  is shared mutable state across parallel loads ("first source that
   *  knows its bounds wins"); boxed in an object so each Promise sees
   *  the same flag. */
  private async _attachOneSource(
    load: AST.Load,
    baseUrl: string,
    maps: ShowSourceMaps,
    cameraFitState: { fit: boolean },
  ): Promise<void> {
    const url = load.url.startsWith('http') || load.url.startsWith('/') ? load.url : baseUrl + load.url
    console.log(`[X-GIS] Loading: ${load.name} from ${url}`)

    // Source `type:` from the DSL takes precedence over URL-extension
    // sniffing so a URL without a file extension (e.g. a TileJSON
    // manifest at `https://tiles.example.com/planet`) still routes
    // correctly. Without this, the misrouted URL falls into the
    // bottom `fetch().json()` branch and the JSON gets stored as a
    // FeatureCollection — which then crashes `applyFilter` because
    // there's no `.features` array.
    const declaredType = load.type
    const looksLikeRaster = declaredType === 'raster' || isTileTemplate(url)
    const vectorTileFormat = detectVectorTileFormat(url, asVectorTileKind(declaredType))

    if (looksLikeRaster) {
      this.rawDatasets.set(load.name, { _tileUrl: url } as unknown as GeoJSONFeatureCollection)
      return
    }

    if (vectorTileFormat !== null && !this.useCanvas2D) {
      const source = new TileCatalog()
      const vtRenderer = new VectorTileRenderer(this.ctx)
      vtRenderer.setBindGroupLayout(this.renderer.bindGroupLayout) // must be set before any tile uploads
      vtRenderer.setExtrudedPipelines(this.renderer.fillPipelineExtruded, this.renderer.fillPipelineExtrudedFallback)
      vtRenderer.setGroundPipelines(this.renderer.fillPipelineGround, this.renderer.fillPipelineGroundFallback)
      vtRenderer.setOITPipeline(this.renderer.fillPipelineExtrudedOIT)
      if (this.lineRenderer) vtRenderer.setLineRenderer(this.lineRenderer)
      vtRenderer.setSource(source) // connect before load so preloaded tiles auto-upload
      const fullUrl = url.startsWith('http') ? url : new URL(url, location.href).href
      // Inferred set + explicit `layers:` merge: explicit wins for any
      // layer not in the inferred set; inferred is typically a subset.
      const inferred = maps.usedSourceLayers.get(load.name)
      const filterLayers = load.layers && load.layers.length > 0
        ? load.layers
        : (inferred && inferred.size > 0 ? [...inferred] : undefined)
      await attachPMTilesSource(source, {
        url: fullUrl,
        kind: vectorTileFormat,
        layers: filterLayers,
        extrudeExprs: maps.extrudeExprsBySource.get(load.name),
        extrudeBaseExprs: maps.extrudeBaseExprsBySource.get(load.name),
        showSlices: maps.showSlicesBySource.get(load.name),
        strokeWidthExprs: maps.strokeWidthExprsBySource.get(load.name),
        strokeColorExprs: maps.strokeColorExprsBySource.get(load.name),
      })
      this.vtSources.set(load.name, { source, renderer: vtRenderer })
      this.rawDatasets.set(load.name, { _vectorTile: true } as unknown as GeoJSONFeatureCollection)

      // Fit camera to the FIRST source that finishes. Multi-source demos
      // typically share world-bounds; "first to win" avoids order-
      // dependent racing across parallel loads.
      if (!cameraFitState.fit) {
        const vtBounds = vtRenderer.getBounds()
        if (vtBounds) {
          cameraFitState.fit = true
          const [minLon, minLat, maxLon, maxLat] = vtBounds
          const clampedLat = Math.max(-85, Math.min(85, (minLat + maxLat) / 2))
          const [cx, cy] = lonLatToMercator((minLon + maxLon) / 2, clampedLat)
          this.camera.centerX = cx
          this.camera.centerY = cy
          const lonSpan = maxLon - minLon
          const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
          const cssW = this.canvas.width / dpr
          const degPerPx = lonSpan / cssW
          this.camera.zoom = Math.max(0.5, Math.log2(360 / (degPerPx * 256)) - 1)
        }
      }
      return
    }

    if (load.url === '') {
      // Inline source — host pushes data later via setSourceData /
      // setSourcePoints / updateFeature.
      this.rawDatasets.set(load.name, { type: 'FeatureCollection', features: [] })
      return
    }

    // GeoJSON URL fetch.
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(
        `[X-GIS] Failed to load "${load.name}" from ${url} — HTTP ${response.status}. ` +
        `Check that the file exists at that path (iOS Safari otherwise surfaces this as the opaque ` +
        `"string did not match the expected pattern" when response.json() runs on an HTML 404 body).`,
      )
    }
    const data = await response.json() as GeoJSONFeatureCollection
    this.rawDatasets.set(load.name, data)
  }

  /** Rebuild GPU layers from raw data with current projection */
  private rebuildLayers(): void {
    // Now projection-agnostic: vertices are raw lon/lat degrees
    // GPU vertex shader applies projection via uniform
    this.renderer.clearLayers()
    this.pointRenderer?.clearLayers()
    this.vectorTileShows = []
    // Reset layer-id registry so re-projection produces deterministic IDs
    // (same `addLayer` order → same IDs). pickAt callers that cached an ID
    // across `setProjection()` need to re-resolve.
    this.layerIds.reset()
    // Wipe public XGISLayer wrappers — they hold references to the old
    // ShowCommand objects, which are about to be replaced. Consumers that
    // cached `getLayer(name)` across `setProjection()` will need to re-
    // resolve (same contract as Mapbox/MapLibre layer references).
    this.xgisLayers.clear()

    // Reset raster renderer — only activate if a layer references a raster source
    if (!this.useCanvas2D) this.rasterRenderer.setUrlTemplate('')

    for (const show of this.showCommands) {
      const data = this.rawDatasets.get(show.targetName)
      if (!data) continue

      // Stamp this show with its stable layer ID so VTR's per-tile
      // uniform write picks it up for the pick texture's G channel.
      // We register by DSL layer name (e.g., 'fill', 'borders') rather
      // than source name, so two layers drawing the same source get
      // distinct IDs and are pickable independently. Legacy syntax
      // mirrors `targetName` into `layerName` at compile time, so this
      // is a no-op there.
      const layerName = show.layerName ?? show.targetName
      show.pickId = this.layerIds.register(layerName)
      // Build (or refresh) the public XGISLayer wrapper, keyed by DSL
      // layer name. `getLayer('borders')` returns the borders wrapper
      // even when its source is shared with `fill`. Secondary shows
      // under the same DSL name share the wrapper (extremely rare —
      // happens only when a future compiler pass fan-outs one `layer`
      // into multiple shows; the wrapper still mutates the first
      // show, the rest will adopt it via the layerName lookup).
      if (!this.xgisLayers.has(layerName)) {
        this.xgisLayers.set(
          layerName,
          new XGISLayer(layerName, show, () => this.invalidate()),
        )
      }

      // Raster tile source referenced by a layer → activate raster renderer
      const tileUrl = (data as unknown as { _tileUrl?: string })._tileUrl
      if (tileUrl) {
        if (!this.useCanvas2D) this.rasterRenderer.setUrlTemplate(tileUrl)
        continue
      }

      // Skip vector tile sources loaded from .xgvt files
      if ((data as unknown as { _vectorTile?: boolean })._vectorTile) {
        const vtEntry = this.vtSources.get(show.targetName)
        if (!vtEntry) continue

        let pipelines: typeof this.vtVariantPipelines = null
        let layout: GPUBindGroupLayout | null = null

        const variant = show.shaderVariant
        if (variant && (variant.preamble || variant.needsFeatureBuffer)) {
          try {
            pipelines = this.renderer.getOrCreateVariantPipelines(variant as any)
            layout = variant.needsFeatureBuffer
              ? this.renderer.featureBindGroupLayout
              : this.renderer.bindGroupLayout
            if (variant.needsFeatureBuffer && !vtEntry.renderer.hasFeatureData()) {
              vtEntry.renderer.buildFeatureDataBuffer(variant as any, layout)
            }
          } catch (e) {
            console.warn('[X-GIS] VT variant pipeline failed:', e)
          }
        }

        this.vectorTileShows.push({ sourceName: show.targetName, show, pipelines, layout })
        continue
      }

      // GeoJSON → in-memory tiling → VectorTileRenderer
      // Each layer gets its own key: reuse source if no filter, separate if filtered
      const hasFilter = !!show.filterExpr
      const vtKey = hasFilter ? `${show.targetName}__${this.vectorTileShows.length}` : show.targetName

      // Reuse existing VT source if same key (same source, no filter)
      if (this.vtSources.has(vtKey)) {
        const vtEntry = this.vtSources.get(vtKey)!
        let pipelines: typeof this.vtVariantPipelines = null
        let layout: GPUBindGroupLayout | null = null
        const variant = show.shaderVariant
        if (variant && (variant.preamble || variant.needsFeatureBuffer)) {
          try {
            pipelines = this.renderer.getOrCreateVariantPipelines(variant as any)
            layout = variant.needsFeatureBuffer
              ? this.renderer.featureBindGroupLayout : this.renderer.bindGroupLayout
            if (variant.needsFeatureBuffer && !vtEntry.renderer.hasFeatureData()) {
              vtEntry.renderer.buildFeatureDataBuffer(variant as any, layout)
            }
          } catch (e) { console.warn('[X-GIS] VT variant pipeline failed:', e) }
        }
        this.vectorTileShows.push({ sourceName: vtKey, show, pipelines, layout })
        continue
      }

      let filtered = applyFilter(data, show.filterExpr)

      // Procedural geometry: evaluate geometry expression per feature
      if (show.geometryExpr?.ast) {
        filtered = applyGeometry(filtered, show.geometryExpr)
      }

      // Point geometry → SDF point renderer (skip polygon tiling pipeline)
      const firstGeomType = filtered.features[0]?.geometry?.type
      if ((firstGeomType === 'Point' || firstGeomType === 'MultiPoint') && !show.geometryExpr && this.pointRenderer) {
        const fillHex = show.fill
        const strokeHex = show.stroke
        const fill = fillHex ? parseHexColor(fillHex) : null
        const stroke = strokeHex ? parseHexColor(strokeHex) : null

        // Resolve zoom-interpolated size to a concrete value at the
        // current camera zoom. Evaluated once at layer build time —
        // sufficient for static displays; a zoom-aware point uniform
        // upload path is tracked as a follow-up for live resize.
        const baseSize = show.zoomSizeStops && show.zoomSizeStops.length > 0
          ? interpolateZoom(show.zoomSizeStops, this.camera.zoom, show.zoomSizeStopsBase ?? 1)
          : (show.size ?? 8)

        // Evaluate per-feature size if data-driven
        let perFeatureSizes: number[] | null = null
        if (show.sizeExpr?.ast) {
          const ast = show.sizeExpr.ast as import('@xgis/compiler').Expr
          perFeatureSizes = filtered.features.map(f => {
            const r = evaluate(ast, f.properties ?? {})
            return typeof r === 'number' ? r : baseSize
          })
        }

        // Resolve shape name to GPU shape_id
        const shapeId = show.shape ? (this.shapeRegistry?.getShapeId(show.shape) ?? 0) : 0

        this.pointRenderer.addLayer(
          filtered.features as any,
          fill, stroke,
          show.strokeWidth,
          baseSize,
          show.opacity ?? 1.0,
          show.sizeUnit,
          perFeatureSizes,
          show.billboard,
          shapeId,
          show.anchor,
          show.zoomSizeStops ?? null,
        )
        continue
      }

      const source = new TileCatalog()
      const vtRenderer = new VectorTileRenderer(this.ctx)
      vtRenderer.setBindGroupLayout(this.renderer.bindGroupLayout)
      vtRenderer.setExtrudedPipelines(this.renderer.fillPipelineExtruded, this.renderer.fillPipelineExtrudedFallback)
      vtRenderer.setGroundPipelines(this.renderer.fillPipelineGround, this.renderer.fillPipelineGroundFallback)
      vtRenderer.setOITPipeline(this.renderer.fillPipelineExtrudedOIT)
      if (this.lineRenderer) vtRenderer.setLineRenderer(this.lineRenderer)
      vtRenderer.setSource(source)
      this.vtSources.set(vtKey, { source, renderer: vtRenderer })

      // Offload `decomposeFeatures` + `compileGeoJSONToTiles(z0)` to a
      // worker so earcut over 10k+ features no longer blocks the main
      // thread. The source is created empty up-front; when the pool
      // returns we call `addTileLevel` + `setRawParts` + fit the camera.
      // Legacy behaviour (synchronous fit + first-frame z0) is preserved
      // in the fallback path when the worker pool is unavailable.
      //
      // Stable-id policy (`feature.id` → `properties.id` → index) lives
      // in the worker now via the `'feature-id-fallback'` mode; see
      // `geojson-compile-worker.ts:resolveIdResolver`.
      const pool = getSharedGeoJSONCompilePool()
      const compilePromise = pool.compile(filtered, 0, 0, 'feature-id-fallback')
      // Capture the entry we just registered so a stale completion (arriving
      // after a re-teardown) cannot overwrite a newer source under the same
      // key — `setSourceData` / `teardownSource` deletes the entry, and we
      // only apply results if the pointer still matches.
      const registeredEntry = this.vtSources.get(vtKey)
      compilePromise.then(({ parts, tileSet }) => {
        if (this.vtSources.get(vtKey) !== registeredEntry) return // superseded
        if (tileSet.levels.length > 0) {
          source.addTileLevel(tileSet.levels[0], tileSet.bounds, tileSet.propertyTable)
        }
        // rawMaxZoom caps runtime sub-tile generation depth. Set to
        // camera.maxZoom (22) so zooming past z=7 produces properly-
        // sized sub-tiles (9.5 m at z=22) instead of a z=7 parent fallback
        // whose 305 km quad distorts under pitched perspective.
        // Paired with 5c1be77's fullCover plumbing through compileSingleTile
        // → xgvt-source so the sub-tile quads reach the match() color
        // lookup with the correct feature id attached.
        source.setRawParts(parts, tileSet.levels.length > 0 ? 22 : 0)

        // Feature data buffer MUST be built after the property table
        // is set on the source — which only happens in `addTileLevel`
        // above. Building it earlier (inside the sync rebuildLayers
        // block below) silently no-ops because `getPropertyTable()`
        // returns undefined before the worker returns, leaving the
        // variant pipeline paired with the default bind-group layout
        // and tripping a WebGPU validation error on every draw. Fixture
        // audit surfaced this as the `match()`-based fixtures
        // (fixture_categorical, reftest_triangle_match, etc.) logging
        // "Bind group layout of pipeline layout does not match layout
        // of bind group".
        const variant = show.shaderVariant
        if (variant && variant.needsFeatureBuffer && !vtRenderer.hasFeatureData()) {
          vtRenderer.buildFeatureDataBuffer(variant as import('@xgis/compiler').ShaderVariant, this.renderer.featureBindGroupLayout)
        }
        // Worker result just landed — wake the render loop to paint it.
        this.invalidate()

        // Fit camera to data bounds once the compile lands — but only
        // when the user hasn't already positioned the camera explicitly
        // (URL hash, programmatic .setView, or a pan/zoom gesture).
        // Otherwise the auto-fit clobbers the requested view, which
        // surfaced as a bug when demos with deep-link hash URLs
        // (e.g. `#19.80/21.55/108.05/75/64.2`) snapped back to whole-
        // world view as soon as the worker compile resolved.
        this._runBoundsFitGate(() => {
          const [minLon, minLat, maxLon, maxLat] = tileSet.bounds
          if (minLon < Infinity) {
            const clampedLat = Math.max(-85, Math.min(85, (minLat + maxLat) / 2))
            const [cx, cy] = lonLatToMercator((minLon + maxLon) / 2, clampedLat)
            this.camera.centerX = cx
            this.camera.centerY = cy
            const lonSpan = maxLon - minLon
            const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
            const cssW = this.canvas.width / dpr
            const degPerPx = lonSpan / cssW
            this.camera.zoom = Math.max(0.5, Math.log2(360 / (degPerPx * 256)) - 1)
          }
        })
      }).catch((err) => {
        console.error('[X-GIS] GeoJSON compile failed:', err)
      })

      // Setup shader variant if needed. The pipeline + layout must be
      // wired synchronously (they're stored on vectorTileShows and read
      // by the render loop every frame), but the feature data buffer
      // itself is built inside the compile-promise `.then()` above —
      // the property table it needs only exists after the worker
      // compile lands.
      let pipelines: typeof this.vtVariantPipelines = null
      let layout: GPUBindGroupLayout | null = null
      const variantSync = show.shaderVariant
      if (variantSync && (variantSync.preamble || variantSync.needsFeatureBuffer)) {
        try {
          pipelines = this.renderer.getOrCreateVariantPipelines(variantSync as any)
          layout = variantSync.needsFeatureBuffer
            ? this.renderer.featureBindGroupLayout
            : this.renderer.bindGroupLayout
        } catch (e) {
          console.warn('[X-GIS] GeoJSON VT variant pipeline failed:', e)
        }
      }
      this.vectorTileShows.push({ sourceName: vtKey, show, pipelines, layout })
    }

    console.log(`[X-GIS] Rebuilt layers (GPU projection: ${this.projectionName})`)
  }

  /** Build layers for Canvas 2D fallback */
  private rebuildLayersCanvas2D(): void {
    if (!this.canvasRenderer) return

    for (const show of this.showCommands) {
      const data = this.rawDatasets.get(show.targetName)
      if (!data) continue

      const isTile = (data as unknown as { _tileUrl?: string })._tileUrl
      if (isTile) {
        this.canvasRenderer.addLayer(show, null, isTile as string)
      } else {
        const filtered = applyFilter(data, show.filterExpr)
        this.canvasRenderer.addLayer(show, filtered, null)

        // Fit camera to data bounds
        if (data.features?.length) {
          let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
          for (const f of data.features) {
            if (!f.geometry) continue
            const coords = JSON.stringify(f.geometry.coordinates)
            const nums = coords.match(/-?\d+\.?\d*/g)?.map(Number) ?? []
            for (let i = 0; i < nums.length - 1; i += 2) {
              const lon = nums[i], lat = nums[i + 1]
              if (Math.abs(lon) <= 180 && Math.abs(lat) <= 90) {
                minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon)
                minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
              }
            }
          }
          if (minLon < Infinity) {
            const [cx, cy] = lonLatToMercator((minLon + maxLon) / 2, (minLat + maxLat) / 2)
            this.camera.centerX = cx
            this.camera.centerY = cy
            const lonSpan = maxLon - minLon
            const degPerPixel = lonSpan / this.canvas.clientWidth
            this.camera.zoom = Math.max(0.5, Math.log2(360 / (degPerPixel * 256)) - 1)
          }
        }
      }
    }
  }

  /** Canvas 2D render loop */
  private renderLoopCanvas2D = (): void => {
    if (!this.running || !this.canvasRenderer) return
    this.canvasRenderer.render(this.camera, this.projectionName)
    requestAnimationFrame(this.renderLoopCanvas2D)
  }

  /** Load and run a pre-compiled .xgb binary */
  async runBinary(buffer: ArrayBuffer, baseUrl = ''): Promise<void> {
    const scene = deserializeXGB(buffer)
    const commands: SceneCommands = { loads: scene.loads, shows: scene.shows as unknown as SceneCommands['shows'] }

    console.log('[X-GIS] Binary loaded:', commands.loads.length, 'loads,', commands.shows.length, 'shows')

    this.ctx = await initGPU(this.canvas)
    this.renderer = new MapRenderer(this.ctx)
    this.rasterRenderer = new RasterRenderer(this.ctx)
    if (GPU_PROF) this.gpuTimer = new GPUTimer(this.ctx)
      try { this.pointRenderer = new PointRenderer(this.ctx) } catch (e) { console.warn('[X-GIS] PointRenderer init failed:', e) }

    for (const load of commands.loads) {
      const url = load.url.startsWith('http') || load.url.startsWith('/') ? load.url : baseUrl + load.url
      const response = await fetch(url)
      const data = await response.json() as GeoJSONFeatureCollection
      this.rawDatasets.set(load.name, data)
    }

    this.showCommands = commands.shows
    this._sceneHasAnimation = commands.shows.some(s =>
      !!s.timeOpacityStops || !!s.timeFillStops || !!s.timeStrokeStops ||
      !!s.timeStrokeWidthStops || !!s.timeSizeStops || !!s.timeDashOffsetStops
    )
    this._needsRender = true
    this.rebuildLayers()

    this.switchController()
    this.running = true
    this.renderLoop()
    console.log('[X-GIS] Map running (from binary)')
  }

  /** Auto-detect: .xgb binary or .xgis source */
  async load(url: string): Promise<void> {
    const response = await fetch(url)
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1)

    if (url.endsWith('.xgb')) {
      const buffer = await response.arrayBuffer()
      await this.runBinary(buffer, baseUrl)
    } else {
      const source = await response.text()
      await this.run(source, baseUrl)
    }
  }

  private renderLoop = (): void => {
    if (!this.running) return
    if (!this.shouldRenderThisFrame()) {
      requestAnimationFrame(this.renderLoop)
      return
    }
    try {
      this.renderFrame()
    } catch (err) {
      // Surface frame errors to the console so the in-page log overlay
      // (and PC DevTools) can show the real message. Without this wrap,
      // requestAnimationFrame errors bubble to window.onerror as the
      // useless "Script error. @ :0:0" placeholder under iOS WebKit.
      console.error('[X-GIS frame]', (err as Error)?.stack ?? err)
      this.running = false  // stop the loop so the error doesn't repeat 60×/sec
    }
  }

  /** Decide whether `renderLoop` should actually call `renderFrame()`.
   *  Skips the frame when the camera and canvas are unchanged since the
   *  last draw AND no animation / pending data source needs to advance.
   *  `renderFrame` itself updates the stored signature and clears
   *  `_needsRender` after a successful draw. */
  private shouldRenderThisFrame(): boolean {
    if (this._needsRender) return true
    if (this._sceneHasAnimation) return true
    if (this.hasPendingSourceWork()) return true
    const c = this.camera
    const canvas = this.ctx?.canvas
    const w = canvas?.width ?? 0, h = canvas?.height ?? 0
    return (
      c.zoom !== this._lastSigZoom ||
      c.centerX !== this._lastSigCX ||
      c.centerY !== this._lastSigCY ||
      c.bearing !== this._lastSigBearing ||
      c.pitch !== this._lastSigPitch ||
      w !== this._lastSigW ||
      h !== this._lastSigH
    )
  }

  /** Returns true when any source still has work that didn't fit in
   *  the previous frame's budgets — keeps render-on-demand running
   *  until the whole pipeline converges. Without this, sub-tile
   *  generation at deep over-zoom (z=17 over a z=15 PMTiles archive
   *  produces 30+ tiles × 4 layer slices = 120 sub-tile clips, but
   *  the per-frame budget caps at ~50) would partial-fill the
   *  viewport and freeze: render-skip fires after the first paint,
   *  leaving the remaining sub-tiles ungenerated until the camera
   *  next moves. Symptoms: checker-pattern of missing layer slices,
   *  visible sub-tile-aligned rectangular gaps.
   *
   *  Signals checked, in order of cost:
   *    - HTTP fetches in flight (`source.hasPendingLoads`).
   *    - VTR has pending uploads (deferred when the per-frame upload
   *      budget hits its cap).
   *    - Last frame had missed tiles (some visible cells couldn't
   *      find a cached ancestor or didn't get sub-tiled in time). */
  private hasPendingSourceWork(): boolean {
    for (const { source, renderer } of this.vtSources.values()) {
      if (source.hasPendingLoads?.()) return true
      if (renderer.hasPendingUploads?.()) return true
      const stats = renderer.getDrawStats?.()
      if (stats && (stats as { missedTiles?: number }).missedTiles && (stats as { missedTiles: number }).missedTiles > 0) return true
    }
    return false
  }

  /** Classify all visible vector-tile shows into opaque and translucent
   *  buckets for the bucket scheduler. Each show is resolved once — zoom-
   *  interpolated opacity, pipeline + layout picks, early-skip for
   *  effectively-invisible layers — so the pass loop below doesn't repeat
   *  that work.
   *
   *  A translucent-stroke layer appears in BOTH buckets:
   *    - opaque bucket with fillPhase='fills' (draws the polygon fill
   *      with baked alpha into the main color target using standard
   *      alpha blending)
   *    - translucent bucket with phase='strokes' (draws just the SDF
   *      stroke into an offscreen RT with MAX blend, then composites
   *      back with the layer's opacity — kills within-layer alpha
   *      accumulation at corner overlaps)
   *
   *  An opaque layer only appears in the opaque bucket, fillPhase='all',
   *  which renders fill + stroke + inline points in one call.
   */
  /** Thin instance wrapper around the pure classifier in
   *  `bucket-scheduler.ts`. Bundles up the instance state the
   *  classifier needs into a single param object so the underlying
   *  function stays testable in isolation. */
  private classifyVectorTileShows(): {
    opaque: ClassifiedShow[]
    translucent: ClassifiedShow[]
    oit: ClassifiedShow[]
  } {
    return classifyVectorTileShowsImpl({
      vectorTileShows: this.vectorTileShows,
      vtSources: this.vtSources,
      cameraZoom: this.camera.zoom,
      elapsedMs: this._elapsedMs,
      rendererDefaults: {
        fillPipeline: this.renderer.fillPipeline,
        fillPipelineGround: this.renderer.fillPipelineGround,
        linePipeline: this.renderer.linePipeline,
        bindGroupLayout: this.renderer.bindGroupLayout,
        fillPipelineFallback: this.renderer.fillPipelineFallback,
        fillPipelineGroundFallback: this.renderer.fillPipelineGroundFallback,
        linePipelineFallback: this.renderer.linePipelineFallback,
        fillPipelineNoPick: this.renderer.fillPipelineNoPick,
        fillPipelineGroundNoPick: this.renderer.fillPipelineGround,
        linePipelineNoPick: this.renderer.linePipelineNoPick,
        fillPipelineFallbackNoPick: this.renderer.fillPipelineFallbackNoPick,
        fillPipelineGroundFallbackNoPick: this.renderer.fillPipelineGroundFallback,
        linePipelineFallbackNoPick: this.renderer.linePipelineFallbackNoPick,
      },
    })
  }

  /** Thin instance wrapper around the pure grouper in
   *  `bucket-scheduler.ts`. */
  private groupOpaqueBySource(opaque: ClassifiedShow[]): OpaqueGroup[] {
    return groupOpaqueBySourceImpl(opaque)
  }

  private renderFrame(): void {
    this._stats.beginFrame()
    resizeCanvas(this.ctx)

    // Seed the animation clock on first rendered frame, then compute the
    // elapsed wall-clock milliseconds. Everything time-interpolated
    // (opacity today, color/width/etc. in later PRs) reads this value.
    if (this._startTime === null) this._startTime = performance.now()
    this._elapsedMs = performance.now() - this._startTime

    const projType = {
      mercator: 0, equirectangular: 1, natural_earth: 2,
      orthographic: 3, azimuthal_equidistant: 4, stereographic: 5,
      oblique_mercator: 6,
    }[this.projectionName] ?? 0
    const { device, context, canvas } = this.ctx
    const w = canvas.width, h = canvas.height
    if (w === 0 || h === 0) { requestAnimationFrame(this.renderLoop); return }

    // DSFUN precision removes the old `maxSrcLevel + 6` clamp: tile vertices
    // are now stored as f64-equivalent (high/low) Mercator-meter pairs, so
    // a z=5 parent tile survives camera zoom 22 with sub-millimeter jitter.
    // Zoom 22 is a universal cap across every source.
    this.camera.maxZoom = 22

    // Clamp camera Y (latitude bounded), wrap X to a single world.
    const MAX_MERC = 20037508.34
    const WORLD_MERC_FULL = MAX_MERC * 2 // full circumference
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
    const mpp = (WORLD_MERC / TILE_PX) / Math.pow(2, this.camera.zoom)
    const visHalfY = (h / dpr) * mpp / 2
    const maxY = Math.max(0, MAX_MERC - visHalfY)
    this.camera.centerY = Math.max(-maxY, Math.min(maxY, this.camera.centerY))

    // X wrap — camera is allowed to pan infinitely in either direction, but
    // the renderer's world-copy enumeration (`WORLD_COPIES = [-2..+2]`) is
    // expressed as a STATIC offset from the camera's primary world. If
    // camera.centerX drifts outside `[-MAX_MERC, +MAX_MERC]` the outer
    // copies on one side fall off the quadtree's `ox` guard (tiles.ts)
    // while the other side is empty, producing a visible "window" of map
    // inside a black background when panning past ±360° lon. Wrap back
    // into one world so the WORLD_COPIES math is always correct.
    if (this.camera.centerX > MAX_MERC) {
      const over = this.camera.centerX + MAX_MERC
      this.camera.centerX = ((over % WORLD_MERC_FULL) + WORLD_MERC_FULL) % WORLD_MERC_FULL - MAX_MERC
    } else if (this.camera.centerX < -MAX_MERC) {
      const under = this.camera.centerX + MAX_MERC
      this.camera.centerX = ((under % WORLD_MERC_FULL) + WORLD_MERC_FULL) % WORLD_MERC_FULL - MAX_MERC
    }

    // RTC: Camera center IS projection center. Always.
    const R = 6378137
    const centerLon = (this.camera.centerX / R) * (180 / Math.PI)
    const centerLat = Math.max(-85, Math.min(85,
      (2 * Math.atan(Math.exp(this.camera.centerY / R)) - Math.PI / 2) * (180 / Math.PI)
    ))

    const encoder = device.createCommandEncoder()
    const screenView = context.getCurrentTexture().createView()
    // Reset per-frame sub-pass assignment in the timer. Subsequent
    // passWrites() calls will return contiguous timestamp ranges
    // starting at sub-pass 0.
    this.gpuTimer?.beginFrame()
    // DIAG: when set to `true`, the next frame's VTR.render() calls
    // log into __xgisDrawOrderTrace; we capture + console.log the
    // sequence at the end of the frame and clear the flag so only
    // ONE frame is captured. Set externally by tests / inspector.
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __xgisCaptureDrawOrder?: boolean; __xgisDrawOrderTrace?: unknown[] }
      if (w.__xgisCaptureDrawOrder) {
        w.__xgisDrawOrderTrace = []
      }
    }
    // Wrap the entire frame in a validation scope so any pass-creation or
    // draw-call validation error gets a unique log entry pointing to the
    // submit. Each block below also pushes its own scope for finer locality.
    device.pushErrorScope('validation')

    // Per-pass scope helper: pushes an error scope, runs `fn`, then pops and
    // logs any validation error tagged with `label`. Nested inside the
    // frame-level scope so both levels fire independently — the inner scope
    // pinpoints which pass failed, the outer one catches encoder-wide state.
    const passScope = (label: string, fn: () => void): void => {
      device.pushErrorScope('validation')
      try { fn() }
      finally {
        device.popErrorScope().then((err) => {
          if (err) console.error(`[X-GIS pass:${label}]`, err.message)
        }).catch(() => { /* scope stack mismatch — swallow */ })
      }
    }

    {
      // ═══ Direct rendering: vertex shader handles all projections ═══
      // MSAA + stencil texture management (recreate on resize).
      // sample count tracks the pipeline-time SAMPLE_COUNT (1 on mobile /
      // ?safe / ?quality=performance / ?msaa=1, 4 on desktop default).
      const sc = getSampleCount()
      const useResolve = sc > 1
      if (!this.stencilTexture || this.msaaWidth !== w || this.msaaHeight !== h) {
        this.msaaTexture?.destroy()
        this.stencilTexture?.destroy()
        this.pickTexture?.destroy()
        this.oitAccumTexture?.destroy()
        this.oitRevealageTexture?.destroy()
        this.overdrawAccumTexture?.destroy()
        this.overdrawAccumTexture = null
        // Allocate the MSAA color attachment ONLY when MSAA is on. When
        // sc === 1 we render straight to the swapchain (no resolveTarget)
        // and the MSAA texture would just waste w×h×4 bytes per frame.
        this.msaaTexture = useResolve
          ? device.createTexture({
              size: { width: w, height: h },
              format: this.ctx.format,
              sampleCount: sc,
              usage: GPUTextureUsage.RENDER_ATTACHMENT,
            })
          : null
        this.stencilTexture = device.createTexture({
          size: { width: w, height: h },
          format: 'depth24plus-stencil8',
          sampleCount: sc,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })
        // Pick RT: RG32Uint, single-sample. `?picking=1` forces SAMPLE_COUNT
        // to 1 globally (see quality.ts) so sc === 1 here whenever PICK is
        // true — the pick attachment and color attachment share sample count
        // as WebGPU requires.
        this.pickTexture = isPickEnabled()
          ? device.createTexture({
              size: { width: w, height: h },
              format: 'rg32uint',
              sampleCount: 1,
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            })
          : null
        // OIT render targets — sampleCount matches the opaque pass so
        // both can share the same depth attachment. Without that
        // sharing the OIT pass had no depth → translucent buildings
        // didn't occlude behind opaque foreground walls. Compose
        // pass resolves the MSAA samples by averaging in the shader.
        this.oitAccumTexture = device.createTexture({
          size: { width: w, height: h },
          format: OIT_ACCUM_FORMAT,
          sampleCount: sc,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          label: 'oit-accum',
        })
        this.oitRevealageTexture = device.createTexture({
          size: { width: w, height: h },
          format: OIT_REVEALAGE_FORMAT,
          sampleCount: sc,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          label: 'oit-revealage',
        })
        if (DEBUG_OVERDRAW) {
          // r16float lets per-pixel additive accumulation grow well
          // past the [0, 1] swapchain range. MSAA forced to 1× in
          // quality.ts when debug=overdraw, so sampleCount=1 here.
          this.overdrawAccumTexture = device.createTexture({
            size: { width: w, height: h },
            format: 'r16float',
            sampleCount: 1,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            label: 'overdraw-accum',
          })
        }
        this.msaaWidth = w
        this.msaaHeight = h
      }

      // When SAMPLE_COUNT === 1 (mobile / no MSAA), render DIRECTLY to the
      // swapchain texture and never set a resolveTarget — single-sample
      // attachments cannot have a resolve target per WebGPU spec.
      //
      // `?debug=overdraw` reroutes every opaque/translucent pass into the
      // r16float accumulator instead. A trailing compose pass at the end
      // of the frame samples the accumulator and writes the colormap to
      // the swapchain. Translucent/OIT paths still run — their debug
      // pipeline mirrors emit into the same accumulator with additive
      // blend, so the heatmap counts every contributing draw.
      const colorView = DEBUG_OVERDRAW
        ? this.overdrawAccumTexture!.createView()
        : (useResolve ? this.msaaTexture!.createView() : screenView)

      // Reset per-frame uniform ring cursors (dynamic-offset slots).
      this.renderer.beginFrame()
      this.lineRenderer?.beginFrame()
      this.rasterRenderer.beginFrame()
      // PointRenderer drains its retired tile-point buffer queue here
      // — buffers retired during last frame's renderTilePoints can
      // safely be destroyed now that queue.submit() has returned for
      // that frame. Keeps the multi-VTR layered demo (4× tile-point
      // rebuilds per frame) from triggering "Buffer used in submit
      // while destroyed" validation errors.
      this.pointRenderer?.beginFrame()
      // Thread the renderer's _frameCount into each VTR so its
      // per-frame catalog budget reset can short-circuit duplicate
      // calls from the same source feeding multiple layers.
      for (const [, { renderer: vtR }] of this.vtSources) vtR.beginFrame(this._frameCount)
      // Frame-scope prefetch pump — fires exactly once per wall-clock
      // frame for every attached vector source. Hosts the
      // Google-Earth-style pan-direction speculation + AMMOS
      // 3D-Tiles-Renderer-style loadSiblings. Critical that this
      // lives in renderFrame (not VTR.render, which the bucket
      // scheduler invokes per ShowCommand ~80× on dense styles) so
      // the prev-cam velocity vector and _evictShield population
      // stay frame-stable. See VTR.pumpPrefetch doc.
      for (const [, { renderer: vtR }] of this.vtSources) {
        vtR.pumpPrefetch(this.camera, projType, w, h, dpr)
      }

      // ══════ Bucket scheduler ══════
      //
      // Layers are classified into two buckets so alpha compositing is
      // always correct regardless of user declaration order:
      //
      //   1. OPAQUE bucket — every vector source's fills + opaque
      //      strokes + the fill half of translucent-stroke layers.
      //      Runs first so translucent content has a finished opaque
      //      backdrop to blend against. Sources that don't share
      //      stencil state get their own sub-pass (each sub-pass
      //      clears stencil), but consecutive same-source shows share
      //      one sub-pass.
      //
      //   2. TRANSLUCENT bucket — offscreen MAX-blend + composite for
      //      each translucent-stroke layer, in declaration order.
      //      Runs after the entire opaque bucket so translucent
      //      strokes always paint on top of opaque content.
      //
      //   3. POINTS bucket — a single pass (or inline in bucket 1)
      //      for SDF points. Always last so points draw over the map.
      //
      // The previous scheduler interleaved bucket 1 + 2 per source,
      // which broke the ordering when a translucent layer was
      // declared before an opaque layer: the translucent composite
      // would run BEFORE the later opaque fill, and the opaque fill
      // would cover the translucent strokes.
      const { opaque, translucent, oit } = this.classifyVectorTileShows()
      const opaqueGroups = this.groupOpaqueBySource(opaque)
      const hasTranslucent = translucent.length > 0 && this.lineRenderer !== null
      const hasOit = oit.length > 0 && this.oitAccumTexture !== null && this.oitRevealageTexture !== null
      const hasPoints = this.pointRenderer?.hasLayers() ?? false
      // ── Two independent point paths ──
      //
      // 1. TILE points: data lives on xgvt tiles (e.g. countries_xgvt
      //    + populated_places_xgvt). VTR drains them per-source via
      //    pointRenderer.addTilePoint/flushTilePoints inside its own
      //    render pass. We pass `pointRenderer` to every VTR.render
      //    call below — VTR's tile loop is a no-op for sources that
      //    don't carry point vertices, so this is safe and free.
      //
      // 2. DIRECT-LAYER points: GeoJSON sources where rebuildLayers
      //    routed the show into pointRenderer.addLayer() instead of
      //    creating a vector-tile pipeline. These live in
      //    pointRenderer.layers and are rendered by a dedicated bucket
      //    3 pass. They are NEVER reachable from VTR.render — VTR
      //    only sees tile data.
      //
      // The original `inlinePoints` optimization conflated these two
      // paths and silently skipped bucket 3 whenever there was no
      // translucent layer, hiding every direct-layer point demo
      // (sdf_points, gradient_points, megacities, custom_*, etc).
      // Fix: bucket 3 always runs when direct-layer points exist.
      // Which pass owns the MSAA resolveTarget? Precisely the last
      // pass that writes to the color target. Priority: dedicated
      // points > last composite > last opaque sub-pass.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _resolveOwner = hasPoints
        ? 'points'
        : hasTranslucent
          ? 'composite'
          : 'opaque'

      if (hasTranslucent) this.lineRenderer!.ensureOffscreen(w, h)

      // ── Bucket 1: opaque ──
      // Always emit at least one pass so raster + canvas background
      // can run even if there are no vector layers to draw. The first
      // pass clears the color target; subsequent opaque sub-passes
      // load.
      const opaqueCount = Math.max(1, opaqueGroups.length)
      for (let gi = 0; gi < opaqueCount; gi++) {
        const group = opaqueGroups[gi]
        const isFirst = gi === 0
        const isLastOpaque = gi === opaqueCount - 1
        // Only the LAST opaque sub-pass can claim resolveTarget, and
        // only if no translucent/points pass runs after it.
        const resolveHere =
          useResolve && isLastOpaque && _resolveOwner === 'opaque'
        // Depth must persist across opaque sub-passes so group N's
        // polygons are correctly occluded by group N-1's (e.g. roads
        // rendered after buildings must respect building depth in a
        // pitched / globe view), and across into the points bucket for
        // the same reason. Only the final consumer can discard. Tile-
        // based mobile GPUs pay a write-back when we store, but the
        // result was visibly wrong without it.
        // OIT pass needs the opaque depth to occlude translucent
        // fragments behind opaque foreground walls; bucket 3 (points)
        // also reads it. Either consumer requires the LAST opaque
        // sub-pass to STORE depth instead of discarding.
        const persistDepth = !isLastOpaque || hasPoints || hasOit

        passScope(isFirst ? 'opaque-main' : `opaque[${gi}]`, () => {
          // Time EVERY opaque sub-pass. The timer pre-allocates a
          // QuerySet wide enough for MAX_SUBPASSES sub-passes, with
          // sub-pass 0 carrying the inside-passes breakdown (bg/raster/
          // legacy/vt) and sub-passes 1..N each contributing one
          // (begin..end) duration that aggregates into the `vt` ring.
          // Demos like osm_style split opaque rendering across multiple
          // groups; single-pass timing missed everything past the first.
          const tsWrites = this.gpuTimer?.passWrites() || undefined
          // Build color attachments. When picking is enabled, add a
          // second RG32Uint attachment at location 1 — every pipeline
          // in the main passes has a matching second fragment output
          // that writes `vec2<u32>(feature_id, instance_id)`. The first
          // sub-pass clears the pick texture to (0, 0) = "no feature";
          // subsequent sub-passes load so earlier-group IDs persist
          // where later groups didn't draw.
          const colorAttachments: GPURenderPassColorAttachment[] = [{
            view: colorView,
            resolveTarget: resolveHere ? screenView : undefined,
            // First pass clears to a neutral dark "space" color
            // visible only where the globe ISN'T (ortho projection
            // corners outside the sphere). Mapbox `background`
            // semantics — earth-surface fill — is now handled
            // through the regular tile pipeline via a synthetic
            // GeoJSON source injected at parse time. In debug=overdraw
            // mode the r16float accumulator clears to 0 — every fragment
            // count starts from zero.
            clearValue: isFirst
              ? (DEBUG_OVERDRAW
                  ? { r: 0, g: 0, b: 0, a: 0 }
                  : { r: 0.039, g: 0.039, b: 0.063, a: 1 })
              : undefined,
            loadOp: isFirst ? 'clear' : 'load',
            storeOp: 'store',
          }]
          if (isPickEnabled() && this.pickTexture) {
            colorAttachments.push({
              view: this.pickTexture.createView(),
              clearValue: isFirst ? { r: 0, g: 0, b: 0, a: 0 } : undefined,
              loadOp: isFirst ? 'clear' : 'load',
              storeOp: 'store',
            })
          }
          const subPass = encoder.beginRenderPass({
            colorAttachments,
            depthStencilAttachment: {
              view: this.stencilTexture!.createView(),
              depthClearValue: 1.0,
              // First sub-pass clears depth; subsequent ones load the
              // depth their predecessor stored.
              depthLoadOp: isFirst ? 'clear' : 'load',
              depthStoreOp: persistDepth ? 'store' : 'discard',
              // Stencil IS still per-sub-pass — each opaque group uses
              // unique IDs for its own polygon coverage and they don't
              // need to survive across groups.
              stencilClearValue: 0,
              stencilLoadOp: 'clear',
              stencilStoreOp: 'discard',
            },
            timestampWrites: tsWrites,
          })

          // First opaque pass owns raster + canvas-2D background
          // content. These are always the back-most layers in the
          // current architecture.
          if (isFirst) {
            // Earth-surface fill — fullscreen quad with depth/stencil
            // writes disabled. Runs first so subsequent draws paint
            // freely on top with no depth-buffer interaction.
            this.backgroundRenderer?.render(subPass)
            this.gpuTimer?.mark(subPass, 'after_bg')
            this.rasterRenderer.render(subPass, this.camera, projType, centerLon, centerLat, w, h, dpr)
            this.gpuTimer?.mark(subPass, 'after_raster')
            this.renderer.renderToPass(subPass, this.camera, projType, centerLon, centerLat, this._elapsedMs)
            this.gpuTimer?.mark(subPass, 'after_legacy')
          }

          // Render the group's vector tile shows (if any). Two-phase
          // within the same sub-pass:
          //   Phase 1: 2D ground shows (extrude.kind === 'none' or
          //            absent) — depth-disabled fill, painter's order
          //            decided by GPU command order.
          //   Phase 2: 3D extruded shows (extrude.kind !== 'none')
          //            — depth-write enabled, cross-tile occlusion
          //            resolves via depth-test against a depth
          //            attachment that's CLEAN at the start of phase 2
          //            (phase 1 didn't write depth). This is the
          //            architectural separation 3D rendering needs:
          //            RT-painted ground is conceptually a backdrop
          //            for the 3D world, and mixing them in arbitrary
          //            declaration order breaks cross-tile depth
          //            ordering at high pitch (back-tile buildings
          //            poking through closer-tile buildings) when a
          //            ground show happens to land between two
          //            extruded shows in the same group. Two-phase
          //            ordering within the group enforces the
          //            invariant regardless of declaration order.
          //
          // In a points-only demo (no opaque vector tile layers at
          // all) `group` is undefined and the synthetic first pass
          // exists only to clear the canvas + draw raster + draw
          // legacy MapRenderer layers. We MUST still call
          // subPass.end() in that case, otherwise the pass stays
          // open and bucket 3 (or any subsequent encoder operation)
          // trips a "RenderPassEncoder is open" validation error.
          if (group) {
            const isExtruded = (cs: typeof group.shows[number]): boolean => {
              const ex = (cs.show as { extrude?: { kind?: string } }).extrude
              return !!ex && ex.kind !== undefined && ex.kind !== 'none'
            }
            // Debug=overdraw: collapse every fill variant onto the
            // single fill debug pipeline whose bgl matches the show's.
            // VTR's setPipeline calls use it uniformly — fallback /
            // ground / extruded variants all output the same constant
            // fragment count. Line pipeline is unused inside VTR's
            // debug path (strokes route through LineRenderer which is
            // gated off too), but we still pass a non-null override
            // for completeness.
            const drawShow = (cs: typeof group.shows[number]) => {
              const debugFp = DEBUG_OVERDRAW
                ? (cs.bgl === this.renderer.featureBindGroupLayout
                    ? this.renderer.fillPipelineOverdrawFeature!
                    : this.renderer.fillPipelineOverdraw!)
                : null
              const debugLp = DEBUG_OVERDRAW ? this.renderer.linePipelineOverdraw! : null
              const fp = debugFp ?? cs.fp
              const lp = debugLp ?? cs.lp
              const fpF = debugFp ?? cs.fpF
              const lpF = debugLp ?? cs.lpF
              const fpG = debugFp ?? cs.fpG
              const fpGF = debugFp ?? cs.fpGF
              cs.vtEntry.renderer.render(
                subPass, this.camera, projType, centerLon, centerLat, w, h,
                cs.show, fp, lp, this.renderer.uniformBuffer, cs.bgl,
                fpF, lpF,
                DEBUG_OVERDRAW ? null : this.pointRenderer,
                cs.fillPhase,
                dpr,
                fpG, fpGF,
              )
            }
            for (let si = 0; si < group.shows.length; si++) {
              if (!isExtruded(group.shows[si])) drawShow(group.shows[si])
            }
            for (let si = 0; si < group.shows.length; si++) {
              if (isExtruded(group.shows[si])) drawShow(group.shows[si])
            }
          }

          subPass.end()
        })
      }

      // ── Bucket 1.5: OIT translucent extrude ──
      // Render every translucent extruded fill into the accum +
      // revealage MRT pair (depth-load from opaque, no depth write),
      // then blend the recovered colour onto the resolved main
      // colour with a full-screen compose draw. Order-independent
      // by construction — no back-to-front sort.
      if (hasOit && !DEBUG_OVERDRAW) {
        passScope('oit-fill', () => {
          // OIT pass shares the opaque pass's MSAA depth-stencil
          // (depthLoadOp='load' so the opaque depth is what
          // translucent fragments test against). depthStoreOp='discard'
          // because no later pass needs the OIT-side depth. With
          // sample counts matched, translucent buildings hide
          // correctly behind opaque foreground walls — full
          // McGuire-Bavoil order independence applies only to
          // translucent-vs-translucent.
          const oitPass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: this.oitAccumTexture!.createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear', storeOp: 'store',
              },
              {
                view: this.oitRevealageTexture!.createView(),
                clearValue: { r: 1, g: 0, b: 0, a: 0 },
                loadOp: 'clear', storeOp: 'store',
              },
            ],
            depthStencilAttachment: {
              view: this.stencilTexture!.createView(),
              depthLoadOp: 'load', depthStoreOp: 'discard',
              stencilLoadOp: 'load', stencilStoreOp: 'discard',
            },
          })
          for (const cs of oit) {
            cs.vtEntry.renderer.render(
              oitPass, this.camera, projType, centerLon, centerLat, w, h,
              cs.show, cs.fp, cs.lp, this.renderer.uniformBuffer, cs.bgl,
              cs.fpF, cs.lpF,
              null, 'oit-fill',
              dpr,
              cs.fpG, cs.fpGF,
            )
          }
          oitPass.end()
        })

        passScope('oit-compose', () => {
          const compPass = encoder.beginRenderPass({
            colorAttachments: [{
              view: colorView,
              resolveTarget: useResolve && !hasTranslucent && !hasPoints && _resolveOwner === 'composite' ? screenView : undefined,
              loadOp: 'load', storeOp: 'store',
            }],
          })
          // Lazy-build the bind group when texture views change.
          const bg = this.ctx.device.createBindGroup({
            layout: this.renderer.oitComposeBindGroupLayout,
            entries: [
              { binding: 0, resource: this.oitAccumTexture!.createView() },
              { binding: 1, resource: this.oitRevealageTexture!.createView() },
            ],
          })
          compPass.setPipeline(this.renderer.oitComposePipeline)
          compPass.setBindGroup(0, bg)
          compPass.draw(3) // oversized triangle — vs_full covers fullscreen with 3 verts
          compPass.end()
        })
      }

      // ── Bucket 2: translucent offscreen + composite ──
      if (hasTranslucent && !DEBUG_OVERDRAW) {
        for (let li = 0; li < translucent.length; li++) {
          const cs = translucent[li]
          const isLastTranslucent = li === translucent.length - 1
          const resolveHere =
            useResolve && isLastTranslucent && _resolveOwner === 'composite'

          passScope(`translucent-off[${li}]`, () => {
            const offPass = this.lineRenderer!.beginTranslucentPass(encoder)
            cs.vtEntry.renderer.render(
              offPass, this.camera, projType, centerLon, centerLat, w, h,
              cs.show, cs.fp, cs.lp, this.renderer.uniformBuffer, cs.bgl,
              cs.fpF, cs.lpF,
              null, 'strokes',
              dpr,
              cs.fpG, cs.fpGF,
              true, // translucentBucket — offscreen pass has no depth
            )
            offPass.end()
          })

          passScope(`translucent-comp[${li}]`, () => {
            const compPass = encoder.beginRenderPass({
              colorAttachments: [{
                view: colorView,
                resolveTarget: resolveHere ? screenView : undefined,
                loadOp: 'load',
                storeOp: 'store',
              }],
            })
            this.lineRenderer!.composite(compPass, cs.show.opacity ?? 1)
            compPass.end()
          })
        }
      }

      // ── Bucket 3: direct-layer points ──
      // Renders pointRenderer.layers (GeoJSON sources routed through
      // pointRenderer.addLayer in rebuildLayers). Always runs when
      // direct layers exist; tile-points are handled inline in
      // bucket 1 via VTR.render's pointRenderer parameter.
      if (hasPoints && !DEBUG_OVERDRAW) {
        passScope('points', () => {
          const ptPass = encoder.beginRenderPass({
            colorAttachments: [{
              view: colorView,
              resolveTarget: useResolve ? screenView : undefined,
              loadOp: 'load',
              storeOp: 'store',
            }],
            depthStencilAttachment: {
              view: this.stencilTexture!.createView(),
              // Load the depth the last opaque sub-pass stored above so
              // billboards on the back side of a globe / pitched surface
              // are correctly occluded by the front-facing opaque
              // polygons. Translucent points still skip depth WRITES
              // (their pipeline disables depthWriteEnabled), so a halo
              // doesn't block other markers — but they DO depth-test.
              depthClearValue: 1.0, depthLoadOp: 'load', depthStoreOp: 'discard',
              stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard',
            },
          })
          // Re-evaluate zoom-interpolated point sizes against the
          // current camera before drawing. No-op for layers without
          // zoomSizeStops; internally skipped when zoom is unchanged.
          this.pointRenderer!.updateDynamicSizes(this.camera.zoom, interpolateZoom)
          this.pointRenderer!.render(ptPass, this.camera, projType, centerLon, centerLat, w, h, dpr)
          ptPass.end()
        })
      }

      // ── Bucket 4: text overlays + per-feature labels ──
      // Two sources of label work:
      //   (a) `map.addOverlay(...)` — explicit (lon, lat) overlays
      //       set imperatively from app code.
      //   (b) layers whose ShowCommand carries a `.label` LabelDef
      //       (Mapbox `text-field` / xgis `label-["{...}"]`). We
      //       walk the source's GeoJSON features, resolve the
      //       template against each feature's properties, and
      //       project the centroid.
      // Lazy-init the stage on first use so a label-free map
      // allocates no atlas pages.
      // Diagnostic kill switch — `window.__xgisDisableLabels = true`
      // before render() short-circuits ALL label work. Used to A/B
      // measure text subsystem cost vs the rest of the frame.
      const disableLabels = typeof window !== 'undefined'
        && (window as unknown as { __xgisDisableLabels?: boolean }).__xgisDisableLabels === true
      // Mapbox `layer.minzoom` / `layer.maxzoom`: hide the layer
      // outside its declared zoom range. Without this gate every
      // sub-layer of a multi-zoom Mapbox style renders at every
      // zoom level — at z=1.86 with OFM Bright that means city /
      // state / town / village / suburb / POI labels all piling
      // onto the antimeridian view, drowning out the few
      // country-level labels that should be visible there.
      const camZ = this.camera.zoom
      const inZoomRange = (s: ShowCommand): boolean =>
        (s.minzoom === undefined || camZ >= s.minzoom)
        && (s.maxzoom === undefined || camZ < s.maxzoom)
      const labelShows = disableLabels
        ? []
        : this.showCommands.filter(s => s.label !== undefined && s.visible !== false && inZoomRange(s))
      if (!disableLabels && (this.overlays.length > 0 || labelShows.length > 0)) {
        if (this.textStage === null) {
          this.textStage = new TextStage(device, this.ctx.format, {}, sc)
          this.textStage.prewarmGISDefaults()
          // Attach any debug hook that was set before the stage existed.
          // The hook is null/undefined-safe on the stage side, so the
          // common no-debug path stays a single null-check inside
          // addLabel.
          if (this._pendingLabelDebugHook !== undefined) {
            this.textStage.setLabelDebugHook(this._pendingLabelDebugHook)
          }
        }
        const stage = this.textStage
        // Anchors are projected against canvas.width/height (physical
        // px); LabelDef.size etc. are CSS-px convention. Telling the
        // stage the current DPR keeps text the right visual size on
        // hidpi displays — without this, a `label-size-13` renders
        // at 6.5 CSS px on a 2x display.
        stage.setDpr(dpr)
        const frame = this.camera.getFrameView(w, h, dpr)
        const mvp = frame.matrix
        const ccx = this.camera.centerX
        const ccy = this.camera.centerY

        // Inline projector — captures matrix + camera center; returns
        // null when the point projects behind camera or far outside.
        // `worldMercatorOffset` shifts the mercator X by N×WORLD_MERC
        // so the polygon renderer's world-copy loop can be mirrored
        // for labels (see projectLonLatCopies below).
        const projectLonLat = (
          lon: number, lat: number, worldMercatorOffset: number = 0,
        ): [number, number] | null => {
          const [mx, my] = lonLatToMercator(lon, lat)
          const rtcX = (mx + worldMercatorOffset) - ccx
          const rtcY = my - ccy
          const cw = mvp[3]! * rtcX + mvp[7]! * rtcY + mvp[15]!
          if (cw <= 0) return null
          const ccx_ = mvp[0]! * rtcX + mvp[4]! * rtcY + mvp[12]!
          const ccy_ = mvp[1]! * rtcX + mvp[5]! * rtcY + mvp[13]!
          const ndcX = ccx_ / cw
          const ndcY = ccy_ / cw
          if (ndcX < -1.5 || ndcX > 1.5 || ndcY < -1.5 || ndcY > 1.5) return null
          return [(ndcX + 1) * 0.5 * w, (1 - ndcY) * 0.5 * h]
        }

        // Mercator is periodic in lon, so PointRenderer / VTR emit
        // every polygon 5× across the -2..+2 world copies. Without
        // mirroring the same loop here, a country anchor at lon=-179
        // gets ONE label at its primary copy and nothing on the
        // adjacent +360° copy that's also visible at z≤2. Result: at
        // low zoom labels visibly cluster on one side of the world
        // map ("포인트가 한쪽에 몰림"). Non-Mercator projections
        // collapse to a single copy — see worldCopiesFor() in
        // gpu-shared for the rationale.
        const worldCopyOffsets: readonly number[] = this.projectionName === 'mercator'
          ? WORLD_COPIES
          : [0]
        const projectLonLatCopies = (lon: number, lat: number): Array<[number, number]> => {
          const out: Array<[number, number]> = []
          for (const w of worldCopyOffsets) {
            const proj = projectLonLat(lon, lat, w * WORLD_MERC)
            if (proj) out.push(proj)
          }
          return out
        }

        // (a) Imperative overlays
        for (const ov of this.overlays) {
          const projected = projectLonLat(ov.lon, ov.lat)
          if (!projected) continue
          const tv = {
            kind: 'expr' as const,
            expr: { ast: { kind: 'StringLiteral' as const, value: ov.text } as never },
          }
          stage.addLabel(tv, {}, projected[0], projected[1], {
            text: tv,
            size: ov.size,
            color: ov.color,
            halo: ov.halo,
            transform: ov.transform,
          }, ov.font)
        }

        // (b) Per-feature labels from ShowCommand.label
        for (const show of labelShows) {
          // If LabelDef.color is unset, fall back to the layer's fill
          // (typical Mapbox-style symbol-on-poly pattern: the same
          // colour for the polygon AND its label). When THAT is also
          // unset, default to white so dark backgrounds stay readable.
          const def = show.label!
          const z = this.camera.zoom
          // Resolve zoom-interpolated text-size against the current
          // camera zoom (Mapbox `text-size: ["interpolate", …, ["zoom"], …]`).
          const resolvedSize = def.sizeZoomStops && def.sizeZoomStops.length > 0
            ? interpolateZoom(def.sizeZoomStops, z, def.sizeZoomStopsBase ?? 1)
            : def.size
          // text-color: zoom-interpolated stops win over the static
          // colour, which itself wins over the layer-fill fallback.
          // RGBA components interpolate independently — alpha included
          // so fade-in / fade-out stops work too.
          let resolvedColor: [number, number, number, number] | undefined = def.color
          if (def.colorZoomStops && def.colorZoomStops.length > 0) {
            resolvedColor = interpolateZoomRgba(def.colorZoomStops, z)
          }
          if (resolvedColor === undefined) {
            resolvedColor = hexToRgba(show.fill) ?? [1, 1, 1, 1]
          }
          // text-halo: zoom-interpolate width and colour independently.
          let resolvedHalo = def.halo
          if (def.haloWidthZoomStops && def.haloWidthZoomStops.length > 0) {
            const w = interpolateZoom(def.haloWidthZoomStops, z, def.haloWidthZoomStopsBase ?? 1)
            resolvedHalo = {
              ...(resolvedHalo ?? { color: [0, 0, 0, 1], width: 0 }),
              width: w,
            }
          }
          if (def.haloColorZoomStops && def.haloColorZoomStops.length > 0) {
            const c = interpolateZoomRgba(def.haloColorZoomStops, z)
            resolvedHalo = {
              ...(resolvedHalo ?? { color: c, width: 0 }),
              color: c,
            }
          }
          // text-rotation-alignment: 'map' makes point labels rotate
          // with the map bearing (text follows the world, not the
          // viewport). 'auto' resolves to viewport for point placement
          // and map for line — matching our existing default behaviour
          // (point labels = no rotation, line labels = tangent rotation
          // computed in screen space). For explicit 'map' on points we
          // bake camera bearing into the label rotate. Mapbox 'pitch-
          // alignment: map' (text laid on the ground plane with
          // perspective) requires shader-side MVP integration — not
          // implemented; we still honour the user intent for the
          // rotation knob since it's the more common request.
          const isLineLabel = def.placement === 'line' || def.placement === 'line-center'
          const rotAlign = def.rotationAlignment ?? 'auto'
          const useMapRotForPoints = !isLineLabel
            && (rotAlign === 'map'
              || (rotAlign === 'auto' && false))  // auto = viewport for point, no extra rotation
          // Bearing rotation for `map`-aligned point labels. Camera
          // bearing is in degrees CCW; text-rotate is degrees CW.
          // Negate so a 30° map rotation yields a 30° label rotation
          // in the same visual direction.
          const bearingDeg = useMapRotForPoints ? -this.camera.bearing : 0
          const effectiveDef = {
            ...def,
            size: resolvedSize,
            color: resolvedColor,
            ...(resolvedHalo !== undefined ? { halo: resolvedHalo } : {}),
            ...(bearingDeg !== 0
              ? { rotate: (def.rotate ?? 0) + bearingDeg } : {}),
          }

          // Per-feature evaluator for data-driven text-size /
          // text-color (Mapbox `["case", …]` / `["match", …]` /
          // arithmetic forms). Used inside the iterator paths below
          // — wraps a feature's def with overrides resolved from
          // sizeExpr / colorExpr against that feature's properties.
          const applyFeatureExprs = (props: Record<string, unknown>) => {
            const hasSizeExpr = def.sizeExpr !== undefined
            const hasColorExpr = def.colorExpr !== undefined
            if (!hasSizeExpr && !hasColorExpr) return effectiveDef
            const out = { ...effectiveDef }
            if (hasSizeExpr) {
              try {
                const v = evaluate(def.sizeExpr!.ast as never, props)
                if (typeof v === 'number' && isFinite(v)) out.size = v
              } catch { /* fall back to effectiveDef.size */ }
            }
            if (hasColorExpr) {
              try {
                const v = evaluate(def.colorExpr!.ast as never, props)
                if (typeof v === 'string') {
                  const hex = resolveColor(v)
                  const rgba = hexToRgba(hex ?? v)
                  if (rgba) out.color = rgba
                }
              } catch { /* fall back to effectiveDef.color */ }
            }
            return out
          }

          // Path 1: GeoJSON / inline-data sources whose features live
          // in `rawDatasets`. Iterates the FeatureCollection directly
          // and uses `featureAnchor` to pick a centroid per geometry.
          const data = this.rawDatasets.get(show.targetName)
          if (data && data.features && !(data as unknown as { _vectorTile?: boolean })._vectorTile) {
            for (const feat of data.features) {
              if (!feat.geometry) continue
              const anchor = featureAnchor(feat.geometry)
              if (!anchor) continue
              const featDef = applyFeatureExprs(feat.properties ?? {})
              // Pass the full LabelDef and let TextStage.composeFontKey
              // build the ctx.font shorthand (weight, italic, CJK
              // fallback chain). Passing `def.font?.[0]` as a 6th-arg
              // override here used to short-circuit that — every Mapbox
              // label rendered in Regular weight and lost Hangul / Han
              // fallback. Keep this comment on every call site so the
              // override doesn't quietly come back.
              for (const projected of projectLonLatCopies(anchor[0], anchor[1])) {
                stage.addLabel(
                  featDef.text, feat.properties ?? {},
                  projected[0], projected[1], featDef,
                )
              }
            }
            continue
          }

          // Path 2: vector-tile sources (PMTiles / .xgvt / Mapbox
          // converter output). Features live in the VTR tile cache.
          // We delegate iteration to VTR.forEachLabelFeature which
          // walks `stableKeys` × `pointVertices` and rebuilds the
          // property bag from the source's PropertyTable. Mercator
          // coords come out in absolute meters; we go through the
          // same projector by inverting back to lon/lat.
          const vtEntry = this.vtSources.get(show.targetName)
          if (vtEntry) {
            const DEG2RAD = Math.PI / 180
            const R = 6378137
            const mercToLonLat = (mx: number, my: number): [number, number] => [
              (mx / R) / DEG2RAD,
              (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) / DEG2RAD,
            ]
            // The MVT worker buckets features per (sourceLayer, filter)
            // and stores each subset under its sliceKey — so a layer
            // with a `filter:` produces e.g. `place::abc123` instead of
            // bare `place`. Without using sliceKey here every filtered
            // label show (label_country_*, label_city, label_town, …
            // for the Bright basemap — every place / poi label that
            // isn't a single unfiltered show) silently iterated zero
            // tiles. Unfiltered shows still work because computeSliceKey
            // collapses the no-filter case to the bare sourceLayer.
            const sliceKey = computeSliceKey(
              show.sourceLayer ?? '',
              show.filterExpr?.ast as Parameters<typeof computeSliceKey>[1],
            )
            // Along-path placement: walk lineVertices instead of
            // pointVertices, project both segment endpoints, anchor
            // at the screen-space midpoint, rotate by the screen-
            // space tangent. Computing the angle in screen space
            // (not mercator) keeps the label aligned with the visible
            // road through any pitch / bearing.
            const useLine = effectiveDef.placement === 'line' || effectiveDef.placement === 'line-center'
            if (useLine) {
              // Mapbox `symbol-spacing` (CSS px). When set on a line
              // placement layer (placement === 'line' only — line-
              // center always emits one label at the midpoint), walk
              // the screen-projected polyline and emit a label every
              // `spacing` pixels. Without this, long highways get a
              // single label which Mapbox would render as a repeating
              // chain. Spacing is in CSS px → multiply by DPR for
              // the physical-pixel polyline space.
              const spacingCssPx = effectiveDef.placement === 'line'
                ? (effectiveDef.spacing ?? 0) : 0
              const spacingPx = spacingCssPx > 0 ? spacingCssPx * dpr : 0
              // Mapbox `text-rotation-alignment: viewport` for line
              // placement keeps the label upright on screen instead of
              // following the road tangent. 'auto' on line resolves to
              // 'map' (= tangent), matching the historical behaviour.
              const lineRotAlign = effectiveDef.rotationAlignment ?? 'auto'
              const useTangentRotation = lineRotAlign !== 'viewport'
              const emitLabelAlongSegment = (
                pax: number, pay: number, pbx: number, pby: number,
                t: number, props: Record<string, unknown>,
              ): void => {
                const x = pax + (pbx - pax) * t
                const y = pay + (pby - pay) * t
                const featDef = applyFeatureExprs(props)
                if (useTangentRotation) {
                  let angleDeg = Math.atan2(pby - pay, pbx - pax) * 180 / Math.PI
                  if (angleDeg > 90 || angleDeg < -90) angleDeg += 180
                  // No fontKey override — TextStage.composeFontKey
                  // builds the proper CSS shorthand with weight / italic
                  // / CJK fallback from featDef. See note at line ~2370.
                  stage.addLabel(
                    featDef.text, props,
                    x, y,
                    { ...featDef, rotate: angleDeg },
                  )
                } else {
                  // Viewport-aligned: just place at the line position
                  // with the def's static rotate (typically 0).
                  stage.addLabel(
                    featDef.text, props,
                    x, y, featDef,
                  )
                }
              }
              if (spacingPx > 0) {
                // Polyline path: project all vertices, walk in screen
                // space, drop labels at spacing/2, 3*spacing/2, …. For
                // tangent-rotation labels (the common case) we hand the
                // polyline + offset to TextStage.addCurvedLineLabel
                // which lays each glyph at its own sample point with
                // the local tangent rotation — this is the Mapbox
                // text-along-curve look. Viewport-aligned line labels
                // (text-rotation-alignment: viewport) keep the simple
                // single-rotation `emitLabelAlongSegment` path so the
                // glyphs stay in a horizontal row.
                vtEntry.renderer.forEachLineLabelPolyline(sliceKey, (mxs, mys, props) => {
                  if (mxs.length < 2) return
                  // Project every vertex to physical-pixel screen
                  // space; pack into typed arrays for the curved-text
                  // sampler. Drop unprojectable vertices by trimming
                  // to the first contiguous projectable run.
                  const px: number[] = []
                  const py: number[] = []
                  for (let i = 0; i < mxs.length; i++) {
                    const [lon, lat] = mercToLonLat(mxs[i]!, mys[i]!)
                    const proj = projectLonLat(lon, lat)
                    if (proj) { px.push(proj[0]); py.push(proj[1]) }
                  }
                  if (px.length < 2) return
                  let total = 0
                  for (let i = 0; i < px.length - 1; i++) {
                    const dx = px[i + 1]! - px[i]!
                    const dy = py[i + 1]! - py[i]!
                    total += Math.sqrt(dx * dx + dy * dy)
                  }
                  const featDef = applyFeatureExprs(props)
                  if (useTangentRotation) {
                    // Curved-text path: pack the projected polyline
                    // and ask TextStage to lay each glyph along it.
                    const polyX = new Float32Array(px)
                    const polyY = new Float32Array(py)
                    // No fontKey override — see note at line ~2370.
                    if (total < spacingPx * 0.5) {
                      stage.addCurvedLineLabel(
                        featDef.text, props,
                        polyX, polyY, total * 0.5,
                        featDef,
                      )
                      return
                    }
                    let nextStop = spacingPx * 0.5
                    while (nextStop <= total) {
                      stage.addCurvedLineLabel(
                        featDef.text, props,
                        polyX, polyY, nextStop,
                        featDef,
                      )
                      nextStop += spacingPx
                    }
                    return
                  }
                  // Viewport-aligned path: keep the historical single-
                  // rotation emission per spacing point.
                  if (total < spacingPx * 0.5) {
                    let acc = 0
                    const target = total * 0.5
                    for (let i = 0; i < px.length - 1; i++) {
                      const dx = px[i + 1]! - px[i]!
                      const dy = py[i + 1]! - py[i]!
                      const segLen = Math.sqrt(dx * dx + dy * dy)
                      if (acc + segLen >= target) {
                        const t = segLen > 0 ? (target - acc) / segLen : 0
                        emitLabelAlongSegment(px[i]!, py[i]!, px[i + 1]!, py[i + 1]!, t, props)
                        return
                      }
                      acc += segLen
                    }
                    return
                  }
                  let nextStop = spacingPx * 0.5
                  let acc = 0
                  for (let i = 0; i < px.length - 1; i++) {
                    const dx = px[i + 1]! - px[i]!
                    const dy = py[i + 1]! - py[i]!
                    const segLen = Math.sqrt(dx * dx + dy * dy)
                    while (nextStop <= acc + segLen && nextStop <= total) {
                      const t = segLen > 0 ? (nextStop - acc) / segLen : 0
                      emitLabelAlongSegment(px[i]!, py[i]!, px[i + 1]!, py[i + 1]!, t, props)
                      nextStop += spacingPx
                    }
                    acc += segLen
                  }
                })
              } else {
                // Single-label-per-feature fallback (line-center, or
                // line-placement with spacing=0). Uses the longest
                // segment chosen by forEachLineLabelFeature.
                vtEntry.renderer.forEachLineLabelFeature(sliceKey, (ax, ay, bx, by, props) => {
                  const [aLon, aLat] = mercToLonLat(ax, ay)
                  const [bLon, bLat] = mercToLonLat(bx, by)
                  const pa = projectLonLat(aLon, aLat)
                  const pb = projectLonLat(bLon, bLat)
                  if (!pa || !pb) return
                  emitLabelAlongSegment(pa[0], pa[1], pb[0], pb[1], 0.5, props)
                })
              }
            } else {
              vtEntry.renderer.forEachLabelFeature(sliceKey, (mercX, mercY, props) => {
                const [lon, lat] = mercToLonLat(mercX, mercY)
                const featDef = applyFeatureExprs(props)
                // No fontKey override — see note at line ~2370.
                // World-copy loop — see comment at projectLonLatCopies.
                for (const projected of projectLonLatCopies(lon, lat)) {
                  stage.addLabel(
                    featDef.text, props,
                    projected[0], projected[1], featDef,
                  )
                }
              })
            }
          }
        }

        stage.prepare()
        // Text overlay v1: skipped in debug=overdraw — text pipeline
        // targets the swapchain format, not r16float. Phase 2 adds
        // a text debug pipeline so glyph + halo overdraw counts.
        if (!DEBUG_OVERDRAW) {
          passScope('text-overlay', () => {
            const tPass = encoder.beginRenderPass({
              colorAttachments: [{
                view: colorView,
                resolveTarget: useResolve ? screenView : undefined,
                loadOp: 'load',
                storeOp: 'store',
              }],
            })
            stage.render(tPass, { width: w, height: h })
            tPass.end()
          })
        }
        stage.reset()
      }
    }

    // ── Debug overdraw compose ──
    // Read the r16float accumulator and write a colormapped RGBA to
    // the swapchain. Runs as the LAST pass of the frame so it owns
    // the swapchain attachment.
    if (DEBUG_OVERDRAW && this.overdrawAccumTexture) {
      passScope('overdraw-compose', () => {
        const pipeline = this.renderer.ensureOverdrawCompose()
        const compPass = encoder.beginRenderPass({
          colorAttachments: [{
            view: screenView,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear', storeOp: 'store',
          }],
        })
        const bg = this.ctx.device.createBindGroup({
          layout: this.renderer.overdrawComposeBindGroupLayout,
          entries: [{
            binding: 0,
            resource: this.overdrawAccumTexture!.createView(),
          }],
        })
        compPass.setPipeline(pipeline)
        compPass.setBindGroup(0, bg)
        compPass.draw(3)
        compPass.end()
      })
    }

    // Flush CPU-side uniform-ring mirrors just before submit. WebGPU
    // orders writeBuffer-before-submit for us, so the encoded draws
    // still see fresh uniform data even though the writes happen
    // after encoder.finish(). Covers MapRenderer's `uniform-ring` and
    // LineRenderer's `line-layer-ring`; VTR's `vtr-uniform-ring`
    // already self-flushes at the end of each renderTileKeys.
    this.renderer.endFrame()
    this.lineRenderer?.endFrame()

    // GPU timing: resolve the queryset BEFORE finish so the same command
    // buffer carries the resolve+copy. Mapping happens after submit.
    this.gpuTimer?.resolveOnEncoder(encoder)

    // Outer scope catches the FRAME-level error (one entry per bad frame),
    // matching the inner scope opened right after createCommandEncoder().
    device.queue.submit([encoder.finish()])

    // DIAG: dump per-frame draw order trace if armed. One-shot —
    // clears the flag so subsequent frames stay silent.
    if (typeof window !== 'undefined') {
      const w = window as unknown as {
        __xgisCaptureDrawOrder?: boolean
        __xgisDrawOrderTrace?: Array<{ seq: number; slice: string; phase: string; extrude: string }>
        __xgisDrawOrderResult?: Array<{ seq: number; slice: string; phase: string; extrude: string }>
      }
      if (w.__xgisCaptureDrawOrder && w.__xgisDrawOrderTrace) {
        const trace = w.__xgisDrawOrderTrace
        // eslint-disable-next-line no-console
        console.log('[XGIS-DRAW-ORDER] frame trace (' + trace.length + ' calls):')
        for (const e of trace) {
          // eslint-disable-next-line no-console
          console.log(`  ${String(e.seq).padStart(2, ' ')}  extrude=${e.extrude.padEnd(10)}  phase=${e.phase.padEnd(8)}  slice="${e.slice}"`)
        }
        w.__xgisDrawOrderResult = trace.slice()
        w.__xgisCaptureDrawOrder = false
        w.__xgisDrawOrderTrace = undefined
      }
    }

    // Drain any readbacks that finished mapping last frame, kick mapAsync
    // on freshly-submitted ones. Cheap when disabled (no-op).
    this.gpuTimer?.pollReadbacks()
    device.popErrorScope().then((err) => {
      if (err) console.error('[X-GIS frame-validation]', err.message)
    }).catch(() => { /* scope mismatch — ignore */ })

    // Collect stats from renderers
    this._stats.zoom = this.camera.zoom
    const rs = this.renderer.getDrawStats()
    this._stats.drawCalls = rs.drawCalls
    this._stats.vertices = rs.vertices
    this._stats.triangles = rs.triangles
    this._stats.lines = rs.lines
    let totalTilesVis = 0, totalTilesCached = 0, totalMissed = 0
    for (const [name, { renderer: vtR }] of this.vtSources) {
      if (!vtR.hasData()) continue
      const vts = vtR.getDrawStats()
      this._stats.drawCalls += vts.drawCalls
      this._stats.vertices += vts.vertices
      this._stats.triangles += vts.triangles
      this._stats.lines += vts.lines
      totalTilesVis += vts.tilesVisible
      totalTilesCached += vtR.getCacheSize()
      totalMissed += vts.missedTiles
      // Throttle [FLICKER] per-source to once per ~60 frames. On-demand
      // tile loading legitimately leaves some visible cells uncached for
      // a few frames; the warning is only informative for diagnosing
      // "missing fallback" regressions, not an error users need to see
      // at 60 Hz during normal pan/zoom.
      if (vts.missedTiles > 0) {
        // Grace period — ignore FLICKER for the first N frames after we
        // first observe missedTiles > 0 on this source. Initial-load
        // compile bursts routinely show 1–16 missed tiles for 2–8 frames
        // as on-demand compilation catches up; warning there is noise.
        // Only fire when missedTiles persist past the grace window, which
        // means an actual regression (GPU cache thrash, tile-drop bug).
        let firstSeen = this._flickerFirstFrame.get(name)
        if (firstSeen === undefined) {
          firstSeen = this._frameCount
          this._flickerFirstFrame.set(name, firstSeen)
        }
        const framesSinceFirst = this._frameCount - firstSeen
        if (framesSinceFirst >= XGISMap.FLICKER_GRACE_FRAMES) {
          const last = this._flickerLastFrame.get(name) ?? -Infinity
          if (this._frameCount - last >= 60) {
            this._flickerLastFrame.set(name, this._frameCount)
            const zRounded = Math.round(this.camera.zoom)
            const cacheSize = vtR.getCacheSize()
            console.warn(`[FLICKER] ${name}: ${vts.missedTiles} tiles without fallback (z=${zRounded} gpuCache=${cacheSize})`)
            // Ring-buffer the event so inspectPipeline() can replay
            // the last few seconds without needing a live console capture.
            this._flickerLog.push({
              ts: typeof performance !== 'undefined' ? performance.now() : Date.now(),
              source: name, missed: vts.missedTiles, z: zRounded, cache: cacheSize,
            })
            if (this._flickerLog.length > XGISMap.FLICKER_LOG_CAP) {
              this._flickerLog.splice(0, this._flickerLog.length - XGISMap.FLICKER_LOG_CAP)
            }
          }
        }
      } else {
        // Clean frame clears the first-seen marker so a later burst (e.g.
        // after pan to a new region) gets its own grace window.
        this._flickerFirstFrame.delete(name)
      }
    }
    this._frameCount++
    this._stats.tilesVisible = totalTilesVis
    this._stats.tilesCached = totalTilesCached
    this._stats.endFrame()
    this._statsPanel?.update(this._stats.get())

    // Snapshot state for the idle-skip comparator in `shouldRenderThisFrame`.
    // Animation ticks + external invalidate() re-arm `_needsRender` on their
    // own path, so clearing it unconditionally here is safe.
    this._lastSigZoom = this.camera.zoom
    this._lastSigCX = this.camera.centerX
    this._lastSigCY = this.camera.centerY
    this._lastSigBearing = this.camera.bearing
    this._lastSigPitch = this.camera.pitch
    this._lastSigW = this.ctx.canvas.width
    this._lastSigH = this.ctx.canvas.height
    this._needsRender = false

    // Tile/texture loads still in flight keep the loop warm so the scene
    // converges. Covers three sources:
    //   - VT tiles with unresolved placeholders (missedTiles > 0)
    //   - VT tiles queued behind the per-frame upload budget
    //   - raster tiles mid-fetch
    if (totalMissed > 0 || this.rasterRenderer.hasPendingLoads()) {
      this._needsRender = true
    } else {
      for (const [, { renderer }] of this.vtSources) {
        if (renderer.hasPendingUploads()) { this._needsRender = true; break }
      }
    }

    requestAnimationFrame(this.renderLoop)
  }

  // ═══ DOM-inspired Layer API ═══

  /** Look up a layer by its DSL name. Returns the same `XGISLayer`
   *  instance for repeated calls within one scene, so consumers can
   *  hold the reference across frames. The wrapper is invalidated by
   *  `setProjection()` / scene rebuild — re-resolve in that case.
   *
   *  Mirrors `document.getElementById` ergonomically; the returned
   *  layer exposes `.style` (CSS-like) and `.addEventListener`. */
  getLayer(name: string): XGISLayer | null {
    return this.xgisLayers.get(name) ?? null
  }

  /** Snapshot of all layer wrappers in registration order. Mirrors
   *  `document.querySelectorAll` returning a static list — mutations to
   *  the scene after this call do not appear in the returned array. */
  getLayers(): readonly XGISLayer[] {
    return Array.from(this.xgisLayers.values())
  }

  /** Map-level event delegation. Fires for any layer that gets hit —
   *  the event's `target` is the hit layer. Same `XGISFeatureEvent`
   *  shape as layer-level handlers. Layer-level listeners run first;
   *  if any of them call `preventDefault`, the map-level dispatch is
   *  suppressed for that hit. Mirrors `document.addEventListener`. */
  addEventListener(
    type: XGISFeatureEventType,
    listener: XGISFeatureListener,
    options?: { signal?: AbortSignal; once?: boolean },
  ): void {
    this.mapListeners.add(type, listener, options)
  }

  removeEventListener(type: XGISFeatureEventType, listener: XGISFeatureListener): void {
    this.mapListeners.remove(type, listener)
  }

  /** Internal: dispatcher calls this after a layer-level dispatch so
   *  map-level handlers see every hit. The `event.defaultPrevented`
   *  flag carries through — listeners that want to suppress map-level
   *  delegation just call `preventDefault()` on the layer event. */
  _dispatchMapEvent(event: XGISFeatureEvent): void {
    if (event.defaultPrevented) return
    if (!this.mapListeners.has(event.type)) return
    this.mapListeners.dispatch(event, 'map')
  }

  // ═══ Dynamic Property API (lower-level dot-notation; prefer .style) ═══

  /** Set a layer property at runtime. Changes apply immediately (next frame). */
  set(path: string, value: unknown): void {
    // path format: "layerName.property" e.g. "world.fill", "world.opacity"
    const dot = path.indexOf('.')
    if (dot < 0) return

    const layerName = path.substring(0, dot)
    const prop = path.substring(dot + 1)
    const layer = this.renderer.getLayer(layerName)
    if (layer) {
      layer.props.set(prop, value)
    }
  }

  /** Get a layer property (current value, including overrides) */
  get(path: string): unknown {
    const dot = path.indexOf('.')
    if (dot < 0) return undefined

    const layerName = path.substring(0, dot)
    const prop = path.substring(dot + 1)
    const layer = this.renderer.getLayer(layerName)
    return layer?.props.get(prop)
  }

  /** Reset a property to its compiled default */
  reset(path: string): void {
    const dot = path.indexOf('.')
    if (dot < 0) return

    const layerName = path.substring(0, dot)
    const prop = path.substring(dot + 1)
    const layer = this.renderer.getLayer(layerName)
    layer?.props.reset(prop)
  }

  /** List all settable properties */
  listProperties(): Record<string, string[]> {
    return this.renderer.listProperties()
  }

  // ═══ External data injection API ═══════════════════════════════
  //
  // Host applications that hold their own data (C2 tracks, sensor
  // feeds, geofences) push it in via these methods instead of having
  // X-GIS fetch a URL. The source must be declared in the .xgis file
  // with `source X { type: geojson }` (no url) so run() can seed an
  // empty placeholder that setSourceData then fills.

  /** Destroy GPU resources for every vtSources entry belonging to
   *  `sourceId` (including its filtered variants keyed `id__N`). */
  private teardownSource(sourceId: string): void {
    for (const [key, entry] of this.vtSources) {
      if (key === sourceId || key.startsWith(`${sourceId}__`)) {
        entry.renderer.destroy()
        this.vtSources.delete(key)
      }
    }
  }

  /** Full-replace push for a GeoJSON source.
   *  Retiles and re-uploads only the affected source; other sources
   *  keep their existing GPU state.
   *
   *  Throws if `sourceId` was not declared in the .xgis file. */
  setSourceData(sourceId: string, data: GeoJSONFeatureCollection): void {
    if (!this.rawDatasets.has(sourceId)) {
      throw new Error(`[X-GIS] setSourceData: unknown source "${sourceId}"`)
    }
    this.rawDatasets.set(sourceId, data)
    // Full replace invalidates any cached feature index for this source.
    this._featureIndex.delete(sourceId)
    this.teardownSource(sourceId)
    this.rebuildLayers()
    this.invalidate()
  }

  /** Typed-array fast path for point sources.
   *
   *  The host passes parallel Float32Arrays of longitudes and
   *  latitudes plus an optional `Uint32Array` of stable ids. This
   *  bypasses GeoJSON authoring on the host side — the dominant
   *  cost in high-rate track scenarios — at the price of synthesizing
   *  a minimal FeatureCollection inside X-GIS. A truly zero-alloc
   *  pointRenderer path is deferred to PR 2; the public API is the
   *  fast path so callers don't need to change when that lands.
   *
   *  Current volume sweet spot: a few thousand points at 10 Hz.
   *  Beyond that, the PR 2 optimization becomes necessary.
   *
   *  Throws on length mismatch between lon / lat / ids. */
  setSourcePoints(sourceId: string, data: PointPatch): void {
    this.setSourceData(sourceId, pointPatchToFeatureCollection(data))
  }

  /** Feature-level mutation. Enqueues a patch and coalesces all
   *  pending updates within a single rAF into one retile per source.
   *
   *  `featureId` matches the stable id (GeoJSON feature.id → u32).
   *  Unknown source or feature logs a warn-once and drops the patch
   *  (a host race under reconnect is expected, not fatal). */
  updateFeature(
    sourceId: string,
    featureId: number,
    patch: { geometry?: GeoJSONFeature['geometry']; properties?: Record<string, unknown> },
  ): void {
    if (!this.rawDatasets.has(sourceId)) {
      if (!this._unknownSourceWarned.has(sourceId)) {
        console.warn(`[X-GIS] updateFeature: unknown source "${sourceId}"`)
        this._unknownSourceWarned.add(sourceId)
      }
      return
    }
    let bySource = this._pendingPatches.get(sourceId)
    if (!bySource) {
      bySource = new Map()
      this._pendingPatches.set(sourceId, bySource)
    }
    const existing = bySource.get(featureId)
    bySource.set(featureId, {
      geometry: patch.geometry ?? existing?.geometry,
      properties: { ...(existing?.properties ?? {}), ...(patch.properties ?? {}) },
    })
    this.scheduleFlushPendingUpdates()
    this.invalidate()
  }

  private scheduleFlushPendingUpdates(): void {
    if (this._pendingFlushHandle !== null) return
    const raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
      ? window.requestAnimationFrame.bind(window)
      : (cb: FrameRequestCallback): number => setTimeout(() => cb(performance.now()), 16) as unknown as number
    this._pendingFlushHandle = raf(() => this.flushPendingUpdates())
  }

  private flushPendingUpdates(): void {
    this._pendingFlushHandle = null
    if (this._pendingPatches.size === 0) return

    for (const [sourceId, patches] of this._pendingPatches) {
      const data = this.rawDatasets.get(sourceId)
      if (!data) continue
      // Lookup via featureId index so patching is O(patches) instead of
      // O(features). The index is built once per source and reused across
      // flush cycles until setSourceData replaces the dataset.
      let index = this._featureIndex.get(sourceId)
      if (!index) {
        index = new Map()
        for (const f of data.features) {
          index.set(toU32Id(f.id ?? f.properties?.id), f)
        }
        this._featureIndex.set(sourceId, index)
      }
      for (const [fid, patch] of patches) {
        const f = index.get(fid)
        if (!f) continue
        if (patch.geometry) f.geometry = patch.geometry
        if (patch.properties) {
          f.properties = { ...(f.properties ?? {}), ...patch.properties }
        }
      }
      // Trigger a single retile for this source.
      this.teardownSource(sourceId)
    }
    this._pendingPatches.clear()
    this.rebuildLayers()
  }

  stop(): void {
    this.controller?.detach()
    this.running = false
  }

  /** Add a text overlay anchored at a geographic point. The overlay
   *  re-projects every frame so it tracks the map as the user pans /
   *  zooms / rotates. Returns a handle for removal. */
  addOverlay(opts: TextOverlayOptions): TextOverlayHandle {
    const overlay: TextOverlay = {
      text: opts.text,
      lon: opts.anchor[0],
      lat: opts.anchor[1],
      size: opts.size ?? 14,
      color: opts.color ?? [1, 1, 1, 1],
      halo: opts.halo,
      font: opts.font,
      transform: opts.transform,
    }
    this.overlays.push(overlay)
    this._needsRender = true
    return {
      remove: () => {
        const i = this.overlays.indexOf(overlay)
        if (i !== -1) {
          this.overlays.splice(i, 1)
          this._needsRender = true
        }
      },
    }
  }

  /** Remove every text overlay. */
  clearOverlays(): void {
    if (this.overlays.length === 0) return
    this.overlays.length = 0
    this._needsRender = true
  }
}
