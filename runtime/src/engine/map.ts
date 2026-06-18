// ═══ X-GIS Map — 전체를 연결하는 엔트리포인트 ═══

import { xlog } from './log'
import { setLogSink as setEngineLogSink } from './log'
import { Lexer, Parser, lower, optimize, emitCommands, evaluate, makeEvalProps, deserializeXGB, resolveImportsAsync, resolveUtilities, resolveColor } from '@xgis/compiler'
import { packPalette, uploadPalette, type PaletteTextures } from './gpu/palette-texture'
import type * as AST from '@xgis/compiler'
import { SyntheticEarthSurfaceBackend } from '../data/sources/synthetic-earth-surface-backend'
import { PROJECTION_NAME_TO_TYPE } from './projection/projections-table'
import { worldBandForProjType } from './projection/earth-surface-fill'
import { projectLonLatToScreenCss } from './render-loop-helpers'
import {
  SYNTHETIC_EARTH_SURFACE_SOURCE,
  buildSyntheticEarthSurfaceShow,
  updateSyntheticEarthSurfaceShowFill,
} from './synthetic-earth-surface-show'
import { type CapPoles } from '../data/sources/geojson-polar-cap-backend'
import {
  installGeoJSONPolarCaps,
  detachGeoJSONPolarCaps,
  type PolarCapInstallHost,
} from './geojson-polar-cap-show'
import { invalidateResolvedShowCache } from './render/resolved-show'
import { getSharedGeoJSONCompilePool } from '../data/workers/geojson-compile-pool'
import { initGPU, GPU_PROF, getMaxDpr, effectiveDpr, WebGPUUnavailableError, type GPUContext } from './gpu/gpu'
import { QUALITY, updateQuality, type QualityConfig } from './gpu/quality'
import { GPUTimer } from './gpu/gpu-timer'
import { Camera } from './projection/camera'
import { CameraController } from './camera-controller'
import { ViewportModeController } from './render/viewport-mode-controller'
import { SourceManager } from './source-manager'
import { InteractionController } from './interaction-controller'
import { MapRenderer, type ShowCommand } from './render/renderer'
import { resolveNumberShape } from './render/paint-shape-resolve'
import { RenderLoop } from './render-loop'
import { RenderTargets } from './render/render-targets'
import {
  classifyVectorTileShows as classifyVectorTileShowsImpl,
  groupOpaqueBySource as groupOpaqueBySourceImpl,
  type ClassifiedShow as ExternalClassifiedShow,
  type OpaqueGroup as ExternalOpaqueGroup,
} from './render/bucket-scheduler'
import { interpret, type SceneCommands } from './interpreter'
import { lonLatToMercator, type GeoJSONFeatureCollection } from '../loader/geojson'
import { RasterRenderer } from './render/raster-renderer'
import { PointRenderer } from './render/point-renderer'
import { ShapeRegistry } from './text/sdf-shape'
import { LineRenderer } from './render/line-renderer'
import { PanZoomController, type Controller } from './controller'
import { DirtyTracker, DirtyDomain, DIRTY_ALL } from './state/dirty'
import { VectorTileRenderer } from './render/vector-tile-renderer'
import { TextStage, type TextStageOptions } from './text/text-stage'
import type { GlyphProvider } from './text/sdf/pbf/glyph-provider'
import { IconStage } from './sprite/icon-stage'
import {
  LayerIdRegistry, XGISLayer, ListenerRegistry, MapEventRegistry, XGISMapEvent, isMapEventType,
  type XGISFeature, type XGISFeatureEvent, type XGISFeatureEventType, type XGISFeatureListener,
  type XGISMapEventType, type XGISMapListener,
} from './layer'
import { attachAutoResize } from './auto-resize'
import { EventDispatcher } from './event-dispatcher'
import { TileCatalog } from '../data/tile-catalog'
import { isTileTemplate } from '../data/tile-select'
import { buildShowSourceMaps } from './show-source-maps'
import {
  parseHexColor, hexToRgba,
  applyFilter, applyGeometry,
} from './feature-helpers'
import {
  inspectMapPipeline, captureMapSnapshot, replayMapSnapshot,
  type PipelineInspection, type MapSnapshot, type ReplayResult,
} from './diagnostics'
import type {
  VariantPipelines, TextOverlay,
  TextOverlayOptions, TextOverlayHandle, XGISFontResource,
  XGISMapOptions, FontTypographyMap,
} from './map-types'
// Re-export the public type surface so existing `import { ... } from
// './engine/map'` paths keep resolving after the extraction.
export type {
  TextOverlayOptions, TextOverlayHandle, XGISFontResource,
  XGISMapOptions, FontTypographyMap,
} from './map-types'
import {
  asVectorTileKind, sceneHasAnyAnimation, labelsHaveTimeAnimation,
  buildTypographyMap, registerFonts,
} from './map-geo-helpers'
import { prewarmVectorTileSource, detectVectorTileFormat } from '../loader/vector-tile-loader'
import { StatsTracker, StatsPanel, type RenderStats } from './stats'
import { toU32Id, pointPatchToFeatureCollection, type PointPatch } from './id-resolver'
import type { GeoJSONFeature } from '../loader/geojson'
import { safeFetch, assertIngestBudget, readBodyCapped } from './safety'

// DoS ceilings for the top-level loader entry points (.xgis style /
// import-resolver text and .xgb binary scene). Defensive — far above any
// real style/scene yet bound a size-bomb response before it materialises
// into a string/ArrayBuffer and OOMs the tab.
// A style module is text (typically a few KB → low MB); 32 MB is generous.
const MAX_STYLE_BYTES = 32 * 1024 * 1024
// A .xgb scene is a serialized binary map (geometry-heavy); 256 MB matches
// the GeoJSON-source cap in source-manager — the practical interactive ceiling.
const MAX_XGB_BYTES = 256 * 1024 * 1024

// ClassifiedShow + OpaqueGroup live in bucket-scheduler.ts so they're
// importable by tests. Local aliases keep the rest of map.ts terse.
type ClassifiedShow = ExternalClassifiedShow
type OpaqueGroup = ExternalOpaqueGroup

/** Structured return type of `XGISMap.inspectPipeline()`. Every field
 *  reports LIVE runtime state (not a simulation) so CPU debug sessions
 *  can correlate a specific frame's tile-selection decisions with the
 *  cache / budget pressure that drove them. */

// Lifecycle/camera event routing (isMapEventType) lives in layer.ts next
// to the canonical MAP_EVENT_TYPES set + the registration-time warnings.

export class XGISMap {
  ctx!: GPUContext
  camera: Camera
  private cameraController!: CameraController
  private readonly _viewport: ViewportModeController
  private sourceManager!: SourceManager
  private interactionController!: InteractionController
  renderer!: MapRenderer
  rasterRenderer!: RasterRenderer
  /** Show whose source backs the active raster URL — single-tracked
   *  for now (one raster basemap per scene is the realistic case).
   *  Per-frame `render()` resolves `paintShapes.opacity` here and
   *  pushes it to the renderer. Null when no raster show is active. */
  _rasterShow: typeof this.showCommands[0] | null = null
  /** Optional GPU pass timer. Null when timestamp-query is unsupported or
   *  `?gpuprof=1` is not set. When set, the FIRST opaque sub-pass each
   *  frame is timed; samples drain to `getGpuTimings()`. */
  gpuTimer: GPUTimer | null = null
  pointRenderer!: PointRenderer
  private shapeRegistry: ShapeRegistry | null = null
  lineRenderer: LineRenderer | null = null
  private running = false
  /** Consecutive renderFrame faults (P0-2); reset by a successful frame. */
  private _frameFailures = 0
  /** Set by `destroy()`. Gates invalidate / flush so a torn-down map is
   *  inert and post-destroy calls no-op instead of touching a destroyed
   *  GPU device. */
  private _destroyed = false
  /** Adaptive-DPR interaction state. `_interacting` is read by the render
   *  loop to pass `interacting` into resizeCanvas — when the host has
   *  opted into a lower QUALITY.interactionDpr, frames during an active
   *  gesture render at reduced DPR (cheaper, cooler) and snap back to full
   *  DPR ~`_INTERACTION_IDLE_MS` after the gesture settles. No effect when
   *  interactionDpr is null (the default), so this is inert unless opted in. */
  _interacting = false
  private _pointerActive = false
  private _interactionIdleTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly _INTERACTION_IDLE_MS = 500
  /** The active projection's canonical name. Owned by `_viewport`
   *  (ViewportModeController); exposed here as a field-read getter so the
   *  RenderLoop host view / label-pass (`host.projectionName`) and the
   *  internal reads keep their plain property-access shape. */
  get projectionName(): string { return this._viewport.projectionName }
  private controller: Controller | null = null

  // SDF text overlay stage. Lazy — first `addOverlay` call instantiates.
  textStage: TextStage | null = null
  overlays: TextOverlay[] = []
  /** Resource bundle the TextStage uses to populate its glyph chain
   *  on first construction. Mutated by `setGlyphsUrl`, `addGlyph
   *  Provider`, and the constructor options bag. After the stage is
   *  built, late additions go through `textStage.addGlyphProvider`
   *  directly. */
  glyphsUrl: string | null = null
  inlineGlyphs: NonNullable<TextStageOptions['inlineGlyphs']> | null = null
  glyphProviders: NonNullable<TextStageOptions['glyphProviders']> = []
  /** Sprite atlas URL prefix from the imported style's top-level
   *  `sprite` field. Used by the lazy IconStage to fetch
   *  `${url}.json` + `${url}.png`. Null = no icons rendered. */
  spriteUrl: string | null = null
  /** Icon overlay stage — lazy, constructed on first frame after a
   *  spriteUrl is set. */
  iconStage: IconStage | null = null
  /** iter-183 — one-shot guard so the sprite atlas view is pushed
   *  into MapRenderer + every VTR exactly once after the iconStage
   *  uploads it. Stays true for the session life since the atlas
   *  texture identity doesn't change post-load. */
  _spriteAtlasViewPushed = false

  // Vector tile sources + renderers (per .xgvt source)
  vtSources = new Map<string, { source: TileCatalog; renderer: VectorTileRenderer }>()
  private vectorTileShows: { sourceName: string; show: SceneCommands['shows'][0]; pipelines: VariantPipelines | null; layout: GPUBindGroupLayout | null }[] = []
  private vtVariantPipelines: VariantPipelines | null = null

  // Raw data for re-projection
  rawDatasets = new Map<string, GeoJSONFeatureCollection>()
  /** Declared input CRS per source id, built at run() time from
   *  `commands.loads[].crs` (the LoadCommand carrier threaded from IR
   *  `SourceDef.crs`). The IR `Scene` is not retained past emitCommands,
   *  so this is the runtime's only carrier for the host-push path:
   *  `setSourceData(sourceId, fc)` looks the declared CRS up here to
   *  reproject pushed data from EPSG → WGS84. Sources without a declared
   *  CRS are absent (treated as EPSG:4326 / no-op). */
  private sourceCRS = new Map<string, string>()
  /** Mercator clamp-boundary pole(s) each GeoJSON source touches, recorded
   *  by SourceManager at attach time (issue #360 F1). Read by the polar-cap
   *  install — both initially and on a projection change — so the cap
   *  backend can be (re-)synthesised without re-walking the feature data. */
  private geojsonCapPoles = new Map<string, CapPoles>()
  showCommands: SceneCommands['shows'] = []

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

  /** Map-level lifecycle / camera event registry — `map.on('moveend', h)`
   *  / `map.on('load', h)` / `map.on('idle', h)`. Separate from
   *  `mapListeners` (feature/pointer events) because the two carry
   *  different payloads; `on()`/`off()`/`once()` route to the right one
   *  by event name. Emit sites: load = first rendered frame (run());
   *  move/zoom/movestart/zoomstart/moveend/zoomend/idle = render-loop
   *  signature diff (catches both gesture + programmatic camera lanes). */
  private mapEventListeners = new MapEventRegistry()

  /** One-shot guard so `load` fires exactly once even if run()/runBinary
   *  is somehow re-entered. */
  private _loadFired = false
  /** Move/zoom transition state for the render-loop signature diff. A
   *  "move" spans from the first camera-signature change until the camera
   *  comes to rest; a "zoom" likewise but tracks zoom alone. `_wasIdle`
   *  edge-detects the busy→idle transition for the single `idle` fire. */
  private _moveActive = false
  private _zoomActive = false
  private _wasIdle = false

  /** Bound `keydown` handler for keyboard pan/zoom (P0-7 a11y). Stored so
   *  `destroy()` can detach it — otherwise the listener (and the closed-
   *  over map) leaks when an SPA unmounts. `null` until `_setupAccessibility`
   *  attaches it (skipped when the canvas is not a real DOM element, e.g.
   *  the unit-test mock). */
  private _keyDownHandler: ((e: KeyboardEvent) => void) | null = null
  /** Detach hook for the auto resize/DPR observers (P0-3); destroy() mirror. */
  private _detachAutoResize: (() => void) | null = null

  // `_cameraExplicitlyPositioned` is owned by CameraController and
  // exposed on XGISMap via a get/set accessor (see below near
  // `_cameraPositionedFlag`). Set whenever the user (or hash sync)
  // explicitly positions the camera so the post-compile bounds-fit
  // knows not to clobber it; reset to `false` at the start of each
  // `run()`. Toggled from markCameraPositioned() + pan/zoom/rotate
  // gestures + setProjection().

  // External-injection update state (see setSourceData / updateFeature)
  private _pendingPatches = new Map<string, Map<number, { geometry?: GeoJSONFeature['geometry']; properties?: Record<string, unknown> }>>()
  private _pendingFlushHandle: number | null = null
  private _unknownSourceWarned = new Set<string>()
  // Tile-backed (URL-loaded) sources store a marker, not a FeatureCollection,
  // so updateFeature can't patch them. Warn once per source (see updateFeature).
  private _tileBackedUpdateWarned = new Set<string>()
  // Lazy featureId → feature index per source, so flushPendingUpdates can
  // patch in O(patches) instead of O(features). Invalidated on setSourceData
  // (full replace) and rebuilt on demand.
  private _featureIndex = new Map<string, Map<number, GeoJSONFeature>>()

  // GPU render-target texture lifecycle (stencil / msaa / OIT accum +
  // revealage / offscreen-extrude depth / overdraw accumulator / pick),
  // including their recreate-on-resize gate. Extracted into RenderTargets
  // (render/render-targets.ts) — RenderLoop reads its textures via
  // FrameContext.rt; the pick path reads `pickTexture` (getter below).
  // Constructed lazily-by-ctx-accessor so it survives ctx reassignment in
  // run(). Instantiated alongside renderLoopInstance in the constructor.
  renderTargets: RenderTargets = new RenderTargets(() => this.ctx)

  // Pick (GPU hover/click) — secondary color attachment that every main-pass
  // pipeline writes `vec2<u32>(feature_id, instance_id)` into. 1-tex design
  // with RG32Uint keeps per-pass overhead to a single extra color-attachment
  // descriptor and 8 bytes/pixel of VRAM. Always allocated (not opt-in) so
  // pipelines have a stable target format; `map.pickAt()` reads back a 1×1
  // at the pointer location via async mapAsync. Kept at single-sample
  // regardless of SAMPLE_COUNT — picking wants deterministic, non-resolved IDs.
  // Now owned by RenderTargets; delegated here for the pick-path accessor.
  get pickTexture(): GPUTexture | null { return this.renderTargets.pickTexture }

  // Stats inspector
  _stats = new StatsTracker()
  _statsPanel: StatsPanel | null = null
  /** Last frame (per source) we logged a FLICKER warning. Throttles the
   *  warning to at most once every 60 frames (~1s at 60fps) so normal
   *  on-demand loading doesn't flood the overlay. */
  _flickerLastFrame = new Map<string, number>()
  /** First frame (per source) at which missedTiles became non-zero. We
   *  expect a burst during the initial 30-ish frames after a source is
   *  added — worker compile lands, then the viewport's leaf tiles
   *  compile on demand at 2/frame. Warning during that window is noise;
   *  a real FLICKER (GPU cache eviction churn, tile-drop regression)
   *  sustains past that horizon. */
  _flickerFirstFrame = new Map<string, number>()
  /** iter-237 (Plan A.2) — Scratch Sets for per-show label-name dedup.
   *  Pre-iter-237 each show allocated fresh `new Set<string>()` for
   *  text-along-line emit dedup + for point-label emit dedup. At
   *  80 shows × 60 fps that's 9600 Set + internal-table allocations
   *  per second per axis. Hoisted + `.clear()` before each show; V8
   *  retains the internal hash buckets across clears so amortized
   *  zero alloc.
   *
   *  Lifetime: scoped to a single show's emit pass. renderFrame is
   *  synchronous + non-reentrant, so sharing across shows is safe
   *  as long as each show clears before use. The closures that
   *  capture the Set still read the live shared ref correctly. */
  readonly _scratchEmittedTextNames = new Set<string>()
  readonly _scratchEmittedPointNames = new Set<string>()
  /** iter-259 (Plan AAA B.7) — applyFeatureExprs cache. Keyed on
   *  props ref via WeakMap so per-feature LabelDef survives across
   *  frames + auto-GCs when source data drops the feature. Per
   *  PMTiles MVT path each tile's featureProps Map returns the
   *  same object ref per featId across frames, so the same feature
   *  hits the same cache entry.
   *
   *  Cache value is invalidated when:
   *   - zoomBucket changes (camera zoom passes a 0.25-zoom threshold)
   *   - effectiveDef ref changes (style hot-update / show rebuild)
   *
   *  No explicit invalidation needed for tile reload: the new
   *  worker decode produces a new props object ref → cache miss
   *  on first access → entry recomputed. Old entries GC via
   *  WeakMap automatic cleanup. */
  readonly _featureExprsCache = new WeakMap<Record<string, unknown>, { zoomBucket: number; effectiveDef: AST.LabelDef; def: AST.LabelDef }>()
  /** iter-261 (Plan L.1.1) — label-dispatch signature for cache
   *  hit-rate diagnostic. Computed at the start of the labelShows
   *  loop; compared to prior frame. Tracks hit/miss without
   *  changing behavior. If hit rate is < 50 % we cancel L.1
   *  before investing in the full snapshot/replay refactor. */
  _prevLabelDispatchSig: string | null = null
  _labelDispatchHits = 0
  _labelDispatchMisses = 0
  /** iter-261 — read this via __xgisMap.getLabelDispatchStats() to
   *  see Phase L.1 cache hit-rate without actually building the
   *  cache. */
  getLabelDispatchStats(): { hits: number; misses: number; hitRate: number } {
    const total = this._labelDispatchHits + this._labelDispatchMisses
    return {
      hits: this._labelDispatchHits,
      misses: this._labelDispatchMisses,
      hitRate: total > 0 ? this._labelDispatchHits / total : 0,
    }
  }
  /** iter-266 — TextStage's per-label content-keyed layout cache
   *  (textKeyFor + sizePx + maxWidthPx + …). Decouples camera from
   *  the key, so unlike the outer dispatch-sig cache (which keys
   *  camera-exact and got 4.9 %) this one should hit through pan +
   *  small zoom changes. Harness reads it via
   *  __xgisMap.getLayoutCacheStats() to size the Phase L.1 retry. */
  getLayoutCacheStats(): { hits: number; misses: number; hitRate: number; entries: number } | null {
    return this.textStage?.getLayoutCacheStats() ?? null
  }
  _frameCount = 0
  /** Ring buffer of recent FLICKER dispatches across ALL sources,
   *  keyed by wall-clock time so `inspectPipeline()` can show what
   *  happened in the last few seconds. Capped at 32 entries — the
   *  60-frame throttle keeps the write rate low, so 32 covers ~30s
   *  of the worst sustained case. */
  _flickerLog: { ts: number; source: string; missed: number; z: number; cache: number }[] = []
  /** Wall-clock animation origin captured on the first rendered frame.
   *  `performance.now() - _startTime` yields the elapsed milliseconds
   *  fed into every time-interpolated value (opacity today, more
   *  properties in future PRs). Null until first renderFrame. */
  _startTime: number | null = null
  _elapsedMs = 0
  /** Earth-surface fill color resolved from `background { fill: ... }`.
   *  Pushed into the synthetic earth-surface show + backend after GPU
   *  init. ALSO read by the background pass (render/passes/background-pass.ts)
   *  to fill the OUTSIDE-band region for flat/cylindrical projections —
   *  the coverage seam from VISION §5 gap #1. null = no background block
   *  declared → the pass falls back to the defined black clear. Non-private
   *  (underscore convention) so the render host can read it, like
   *  `_rasterShow`. */
  _backgroundColor: [number, number, number, number] | null = null
  /** P3 Step 3c — scene-scoped palette GPU textures. Held for
   *  destruction on the next scene reload; the underlying view is
   *  bound to every VTR + MapRenderer via setPaletteColorAtlas. */
  private _paletteHandles: PaletteTextures | null = null
  /** Phase 2 PR 2c.3 — synthetic backend serving the z=0 ECEF earth-
   *  surface mesh that replaces BackgroundRenderer. Constructed in run()
   *  + runBinary() after the catalog/renderer pair exists, attached to
   *  the synthetic source's TileCatalog. Null until run() initialises
   *  GPU + catalogs. */
  private _syntheticBackend: SyntheticEarthSurfaceBackend | null = null

  // ── Idle-render skip ──
  // Before this, `renderLoop` called `renderFrame()` every rAF (~60Hz) even
  // when nothing changed. On mobile the SDF line shader + mobile GPU is
  // heavy enough that a static minimal.xgis map pegged the tile units for
  // zero visual benefit ("엄청난 랙"). Now we compare camera state + canvas
  // size each tick and skip the frame when the signature matches, the
  // scene has no time-based animation, and no external invalidate is
  // pending. Any camera input, data push, or active animation resumes
  // per-frame rendering naturally.
  _needsRender = true
  private _dirty = new DirtyTracker()
  private _sceneHasAnimation = false
  /** True when a label carries a time-driven shape (text-size/-color/-halo/
   *  -opacity/icon-* against the clock). Read by the label pass: the S16
   *  prepare-skip signature omits the animation clock, so a time-animated
   *  label must keep re-collating even when the camera is static. */
  _labelsHaveTimeAnimation = false
  _lastSigZoom = NaN
  _lastSigCX = NaN
  _lastSigCY = NaN
  _lastSigBearing = NaN
  _lastSigPitch = NaN
  _lastSigW = 0
  _lastSigH = 0

  /** The per-frame GPU render method, extracted verbatim into RenderLoop
   *  (render-loop.ts). `renderFrame()` below delegates to
   *  `renderLoopInstance.render()`. Instantiated in the constructor —
   *  RenderLoop holds this map by reference and reads renderer / ctx /
   *  stages fresh at render time (they're populated lazily in run()). */
  private renderLoopInstance!: RenderLoop

  /** Explicit render trigger for code paths that change state outside the
   *  camera (setSourceData, updateFeature, tile load completion, etc.). */
  invalidate(): void { if (this._destroyed) return; this._needsRender = true; this._dirty.tag(DirtyDomain.CAMERA | DirtyDomain.VIEWPORT | DirtyDomain.PROJECTION | DirtyDomain.STYLE | DirtyDomain.SOURCE | DirtyDomain.GEOMETRY | DirtyDomain.LABEL | DirtyDomain.CLOCK) }

  /** Internal render trigger for the non-camera state changes that used to set
   *  `_needsRender = true` raw (scene rebuild, overlay add/remove). Sets the
   *  render flag AND tags the matching dirty domain(s) in one place so the two
   *  cannot drift — the granular counterpart to invalidate()'s blanket
   *  DIRTY_ALL. Still INERT: `shouldRenderThisFrame()` reads `_needsRender`, not
   *  `_dirty`, so output is byte-identical until a consumer reads the bitset
   *  (S16). No `_destroyed` guard — every caller is an internal load/overlay
   *  path that already runs only on a live map. */
  private _markDirty(domains: number): void { this._needsRender = true; this._dirty.tag(domains) }

  /** Eval-side consumer for the label pass (S16 — the FIRST consumer skip).
   *  Reads-and-CLEARS the LABEL domain: returns whether labels were re-tagged
   *  since the last call, then resets the bit so the next frame starts clean
   *  unless an edit (overlay add/remove, scene rebuild, or any invalidate())
   *  re-tags it. The label pass combines this with its camera/canvas/tile-set
   *  signature to skip re-dispatch + re-collision on an unchanged frame. */
  consumeLabelDirty(): boolean { return this._dirty.consume(DirtyDomain.LABEL) }

  /** Producer side of the LABEL dirty domain — re-arm a frame AND tag
   *  LABEL so the next frame's S16 skip is forced to re-prepare. Used by
   *  the TextStage when an async glyph resource (PBF range) lands after the
   *  requesting frame already drew (Audit ① B1): without this, the skip
   *  keeps replaying the stale zero-SDF glyph until the camera moves.
   *  Package-internal (no modifier) so RenderLoopHost can see it. */
  markLabelDirty(): void { this._markDirty(DirtyDomain.LABEL) }

  /** Flag an active user gesture (pan / zoom) so the render loop can drop
   *  to QUALITY.interactionDpr while interacting and restore full DPR once
   *  the gesture settles. Debounced: each call pushes the idle-restore out
   *  by `_INTERACTION_IDLE_MS`. No-op after destroy(). Inert unless the
   *  host opted into a reduced interactionDpr. */
  markInteracting(): void {
    if (this._destroyed) return
    // Inert unless the host opted into a reduced interaction DPR — skip the
    // debounce churn entirely in the default (interactionDpr === null) config.
    if (QUALITY.interactionDpr === null) return
    this._interacting = true
    if (this._interactionIdleTimer !== null) clearTimeout(this._interactionIdleTimer)
    this._interactionIdleTimer = setTimeout(() => {
      this._interacting = false
      this._interactionIdleTimer = null
      this.invalidate() // one crisp full-DPR frame after the gesture settles
    }, XGISMap._INTERACTION_IDLE_MS)
  }

  /** Update the style-background fill colour at runtime. Pushes the new
   *  RGBA into the synthetic earth-surface backend so future-decoded
   *  ancestor falls + into the synthetic show so the polygon ECEF
   *  pipeline picks the colour up on the next frame. Caller writes
   *  `[r, g, b, a]` in 0..1 floats. Pass `null` to drop the synthetic
   *  source's contribution (canvas clearValue then dominates) — this
   *  tears down the synthetic VTR + backend, filters the synthetic
   *  ShowCommand out of `showCommands`, and clears `_syntheticBackend`.
   *  Idempotent: calling with `null` repeatedly is a no-op after the
   *  first teardown. */
  setBackgroundFill(rgba: [number, number, number, number] | null): void {
    if (rgba === null) {
      // Teardown the synthetic source if it was installed. Without this
      // the backend keeps emitting tiles + the synthetic show keeps
      // rendering even though the public API "dropped" the bg fill.
      if (this._syntheticBackend) {
        this.teardownSource(SYNTHETIC_EARTH_SURFACE_SOURCE)
        this.rawDatasets.delete(SYNTHETIC_EARTH_SURFACE_SOURCE)
        this._syntheticBackend = null
      }
      // Filter the synthetic ShowCommand out of the live frame's command
      // list — rebuildLayers prepends it on each style reload, but a
      // mid-session null-teardown must drop it now so the next frame
      // does not dispatch a draw against a torn-down catalog.
      const synthIdx = this.showCommands.findIndex(
        s => s.targetName === SYNTHETIC_EARTH_SURFACE_SOURCE,
      )
      if (synthIdx >= 0) {
        invalidateResolvedShowCache(this.showCommands[synthIdx]!)
        this.showCommands.splice(synthIdx, 1)
      }
      this._backgroundColor = null
      this._dirty.tag(DirtyDomain.STYLE)
      this.invalidate()
      return
    }
    if (!Array.isArray(rgba) || rgba.length !== 4
        || !Number.isFinite(rgba[0]) || !Number.isFinite(rgba[1])
        || !Number.isFinite(rgba[2]) || !Number.isFinite(rgba[3])) {
      xlog.warn(`[X-GIS] setBackgroundFill: rejected non-finite RGBA ${JSON.stringify(rgba)}`)
      return
    }
    this._backgroundColor = rgba
    // Re-install path: setBackgroundFill(null) earlier in this session
    // tore down the synthetic source; the user is now opting back in.
    // Run the install + prepend the synthetic ShowCommand at sort-order
    // 0 so the next frame dispatches against a live catalog. Requires
    // the renderer to be initialised — pre-run() callers just set
    // `_backgroundColor` and the deferred install fires inside run() /
    // runBinary() the same as the original install path.
    if (!this._syntheticBackend && this.renderer) {
      this._installSyntheticEarthSurfaceSource(rgba)
      const syntheticShow = buildSyntheticEarthSurfaceShow(rgba)
      this.showCommands = [syntheticShow, ...this.showCommands]
    } else {
      this._syntheticBackend?.updateFillColor(rgba)
      const synthShow = this.showCommands.find(
        s => s.targetName === SYNTHETIC_EARTH_SURFACE_SOURCE,
      )
      if (synthShow) {
        updateSyntheticEarthSurfaceShowFill(synthShow, rgba)
        invalidateResolvedShowCache(synthShow)
      }
    }
    this._dirty.tag(DirtyDomain.STYLE)
    this.invalidate()
  }

  /** Phase 2 PR 2c.3 — wire the synthetic earth-surface source into the
   *  vector-tile dispatch path. Creates a dedicated TileCatalog +
   *  VectorTileRenderer pair, attaches the synthetic backend, and seeds
   *  `rawDatasets` with the `_vectorTile: true` marker rebuildLayers
   *  checks. Idempotent. */
  private _installSyntheticEarthSurfaceSource(
    rgba: [number, number, number, number],
  ): void {
    if (this._syntheticBackend) {
      this._syntheticBackend.updateFillColor(rgba)
      return
    }
    const catalog = new TileCatalog()
    const vtRenderer = new VectorTileRenderer(this.ctx)
    vtRenderer.setBindGroupLayout(this.renderer.bindGroupLayout)
    vtRenderer.setPaletteResources(this.renderer.paletteColorAtlasView, this.renderer.paletteSampler)
    vtRenderer.setSpriteAtlasView(this.renderer.spriteAtlasView)
    vtRenderer.setExtrudedPipelines(this.renderer.fillPipelineExtruded, this.renderer.fillPipelineExtrudedFallback)
    vtRenderer.setGroundPipelines(this.renderer.fillPipelineGround, this.renderer.fillPipelineGroundFallback)
    vtRenderer.setPatternPipelines(this.renderer.fillPipelinePatternGround, this.renderer.fillPipelinePatternGroundFallback)
    vtRenderer.setPatternExtrudedPipelines(this.renderer.fillPipelinePatternExtruded, this.renderer.fillPipelinePatternExtrudedFallback)
    vtRenderer.setOITPipeline(this.renderer.fillPipelineExtrudedOIT)
    if (this.lineRenderer) vtRenderer.setLineRenderer(this.lineRenderer)
    vtRenderer.setSource(catalog)
    const projType = PROJECTION_NAME_TO_TYPE[this.projectionName] ?? 0
    const backend = new SyntheticEarthSurfaceBackend(projType)
    backend.updateFillColor(rgba)
    catalog.attachBackend(backend)
    this._syntheticBackend = backend
    this.vtSources.set(SYNTHETIC_EARTH_SURFACE_SOURCE, { source: catalog, renderer: vtRenderer })
    this.rawDatasets.set(
      SYNTHETIC_EARTH_SURFACE_SOURCE,
      { _vectorTile: true } as unknown as GeoJSONFeatureCollection,
    )
  }

  /** Issue #360 F1 — XGISMap-side host adapter for the per-source polar-cap
   *  install (logic lives in geojson-polar-cap-show.ts so map.ts stays thin).
   *  The vtSources/rawDatasets/geojsonCapPoles Maps are shared by reference;
   *  showCommands is read/replaced through the accessor pair. */
  private _polarCapHost(): PolarCapInstallHost {
    return {
      ctx: this.ctx,
      renderer: this.renderer,
      lineRenderer: this.lineRenderer,
      projectionName: this.projectionName,
      vtSources: this.vtSources,
      rawDatasets: this.rawDatasets,
      geojsonCapPoles: this.geojsonCapPoles,
      getShowCommands: () => this.showCommands as ShowCommand[],
      setShowCommands: (shows) => { this.showCommands = shows as SceneCommands['shows'] },
      teardownSource: (id) => this.teardownSource(id),
    }
  }

  constructor(private canvas: HTMLCanvasElement, options: XGISMapOptions = {}) {
    this.camera = new Camera(0, 20, 2)
    this.cameraController = new CameraController(this.camera, {
      invalidate: () => this.invalidate(),
      getCanvas: () => this.getCanvas(),
      getCtxCanvas: () => this.ctx?.canvas,
    })
    // Projection-mode + graticule cluster. Holds the shared camera (writes
    // zoom/pitch/globeOrtho/globeMode/pitchLocked on a projection switch) and
    // reaches the renderer fresh for graticule. The world-band-change bg
    // rebuild stays on map.ts (STYLE-fused, plan §5 false-boundary #1) — the
    // controller signals it via this callback at the exact in-body position
    // the inline block occupied, preserving the band-change → camera-writes
    // → tag/invalidate order.
    this._viewport = new ViewportModeController(this.camera, {
      getRenderer: () => this.renderer,
      onWorldBandChange: (prevProj, canonical) => {
        const prevBand = worldBandForProjType(PROJECTION_NAME_TO_TYPE[prevProj] ?? 0)
        const nextBand = worldBandForProjType(PROJECTION_NAME_TO_TYPE[canonical] ?? 0)
        if (prevBand === nextBand) return
        // Synthetic background — its mesh latitude band is fixed per instance,
        // so a band change must re-install the backend with the new band.
        if (this._syntheticBackend && this._backgroundColor) {
          const rgba = this._backgroundColor
          this.setBackgroundFill(null)
          this.setBackgroundFill(rgba)
        }
        // Per-source polar caps (issue #360 F1): mercator-class has no pole
        // hole → detach; sphere-class → (re-)install. rebuildLayers() then
        // re-runs so the new cap show enters `vectorTileShows` (the dispatch
        // list is built from showCommands at rebuild time — without it the cap
        // tile is cached but never selected/drawn).
        const hadCaps = this.geojsonCapPoles.size > 0
        if (nextBand === 'mercator-clamped') detachGeoJSONPolarCaps(this._polarCapHost())
        else installGeoJSONPolarCaps(this._polarCapHost())
        if (hadCaps && this.renderer) this.rebuildLayers()
      },
    })
    // Source-ingest cluster — receives the SAME source-state Map
    // instances by reference so every internal read in renderFrame /
    // rebuildLayers / hasPendingSourceWork / diagnostics stays untouched.
    // ctx / renderer / lineRenderer are read fresh (populated in run())
    // via accessors; camera / canvas are stable ctor-time instances.
    this.sourceManager = new SourceManager({
      rawDatasets: this.rawDatasets,
      vtSources: this.vtSources,
      sourceCRS: this.sourceCRS,
      geojsonCapPoles: this.geojsonCapPoles,
      camera: this.camera,
      canvas: this.canvas,
      getCtx: () => this.ctx,
      getRenderer: () => this.renderer,
      getLineRenderer: () => this.lineRenderer,
      invalidate: () => this.invalidate(),
      fitZoomToLonSpan: (lonSpan, cssWidthPx) => this._fitZoomToLonSpan(lonSpan, cssWidthPx),
      runBoundsFitGate: (apply) => this._runBoundsFitGate(apply),
      rebuildLayers: () => this.rebuildLayers(),
      teardownSource: (sourceId) => this.teardownSource(sourceId),
      deleteFeatureIndex: (sourceId) => { this._featureIndex.delete(sourceId) },
    })
    // Pick / interaction QUERY cluster — receives the shared camera +
    // layer/source state by reference; ctx / pickTexture / projectionName /
    // vectorTileShows are read fresh via accessors (lazily populated,
    // mutated, or reassigned at runtime). pickReadbackPool is owned inside.
    this.interactionController = new InteractionController({
      camera: this.camera,
      layerIds: this.layerIds,
      xgisLayers: this.xgisLayers,
      rawDatasets: this.rawDatasets,
      featureIndex: this._featureIndex,
      getCtx: () => this.ctx,
      getPickTexture: () => this.pickTexture,
      getProjectionName: () => this.projectionName,
      getVectorTileShows: () => this.vectorTileShows,
    })
    // Apply resource options BEFORE the first render frame so the
    // lazy TextStage construction sees the full bundle. Setters
    // remain available for late binding (e.g. style importer adds
    // glyphs URL after constructor runs).
    if (options.glyphs?.url) this.glyphsUrl = options.glyphs.url
    if (options.glyphs?.inline) this.inlineGlyphs = options.glyphs.inline
    if (options.glyphProviders) this.glyphProviders.push(...options.glyphProviders)
    if (options.spriteUrl) this.spriteUrl = options.spriteUrl
    // Font registration is fire-and-forget — the FontFace promise
    // resolves on the browser's font thread. Callers who need
    // guaranteed-loaded fonts should await `map.fontsReady` before
    // their first label submission.
    if (options.fonts) {
      this.fontsReady = registerFonts(options.fonts)
      this.fontTypography = buildTypographyMap(options.fonts)
    } else {
      this.fontsReady = Promise.resolve()
    }
    // When the WOFF FontFace(s) land, re-raster glyphs that Canvas2D drew with
    // the system fallback before they loaded + re-arm the loop — else a label
    // submitted before fontsReady keeps the fallback letterforms forever (the
    // resource-land twin of the glyph/provider re-raster fixes).
    if (options.fonts) void this.fontsReady.then(() => {
      if (this._destroyed) return
      this.textStage?.invalidateAllGlyphs()
      this.markLabelDirty()
    })
    // P4 opt-in for compute-driven paint evaluation. Stored as a
    // simple flag the run() method reads when invoking emitCommands.
    if (options.enableComputePath) this._enableComputePath = true
    // Graticule default off (was implicitly on). Applied AFTER renderer
    // construction via setGraticuleEnabled — held on the viewport controller
    // until renderer exists (initGPU resolves in run()).
    this._viewport.graticuleInitial = options.graticule === true
    // RenderLoop owns the per-frame GPU render method (extracted from
    // map.ts). It holds this map by reference and reaches its members
    // through a typed host view — renderer / ctx / stages are read fresh
    // at render time, so constructing it before run() populates them is
    // safe.
    this.renderLoopInstance = new RenderLoop(this)
    // P0-7 a11y baseline: make the host-supplied canvas focusable +
    // keyboard-drivable. Runs at ctor time (canvas is available pre-GPU);
    // no-ops when the canvas is not a real DOM element (unit-test mock).
    this._setupAccessibility(options.ariaLabel)
    // P0-3: container-resize + monitor-swap DPR tracking while idle; both
    // funnel into the existing public resize() path. No-op in test envs.
    this._detachAutoResize = attachAutoResize(this.canvas, () => this.resize())
  }

  /** P0-7 accessibility baseline. The renderer is canvas-only with no
   *  internal DOM, so the host's <canvas> is the keyboard / screen-reader
   *  surface. This makes it focusable (`tabindex=0`), names it for
   *  assistive tech (`role="region"` + `aria-label`), draws a visible
   *  `:focus-visible` ring (WCAG 2.4.7), and routes arrow / +/- keys to
   *  the SAME camera methods drag + wheel use (`panBy` / `zoomIn` /
   *  `zoomOut` on the shared `cameraController`) so keyboard moves reuse
   *  the move-event bus, respect `maxBounds`, and clamp zoom identically.
   *
   *  Skipped when `this.canvas` is not a real DOM element (the unit-test
   *  mock is a bare `{ width, height }` object) — mirrors the
   *  `typeof document === 'undefined'` guard in
   *  `_showWebGPUUnavailableDefault`. */
  private _setupAccessibility(ariaLabel?: string): void {
    const canvas = this.canvas
    if (typeof document === 'undefined') return
    if (!canvas || typeof canvas.setAttribute !== 'function' || typeof canvas.addEventListener !== 'function') return
    // Focusable + named for assistive tech. Only set tabIndex if the host
    // hasn't already made it focusable, so an embedder's explicit choice
    // (e.g. tabindex=-1 to drive focus programmatically) is preserved.
    if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0
    if (!canvas.hasAttribute('role')) canvas.setAttribute('role', 'region')
    if (!canvas.hasAttribute('aria-label')) canvas.setAttribute('aria-label', ariaLabel ?? 'Map')
    // Marker the shared focus-ring stylesheet targets (independent of the
    // role/aria-label values, which a host may override).
    canvas.setAttribute('data-xgis-map', '')
    XGISMap._injectFocusStyle()
    const handler = (e: KeyboardEvent) => this._onKeyDown(e)
    this._keyDownHandler = handler
    canvas.addEventListener('keydown', handler)
  }

  /** Inject a single shared stylesheet that draws a focus ring on any
   *  X-GIS canvas — only when keyboard-driven (`:focus-visible`), so a
   *  pointer click doesn't show the ring. Module-once via a guard flag;
   *  targets the `data-xgis-map` marker `_setupAccessibility` sets, which
   *  is stable even if the host overrides role / aria-label. */
  private static _focusStyleInjected = false
  private static _injectFocusStyle(): void {
    if (XGISMap._focusStyleInjected) return
    if (typeof document === 'undefined' || !document.head) return
    XGISMap._focusStyleInjected = true
    const style = document.createElement('style')
    style.setAttribute('data-xgis-a11y', '')
    style.textContent =
      'canvas[data-xgis-map]:focus-visible{' +
      'outline:3px solid #4d90fe;outline-offset:2px;}'
    document.head.appendChild(style)
  }

  /** Keyboard pan/zoom (P0-7). Arrow keys pan, `+`/`=` zoom in, `-`/`_`
   *  zoom out, Shift accelerates the pan. Routes through the shared
   *  `cameraController` (same path as drag/wheel) so the render-loop
   *  camera-diff fires `move`/`moveend`/`zoom*` for free. `preventDefault`
   *  is called ONLY for keys we act on, and we bail when an unhandled
   *  modifier (Ctrl/Alt/Meta) is held so we don't steal browser shortcuts. */
  private _onKeyDown(e: KeyboardEvent): void {
    if (this._destroyed) return
    // Leave browser / OS chords (Ctrl+, Alt+, Cmd+) alone. Shift is the
    // only modifier we consume (fast pan).
    if (e.ctrlKey || e.altKey || e.metaKey) return
    // prefers-reduced-motion: keyboard pan/zoom are already instant jumps
    // (no transition infra), so there is nothing to suppress; honored here
    // as a forward-looking guard for when easeTo/flyTo gain animation.
    const PAN_PX = 80
    const FAST_PX = 320
    const step = e.shiftKey ? FAST_PX : PAN_PX
    switch (e.key) {
      case 'ArrowUp':    this.cameraController.panBy([0, -step]); break
      case 'ArrowDown':  this.cameraController.panBy([0,  step]); break
      case 'ArrowLeft':  this.cameraController.panBy([-step, 0]); break
      case 'ArrowRight': this.cameraController.panBy([ step, 0]); break
      case '+': case '=': this.cameraController.zoomIn(); break
      case '-': case '_': this.cameraController.zoomOut(); break
      default: return // not a key we handle — leave default behaviour intact
    }
    e.preventDefault()
    // Mirror the pointer-gesture bookkeeping (onPointerDown): the user has
    // taken control of the camera, so the post-compile bounds auto-fit must
    // not clobber it, and the interaction-DPR path can kick in.
    this._cameraExplicitlyPositioned = true
    this.markInteracting()
  }

  /** Toggle the lat/lon grid overlay. Default off. Forwards to the viewport
   *  controller (renderer delegate + held-state); tag + invalidate stay here
   *  to preserve the original tail order. */
  setGraticuleEnabled(on: boolean): void {
    this._viewport.setGraticuleEnabled(on)
    this._dirty.tag(DirtyDomain.STYLE)
    this.invalidate()
  }

  /** Mapbox-API parity: programmatic camera control. Delegated to
   *  CameraController — see camera-controller.ts for the validation /
   *  clamp logic (moved verbatim). */
  setCenter(lon: number, lat: number): void { this.cameraController.setCenter(lon, lat); this._cameraExplicitlyPositioned = true; this._dirty.tag(DirtyDomain.CAMERA) }
  setZoom(zoom: number): void { this.cameraController.setZoom(zoom); this._cameraExplicitlyPositioned = true; this._dirty.tag(DirtyDomain.CAMERA) }
  setMinZoom(z: number): void { this.cameraController.setMinZoom(z) }
  setMaxZoom(z: number): void { this.cameraController.setMaxZoom(z) }
  getMinZoom(): number { return this.cameraController.getMinZoom() }
  getMaxZoom(): number { return this.cameraController.getMaxZoom() }
  zoomIn(): void { this.cameraController.zoomIn() }
  zoomOut(): void { this.cameraController.zoomOut() }
  setMaxBounds(bounds: [[number, number], [number, number]] | null): void { this.cameraController.setMaxBounds(bounds) }
  getMaxBounds(): [[number, number], [number, number]] | null { return this.cameraController.getMaxBounds() }
  getBounds(): [[number, number], [number, number]] { return this.cameraController.getBounds() }

  /** Mapbox-API parity: returns true once the map has finished its
   *  initial load and entered the render loop. Matches MapLibre GL
   *  JS `map.loaded()`. Tracks the same `__xgisReady` signal the
   *  smoke-test harness polls. */
  private _loaded = false
  loaded(): boolean { return this._loaded }

  /** Host hook fired once if the GPU device is lost (driver reset, tab
   *  backgrounding, OOM) — NOT on explicit teardown. The render loop
   *  already stops itself on loss (no error cascade); use this to surface
   *  a "GPU lost — reload" affordance or trigger app-level re-init. Safe
   *  to call before or after init: stored and applied when the GPU
   *  context resolves. */
  onDeviceLost(cb: (info: GPUDeviceLostInfo) => void): void {
    this._onDeviceLost = cb
    if (this.ctx) this.ctx.onDeviceLost = cb
  }
  private _onDeviceLost?: (info: GPUDeviceLostInfo) => void

  /** Host hook fired once if WebGPU is unavailable when the map tries to
   *  mount — no `navigator.gpu` (unsupported browser) or no GPU adapter.
   *  Lets the embedding app surface a graceful "WebGPU required" fallback
   *  instead of an uncaught throw bubbling to window.onerror. The map
   *  simply does not mount (no ctx, render loop never starts). Safe to
   *  set before run(). */
  onWebGPUUnavailable(cb: () => void): void { this._onWebGPUUnavailable = cb }
  private _onWebGPUUnavailable: (() => void) | null = null

  /** Default WebGPU-unavailable UX when the host did NOT register an
   *  onWebGPUUnavailable() handler: show a message in the map container
   *  instead of leaving a silent blank canvas (the renderer is WebGPU-only,
   *  there is no Canvas 2D / WebGL fallback). The host can override this by
   *  registering onWebGPUUnavailable(). */
  private _showWebGPUUnavailableDefault(): void {
    const msg = 'This map requires a WebGPU-capable browser (latest Chrome/Edge, or Safari 18+).'
    // eslint-disable-next-line no-console
    console.warn('[X-GIS] ' + msg + ' Register onWebGPUUnavailable() to customize this.')
    if (typeof document === 'undefined') return
    const parent = this.canvas?.parentElement
    if (!parent || parent.querySelector('[data-xgis-webgpu-unavailable]')) return
    const el = document.createElement('div')
    el.setAttribute('data-xgis-webgpu-unavailable', '')
    el.setAttribute('role', 'alert')
    el.textContent = msg
    el.style.cssText =
      'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
      'text-align:center;padding:1rem;box-sizing:border-box;' +
      'font:14px/1.5 system-ui,-apple-system,sans-serif;color:#e5e7eb;background:#111827;'
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
    parent.appendChild(el)
  }

  /** Mapbox-API parity: return the underlying canvas element.
   *  Hosts need this to attach gesture listeners, capture screenshots
   *  via canvas.toBlob, or compute hit-test coordinates. Falls back
   *  to the constructor-supplied canvas if ctx hasn't initialized yet
   *  (pre-init phase before WebGPU adapter resolves). */
  getCanvas(): HTMLCanvasElement {
    return (this.ctx?.canvas ?? this.canvas) as HTMLCanvasElement
  }

  /** Mapbox-API parity: return the canvas's parent container element.
   *  Returns null if the canvas has no parent (e.g. detached mount).
   *  Mapbox GL JS hosts use this to position UI controls relative to
   *  the map. */
  getContainer(): HTMLElement | null {
    const c = this.getCanvas()
    return (c?.parentElement as HTMLElement) ?? null
  }

  /** Mapbox-API parity: fit the camera to a lon/lat bounding box.
   *  Delegated to CameraController. */
  fitBounds(
    bounds: [[number, number], [number, number]],
    opts: { padding?: number; bearing?: number; pitch?: number } = {},
  ): void {
    this.cameraController.fitBounds(bounds, opts)
    this._cameraExplicitlyPositioned = true
    this._dirty.tag(DirtyDomain.CAMERA)
  }

  /** Mapbox-API parity stub: setStyle / addLayer / addSource / addImage
   *  are not implemented. X-GIS uses compile-time IR, not runtime style
   *  mutation — the host loads compiled .xgis via the constructor or
   *  vector-tile attach helpers, not via these MapLibre GL JS methods.
   *
   *  These warn-once stubs make porting MapLibre code fail loudly and
   *  early rather than silently no-op. The warning points the user at
   *  the right replacement API. */
  private _warnedStyleAPI = new Set<string>()
  private _warnUnsupported(method: string, replacement: string): void {
    if (this._warnedStyleAPI.has(method)) return
    this._warnedStyleAPI.add(method)
    xlog.warn(`[X-GIS] map.${method}() is not supported. ${replacement}`)
  }
  setStyle(_style: unknown): void {
    this._warnUnsupported('setStyle', 'Recompile the .xgis source via @xgis/compiler and reload the runtime; X-GIS uses compile-time IR, not runtime style swap.')
  }
  addLayer(_layer: unknown, _beforeId?: string): void {
    this._warnUnsupported('addLayer', 'Add the layer to your .xgis source and recompile; runtime layer-mutation is not implemented.')
  }
  removeLayer(_id: string): void {
    this._warnUnsupported('removeLayer', 'Set `visible: false` on the layer style in your .xgis source instead.')
  }
  addSource(_id: string, _source: unknown): void {
    this._warnUnsupported('addSource', 'Declare the source in your .xgis source / use attachPMTilesSource for vector tiles.')
  }
  removeSource(_id: string): void {
    this._warnUnsupported('removeSource', 'Remove the source from your .xgis source and recompile.')
  }
  addImage(_id: string, _image: unknown): void {
    this._warnUnsupported('addImage', 'Sprite atlas is not implemented yet (Batch 2 roadmap). Embed icon data in feature properties for now.')
  }

  /** Notify the map that its container resized (Mapbox-API parity). Just
   *  invalidates — the next frame's resizeCanvas picks up the new buffer
   *  size. Idempotent; also the funnel for the auto observers (P0-3). */
  resize(): void {
    this.invalidate()
  }

  /** Route engine logs (pass-validation errors, warnings) to a custom sink
   *  instead of the console — for telemetry / in-app overlays. Pass null to
   *  restore the console default. */
  setLogSink(sink: import('./log').LogSink | null): void { setEngineLogSink(sink) }

  /** Mapbox-API parity: animated camera variants. X-GIS has no
   *  transition infra yet, so both alias to jumpTo (instant) inside
   *  CameraController. */
  easeTo(opts: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number; duration?: number; easing?: unknown }): void {
    this.cameraController.easeTo(opts)
    this._cameraExplicitlyPositioned = true
    this._dirty.tag(DirtyDomain.CAMERA)
  }
  flyTo(opts: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number; duration?: number; speed?: number; curve?: number }): void {
    this.cameraController.flyTo(opts)
    this._cameraExplicitlyPositioned = true
    this._dirty.tag(DirtyDomain.CAMERA)
  }

  /** Mapbox-API parity: pan the map by an offset in CSS pixels.
   *  Delegated to CameraController. */
  panBy(offset: [number, number]): void { this.cameraController.panBy(offset); this._cameraExplicitlyPositioned = true; this._dirty.tag(DirtyDomain.CAMERA) }

  setBearing(bearing: number): void { this.cameraController.setBearing(bearing); this._dirty.tag(DirtyDomain.CAMERA) }
  setPitch(pitch: number): void { this.cameraController.setPitch(pitch); this._dirty.tag(DirtyDomain.CAMERA) }

  /** Mapbox-API parity: bulk camera update. Delegated to
   *  CameraController. */
  jumpTo(opts: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): void {
    this.cameraController.jumpTo(opts)
    this._cameraExplicitlyPositioned = true
    this._dirty.tag(DirtyDomain.CAMERA)
  }

  /** Mapbox-API parity: per-axis getters. Delegated to CameraController. */
  getCenter(): [number, number] { return this.cameraController.getCenter() }
  getZoom(): number { return this.cameraController.getZoom() }
  getBearing(): number { return this.cameraController.getBearing() }
  getPitch(): number { return this.cameraController.getPitch() }

  /** MapLibre-API parity + the core debug-measurement primitive: project
   *  `[lon, lat]` → canvas-local CSS-px (×dpr for device px). Impl +
   *  full contract in `projectLonLatToScreenCss`. */
  project(lonLat: readonly [number, number]): [number, number] | null {
    const dpr = effectiveDpr(this._interacting)  // SAME interaction-cap dpr the frame sizes the canvas with (render-loop.ts:219)
    const [centerLon, centerLat] = this.getCenter()
    return projectLonLatToScreenCss(
      this.camera, this.canvas.width, this.canvas.height, dpr, centerLon, centerLat, lonLat,
    )
  }

  /** Inverse of `project`: canvas-local CSS-px → `[lon, lat]` (null if the ray
   *  misses the surface — off a globe/disc). Delegates to the camera's
   *  validated screen→lon/lat inverse (the gesture-anchor inverse,
   *  camera-helpers.ts) at the same interaction-cap dpr `project` uses. */
  unproject(screen: readonly [number, number]): [number, number] | null {
    const dpr = effectiveDpr(this._interacting)
    return this.camera.unprojectToLonLat(screen[0] * dpr, screen[1] * dpr, this.canvas.width, this.canvas.height, dpr)
  }

  /** Mapbox-API parity: read the current camera state as a single
   *  object. Delegated to CameraController. */
  getCameraState(): { center: [number, number]; zoom: number; bearing: number; pitch: number } {
    return this.cameraController.getCameraState()
  }

  /** @deprecated Phase 1a (Tier 3 source-honest principle): polar-cap
   *  synthesis is no longer renderer-driven. Preprocess GeoJSON with
   *  `injectPolarCaps` / `synthesizePolarCaps` (re-exported from
   *  `@xgis/runtime`) before `setSourceData`. This setter is a no-op +
   *  one-shot `xlog.warn` so existing host code does not throw. */
  setPolarCapsEnabled(on: boolean): void { this._viewport.setPolarCapsEnabled(on) }
  /** @deprecated Always returns `false` post-Phase 1a — polar-cap synthesis
   *  is no longer renderer-driven (see `setPolarCapsEnabled`). */
  isPolarCapsEnabled(): boolean { return this._viewport.isPolarCapsEnabled() }

  /** Current graticule on/off state. */
  isGraticuleEnabled(): boolean {
    return this._viewport.isGraticuleEnabled()
  }

  /** P4 opt-in flag. When true, run() invokes
   *  `emitCommands(scene, { enableComputePath: true, ... })`. The
   *  rest of the wire-up (handle attach, dispatch, bind groups) is
   *  unconditional but no-op when the variant carries no
   *  computeBindings. */
  private _enableComputePath = false
  /** Cached compute plan from the last successful run() so non-run
   *  paths (rebuildLayers after setProjection, etc.) can hand it to
   *  VTR.setComputeContext. Undefined when the scene didn't go
   *  through emitCommands w/ enableComputePath or had no compute
   *  paint expressions. */
  private _currentComputePlan: readonly import('@xgis/compiler').ComputePlanEntry[] | undefined

  /** Per-font typography overrides keyed by CSS family ("Open Sans"
   *  → { letterSpacingEm: -0.02, lineHeightScale: 1.05 }). Built from
   *  `options.fonts[].letterSpacingEm / lineHeightScale` at constructor
   *  time and passed through to TextStage so layer-level spacing /
   *  line-height can be tuned per font without forking the style spec. */
  fontTypography: FontTypographyMap | null = null

  /** Resolves once every font passed via `options.fonts` (or `add
   *  Font`) has finished loading. Importers should await this before
   *  the first label-producing frame to keep the atlas from caching
   *  system-fallback glyphs that the loaded font would later replace. */
  readonly fontsReady: Promise<void>

  /** Late-bound font loader — same shape as the constructor option.
   *  Useful for code-paths that don't own the constructor (style
   *  importer, plugin). Returns a promise that resolves when the
   *  added fonts are ready. The class-level `fontsReady` doesn't
   *  fold in subsequent calls — await the per-call return instead. */
  addFonts(fonts: XGISFontResource[]): Promise<void> {
    return registerFonts(fonts)
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
      this.renderTargets.invalidate()
      this.renderer.rebuildForQuality()
      this.rasterRenderer.rebuildForQuality()
      this.lineRenderer?.rebuildForQuality()
      this.pointRenderer?.rebuildForQuality()
      // Per-show variant pipelines + layouts both went stale: the
      // pipelines embed the OLD pick-attachment/MSAA target state, and
      // the layouts reference the OLD base/feature bind-group-layouts
      // that initPipelines just replaced. We can't simply null
      // `entry.pipelines` and rely on a "lazy rebuild" — the
      // bucket-scheduler never calls `getOrCreateVariantPipelines`; it
      // just falls back to `defaults.fillPipeline` (base-only) while
      // `entry.layout` still points at the old feature/compute layout.
      // That mismatch tripped per-frame `[BindGroupLayout
      // "mr-baseBindGroupLayout"] of pipeline layout
      // "mr-mainPipelineLayout(base-only)" does not match layout
      // [BindGroupLayout "mr-featureBindGroupLayout"]` validation and
      // the data-driven match() polygons stopped painting (fixture_
      // picking regression). Re-resolve both immediately so the entry
      // stays internally consistent.
      this._reResolveVariantPipelines()
      // VTRs hold their own references to the renderer's `extruded`
      // and `ground` pipelines (set once at attach time). After a
      // rebuild those references go stale — same pipeline-attachment-
      // mismatch panic, just one indirection deeper. Re-wire every
      // VTR to the freshly built pipelines.
      //
      // ALSO re-wire the bind-group layouts: VTR caches
      // `baseBindGroupLayout` (set once via setBindGroupLayout) AND
      // `featureBindGroupLayout` (captured per-variant by
      // buildFeatureDataBuffer). After `initPipelines` replaces both
      // layout objects on the renderer, every per-tile bind group VTR
      // already built (tileBgDefault, tileBgFeature, per-tile-feature-
      // bg) still references the OLD layouts. Drawing those bind
      // groups against the freshly-rebuilt fillPipeline (whose
      // pipelineLayout points at the NEW base BGL) is a layout
      // mismatch — WebGPU drops the draw call but does not throw a
      // catchable JS error (the validation error fires in the GPU
      // process and is async / silent at the JS layer), so the canvas
      // just goes dark with no console signal. multi_layer + countries
      // demo regressed this way after setQuality({picking:true}); fixed
      // by re-wiring the base BGL here. featureBindGroupLayout is
      // re-captured inside `_reResolveVariantPipelines` when each
      // variant-bearing show re-calls getOrBuildVariantLayout.
      for (const { renderer: vtRenderer } of this.vtSources.values()) {
        vtRenderer.setBindGroupLayout(this.renderer.bindGroupLayout)
        vtRenderer.setExtrudedPipelines(
          this.renderer.fillPipelineExtruded,
          this.renderer.fillPipelineExtrudedFallback,
        )
        vtRenderer.setGroundPipelines(
          this.renderer.fillPipelineGround,
          this.renderer.fillPipelineGroundFallback,
        )
        vtRenderer.setPatternPipelines(
          this.renderer.fillPipelinePatternGround,
          this.renderer.fillPipelinePatternGroundFallback,
        )
        vtRenderer.setPatternExtrudedPipelines(
          this.renderer.fillPipelinePatternExtruded,
          this.renderer.fillPipelinePatternExtrudedFallback,
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
    // Defense-in-depth: a move-rAF queued before destroy() must not run
    // copyTextureToBuffer/submit on the destroyed device (the dispatcher's
    // rAF is cancelled in destroy(); guard the entry point too).
    if (this._destroyed) return null
    return this.interactionController.pickAt(clientX, clientY)
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

  /** Change projection at runtime — GPU uniform only, no re-tessellation!
   *  Forwards to ViewportModeController (name validation + camera writes +
   *  the world-band-change bg-rebuild callback run on map.ts). The tag +
   *  invalidate stay here, in their original tail order, and only fire when
   *  the controller applied the switch (`true`); an unknown name is dropped
   *  with a warn inside the controller and short-circuits here. */
  setProjection(name: string): void {
    if (!this._viewport.setProjection(name)) return
    this._dirty.tag(DirtyDomain.PROJECTION)
    this.invalidate()
  }

  getProjectionName(): string {
    return this._viewport.getProjectionName()
  }

  /** Set the style's `glyphs` URL template (e.g.
   *  `https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf`).
   *  Used by the HTTP-backed `GlyphPbfCache` provider in the chain.
   *  Call BEFORE the first label-producing frame to pre-stage the
   *  URL; for late binding (style imported after the map mounted),
   *  the provider gets wired on the next TextStage construction.
   *  Passing `null` clears the URL. */
  setGlyphsUrl(url: string | null): void {
    this.glyphsUrl = url
  }

  /** Seed the glyph chain with pre-loaded PBF range bytes. Keyed as
   *  `{ fontstack: { rangeStart: Uint8Array } }`. Same chain semantics
   *  as `setGlyphsUrl` — call before first label frame. For embedded
   *  / air-gapped deployments where the host ships PBF data inside
   *  its own bundle. */
  setInlineGlyphs(seed: NonNullable<TextStageOptions['inlineGlyphs']> | null): void {
    this.inlineGlyphs = seed
  }

  /** Append a custom glyph provider (IndexedDB, S3, IPFS, etc.) to
   *  the chain. If the TextStage already exists, the provider is
   *  hooked in immediately and visible to the next `ensure()`. If
   *  not, it's queued for first-construction. Order matters: earlier
   *  providers take priority on sync `get()` probes. */
  addGlyphProvider(provider: GlyphProvider): void {
    this.glyphProviders.push(provider)
    this.textStage?.addGlyphProvider(provider)
    this.markLabelDirty() // re-arm the loop so an idle map repaints the upgraded glyphs
  }

  /** Set the style's `sprite` URL prefix (e.g.
   *  `https://demotiles.maplibre.org/styles/sprites/ofm`). The
   *  IconStage lazy-fetches `${url}.json` + `${url}.png` on first
   *  label-bearing frame. Once the stage is built, the URL is fixed
   *  for the session — set BEFORE the first label-producing show
   *  command lands, typically from the style importer. Passing
   *  `null` clears the setting. */
  setSpriteUrl(url: string | null): void {
    this.spriteUrl = url
  }

  /** Diagnostic — every icon name the style referenced that the
   *  sprite atlas didn't have AFTER it loaded. Iter 526 plumbing
   *  exposed on IconStage; lifted here as the public API so
   *  playground / Playwright specs can probe without crossing the
   *  private boundary. Returns `null` if the icon stage hasn't been
   *  built yet (no label-producing show has fired). */
  getMissingIconNames(): string[] | null {
    return this.iconStage?.getMissingIconNames() ?? null
  }

  /** Sibling diagnostic — icon names that DID resolve and dispatched
   *  to the GPU. Pair with `getMissingIconNames()` to distinguish
   *  "feature filter rejected everything" (both empty) from "feature
   *  reached dispatch and atlas resolved" (dispatched non-empty).
   *  Iter 532. */
  getDispatchedIconNames(): string[] | null {
    return this.iconStage?.getDispatchedIconNames() ?? null
  }

  /** Iter 108 sibling to getDispatchedIconNames — every resolved
   *  label text string TextStage has submitted post text-expr
   *  evaluation. Answers "did the text reach the stage" (vs
   *  "evaluated to empty and dropped before submit"). Used by
   *  bright-texas-shields e2e to isolate text-expr eval failures
   *  from downstream collision suppression. Returns null when no
   *  TextStage has been built yet (no label-producing show has
   *  fired). */
  getDispatchedLabelTexts(): string[] | null {
    return this.textStage?.getDispatchedLabelTexts() ?? null
  }

  /** iter-285 — disambiguate collision-suppressed vs render-but-
   *  invisible. `submitted` is the raw addLabel/addCurvedLineLabel
   *  count at frame start, `drawn` is the count of TextDraws that
   *  reached renderer.setDraws (post-collision). User-reported OFM
   *  Bright Texas highway shields: dispatchedLabelTexts include the
   *  shield numbers but the screen shows no glyphs — comparing
   *  submitted vs drawn here localises whether collision dropped
   *  them or whether they reached GPU but rendered invisibly. */
  getLastLabelCounts(): { submitted: number; drawn: number } | null {
    if (!this.textStage) return null
    return {
      submitted: this.textStage.getLastSubmittedLabelCount(),
      drawn: this.textStage.getLastDrawnLabelCount(),
    }
  }

  /** iter-336 — glyph-atlas generation counter (bumps on EVERY slot
   *  eviction/reuse, iter-190). Aliasing ("wrong character" — a label's
   *  glyph rendered from a slot since reassigned to another codepoint,
   *  the iter-175/268/273 class) can only happen when a slot is evicted.
   *  A STEADY frame (no camera change) whose generation is unchanged
   *  proves no eviction occurred → no aliasing possible that frame. A
   *  generation that keeps climbing at steady state = atlas thrashing =
   *  aliasing risk. Returns null before any TextStage is built. */
  getAtlasGeneration(): number | null {
    return this.textStage?.getAtlasGeneration() ?? null
  }

  /** iter-327 — live per-glyph placement dump for a user-reported label
   *  scatter. Call `setLabelDumpFilter("서울특별시")`, let one frame
   *  render, then `getDumpedLabels()` returns the ACTUAL per-glyph (x,y)
   *  offsets the renderer received. If line-2 glyphs share one y and
   *  ascend in x, the CPU composition is correct → the scatter is in the
   *  GPU shader; if they're mixed, the bug is in prepare. Off by default. */
  setLabelDumpFilter(substr: string | null): void {
    this.textStage?.setLabelDumpFilter(substr)
  }
  getDumpedLabels(): ReadonlyArray<{
    text: string; anchorX: number; anchorY: number; fontSize: number; slotSize: number; curved: boolean
    glyphs: ReadonlyArray<{ cp: number; x: number; y: number; bearingY: number; height: number; rfs: number }>
  }> | null {
    return this.textStage?.getDumpedLabels() ?? null
  }
  /** iter-343 — paired-icon placement dump (debug-labels page). Pairs
   *  with getDumpedLabels so the analyzer can flag a shield whose text
   *  centre drifts from its box (icon) centre. */
  setIconDumpEnabled(on: boolean): void {
    this.iconStage?.setIconDumpEnabled(on)
  }
  getDumpedIcons(): ReadonlyArray<{
    name: string; anchorX: number; anchorY: number; drawW: number; drawH: number; centerY: number
  }> | null {
    return this.iconStage?.getDumpedIcons() ?? null
  }

  /** iter-288 — FLICKER class tile-load diagnostic. Aggregates the
   *  per-source partition VTR exposes (`getTileLoadDiagnostic`)
   *  across every attached vector-tile source. Per memory entry
   *  `project_water_low_zoom_iter271`, the user-reported FLICKER
   *  log (`140 tiles z=5 gpuCache=62`) decomposes into needed vs
   *  cached vs upload-queued vs fetch-in-flight vs cap; this
   *  accessor surfaces every term so the next focused-fix iter can
   *  pin the bottleneck without re-reading the FLICKER log.
   *
   *  Returns one entry per source (keyed by source name) so multi-
   *  source styles (e.g. raster basemap + vector overlay) don't
   *  collide. */
  getTileLoadDiagnostic(): Record<string, {
    needed: number
    missed: number
    gpuUnique: number
    catalogCached: number
    catalogLoading: number
    uploadQueued: number
    gpuCap: number
  }> {
    const out: Record<string, ReturnType<VectorTileRenderer['getTileLoadDiagnostic']>> = {}
    for (const [name, entry] of this.vtSources) {
      out[name] = entry.renderer.getTileLoadDiagnostic()
    }
    return out
  }

  /** iter-286 — camera state snapshot for probe-first diagnosis of
   *  z=0 render bugs (mercator z=0 + pitch flat strip;
   *  ortho/azi/stereo/oblique z=0 disc-scale mis-render). Per
   *  `project_mercator_z0_pitch_render` + `project_non_merc_z0_disc_
   *  render_fail` memos, blind-patching camera.ts has historically
   *  flipped failure modes — matrix dump diff vs known-good cells is
   *  the only safe change cycle.
   *
   *  Returns the resolved 4×4 RTC matrix (column-major, 16 floats) +
   *  the derived altitude / halfFov / near-far plane numbers
   *  `_buildRTCMatrix` consumes. Caller passes current canvas dims
   *  (matches whatever the renderer used last frame). */
  getCameraDebugSnapshot(canvasWidth: number, canvasHeight: number, dpr: number = 1): {
    matrix: number[]
    far: number
    altitude: number
    halfFovRad: number
    pitchDeg: number
    bearingDeg: number
    zoom: number
    canvasW: number
    canvasH: number
    dpr: number
  } {
    return this.camera.getDebugSnapshot(canvasWidth, canvasHeight, dpr)
  }

  /** iter 152 — z0-halo probe (user report #1). Per-label resolved
   *  fontSize / rasterFontSize / halo width / haloWidthNorm (the
   *  value packUniforms feeds the shader). Lets an E2E read what the
   *  LIVE pipeline resolves at z0 vs deeper zoom.
   *  (memory project_z0_halo_too_large_2026_05_19) */
  getHaloDebug(): ReadonlyArray<{
    text: string; fontSize: number; rasterFontSize: number
    haloWidth: number; haloWidthNorm: number
  }> | null {
    return this.textStage?.getHaloDebug() ?? null
  }

  /** Per-frame draw count — answers "did icons render in the most
   *  recent prepare?" Distinct from `getDispatchedIconNames()` which
   *  is cumulative across all frames. Iter 533 — added to localize
   *  the bright-texas-shields invisible-shields bug. */
  getLastDrawIconCount(): number | null {
    return this.iconStage?.getLastDrawIconCount() ?? null
  }

  /** Iter 534 — vertex inspection diagnostic. Returns first vertex's
   *  pos_px_xy + uv + opacity + last atlas-size capture from the
   *  most recent IconRenderer.setDraws(). Lets the diagnostic answer
   *  "are the icons positioned off-screen?" and "are the UVs sane?". */
  getLastDrawSample(): {
    firstVertex: [number, number, number, number, number] | null
    atlasSize: { width: number; height: number } | null
    vertexBBox: { minX: number; minY: number; maxX: number; maxY: number } | null
    drawViewport: { width: number; height: number } | null
  } | null {
    return this.iconStage?.getLastDrawSample() ?? null
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
  _pendingLabelDebugHook?: ((text: string, ax: number, ay: number, kind: 'point' | 'curve') => void) | undefined

  /** Render-trace recorder. When set, every frame pushes its resolved
   *  paint state + label submissions into the recorder. Used by spec
   *  invariant tests (compiler/src/__tests__/spec-invariants/) and by
   *  diagnostic e2e specs to assert on the GPU INTENT rather than the
   *  pixel output. Pass `null` to detach.
   *
   *  Distinct from `setLabelDebugHook` — the trace recorder captures
   *  layer-level paint state in addition to label metadata, and is
   *  forwarded into the bucket scheduler's `traceRecorder` field on
   *  the next `renderFrame()` via `_pendingTraceRecorder`. */
  setTraceRecorder(recorder: import('../diagnostics/render-trace').RenderTraceRecorder | null): void {
    this._pendingTraceRecorder = recorder
    this.textStage?.setTraceRecorder(recorder)
  }
  _pendingTraceRecorder: import('../diagnostics/render-trace').RenderTraceRecorder | null = null

  /** One-shot helper: attaches a fresh recorder, waits TWO requestAnimationFrame
   *  ticks (the first ensures any in-flight frame settles, the second
   *  captures a clean one), then detaches and returns the snapshot.
   *  Used by e2e invariant tests via `window.__xgisMap.captureNextFrameTrace()`
   *  so test code doesn't have to import the recorder class through the
   *  page context. */
  async captureNextFrameTrace(): Promise<import('../diagnostics/render-trace').FrameTrace> {
    const { createTraceRecorder } = await import('../diagnostics/render-trace')
    const recorder = createTraceRecorder()
    this.setTraceRecorder(recorder)
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    // Force a render so labels/layers get emitted even if the camera
    // is idle (no auto-renderFrame queued).
    this.invalidate()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    const trace = recorder.snapshot()
    this.setTraceRecorder(null)
    return trace
  }

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
        onPointerMove: (x, y, e) => {
          // Continuous drag (pointer held) is an active gesture; a bare
          // hover is not — gate the interaction flag on _pointerActive.
          if (this._pointerActive) this.markInteracting()
          dispatcher.handleMove(x, y, e)
        },
        onPointerLeave: (e) => { this._pointerActive = false; dispatcher.handlePointerLeave(e) },
        // Any drag, rotate, or wheel zoom is the user explicitly
        // positioning the camera — disable the post-compile bounds-fit
        // auto-snap so the user doesn't get yanked back to whole-world
        // view when the next tile compile lands.
        onPointerDown: (x, y, e) => {
          this._cameraExplicitlyPositioned = true
          this._pointerActive = true
          this.markInteracting()
          void dispatcher.handlePointerDown(x, y, e)
        },
        onPointerUp: (x, y, e) => { this._pointerActive = false; void dispatcher.handlePointerUp(x, y, e) },
        // OS/gesture steal (capture loss) ends the drag without a clean
        // pointerup — clear the flag so a later hover can't re-pin low DPR.
        onPointerCancel: () => { this._pointerActive = false },
        onWheel: (x, y, e) => {
          this._cameraExplicitlyPositioned = true
          this.markInteracting()
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

  /** Re-resolve `entry.pipelines` AND `entry.layout` for every
   *  `vectorTileShows` entry from each show's current `shaderVariant`.
   *  Called from `setQuality` after `rebuildForQuality()` so the per-
   *  show pipelines + layouts the bucket-scheduler reads are consistent
   *  with the freshly rebuilt base / feature bind-group-layouts. The
   *  invariant the bucket-scheduler depends on:
   *
   *    (entry.pipelines === null) ↔ (entry.layout === null)
   *
   *  Violating it produces the BGL mismatch (commit 6080a2f). The
   *  invariant is verified by `map-set-quality-invariant.test.ts`. */
  _reResolveVariantPipelines(): void {
    for (const entry of this.vectorTileShows) {
      const variant = entry.show.shaderVariant
      if (variant && (variant.preamble || variant.needsFeatureBuffer)) {
        try {
          entry.pipelines = this.renderer.getOrCreateVariantPipelines(variant as never)
          entry.layout = this.renderer.getOrBuildVariantLayout(variant as never)
        } catch (e) {
          xlog.warn('[X-GIS] Variant pipeline re-resolve after setQuality failed:', e)
          entry.pipelines = null
          entry.layout = null
        }
      } else {
        entry.pipelines = null
        entry.layout = null
      }
    }
  }

  /** Map a feature-bounds lon-span to the auto-fit camera zoom. Shared
   *  across the four bounds-fit sites (sync setRawParts, async GeoJSON
   *  compile lands, VirtualPMTiles attach). Delegated to CameraController;
   *  kept on XGISMap so the `map._fitZoomToLonSpan(...)` test seam (cast)
   *  and the internal `this._fitZoomToLonSpan` callers stay unchanged. */
  private _fitZoomToLonSpan(lonSpan: number, cssWidthPx: number): number {
    return this.cameraController._fitZoomToLonSpan(lonSpan, cssWidthPx)
  }

  /** Read-only flag so tests can assert the state machine without
   *  reaching into private fields. Not part of the public API. */
  get _cameraPositionedFlag(): boolean {
    return this._cameraExplicitlyPositioned
  }

  /** Camera user-positioned flag — owned by CameraController. Exposed
   *  here as a get/set accessor so internal map.ts call-sites
   *  (run / pointer handlers / markCameraPositioned / bounds-fit gate)
   *  and the diagnostics + characterization-test cast seam
   *  (`map._cameraExplicitlyPositioned`) stay byte-identical. */
  private get _cameraExplicitlyPositioned(): boolean {
    return this.cameraController.cameraExplicitlyPositioned
  }
  private set _cameraExplicitlyPositioned(v: boolean) {
    this.cameraController.cameraExplicitlyPositioned = v
  }

  /** Reverse-resolve a layerId from the pick texture into its public
   *  XGISLayer wrapper. Returns null for the sentinel `0` and any ID
   *  that no longer maps to a registered layer (post-clearLayers). */
  private getLayerByPickId(layerId: number): XGISLayer | null {
    return this.interactionController.getLayerByPickId(layerId)
  }

  /** Build the rich feature payload for an event hit. Falls back to an
   *  ID-only feature when the source's `_featureIndex` doesn't carry
   *  full properties (e.g., .xgvt-loaded tile sources without a parsed
   *  property table). */
  private buildFeatureForEvent(layerId: number, featureId: number): XGISFeature | null {
    return this.interactionController.buildFeatureForEvent(layerId, featureId)
  }

  /** Convert a CSS-coordinate point to longitude/latitude using the
   *  current camera. Mercator-only; other projections return null and
   *  the dispatcher coerces to [NaN, NaN]. */
  private clientToLngLat(clientX: number, clientY: number): readonly [number, number] | null {
    return this.interactionController.clientToLngLat(clientX, clientY)
  }

  /** Load and run an X-GIS program */
  async run(source: string, baseUrl = ''): Promise<void> {
    // Re-entry guard. A destroyed map is inert — re-running would
    // resurrect it (re-arm the render loop + hold a fresh GPUDevice for
    // the page lifetime), so bail. Re-running a still-live map is a
    // legitimate scene swap, but the prior run()'s ctx/renderers/stages
    // must be torn down first or its GPUDevice is orphaned.
    if (this._destroyed) return
    if (this._loaded || this.running) this._teardownForReinit()

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
        xlog.error(`[X-GIS import] cannot build URL for "${path}" against base "${absBase}":`, (e as Error).message)
        return null
      }
      try {
        // SSRF guard: an imported style can `import { … } from "<url>"` —
        // block private/loopback/non-http(s) targets before fetch, AND
        // re-check every redirect hop (safeFetch follows manually) so an
        // allowlisted host can't 302 to an internal address. Throws into
        // the catch below → null (the import resolves to nothing, same as a
        // 404), so an attacker can't probe internal hosts.
        const resp = await safeFetch(url, undefined, 'style import URL')
        if (!resp.ok) {
          xlog.error(`[X-GIS import] fetch ${url} failed: ${resp.status} ${resp.statusText}`)
          return null
        }
        // Cap the module body — a lying/absent Content-Length otherwise lets
        // an unbounded .text() OOM the tab.
        const bytes = await readBodyCapped(resp, MAX_STYLE_BYTES, `style import ${url}`)
        return new TextDecoder().decode(bytes)
      } catch (e) {
        xlog.error(`[X-GIS import] fetch ${url} threw:`, (e as Error).message)
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
      // P4: bypass `extractMatchDefaultColor` when the compute path
      // is opted in, so match() fills survive lowering as data-
      // driven rather than collapsing to their default arm. Paired
      // with convertMapboxStyle's `bypassExpandColorMatch` (set by
      // the compare/demo runner when ?compute=1) for the symmetric
      // gate — both flags MUST be true for Mapbox-converted styles
      // to reach the compute kernel emit.
      const scene = lower(ast, {
        bypassExtractMatchDefaultColor: this._enableComputePath,
      })
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
        if (d.severity === 'warn') xlog.warn(`${prefix}${lineSuffix} ${d.message}`)
        else console.log(`${prefix}${lineSuffix} ${d.message}`)
      }
      commands = emitCommands(optimize(scene, ast), {
        enablePaletteSampling: true,
        // P4 opt-in: user-supplied via XGISMapOptions.enableComputePath.
        // When false (default) the compiler emits variants without
        // computeBindings, and every renderer-side compute branch
        // short-circuits to legacy paint resolve.
        enableComputePath: this._enableComputePath,
      })
    } else {
      commands = interpret(ast)
    }

    // background { fill: <color> } — Mapbox-style earth-surface fill.
    // Phase 2 PR 2c.3 ships this through the standard polygon ECEF
    // pipeline (SyntheticEarthSurfaceBackend serves a z=0 lat/lon-grid
    // mesh projected to ECEF; the synthetic ShowCommand prepended to
    // `commands.shows` carries the fill paint). Sphere projections see
    // the fill curve naturally; flat projections see the band fill at
    // sort-order 0 just like the legacy BackgroundRenderer path. Color
    // lookup: utility lines first (`| fill-sky-900` → resolveUtilities →
    // hex), then style properties (`fill: sky-900` or `fill: #082f49`).
    // StyleProperty stores the raw string; `sky-900` resolves via
    // resolveColor(); bare `#rrggbb` passes through.
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
    // Use hexToRgba (nullable variant) so an invalid hex shape falls
    // through to the renderer's built-in default instead of silently
    // painting black. parseHexColor always returns [0,0,0,1] on
    // regex-fail; switching to the null-returning variant surfaces
    // the bad input as "no override" rather than "opaque black
    // background".
    if (bgColor) {
      const parsed = hexToRgba(bgColor)
      if (parsed !== null) this._backgroundColor = parsed
    }

    console.log('[X-GIS] Parsed:', commands.loads.length, 'loads,', commands.shows.length, 'shows')

    // AC11b: build the per-source declared-CRS registry from the
    // LoadCommand carrier (`commands.loads[].crs`, threaded from IR
    // SourceDef.crs). The IR Scene is not retained past emitCommands, so
    // this Map is the runtime's only carrier for the host-push path —
    // setSourceData(sourceId, fc) looks the declared CRS up here later.
    // Rebuilt fresh each run() so a re-run with a different program
    // doesn't leak stale CRS declarations.
    // Cast: interpreter's LoadCommand type doesn't carry `crs` (it's a
    // compiler-LoadCommand-only field — the legacy interpreter path
    // assumes EPSG:4326, see interpreter.ts:67-74). Field access returns
    // undefined uniformly when absent, so the legacy path leaves the
    // registry empty (every source treated as 4326 / no-op).
    this.sourceCRS.clear()
    for (const load of commands.loads as { name: string; crs?: string }[]) {
      if (load.crs) this.sourceCRS.set(load.name, load.crs)
    }

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
      } else {
        // GeoJSON URL sources default-route through VirtualPMTilesBackend
        // (source-manager Phase 5f), which decodes tiles on the SAME MVT
        // worker pool. Mirror source-manager's classification: anything that
        // is NOT a raster (declared raster, or an untyped {z}/{x}/{y}
        // template) falls through to the GeoJSON path and needs that pool.
        const isDeclaredVector = declaredType === 'vector'
          || declaredType === 'tilejson'
          || declaredType === 'pmtiles'
        const looksLikeRaster = declaredType === 'raster'
          || (!isDeclaredVector && isTileTemplate(url))
        if (!looksLikeRaster) anyVectorTile = true
      }
    }
    // Prewarm the MVT decode worker pool when ANY load needs it. Each
    // worker takes 10-50 ms to spawn its JS context; lazy-spawning on
    // first compile pays that cost serially after the first byte
    // arrives. Pre-spawning here lets the workers initialise in
    // parallel with PMTiles header round trips and shader compile.
    // GeoJSON loads now hit this too (they decode on the MVT pool via the
    // virtual-PMTiles route) — without the prewarm the fleet spins up cold
    // on the first compile() AFTER __xgisReady (~720 ms of idle worker
    // module-eval the pre-ready GPU/shader init would otherwise hide).
    if (anyVectorTile) {
      void import('../data/workers/mvt-worker-pool').then(m => m.prewarmMvtWorkerPool()).catch(() => undefined)
    }


    // 2. Await the GPU init kicked off at step 0. WebGPU is required —
    // any failure here propagates so the caller knows the map can't
    // mount (no silent Canvas2D fallback any more; the fallback path
    // could only render a tiny subset of the pipeline correctly).
    const result = await gpuInit
    if (result instanceof WebGPUUnavailableError) {
      // Graceful: no WebGPU / no adapter. Fire the host hook, or show a default
      // in-container message if the host registered none, then abort the mount
      // instead of throwing an uncaught error to window.onerror.
      if (this._onWebGPUUnavailable) this._onWebGPUUnavailable()
      else this._showWebGPUUnavailableDefault()
      return
    }
    if (result instanceof Error) throw result
    // A destroy() may have landed while requestDevice() was in flight.
    // Re-arming state now would resurrect the map AND leak this freshly-
    // minted device for the page lifetime — destroy it and bail instead.
    if (this._destroyed) {
      (result as GPUContext)?.device?.destroy?.()
      return
    }
    this.ctx = result
    if (this._onDeviceLost) this.ctx.onDeviceLost = this._onDeviceLost
    this.renderer = new MapRenderer(this.ctx)
    this.renderer.setGraticuleEnabled(this._viewport.graticuleInitial)
    this.rasterRenderer = new RasterRenderer(this.ctx)
    if (GPU_PROF) this.gpuTimer = new GPUTimer(this.ctx)

    // P3 Step 3c — upload the scene-level color gradient palette to GPU
    // so MapRenderer + freshly-built VTRs sample the real atlas instead
    // of the 1×1 stub installed at MapRenderer init.
    if (commands.palette && commands.palette.colorGradients.length > 0) {
      // Guard with try/catch — palette upload races scene compile and a
      // transient GPU error (cold device, low-memory) shouldn't kill the
      // whole map. Falls back to the 1×1 stub atlas; legacy
      // `u.fill_color` uniform path keeps working for every variant.
      try {
        const packed = packPalette(commands.palette)
        const handles = uploadPalette(this.ctx.device, packed)
        if (this._paletteHandles) {
          this._paletteHandles.colorPalette.destroy()
          this._paletteHandles.scalarPalette.destroy()
          this._paletteHandles.colorGradientAtlas.destroy()
          this._paletteHandles.scalarGradientAtlas.destroy()
        }
        this._paletteHandles = handles
        this.renderer.setPaletteColorAtlas(handles.colorGradientAtlas.createView())
      } catch (e) {
        xlog.warn('[X-GIS] palette upload failed; falling back to legacy uniform path:',
          (e as Error)?.message)
      }
    }
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
    } catch (e) { xlog.warn('[X-GIS] PointRenderer init failed:', e) }

    // SDF line renderer (shared by all VTR instances)
    try {
      this.lineRenderer = new LineRenderer(this.ctx, this.renderer.bindGroupLayout)
      if (this.shapeRegistry) this.lineRenderer.setShapeRegistry(this.shapeRegistry)
    } catch (e) { xlog.warn('[X-GIS] LineRenderer init failed:', e) }
    // VT sources/renderers created per .xgvt file in the load loop


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
    // allSettled (not all) so a single source that fails EPSG reprojection
    // (invalid / unsupported `crs`) is isolated rather than aborting every
    // load (AC7). Non-reprojection failures (HTTP, JSON parse, …) keep the
    // existing fail-the-run contract and are re-thrown after the batch.
    const loadResults = await Promise.allSettled(commands.loads.map(load =>
      this.sourceManager._attachOneSource(load, baseUrl, {
        usedSourceLayers,
        extrudeExprsBySource,
        extrudeBaseExprsBySource,
        strokeWidthExprsBySource,
        strokeColorExprsBySource,
        showSlicesBySource,
      }, cameraFitState),
    ))
    for (const r of loadResults) {
      if (r.status !== 'rejected') continue
      const reason = r.reason as { xgisReprojectFailure?: boolean } | undefined
      if (reason && reason.xgisReprojectFailure === true) {
        // Isolate: log the bad-CRS source and let the other loads stand.
        xlog.error(reason instanceof Error ? reason.message : String(reason))
        continue
      }
      throw r.reason
    }

    // Seed inline GeoJSON captured from imported Mapbox styles. Direct
    // rawDatasets write (not setSourceData) because rebuildLayers runs
    // unconditionally a few lines below — calling setSourceData here
    // would fire a redundant retile.
    for (const [id, fc] of inlineGeoJSON) {
      if (this.rawDatasets.has(id)) {
        // Reproject declared-CRS input → WGS84 LL before tiling. Absent
        // CRS ⇒ EPSG:4326 / no-op (returns same ref). See reproject-fc.ts.
        this.rawDatasets.set(id, this._reprojectIngest(id, fc as GeoJSONFeatureCollection))
      } else {
        xlog.warn(`[X-GIS] Inline GeoJSON for unknown source "${id}" — dropping. (Mapbox style sources didn't emit a matching load command.)`)
      }
    }

    // Phase 2 PR 2c.3 — install the synthetic earth-surface backend +
    // prepend its ShowCommand at sort-order 0 so the style background
    // fill renders through the polygon ECEF pipeline. Skips when no
    // `background { fill: ... }` was declared (the canvas clearValue
    // dominates). Mutates `commands.shows` in place to land ahead of
    // every authored layer; rebuildLayers() then sees the synthetic
    // show first and dispatches it through the standard VT path.
    if (this._backgroundColor) {
      this._installSyntheticEarthSurfaceSource(this._backgroundColor)
      const syntheticShow = buildSyntheticEarthSurfaceShow(this._backgroundColor)
      commands.shows = [syntheticShow, ...commands.shows] as typeof commands.shows
    }

    this.showCommands = commands.shows
    // Issue #360 F1 — install per-source polar caps now that `showCommands`
    // is live (the cap fill is resolved from each source's polygon fill show)
    // and SourceManager has recorded which sources touch a pole. No-op on
    // mercator-class projections; the projection-change hook re-drives it.
    installGeoJSONPolarCaps(this._polarCapHost())
    commands.shows = this.showCommands as typeof commands.shows
    this._sceneHasAnimation = sceneHasAnyAnimation(commands.shows)
    this._labelsHaveTimeAnimation = labelsHaveTimeAnimation(commands.shows)
    // Full scene (re)build — style, sources, geometry, labels, and possibly
    // projection/animation all replaced; DIRTY_ALL is the honest mask.
    this._markDirty(DIRTY_ALL)
    // Cache the compute plan on `this` so non-run paths (e.g.
    // rebuildLayers after a setProjection, which re-creates VTR
    // sources WITHOUT a fresh emitCommands run) can still hand the
    // current plan to VTR.setComputeContext. Cleared on binary load
    // (which has no compute plan).
    this._currentComputePlan = (commands as { computePlan?: import('@xgis/compiler').ComputePlanEntry[] }).computePlan

    // Hand the compute plan to the renderer BEFORE rebuildLayers so
    // its addLayer calls can attach ComputeLayerHandles for variants
    // carrying `computeBindings`. `commands.computePlan` is
    // undefined when the compile didn't go through emitCommands
    // (binary load path) or when the scene had no compute-feature
    // paint shapes — the setter handles both as a clear. No effect
    // on production today: no callsite passes `enableComputePath`,
    // so variants never carry `computeBindings`.
    //
    // Cast: interpreter's SceneCommands type doesn't carry
    // `computePlan` (compiler-only field). The runtime field-access
    // returns undefined uniformly when absent.
    this.renderer.setComputePlan(
      (commands as { computePlan?: import('@xgis/compiler').ComputePlanEntry[] }).computePlan,
    )

    // Prewarm shader-variant pipelines BEFORE rebuildLayers so the
    // GPU driver compiles them in parallel with the rest of init.
    // Without this, `rebuildLayers` calls the synchronous
    // `getOrCreateVariantPipelines` (createRenderPipeline) which
    // returns a handle but defers driver compile to first draw —
    // showing up as a >1 s `(idle)` block on the first post-ready
    // frame for variant-heavy demos (filter_gdp at z=8 Europe).
    // `createRenderPipelineAsync` lets the driver work in the
    // background so the frame budget recovers.
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
        xlog.warn('[X-GIS] shader prewarm failed (falling back to lazy compile on first draw):', (e as Error).message)
      }
    }

    // A destroy() may have landed across the data-load / prewarm awaits.
    // Stop before rebuildLayers + re-arming the render loop — otherwise
    // the destroyed map resurrects and its device leaks for the page
    // lifetime. Tear down the device we created earlier in this run().
    if (this._destroyed) {
      this.ctx?.device?.destroy?.()
      return
    }

    // 4. Build render layers + fit camera
    this.rebuildLayers()

    // 5. Setup controller
    this.switchController()

    // 6. Start render loop
    this.running = true
    this.renderLoop()

    console.log('[X-GIS] Map running')

    // Expose a ready signal for headless e2e / smoke tests. The test
    // harness (playground/e2e/smoke.spec.ts) polls window.__xgisReady
    // to know when a demo has completed its initial load and entered
    // the render loop. Gated on `typeof window` so SSR / Node tests
    // don't trip over the global.
    this._loaded = true
    this._fireLoadEvent()
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

  /** Reproject a real-FC ingest from its declared source CRS to WGS84
   *  lon/lat before it enters `rawDatasets` (and therefore before tiling
   *  / bounds / camera-fit). The declared CRS is looked up by source name
   *  in `this.sourceCRS` (built in `run()` from `commands.loads[].crs`);
   *  a source with no declared CRS is treated as EPSG:4326 and the call
   *  is a no-op that returns the same reference (no clone). An invalid /
   *  unsupported EPSG throws a clear, source-attributable error (AC7) —
   *  callers on the parallel `Promise.all` load path isolate the failure
   *  to that one source rather than aborting every load. Only call this
   *  for real FeatureCollections — never for the synthetic `_vectorTile`
   *  / `_tileUrl` markers (those carry no coordinate data).
   *
   *  Public (underscore-prefixed) as a test seam — same convention as
   *  `_runBoundsFitGate` — so integration tests can drive the ingest
   *  reprojection without a GPU device (AC3/AC7/AC8). */
  _reprojectIngest(
    sourceName: string,
    fc: GeoJSONFeatureCollection,
  ): GeoJSONFeatureCollection {
    return this.sourceManager._reprojectIngest(sourceName, fc)
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
    this.rasterRenderer.setUrlTemplate('')
    // Drop any previously-tracked raster show. A new active one (if any)
    // is captured below by the same `_tileUrl` test that arms the
    // renderer.
    this._rasterShow = null

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
        this.rasterRenderer.setUrlTemplate(tileUrl)
        // Capture the show so the frame loop can resolve its
        // `paintShapes.opacity` per zoom (OFM Liberty's natural_earth
        // raster fades 0.6 → 0.1 across z=0..6). First-wins — multi-
        // raster scenes pick the earliest declared raster show.
        if (!this._rasterShow) this._rasterShow = show
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
            // Compute-aware layout selection: when the variant
            // carries `computeBindings`, MapRenderer returns the
            // per-variant extended layout (legacy entries + read-only
            // storage at the compiler-chosen binding indices) — VTR
            // builds its per-tile bind groups against this layout so
            // its pipeline + bind groups agree.
            layout = this.renderer.getOrBuildVariantLayout(variant as never)
            // P4 compute context: when the variant carries compute
            // bindings, hand the scene plan + renderNodeIndex to the
            // VTR so per-tile uploads can attach a ComputeLayerHandle.
            // Always called (no-op for non-compute variants).
            // Plan goes through `setComputePlan`; renderNodeIndex
            // travels with the variant via `buildFeatureDataBuffer`
            // so the two CANNOT drift across shows that share this
            // VTR. The plan setter is idempotent + scene-scoped.
            vtEntry.renderer.setComputePlan(this._currentComputePlan)
            if (variant.needsFeatureBuffer && !vtEntry.renderer.hasFeatureData()) {
              vtEntry.renderer.buildFeatureDataBuffer(
                variant as any, layout, show.renderNodeIndex,
              )
            }
          } catch (e) {
            xlog.warn('[X-GIS] VT variant pipeline failed:', e)
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
            layout = this.renderer.getOrBuildVariantLayout(variant as never)
            // Mirror of the sibling branch above — same compute-
            // context hand-off so this code path (existing VT source)
            // sees the compute plan for the new show.
            // Plan goes through `setComputePlan`; renderNodeIndex
            // travels with the variant via `buildFeatureDataBuffer`
            // so the two CANNOT drift across shows that share this
            // VTR. The plan setter is idempotent + scene-scoped.
            vtEntry.renderer.setComputePlan(this._currentComputePlan)
            if (variant.needsFeatureBuffer && !vtEntry.renderer.hasFeatureData()) {
              vtEntry.renderer.buildFeatureDataBuffer(
                variant as any, layout, show.renderNodeIndex,
              )
            }
          } catch (e) { xlog.warn('[X-GIS] VT variant pipeline failed:', e) }
        }
        this.vectorTileShows.push({ sourceName: vtKey, show, pipelines, layout })
        continue
      }

      let filtered = applyFilter(data, show.filterExpr, this.camera.zoom, this.camera.pitch)

      // Procedural geometry: evaluate geometry expression per feature
      if (show.geometryExpr?.ast) {
        filtered = applyGeometry(filtered, show.geometryExpr, this.camera.zoom, this.camera.pitch)
      }

      // Point geometry → SDF point renderer (skip polygon tiling pipeline)
      const firstGeomType = filtered.features[0]?.geometry?.type
      if ((firstGeomType === 'Point' || firstGeomType === 'MultiPoint') && !show.geometryExpr && this.pointRenderer) {
        const fillHex = show.fill
        const strokeHex = show.stroke
        const fill = fillHex ? parseHexColor(fillHex) : null
        const stroke = strokeHex ? parseHexColor(strokeHex) : null

        // Resolve the typed size PropertyShape to a concrete scalar
        // at the current camera state. Evaluated once at layer build
        // time — sufficient for static displays; live resize for
        // animated sizes runs through pointRenderer.updateDynamicSizes
        // each frame.
        const sizeShape = show.paintShapes.size
        const baseSize = sizeShape !== null
          ? (sizeShape.kind === 'constant'
              ? sizeShape.value
              : resolveNumberShape(sizeShape, this.camera.zoom, performance.now()).value)
          : 8

        // Evaluate per-feature size if data-driven. Inject reserved
        // keys (`$zoom` / `$geometryType` / `$featureId`) via
        // makeEvalProps so size expressions like
        // `interpolate(zoom, …)` or `case([==, ["geometry-type"],
        // "Point"], …)` see the live values. Pre-fix the raw props
        // bag meant size-by-zoom collapsed to baseSize uniformly.
        let perFeatureSizes: number[] | null = null
        if (show.sizeExpr?.ast) {
          const ast = show.sizeExpr.ast as import('@xgis/compiler').Expr
          const cameraZoom = this.camera.zoom
          const cameraPitch = this.camera.pitch
          perFeatureSizes = filtered.features.map(f => {
            const bag = makeEvalProps({
              props: (f.properties ?? undefined) as Record<string, unknown> | undefined,
              geometryType: f.geometry?.type,
              featureId: (f as { id?: string | number }).id,
              cameraZoom,
              cameraPitch,
            })
            // Per-feature throw isolation — mirror of applyFilter
            // (566ab36). One pathological size expression must not
            // collapse every point's size to NaN.
            let r: unknown
            try {
              r = evaluate(ast, bag)
            } catch {
              return baseSize
            }
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
          show.paintShapes.size,
        )
        continue
      }

      const source = new TileCatalog()
      const vtRenderer = new VectorTileRenderer(this.ctx)
      vtRenderer.setBindGroupLayout(this.renderer.bindGroupLayout)
    vtRenderer.setPaletteResources(this.renderer.paletteColorAtlasView, this.renderer.paletteSampler)
    vtRenderer.setSpriteAtlasView(this.renderer.spriteAtlasView)
      vtRenderer.setExtrudedPipelines(this.renderer.fillPipelineExtruded, this.renderer.fillPipelineExtrudedFallback)
      vtRenderer.setGroundPipelines(this.renderer.fillPipelineGround, this.renderer.fillPipelineGroundFallback)
    vtRenderer.setPatternPipelines(this.renderer.fillPipelinePatternGround, this.renderer.fillPipelinePatternGroundFallback)
    vtRenderer.setPatternExtrudedPipelines(this.renderer.fillPipelinePatternExtruded, this.renderer.fillPipelinePatternExtrudedFallback)
      vtRenderer.setOITPipeline(this.renderer.fillPipelineExtrudedOIT)
      if (this.lineRenderer) vtRenderer.setLineRenderer(this.lineRenderer)
      vtRenderer.setSource(source)
      this.vtSources.set(vtKey, { source, renderer: vtRenderer })

      // Phase 5f-2 opt-in path: route inline GeoJSON sources through
      // VirtualPMTilesBackend (the same pipeline URL-loaded GeoJSON
      // takes since Phase 5f-1). Gated behind a flag so the rollout
      // can expand demo-by-demo as we confirm parity. Skipped when:
      //   - the show carries a shader variant that needs the
      //     per-feature data buffer (the legacy path's addTileLevel
      //     + buildFeatureDataBuffer ordering is load-bearing for
      //     match() / gradient() variants)
      //   - the show carries a geometryExpr (procedural geometry
      //     reads raw features, not tile geometry)
      //   - filter is set (per-show filtering needs showSlices wiring
      //     into VirtualPMTilesBackend — separate work)
      const needsFeatureBuffer = !!(show.shaderVariant?.needsFeatureBuffer)
      const useVirtualForInline = typeof window !== 'undefined'
        && ((window as unknown as { __XGIS_USE_VIRTUAL_INLINE_GEOJSON?: boolean }).__XGIS_USE_VIRTUAL_INLINE_GEOJSON === true
            || /[?&]virt_inline=1\b/.test(window.location.search))
        && !hasFilter
        && !show.geometryExpr?.ast
        && !needsFeatureBuffer
      if (useVirtualForInline) {
        this.sourceManager._attachInlineGeoJSONViaVirtualPMTiles(vtKey, filtered, show, source)
        // Setup shader variant pipelines + layout synchronously so the
        // render loop has them on the first frame. needsFeatureBuffer
        // shows take the legacy path above; the variant pipeline here
        // is only the non-feature-buffer kind.
        const variantSync = show.shaderVariant
        let syncPipelines: typeof this.vtVariantPipelines = null
        let syncLayout: GPUBindGroupLayout | null = null
        if (variantSync && variantSync.preamble) {
          try {
            syncPipelines = this.renderer.getOrCreateVariantPipelines(variantSync as any)
            syncLayout = this.renderer.bindGroupLayout
          } catch (e) {
            xlog.warn('[X-GIS] GeoJSON VT variant pipeline failed:', e)
          }
        }
        this.vectorTileShows.push({ sourceName: vtKey, show, pipelines: syncPipelines, layout: syncLayout })
        continue
      }

      // Legacy path: worker compile → setRawParts → GeoJSONRuntimeBackend.
      // Offload `decomposeFeatures` + `compileGeoJSONToTiles(z0)` to a
      // worker so earcut over 10k+ features no longer blocks the main
      // thread. The source is created empty up-front; when the pool
      // returns we call `addTileLevel` + `setRawParts` + fit the camera.
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
          // Compute-aware layout selection — matches the same call in
          // rebuildLayers (lines 1729 / 1758) so the VTR per-tile
          // bind group uses the extended layout when the variant
          // carries computeBindings.
          vtRenderer.buildFeatureDataBuffer(
            variant as import('@xgis/compiler').ShaderVariant,
            this.renderer.getOrBuildVariantLayout(variant as never),
            show.renderNodeIndex,
          )
          vtRenderer.setComputePlan(this._currentComputePlan)
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
            // Keep centerLatDeg consistent with the fitted centerY (≤85, byte-safe).
            this.camera.syncCenterLat()
            const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
            const cssW = this.canvas.width / dpr
            this.camera.zoom = this._fitZoomToLonSpan(maxLon - minLon, cssW)
          }
        })
      }).catch((err) => {
        xlog.error('[X-GIS] GeoJSON compile failed:', err)
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
          layout = this.renderer.getOrBuildVariantLayout(variantSync as never)
        } catch (e) {
          xlog.warn('[X-GIS] GeoJSON VT variant pipeline failed:', e)
        }
      }
      this.vectorTileShows.push({ sourceName: vtKey, show, pipelines, layout })
    }

    console.log(`[X-GIS] Rebuilt layers (GPU projection: ${this.projectionName})`)
  }

  /** Load and run a pre-compiled .xgb binary */
  async runBinary(buffer: ArrayBuffer, baseUrl = ''): Promise<void> {
    // Re-entry guard — see run(). A destroyed map stays inert; a live map
    // tears down its prior device before re-loading so it isn't orphaned.
    if (this._destroyed) return
    if (this._loaded || this.running) this._teardownForReinit()

    const scene = deserializeXGB(buffer)
    const commands: SceneCommands = { loads: scene.loads, shows: scene.shows as unknown as SceneCommands['shows'] }

    console.log('[X-GIS] Binary loaded:', commands.loads.length, 'loads,', commands.shows.length, 'shows')

    let ctx: GPUContext
    try {
      ctx = await initGPU(this.canvas)
    } catch (e) {
      if (e instanceof WebGPUUnavailableError) {
        // Graceful: no WebGPU / no adapter. Fire the host hook, or show a
        // default in-container message if none, then abort the binary mount
        // instead of throwing to window.onerror.
        if (this._onWebGPUUnavailable) this._onWebGPUUnavailable()
        else this._showWebGPUUnavailableDefault()
        return
      }
      throw e
    }
    // A destroy() may have landed while requestDevice() was in flight —
    // re-arming now would resurrect the map and leak this device. Destroy
    // it and bail before assigning ctx / building renderers.
    if (this._destroyed) {
      ctx?.device?.destroy?.()
      return
    }
    this.ctx = ctx
    if (this._onDeviceLost) this.ctx.onDeviceLost = this._onDeviceLost
    this.renderer = new MapRenderer(this.ctx)
    this.renderer.setGraticuleEnabled(this._viewport.graticuleInitial)
    this.rasterRenderer = new RasterRenderer(this.ctx)
    if (GPU_PROF) this.gpuTimer = new GPUTimer(this.ctx)
      try { this.pointRenderer = new PointRenderer(this.ctx) } catch (e) { xlog.warn('[X-GIS] PointRenderer init failed:', e) }

    for (const load of commands.loads) {
      const url = load.url.startsWith('http') || load.url.startsWith('/') ? load.url : baseUrl + load.url
      // SSRF guard: a .xgb scene's source URL is host-supplied. Block
      // private/loopback/non-http(s) targets before fetch AND re-check each
      // redirect hop (safeFetch follows manually) so an allowlisted host
      // can't 302 to an internal address (throws, failing this binary load
      // the same way a network/parse error already does).
      const response = await safeFetch(url, undefined, `.xgb source "${load.name}"`)
      // Cap the raw body before JSON.parse, then bound the parsed collection
      // semantically — a hostile .xgb side-load can't OOM via an unbounded
      // .json() nor via an over-budget feature/vertex count.
      const rawBytes = await readBodyCapped(response, MAX_XGB_BYTES, `.xgb source "${load.name}"`)
      const data = JSON.parse(new TextDecoder().decode(rawBytes)) as GeoJSONFeatureCollection
      assertIngestBudget((data as { features?: unknown }).features, `.xgb source "${load.name}"`)
      // No EPSG reprojection here: .xgb does not serialize a source `crs`
      // (compiler/src/serialization/format.ts:44-48 carries name+url only),
      // and runBinary never builds the sourceCRS registry — so every .xgb
      // source is assumed EPSG:4326. Input-reprojection for binary loads is
      // an explicit Non-goal of the EPSG plan (AC12); revisit if/when the
      // .xgb format gains a crs field.
      this.rawDatasets.set(load.name, data)
    }

    // Mirror of run(): if a caller pushed a background fill via
    // setBackgroundFill before runBinary, install the synthetic source
    // + prepend its show. .xgb format doesn't carry a background block
    // today, so _backgroundColor only lands here through the public API.
    if (this._backgroundColor) {
      this._installSyntheticEarthSurfaceSource(this._backgroundColor)
      const syntheticShow = buildSyntheticEarthSurfaceShow(this._backgroundColor)
      commands.shows = [syntheticShow, ...commands.shows] as typeof commands.shows
    }

    // A destroy() may have landed across the per-source fetch awaits.
    // Stop before rebuildLayers + re-arming the loop, destroying the
    // device created above so it doesn't outlive the map.
    if (this._destroyed) {
      this.ctx?.device?.destroy?.()
      return
    }

    this.showCommands = commands.shows
    this._sceneHasAnimation = sceneHasAnyAnimation(commands.shows)
    this._labelsHaveTimeAnimation = labelsHaveTimeAnimation(commands.shows)
    // Full scene (re)build from a binary load — same DIRTY_ALL mask as run().
    this._markDirty(DIRTY_ALL)
    this.rebuildLayers()

    this.switchController()
    this.running = true
    this.renderLoop()
    this._fireLoadEvent()
    console.log('[X-GIS] Map running (from binary)')
  }

  /** Auto-detect: .xgb binary or .xgis source */
  async load(url: string): Promise<void> {
    // SSRF guard for the top-level public loader: a host-supplied URL must
    // not target a private/loopback host or a non-http(s) scheme, and every
    // redirect hop is re-checked (safeFetch follows manually) so an
    // allowlisted host can't 302 to an internal address. Throws
    // XGISSecurityError to the caller (this is an explicit public load —
    // the host decides how to surface a refused URL).
    const response = await safeFetch(url, undefined, 'map source URL')
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1)

    if (url.endsWith('.xgb')) {
      // Cap the binary scene body before materialising the ArrayBuffer.
      const bytes = await readBodyCapped(response, MAX_XGB_BYTES, `.xgb scene ${url}`)
      // readBodyCapped may hand back a view onto a larger pooled buffer;
      // pass a tightly-sliced ArrayBuffer to the deserializer.
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      await this.runBinary(buffer, baseUrl)
    } else {
      // Cap the style body before decoding to text.
      const bytes = await readBodyCapped(response, MAX_STYLE_BYTES, `.xgis style ${url}`)
      const source = new TextDecoder().decode(bytes)
      await this.run(source, baseUrl)
    }
  }

  renderLoop = (): void => {
    if (!this.running) return
    // Emit move/zoom/idle lifecycle events every rAF tick (before the skip
    // gate): catches camera changes from BOTH the gesture + programmatic lanes.
    this._processCameraEvents()
    if (!this.shouldRenderThisFrame()) {
      requestAnimationFrame(this.renderLoop)
      return
    }
    try {
      this.renderFrame()
      this._frameFailures = 0
    } catch (err) {
      // Surface the real message to the console / log overlay (a rAF throw
      // reaches window.onerror as "Script error. @ :0:0" under iOS WebKit).
      xlog.error('[X-GIS frame]', (err as Error)?.stack ?? err)
      // Bounded recovery (P0-2): retry next frame so a transient fault can't
      // freeze the map; only a persistent fault (3 consecutive) halts the loop
      // (no 60×/sec spam). destroy()/device-loss exit via running/deviceLost.
      if (++this._frameFailures >= 3) {
        xlog.error(`[X-GIS] render loop halted after ${this._frameFailures} consecutive frame failures`)
        this.running = false
        return
      }
      requestAnimationFrame(this.renderLoop)
    }
  }

  // Last camera signature for which lifecycle events were emitted. Kept
  // separate from `_lastSig*` (owned by renderFrame's idle-skip gate) so
  // the event logic is self-contained and robust across skipped frames.
  private _evtSigCX = NaN
  private _evtSigCY = NaN
  private _evtSigZoom = NaN
  private _evtSigBearing = NaN
  private _evtSigPitch = NaN

  /** Drive movestart/move/moveend, zoomstart/zoom/zoomend, and idle off
   *  the camera signature, once per rAF tick. MapLibre semantics:
   *    - a "move" begins on the first changed frame (`movestart`), fires
   *      `move` every changed frame, and ends (`moveend`) the first frame
   *      the camera is unchanged again — regardless of pending tile work.
   *    - "zoom" likewise, gated on the zoom field alone.
   *    - `idle` fires once on the busy→idle transition: camera at rest
   *      AND no pending tile/label work AND no active move/zoom.
   *  Diffing the camera (not `_lastSig*`) means programmatic jumpTo and
   *  user drag/wheel both flow through here uniformly. */
  private _processCameraEvents(): void {
    const c = this.camera
    const cxChanged = c.centerX !== this._evtSigCX
    const cyChanged = c.centerY !== this._evtSigCY
    const bearingChanged = c.bearing !== this._evtSigBearing
    const pitchChanged = c.pitch !== this._evtSigPitch
    const zoomChanged = c.zoom !== this._evtSigZoom
    // First tick: seed the signature without firing (NaN !== anything).
    const seeded = Number.isFinite(this._evtSigCX)
    const moved = seeded && (cxChanged || cyChanged || bearingChanged || pitchChanged || zoomChanged)

    if (moved) {
      // Zoom start/continue (zoom is also a move in MapLibre).
      if (zoomChanged) {
        if (!this._zoomActive) { this._zoomActive = true; this._fireMapEvent('zoomstart') }
      }
      if (!this._moveActive) { this._moveActive = true; this._fireMapEvent('movestart') }
      if (zoomChanged) this._fireMapEvent('zoom')
      this._fireMapEvent('move')
    } else {
      // Camera at rest this tick — close out any open move/zoom.
      if (this._zoomActive) { this._zoomActive = false; this._fireMapEvent('zoomend') }
      if (this._moveActive) { this._moveActive = false; this._fireMapEvent('moveend') }
    }

    // Update the emitted-signature snapshot.
    this._evtSigCX = c.centerX
    this._evtSigCY = c.centerY
    this._evtSigZoom = c.zoom
    this._evtSigBearing = c.bearing
    this._evtSigPitch = c.pitch

    // Idle = nothing left to draw AND camera at rest AND no open gesture.
    // `shouldRenderThisFrame()` already folds in _needsRender,
    // _sceneHasAnimation, hasPendingSourceWork, and the camera/size diff.
    const idleNow = !this._moveActive && !this._zoomActive && !this.shouldRenderThisFrame()
    if (idleNow) {
      if (!this._wasIdle) { this._wasIdle = true; this._fireMapEvent('idle') }
    } else {
      this._wasIdle = false
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
  classifyVectorTileShows(): {
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
      traceRecorder: this._pendingTraceRecorder,
    })
  }

  /** Thin instance wrapper around the pure grouper in
   *  `bucket-scheduler.ts`. */
  groupOpaqueBySource(opaque: ClassifiedShow[]): OpaqueGroup[] {
    return groupOpaqueBySourceImpl(opaque)
  }

  private renderFrame(): void {
    return this.renderLoopInstance.render()
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

  /** Mapbox GL JS-style paint property mutation (plan P6 first cut).
   *  Maps a Mapbox property name onto the corresponding XGISLayerStyle
   *  setter; returns true on a recognised (layer, property) pair, false
   *  for unknown layer or unsupported property. The setter path already
   *  invalidates the next frame and propagates into paintShapes /
   *  bucket-scheduler (commit 7724b5c), so no render-loop coupling.
   *
   *  Supported properties (constant scalar / hex string values):
   *    fill-color / line-color / fill-opacity / line-opacity / opacity
   *    line-width / visibility
   *
   *  Out of scope for this cut: expression values (e.g. `["match", ...]`)
   *  — those still require a full re-compile via the regular setStyle
   *  path. The plan's P6 incremental-recompile pass is a follow-up. */
  setPaintProperty(layerId: string, property: string, value: unknown): boolean {
    const layer = this.getLayer(layerId)
    if (!layer) return false
    switch (property) {
      case 'fill-color':
        if (typeof value !== 'string' && value !== null) return false
        // Validate hex shape BEFORE delegating to the setter. The
        // XGISLayerStyle.fill setter silently no-ops on invalid hex
        // (to keep show.fill + paintShapes.fill in sync), so
        // setPaintProperty would otherwise return `true` for an
        // unparseable value while the layer's colour didn't change.
        // Mirror of the runtime hexToRgba contract fix (iter 318).
        if (typeof value === 'string' && hexToRgba(value) === null) return false
        layer.style.fill = value as string | null
        this._dirty.tag(DirtyDomain.STYLE)
        return true
      case 'line-color':
        if (typeof value !== 'string' && value !== null) return false
        if (typeof value === 'string' && hexToRgba(value) === null) return false
        layer.style.stroke = value as string | null
        this._dirty.tag(DirtyDomain.STYLE)
        return true
      case 'fill-opacity':
      case 'line-opacity':
      case 'opacity':
        // Mapbox spec: opacity ∈ [0, 1]. Pre-fix an out-of-range value
        // propagated to the renderer untouched; negative opacity is
        // undefined behaviour and > 1 amplified colour bleeds through
        // alpha compositing.
        if (typeof value !== 'number' || !Number.isFinite(value)) return false
        layer.style.opacity = Math.max(0, Math.min(1, value))
        this._dirty.tag(DirtyDomain.STYLE)
        return true
      case 'line-width':
        // Mapbox spec: line-width >= 0. Negative values previously
        // propagated and the line shader produced inside-out miters.
        if (typeof value !== 'number' || !Number.isFinite(value)) return false
        layer.style.strokeWidth = Math.max(0, value)
        this._dirty.tag(DirtyDomain.STYLE)
        return true
      case 'visibility':
        // Mapbox-style: 'visible' | 'none'. Coerce to boolean for the
        // XGISLayerStyle setter; reject other strings.
        if (value !== 'visible' && value !== 'none') return false
        layer.style.visible = value === 'visible'
        this._dirty.tag(DirtyDomain.STYLE)
        return true
      default:
        return false
    }
  }

  /** Mapbox GL JS-style paint property query (plan P6 first cut). Mirrors
   *  `setPaintProperty` — returns the current value for recognised
   *  properties, undefined for unknown layer or property. Read from the
   *  XGISLayerStyle accessor which reflects any prior setPaintProperty
   *  override OR the compiled default. */
  getPaintProperty(layerId: string, property: string): unknown {
    const layer = this.getLayer(layerId)
    if (!layer) return undefined
    switch (property) {
      case 'fill-color':   return layer.style.fill
      case 'line-color':   return layer.style.stroke
      case 'fill-opacity':
      case 'line-opacity':
      case 'opacity':      return layer.style.opacity
      case 'line-width':   return layer.style.strokeWidth
      case 'visibility':   return layer.style.visible ? 'visible' : 'none'
      default:             return undefined
    }
  }

  /** Map-level event delegation — fires for any layer hit (`target` = the
   *  hit layer, same `XGISFeatureEvent` shape). Layer-level listeners run
   *  first; their `preventDefault` suppresses the map-level dispatch. */
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

  /** Mapbox-API parity `on()`/`off()` aliases. Two disjoint event surfaces
   *  routed by name: feature/pointer events (click, mousemove, …) →
   *  `mapListeners` (XGISFeatureEvent, carries the hit feature);
   *  lifecycle/camera events (load, idle, move*, zoom*) →
   *  `mapEventListeners` (XGISMapEvent, carries the camera state).
   *  Unknown names warn once at the feature registry (layer.ts, P0-4). */
  on(type: XGISMapEventType, listener: XGISMapListener): void
  on(type: XGISFeatureEventType, listener: XGISFeatureListener): void
  on(type: XGISFeatureEventType | XGISMapEventType, listener: XGISFeatureListener | XGISMapListener): void {
    if (isMapEventType(type)) this.mapEventListeners.add(type, listener as XGISMapListener)
    else this.mapListeners.add(type, listener as XGISFeatureListener)
  }
  off(type: XGISMapEventType, listener: XGISMapListener): void
  off(type: XGISFeatureEventType, listener: XGISFeatureListener): void
  off(type: XGISFeatureEventType | XGISMapEventType, listener: XGISFeatureListener | XGISMapListener): void {
    if (isMapEventType(type)) this.mapEventListeners.remove(type, listener as XGISMapListener)
    else this.mapListeners.remove(type, listener as XGISFeatureListener)
  }
  once(type: XGISMapEventType, listener: XGISMapListener): void
  once(type: XGISFeatureEventType, listener: XGISFeatureListener): void
  once(type: XGISFeatureEventType | XGISMapEventType, listener: XGISFeatureListener | XGISMapListener): void {
    if (isMapEventType(type)) this.mapEventListeners.add(type, listener as XGISMapListener, { once: true })
    else this.mapListeners.add(type, listener as XGISFeatureListener, { once: true })
  }

  /** Build + dispatch a lifecycle/camera event from the current camera
   *  state. No-op without listeners so the per-frame path stays cheap. */
  private _fireMapEvent(type: XGISMapEventType): void {
    if (!this.mapEventListeners.has(type)) return
    const cam = this.cameraController.getCameraState()
    this.mapEventListeners.dispatch(new XGISMapEvent({
      type,
      target: this,
      center: cam.center,
      zoom: cam.zoom,
      bearing: cam.bearing,
      pitch: cam.pitch,
    }))
  }

  /** Fire `load` exactly once, after the map has entered the render loop
   *  (the first frame has been scheduled). Mirrors the `_loaded` /
   *  `__xgisReady` contract — both run() and runBinary() call this after
   *  setting `_loaded = true`. MapLibre fires `load` once per map. */
  private _fireLoadEvent(): void {
    if (this._loadFired) return
    this._loadFired = true
    this._fireMapEvent('load')
  }

  /** Internal: dispatcher calls this after a layer-level dispatch so
   *  map-level handlers see every hit. `event.defaultPrevented` carries
   *  through — a layer listener's preventDefault() suppresses this. */
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

  /** Destroy GPU + catalog resources for every vtSources entry belonging to `sourceId` (incl. its filtered variants keyed `id__N`). */
  private teardownSource(sourceId: string): void {
    for (const [key, entry] of this.vtSources) {
      if (key === sourceId || key.startsWith(`${sourceId}__`)) {
        entry.renderer.destroy()
        entry.source.destroy()
        this.vtSources.delete(key)
      }
    }
  }

  /** Release every GPU resource this map allocated in a prior run()/
   *  runBinary() so the SAME instance can be re-loaded without orphaning
   *  the previous GPUDevice. Mirrors destroy()'s resource-freeing body
   *  MINUS the _destroyed latch and the canvas/controller/keyboard
   *  removal — those DOM hooks are reused by the re-run. After this
   *  returns, run()/runBinary() rebuild ctx + renderers + stages clean.
   *  No-op when nothing was ever loaded (`?.` covers a null ctx). */
  private _teardownForReinit(): void {
    this.running = false

    // Per-source GPU renderers + tile catalogs.
    for (const key of [...this.vtSources.keys()]) this.teardownSource(key)

    // Overlay stages own GPU buffers + glyph/icon atlases.
    this.textStage?.destroy()
    this.textStage = null
    this.iconStage?.destroy()
    this.iconStage = null

    // Colour / scalar palette + gradient-atlas textures.
    if (this._paletteHandles) {
      this._paletteHandles.colorPalette.destroy()
      this._paletteHandles.scalarPalette.destroy()
      this._paletteHandles.colorGradientAtlas.destroy()
      this._paletteHandles.scalarGradientAtlas.destroy()
      this._paletteHandles = null
    }

    // Keystone: frees EVERY remaining GPU resource on the prior per-map
    // device (buffers, textures, pipelines across all renderers + render
    // targets) in one call, so the orphaned device can't outlive the map.
    this.ctx?.device?.destroy()

    this.vtSources.clear()
  }

  /** Public teardown — releases every resource this map owns so an SPA
   *  can unmount it without leaking GPU memory, the render loop, or DOM
   *  listeners. Idempotent; after it runs the map is inert (invalidate /
   *  render no-op).
   *
   *  NOTE: the GeoJSON compile worker pool is a process-shared singleton
   *  (getSharedGeoJSONCompilePool) and is intentionally NOT terminated
   *  here — a sibling map may still be using it. Per-map worker ownership
   *  is a separate hardening item. */
  destroy(): void {
    if (this._destroyed) return
    this._destroyed = true
    this.running = false // next requestAnimationFrame tick early-returns

    // Pending interaction-idle debounce.
    if (this._interactionIdleTimer !== null) {
      clearTimeout(this._interactionIdleTimer)
      this._interactionIdleTimer = null
    }
    this._interacting = false
    this._pointerActive = false

    // Pending feature-update flush rAF (scheduleFlushPendingUpdates uses
    // window.requestAnimationFrame, or a setTimeout fallback in non-DOM
    // envs) — cancel with the matching primitive to drop the GC pin.
    if (this._pendingFlushHandle !== null) {
      if (typeof window !== 'undefined' && window.cancelAnimationFrame) {
        window.cancelAnimationFrame(this._pendingFlushHandle)
      } else clearTimeout(this._pendingFlushHandle)
      this._pendingFlushHandle = null
    }
    this._pendingPatches.clear()

    // Pointer-event dispatcher owns a move-coalescing rAF with no other
    // cancel path; its callback funnels into pickAt on the destroyed device.
    this.eventDispatcher?.destroy()
    this.eventDispatcher = null

    // DOM / pointer listeners — the leak that survives GC otherwise.
    this.controller?.detach()
    this.controller = null

    // Keyboard (a11y) listener — same leak class as the pointer listeners.
    // Detach from `this.canvas` (the exact element `_setupAccessibility`
    // attached to), not `getCanvas()`, so removal is symmetric.
    if (this._keyDownHandler) {
      this.canvas?.removeEventListener('keydown', this._keyDownHandler)
      this._keyDownHandler = null
    }

    // Auto resize/DPR observers (P0-3) — teardown mirror of the ctor attach.
    this._detachAutoResize?.()
    this._detachAutoResize = null

    // Per-source GPU renderers + tile catalogs (renderer.destroy each).
    for (const key of [...this.vtSources.keys()]) this.teardownSource(key)

    // Overlay stages own GPU buffers + glyph/icon atlases.
    this.textStage?.destroy()
    this.textStage = null
    this.iconStage?.destroy()
    this.iconStage = null

    // DOM stats overlay element.
    this._statsPanel?.destroy()
    this._statsPanel = null

    // Colour / scalar palette + gradient-atlas textures.
    if (this._paletteHandles) {
      this._paletteHandles.colorPalette.destroy()
      this._paletteHandles.scalarPalette.destroy()
      this._paletteHandles.colorGradientAtlas.destroy()
      this._paletteHandles.scalarGradientAtlas.destroy()
      this._paletteHandles = null
    }

    // Keystone: one call frees EVERY remaining GPU resource allocated on
    // this map's (per-map) device — buffers, textures, pipelines across
    // all renderers + render targets. `?.` covers a destroy() before
    // run() ever populated ctx.
    this.ctx?.device?.destroy()

    // Drop retained CPU data so it can be GC'd.
    this.vtSources.clear()
    this.rawDatasets.clear()

    // Window globals run() installed: snapshot/replay/trace closures capture
    // `this` (GC pin) and __xgisReady advertises a live map. Mirror of the
    // run() install block (~2088) — clear them so a destroyed map is neither
    // pinned nor reported loaded.
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __xgisReady?: boolean; __xgisSnapshot?: unknown; __xgisStartDrawOrderTrace?: unknown; __xgisReplaySnapshot?: unknown }
      w.__xgisReady = false
      delete w.__xgisSnapshot
      delete w.__xgisStartDrawOrderTrace
      delete w.__xgisReplaySnapshot
    }
  }

  /** Full-replace push for a GeoJSON source.
   *  Retiles and re-uploads only the affected source; other sources
   *  keep their existing GPU state.
   *
   *  Throws if `sourceId` was not declared in the .xgis file. */
  setSourceData(sourceId: string, data: GeoJSONFeatureCollection): void {
    this.sourceManager.setSourceData(sourceId, data)
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
        xlog.warn(`[X-GIS] updateFeature: unknown source "${sourceId}"`)
        this._unknownSourceWarned.add(sourceId)
      }
      return
    }
    // Tile-backed markers carry no FeatureCollection, so a patch would be
    // silently dropped at flush. Warn-once at enqueue time so the host learns
    // immediately rather than discovering a no-op.
    const dataset = this.rawDatasets.get(sourceId)
    if (!dataset || !Array.isArray((dataset as { features?: unknown }).features)) {
      if (!this._tileBackedUpdateWarned.has(sourceId)) {
        xlog.warn(`[X-GIS] updateFeature: source "${sourceId}" is tile-backed (URL-loaded); feature updates are only supported for host-pushed GeoJSON sources (setSourceData)`)
        this._tileBackedUpdateWarned.add(sourceId)
      }
      return
    }
    let bySource = this._pendingPatches.get(sourceId)
    if (!bySource) {
      bySource = new Map()
      this._pendingPatches.set(sourceId, bySource)
    }
    const existing = bySource.get(featureId)
    // Defensive: coerce non-plain-object patch.properties to {} so a
    // host passing a string / array (TypeScript-cast at the boundary)
    // doesn't spread char/index keys into the patched feature props.
    // Mirror of the makeEvalProps coercion (4e11bb7).
    const patchProps = patch.properties
    const safePatchProps = patchProps !== null && patchProps !== undefined
      && typeof patchProps === 'object' && !Array.isArray(patchProps)
      ? patchProps
      : {}
    bySource.set(featureId, {
      geometry: patch.geometry ?? existing?.geometry,
      properties: { ...(existing?.properties ?? {}), ...safePatchProps },
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
    if (this._destroyed) return
    if (this._pendingPatches.size === 0) return

    for (const [sourceId, patches] of this._pendingPatches) {
      const data = this.rawDatasets.get(sourceId)
      // Non-FeatureCollection shape (tile-backed marker / legacy direct write):
      // `.features` not being an array would crash the for-of. updateFeature
      // rejects markers at enqueue time; a patch reaching here warns once so
      // the no-op is observable rather than silent.
      if (!data || !Array.isArray((data as { features?: unknown }).features)) {
        if (!this._tileBackedUpdateWarned.has(sourceId)) {
          xlog.warn(`[X-GIS] updateFeature: source "${sourceId}" is not a patchable FeatureCollection; ${patches.size} pending update(s) dropped`)
          this._tileBackedUpdateWarned.add(sourceId)
        }
        continue
      }
      // Lookup via featureId index so patching is O(patches) instead of
      // O(features). The index is built once per source and reused across
      // flush cycles until setSourceData replaces the dataset.
      let index = this._featureIndex.get(sourceId)
      if (!index) {
        index = new Map()
        for (let i = 0; i < data.features.length; i++) {
          const f = data.features[i]
          // +1 on the fallback index branch mirrors the encode chokepoint
          // (geojson-compile-worker.ts:resolveIdResolver) so the stable id
          // the host receives from a pick event (i+1 for id-less features)
          // matches the key updateFeature patches against here.
          index.set(toU32Id(f.id ?? f.properties?.id ?? i + 1), f)
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
    this._markDirty(DirtyDomain.LABEL)
    return {
      remove: () => {
        const i = this.overlays.indexOf(overlay)
        if (i !== -1) {
          this.overlays.splice(i, 1)
          this._markDirty(DirtyDomain.LABEL)
        }
      },
    }
  }

  /** Remove every text overlay. */
  clearOverlays(): void {
    if (this.overlays.length === 0) return
    this.overlays.length = 0
    this._markDirty(DirtyDomain.LABEL)
  }
}
