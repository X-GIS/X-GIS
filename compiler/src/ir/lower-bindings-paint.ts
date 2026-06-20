// ═══ AST → IR Lowering: PAINT-concern binding handlers ═══
// Relocated opacity / size / fill-extrusion / translate / projection /
// visibility / shape / animation arms from lowerLayer's utility ladder
// (lower.ts). Pure body moves — see lower-bindings.ts header for the
// faithfulness invariant.

import { resolveColor } from '../tokens/colors'
import { colorConstant, hexToRgba, sizeConstant } from './render-node'
import {
  bindingAsConstantNumber,
  extractInterpolateZoomStops,
} from './lower-helpers'
import type { BindingHandler } from './lower-bindings'

// ── Binding-form arms (item.binding present) ──

/** `opacity-[interpolate(zoom, …)]` — 0..100 scale, divide each stop. */
export const opacityZoomBindingHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'opacity',
  apply: (ctx) => {
    const zoomStops = extractInterpolateZoomStops(ctx.item.binding!)
    if (zoomStops) {
      for (const s of zoomStops.stops) {
        ctx.acc.opacityZoomStops.push({
          zoom: s.zoom,
          // opacity-<N> is the 0..100 scale; divide always (the old
          // `<=1?:/100` heuristic mis-read opacity-1 = Mapbox 0.01 as 1.0).
          value: s.value / 100,
        })
      }
      if (zoomStops.base !== 1) ctx.acc.opacityZoomStopsBase = zoomStops.base
      return true
    }
    // Non-zoom opacity binding — fall through to the named `opacity` arm
    // (data-driven). Original: the `if (zoomStops && name==='opacity')`
    // guard failed and control reached `else if (name==='opacity')`.
    ctx.acc.opacity = { kind: 'data-driven', expr: { ast: ctx.item.binding! } }
    return true
  },
}

/** `size-[interpolate(zoom, …)]` — zoom stops, else data-driven. */
export const sizeZoomBindingHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'size',
  apply: (ctx) => {
    const zoomStops = extractInterpolateZoomStops(ctx.item.binding!)
    if (zoomStops) {
      for (const s of zoomStops.stops) ctx.acc.sizeZoomStops.push({ zoom: s.zoom, value: s.value })
      if (zoomStops.base !== 1) ctx.acc.sizeZoomStopsBase = zoomStops.base
      return true
    }
    ctx.acc.size = { kind: 'data-driven', expr: { ast: ctx.item.binding! }, unit: ctx.item.bindingUnit ?? null }
    return true
  },
}

/** `fill-translate-x/y-[interpolate(zoom, …)]` — per-axis zoom shape. */
export const fillTranslateXBindingHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'fill-translate-x',
  apply: (ctx) => {
    const zoomStops = extractInterpolateZoomStops(ctx.item.binding!)
    if (!zoomStops) return false
    ctx.acc.fillTranslateXShape = { kind: 'zoom-interpolated', stops: zoomStops.stops, base: zoomStops.base }
    return true
  },
}
export const fillTranslateYBindingHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'fill-translate-y',
  apply: (ctx) => {
    const zoomStops = extractInterpolateZoomStops(ctx.item.binding!)
    if (!zoomStops) return false
    ctx.acc.fillTranslateYShape = { kind: 'zoom-interpolated', stops: zoomStops.stops, base: zoomStops.base }
    return true
  },
}
export const circleTranslateXBindingHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'circle-translate-x',
  apply: (ctx) => {
    const zoomStops = extractInterpolateZoomStops(ctx.item.binding!)
    if (!zoomStops) return false
    ctx.acc.circleTranslateXShape = { kind: 'zoom-interpolated', stops: zoomStops.stops, base: zoomStops.base }
    return true
  },
}
export const circleTranslateYBindingHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'circle-translate-y',
  apply: (ctx) => {
    const zoomStops = extractInterpolateZoomStops(ctx.item.binding!)
    if (!zoomStops) return false
    ctx.acc.circleTranslateYShape = { kind: 'zoom-interpolated', stops: zoomStops.stops, base: zoomStops.base }
    return true
  },
}

/** Binding-form fill-extrusion height/base (feature exprs). */
export const fillExtrusionHeightBindingHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'fill-extrusion-height',
  apply: (ctx) => { ctx.acc.extrude = { kind: 'feature', expr: { ast: ctx.item.binding! }, fallback: 0 }; return true },
}
export const fillExtrusionBaseBindingHandler: BindingHandler = {
  match: (ctx) => ctx.name === 'fill-extrusion-base',
  apply: (ctx) => { ctx.acc.extrudeBase = { kind: 'feature', expr: { ast: ctx.item.binding! }, fallback: 0 }; return true },
}

/** Final binding-form fallthrough: numeric-const translate arms + the
 *  X-GIS0005 catch-all. Mirrors lowerLayer's `else` branch. */
export const bindingFallthroughHandler: BindingHandler = {
  match: () => true,
  apply: (ctx) => {
    // Numeric paint utilities that allow negative values use
    // bracket-binding form since the utility-name grammar treats
    // `-` as a segment separator. We only accept literal-number
    // (or unary-minus literal) bindings here.
    const n = bindingAsConstantNumber(ctx.item.binding!)
    if (n !== null) {
      const a = ctx.acc
      if (ctx.name === 'fill-translate-x') { a.fillTranslateX = n; return true }
      if (ctx.name === 'fill-translate-y') { a.fillTranslateY = n; return true }
      if (ctx.name === 'circle-translate-x') { a.circleTranslateX = n; return true }
      if (ctx.name === 'circle-translate-y') { a.circleTranslateY = n; return true }
      if (ctx.name === 'circle-blur') { a.circleBlur = n; return true }
      if (ctx.name === 'stroke-translate-x') { a.strokeTranslateX = n; return true }
      if (ctx.name === 'stroke-translate-y') { a.strokeTranslateY = n; return true }
    }
    // Bracket-binding form with a name that's not in any of the
    // handled arms above. Pre-fix this was the silent-drop hole that
    // hid the `stroke-[interpolate_exp(zoom, …)]` regression — a
    // `name: "stroke"` binding falls through every named handler
    // and gets dropped without a peep, so every Mapbox
    // `paint.line-width: ["interpolate", …]` reverted to a 1 px
    // hairline. Surface every unhandled binding as a warn-level
    // diagnostic so the next regression of this shape fails CI
    // instead of shipping silently.
    ctx.diagnostics.push({
      severity: 'warn',
      code: 'X-GIS0005',
      line: ctx.stmt.line,
      message:
        `Bracket-binding utility "${ctx.name}-[…]" has no handler in lower.ts — ` +
        `the expression is being dropped. Add a name==="${ctx.name}" arm in the ` +
        `binding-form handler to thread the value into the appropriate IR field.`,
    })
    return true
  },
}

// ── Utility-form arms (no binding) ──

/** Plain-numeric translate utilities (`fill-translate-x-3`, etc.). */
export const translateConstUtilHandlers: BindingHandler[] = [
  {
    match: (c) => c.name.startsWith('fill-translate-x-'),
    apply: (c) => {
      // Mapbox `paint.fill-translate` x component in CSS pixels.
      // Bracket-wrap form for negatives (`fill-translate-x-[-2]`)
      // is handled by the bracket binding parser above. Plain
      // numeric form lands here.
      const num = parseFloat(c.name.slice('fill-translate-x-'.length))
      if (!isNaN(num)) c.acc.fillTranslateX = num
      return true
    },
  },
  {
    match: (c) => c.name.startsWith('fill-translate-y-'),
    apply: (c) => { const num = parseFloat(c.name.slice('fill-translate-y-'.length)); if (!isNaN(num)) c.acc.fillTranslateY = num; return true },
  },
  {
    // Mapbox fill-translate-anchor=map → world-space anchor flag. The
    // converter emits this ONLY for anchor=map (viewport is the
    // byte-identical default that emits nothing). Runtime rotates the
    // [dx,dy] offset by the map bearing at the per-tile bake.
    match: (c) => c.name === 'fill-translate-anchor-map',
    apply: (c) => { c.acc.fillTranslateAnchorMap = true; return true },
  },
]

export const circleTranslateConstUtilHandlers: BindingHandler[] = [
  {
    match: (c) => c.name.startsWith('circle-translate-x-'),
    apply: (c) => { const num = parseFloat(c.name.slice('circle-translate-x-'.length)); if (!isNaN(num)) c.acc.circleTranslateX = num; return true },
  },
  {
    match: (c) => c.name.startsWith('circle-translate-y-'),
    apply: (c) => { const num = parseFloat(c.name.slice('circle-translate-y-'.length)); if (!isNaN(num)) c.acc.circleTranslateY = num; return true },
  },
  {
    match: (c) => c.name.startsWith('circle-blur-'),
    apply: (c) => { const num = parseFloat(c.name.slice('circle-blur-'.length)); if (!isNaN(num)) c.acc.circleBlur = num; return true },
  },
]

export const strokeTranslateConstUtilHandlers: BindingHandler[] = [
  {
    match: (c) => c.name.startsWith('stroke-translate-x-'),
    apply: (c) => { const num = parseFloat(c.name.slice('stroke-translate-x-'.length)); if (!isNaN(num)) c.acc.strokeTranslateX = num; return true },
  },
  {
    match: (c) => c.name.startsWith('stroke-translate-y-'),
    apply: (c) => { const num = parseFloat(c.name.slice('stroke-translate-y-'.length)); if (!isNaN(num)) c.acc.strokeTranslateY = num; return true },
  },
  {
    // Mapbox line-translate-anchor=map → world-space anchor flag for
    // the line pipeline. Emitted by the converter only for anchor=map.
    match: (c) => c.name === 'stroke-translate-anchor-map',
    apply: (c) => { c.acc.strokeTranslateAnchorMap = true; return true },
  },
]

/** Utility-form fill-extrusion height/base constants. */
export const fillExtrusionConstUtilHandlers: BindingHandler[] = [
  {
    match: (c) => c.name.startsWith('fill-extrusion-height-'),
    apply: (c) => {
      // Mapbox `fill-extrusion-height` paint property as a tailwind-
      // shaped utility. Value is a static metres count; data-driven
      // form is handled higher up via the `-[expr]` binding branch.
      const num = parseFloat(c.name.slice('fill-extrusion-height-'.length))
      if (!isNaN(num)) c.acc.extrude = { kind: 'constant', value: num }
      return true
    },
  },
  {
    match: (c) => c.name.startsWith('fill-extrusion-base-'),
    apply: (c) => {
      // Mapbox `fill-extrusion-base` paint property — z of the
      // wall BOTTOM (default 0). Static-value form; data-driven goes
      // through the `-[expr]` branch above.
      const num = parseFloat(c.name.slice('fill-extrusion-base-'.length))
      if (!isNaN(num)) c.acc.extrudeBase = { kind: 'constant', value: num }
      return true
    },
  },
]

/** opacity-* / size-* / projection-* / visibility / shape / pointer-events /
 *  animation utility arms. */
export const miscUtilHandlers: BindingHandler[] = [
  {
    match: (c) => c.name.startsWith('opacity-'),
    apply: (c) => {
      const num = parseFloat(c.name.slice(8))
      if (!isNaN(num)) {
        const val = num / 100 // 0..100 scale (see opacity zoom-stop arm)
        c.acc.opacity = { kind: 'constant', value: val }
      }
      return true
    },
  },
  {
    match: (c) => c.name.startsWith('size-'),
    apply: (c) => {
      const sizeStr = c.name.slice(5)
      const unitMatch = sizeStr.match(/^([\d.]+)(px|m|km|nm|deg)?$/)
      if (unitMatch) {
        const num = parseFloat(unitMatch[1])
        const unit = unitMatch[2] || null  // null = px default
        if (!isNaN(num)) c.acc.size = sizeConstant(num, unit)
      }
      return true
    },
  },
  { match: (c) => c.name.startsWith('projection-'), apply: (c) => { c.acc.projection = c.name.slice(11); return true } },
  { match: (c) => c.name === 'hidden', apply: (c) => { c.acc.visible = false; return true } },
  { match: (c) => c.name === 'flat', apply: (c) => { c.acc.billboard = false; return true } },
  { match: (c) => c.name === 'billboard', apply: (c) => { c.acc.billboard = true; return true } },
  { match: (c) => c.name === 'anchor-center', apply: (c) => { c.acc.anchor = 'center'; return true } },
  { match: (c) => c.name === 'anchor-bottom', apply: (c) => { c.acc.anchor = 'bottom'; return true } },
  { match: (c) => c.name === 'anchor-top', apply: (c) => { c.acc.anchor = 'top'; return true } },
  {
    match: (c) => c.name.startsWith('shape-'),
    apply: (c) => {
      const shapeName = c.name.slice(6)
      if (c.item.binding) {
        c.acc.shape = { kind: 'data-driven', expr: { ast: c.item.binding } }
      } else {
        c.acc.shape = { kind: 'named', name: shapeName }
      }
      return true
    },
  },
  { match: (c) => c.name === 'visible', apply: (c) => { c.acc.visible = true; return true } },
  { match: (c) => c.name === 'pointer-events-none', apply: (c) => { c.acc.pointerEvents = 'none'; return true } },
  { match: (c) => c.name === 'pointer-events-auto', apply: (c) => { c.acc.pointerEvents = 'auto'; return true } },
  {
    match: (c) => c.name.startsWith('animation-'),
    apply: (c) => {
      // All animation-related utilities carry the `animation-` prefix so
      // they're visually grouped and can't collide with non-animation
      // modifiers. The sub-prefix discriminator decides whether this is
      // a lifecycle setting or a keyframes reference:
      //
      //   animation-duration-<ms>   → duration in milliseconds
      //   animation-delay-<ms>      → delay in ms (negative allowed)
      //   animation-ease-{linear|in|out|in-out}
      //                             → easing function
      //   animation-infinite        → loop forever
      //   animation-<anything else> → keyframes reference by name
      //
      // This means `duration`, `delay`, `ease-*`, and `infinite` are
      // reserved as keyframes names — using them in `keyframes <name>`
      // makes them unreachable here.
      const a = c.acc
      const rest = c.name.slice('animation-'.length)
      if (rest.startsWith('duration-')) {
        const num = parseFloat(rest.slice('duration-'.length))
        if (!isNaN(num)) a.animationDurationMs = num
      } else if (rest.startsWith('delay-')) {
        const num = parseFloat(rest.slice('delay-'.length))
        if (!isNaN(num)) a.animationDelayMs = num
      } else if (rest === 'ease-linear') {
        a.animationEasing = 'linear'
      } else if (rest === 'ease-in') {
        a.animationEasing = 'ease-in'
      } else if (rest === 'ease-out') {
        a.animationEasing = 'ease-out'
      } else if (rest === 'ease-in-out') {
        a.animationEasing = 'ease-in-out'
      } else if (rest === 'infinite') {
        a.animationLoop = true
      } else {
        a.animationName = rest
      }
      return true
    },
  },
]

/** Modifier-item color arm: `friendly:fill-green-500` pushes a conditional
 *  branch. Mirrors lowerLayer's modifier block (after the X-GIS0001 check). */
export const modifierFillHandler: BindingHandler = {
  match: (ctx) => ctx.name.startsWith('fill-'),
  apply: (ctx) => {
    const hex = resolveColor(ctx.name.slice(5))
    if (hex) {
      ctx.acc.fillBranches.push({ field: ctx.mod!, value: colorConstant(...hexToRgba(hex)) })
    }
    return true
  },
}
