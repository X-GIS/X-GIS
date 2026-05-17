// ═══ X-GIS Map — 전체를 연결하는 엔트리포인트 ═══

import { Lexer, Parser, lower, optimize, emitCommands, evaluate, makeEvalProps, deserializeXGB, resolveImportsAsync, resolveUtilities, resolveColor, tileKey as compilerTileKey, type Program } from '@xgis/compiler'
import { packPalette, uploadPalette, type PaletteTextures } from './gpu/palette-texture'
import type * as AST from '@xgis/compiler'
import { BackgroundRenderer } from './render/background-renderer'
import { getSharedGeoJSONCompilePool } from '../data/workers/geojson-compile-pool'
import { initGPU, resizeCanvas, GPU_PROF, getSampleCount, getMaxDpr, isPickEnabled, type GPUContext } from './gpu/gpu'
import { DEBUG_OVERDRAW } from './debug-flags'
import { OIT_ACCUM_FORMAT, OIT_REVEALAGE_FORMAT, WORLD_MERC, WORLD_COPIES, TILE_PX } from './gpu/gpu-shared'
import { QUALITY, updateQuality, onQualityChange, type QualityConfig } from './gpu/quality'
import { GPUTimer } from './gpu/gpu-timer'
import { Camera } from './projection/camera'
import { projectWgsl, needsBackfaceCullWgsl } from './projection/projection-wgsl-mirror'
import { globeForward } from './projection/globe'
import { MapRenderer, type ShowCommand } from './render/renderer'
import { resolveNumberShape, resolveColorShape, resolveSteppedShape } from './render/paint-shape-resolve'
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
import { VectorTileRenderer } from './render/vector-tile-renderer'
import { TextStage, type TextStageOptions } from './text/text-stage'
import type { GlyphProvider } from './text/sdf/pbf/glyph-provider'
import { IconStage } from './sprite/icon-stage'
import { resolveText } from './text/text-resolver'
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
import { VirtualPMTilesBackend } from '../data/sources/virtual-pmtiles-backend'
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
function asVectorTileKind(t: string | undefined): 'pmtiles' | 'tilejson' | 'auto' | undefined {
  // Mapbox-style sources declare `type: vector`; treat that as `auto`
  // so the URL-based detector picks the right format. Without this
  // mapping, sources like Protomaps `type:vector, tiles:[".../{z}/{x}/{y}.mvt"]`
  // fell through to raster classification via `isTileTemplate(url)`
  // and rendered as empty tiles (user-reported 2026-05-16).
  if (t === 'vector') return 'auto'
  return t === 'pmtiles' || t === 'tilejson' || t === 'auto' ? t : undefined
}

/** Scene-level animation detection. `true` when ANY ShowCommand
 *  carries a per-frame time-driven property — the paint axes
 *  (opacity / fill / stroke / strokeWidth / size) on PaintShapes
 *  or the structural dashOffsetShape. Drives the render loop's
 *  continuous-redraw decision: a static scene renders once and
 *  idles; an animated scene requestAnimationFrame's every tick. */
function sceneHasAnyAnimation(shows: {
  paintShapes: import('@xgis/compiler').PaintShapes
  dashOffsetShape?: import('@xgis/compiler').PropertyShape<number> | null
}[]): boolean {
  const isTimeAnimated = (k: string): boolean =>
    k === 'time-interpolated' || k === 'zoom-time'
  return shows.some(s => {
    const p = s.paintShapes
    return isTimeAnimated(p.opacity.kind)
      || isTimeAnimated(p.strokeWidth.kind)
      || (p.fill !== null && isTimeAnimated(p.fill.kind))
      || (p.stroke !== null && isTimeAnimated(p.stroke.kind))
      || (p.size !== null && isTimeAnimated(p.size.kind))
      || (s.dashOffsetShape !== null && s.dashOffsetShape !== undefined && isTimeAnimated(s.dashOffsetShape.kind))
  })
}

/** Walk every coordinate in a GeoJSON FeatureCollection and return
 *  the lon/lat bbox. Used by the Phase 5e VirtualPMTilesBackend
 *  attach path to pick a camera-fit position when the source has
 *  no external metadata (unlike PMTiles' `bounds` field). Returns
 *  null when the collection has no usable geometry. */
function computeGeoJSONBounds(
  fc: GeoJSONFeatureCollection,
): [number, number, number, number] | null {
  let minLon = Infinity, minLat = Infinity
  let maxLon = -Infinity, maxLat = -Infinity
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return
    // Coordinate pair: [lon, lat, ...]
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      const lon = c[0] as number, lat = c[1] as number
      if (lon < minLon) minLon = lon
      if (lon > maxLon) maxLon = lon
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      return
    }
    for (const inner of c) visit(inner)
  }
  for (const f of fc.features ?? []) {
    if (f.geometry) visit((f.geometry as { coordinates?: unknown }).coordinates)
  }
  if (!isFinite(minLon)) return null
  return [minLon, minLat, maxLon, maxLat]
}

/** A single font face to register via the CSS FontFace API. The
 *  pre-loaded `data` lets the map run completely offline — the host
 *  application embeds the WOFF/TTF bytes in its own bundle and hands
 *  them in. `weight` accepts a CSS-spec range string for variable
 *  fonts (e.g. `"300 800"`) or a single value (`"600"`). */
export interface XGISFontResource {
  family: string
  data: ArrayBuffer | Uint8Array
  weight?: string
  style?: string
  /** Em-unit offset ADDED to layer-level `text-letter-spacing` for any
   *  label whose primary font matches this family. Default 0. Useful
   *  when bundling fonts whose intrinsic tracking differs — e.g. Noto
   *  Sans looks slightly looser than Open Sans at the same nominal
   *  spacing, so a -0.02 offset re-balances multi-font layouts. */
  letterSpacingEm?: number
  /** Multiplier on the layer-level `text-line-height` (default 1.2em).
   *  Default 1.0. Some fonts authored with a tight UPM benefit from a
   *  small expansion (e.g. 1.05) for multi-line labels. */
  lineHeightScale?: number
}

/** Resource-injection bag for XGISMap. All fields are optional so the
 *  no-arg constructor (`new XGISMap(canvas)`) still works. Resources
 *  attached here are picked up by the TextStage on first construction
 *  (lazy — happens on the first label-bearing frame). Setters + `add
 *  GlyphProvider` cover the late-binding case. */
export interface XGISMapOptions {
  /** Glyph sources. `url` points at a MapLibre PBF server template;
   *  `inline` seeds the cache with pre-loaded PBF range bytes per
   *  fontstack — useful for air-gapped deployments. */
  glyphs?: {
    url?: string
    inline?: NonNullable<TextStageOptions['inlineGlyphs']>
  }
  /** Sprite atlas URL prefix (e.g. `https://.../sprites/ofm`). The
   *  IconStage fetches `${url}.json` + `${url}.png` on first label-
   *  bearing frame. Optional — leaving it unset means icon-image
   *  layers from imported styles render nothing (current default). */
  spriteUrl?: string
  /** Raw provider chain — escape hatch for custom backends (IndexedDB,
   *  S3, etc.). Sits between inline and HTTP in the chain. */
  glyphProviders?: GlyphProvider[]
  /** Pre-loaded WOFF/TTF fonts registered via the CSS FontFace API.
   *  Same effect as <link rel="preload"> + @font-face, but driven from
   *  JS so the host can ship the bytes inside its own bundle. */
  fonts?: XGISFontResource[]
  /** Plan P4 opt-in: route per-feature paint expressions
   *  (`match(get(field), ...)`, `case(...)`) through a GPU compute
   *  kernel instead of the legacy fragment-shader if-else chain.
   *
   *  When set to `true`, `emitCommands` runs with
   *  `enableComputePath: true`: the compiler emits a `computePlan`
   *  + variants carrying `computeBindings`, and MapRenderer attaches
   *  `ComputeLayerHandle` instances that dispatch per-frame compute
   *  kernels (see `compute-layer-registry.ts`).
   *
   *  Default is `false` (legacy fragment-shader path) until the
   *  per-style pixel-match verification gate flips. Direct .xgis
   *  fixtures with `match()` data-driven fills exercise the path
   *  cleanly; Mapbox-converted styles (OFM Bright etc.) get their
   *  match() expressions pre-expanded by `expand-color-match` so
   *  the compute path sees 0 entries on them — still safe to enable. */
  enableComputePath?: boolean
  /** Show the lat/lon graticule grid lines. Default `false` — the
   *  graticule was a debugging aid that shipped on by default; for
   *  basemap-quality output it should opt in. Toggle at runtime via
   *  `map.setGraticuleEnabled(bool)`. */
  graticule?: boolean
}

/** Map of CSS family name → per-font typography overrides. Built once
 *  from the constructor options and consulted in TextStage when
 *  computing per-label letter-spacing and line-height. */
export type FontTypographyMap = Map<string, { letterSpacingEm: number; lineHeightScale: number }>

function buildTypographyMap(fonts: readonly XGISFontResource[]): FontTypographyMap | null {
  const map: FontTypographyMap = new Map()
  for (const f of fonts) {
    const ls = f.letterSpacingEm ?? 0
    const lh = f.lineHeightScale ?? 1
    if (ls === 0 && lh === 1) continue
    map.set(f.family, { letterSpacingEm: ls, lineHeightScale: lh })
  }
  return map.size > 0 ? map : null
}

/** Register a batch of fonts via the FontFace API, returning a promise
 *  that resolves once every face has finished loading. No-op (and
 *  resolved immediately) in environments without `document.fonts`. */
async function registerFonts(fonts: readonly XGISFontResource[]): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  await Promise.all(fonts.map(async f => {
    try {
      const face = new FontFace(f.family, f.data as BufferSource, {
        weight: f.weight ?? 'normal',
        style: f.style ?? 'normal',
      })
      await face.load()
      document.fonts.add(face)
    } catch (e) {
      // One bad font shouldn't bring down the rest. Swallow + log so
      // the developer can spot it without crashing the page.
      console.warn(`[XGISMap] FontFace load failed for "${f.family}":`, e)
    }
  }))
}

export class XGISMap {
  private ctx!: GPUContext
  private camera: Camera
  private renderer!: MapRenderer
  private rasterRenderer!: RasterRenderer
  /** Show whose source backs the active raster URL — single-tracked
   *  for now (one raster basemap per scene is the realistic case).
   *  Per-frame `render()` resolves `paintShapes.opacity` here and
   *  pushes it to the renderer. Null when no raster show is active. */
  private _rasterShow: typeof this.showCommands[0] | null = null
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

  // SDF text overlay stage. Lazy — first `addOverlay` call instantiates.
  private textStage: TextStage | null = null
  private overlays: TextOverlay[] = []
  /** Resource bundle the TextStage uses to populate its glyph chain
   *  on first construction. Mutated by `setGlyphsUrl`, `addGlyph
   *  Provider`, and the constructor options bag. After the stage is
   *  built, late additions go through `textStage.addGlyphProvider`
   *  directly. */
  private glyphsUrl: string | null = null
  private inlineGlyphs: NonNullable<TextStageOptions['inlineGlyphs']> | null = null
  private glyphProviders: NonNullable<TextStageOptions['glyphProviders']> = []
  /** Sprite atlas URL prefix from the imported style's top-level
   *  `sprite` field. Used by the lazy IconStage to fetch
   *  `${url}.json` + `${url}.png`. Null = no icons rendered. */
  private spriteUrl: string | null = null
  /** Icon overlay stage — lazy, constructed on first frame after a
   *  spriteUrl is set. */
  private iconStage: IconStage | null = null

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
  /** P3 Step 3c — scene-scoped palette GPU textures. Held for
   *  destruction on the next scene reload; the underlying view is
   *  bound to every VTR + MapRenderer via setPaletteColorAtlas. */
  private _paletteHandles: PaletteTextures | null = null
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

  constructor(private canvas: HTMLCanvasElement, options: XGISMapOptions = {}) {
    this.camera = new Camera(0, 20, 2)
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
    // P4 opt-in for compute-driven paint evaluation. Stored as a
    // simple flag the run() method reads when invoking emitCommands.
    if (options.enableComputePath) this._enableComputePath = true
    // Graticule default off (was implicitly on). Applied AFTER renderer
    // construction via setGraticuleEnabled — held here until renderer
    // exists (initGPU resolves in run()).
    this._graticuleInitial = options.graticule === true
  }

  /** Captured at ctor time so run() can apply it once MapRenderer exists. */
  private _graticuleInitial = false

  /** Toggle the lat/lon grid overlay. Default off. */
  setGraticuleEnabled(on: boolean): void {
    this.renderer?.setGraticuleEnabled(on)
    this._graticuleInitial = on
    this.invalidate()
  }

  /** Current graticule on/off state. */
  isGraticuleEnabled(): boolean {
    return this.renderer?.isGraticuleEnabled() ?? this._graticuleInitial
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
  private fontTypography: FontTypographyMap | null = null

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
      this.msaaWidth = 0
      this.msaaHeight = 0
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
    // Normalize common aliases so URL `?proj=equirect` / Monaco's
    // hyphen-separated names ('natural-earth') resolve to the canonical
    // key the projType lookup uses. Unknown values silently fell back to
    // mercator (renderFrame's `?? 0`) — a silent footgun.
    const ALIASES: Record<string, string> = {
      equirect: 'equirectangular',
      'natural-earth': 'natural_earth',
      'azimuthal-equidistant': 'azimuthal_equidistant',
      'oblique-mercator': 'oblique_mercator',
    }
    const canonical = ALIASES[name] ?? name
    const prevProj = this.projectionName
    this.projectionName = canonical
    name = canonical

    // Adjust zoom for different projection scale
    // The wide-view set (flat azimuthal discs + the true 3D globe) all
    // frame the whole earth, so they need the zoomed-out view.
    const isWideView = (n: string) =>
      ['orthographic', 'azimuthal_equidistant', 'stereographic', 'globe'].includes(n)
    if (!isWideView(prevProj) && isWideView(name)) {
      this.camera.zoom = Math.min(this.camera.zoom, 1.5)
    } else if (isWideView(prevProj) && !isWideView(name)) {
      this.camera.zoom = Math.max(this.camera.zoom, 1.5)
    }

    // The azimuthal projections (ortho / azimuthal_equidistant /
    // stereographic) are exact 2D discs at pitch=0. A pitched 2D camera
    // would just lay the disc on its side, so instead of locking pitch
    // we promote them to the true 3D sphere when tilted: renderFrame
    // flips them to the globe vertex path (projType 7) with an
    // ORTHOGRAPHIC orbit camera (camera.globeOrtho) once pitch>0, giving
    // a real parallel-projection 3D tilt that is byte-identical to the
    // 2D disc at pitch=0 (orthographic projection of a sphere from the
    // surface normal IS the disc). pitch is no longer locked; it starts
    // at 0 on a projection switch so the view opens flat/exact.
    const AZIMUTHAL = ['orthographic', 'azimuthal_equidistant', 'stereographic']
    const isAzimuthal = AZIMUTHAL.includes(name)
    this.camera.pitchLocked = false
    if (isAzimuthal || name === 'globe') this.camera.pitch = 0
    // Azimuthal-when-tilted uses the parallel (orthographic) orbit
    // camera; the true `globe` keeps its perspective orbit camera.
    this.camera.globeOrtho = isAzimuthal

    // True 3D globe always emits the orbit view-projection; the
    // azimuthal set switches to it dynamically in renderFrame when
    // pitch>0 (renderers branch on projType 7).
    this.camera.globeMode = name === 'globe'

    this.invalidate()
  }

  getProjectionName(): string {
    return this.projectionName
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
  private _pendingTraceRecorder: import('../diagnostics/render-trace').RenderTraceRecorder | null = null

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
          console.warn('[X-GIS] Variant pipeline re-resolve after setQuality failed:', e)
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
   *  compile lands, VirtualPMTiles attach). Pulled into one place
   *  because a degenerate `lonSpan === 0` (single-point or co-linear
   *  fixtures like fixture-point.geojson) made the inline
   *  `Math.log2(360 / (degPerPx * 256))` collapse to Infinity → camera.
   *  zoom = Infinity → broken projection matrix → blank canvas with a
   *  `#Infinity/0/0` badge. */
  private _fitZoomToLonSpan(lonSpan: number, cssWidthPx: number): number {
    // Degenerate bounds → pin a country-level zoom. SDF point billboards
    // (size-40-class fixtures) read cleanly here, and the user can still
    // wheel-zoom out.
    if (!(lonSpan > 1e-9) || !(cssWidthPx > 0)) return 4
    const degPerPx = lonSpan / cssWidthPx
    return Math.max(0.5, Math.log2(360 / (degPerPx * 256)) - 1)
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
   *  current camera. Mercator-only; other projections return null and
   *  the dispatcher coerces to [NaN, NaN]. */
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
        if (d.severity === 'warn') console.warn(`${prefix}${lineSuffix} ${d.message}`)
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


    // 2. Await the GPU init kicked off at step 0. WebGPU is required —
    // any failure here propagates so the caller knows the map can't
    // mount (no silent Canvas2D fallback any more; the fallback path
    // could only render a tiny subset of the pipeline correctly).
    const result = await gpuInit
    if (result instanceof Error) throw result
    this.ctx = result
    this.renderer = new MapRenderer(this.ctx)
    this.renderer.setGraticuleEnabled(this._graticuleInitial)
    this.rasterRenderer = new RasterRenderer(this.ctx)
    this.backgroundRenderer = new BackgroundRenderer(this.ctx)
    if (this._backgroundColor) this.backgroundRenderer.setFill(this._backgroundColor)
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
        console.warn('[X-GIS] palette upload failed; falling back to legacy uniform path:',
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
    } catch (e) { console.warn('[X-GIS] PointRenderer init failed:', e) }

    // SDF line renderer (shared by all VTR instances)
    try {
      this.lineRenderer = new LineRenderer(this.ctx, this.renderer.bindGroupLayout)
      if (this.shapeRegistry) this.lineRenderer.setShapeRegistry(this.shapeRegistry)
    } catch (e) { console.warn('[X-GIS] LineRenderer init failed:', e) }
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
    this._sceneHasAnimation = sceneHasAnyAnimation(commands.shows)
    this._needsRender = true
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
        console.warn('[X-GIS] shader prewarm failed (falling back to lazy compile on first draw):', (e as Error).message)
      }
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
    // Mapbox styles declare `type: vector` / converted to `type: tilejson`
    // for MVT XYZ endpoints whose URL contains the `{z}/{x}/{y}` template.
    // Don't let the template-shape heuristic re-route those into the
    // raster path — declared vector-family type wins.
    const isDeclaredVector = declaredType === 'vector'
      || declaredType === 'tilejson'
      || declaredType === 'pmtiles'
    const looksLikeRaster = declaredType === 'raster'
      || (!isDeclaredVector && isTileTemplate(url))
    const vectorTileFormat = detectVectorTileFormat(url, asVectorTileKind(declaredType))

    if (looksLikeRaster) {
      this.rawDatasets.set(load.name, { _tileUrl: url } as unknown as GeoJSONFeatureCollection)
      return
    }

    if (vectorTileFormat !== null) {
      const source = new TileCatalog()
      const vtRenderer = new VectorTileRenderer(this.ctx)
      vtRenderer.setBindGroupLayout(this.renderer.bindGroupLayout)
    vtRenderer.setPaletteResources(this.renderer.paletteColorAtlasView, this.renderer.paletteSampler) // must be set before any tile uploads
      vtRenderer.setPaletteResources(this.renderer.paletteColorAtlasView, this.renderer.paletteSampler)
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
          const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
          const cssW = this.canvas.width / dpr
          this.camera.zoom = this._fitZoomToLonSpan(maxLon - minLon, cssW)
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

    // Phase 5f: VirtualPMTilesBackend is now the default route for
    // GeoJSON URL sources. The legacy main-thread compileSync path
    // (GeoJSONRuntimeBackend) is still available for opt-out
    // diagnostics during the rollout via either:
    //   - `window.__XGIS_USE_LEGACY_GEOJSON = true` in DevTools
    //   - `?legacy=1` query param
    // The opt-out keeps the safety net while we confirm the new
    // path is stable across every demo + fixture. Once the e2e
    // suite has run green for a stretch, the legacy path comes
    // out entirely (Phase 5f follow-up).
    const useLegacy = typeof window !== 'undefined' && (
      (window as unknown as { __XGIS_USE_LEGACY_GEOJSON?: boolean }).__XGIS_USE_LEGACY_GEOJSON === true
      || /[?&]legacy=1\b/.test(window.location.search)
    )
    const useVirtualPMTiles = !useLegacy
    if (useVirtualPMTiles) {
      // Diagnostic flag — set on `window` so the Phase 5e regression
      // spec can assert the route taken without parsing console
      // output. Cheap: one property write at attach time.
      if (typeof window !== 'undefined') {
        (window as unknown as { __xgisVirtualPMTilesActive?: boolean }).__xgisVirtualPMTilesActive = true
      }
      await this._attachGeoJSONViaVirtualPMTiles(load.name, data, maps, cameraFitState)
      return
    }

    this.rawDatasets.set(load.name, data)
  }

  /** Phase 5f-2 opt-in: attach an INLINE GeoJSON source (filtered,
   *  per-show) through VirtualPMTilesBackend, bypassing the legacy
   *  pool.compile + setRawParts + GeoJSONRuntimeBackend chain. Run
   *  when `__XGIS_USE_VIRTUAL_INLINE_GEOJSON` / `?virt_inline=1` is
   *  set AND the show is simple (no filter, no geometryExpr, no
   *  per-feature buffer variant — those still take the legacy path
   *  until showSlices and feature-buffer build ordering are wired
   *  through VirtualPMTilesBackend). */
  private _attachInlineGeoJSONViaVirtualPMTiles(
    vtKey: string,
    filtered: GeoJSONFeatureCollection,
    _show: ShowCommand,
    source: TileCatalog,
  ): void {
    const backend = new VirtualPMTilesBackend({
      sourceName: vtKey,
      geojson: filtered,
      // No per-show filter / extrude / stroke overrides here — those
      // are exactly the cases the gate above rejects.
    })
    source.attachBackend(backend)

    // Camera fit from the data's bounds. Same heuristic the legacy
    // compile callback uses; the bounds come from a sync walk
    // because we don't get a tileSet callback in this path.
    this._runBoundsFitGate(() => {
      let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
      const visit = (c: unknown): void => {
        if (!Array.isArray(c)) return
        if (typeof c[0] === 'number' && typeof c[1] === 'number') {
          const lon = c[0] as number, lat = c[1] as number
          if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon
          if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat
          return
        }
        for (const inner of c) visit(inner)
      }
      for (const f of filtered.features) {
        if (f.geometry) visit((f.geometry as { coordinates?: unknown }).coordinates)
      }
      if (minLon < Infinity) {
        const clampedLat = Math.max(-85, Math.min(85, (minLat + maxLat) / 2))
        const [cx, cy] = lonLatToMercator((minLon + maxLon) / 2, clampedLat)
        this.camera.centerX = cx
        this.camera.centerY = cy
        const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
        const cssW = this.canvas.width / dpr
        this.camera.zoom = this._fitZoomToLonSpan(maxLon - minLon, cssW)
      }
    })

    this.invalidate()
  }

  /** Phase 5e: attach a GeoJSON source through VirtualPMTilesBackend
   *  so it flows through the catalog + MVT-worker pipeline instead
   *  of the synchronous main-thread compileSync path. Mirrors the
   *  PMTiles attach branch above — same TileCatalog + VectorTileRenderer
   *  setup, same camera-fit logic, same vtSources registry — only
   *  the backend instance differs. */
  private async _attachGeoJSONViaVirtualPMTiles(
    sourceName: string,
    data: GeoJSONFeatureCollection,
    maps: ShowSourceMaps,
    cameraFitState: { fit: boolean },
  ): Promise<void> {
    const source = new TileCatalog()
    const vtRenderer = new VectorTileRenderer(this.ctx)
    vtRenderer.setBindGroupLayout(this.renderer.bindGroupLayout)
    vtRenderer.setPaletteResources(this.renderer.paletteColorAtlasView, this.renderer.paletteSampler)
    vtRenderer.setExtrudedPipelines(this.renderer.fillPipelineExtruded, this.renderer.fillPipelineExtrudedFallback)
    vtRenderer.setGroundPipelines(this.renderer.fillPipelineGround, this.renderer.fillPipelineGroundFallback)
    vtRenderer.setOITPipeline(this.renderer.fillPipelineExtrudedOIT)
    if (this.lineRenderer) vtRenderer.setLineRenderer(this.lineRenderer)
    vtRenderer.setSource(source)

    const inferred = maps.usedSourceLayers.get(sourceName)
    const filterLayers = inferred && inferred.size > 0 ? [...inferred] : undefined

    const backend = new VirtualPMTilesBackend({
      sourceName,
      geojson: data,
      layers: filterLayers,
      extrudeExprs: maps.extrudeExprsBySource.get(sourceName),
      extrudeBaseExprs: maps.extrudeBaseExprsBySource.get(sourceName),
      showSlices: maps.showSlicesBySource.get(sourceName),
      strokeWidthExprs: maps.strokeWidthExprsBySource.get(sourceName),
      strokeColorExprs: maps.strokeColorExprsBySource.get(sourceName),
    })
    source.attachBackend(backend)

    this.vtSources.set(sourceName, { source, renderer: vtRenderer })
    this.rawDatasets.set(sourceName, { _vectorTile: true } as unknown as GeoJSONFeatureCollection)

    // Camera-fit: derive bounds from the GeoJSON features themselves
    // (no remote metadata to consult, unlike PMTiles).
    if (!cameraFitState.fit) {
      const bounds = computeGeoJSONBounds(data)
      if (bounds) {
        cameraFitState.fit = true
        const [minLon, minLat, maxLon, maxLat] = bounds
        const clampedLat = Math.max(-85, Math.min(85, (minLat + maxLat) / 2))
        const [cx, cy] = lonLatToMercator((minLon + maxLon) / 2, clampedLat)
        this.camera.centerX = cx
        this.camera.centerY = cy
        const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
        const cssW = this.canvas.width / dpr
        this.camera.zoom = this._fitZoomToLonSpan(maxLon - minLon, cssW)
      }
    }
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
          } catch (e) { console.warn('[X-GIS] VT variant pipeline failed:', e) }
        }
        this.vectorTileShows.push({ sourceName: vtKey, show, pipelines, layout })
        continue
      }

      let filtered = applyFilter(data, show.filterExpr, this.camera.zoom)

      // Procedural geometry: evaluate geometry expression per feature
      if (show.geometryExpr?.ast) {
        filtered = applyGeometry(filtered, show.geometryExpr, this.camera.zoom)
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
          perFeatureSizes = filtered.features.map(f => {
            const bag = makeEvalProps({
              props: (f.properties ?? undefined) as Record<string, unknown> | undefined,
              geometryType: f.geometry?.type,
              featureId: (f as { id?: string | number }).id,
              cameraZoom,
            })
            const r = evaluate(ast, bag)
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
      vtRenderer.setExtrudedPipelines(this.renderer.fillPipelineExtruded, this.renderer.fillPipelineExtrudedFallback)
      vtRenderer.setGroundPipelines(this.renderer.fillPipelineGround, this.renderer.fillPipelineGroundFallback)
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
        this._attachInlineGeoJSONViaVirtualPMTiles(vtKey, filtered, show, source)
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
            console.warn('[X-GIS] GeoJSON VT variant pipeline failed:', e)
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
            const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
            const cssW = this.canvas.width / dpr
            this.camera.zoom = this._fitZoomToLonSpan(maxLon - minLon, cssW)
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
          layout = this.renderer.getOrBuildVariantLayout(variantSync as never)
        } catch (e) {
          console.warn('[X-GIS] GeoJSON VT variant pipeline failed:', e)
        }
      }
      this.vectorTileShows.push({ sourceName: vtKey, show, pipelines, layout })
    }

    console.log(`[X-GIS] Rebuilt layers (GPU projection: ${this.projectionName})`)
  }

  /** Load and run a pre-compiled .xgb binary */
  async runBinary(buffer: ArrayBuffer, baseUrl = ''): Promise<void> {
    const scene = deserializeXGB(buffer)
    const commands: SceneCommands = { loads: scene.loads, shows: scene.shows as unknown as SceneCommands['shows'] }

    console.log('[X-GIS] Binary loaded:', commands.loads.length, 'loads,', commands.shows.length, 'shows')

    this.ctx = await initGPU(this.canvas)
    this.renderer = new MapRenderer(this.ctx)
    this.renderer.setGraticuleEnabled(this._graticuleInitial)
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
    this._sceneHasAnimation = sceneHasAnyAnimation(commands.shows)
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
      traceRecorder: this._pendingTraceRecorder,
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

    let projType = {
      mercator: 0, equirectangular: 1, natural_earth: 2,
      orthographic: 3, azimuthal_equidistant: 4, stereographic: 5,
      oblique_mercator: 6, globe: 7,
    }[this.projectionName] ?? 0
    // Azimuthal-when-tilted: ortho/azimuthal_eq/stereographic are exact
    // 2D discs at pitch=0 but promote to the true 3D sphere once the
    // user tilts. At pitch>0 we drive the globe vertex path (projType 7
    // → proj_globe) with the camera's ORTHOGRAPHIC orbit matrix
    // (globeOrtho was set in setProjection). At pitch=0 they stay on
    // their exact 2D projection so the CPU/GPU consistency contract and
    // each projection's identity (stereographic ≠ ortho) are preserved.
    const azimuthalTilted = (projType >= 3 && projType <= 5) && this.camera.pitch > 0
    if (azimuthalTilted) projType = 7
    this.camera.globeMode = (projType === 7)
    // Hand the resolved projection kind to the camera so zoomAt can pick
    // a projection-correct cursor anchor (orthographic needs the spherical
    // inverse, not the flat-Mercator-plane unproject).
    this.camera.projType = projType
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
    // Reset per-frame timer state BEFORE compute dispatch so the
    // first compute pass gets timestampWrites attached. `beginFrame()`
    // clears both the sub-pass counter AND the
    // `computeRanThisFrame` latch — moving it after compute dispatch
    // (the original order) left the latch stale → second-frame onward
    // would skip compute timestamps even though compute was running.
    this.gpuTimer?.beginFrame()
    // P4 compute pass: run every attached ComputeLayerHandle's
    // kernel(s) BEFORE any render pass begins so the fragment shader
    // can read populated output buffers. No-op when no compute layer
    // is attached (no variant carries `computeBindings` in production
    // today). Must run after encoder creation, before the first
    // beginRenderPass.
    this.renderer.dispatchComputePass(encoder, this.gpuTimer)
    // Every active VTR also runs its per-tile compute kernels here
    // — they need to fire BEFORE the first render pass for the same
    // reason as MapRenderer: fragment shaders read the kernel output
    // buffer at draw time. No-op when no VTR has a compute-bound
    // show attached. Timer is consulted by the FIRST kernel that
    // dispatches each frame — see GPUTimer.computeWrites().
    for (const vtSource of this.vtSources.values()) {
      vtSource.renderer.dispatchComputePass(encoder, this.gpuTimer)
    }
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
      // Push camera frame info to the trace recorder so invariant
      // tests can correlate layer/label records with the frame state
      // that produced them.
      if (this._pendingTraceRecorder !== null) {
        const camMx = this.camera.centerX
        const camMy = this.camera.centerY
        const R = 6378137
        const lon = (camMx / R) * (180 / Math.PI)
        const lat = (Math.atan(Math.exp(camMy / R)) * 2 - Math.PI / 2) * (180 / Math.PI)
        const canvas = this.ctx?.canvas
        const cw = canvas?.width ?? 0
        const ch = canvas?.height ?? 0
        this._pendingTraceRecorder.recordCamera({
          zoom: this.camera.zoom,
          centerLon: lon,
          centerLat: lat,
          bearing: this.camera.bearing,
          pitch: this.camera.pitch,
          projection: this.projectionName ?? 'mercator',
          viewportWidthPx: cw,
          viewportHeightPx: ch,
          dpr: dpr,
        })
      }
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
            // Per-frame raster-opacity resolve. resolveNumberShape
            // honours constant / zoom-interpolated / time-interpolated
            // / zoom-time shapes — same code that drives every other
            // layer's opacity, just driving the global raster
            // renderer's uniform.
            if (this._rasterShow) {
              const op = resolveNumberShape(
                this._rasterShow.paintShapes.opacity,
                this.camera.zoom, this._elapsedMs,
              ).value
              this.rasterRenderer.setOpacity(op)
            } else {
              this.rasterRenderer.setOpacity(1)
            }
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
                false, cs.resolvedShow,
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
              false, cs.resolvedShow,
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
              cs.resolvedShow,
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
            // Composite opacity reads the Phase 4b ResolvedShow
            // snapshot: zoom × time already collapsed by the bucket
            // scheduler. Was `cs.show.opacity` — equivalent value,
            // narrower type (the snapshot is readonly, so a future
            // refactor that mutates `cs.show.opacity` mid-frame
            // can't accidentally drift this composite's input).
            this.lineRenderer!.composite(compPass, cs.resolvedShow.opacity)
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
          this.pointRenderer!.updateDynamicSizes(this.camera.zoom, performance.now())
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
          // Assemble the TextStage's glyph-resource options from
          // everything the host has handed us via constructor /
          // setters / addGlyphProvider. Empty bag → byte-identical
          // pre-PBF behaviour.
          const tsOpts: TextStageOptions = {}
          if (this.glyphsUrl !== null) tsOpts.glyphsUrl = this.glyphsUrl
          if (this.inlineGlyphs !== null) tsOpts.inlineGlyphs = this.inlineGlyphs
          if (this.glyphProviders.length > 0) tsOpts.glyphProviders = this.glyphProviders
          if (this.fontTypography !== null) tsOpts.fontTypography = this.fontTypography
          // Bake locally-rasterised (non-PBF) glyphs at physical-pixel
          // resolution so Hangul/Han labels aren't GPU-upscaled ~dpr×
          // from a 24-px atlas raster (low-res CJK on hidpi screens).
          tsOpts.dpr = dpr
          this.textStage = new TextStage(device, this.ctx.format, tsOpts, sc)
          this.textStage.prewarmGISDefaults()
          // Attach any debug hook that was set before the stage existed.
          // The hook is null/undefined-safe on the stage side, so the
          // common no-debug path stays a single null-check inside
          // addLabel.
          if (this._pendingLabelDebugHook !== undefined) {
            this.textStage.setLabelDebugHook(this._pendingLabelDebugHook)
          }
          if (this._pendingTraceRecorder !== null) {
            this.textStage.setTraceRecorder(this._pendingTraceRecorder)
          }
        }
        const stage = this.textStage
        // Lazy IconStage — only built when the style has a `sprite`
        // URL AND at least one currently-active label show declares
        // an `iconImage`. Both gates avoid the network fetch on
        // styles that don't need icons.
        if (this.iconStage === null && this.spriteUrl !== null
            && labelShows.some(s => s.label?.iconImage !== undefined)) {
          this.iconStage = new IconStage(device, this.ctx.format, {
            spriteUrl: this.spriteUrl, dpr,
          }, sc)
        }
        const iStage = this.iconStage
        // Anchors are projected against canvas.width/height (physical
        // px); LabelDef.size etc. are CSS-px convention. Telling the
        // stage the current DPR keeps text the right visual size on
        // hidpi displays — without this, a `label-size-13` renders
        // at 6.5 CSS px on a 2x display.
        stage.setDpr(dpr)
        iStage?.setDpr(dpr)
        // Per-label icon dispatch helper. Captures dpr + iStage from
        // the render-frame scope so the call sites below stay one
        // line — every per-feature addLabel that follows gets a
        // matching maybeAddIcon. Line / curve placement intentionally
        // doesn't call this (icon-along-curve is a Phase B+ feature);
        // point-anchored POI symbols (the demotiles + OFM Bright bus-
        // stop / school / amenity layers) flow through here.
        const dispatchIcon = (def: { iconImage?: string; iconSize?: number; iconAnchor?: import('@xgis/compiler').LabelDef['iconAnchor']; iconOffset?: [number, number]; iconRotate?: number }, ax: number, ay: number): void => {
          if (!iStage || def.iconImage === undefined) return
          const offDx = (def.iconOffset?.[0] ?? 0) * dpr
          const offDy = (def.iconOffset?.[1] ?? 0) * dpr
          iStage.addIcon(ax + offDx, ay + offDy, def.iconImage, {
            sizeScale: def.iconSize ?? 1,
            rotateRad: ((def.iconRotate ?? 0) * Math.PI) / 180,
            anchor: def.iconAnchor ?? 'center',
          })
        }
        // Mapbox `text-field` expressions that depend on zoom (e.g.
        // demotiles `text-field: {stops:[[2,"{ABBREV}"],[4,"{NAME}"]]}`
        // → step(zoom, .ABBREV, 4, .NAME)) need the camera zoom in the
        // evaluator props bag. Without this, zoom = undefined → NaN
        // → step()'s default arm forever, so country labels never
        // switched from "S. Kor" to "S. Korea" past z=4.
        stage.setCameraZoom(this.camera.zoom)
        const frame = this.camera.getFrameView(w, h, dpr)
        const mvp = frame.matrix
        const ccx = this.camera.centerX
        const ccy = this.camera.centerY

        // Inline projector — captures matrix + camera center; returns
        // null when the point projects behind camera or far outside.
        // `worldMercatorOffset` shifts the mercator X by N×WORLD_MERC
        // so the polygon renderer's world-copy loop can be mirrored
        // for labels (see projectLonLatCopies below).
        // Hot-path scalar projection. The line-label polyline path used to
        // be merc → lonLat → merc → screen (mercToLonLat + lonLatToMercator
        // back-to-back, both allocating `[x, y]` per vertex). Inlining a
        // direct merc → screen projector eliminates both round-trips +
        // both allocations. Profile on OFM Bright z=13: forEachLineLabel-
        // Polyline ran at 31ms/frame, with lonLatToMercator + mercToLonLat
        // alone consuming 25ms (80% of the function's time). The
        // direct projector caps that at the matrix-multiply core.
        //
        // Returns negative cw / out-of-NDC-window via `null` as before.
        // `projectScreen` is a SHARED 2-element scratch — caller copies
        // values out before the next call.
        const _projScratch: [number, number] = [0, 0]
        const projectMerc = (
          mx: number, my: number, worldMercatorOffset: number = 0,
        ): [number, number] | null => {
          const rtcX = (mx + worldMercatorOffset) - ccx
          const rtcY = my - ccy
          const cw = mvp[3]! * rtcX + mvp[7]! * rtcY + mvp[15]!
          if (cw <= 0) return null
          const ccx_ = mvp[0]! * rtcX + mvp[4]! * rtcY + mvp[12]!
          const ccy_ = mvp[1]! * rtcX + mvp[5]! * rtcY + mvp[13]!
          const ndcX = ccx_ / cw
          const ndcY = ccy_ / cw
          if (ndcX < -1.5 || ndcX > 1.5 || ndcY < -1.5 || ndcY > 1.5) return null
          _projScratch[0] = (ndcX + 1) * 0.5 * w
          _projScratch[1] = (1 - ndcY) * 0.5 * h
          return _projScratch
        }

        // Non-Mercator label anchors mirror the GPU reproject_point
        // (point-renderer.ts): project(lon,lat) - project(center) in the
        // ACTIVE projection, then the shared MVP — NOT the Mercator
        // formula, which detached every label from its feature under
        // natural_earth / ortho / azimuthal / stereo / oblique. Hoist the
        // projected camera centre + flag once per frame (centerLon /
        // centerLat / projType are renderFrame constants) so the hot
        // per-label path stays allocation-free.
        const _lblIsMerc = this.projectionName === 'mercator'
        const _lblIsGlobe = this.projectionName === 'globe'
        // Globe label anchor = sphere RTC against the focus, then the
        // full 4×4 orbit MVP (camera emits it in globe mode). Hoisted
        // per frame like _lblCenter.
        const _lblGlobeCenter = _lblIsGlobe
          ? globeForward(centerLon, centerLat)
          : ([0, 0, 0] as [number, number, number])
        const _lblCenter: [number, number] = _lblIsMerc || _lblIsGlobe
          ? [0, 0]
          : projectWgsl(projType, centerLon, centerLat, centerLon, centerLat)

        const projectLonLat = (
          lon: number, lat: number, worldMercatorOffset: number = 0,
        ): [number, number] | null => {
          if (_lblIsMerc) {
            // Inlined lonLatToMercator to skip the per-call allocation
            // (used to be `[mx, my] = lonLatToMercator(lon, lat)`).
            const DEG2RAD = Math.PI / 180
            const R = 6378137
            const LAT_LIMIT = 85.051129
            const lat_c = lat < -LAT_LIMIT ? -LAT_LIMIT : (lat > LAT_LIMIT ? LAT_LIMIT : lat)
            const mx = lon * DEG2RAD * R
            const my = Math.log(Math.tan(Math.PI / 4 + lat_c * DEG2RAD / 2)) * R
            const proj = projectMerc(mx, my, worldMercatorOffset)
            if (!proj) return null
            // Return a FRESH 2-tuple — projectMerc's scratch can't survive
            // across multiple projectLonLat calls in the same expression
            // (`projectLonLatCopies` builds a list of results).
            return [proj[0], proj[1]]
          }
          if (_lblIsGlobe) {
            // True 3D globe: hemisphere-cull, then sphere RTC against
            // the focus through the FULL 4×4 orbit MVP (the z column is
            // significant here, unlike the flat path which drops it).
            if (needsBackfaceCullWgsl(projType, lon, lat, centerLon, centerLat) < 0) return null
            const g = globeForward(lon, lat)
            const rx = g[0] - _lblGlobeCenter[0]
            const ry = g[1] - _lblGlobeCenter[1]
            const rz = g[2] - _lblGlobeCenter[2]
            const cw = mvp[3]! * rx + mvp[7]! * ry + mvp[11]! * rz + mvp[15]!
            if (cw <= 0) return null
            const ndcX = (mvp[0]! * rx + mvp[4]! * ry + mvp[8]! * rz + mvp[12]!) / cw
            const ndcY = (mvp[1]! * rx + mvp[5]! * ry + mvp[9]! * rz + mvp[13]!) / cw
            if (ndcX < -1.5 || ndcX > 1.5 || ndcY < -1.5 || ndcY > 1.5) return null
            return [(ndcX + 1) * 0.5 * w, (1 - ndcY) * 0.5 * h]
          }
          // Non-Mercator: exact CPU mirror of the GPU per-vertex path.
          // Cull the back hemisphere first (same thresholds as the
          // shader's needs_backface_cull), then project unconditionally
          // and apply the shared MVP. worldMercatorOffset is unused —
          // non-Mercator collapses to a single world copy.
          if (needsBackfaceCullWgsl(projType, lon, lat, centerLon, centerLat) < 0) return null
          const p = projectWgsl(projType, lon, lat, centerLon, centerLat)
          if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null
          const rtcX = p[0] - _lblCenter[0]
          const rtcY = p[1] - _lblCenter[1]
          const cw = mvp[3]! * rtcX + mvp[7]! * rtcY + mvp[15]!
          if (cw <= 0) return null
          const ndcX = (mvp[0]! * rtcX + mvp[4]! * rtcY + mvp[12]!) / cw
          const ndcY = (mvp[1]! * rtcX + mvp[5]! * rtcY + mvp[13]!) / cw
          if (ndcX < -1.5 || ndcX > 1.5 || ndcY < -1.5 || ndcY > 1.5) return null
          return [(ndcX + 1) * 0.5 * w, (1 - ndcY) * 0.5 * h]
        }

        // Line-label polylines arrive as absolute Mercator metres.
        // Mercator: project directly (the hot path — no merc↔lonLat
        // round-trip, which was ~80% of this pass pre-optimisation).
        // Non-Mercator: invert to lon/lat and route through
        // projectLonLat so the polyline reprojects through the ACTIVE
        // projection (with back-face cull) exactly like its line
        // geometry — otherwise curved road labels stay Mercator-laid
        // while the road itself is reprojected.
        const projectMercAny = (sx: number, sy: number): [number, number] | null => {
          if (_lblIsMerc) return projectMerc(sx, sy)
          const R = 6378137
          const lon = sx / (Math.PI / 180 * R)
          const lat = (2 * Math.atan(Math.exp(sy / R)) - Math.PI / 2) / (Math.PI / 180)
          return projectLonLat(lon, lat, 0)
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
        // Label-specific world-copy iteration. Polygon / line draws
        // enumerate WORLD_COPIES = [-2..+2] so geometry wraps cleanly
        // at the antimeridian. For LABELS, projecting the same
        // anchor through every world copy stacks duplicate country
        // names onto the visible canvas — at z=0/lng=180 the ±360°
        // copies all land within projectLonLat's NDC ±1.5 window and
        // the user sees Belgium / Russia / etc. drawn 2-3× across
        // the Pacific. MapLibre renders each feature's label exactly
        // once at its primary world position. Match that here by
        // trying offsets in `|offset|` order [0, ±1, ±2] and
        // returning the FIRST that projects; the primary copy wins
        // whenever it's visible, and only the antimeridian-seam
        // case falls through to an adjacent wrap.
        const projectLonLatCopies = (lon: number, lat: number): Array<[number, number]> => {
          if (this.projectionName !== 'mercator') {
            const proj = projectLonLat(lon, lat, 0)
            return proj ? [proj] : []
          }
          // Try world copies in increasing |offset| order: 0, then ±1,
          // then ±2. First copy that projects within the projector's
          // NDC ±1.5 window wins. Matches MapLibre: every label is
          // anchored to its primary world copy when visible, and only
          // wraps to an adjacent copy when the primary projects off-
          // screen (e.g., at the antimeridian seam).
          for (const wo of [0, -1, 1, -2, 2]) {
            const proj = projectLonLat(lon, lat, wo * WORLD_MERC)
            if (proj) return [proj]
          }
          return []
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
          }, ov.font, '__overlay')
        }

        // (b) Per-feature labels from ShowCommand.label
        for (const show of labelShows) {
          // If LabelDef.color is unset, fall back to the layer's fill
          // (typical Mapbox-style symbol-on-poly pattern: the same
          // colour for the polygon AND its label). When THAT is also
          // unset, default to white so dark backgrounds stay readable.
          const def = show.label!
          // Stable per-show layer identifier for the trace recorder
          // (FrameTrace.labels[i].layerName). Prefer the DSL layer
          // name; fall back to the source layer for legacy syntax
          // and the source name for inline / unfiltered shows. Used
          // by parity diagnostics + invariants to group labels by
          // their origin layer (`label_country_2`, `poi_r1`, …).
          const labelLayerName = show.layerName ?? show.sourceLayer ?? show.targetName ?? ''
          const z = this.camera.zoom
          const elapsedMs = performance.now()
          // Per-frame label paint resolution flows through the unified
          // LabelShapes bundle (Plan Label L2). Same resolvers
          // (`resolveNumberShape` / `resolveColorShape`) the paint side
          // uses — keeps the value-derivation path consistent and lets
          // a new dependency form (e.g. time-interpolated text-size)
          // land in one place. Per-feature `sizeExpr` / `colorExpr` are
          // expressed as `kind: 'data-driven'` shapes (see
          // `applyFeatureExprs` below) — the resolver returns the
          // layer-level fallback (1 for numbers, null for colour),
          // which we override with the static defaults here.
          const shapes = def.shapes
          // text-size: constant / zoom-interpolated paths resolve to a
          // concrete number; data-driven needs the per-feature eval
          // path, so we treat its placeholder as the static `def.size`.
          const resolvedSize = shapes && shapes.size.kind !== 'data-driven'
            ? resolveNumberShape(shapes.size, z, elapsedMs).value
            : def.size
          // text-color: null shape → fall back to the layer fill hex.
          // data-driven goes through applyFeatureExprs.
          let resolvedColor: [number, number, number, number] | undefined
          if (shapes && shapes.color !== null && shapes.color.kind !== 'data-driven') {
            const c = resolveColorShape(shapes.color, z, elapsedMs)
            if (c !== null) resolvedColor = c.value as [number, number, number, number]
            else if (shapes.color.kind === 'constant') resolvedColor = shapes.color.value as [number, number, number, number]
          }
          if (resolvedColor === undefined) {
            resolvedColor = hexToRgba(show.fill) ?? [1, 1, 1, 1]
          }
          // text-halo: width + colour resolve independently. When the
          // shape is null the halo axis was never authored; reuse the
          // legacy `def.halo` object as the static fallback so a halo
          // declared without zoom-stops still applies.
          let resolvedHalo = def.halo
          if (shapes?.haloWidth && shapes.haloWidth.kind !== 'data-driven') {
            const w = resolveNumberShape(shapes.haloWidth, z, elapsedMs).value
            // Mapbox spec default for text-halo-color is rgba(0,0,0,0)
            // (transparent). Matches lower.ts halo merging — keeps the
            // fallback symmetric so a haloWidth-only authored style
            // doesn't paint an opaque black outline. Prior [0,0,0,1]
            // re-introduced the opaque-black-halo bug class on the
            // runtime side.
            resolvedHalo = {
              ...(resolvedHalo ?? { color: [0, 0, 0, 0], width: 0 }),
              width: w,
            }
          }
          if (shapes?.haloColor && shapes.haloColor.kind !== 'data-driven') {
            const c = resolveColorShape(shapes.haloColor, z, elapsedMs)
            const cv = c !== null
              ? c.value as [number, number, number, number]
              : (shapes.haloColor.kind === 'constant'
                ? shapes.haloColor.value as [number, number, number, number]
                : undefined)
            if (cv !== undefined) {
              resolvedHalo = {
                ...(resolvedHalo ?? { color: cv, width: 0 }),
                color: cv,
              }
            }
          }
          if (shapes?.haloBlur && shapes.haloBlur.kind !== 'data-driven') {
            const b = resolveNumberShape(shapes.haloBlur, z, elapsedMs).value
            resolvedHalo = {
              ...(resolvedHalo ?? { color: [0, 0, 0, 0], width: 0 }),
              blur: b,
            }
          }
          // Font resolution: family stack / weight / style are three
          // independent PropertyShapes resolved through the shared
          // shape helpers — `resolveNumberShape` for the numeric
          // weight axis, `resolveSteppedShape` for the array / enum
          // axes (font stack / style don't interpolate; they step at
          // the last zoom stop <= camera zoom). Source-format-specific
          // font-name parsing stays in the converter, not the runtime.
          let resolvedFont = def.font
          let resolvedFontWeight = def.fontWeight
          let resolvedFontStyle = def.fontStyle
          if (shapes?.font && shapes.font.kind !== 'data-driven') {
            const stack = resolveSteppedShape(shapes.font, z)
            if (stack !== null && stack.length > 0) resolvedFont = [...stack]
          }
          if (shapes?.fontWeight && shapes.fontWeight.kind !== 'data-driven') {
            resolvedFontWeight = resolveNumberShape(shapes.fontWeight, z, elapsedMs).value
          }
          if (shapes?.fontStyle && shapes.fontStyle.kind !== 'data-driven') {
            const v = resolveSteppedShape(shapes.fontStyle, z)
            if (v !== null) resolvedFontStyle = v
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
            ...(resolvedFont !== undefined ? { font: resolvedFont } : {}),
            ...(resolvedFontWeight !== undefined ? { fontWeight: resolvedFontWeight } : {}),
            ...(resolvedFontStyle !== undefined ? { fontStyle: resolvedFontStyle } : {}),
            ...(bearingDeg !== 0
              ? { rotate: (def.rotate ?? 0) + bearingDeg } : {}),
          }

          // Per-feature evaluator for data-driven text-size /
          // text-color (Mapbox `["case", …]` / `["match", …]` /
          // arithmetic forms). Wraps a feature's def with overrides
          // resolved from the data-driven PropertyShapes against
          // that feature's properties. Pulls AST from
          // `def.shapes.size.expr` / `def.shapes.color.expr` — the
          // LabelShapes bundle is the single source of truth post-L2.
          const sizeExprAst = shapes && shapes.size.kind === 'data-driven'
            ? shapes.size.expr.ast : null
          const colorExprAst = shapes && shapes.color !== null && shapes.color.kind === 'data-driven'
            ? shapes.color.expr.ast : null
          const cameraZoom = this.camera.zoom
          const applyFeatureExprs = (props: Record<string, unknown>) => {
            if (sizeExprAst === null && colorExprAst === null) return effectiveDef
            // makeEvalProps injects the reserved `$zoom` key so label
            // text-size / text-color expressions referencing
            // `interpolate(zoom, …)` resolve to the current camera
            // zoom rather than undefined (which evaluate() folds to
            // null → number coercion 0 → label size = 0 / label
            // colour collapses to default). Mirrors the
            // extractFeatureWidths reserved-key contract.
            const bag = makeEvalProps({ props, cameraZoom })
            const out = { ...effectiveDef }
            if (sizeExprAst !== null) {
              try {
                const v = evaluate(sizeExprAst as never, bag)
                if (typeof v === 'number' && isFinite(v)) out.size = v
              } catch { /* fall back to effectiveDef.size */ }
            }
            if (colorExprAst !== null) {
              try {
                const v = evaluate(colorExprAst as never, bag)
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
                  undefined, labelLayerName,
                )
                dispatchIcon(featDef, projected[0], projected[1])
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
            // Mirrors show-source-maps.ts `effectiveLayer`: fall back to
            // `targetName` when `sourceLayer` is empty (inline GeoJSON).
            // Worker emits slices keyed under the source name, so without
            // this fallback every label show on an inline GeoJSON source
            // looked up the wrong sliceKey and silently iterated zero
            // tiles (same class as filter_gdp emerald/yellow).
            const sliceKey = computeSliceKey(
              show.sourceLayer || show.targetName || '',
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
                    undefined, labelLayerName,
                  )
                } else {
                  // Viewport-aligned: just place at the line position
                  // with the def's static rotate (typically 0).
                  stage.addLabel(
                    featDef.text, props,
                    x, y, featDef,
                    undefined, labelLayerName,
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
                //
                // Cross-tile dedupe: cap line labels at ONE emission
                // per unique road name per ShowCommand pass. PMTiles
                // slices a single road into separate featId per tile,
                // so the same road name emits as N independent
                // polylines across N visible tiles — at z=17 a
                // one-screen-wide road crossing 5 tile boundaries
                // would stamp its name 5× along itself. MapLibre's
                // collision system collapses these via bbox overlap,
                // but X-GIS's line-label bboxes are narrow strips
                // along the road tangent and adjacent tile segments
                // don't overlap enough to trigger the collision drop.
                // Hard-cap here matches the reference output.
                const emittedTextNames = new Set<string>()
                const isTooCloseToSameText = (resolvedText: string, _sx: number, _sy: number): boolean => {
                  return emittedTextNames.has(resolvedText)
                }
                const recordTextPosition = (resolvedText: string, _sx: number, _sy: number): void => {
                  emittedTextNames.add(resolvedText)
                }
                const SUBDIVS_PER_SEG = 16
                // Polyline projection scratch — sized once per show, big
                // enough to hold the worst-case sample count across any
                // polyline encountered in this layer. Each callback
                // writes into the head and uses a per-call `count` so we
                // never have to clear. `new Float32Array(px)` inside the
                // callback was the dominant GC source on z=12 Korea
                // (`forEachLineLabelPolyline.prepare` ~30 ms with visible
                // GC sweeps in profile); reusing one buffer per layer
                // collapses that to near-zero.
                let _pxScratch = new Float32Array(0)
                let _pyScratch = new Float32Array(0)
                // Static return holder for samplePosAt — closure used to
                // return `{ x, y }` on every call, which fired in the
                // hot loop below per spacing point.
                const _samplePosOut: [number, number] = [0, 0]
                vtEntry.renderer.forEachLineLabelPolyline(sliceKey, (mxs, mys, props) => {
                  if (mxs.length < 2) return
                  // Project every vertex to physical-pixel screen
                  // space; pack into typed arrays for the curved-text
                  // sampler. Drop unprojectable vertices by trimming
                  // to the first contiguous projectable run.
                  //
                  // Subdivide each segment so a world-spanning line
                  // (e.g. demotiles geolines: Tropic of Cancer with 2
                  // vertices at lng=±180) gets enough sample points
                  // for the on-screen portion to project successfully.
                  // Without this, both raw endpoints land outside the
                  // NDC ±1.5 window and `projectLonLat` rejects them,
                  // leaving px.length === 0 and the label silently
                  // dropping. Sample density (16 cuts per segment) is
                  // sufficient for the labelling pass — the actual
                  // line geometry is rendered separately by the line
                  // renderer which handles its own viewport clipping.
                  const N = mxs.length
                  // Upper-bound sample count for this polyline. First
                  // segment emits SUBDIVS_PER_SEG+1 samples (including
                  // both endpoints), every later segment emits
                  // SUBDIVS_PER_SEG samples (start vertex skipped to
                  // avoid duplicating the previous segment's end).
                  // Total = SUBDIVS_PER_SEG * N - (N - 2). projectMerc
                  // rejections only shorten this — they never grow it.
                  const upper = SUBDIVS_PER_SEG * N + 1
                  if (_pxScratch.length < upper) {
                    _pxScratch = new Float32Array(upper * 2)  // 2× to amortise growth
                    _pyScratch = new Float32Array(upper * 2)
                  }
                  let pn = 0  // active sample count
                  for (let i = 0; i < N - 1; i++) {
                    const ax = mxs[i]!, ay = mys[i]!
                    const bx = mxs[i + 1]!, by = mys[i + 1]!
                    const steps = i === 0 ? SUBDIVS_PER_SEG : SUBDIVS_PER_SEG - 1
                    const startT = i === 0 ? 0 : 1 / SUBDIVS_PER_SEG
                    for (let s = 0; s <= steps; s++) {
                      const t = startT + s * (1 - startT) / steps
                      const sx = ax + (bx - ax) * t
                      const sy = ay + (by - ay) * t
                      // Direct merc → screen projection. Skips the
                      // mercToLonLat + lonLatToMercator round-trip that
                      // accounted for ~80 % of forEachLineLabelPolyline's
                      // frame time pre-optimisation (OFM Bright z=13).
                      const proj = projectMercAny(sx, sy)
                      if (proj) {
                        _pxScratch[pn] = proj[0]
                        _pyScratch[pn] = proj[1]
                        pn++
                      }
                    }
                  }
                  if (pn < 2) return
                  let total = 0
                  for (let i = 0; i < pn - 1; i++) {
                    const dx = _pxScratch[i + 1]! - _pxScratch[i]!
                    const dy = _pyScratch[i + 1]! - _pyScratch[i]!
                    total += Math.sqrt(dx * dx + dy * dy)
                  }
                  const featDef = applyFeatureExprs(props)
                  // Cross-tile dedupe key. resolveText() varies across
                  // road segments when one segment carries
                  // `name:nonlatin` and the next doesn't — the concat
                  // expression returns different strings even though
                  // the road is the same. Prefer the most stable name
                  // field (`name` → `name_en` → resolved fallback) so
                  // the dedupe matches across heterogeneous segments.
                  const propsRec = props as Record<string, unknown>
                  const stableName = typeof propsRec.name === 'string' ? propsRec.name
                    : typeof propsRec.name_en === 'string' ? propsRec.name_en
                    : resolveText(featDef.text, props, this.camera.zoom)
                  const resolvedTextForDedupe = stableName
                  // Walk the polyline and compute the screen-pixel
                  // position for an offset s along it. Used by the
                  // cross-tile dedupe to evaluate "is this position
                  // too close to one already labelled with the same
                  // text?" without re-running the full glyph layout.
                  // Returns true into `_samplePosOut` (shared) or false.
                  const samplePosAt = (s: number): boolean => {
                    let acc = 0
                    for (let i = 0; i < pn - 1; i++) {
                      const dx = _pxScratch[i + 1]! - _pxScratch[i]!
                      const dy = _pyScratch[i + 1]! - _pyScratch[i]!
                      const segLen = Math.sqrt(dx * dx + dy * dy)
                      if (acc + segLen >= s) {
                        const t = segLen > 0 ? (s - acc) / segLen : 0
                        _samplePosOut[0] = _pxScratch[i]! + dx * t
                        _samplePosOut[1] = _pyScratch[i]! + dy * t
                        return true
                      }
                      acc += segLen
                    }
                    return false
                  }
                  if (useTangentRotation) {
                    // Curved-text path: pack the projected polyline
                    // and ask TextStage to lay each glyph along it.
                    // Slice to the actual count — TextStage stores the
                    // view, so we have to hand it a fresh typed array
                    // that survives past the next callback iteration
                    // (the shared scratch gets overwritten).
                    const polyX = _pxScratch.slice(0, pn)
                    const polyY = _pyScratch.slice(0, pn)
                    // No fontKey override — see note at line ~2370.
                    if (total < spacingPx * 0.5) {
                      if (samplePosAt(total * 0.5)) {
                        const sx = _samplePosOut[0], sy = _samplePosOut[1]
                        if (!isTooCloseToSameText(resolvedTextForDedupe, sx, sy)) {
                          stage.addCurvedLineLabel(
                            featDef.text, props,
                            polyX, polyY, total * 0.5,
                            featDef,
                            undefined, labelLayerName,
                          )
                          recordTextPosition(resolvedTextForDedupe, sx, sy)
                        }
                      }
                      return
                    }
                    let nextStop = spacingPx * 0.5
                    while (nextStop <= total) {
                      if (samplePosAt(nextStop)) {
                        const sx = _samplePosOut[0], sy = _samplePosOut[1]
                        if (!isTooCloseToSameText(resolvedTextForDedupe, sx, sy)) {
                          stage.addCurvedLineLabel(
                            featDef.text, props,
                            polyX, polyY, nextStop,
                            featDef,
                            undefined, labelLayerName,
                          )
                          recordTextPosition(resolvedTextForDedupe, sx, sy)
                        }
                      }
                      nextStop += spacingPx
                    }
                    return
                  }
                  // Viewport-aligned path: keep the historical single-
                  // rotation emission per spacing point.
                  if (total < spacingPx * 0.5) {
                    let acc = 0
                    const target = total * 0.5
                    for (let i = 0; i < pn - 1; i++) {
                      const dx = _pxScratch[i + 1]! - _pxScratch[i]!
                      const dy = _pyScratch[i + 1]! - _pyScratch[i]!
                      const segLen = Math.sqrt(dx * dx + dy * dy)
                      if (acc + segLen >= target) {
                        const t = segLen > 0 ? (target - acc) / segLen : 0
                        emitLabelAlongSegment(_pxScratch[i]!, _pyScratch[i]!, _pxScratch[i + 1]!, _pyScratch[i + 1]!, t, props)
                        return
                      }
                      acc += segLen
                    }
                    return
                  }
                  let nextStop = spacingPx * 0.5
                  let acc = 0
                  for (let i = 0; i < pn - 1; i++) {
                    const dx = _pxScratch[i + 1]! - _pxScratch[i]!
                    const dy = _pyScratch[i + 1]! - _pyScratch[i]!
                    const segLen = Math.sqrt(dx * dx + dy * dy)
                    while (nextStop <= acc + segLen && nextStop <= total) {
                      const t = segLen > 0 ? (nextStop - acc) / segLen : 0
                      emitLabelAlongSegment(_pxScratch[i]!, _pyScratch[i]!, _pxScratch[i + 1]!, _pyScratch[i + 1]!, t, props)
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
              // Cross-tile point-label dedupe: large named polygon
              // features (countries, oceans) cross tile boundaries
              // at low zoom and the worker emits a centroid PER tile
              // for the polygon's tile-clipped sub-shape. Without
              // dedupe the same name appears 2-3× across adjacent
              // tiles. Mirror the line-label dedupe (Set keyed by
              // stable name) to keep one emission per ShowCommand.
              const emittedPointNames = new Set<string>()
              vtEntry.renderer.forEachLabelFeature(sliceKey, (mercX, mercY, props) => {
                const propsRec = props as Record<string, unknown>
                const stableName = typeof propsRec.name === 'string' ? propsRec.name
                  : typeof propsRec.name_en === 'string' ? propsRec.name_en
                  : ''
                if (stableName !== '' && emittedPointNames.has(stableName)) return
                if (stableName !== '') emittedPointNames.add(stableName)
                const featDef = applyFeatureExprs(props)
                // No fontKey override — see note at line ~2370.
                // World-copy loop on MERCATOR coords directly — skips
                // the merc → lonLat → merc round-trip the previous
                // path did (one allocation + two trig stacks per call).
                // Mirror of `projectLonLatCopies` for non-mercator
                // projections is still needed because those reproject
                // through lonLat space; we handle that here inline.
                if (this.projectionName !== 'mercator') {
                  const [lon, lat] = mercToLonLat(mercX, mercY)
                  for (const projected of projectLonLatCopies(lon, lat)) {
                    stage.addLabel(
                      featDef.text, props,
                      projected[0], projected[1], featDef,
                      undefined, labelLayerName,
                    )
                    dispatchIcon(featDef, projected[0], projected[1])
                  }
                  return
                }
                // Mercator world-copy iteration: try offset 0, ±1, ±2
                // (same order projectLonLatCopies uses) directly on
                // merc coords. First copy that projects within the
                // NDC window wins.
                for (const wo of [0, -1, 1, -2, 2]) {
                  const proj = projectMerc(mercX, mercY, wo * WORLD_MERC)
                  if (!proj) continue
                  stage.addLabel(
                    featDef.text, props,
                    proj[0], proj[1], featDef,
                    undefined, labelLayerName,
                  )
                  dispatchIcon(featDef, proj[0], proj[1])
                  break
                }
              })
            }
          }
        }

        stage.prepare()
        iStage?.prepare()
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
            // Icons render BEFORE text so labels read on top of their
            // POI badges — matches MapLibre's symbol-stage ordering.
            iStage?.render(tPass, { width: w, height: h })
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
        layer.style.fill = value as string | null
        return true
      case 'line-color':
        if (typeof value !== 'string' && value !== null) return false
        layer.style.stroke = value as string | null
        return true
      case 'fill-opacity':
      case 'line-opacity':
      case 'opacity':
        if (typeof value !== 'number') return false
        layer.style.opacity = value
        return true
      case 'line-width':
        if (typeof value !== 'number') return false
        layer.style.strokeWidth = value
        return true
      case 'visibility':
        // Mapbox-style: 'visible' | 'none'. Coerce to boolean for the
        // XGISLayerStyle setter; reject other strings.
        if (value !== 'visible' && value !== 'none') return false
        layer.style.visible = value === 'visible'
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
