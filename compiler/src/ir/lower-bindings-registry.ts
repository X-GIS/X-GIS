// ═══ AST → IR Lowering: binding-handler registry assembly ═══
// Splices the per-concern handler fragments (lower-bindings-fill/-line/-paint)
// back into the EXACT cross-concern order of lowerLayer's original utility
// ladder, then exposes the three ordered lists the driver walks:
//
//   MODIFIER_HANDLERS    — items with a modifier (`friendly:fill-green-500`)
//   BINDING_HANDLERS     — items with a `-[expr]` binding
//   UTILITY_HANDLERS     — plain utility-name items
//
// The order in each array is load-bearing (FIRST-MATCH-WINS reproduces the
// original if/else-if cascade). Adding a new property is now a single new
// handler spliced at the right position — no parallel edit of an accumulator
// `let` + return-literal key + ladder arm. See lower-bindings.ts header.

import type { BindingHandler } from './lower-bindings'
import {
  fillBindingHandler,
  fillAntialiasUtilHandler,
  fillExtrusionVerticalGradientUtilHandler,
  fillPatternUtilHandler,
  fillColorUtilHandler,
} from './lower-bindings-fill'
import {
  strokeDasharrayBindingHandler,
  strokeGapBindingHandler,
  strokeTranslateXBindingHandler,
  strokeTranslateYBindingHandler,
  strokeOpacityBindingHandler,
  strokeBindingHandler,
  lineCapJoinUtilHandlers,
} from './lower-bindings-line'
import {
  opacityZoomBindingHandler,
  sizeZoomBindingHandler,
  fillTranslateXBindingHandler,
  fillTranslateYBindingHandler,
  circleTranslateXBindingHandler,
  circleTranslateYBindingHandler,
  fillExtrusionHeightBindingHandler,
  fillExtrusionBaseBindingHandler,
  bindingFallthroughHandler,
  translateConstUtilHandlers,
  circleTranslateConstUtilHandlers,
  strokeTranslateConstUtilHandlers,
  fillExtrusionConstUtilHandlers,
  miscUtilHandlers,
  modifierFillHandler,
} from './lower-bindings-paint'

/** Modifier-item handlers (run after the X-GIS0001 deprecated-z<N> check in
 *  the driver). Only the `fill-*` colour modifier exists. */
export const MODIFIER_HANDLERS: BindingHandler[] = [modifierFillHandler]

/** Binding-form ladder. Order mirrors lower.ts lines ~521–746:
 *  zoom-guarded arms first (dasharray, opacity, size, stroke-gap, the four
 *  translate axes, stroke-opacity), then the named arms (fill, stroke,
 *  fill-extrusion height/base), then the numeric-const + X-GIS0005
 *  fallthrough LAST. opacity/size fuse their zoom + named-data-driven bodies
 *  into one handler (placed at the zoom position) — faithful because the
 *  original named opacity/size arms only ran when the zoom guard failed. */
export const BINDING_HANDLERS: BindingHandler[] = [
  strokeDasharrayBindingHandler,
  opacityZoomBindingHandler,
  sizeZoomBindingHandler,
  strokeGapBindingHandler,
  fillTranslateXBindingHandler,
  fillTranslateYBindingHandler,
  circleTranslateXBindingHandler,
  circleTranslateYBindingHandler,
  strokeTranslateXBindingHandler,
  strokeTranslateYBindingHandler,
  strokeOpacityBindingHandler,
  fillBindingHandler,
  strokeBindingHandler,
  fillExtrusionHeightBindingHandler,
  fillExtrusionBaseBindingHandler,
  // LAST: numeric-const translate fallbacks + the X-GIS0005 catch-all.
  bindingFallthroughHandler,
]

/** Utility-form ladder. Order mirrors lower.ts lines ~754–987:
 *  fill-translate consts, fill-antialias/vgradient flags, circle-translate +
 *  blur consts, stroke-translate consts, then fill-extrusion consts,
 *  fill-pattern, fill colour, all stroke cap/join/dash/offset/pattern/blur/
 *  image/width-or-colour arms, then opacity/size/projection/visibility/
 *  shape/pointer/animation. (label-* arms are skipped by the driver before
 *  this list, exactly as the original `name.startsWith('label-')` guards.) */
export const UTILITY_HANDLERS: BindingHandler[] = [
  ...translateConstUtilHandlers,
  fillAntialiasUtilHandler,
  fillExtrusionVerticalGradientUtilHandler,
  ...circleTranslateConstUtilHandlers,
  ...strokeTranslateConstUtilHandlers,
  ...fillExtrusionConstUtilHandlers,
  fillPatternUtilHandler,
  fillColorUtilHandler,
  ...lineCapJoinUtilHandlers,
  ...miscUtilHandlers,
]
