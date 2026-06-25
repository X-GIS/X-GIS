// ═══ AST → IR Lowering: pure binding helpers ═══
// Side-effect-free helpers extracted from lower.ts. Each operates purely
// on an AST.Expr and returns a value or null; none close over module
// state. Kept here so lower.ts stays focused on the lowering pipeline.

import type * as AST from '../parser/ast'
import { parseExpressionString } from '../parser/parser'
import { parseTextTemplate, isBareExpressionTemplate } from '../format'
import type { TextValue, TextPart } from './render-node'
import type { ZoomStopsWithBase } from './lower-types'

/** Convert the AST.Expr bound to a `label-[<binding>]` utility into
 *  a TextValue. When the binding is a string literal we treat it as
 *  a text template (see compiler/src/format/template-parser.ts) so
 *  patterns like `label-["Lat: {lat:.4f}°N"]` resolve into per-feature
 *  formatted strings. Bare-expression bindings (`label-[.name]`) and
 *  templates that collapse to a single bare interp (`label-["{name}"]`)
 *  return the legacy `kind:'expr'` shape so the renderer doesn't have
 *  to walk a single-part template at runtime. */
export function bindingToTextValue(binding: AST.Expr): TextValue {
  if (binding.kind !== 'StringLiteral') {
    return { kind: 'expr', expr: { ast: binding } }
  }
  const parts = parseTextTemplate(binding.value)
  // "abc" with no interps — wrap as a single-literal template so the
  // text resolver always emits the constant string. Don't try to coax
  // it into kind:'expr' (DataExpr expects an AST, not a string).
  if (parts.length === 0) {
    return { kind: 'template', parts: [{ kind: 'literal', value: '' }] }
  }
  if (isBareExpressionTemplate(parts)) {
    const interp = parts[0] as { kind: 'interp'; text: string }
    return { kind: 'expr', expr: { ast: parseExpressionString(interp.text) } }
  }
  const irParts: TextPart[] = parts.map(p => {
    if (p.kind === 'literal') return { kind: 'literal', value: p.text }
    return {
      kind: 'interp',
      expr: { ast: parseExpressionString(p.text) },
      ...(p.spec ? { spec: p.spec } : {}),
    }
  })
  return { kind: 'template', parts: irParts }
}

/** Extract a constant number from a utility binding, supporting the
 *  bracket form for negatives that the utility-name grammar can't
 *  express inline (`label-offset-y-[-0.2]`, `label-rotate-[-30]`).
 *  Accepts a `NumberLiteral` directly OR a `UnaryExpr` wrapping one.
 *  Returns null for anything else (data-driven / non-numeric) — caller
 *  falls through to its data-driven branch. */
export function bindingAsConstantNumber(binding: AST.Expr): number | null {
  if (binding.kind === 'NumberLiteral') return binding.value
  if (binding.kind === 'UnaryExpr' && binding.op === '-'
      && binding.operand.kind === 'NumberLiteral') {
    return -binding.operand.value
  }
  return null
}

/** When the binding is `match(.field) { "k" -> #color, …, _ -> #color }`,
 *  pull the default arm's colour out as a hex string. Used by the
 *  `name === 'fill'` arm to provide a constant fallback when the
 *  full per-feature data-driven path isn't yet wired through to the
 *  fill renderer. The converter lowers Mapbox `["match", input, k,
 *  v, …, default]` into this shape via `expressions.ts:111`. */
export function extractMatchDefaultColor(expr: AST.Expr): string | null {
  // Match form: `match(.field) { v -> #colour, …, _ -> #default }`.
  if (expr.kind === 'FnCall'
      && expr.callee.kind === 'Identifier'
      && expr.callee.name === 'match'
      && expr.matchBlock) {
    for (const arm of expr.matchBlock.arms) {
      if (arm.pattern === '_') {
        if (arm.value.kind === 'ColorLiteral') return arm.value.value
        // The converter sometimes wraps the default in resolveColor at
        // emit time; we accept hex-shaped string literals too.
        if (arm.value.kind === 'StringLiteral' && /^#/.test(arm.value.value)) {
          return arm.value.value
        }
      }
    }
    return null
  }
  // Ternary / `case()` form: `cond ? #c1 : cond2 ? #c2 : #default`.
  // The converter's case-lowering emits a right-leaning ConditionalExpr
  // chain (`expressions.ts` case 'case'). Walk down the elseExpr side
  // until we hit a ColorLiteral or hex-shaped StringLiteral leaf —
  // that's the default arm. Any branch returning a non-colour leaf
  // (number, identifier, etc.) means this isn't a colour expression
  // and we bail with null so the caller routes through the width path.
  if (expr.kind === 'ConditionalExpr') {
    let cur: AST.Expr = expr
    while (cur.kind === 'ConditionalExpr') {
      // Check the THEN branch carries a colour leaf — first non-colour
      // branch disqualifies the whole expression.
      const t = cur.thenExpr
      if (t.kind === 'ColorLiteral') {
        // ok
      } else if (t.kind === 'StringLiteral' && /^#/.test(t.value)) {
        // ok
      } else {
        return null
      }
      cur = cur.elseExpr
    }
    if (cur.kind === 'ColorLiteral') return cur.value
    if (cur.kind === 'StringLiteral' && /^#/.test(cur.value)) return cur.value
    return null
  }
  // Coalesce form: `.a ?? .b ?? "#default"` — the converter emits this
  // for Mapbox `["coalesce", ["get","a"], ["get","b"], <hex>]`. The
  // chain is right-leaning BinaryExpr nodes with op '??'; the deepest
  // right operand is the default. Walk down right.right.right… until
  // we hit a non-'??' operator; if THAT leaf is a colour literal /
  // hex StringLiteral, the whole expression is colour-shaped. Any
  // non-colour leaf disqualifies (a coalesce returning numbers /
  // booleans / strings belongs on a different paint axis).
  if (expr.kind === 'BinaryExpr' && expr.op === '??') {
    let cur: AST.Expr = expr
    while (cur.kind === 'BinaryExpr' && cur.op === '??') {
      cur = cur.right
    }
    if (cur.kind === 'ColorLiteral') return cur.value
    if (cur.kind === 'StringLiteral' && /^#/.test(cur.value)) return cur.value
    return null
  }
  return null
}

/** Detect the `interpolate(zoom, k1, v1, k2, v2, …)` call shape and
 *  extract numeric (zoom, value) stops. Returns null when the AST
 *  isn't that exact shape — other inputs (feature properties, etc.)
 *  or non-numeric values fall through to the generic data-driven
 *  evaluator path. Used by the binding lowerer to short-circuit
 *  zoom-only uses straight onto the existing ZoomStop<number>[]
 *  zoom-interpolation infrastructure (no per-frame eval, no per-
 *  feature plumbing — the existing kind:'zoom-interpolated' code
 *  paths in the runtime do the heavy lifting). */
export function extractInterpolateZoomStops(
  expr: AST.Expr,
): ZoomStopsWithBase<number> | null {
  if (expr.kind !== 'FnCall') return null
  if (expr.callee.kind !== 'Identifier') return null
  const calleeName = expr.callee.name
  const isExp = calleeName === 'interpolate_exp'
  if (!isExp && calleeName !== 'interpolate') return null
  const args = expr.args
  if (args.length < 3) return null
  // Exponential carries a leading `base` argument before the zoom keyword:
  //   interpolate_exp(zoom, BASE, z1, v1, z2, v2, …)
  // Linear:
  //   interpolate(zoom, z1, v1, z2, v2, …)
  // So peel the base first when exponential, then the rest is identical.
  let cursor = 0
  const input = args[cursor++]
  if (input.kind !== 'Identifier' || input.name !== 'zoom') return null
  let base = 1
  if (isExp) {
    const baseArg = args[cursor++]
    if (baseArg === undefined || baseArg.kind !== 'NumberLiteral') return null
    base = baseArg.value
  }
  // Remaining args must alternate (numeric zoom, numeric value).
  const remaining = args.length - cursor
  if (remaining < 4 || remaining % 2 !== 0) return null
  const stops: Array<{ zoom: number; value: number }> = []
  for (let i = cursor; i + 1 < args.length; i += 2) {
    // Accept both bare NumberLiteral and `-N` UnaryExpr around one
    // (negative-stop interpolations like stroke-offset / text-rotate
    // fall to UnaryExpr in the parser). Reuse the existing
    // bindingAsConstantNumber helper so the rule stays in one place.
    const z = bindingAsConstantNumber(args[i])
    const v = bindingAsConstantNumber(args[i + 1])
    if (z === null || v === null) return null
    stops.push({ zoom: z, value: v })
  }
  return stops.length >= 2 ? { base, stops } : null
}

/** Detect the `step(zoom, default, z1, v1, z2, v2, …)` call shape and
 *  extract numeric zoom stops. Returns null when the AST isn't that exact
 *  shape — other inputs (feature properties, etc.) or non-numeric values
 *  fall through to the generic data-driven path.
 *
 *  Mapbox `["step", ["zoom"], def, z1, v1, z2, v2, …]` semantics:
 *    zoom < z1  → def
 *    zoom ≥ z1  → v1
 *    zoom ≥ z2  → v2   … etc.
 *
 *  Represented in the existing zoom-interpolated infrastructure by
 *  emitting each boundary as two adjacent stops:
 *    [{zoom: z1, value: def}, {zoom: z1 + ε, value: v1}, …]
 *  Before z1 the function clamps to `def`; at z1+ε it snaps to the new
 *  value. ε = 0.0001 zoom units is imperceptible but forces the linear
 *  interpolator to pass through the step boundary cleanly. */
export function extractStepZoomStops(
  expr: AST.Expr,
): ZoomStopsWithBase<number> | null {
  if (expr.kind !== 'FnCall') return null
  if (expr.callee.kind !== 'Identifier') return null
  if (expr.callee.name !== 'step') return null
  const args = expr.args
  // step(zoom, default, z1, v1, …) — even arg count, at least 4.
  if (args.length < 4 || args.length % 2 !== 0) return null
  const input = args[0]
  if (input.kind !== 'Identifier' || input.name !== 'zoom') return null
  const defVal = bindingAsConstantNumber(args[1])
  if (defVal === null) return null
  const STEP_EPSILON = 0.0001
  const stops: Array<{ zoom: number; value: number }> = []
  let prevValue = defVal
  for (let i = 2; i + 1 < args.length; i += 2) {
    const z = bindingAsConstantNumber(args[i])
    const v = bindingAsConstantNumber(args[i + 1])
    if (z === null || v === null) return null
    stops.push({ zoom: z, value: prevValue })
    stops.push({ zoom: z + STEP_EPSILON, value: v })
    prevValue = v
  }
  return stops.length >= 2 ? { base: 1, stops } : null
}

/** Pull `(zoom, number[])` stops from `interpolate(zoom, z0, [a,b], z1,
 *  [c,d], …)` — the line-dasharray zoom form. Returns null when the
 *  expression isn't a zoom interpolate OR any stop value isn't a numeric
 *  ArrayLiteral of length ≥ 2. Mapbox `line-dasharray` is
 *  `interpolated: false`, so the runtime STEPS to the nearest stop
 *  (resolveArrayShape) rather than lerping arrays of possibly-different
 *  length. Dash values are non-negative (clamped here, same as the
 *  constant addStrokeDash path). */
export function extractInterpolateZoomArrayStops(
  expr: AST.Expr,
): { base: number; stops: Array<{ zoom: number; value: number[] }> } | null {
  if (expr.kind !== 'FnCall') return null
  if (expr.callee.kind !== 'Identifier') return null
  const calleeName = expr.callee.name
  const isExp = calleeName === 'interpolate_exp'
  if (!isExp && calleeName !== 'interpolate') return null
  const args = expr.args
  let cursor = 0
  const input = args[cursor++]
  if (input === undefined || input.kind !== 'Identifier' || input.name !== 'zoom') return null
  let base = 1
  if (isExp) {
    const baseArg = args[cursor++]
    if (baseArg === undefined || baseArg.kind !== 'NumberLiteral') return null
    base = baseArg.value
  }
  const remaining = args.length - cursor
  if (remaining < 4 || remaining % 2 !== 0) return null
  const stops: Array<{ zoom: number; value: number[] }> = []
  for (let i = cursor; i + 1 < args.length; i += 2) {
    const z = bindingAsConstantNumber(args[i]!)
    const valExpr = args[i + 1]!
    if (z === null || valExpr.kind !== 'ArrayLiteral') return null
    const arr: number[] = []
    for (const el of valExpr.elements) {
      const n = bindingAsConstantNumber(el)
      if (n === null) return null
      arr.push(Math.max(0, n))
    }
    if (arr.length < 2) return null
    stops.push({ zoom: z, value: arr })
  }
  return stops.length >= 2 ? { base, stops } : null
}

/** Pull the full set of `(zoom, color)` stops from an `interpolate(
 *  zoom, z0, c0, z1, c1, …)` binding. Returns null when the
 *  expression isn't an interpolate-by-zoom OR any value isn't a
 *  ColorLiteral. The runtime interpolates RGBA component-wise per
 *  frame so a colour fade at low zoom (e.g. text fading from grey
 *  at z5 to black at z14) matches Mapbox's continuous interp rather
 *  than snapping at one of the endpoints. */
export function extractInterpolateZoomColorStops(
  expr: AST.Expr,
): { base: number; stops: Array<{ zoom: number; value: string }> } | null {
  if (expr.kind !== 'FnCall') return null
  if (expr.callee.kind !== 'Identifier') return null
  const calleeName = expr.callee.name
  const isExp = calleeName === 'interpolate_exp'
  if (!isExp && calleeName !== 'interpolate') return null
  const args = expr.args
  // Exponential carries a leading `base` argument before the zoom keyword:
  //   interpolate_exp(zoom, BASE, z1, c1, z2, c2, …)
  // Linear:
  //   interpolate(zoom, z1, c1, z2, c2, …)
  // Mirrors the numeric extractInterpolateZoomStops shape. We peel
  // the `base` here for parity. The runtime side (interpolateZoomRgba
  // in render/renderer.ts) DOES honor a non-1 base on the linear-vs-
  // exponential branch as of iter 354 — but the IR `ColorValue` of
  // kind 'zoom-interpolated' currently doesn't carry the base field,
  // so callers of this extractor get only stops + the runtime always
  // sees base=1. Routing the base through ColorValue → renderer is a
  // follow-up: the runtime is ready, only the IR carrier needs the
  // field. Until then, exponential colour curves collapse to linear —
  // accurate enough for OFM-style 1-2-stop fades (per memory
  // project_ofm_parity_investigation_2026_05_12 — "zero observable
  // OFM impact").
  let cursor = 0
  const input = args[cursor++]
  if (input === undefined || input.kind !== 'Identifier' || input.name !== 'zoom') return null
  let base = 1
  if (isExp) {
    const baseArg = args[cursor++]
    if (baseArg === undefined || baseArg.kind !== 'NumberLiteral') return null
    base = baseArg.value
  }
  const remaining = args.length - cursor
  if (remaining < 4 || remaining % 2 !== 0) return null
  const stops: Array<{ zoom: number; value: string }> = []
  for (let i = cursor; i + 1 < args.length; i += 2) {
    const zArg = args[i]
    const vArg = args[i + 1]
    if (zArg.kind !== 'NumberLiteral') return null
    // Bare-hex `#abc` lowers to ColorLiteral; user-authored xgis or a
    // future converter path emitting JSON.stringify-quoted hex would
    // produce StringLiteral. Accept both shapes so hex stops survive
    // either lowering route.
    if (vArg.kind === 'ColorLiteral') {
      stops.push({ zoom: zArg.value, value: vArg.value })
    } else if (vArg.kind === 'StringLiteral' && /^#[0-9a-fA-F]{3,8}$/.test(vArg.value)) {
      stops.push({ zoom: zArg.value, value: vArg.value })
    } else {
      return null
    }
  }
  return stops.length >= 2 ? { base, stops } : null
}
