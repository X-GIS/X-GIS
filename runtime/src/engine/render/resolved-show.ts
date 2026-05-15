// ═══ ResolvedShow ═══
//
// A per-frame, SSA-style snapshot of a ShowCommand's paint state with
// EVERY animation / zoom dependency already collapsed to a scalar
// / RGBA. The downstream renderers (VectorTileRenderer, LineRenderer,
// PointRenderer, the text-stage composite step) read these readonly
// fields directly — no per-callsite zoom-stop evaluation, no
// mutable `cs.show.opacity = composedOpa` writeback.
//
// Phase 4 complete: this is the SOLE per-frame paint-state carrier.
// `classifyVectorTileShows` builds one ResolvedShow per ClassifiedShow,
// every downstream consumer (VTR.render, line composite, point
// labels) reads from it. ShowCommand keeps its static / authored
// paint fields for the imperative `layer.opacity =` API and the
// canvas-fallback renderer; the WebGPU draw path no longer touches
// them per-frame.

// SceneCommands isn't on the public @xgis/compiler barrel surface but
// `bucket-scheduler.ts` already imports it the same way; both
// references stay consistent through @xgis/compiler's workspace
// resolution. (Adding the export to compiler/src/index.ts surfaces
// stale field references elsewhere — separate cleanup task.)
import type { SceneCommands, PropertyShape } from '@xgis/compiler'
import { resolveNumberShape, resolveColorShape } from './paint-shape-resolve'

type ShowCommand = SceneCommands['shows'][0]
type ShapeRef = PropertyShape<unknown> | null | undefined

// Per-show cache for ResolvedShow snapshots. The classifier hits
// resolveShow once per show per frame — Bright at 115 shows × 60 fps
// = 6,900 allocations/sec. Most frames have stable zoom (pan-only
// motion); for shows with no time-interpolated axis (Bright: all 115)
// the resolved value is byte-identical across frames as long as zoom
// holds. The cache stores the SHAPE references we resolved against so
// `XGISLayerStyle.opacity = 0.5` (setter replaces paintShapes.opacity)
// invalidates the entry automatically via reference inequality.
interface ResolveCacheEntry {
  opacity: ShapeRef
  strokeWidth: ShapeRef
  size: ShapeRef
  fill: ShapeRef
  stroke: ShapeRef
  dashOffset: ShapeRef
  zoom: number
  elapsedMs: number
  /** True iff any cached axis is time-interpolated / zoom-time. When
   *  true, elapsedMs MUST match for a hit; otherwise the elapsedMs
   *  field is ignored (zoom-only or constant axes don't depend on
   *  the clock and benefit from cache hits even as time advances). */
  hasTimeDep: boolean
  resolved: ResolvedShow
}
const _resolveCache = new WeakMap<ShowCommand, ResolveCacheEntry>()

function shapeIsTimeDep(s: ShapeRef): boolean {
  if (s === null || s === undefined) return false
  return s.kind === 'time-interpolated' || s.kind === 'zoom-time'
}

/** RGBA tuple in straight-alpha sRGB unit floats (0..1 per channel).
 *  Matches the convention used throughout the runtime — the GPU
 *  conversion to premultiplied sRGB happens in the shader. */
export type RGBA = readonly [number, number, number, number]

/** Per-frame snapshot of a ShowCommand's paint state. Every field is
 *  `readonly` — downstream callers should never mutate a ResolvedShow.
 *  Construct one via {@link resolveShow}.
 *
 *  Optional fields stay `undefined` when the source ShowCommand never
 *  declared that axis (e.g. `stroke` on a fill-only layer). Numeric
 *  scalars (`opacity`, `strokeWidth`, `size`, `dashOffset`) always
 *  carry a concrete number — the resolver applies the spec's defaults
 *  when the shape is `data-driven` or absent. */
export interface ResolvedShow {
  /** Stable per-show layer identifier — DSL `layer` name when present,
   *  otherwise the MVT source-layer key, otherwise the source name. */
  readonly layerName: string

  /** Compositing opacity in [0, 1]. Composes zoom × time when both
   *  axes carry stops; otherwise the dominant axis wins. */
  readonly opacity: number

  /** Stroke width in CSS px. Renderer scales by DPR. */
  readonly strokeWidth: number

  /** Point-marker / label-anchor size in CSS px. */
  readonly size: number

  /** Stroke dash-pattern offset in CSS px. Sub-pixel-stable across
   *  frames for the dash-march animation. */
  readonly dashOffset: number

  /** RGBA fill when the layer declared one. `null` for line-only or
   *  data-driven layers (the per-feature bake / static hex is the
   *  authoritative value downstream). */
  readonly fill: RGBA | null

  /** RGBA stroke when the layer declared one. */
  readonly stroke: RGBA | null
}

/** Per-frame camera + clock context the resolver needs. Keeps the
 *  signature stable as new animation kinds are added. */
export interface ResolveEnv {
  readonly cameraZoom: number
  readonly elapsedMs: number
}

/** Collapse every per-frame-variable axis of a ShowCommand into a
 *  ResolvedShow snapshot.
 *
 *  The classifier in `bucket-scheduler.ts:classifyVectorTileShows`
 *  calls this once per ShowCommand per frame; downstream consumers
 *  read scalars / RGBA off the returned snapshot. */
export function resolveShow(show: ShowCommand, env: ResolveEnv): ResolvedShow {
  const { cameraZoom, elapsedMs } = env
  const ps = show.paintShapes

  // Allocation-free hot path: reuse the previous frame's ResolvedShow
  // when (a) every paint-shape reference is identical to last call's
  // (catches setter-driven mutations cleanly) AND (b) zoom hasn't
  // moved AND (c) for shows with a time-driven axis, elapsedMs is
  // unchanged too. Bright pan motion holds zoom — all 115 shows hit.
  const cached = _resolveCache.get(show)
  if (cached
    && cached.opacity === ps.opacity
    && cached.strokeWidth === ps.strokeWidth
    && cached.size === ps.size
    && cached.fill === ps.fill
    && cached.stroke === ps.stroke
    && cached.dashOffset === show.dashOffsetShape
    && cached.zoom === cameraZoom
    && (!cached.hasTimeDep || cached.elapsedMs === elapsedMs)
  ) {
    return cached.resolved
  }

  // Opacity — `zoom-time` kind composes both axes multiplicatively,
  // matching the legacy `zoomOpa * timeOpa` rule.
  const opacity = resolveNumberShape(ps.opacity, cameraZoom, elapsedMs).value

  // Stroke width — three branches:
  //   - animated   → per-frame value from resolveNumberShape
  //   - constant   → the shape's baked-in value (== show.strokeWidth)
  //   - data-driven → the layer's static `show.strokeWidth` base;
  //                  per-feature buffer slot overrides downstream.
  //                  resolveNumberShape returns `1` here as a
  //                  per-layer fallback that loses the user's
  //                  declared base width — so we read show
  //                  directly for this case.
  const strokeWidth = ps.strokeWidth.kind === 'data-driven'
    ? (show.strokeWidth ?? 1)
    : resolveNumberShape(ps.strokeWidth, cameraZoom, elapsedMs).value

  // Size — same rule as strokeWidth.
  const size = ps.size === null
    ? (show.size ?? 0)
    : ps.size.kind === 'data-driven'
      ? (show.size ?? 0)
      : resolveNumberShape(ps.size, cameraZoom, elapsedMs).value

  // Dash offset is a STRUCTURAL stroke attribute (drift of the dash
  // pattern along the line) — it has its own PropertyShape outside the
  // PaintShapes bundle. emit-commands composes the shape from the
  // static `stroke.dashOffset` and any time-interpolated animation
  // with the layer-level lifecycle metadata baked in.
  const dashOffset = show.dashOffsetShape
    ? resolveNumberShape(show.dashOffsetShape, cameraZoom, elapsedMs).value
    : 0

  // Fill / stroke colour — `null` from the resolver means "the
  // ShowCommand's static `fill` hex is authoritative this frame".
  //
  // P3 Step 4 (deferred, attempt 2): even with the gradient atlas
  // upgraded from rgba8unorm to rgba16float (half-float channels,
  // ~11-bit mantissa), the ML pixel match still drops 96.89 % →
  // 68.29 % identical when the CPU resolve is skipped. Root cause
  // moved: it's no longer atlas quantisation but the canvas
  // surface itself — Chrome's swap-chain is 8-bit RGB regardless of
  // atlas precision, so any path that produces a fractional channel
  // value (CPU exact float64 lerp vs GPU rgba16float + HW linear
  // filter + back-to-8bit quantisation at display) ends up with a
  // ±1 RGB round-off at byte boundary. ≤8 RGB delta stays at
  // 97.79 % — visually indistinguishable, but breaks the plan's
  // strict ≤1 RGB delta verification target. Defer until 10-bit
  // HDR canvas / non-byte display surface is wired (browser
  // dependency, separate phase).
  const fillResolved = ps.fill !== null
    ? resolveColorShape(ps.fill, cameraZoom, elapsedMs)
    : null
  const strokeResolved = ps.stroke !== null
    ? resolveColorShape(ps.stroke, cameraZoom, elapsedMs)
    : null

  // Static-hex fallback for the `null` case. parseHexColor lives in
  // map.ts; we just hand back whatever the ShowCommand already
  // computed at compile time (`resolvedFillRgba` is the bake-time
  // staging field used by classifyVectorTileShows).
  const fill: RGBA | null = fillResolved !== null
    ? (fillResolved.value as RGBA)
    : (show.resolvedFillRgba ?? null)
  const stroke: RGBA | null = strokeResolved !== null
    ? (strokeResolved.value as RGBA)
    : (show.resolvedStrokeRgba ?? null)

  const resolved: ResolvedShow = {
    layerName: show.layerName ?? show.sourceLayer ?? show.targetName ?? '',
    opacity, strokeWidth, size, dashOffset,
    fill, stroke,
  }

  const hasTimeDep =
    shapeIsTimeDep(ps.opacity as ShapeRef)
    || shapeIsTimeDep(ps.strokeWidth as ShapeRef)
    || shapeIsTimeDep(ps.size as ShapeRef)
    || shapeIsTimeDep(ps.fill as ShapeRef)
    || shapeIsTimeDep(ps.stroke as ShapeRef)
    || shapeIsTimeDep(show.dashOffsetShape as ShapeRef)
  if (cached) {
    cached.opacity = ps.opacity as ShapeRef
    cached.strokeWidth = ps.strokeWidth as ShapeRef
    cached.size = ps.size as ShapeRef
    cached.fill = ps.fill as ShapeRef
    cached.stroke = ps.stroke as ShapeRef
    cached.dashOffset = show.dashOffsetShape as ShapeRef
    cached.zoom = cameraZoom
    cached.elapsedMs = elapsedMs
    cached.hasTimeDep = hasTimeDep
    cached.resolved = resolved
  } else {
    _resolveCache.set(show, {
      opacity: ps.opacity as ShapeRef,
      strokeWidth: ps.strokeWidth as ShapeRef,
      size: ps.size as ShapeRef,
      fill: ps.fill as ShapeRef,
      stroke: ps.stroke as ShapeRef,
      dashOffset: show.dashOffsetShape as ShapeRef,
      zoom: cameraZoom,
      elapsedMs,
      hasTimeDep,
      resolved,
    })
  }

  return resolved
}
