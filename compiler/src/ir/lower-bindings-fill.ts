// ═══ AST → IR Lowering: FILL-concern binding handlers ═══
// Relocated fill/pattern/antialias/fill-extrusion arms from lowerLayer's
// utility ladder (lower.ts). Pure body moves — see lower-bindings.ts header
// for the faithfulness invariant. Order within each exported array mirrors the
// original ladder; the assembler in lower-bindings-registry.ts splices these
// into the original cross-concern sequence.

import { resolveColor } from '../tokens/colors'
import { colorConstant, hexToRgba } from './render-node'
import { extractInterpolateZoomColorStops } from './lower-helpers'
import type { BindingHandler } from './lower-bindings'

/** Binding-form `fill-[…]` arm (zoom-interp color, data-driven match). */
export const fillBindingHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'fill',
  apply: (ctx) => {
    const { item, acc } = ctx
    // Mapbox `paint.fill-color: ["interpolate", curve, ["zoom"], …]`
    // converts to `fill-[interpolate(zoom, z1, #hex, …)]`. The
    // converter emits hex literals at each stop; we extract them
    // into the zoom-interpolated ColorValue here. The runtime
    // (renderer.ts:render-loop) reads `zoomFillStops` if present
    // and recomputes the fill RGBA per frame from the camera
    // zoom. PR #97's earlier "last-stop only" heuristic collapsed
    // landuse-suburb to alpha=0 (Mapbox intentionally fades it
    // out at z=10) — every suburb polygon rendered invisible
    // regardless of viewing zoom; full preservation prevents
    // that regression class.
    const colorInterp = extractInterpolateZoomColorStops(item.binding!)
    if (colorInterp && colorInterp.stops.length > 0) {
      const rgbaStops: import('./render-node').ZoomStop<[number, number, number, number]>[] = []
      for (const s of colorInterp.stops) {
        const hex = resolveColor(s.value)
        if (hex) rgbaStops.push({ zoom: s.zoom, value: hexToRgba(hex) })
      }
      if (rgbaStops.length > 0) {
        acc.fill =
          colorInterp.base !== 1
            ? { kind: 'zoom-interpolated', stops: rgbaStops, base: colorInterp.base }
            : { kind: 'zoom-interpolated', stops: rgbaStops }
        return true
      }
    }
    // Per-feature `match(.field) { …, _ -> #color }` (Mapbox
    // `["match", ["get", "X"], …, default]`) is DATA-DRIVEN,
    // unconditionally (#725). This used to collapse to a constant
    // of the `_` default arm whenever that arm was a resolvable
    // hex — a placeholder from before the per-feature fill path
    // existed — which made behaviour depend on how the author
    // spelled the default (`#hex` collapsed to one colour; a
    // token default fell through to data-driven and rendered
    // per-feature). The per-feature machinery (compiled variant
    // + feat_data[fid], the same path token-default matches
    // already exercise in production) has long landed, and the
    // match AST carries its own `_` arm, so the default still
    // wins for unmatched features — inside the variant instead
    // of swallowing the whole layer. (Mapbox-converted styles
    // usually never reach here: expand-color-match splits a
    // fill-color match into per-colour sublayers at convert
    // time; this arm is the direct-authored `.xgis` utility
    // path and the compute opt-in.)
    acc.fill = { kind: 'data-driven', expr: { ast: item.binding! } }
    return true
  },
}

/** Utility-form fill-extrusion vertical-gradient + antialias opt-out flags
 *  (single-token utilities, only the explicit-false case emitted). These sit
 *  amid the utility ladder; the assembler places them in original order. */
export const fillAntialiasUtilHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'fill-antialias-false',
  apply: (ctx) => {
    ctx.acc.fillAntialias = false
    return true
  },
}
export const fillExtrusionVerticalGradientUtilHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'fill-extrusion-vertical-gradient-false',
  apply: (ctx) => {
    ctx.acc.fillExtrusionVerticalGradient = false
    return true
  },
}

/** Utility-form fill-pattern + generic fill-<color>. fill-pattern MUST precede
 *  the color arm (else the sprite name routes into colour resolution). */
export const fillPatternUtilHandler: BindingHandler = {
  match: (ctx) => ctx.name.startsWith('fill-pattern-'),
  apply: (ctx) => {
    // iter-177 Mapbox `fill-pattern` Stage 1. Sprite name segment
    // after `fill-pattern-`; the runtime samples that sprite's
    // centre pixel for the layer fill colour. Must precede the
    // generic `fill-<color>` branch below.
    const sprite = ctx.name.slice('fill-pattern-'.length)
    if (sprite.length > 0) ctx.acc.fillPattern = sprite
    return true
  },
}
export const fillColorUtilHandler: BindingHandler = {
  match: (ctx) => ctx.name.startsWith('fill-'),
  apply: (ctx) => {
    const hex = resolveColor(ctx.name.slice(5))
    if (hex) ctx.acc.fill = colorConstant(...hexToRgba(hex))
    return true
  },
}
