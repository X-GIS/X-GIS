// Per-op expression-handler registry.
//
// Assembles a Map<op, ExprHandler> from the per-cluster modules. The
// `_exprToXgisImpl` dispatcher in expressions.ts owns the recursion
// guard + scalar prelude + unsupported-op fallback, then looks a
// handler up here. Each handler is the verbatim body of one original
// `switch(op)` arm — preserving the SAME emission and the SAME
// warnings[] push order. New ops are appended here (a single, isolated
// registration line) rather than threaded into the god-switch.

import type { ExprHandler } from './expr-handler-types'
import { convertInterpolate } from './expr-interpolate'
import { convertMatch } from './expr-match'
import {
  comparisonHandler, addMulHandler, subtractHandler, divModHandler,
  minMaxHandler, powHandler, unaryMathHandler, mathConstantHandler,
} from './expr-arithmetic'
import {
  coalesceHandler, caseHandler, allHandler, anyHandler, notHandler,
} from './expr-logic'
import {
  getHandler, hasHandler, notHasHandler, atHandler, typeofHandler,
  zoomHandler, pitchHandler, geometryTypeHandler, idHandler, inHandler,
} from './expr-lookup'
import {
  literalHandler, arrayHandler, typeCoercionHandler, concatHandler,
  formatHandler, stepHandler, letHandler, varHandler, sliceHandler,
  indexOfHandler, numberFormatHandler, rgbHandler,
} from './expr-string'

// `match` / `interpolate` already live in their own modules with a
// `(v, warnings, recurse)` signature; adapt them to ExprHandler.
const matchHandler: ExprHandler = (v, warnings, recurse) => convertMatch(v, warnings, recurse)
const interpolateHandler: ExprHandler = (v, warnings, recurse) => convertInterpolate(v, warnings, recurse)

/** op string → handler. Insertion order is irrelevant (Map lookup),
 *  but kept grouped by cluster for readability. */
export const EXPR_HANDLERS: Map<string, ExprHandler> = new Map([
  // string / value-shaping
  ['literal', literalHandler],
  // lookup / accessors
  ['get', getHandler],
  ['has', hasHandler],
  ['!has', notHasHandler],
  // logic
  ['coalesce', coalesceHandler],
  ['case', caseHandler],
  ['match', matchHandler],
  ['all', allHandler],
  ['any', anyHandler],
  ['!', notHandler],
  // comparison
  ['==', comparisonHandler],
  ['!=', comparisonHandler],
  ['<', comparisonHandler],
  ['<=', comparisonHandler],
  ['>', comparisonHandler],
  ['>=', comparisonHandler],
  // arithmetic
  ['+', addMulHandler],
  ['*', addMulHandler],
  ['-', subtractHandler],
  ['/', divModHandler],
  ['%', divModHandler],
  // string / value-shaping
  ['array', arrayHandler],
  // arithmetic — min / max
  ['min', minMaxHandler],
  ['max', minMaxHandler],
  // type coercion
  ['to-number', typeCoercionHandler],
  ['number', typeCoercionHandler],
  ['to-string', typeCoercionHandler],
  ['string', typeCoercionHandler],
  ['to-boolean', typeCoercionHandler],
  ['boolean', typeCoercionHandler],
  ['to-color', typeCoercionHandler],
  // interpolate family
  ['interpolate', interpolateHandler],
  ['interpolate-lab', interpolateHandler],
  ['interpolate-hcl', interpolateHandler],
  // math + trig + log builtins
  ['^', powHandler],
  ['abs', unaryMathHandler],
  ['ceil', unaryMathHandler],
  ['floor', unaryMathHandler],
  ['round', unaryMathHandler],
  ['sqrt', unaryMathHandler],
  ['sin', unaryMathHandler],
  ['cos', unaryMathHandler],
  ['tan', unaryMathHandler],
  ['asin', unaryMathHandler],
  ['acos', unaryMathHandler],
  ['atan', unaryMathHandler],
  ['ln', unaryMathHandler],
  ['log10', unaryMathHandler],
  ['log2', unaryMathHandler],
  ['length', unaryMathHandler],
  ['downcase', unaryMathHandler],
  ['upcase', unaryMathHandler],
  // zero-arg numeric constants
  ['pi', mathConstantHandler],
  ['e', mathConstantHandler],
  ['ln2', mathConstantHandler],
  // string / value-shaping
  ['concat', concatHandler],
  ['format', formatHandler],
  ['step', stepHandler],
  ['let', letHandler],
  ['var', varHandler],
  // lookup / accessors
  ['at', atHandler],
  ['typeof', typeofHandler],
  // string / value-shaping
  ['slice', sliceHandler],
  ['index-of', indexOfHandler],
  ['number-format', numberFormatHandler],
  ['rgb', rgbHandler],
  ['rgba', rgbHandler],
  // zero-arg feature accessors
  ['zoom', zoomHandler],
  ['pitch', pitchHandler],
  ['geometry-type', geometryTypeHandler],
  ['id', idHandler],
  // lookup — in
  ['in', inHandler],
])
