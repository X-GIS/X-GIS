// ═══ ResolvedShow ═══
//
// A per-frame, SSA-style snapshot of a ShowCommand's paint state with
// EVERY animation / zoom dependency already collapsed to a scalar
// / RGBA. The downstream renderers (VectorTileRenderer, LineRenderer,
// PointRenderer, the text-stage composite step) read these readonly
// fields directly — no per-callsite zoom-stop evaluation, no
// mutable `cs.show.opacity = composedOpa` writeback.
//
// Phase 4a (this file): introduce the type + the `resolveShow`
// helper. The bucket scheduler still resolves inline and writes back
// to a cloned ShowCommand; both surfaces share the same resolver
// helpers (paint-shape-resolve.ts) so the values stay in sync.
//
// Phase 4b / 4c (follow-up commits): migrate `classifyVectorTileShows`
// output to `ClassifiedShow<ResolvedShow>` and narrow the renderer
// signatures so a TypeScript error fires when someone tries to mutate
// the resolved paint state.

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
 *  Mirrors the in-place resolution in `bucket-scheduler.ts:184-318` so
 *  both paths produce identical scalars. Phase 4b will switch the
 *  classifier to populate ResolvedShow directly; Phase 4c removes the
 *  mutable `effectiveShow.opacity = …` writebacks once every consumer
 *  reads from the snapshot instead. */
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

  // Dash offset — only `time-interpolated` is currently supported on
  // the parent StrokeValue. Read from the legacy timeDashOffsetStops
  // for now; will move into a PaintShape in the next pass.
  const dashOffset = show.timeDashOffsetStops
    ? resolveNumberShape(
        { kind: 'time-interpolated', stops: show.timeDashOffsetStops,
          loop: false, easing: 'linear', delayMs: 0 } as never,
        cameraZoom, elapsedMs,
      ).value
    : (show.dashOffset ?? 0)

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
