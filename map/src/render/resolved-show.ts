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

// The runtime's `ShowCommand` (renderer-types.ts) is a SUPERSET of the
// compiler's emit-commands `ShowCommand`: it carries runtime-only
// bake/resolve fields (`resolvedFillRgba`, `dashOffset`, the time/zoom
// stop arrays, …) that this resolver reads below. Use the runtime type,
// not the compiler's, so those field accesses type-check.
import type { PropertyShape } from '@xgis/compiler'
import type { ShowCommand } from './renderer-types'
import { resolveNumberShape, resolveColorShape, resolveArrayShape } from './paint-shape-resolve'

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

/** iter-177 — drop the cached entry for `show` so the next
 *  `resolveShow` call re-reads `show.resolvedFillRgba`. Used by the
 *  fill-pattern Stage 1 resolver in map.ts which writes the resolved
 *  RGBA after the sprite atlas finishes loading. Without invalidation
 *  the cached `{fill: null}` from before the atlas loaded sticks and
 *  the polygon stays invisible. */
export function invalidateResolvedShowCache(show: ShowCommand): void {
  _resolveCache.delete(show)
}

function shapeIsTimeDep(s: ShapeRef): boolean {
  if (s === null || s === undefined) return false
  return s.kind === 'time-interpolated' || s.kind === 'zoom-time'
}

/** RGBA tuple in straight-alpha sRGB unit floats (0..1 per channel).
 *  Matches the convention used throughout the runtime — the GPU
 *  conversion to premultiplied sRGB happens in the shader. */
type RGBA = readonly [number, number, number, number]

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

  /** WS-1 — per-frame zoom-interp viewport translate in CSS px for
   *  fill / line. Falls back to the constant ShowCommand.*TranslateX/Y
   *  when no shape was authored. Circle translate resolves in the
   *  point-renderer (it doesn't flow through ResolvedShow). */
  readonly fillTranslateX: number
  readonly fillTranslateY: number
  readonly strokeTranslateX: number
  readonly strokeTranslateY: number

  /** WS-1 — per-frame zoom-interp dash array (CSS-px on/off lengths), or
   *  `null` when the layer has no dash shape (VTR falls back to the static
   *  `ShowCommand.dashArray`). STEPped to the nearest zoom stop. */
  readonly dashArray: readonly number[] | null
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
  if (
    cached &&
    cached.opacity === ps.common.opacity &&
    cached.strokeWidth === ps.line.strokeWidth &&
    cached.size === ps.circle.size &&
    cached.fill === ps.fill.fill &&
    cached.stroke === ps.line.stroke &&
    cached.dashOffset === show.dashOffsetShape &&
    cached.zoom === cameraZoom &&
    (!cached.hasTimeDep || cached.elapsedMs === elapsedMs)
  ) {
    return cached.resolved
  }

  // Opacity — `zoom-time` composes both axes multiplicatively (legacy
  // `zoomOpa * timeOpa`). data-driven mirrors strokeWidth/size (#725):
  // the per-feature alpha is folded into the fill/stroke colour
  // downstream, so the per-layer compositing opacity reads the
  // single-authority `show.opacity` base rather than resolveNumberShape's
  // flat 1 — which would drop an authored/imperative base on a
  // data-driven-opacity layer.
  const opacity =
    ps.common.opacity.kind === 'data-driven'
      ? (show.opacity ?? 1)
      : resolveNumberShape(ps.common.opacity, cameraZoom, elapsedMs).value

  // Stroke width — three branches:
  //   - animated   → per-frame value from resolveNumberShape
  //   - constant   → the shape's baked-in value (== show.strokeWidth)
  //   - data-driven → the layer's static `show.strokeWidth` base;
  //                  per-feature buffer slot overrides downstream.
  //                  resolveNumberShape returns `1` here as a
  //                  per-layer fallback that loses the user's
  //                  declared base width — so we read show
  //                  directly for this case.
  const strokeWidth =
    ps.line.strokeWidth.kind === 'data-driven'
      ? (show.strokeWidth ?? 1)
      : resolveNumberShape(ps.line.strokeWidth, cameraZoom, elapsedMs).value

  // Size — same rule as strokeWidth.
  const size =
    ps.circle.size === null
      ? (show.size ?? 0)
      : ps.circle.size.kind === 'data-driven'
        ? (show.size ?? 0)
        : resolveNumberShape(ps.circle.size, cameraZoom, elapsedMs).value

  // Dash offset is a STRUCTURAL stroke attribute (drift of the dash
  // pattern along the line) — it has its own PropertyShape outside the
  // PaintShapes bundle. emit-commands composes the shape from the
  // static `stroke.dashOffset` and any time-interpolated animation
  // with the layer-level lifecycle metadata baked in.
  const dashOffset = show.dashOffsetShape
    ? resolveNumberShape(show.dashOffsetShape, cameraZoom, elapsedMs).value
    : 0

  // WS-1 — per-frame zoom-interp translate (fill / line). Prefer the
  // shape; fall back to the constant ShowCommand field. These are
  // zoom-only, so the resolve-cache (keyed on zoom) keeps them fresh
  // automatically — no extra cache-ref tracking needed.
  const fillTranslateX = show.fillTranslateXShape
    ? resolveNumberShape(show.fillTranslateXShape, cameraZoom, elapsedMs).value
    : (show.fillTranslateX ?? 0)
  const fillTranslateY = show.fillTranslateYShape
    ? resolveNumberShape(show.fillTranslateYShape, cameraZoom, elapsedMs).value
    : (show.fillTranslateY ?? 0)
  const strokeTranslateX = show.strokeTranslateXShape
    ? resolveNumberShape(show.strokeTranslateXShape, cameraZoom, elapsedMs).value
    : (show.strokeTranslateX ?? 0)
  const strokeTranslateY = show.strokeTranslateYShape
    ? resolveNumberShape(show.strokeTranslateYShape, cameraZoom, elapsedMs).value
    : (show.strokeTranslateY ?? 0)

  // WS-1 — per-frame zoom-interp dash array (STEP). Zoom-only, so the
  // zoom-keyed resolve-cache keeps it fresh. null → VTR uses show.dashArray.
  const dashArray = show.dashArrayShape ? resolveArrayShape(show.dashArrayShape, cameraZoom) : null

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
  const fillResolved =
    ps.fill.fill !== null ? resolveColorShape(ps.fill.fill, cameraZoom, elapsedMs) : null
  const strokeResolved =
    ps.line.stroke !== null ? resolveColorShape(ps.line.stroke, cameraZoom, elapsedMs) : null

  // Static-hex fallback for the `null` case. parseHexColor lives in
  // map.ts; we just hand back whatever the ShowCommand already
  // computed at compile time (`resolvedFillRgba` is the bake-time
  // staging field used by classifyVectorTileShows).
  const fill: RGBA | null =
    fillResolved !== null ? (fillResolved.value as RGBA) : (show.resolvedFillRgba ?? null)
  const stroke: RGBA | null =
    strokeResolved !== null ? (strokeResolved.value as RGBA) : (show.resolvedStrokeRgba ?? null)

  const resolved: ResolvedShow = {
    layerName: show.layerName ?? show.sourceLayer ?? show.targetName ?? '',
    opacity,
    strokeWidth,
    size,
    dashOffset,
    fill,
    stroke,
    fillTranslateX,
    fillTranslateY,
    strokeTranslateX,
    strokeTranslateY,
    dashArray,
  }

  const hasTimeDep =
    shapeIsTimeDep(ps.common.opacity as ShapeRef) ||
    shapeIsTimeDep(ps.line.strokeWidth as ShapeRef) ||
    shapeIsTimeDep(ps.circle.size as ShapeRef) ||
    shapeIsTimeDep(ps.fill.fill as ShapeRef) ||
    shapeIsTimeDep(ps.line.stroke as ShapeRef) ||
    shapeIsTimeDep(show.dashOffsetShape as ShapeRef)
  if (cached) {
    cached.opacity = ps.common.opacity as ShapeRef
    cached.strokeWidth = ps.line.strokeWidth as ShapeRef
    cached.size = ps.circle.size as ShapeRef
    cached.fill = ps.fill.fill as ShapeRef
    cached.stroke = ps.line.stroke as ShapeRef
    cached.dashOffset = show.dashOffsetShape as ShapeRef
    cached.zoom = cameraZoom
    cached.elapsedMs = elapsedMs
    cached.hasTimeDep = hasTimeDep
    cached.resolved = resolved
  } else {
    _resolveCache.set(show, {
      opacity: ps.common.opacity as ShapeRef,
      strokeWidth: ps.line.strokeWidth as ShapeRef,
      size: ps.circle.size as ShapeRef,
      fill: ps.fill.fill as ShapeRef,
      stroke: ps.line.stroke as ShapeRef,
      dashOffset: show.dashOffsetShape as ShapeRef,
      zoom: cameraZoom,
      elapsedMs,
      hasTimeDep,
      resolved,
    })
  }

  return resolved
}
