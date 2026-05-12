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
import type { PropertyShape } from '@xgis/compiler'
import { interpolateZoom, interpolateZoomRgba, interpolateTime, interpolateTimeColor } from './renderer'
import { SAFE_MODE } from '../gpu/gpu'
import type { RenderTraceRecorder, RGBA } from '../../diagnostics/render-trace'

/** Evaluate a `PropertyShape<number>` (PR Step 1c migration target)
 *  to a per-frame scalar. The five variants map to the renderer's
 *  existing interpolators:
 *
 *    constant            → shape.value
 *    zoom-interpolated   → interpolateZoom(stops, cameraZoom, base)
 *    time-interpolated   → interpolateTime(stops, elapsedMs, …)
 *    zoom-time           → zoomFactor × timeFactor (the spec's
 *                          composition rule for opacity; same shape
 *                          used here so callers don't branch)
 *    data-driven         → 1 (per-feature evaluation happens
 *                          downstream in the worker; the per-layer
 *                          fallback is "no animation")
 *
 *  Returns the resolved scalar plus flags telling the caller whether
 *  zoom and/or time contributed — used by the clone decision so the
 *  hot path (static shows) stays zero-allocation. */
function resolveNumberShape(
  shape: PropertyShape<number>,
  cameraZoom: number,
  elapsedMs: number,
): { value: number; hasZoom: boolean; hasTime: boolean } {
  switch (shape.kind) {
    case 'constant':
      return { value: shape.value, hasZoom: false, hasTime: false }
    case 'zoom-interpolated':
      return {
        value: interpolateZoom(shape.stops, cameraZoom, shape.base ?? 1),
        hasZoom: true, hasTime: false,
      }
    case 'time-interpolated':
      return {
        value: interpolateTime(shape.stops, elapsedMs, shape.loop, shape.easing, shape.delayMs),
        hasZoom: false, hasTime: true,
      }
    case 'zoom-time': {
      const zoomFactor = interpolateZoom(shape.zoomStops, cameraZoom, 1)
      const timeFactor = interpolateTime(
        shape.timeStops, elapsedMs, shape.loop, shape.easing, shape.delayMs,
      )
      return { value: zoomFactor * timeFactor, hasZoom: true, hasTime: true }
    }
    case 'data-driven':
      return { value: 1, hasZoom: false, hasTime: false }
  }
}

/** RGBA companion to {@link resolveNumberShape}. Reuses
 *  interpolateZoomRgba / interpolateTimeColor (the same per-channel
 *  blenders the renderer already calls). For `constant` and
 *  `data-driven` returns null — the renderer uses the static fill hex
 *  (constant) or the per-feature bake (data-driven) and clone-on-
 *  resolution would be wasted work. */
function resolveColorShape(
  shape: PropertyShape<RGBA>,
  cameraZoom: number,
  elapsedMs: number,
): { value: RGBA; hasZoom: boolean; hasTime: boolean } | null {
  switch (shape.kind) {
    case 'constant':
      return null
    case 'zoom-interpolated':
      return {
        value: interpolateZoomRgba(shape.stops, cameraZoom, shape.base ?? 1) as RGBA,
        hasZoom: true, hasTime: false,
      }
    case 'time-interpolated':
      return {
        value: interpolateTimeColor(
          shape.stops, elapsedMs, shape.loop, shape.easing, shape.delayMs,
        ) as RGBA,
        hasZoom: false, hasTime: true,
      }
    case 'zoom-time': {
      // Spec doesn't define zoom × time composition for colour; pick
      // the time-axis value (the dominant animation in observed
      // styles). Emit-commands doesn't currently produce zoom-time
      // colour shapes, so this branch is defensive only.
      return {
        value: interpolateTimeColor(
          shape.timeStops, elapsedMs, shape.loop, shape.easing, shape.delayMs,
        ) as RGBA,
        hasZoom: true, hasTime: true,
      }
    }
    case 'data-driven':
      return null
  }
}

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
    const loop = entry.show.timeOpacityLoop ?? false
    const easing = entry.show.timeOpacityEasing ?? 'linear'
    const delayMs = entry.show.timeOpacityDelayMs ?? 0

    // ── Opacity (zoom × time, composed) ──
    //
    // Step 1c: read the typed PaintShapes.opacity bundle emitted by
    // BOTH the compiler (emit-commands) AND the legacy interpreter
    // (interpreter.ts:synthesizeConstantPaintShapes). resolveNumberShape
    // composes zoom and time multiplicatively for the `zoom-time`
    // variant, matching the legacy `zoomOpa * timeOpa` calculation 1:1.
    const opacityShape = entry.show.paintShapes.opacity
    const opaResolved = resolveNumberShape(opacityShape, input.cameraZoom, input.elapsedMs)
    const composedOpa = opaResolved.value

    // ── Stroke width (time overrides zoom overrides scalar) ──
    //
    // emit-commands' composeStrokeWidthShape folds the spatial
    // (StrokeWidthValue) and temporal (StrokeValue.timeWidthStops)
    // halves into a single shape: `constant` / `data-driven` for
    // baked / per-feature paths (renderer uses entry.show.strokeWidth
    // scalar or the per-feature segment-buffer slot), or one of the
    // three animated kinds for per-frame eval here.
    const swShape = entry.show.paintShapes.strokeWidth
    let resolvedStrokeWidth: number | undefined
    if (swShape.kind === 'zoom-interpolated' || swShape.kind === 'time-interpolated' || swShape.kind === 'zoom-time') {
      resolvedStrokeWidth = resolveNumberShape(swShape, input.cameraZoom, input.elapsedMs).value
    }

    // ── Size (point markers, label paths) ──
    const sizeShape = entry.show.paintShapes.size
    let resolvedSize: number | undefined
    if (sizeShape !== null &&
        (sizeShape.kind === 'zoom-interpolated' || sizeShape.kind === 'time-interpolated' || sizeShape.kind === 'zoom-time')) {
      resolvedSize = resolveNumberShape(sizeShape, input.cameraZoom, input.elapsedMs).value
    }

    // ── Dash offset (time only — not part of PaintShapes) ──
    //
    // Stroke dash offset is a structural attribute, not a "paint"
    // colour/numeric — it lives on the parent StrokeValue alongside
    // dashArray + patterns and only carries a `time-interpolated`
    // animation form. Kept on the flat field for now.
    let resolvedDashOffset: number | undefined
    if (entry.show.timeDashOffsetStops) {
      resolvedDashOffset = interpolateTime(
        entry.show.timeDashOffsetStops, input.elapsedMs, loop, easing, delayMs,
      )
    }

    // ── Fill colour ──
    const fillShape = entry.show.paintShapes.fill
    let resolvedFillRgba: [number, number, number, number] | undefined
    if (fillShape !== null) {
      const r = resolveColorShape(fillShape, input.cameraZoom, input.elapsedMs)
      if (r !== null) resolvedFillRgba = r.value as [number, number, number, number]
    }

    // ── Stroke colour ──
    const strokeShape = entry.show.paintShapes.stroke
    let resolvedStrokeRgba: [number, number, number, number] | undefined
    if (strokeShape !== null) {
      const r = resolveColorShape(strokeShape, input.cameraZoom, input.elapsedMs)
      if (r !== null) resolvedStrokeRgba = r.value as [number, number, number, number]
    }

    const hasAnyTimeAnim =
      !!entry.show.timeOpacityStops ||
      !!entry.show.timeFillStops ||
      !!entry.show.timeStrokeStops ||
      !!entry.show.timeStrokeWidthStops ||
      !!entry.show.timeSizeStops ||
      !!entry.show.timeDashOffsetStops
    const hasAnyZoomStops =
      !!entry.show.zoomOpacityStops ||
      !!entry.show.zoomFillStops ||
      !!entry.show.zoomStrokeWidthStops ||
      !!entry.show.zoomSizeStops
    const needsClone = hasAnyZoomStops || hasAnyTimeAnim
    const effectiveShow: SceneCommands['shows'][0] = needsClone
      ? { ...entry.show, opacity: composedOpa }
      : entry.show
    if (resolvedStrokeWidth !== undefined) effectiveShow.strokeWidth = resolvedStrokeWidth
    if (resolvedSize !== undefined) effectiveShow.size = resolvedSize
    if (resolvedDashOffset !== undefined) effectiveShow.dashOffset = resolvedDashOffset
    if (resolvedFillRgba !== undefined) effectiveShow.resolvedFillRgba = resolvedFillRgba
    if (resolvedStrokeRgba !== undefined) effectiveShow.resolvedStrokeRgba = resolvedStrokeRgba

    if ((effectiveShow.opacity ?? 1) < 0.005) continue

    const isTranslucentStroke =
      !safeMode && (effectiveShow.opacity ?? 1) < 0.999 && !!effectiveShow.stroke
    // Translucent extruded fills route through Weighted-Blended
    // OIT — the layer's fill phase moves to the OIT pass, leaving
    // outlines (if any) on the regular line path. Detected purely
    // from the show's effective opacity + presence of an
    // `extrude:` keyword; no per-feature decision (an extruded
    // layer with mixed alphas still routes its entire fill through
    // OIT, which is the whole point — no sort).
    const isOitExtrude =
      !safeMode && (effectiveShow.opacity ?? 1) < 0.999
      && effectiveShow.extrude !== undefined
      && effectiveShow.extrude.kind !== 'none'
    // pointer-events: none routes through the writeMask:0 mirror set
    // so the layer's pickId never lands in the pick texture (picks
    // fall through to whatever drew underneath). Falls back to the
    // pickable pipeline if the no-pick mirror isn't available — that's
    // a stub/test scenario, not an expected production path.
    const noPick = effectiveShow.pointerEvents === 'none'
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
    const classified: ClassifiedShow = {
      sourceName: entry.sourceName,
      vtEntry,
      show: effectiveShow,
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
      const layerName = (effectiveShow as { layerName?: string }).layerName ?? ''
      input.traceRecorder.recordLayer({
        layerName,
        fillPhase,
        resolvedOpacity: composedOpa,
        resolvedStrokeWidth: resolvedStrokeWidth ?? entry.show.strokeWidth ?? 0,
        resolvedFill: resolvedFillRgba as RGBA | undefined,
        resolvedStroke: resolvedStrokeRgba as RGBA | undefined,
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
