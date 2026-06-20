// ═══ AST → IR Lowering: LINE/STROKE-concern binding handlers ═══
// Relocated stroke-* arms from lowerLayer's utility ladder (lower.ts). Pure
// body moves — see lower-bindings.ts header for the faithfulness invariant.

import { resolveColor } from '../tokens/colors'
import { colorConstant, hexToRgba } from './render-node'
import {
  extractMatchDefaultColor,
  extractInterpolateZoomStops,
  extractInterpolateZoomArrayStops,
  extractInterpolateZoomColorStops,
} from './lower-helpers'
import type { BindingHandler } from './lower-bindings'

// ── Binding-form stroke arms (item.binding present) ──

/** `stroke-dasharray-[interpolate(zoom, …, [array], …)]` — array-valued zoom
 *  stops. Steps at runtime (Mapbox line-dasharray is interpolated:false). */
export const strokeDasharrayBindingHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'stroke-dasharray',
  apply: (ctx) => {
    const arrStops = extractInterpolateZoomArrayStops(ctx.item.binding!)
    if (arrStops) {
      ctx.acc.dashArrayShape = { kind: 'zoom-interpolated', stops: arrStops.stops, base: arrStops.base }
      return true
    }
    // No array stops — fall through (original arm did NOT `continue`; the
    // item then reaches the named `stroke` arm). Report not-consumed.
    return false
  },
}

/** `stroke-gap-[interpolate(zoom, …)]` — last-stop approximation. */
export const strokeGapBindingHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'stroke-gap',
  apply: (ctx) => {
    const zoomStops = extractInterpolateZoomStops(ctx.item.binding!)
    if (!zoomStops) return false
    // Mapbox `line-gap-width` zoom-interp. Full per-frame
    // resolve is the right path (needs StrokeValue.gapWidth →
    // PropertyShape<number>); not yet wired. Use last-stop
    // approximation — same pattern as iter 508's fill-translate
    // and iter 488's text-opacity zoom-interp drops. OFM Liberty
    // waterway_tunnel stops at z=12 (0) → z=20 (6); last stop
    // = 6 px so the runtime renders the double-line at full
    // intended gap at the highest zoom; lower zooms render
    // wider-than-spec but the visual is close.
    const last = zoomStops.stops[zoomStops.stops.length - 1]
    if (last && last.value > 0) ctx.acc.strokeGapWidth = last.value
    return true
  },
}

/** `stroke-translate-x/y-[interpolate(zoom, …)]` — per-axis zoom shape. */
export const strokeTranslateXBindingHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'stroke-translate-x',
  apply: (ctx) => {
    const zoomStops = extractInterpolateZoomStops(ctx.item.binding!)
    if (!zoomStops) return false
    ctx.acc.strokeTranslateXShape = { kind: 'zoom-interpolated', stops: zoomStops.stops, base: zoomStops.base }
    return true
  },
}
export const strokeTranslateYBindingHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'stroke-translate-y',
  apply: (ctx) => {
    const zoomStops = extractInterpolateZoomStops(ctx.item.binding!)
    if (!zoomStops) return false
    ctx.acc.strokeTranslateYShape = { kind: 'zoom-interpolated', stops: zoomStops.stops, base: zoomStops.base }
    return true
  },
}

/** `stroke-opacity-[interpolate(zoom, …)]` — circle-stroke-opacity zoom shape
 *  on the 0..100 scale; divide each stop back to 0..1. */
export const strokeOpacityBindingHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'stroke-opacity',
  apply: (ctx) => {
    const zoomStops = extractInterpolateZoomStops(ctx.item.binding!)
    if (!zoomStops) return false
    ctx.acc.strokeOpacityShape = { kind: 'zoom-interpolated', stops: zoomStops.stops.map(s => ({ zoom: s.zoom, value: s.value / 100 })), base: zoomStops.base }
    return true
  },
}

/** Named `stroke-[<expr>]` binding — width vs colour disambiguation. */
export const strokeBindingHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'stroke',
  apply: (ctx) => {
    const { item, acc } = ctx
    // `stroke-[<expr>]` carries either a colour expression (Mapbox
    // `paint.line-color: ["interpolate", …]`) or a width
    // expression (`paint.line-width: ["interpolate", …]`). The
    // converter emits the same shape for both because the
    // utility-name grammar can't tell them apart at the lex
    // stage. Disambiguate by inspecting the lowered expression:
    //   - `interpolate(zoom, z, color, …)`  → colour stops
    //   - `interpolate_exp(zoom, base, z, n, …)` → numeric stops
    //   - everything else → per-feature `widthExpr` (numeric
    //     case/match dominate; per-feature colour-only goes
    //     through `colorExpr` once that path lands).
    // Pre-fix this whole branch was missing — every OFM Bright
    // road's `stroke-[interpolate_exp(…)]` width silently
    // collapsed to the default 1 px, so the entire highway
    // network rendered as hair-thin lines.
    const colorInterp = extractInterpolateZoomColorStops(item.binding!)
    if (colorInterp && colorInterp.stops.length > 0) {
      // Last stop is the constant fallback. ColorValue doesn't
      // (yet) have a `zoom-interpolated` variant for stroke; a
      // proper per-frame stroke colour update path is parallel
      // to the fill follow-up (see `name === 'fill'` arm).
      // For now picking the highest-zoom colour gives the right
      // appearance at typical viewing zoom and prevents the
      // silent null-stroke drop. (base would land here once
      // stroke-color gets the per-frame interp path.)
      const last = colorInterp.stops[colorInterp.stops.length - 1]!
      const hex = resolveColor(last.value)
      if (hex) {
        const rgba = hexToRgba(hex)
        acc.strokeColor = colorConstant(rgba[0], rgba[1], rgba[2], rgba[3])
      }
    } else {
      // Disambiguate WIDTH vs COLOUR expression. Numeric zoom
      // stops (`interpolate_exp(zoom, base, z, n, …)` or
      // `interpolate(zoom, z, n, …)`) take the width path. A
      // colour-valued `match(.field) { v -> #rrggbb, …, _ ->
      // #default }` (Mapbox `paint.line-color: ["match", …]`)
      // walks the default-arm color extractor — if it yields a
      // hex, the binding is colour-shaped → route through the
      // strokeColorExpr field (mirror of the fill data-driven
      // arm above) so the runtime can evaluate per feature via
      // the line segment buffer's color_packed slot. Without
      // this branch a standalone data-driven stroke colour fell
      // straight through to `strokeWidthExpr`, the layer gained
      // no resolved colour, and dead-layer-elim dropped it.
      const widthStops = extractInterpolateZoomStops(item.binding!)
      if (widthStops) {
        // Pure zoom-only width — hoist as zoom stops on the
        // stroke value. The renderer recomputes `layer.width_px`
        // per frame from camera.zoom, so the line widens
        // continuously as the user zooms (vs. the widthExpr
        // path which bakes a single width per tile at decode
        // time and only updates on tile-zoom boundary crosses).
        acc.strokeWidthZoomStops = widthStops.stops
        acc.strokeWidthZoomStopsBase = widthStops.base
      } else {
        const defaultHex = extractMatchDefaultColor(item.binding!)
        if (defaultHex) {
          // Colour-shaped per-feature expression. Bake the
          // default arm as a constant fallback (so the layer
          // renders SOMETHING even before the per-feature
          // packer runs) and stash the full AST in
          // strokeColorExpr. Mirror of merge-layers' synthetic
          // strokeColorExpr emission.
          const rgba = hexToRgba(defaultHex)
          acc.strokeColor = colorConstant(rgba[0], rgba[1], rgba[2], rgba[3])
          acc.strokeColorExpr = { ast: item.binding! }
        } else {
          // Per-feature `case` / `match` expression on width.
          acc.strokeWidthExpr = { ast: item.binding! }
        }
      }
    }
    return true
  },
}

// ── Utility-form stroke arms (no binding) ──

export const lineCapJoinUtilHandlers: BindingHandler[] = [
  { match: (c) => c.name === 'stroke-butt-cap', apply: (c) => { c.acc.linecap = 'butt'; return true } },
  { match: (c) => c.name === 'stroke-round-cap', apply: (c) => { c.acc.linecap = 'round'; return true } },
  { match: (c) => c.name === 'stroke-square-cap', apply: (c) => { c.acc.linecap = 'square'; return true } },
  { match: (c) => c.name === 'stroke-arrow-cap', apply: (c) => { c.acc.linecap = 'arrow'; return true } },
  { match: (c) => c.name === 'stroke-miter-join', apply: (c) => { c.acc.linejoin = 'miter'; return true } },
  { match: (c) => c.name === 'stroke-round-join', apply: (c) => { c.acc.linejoin = 'round'; return true } },
  { match: (c) => c.name === 'stroke-bevel-join', apply: (c) => { c.acc.linejoin = 'bevel'; return true } },
  {
    match: (c) => c.name.startsWith('stroke-miterlimit-'),
    apply: (c) => { const num = parseFloat(c.name.slice('stroke-miterlimit-'.length)); if (!isNaN(num)) c.acc.miterlimit = num; return true },
  },
  {
    match: (c) => c.name.startsWith('stroke-dasharray-'),
    apply: (c) => {
      // e.g. stroke-dasharray-10-5 or stroke-dasharray-6-2-1-2.
      // The lexer splits `20_10` into Number + Identifier which breaks
      // the utility-name accumulator — hyphen is the only separator that
      // stays inside a single utility token via parseUtilityName.
      const parts = c.name.slice('stroke-dasharray-'.length).split('-')
      const nums = parts.map(parseFloat).filter(n => !isNaN(n))
      if (nums.length >= 2) c.acc.dashArray = nums
      return true
    },
  },
  {
    match: (c) => c.name.startsWith('stroke-dashoffset-'),
    apply: (c) => { const num = parseFloat(c.name.slice('stroke-dashoffset-'.length)); if (!isNaN(num)) c.acc.dashOffset = num; return true },
  },
  { match: (c) => c.name === 'stroke-inset', apply: (c) => { c.acc.strokeAlign = 'inset'; return true } },
  { match: (c) => c.name === 'stroke-outset', apply: (c) => { c.acc.strokeAlign = 'outset'; return true } },
  { match: (c) => c.name === 'stroke-center', apply: (c) => { c.acc.strokeAlign = 'center'; return true } },
  {
    // Right-hand parallel offset: same magnitude, negative sign convention.
    match: (c) => c.name.startsWith('stroke-offset-right-'),
    apply: (c) => { const num = parseFloat(c.name.slice('stroke-offset-right-'.length)); if (!isNaN(num)) c.acc.strokeOffset = -num; return true },
  },
  {
    match: (c) => c.name.startsWith('stroke-offset-left-'),
    apply: (c) => { const num = parseFloat(c.name.slice('stroke-offset-left-'.length)); if (!isNaN(num)) c.acc.strokeOffset = num; return true },
  },
  {
    // Bare stroke-offset-N → positive (left of travel) by default.
    match: (c) => c.name.startsWith('stroke-offset-'),
    apply: (c) => { const num = parseFloat(c.name.slice('stroke-offset-'.length)); if (!isNaN(num)) c.acc.strokeOffset = num; return true },
  },
  { match: (c) => c.name.startsWith('stroke-pattern-1-'), apply: (c) => { c.acc.parsePatternAttr(c.name.slice('stroke-pattern-1-'.length), 1); return true } },
  { match: (c) => c.name.startsWith('stroke-pattern-2-'), apply: (c) => { c.acc.parsePatternAttr(c.name.slice('stroke-pattern-2-'.length), 2); return true } },
  { match: (c) => c.name.startsWith('stroke-pattern-'), apply: (c) => { c.acc.parsePatternAttr(c.name.slice('stroke-pattern-'.length), 0); return true } },
  {
    // Mapbox `paint.line-blur` — edge feathering in CSS px.
    match: (c) => c.name.startsWith('stroke-blur-'),
    apply: (c) => { const num = parseFloat(c.name.slice('stroke-blur-'.length)); if (!isNaN(num)) c.acc.strokeBlur = num; return true },
  },
  {
    // Mapbox `paint.line-gap-width` — px gap between two parallel strokes
    // ("double line" casing). Constant form here; zoom-interp emits the
    // bracket binding form handled in the binding-form arm.
    match: (c) => c.name.startsWith('stroke-gap-'),
    apply: (c) => { const num = parseFloat(c.name.slice('stroke-gap-'.length)); if (!isNaN(num) && num > 0) c.acc.strokeGapWidth = num; return true },
  },
  {
    // iter-178 Mapbox `line-pattern` Stage 1 → linePattern. Uses the
    // DISTINCT `stroke-image-` namespace (NOT `stroke-pattern-`, which the
    // native SDF dash arms above own, else the sprite is mis-routed into
    // the dash path). Must precede the generic `stroke-` branch below.
    match: (c) => c.name.startsWith('stroke-image-'),
    apply: (c) => { const sprite = c.name.slice('stroke-image-'.length); if (sprite.length > 0) c.acc.linePattern = sprite; return true },
  },
  {
    match: (c) => c.name.startsWith('stroke-'),
    apply: (c) => {
      const rest = c.name.slice(7)
      const num = parseFloat(rest)
      if (!isNaN(num) && rest === String(num)) {
        c.acc.strokeWidth = num
      } else {
        const hex = resolveColor(rest)
        if (hex) c.acc.strokeColor = colorConstant(...hexToRgba(hex))
      }
      return true
    },
  },
]
