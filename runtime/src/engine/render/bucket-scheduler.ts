// ═══ Vector tile bucket scheduler ═══
//
// Pure, testable classifier that turns a frame's `vectorTileShows`
// into two ordered buckets:
//
//   - opaque        — every show, in declaration order. Translucent-
//                     stroke shows appear here too with `fillPhase:
//                     'fills'` so their fill half draws into the
//                     opaque bucket; their stroke half is in the
//                     translucent bucket below.
//   - translucent   — only the translucent-stroke shows, with
//                     `fillPhase: 'fills'` (the bucket scheduler
//                     emits the offscreen 'strokes' draw separately).
//
// Side effects: NONE. The classifier reads inputs and returns a
// ClassifiedShow[] pair. Animation IR (zoom-opacity / time-* stops)
// is resolved here so downstream renderers see a plain static show.
//
// Why a separate module: PR 2 (bucket scheduler refactor) and PR 3
// (animation lifecycle) both shipped silent classification bugs that
// the smoke test couldn't catch. Extracting the classifier into a
// pure function lets `bucket-scheduler.test.ts` exercise every
// fixture combination without spinning up the full WebGPU stack.

import type { Camera } from '../projection/camera'
import type { LayerDrawPhase } from './vector-tile-renderer'
import type { SceneCommands } from '@xgis/compiler'
import { resolveNumberShape } from './paint-shape-resolve'
import { resolveShow, type ResolvedShow } from './resolved-show'
import { SAFE_MODE } from '../gpu/gpu'
import type { RenderTraceRecorder, RGBA } from '../../diagnostics/render-trace'

// ── Output: post-classification show with all animation resolved ──

/** A vector-tile show after zoom-opacity resolution and bucket
 *  classification. Produced by `classifyVectorTileShows()` once per
 *  frame and consumed by the bucket scheduler.
 *
 *  The opaque/translucent split: a layer with a translucent stroke
 *  (opacity < 0.999 and a stroke color set) appears in BOTH buckets:
 *    - opaque bucket with `fillPhase='fills'` — the fill half
 *      draws into the main opaque sub-pass
 *    - translucent bucket — the stroke half draws to an offscreen
 *      RT with MAX blending, then composites back at the layer's
 *      opacity
 *
 *  A pure-opaque layer appears only in the opaque bucket with
 *  `fillPhase='all'`. A near-invisible layer (opacity < 0.005) is
 *  dropped entirely. */
export interface ClassifiedShow {
  sourceName: string
  vtEntry: ClassifierVTSource
  show: SceneCommands['shows'][0]
  /** Per-frame snapshot of the show's paint state with every
   *  zoom-stop / time-stop / shape kind already collapsed to a
   *  scalar / RGBA. New consumers should read paint properties
   *  from `resolvedShow` instead of `show.opacity` / `show.fill`
   *  — the latter still works for backwards compatibility but
   *  carries the legacy mutable-clone semantics.
   *
   *  Phase 4c-final: the SOLE per-frame paint-state carrier. The
   *  classifier no longer mutates a ShowCommand clone; `show` on
   *  ClassifiedShow is the original immutable source. Every
   *  downstream consumer (VTR.render, line composite, point labels)
   *  reads paint values from THIS field. */
  resolvedShow: ResolvedShow
  fp: GPURenderPipeline
  lp: GPURenderPipeline
  bgl: GPUBindGroupLayout
  fpF?: GPURenderPipeline
  lpF?: GPURenderPipeline
  // Depth-disabled (`STENCIL_WRITE_NO_DEPTH`) ground variants for
  // `extrude.kind === 'none'` layers. Match `bgl` — i.e. they share
  // the layout of `fp`/`fpF`. The renderer's unconditional ground
  // pipelines (`fillPipelineGround` / `fillPipelineGroundFallback`)
  // can only substitute when bgl === baseBindGroupLayout; for
  // variant-driven (feature-buffer) shows we need a feature-layout
  // ground pipeline, which is what these fields carry.
  fpG?: GPURenderPipeline
  fpGF?: GPURenderPipeline
  isTranslucentStroke: boolean
  fillPhase: LayerDrawPhase
}

// ── Input contract ──
//
// Defined as minimal interfaces (not the concrete runtime types) so
// tests can construct stub fixtures without instantiating a full
// MapRenderer / VectorTileRenderer / GPU device.

/** Minimal contract the classifier needs from a vector-tile source
 *  entry. Real callers pass `{ source: XGVTSource, renderer:
 *  VectorTileRenderer }` — only `renderer.hasData()` is actually
 *  called, the rest is plumbed through to the output. */
export interface ClassifierVTSource {
  source: unknown
  renderer: { hasData(): boolean } & Record<string, unknown>
}

/** Per-show entry as stored on `XGISMap.vectorTileShows`. The classifier
 *  reads `show`, `pipelines` (when set), and `layout` (when set);
 *  `sourceName` is the lookup key into `vtSources`. */
export interface ClassifierShowEntry {
  sourceName: string
  show: SceneCommands['shows'][0]
  pipelines: ClassifierVariantPipelines | null
  layout: GPUBindGroupLayout | null
}

/** Per-show shader variant pipelines (when a layer needed a custom
 *  WGSL specialization). Mirrors the runtime VariantPipelines shape
 *  but is stub-friendly. The `*NoPick` mirrors are the writeMask:0
 *  pick-attachment variants used when `show.pointerEvents === 'none'`;
 *  callers may omit them (the classifier falls back to the pickable
 *  pipeline + a console warning). */
export interface ClassifierVariantPipelines {
  fillPipeline: GPURenderPipeline
  fillPipelineGround?: GPURenderPipeline
  linePipeline: GPURenderPipeline
  fillPipelineFallback?: GPURenderPipeline
  fillPipelineGroundFallback?: GPURenderPipeline
  linePipelineFallback?: GPURenderPipeline
  fillPipelineNoPick?: GPURenderPipeline
  fillPipelineGroundNoPick?: GPURenderPipeline
  linePipelineNoPick?: GPURenderPipeline
  fillPipelineFallbackNoPick?: GPURenderPipeline
  fillPipelineGroundFallbackNoPick?: GPURenderPipeline
  linePipelineFallbackNoPick?: GPURenderPipeline
}

/** The default GPU resources shared across every layer. Pulled off
 *  `MapRenderer` in production; tests construct stubs. The `*NoPick`
 *  mirrors carry the writeMask:0 pick-attachment variants for
 *  `pointer-events: none` layers — when picking is globally off they
 *  alias the pickable pipelines. */
export interface ClassifierRendererDefaults {
  fillPipeline: GPURenderPipeline
  fillPipelineGround?: GPURenderPipeline
  linePipeline: GPURenderPipeline
  bindGroupLayout: GPUBindGroupLayout
  fillPipelineFallback?: GPURenderPipeline
  fillPipelineGroundFallback?: GPURenderPipeline
  linePipelineFallback?: GPURenderPipeline
  fillPipelineNoPick?: GPURenderPipeline
  fillPipelineGroundNoPick?: GPURenderPipeline
  linePipelineNoPick?: GPURenderPipeline
  fillPipelineFallbackNoPick?: GPURenderPipeline
  fillPipelineGroundFallbackNoPick?: GPURenderPipeline
  linePipelineFallbackNoPick?: GPURenderPipeline
}

/** Full input bundle. Keeping it a single param object means callers
 *  don't have to remember positional argument order, and adding a
 *  new field (e.g. a future `safeMode` override) is non-breaking. */
export interface ClassifierInput {
  vectorTileShows: ClassifierShowEntry[]
  vtSources: Map<string, ClassifierVTSource>
  cameraZoom: number
  elapsedMs: number
  rendererDefaults: ClassifierRendererDefaults
  /** Optional override for SAFE_MODE — defaults to the env constant.
   *  Tests use this to flip translucent-stroke detection on/off
   *  without touching the global. */
  safeMode?: boolean
  /** Optional render-trace recorder. When non-null, the classifier
   *  pushes one `TraceLayer` per visible layer with its fully-
   *  resolved paint state. Production code path leaves this null —
   *  V8 branch-predicts the null check away, zero hot-loop cost.
   *  Recorder hooks land here (not in VTR.render) because this is
   *  the single choke point where every paint property's final
   *  zoom × time-interpolated value is known. */
  traceRecorder?: RenderTraceRecorder | null
}

export interface ClassifierResult {
  opaque: ClassifiedShow[]
  translucent: ClassifiedShow[]
  /** Translucent extruded fills routed through Weighted-Blended OIT
   *  (`fillPipelineExtrudedOIT` + accum/revealage RTs + compose).
   *  The same show may also appear in `opaque` (for its strokes /
   *  outlines via the regular line pipeline) and `translucent` (for
   *  translucent strokes) — the buckets describe rendering phases,
   *  not show identity. */
  oit: ClassifiedShow[]
}

/** Classify a frame's vector tile shows into opaque + translucent
 *  buckets, resolving every time-interpolated animation property
 *  along the way. See {@link ClassifiedShow} for the bucket
 *  semantics.
 *
 *  This function is pure: same inputs → same outputs, no I/O, no
 *  side effects on the input objects. The returned `effectiveShow`
 *  is a shallow clone whenever any animation-resolved field needs
 *  to override the base show; otherwise the original show object
 *  is reused (zero-allocation hot path for static layers). */
export function classifyVectorTileShows(input: ClassifierInput): ClassifierResult {
  const opaque: ClassifiedShow[] = []
  const translucent: ClassifiedShow[] = []
  const oit: ClassifiedShow[] = []
  const safeMode = input.safeMode ?? SAFE_MODE
  const defaults = input.rendererDefaults

  for (const entry of input.vectorTileShows) {
    const vtEntry = input.vtSources.get(entry.sourceName)
    if (!vtEntry || !vtEntry.renderer.hasData()) continue

    // Explicit author / imperative-API hide. The
    // `XGISLayerStyle.visible = false` setter flips this flag; the
    // classifier must respect it (parallel to the minzoom/maxzoom
    // gate below). Previously the WebGPU draw path ignored
    // `show.visible`, only the canvas-fallback renderer checked it,
    // so toggling visibility was silently no-op for typical users.
    if (entry.show.visible === false) continue

    // Mapbox `layer.minzoom` / `layer.maxzoom` — gate per-frame so
    // shows declared for a narrow zoom band (e.g. building extrusions
    // at z≥14, country boundaries at z=0..5) only draw inside that
    // band. Without this the user sees layers piling onto every zoom:
    // country labels under city labels at z=12, suburb fills painting
    // over road casings at z=15. Mapbox's spec uses `>= minzoom` and
    // `< maxzoom` (exclusive upper bound), so camera.zoom == maxzoom
    // hides the layer.
    if (entry.show.minzoom !== undefined && input.cameraZoom < entry.show.minzoom) continue
    if (entry.show.maxzoom !== undefined && input.cameraZoom >= entry.show.maxzoom) continue

    // Per-frame paint resolution. Every animation/zoom-driven paint
    // property is evaluated HERE so downstream renderers
    // (VectorTileRenderer, LineRenderer, PointRenderer, the text
    // stage's composite step) read plain scalar / RGBA fields. Each
    // property follows the same precedence:
    //
    //   resolved = time-interpolated  if timeXxxStops set
    //            else zoom-interpolated if zoomXxxStops set
    //            else show.<scalar>
    //
    // Opacity is the only field that COMPOSES zoom × time (a layer
    // can pulse via time while ramping in via zoom — common for
    // "fade in at z=12 then breathe" animations). All others let
    // time override zoom outright.
    //
    // Single choke point means: adding a new zoom-driven paint
    // property only touches THIS function. The previous
    // architecture re-evaluated zoom*Stops in 4-5 callsites; a
    // missing branch (composite step forgot to evaluate
    // zoomOpacityStops) silently lost the ramp on the demotiles
    // countries-boundary border — the kind of bug centralisation
    // prevents.
    // Opacity (zoom × time, composed) is the only paint value the
    // classifier needs INLINE, because it drives bucket placement
    // (translucent threshold + OIT routing). Everything else lives
    // on the resolvedShow snapshot below — single source of truth,
    // no parallel `resolvedXxx` locals to keep in sync.
    const composedOpa = resolveNumberShape(
      entry.show.paintShapes.opacity, input.cameraZoom, input.elapsedMs,
    ).value

    // Phase 4c-final: no more effectiveShow clone + mutation. The
    // per-frame resolved scalars / RGBA live on `resolvedShow` below;
    // consumers (VectorTileRenderer.render, line composite, point
    // labels) read from THERE. `show` stays the immutable source
    // ShowCommand. Visibility, pipeline, pointer-events decisions
    // still come from the static show — they're not zoom/time-driven.
    if (composedOpa < 0.005) continue

    const isTranslucentStroke =
      !safeMode && composedOpa < 0.999 && !!entry.show.stroke
    // Translucent extruded fills route through Weighted-Blended OIT.
    const isOitExtrude =
      !safeMode && composedOpa < 0.999
      && entry.show.extrude !== undefined
      && entry.show.extrude.kind !== 'none'
    const noPick = entry.show.pointerEvents === 'none'
    const fp = noPick
      ? (entry.pipelines?.fillPipelineNoPick ?? defaults.fillPipelineNoPick ?? entry.pipelines?.fillPipeline ?? defaults.fillPipeline)
      : (entry.pipelines?.fillPipeline ?? defaults.fillPipeline)
    const lp = noPick
      ? (entry.pipelines?.linePipelineNoPick ?? defaults.linePipelineNoPick ?? entry.pipelines?.linePipeline ?? defaults.linePipeline)
      : (entry.pipelines?.linePipeline ?? defaults.linePipeline)
    const bgl = entry.layout ?? defaults.bindGroupLayout
    const fpF = noPick
      ? (entry.pipelines?.fillPipelineFallbackNoPick ?? defaults.fillPipelineFallbackNoPick ?? entry.pipelines?.fillPipelineFallback ?? defaults.fillPipelineFallback)
      : (entry.pipelines?.fillPipelineFallback ?? defaults.fillPipelineFallback)
    const lpF = noPick
      ? (entry.pipelines?.linePipelineFallbackNoPick ?? defaults.linePipelineFallbackNoPick ?? entry.pipelines?.linePipelineFallback ?? defaults.linePipelineFallback)
      : (entry.pipelines?.linePipelineFallback ?? defaults.linePipelineFallback)
    // Ground (depth-disabled) variants. Prefer a per-show variant
    // ground pipeline when the show carries one (matches `fp`'s
    // bind-group layout). Otherwise fall back to the renderer-level
    // default ground pipelines (built with the base layout). VTR
    // picks them at draw time only when bgl matches the pipeline's
    // expected layout — so when bgl is the feature layout but only
    // the base-layout default ground exists, the substitution is
    // skipped (and the depth-write fp is used). That preserves
    // bind-group correctness; the painter's-order optimisation just
    // doesn't apply to that show.
    const fpG = noPick
      ? (entry.pipelines?.fillPipelineGroundNoPick ?? defaults.fillPipelineGroundNoPick ?? entry.pipelines?.fillPipelineGround ?? defaults.fillPipelineGround)
      : (entry.pipelines?.fillPipelineGround ?? defaults.fillPipelineGround)
    const fpGF = noPick
      ? (entry.pipelines?.fillPipelineGroundFallbackNoPick ?? defaults.fillPipelineGroundFallbackNoPick ?? entry.pipelines?.fillPipelineGroundFallback ?? defaults.fillPipelineGroundFallback)
      : (entry.pipelines?.fillPipelineGroundFallback ?? defaults.fillPipelineGroundFallback)
    // Opaque-bucket fillPhase decision:
    //  * isOitExtrude && isTranslucentStroke → SKIP opaque entirely
    //    (fills handled by OIT, strokes by translucent offscreen)
    //  * isOitExtrude only → 'strokes' (fills to OIT; outlines, if
    //    any, go through the regular opaque line pipeline — they're
    //    fully opaque even when the fill is translucent)
    //  * isTranslucentStroke only → 'fills' (fills opaque; strokes
    //    to translucent offscreen MAX-blend)
    //  * neither → 'all' (pure opaque)
    const skipOpaque = isOitExtrude && isTranslucentStroke
    const fillPhase: LayerDrawPhase = skipOpaque
      ? 'fills' // sentinel — entry isn't pushed to opaque
      : isOitExtrude
        ? 'strokes'
        : isTranslucentStroke
          ? 'fills'
          : 'all'
    // Phase 4c-final: ResolvedShow snapshot is the SOLE per-frame
    // paint-state carrier. The classifier no longer clones / mutates
    // a ShowCommand; `show` on ClassifiedShow is the original
    // immutable source. All downstream consumers read the resolved
    // scalars / RGBA from resolvedShow.
    const resolvedShow = resolveShow(entry.show, {
      cameraZoom: input.cameraZoom, elapsedMs: input.elapsedMs,
    })
    const classified: ClassifiedShow = {
      sourceName: entry.sourceName,
      vtEntry,
      show: entry.show,
      resolvedShow,
      fp, lp, bgl, fpF, lpF, fpG, fpGF,
      isTranslucentStroke,
      fillPhase,
    }
    if (!skipOpaque) opaque.push(classified)
    if (isTranslucentStroke) translucent.push(classified)
    if (isOitExtrude) oit.push(classified)

    // Render-trace recorder hook. Pushes one TraceLayer per visible
    // layer with its fully zoom × time-resolved paint state. Branch
    // is predicted away when recorder is null (production path).
    if (input.traceRecorder !== null && input.traceRecorder !== undefined) {
      const layerName = resolvedShow.layerName
      input.traceRecorder.recordLayer({
        layerName,
        fillPhase,
        resolvedOpacity: resolvedShow.opacity,
        resolvedStrokeWidth: resolvedShow.strokeWidth,
        resolvedFill: resolvedShow.fill as RGBA | undefined,
        resolvedStroke: resolvedShow.stroke as RGBA | undefined,
      })
    }
  }

  return { opaque, translucent, oit }
}

/** Group consecutive same-source opaque shows into runs so each
 *  source gets a single render pass with one stencil clear.
 *  Preserves declaration order — a later show with the same
 *  sourceName that's split by an intervening different source
 *  opens a NEW group (the stencil ring state isn't compatible
 *  across sources). */
export interface OpaqueGroup {
  sourceName: string
  shows: ClassifiedShow[]
}

export function groupOpaqueBySource(opaque: ClassifiedShow[]): OpaqueGroup[] {
  const groups: OpaqueGroup[] = []
  for (const show of opaque) {
    const last = groups[groups.length - 1]
    if (last && last.sourceName === show.sourceName) {
      last.shows.push(show)
    } else {
      groups.push({ sourceName: show.sourceName, shows: [show] })
    }
  }
  return groups
}

/** Pre-frame scheduling plan: which buckets actually run, and which
 *  pass owns the MSAA resolveTarget. Computed once per frame from
 *  the classifier output + a few external flags. Pulling this out
 *  of `renderFrame()` makes it independently testable.
 *
 *  This is the structural fix for Bug 2: the previous scheduler
 *  conflated tile-points and direct-layer points under a single
 *  `inlinePoints` flag. The plan now exposes them as separate
 *  fields so a future refactor can't drop one silently. */
export interface ScheduleFlags {
  /** True when the translucent bucket needs to run (offscreen
   *  stroke + composite). Requires at least one translucent-stroke
   *  show AND a working line renderer. */
  hasTranslucent: boolean
  /** True when a dedicated points pass (bucket 3) needs to run for
   *  GeoJSON sources that called `pointRenderer.addLayer()`. Tile
   *  points (xgvt-source point vertices) are handled inline in
   *  bucket 1 via `VTR.render(pointRenderer)`. */
  hasDirectLayerPoints: boolean
  /** Which pass owns the MSAA resolveTarget (always the LAST pass
   *  that writes to the color attachment). */
  resolveOwner: 'opaque' | 'composite' | 'points'
}

export function planFrameSchedule(
  classification: ClassifierResult,
  hasLineRenderer: boolean,
  hasDirectLayerPoints: boolean,
): ScheduleFlags {
  const hasTranslucent = classification.translucent.length > 0 && hasLineRenderer
  const resolveOwner: ScheduleFlags['resolveOwner'] = hasDirectLayerPoints
    ? 'points'
    : hasTranslucent
      ? 'composite'
      : 'opaque'
  return { hasTranslucent, hasDirectLayerPoints, resolveOwner }
}
