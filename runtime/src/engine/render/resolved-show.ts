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
import type { SceneCommands } from '@xgis/compiler'
import { resolveNumberShape, resolveColorShape } from './paint-shape-resolve'

type ShowCommand = SceneCommands['shows'][0]

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

  return {
    layerName: show.layerName ?? show.sourceLayer ?? show.targetName ?? '',
    opacity, strokeWidth, size, dashOffset,
    fill, stroke,
  }
}
