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

import type { Camera } from './camera'
import type { LayerDrawPhase } from './vector-tile-renderer'
import type { SceneCommands } from '@xgis/compiler'
import { interpolateZoom, interpolateTime, interpolateTimeColor } from './renderer'
import { SAFE_MODE } from './gpu'

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
 *  but is stub-friendly. */
export interface ClassifierVariantPipelines {
  fillPipeline: GPURenderPipeline
  linePipeline: GPURenderPipeline
  fillPipelineFallback?: GPURenderPipeline
  linePipelineFallback?: GPURenderPipeline
}

/** The five default GPU resources shared across every layer. Pulled
 *  off `MapRenderer` in production; tests construct stubs. */
export interface ClassifierRendererDefaults {
  fillPipeline: GPURenderPipeline
  linePipeline: GPURenderPipeline
  bindGroupLayout: GPUBindGroupLayout
  fillPipelineFallback?: GPURenderPipeline
  linePipelineFallback?: GPURenderPipeline
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
}

export interface ClassifierResult {
  opaque: ClassifiedShow[]
  translucent: ClassifiedShow[]
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
  const safeMode = input.safeMode ?? SAFE_MODE
  const defaults = input.rendererDefaults

  for (const entry of input.vectorTileShows) {
    const vtEntry = input.vtSources.get(entry.sourceName)
    if (!vtEntry || !vtEntry.renderer.hasData()) continue

    // Opacity = zoom factor × time factor. Either may be 1 if its
    // stop list is absent, leaving the existing constant opacity
    // intact.
    const baseOpa = entry.show.opacity ?? 1
    const zoomOpa = entry.show.zoomOpacityStops
      ? interpolateZoom(entry.show.zoomOpacityStops, input.cameraZoom)
      : baseOpa
    const timeOpa = entry.show.timeOpacityStops
      ? interpolateTime(
          entry.show.timeOpacityStops, input.elapsedMs,
          entry.show.timeOpacityLoop ?? false,
          entry.show.timeOpacityEasing ?? 'linear',
          entry.show.timeOpacityDelayMs ?? 0,
        )
      : 1
    const composedOpa = zoomOpa * timeOpa

    // PR 3: resolve animated color/width/size/dashoffset here so
    // the downstream VTR, line-renderer, and point-renderer all
    // see a plain static show object and don't need to know about
    // time stops. The classifier is the single choke point that
    // turns animation IR back into concrete uniform values every
    // frame.
    const loop = entry.show.timeOpacityLoop ?? false
    const easing = entry.show.timeOpacityEasing ?? 'linear'
    const delayMs = entry.show.timeOpacityDelayMs ?? 0
    const hasAnyTimeAnim =
      !!entry.show.timeOpacityStops ||
      !!entry.show.timeFillStops ||
      !!entry.show.timeStrokeStops ||
      !!entry.show.timeStrokeWidthStops ||
      !!entry.show.timeSizeStops ||
      !!entry.show.timeDashOffsetStops
    const needsClone = !!entry.show.zoomOpacityStops || hasAnyTimeAnim
    const effectiveShow: SceneCommands['shows'][0] = needsClone
      ? { ...entry.show, opacity: composedOpa }
      : entry.show
    if (entry.show.timeFillStops) {
      effectiveShow.resolvedFillRgba = interpolateTimeColor(
        entry.show.timeFillStops, input.elapsedMs, loop, easing, delayMs,
      )
    }
    if (entry.show.timeStrokeStops) {
      effectiveShow.resolvedStrokeRgba = interpolateTimeColor(
        entry.show.timeStrokeStops, input.elapsedMs, loop, easing, delayMs,
      )
    }
    if (entry.show.timeStrokeWidthStops) {
      effectiveShow.strokeWidth = interpolateTime(
        entry.show.timeStrokeWidthStops, input.elapsedMs, loop, easing, delayMs,
      )
    }
    if (entry.show.timeDashOffsetStops) {
      effectiveShow.dashOffset = interpolateTime(
        entry.show.timeDashOffsetStops, input.elapsedMs, loop, easing, delayMs,
      )
    }
    if (entry.show.timeSizeStops) {
      effectiveShow.size = interpolateTime(
        entry.show.timeSizeStops, input.elapsedMs, loop, easing, delayMs,
      )
    }
    if ((effectiveShow.opacity ?? 1) < 0.005) continue

    const isTranslucentStroke =
      !safeMode && (effectiveShow.opacity ?? 1) < 0.999 && !!effectiveShow.stroke
    const fp = entry.pipelines?.fillPipeline ?? defaults.fillPipeline
    const lp = entry.pipelines?.linePipeline ?? defaults.linePipeline
    const bgl = entry.layout ?? defaults.bindGroupLayout
    const fpF = entry.pipelines?.fillPipelineFallback ?? defaults.fillPipelineFallback
    const lpF = entry.pipelines?.linePipelineFallback ?? defaults.linePipelineFallback
    const classified: ClassifiedShow = {
      sourceName: entry.sourceName,
      vtEntry,
      show: effectiveShow,
      fp, lp, bgl, fpF, lpF,
      isTranslucentStroke,
      fillPhase: isTranslucentStroke ? 'fills' : 'all',
    }
    opaque.push(classified)
    if (isTranslucentStroke) translucent.push(classified)
  }

  return { opaque, translucent }
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
