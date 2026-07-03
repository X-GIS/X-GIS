// Numeric / comparison expression cluster → xgis.
//
// Extracted verbatim from expressions.ts's `_exprToXgisImpl` switch:
// the comparison operators (== != < <= > >=), the arithmetic operators
// (+ - * / % ^), the unary/variadic math + trig + log builtins, the
// zero-arg numeric constants (pi / e / ln2), and min / max. Each handler
// is the byte-identical body of its original switch arm; recursion is a
// parameter to avoid importing expressions.ts (cycle).

import type { ExprHandler } from './expr-handler-types'
import { extractCollatorOpts } from './collator-opts'

// Comparison operators. Mapbox spec allows a trailing
// `["collator", {…}]` arg that controls case-sensitivity /
// locale-aware ordering of string compares (`["==", a, b,
// ["collator", { "case-sensitive": false }]]`). X-GIS string
// comparison is byte-exact — we drop the collator with a warning
// and proceed with the bare a/b. Without this branch the 4-arg
// form fell to the length-check below and returned null, hiding
// the entire predicate.
export const comparisonHandler: ExprHandler = (v, warnings, recurse, _recurseFilter, op) => {
  if (v.length === 4) {
    const collator = v[3]
    if (Array.isArray(collator) && collator[0] === 'collator') {
      const a = recurse(v[1], warnings)
      const b = recurse(v[2], warnings)
      if (a === null || b === null) return null
      // Constant collator options → lower to the CPU locale-aware compare
      // builtin (eval/collator.ts). Non-constant options can't be baked
      // into the call, so fall back to byte-exact compare with a warning.
      const opts = extractCollatorOpts(collator)
      if (opts === null) {
        warnings.push(
          `["${op}"] ["collator", …] has non-constant options — locale-aware compare needs literal case-sensitive / diacritic-sensitive / locale; falling back to byte-exact compare.`,
        )
        return `${a} ${op} ${b}`
      }
      return `collator_cmp(${JSON.stringify(op)}, ${a}, ${b}, ${JSON.stringify(opts.locale)}, ${opts.caseSensitive}, ${opts.diacriticSensitive})`
    }
  }
  if (v.length !== 3) return null
  const a = recurse(v[1], warnings)
  const b = recurse(v[2], warnings)
  if (a === null || b === null) return null
  return `${a} ${op} ${b}`
}

// Arithmetic operators. Mapbox spec: `+`/`*` variadic (≥ 2 args);
// `-` unary (negation) OR binary; `/`/`%` strictly binary. Pre-fix
// the shared comparison branch required EXACTLY 2 operands, so the
// variadic/unary forms returned null and silently collapsed the
// whole containing case/interpolate/paint value. Evaluator supports
// binary +,-,*,/,% and unary -; `(a + b + c)` parses left-assoc.
export const addMulHandler: ExprHandler = (v, warnings, recurse, _recurseFilter, op) => {
  if (v.length < 3) {
    warnings.push(`["${op}"] expects at least 2 arguments, got ${v.length - 1}.`)
    return null
  }
  const parts = v.slice(1).map((a) => recurse(a, warnings))
  if (parts.some((p) => p === null)) return null
  return `(${parts.join(` ${op} `)})`
}

export const subtractHandler: ExprHandler = (v, warnings, recurse) => {
  if (v.length === 2) {
    const a = recurse(v[1], warnings)
    return a === null ? null : `(-(${a}))`
  }
  if (v.length === 3) {
    const a = recurse(v[1], warnings)
    const b = recurse(v[2], warnings)
    if (a === null || b === null) return null
    return `${a} - ${b}`
  }
  warnings.push(`["-"] expects 1 or 2 arguments, got ${v.length - 1}.`)
  return null
}

export const divModHandler: ExprHandler = (v, warnings, recurse, _recurseFilter, op) => {
  if (v.length !== 3) {
    warnings.push(`["${op}"] expects exactly 2 arguments, got ${v.length - 1}.`)
    return null
  }
  const a = recurse(v[1], warnings)
  const b = recurse(v[2], warnings)
  if (a === null || b === null) return null
  return `${a} ${op} ${b}`
}

export const minMaxHandler: ExprHandler = (v, warnings, recurse, _recurseFilter, op) => {
  // Mapbox spec: ≥ 1 argument required. Pre-fix `["min"]` /
  // `["max"]` (zero args) returned null silently with no
  // diagnostic; same for partial-drop when some args failed
  // to convert (the result misleadingly succeeded with fewer
  // operands than authored).
  if (v.length < 2) {
    warnings.push(`Malformed ["${op}"] expression: expected at least 1 argument, got 0.`)
    return null
  }
  const rawCount = v.length - 1
  const args = v
    .slice(1)
    .map((x) => recurse(x, warnings))
    .filter((s): s is string => s !== null)
  if (args.length < rawCount) {
    warnings.push(
      `["${op}"] dropped ${rawCount - args.length} of ${rawCount} arg(s) that failed to convert; result may differ from authored intent.`,
    )
  }
  return args.length > 0 ? `${op}(${args.join(', ')})` : null
}

// ─── Batch 6: math + trig + log builtins ───
// All of these have a 1:1 evaluator builtin (callBuiltin in
// compiler/src/eval/evaluator.ts). The converter just wraps the
// operands in a function-call shape the parser turns back into a
// FnCall expression.
export const powHandler: ExprHandler = (v, warnings, recurse) => {
  // Mapbox `["^", a, b]` → xgis `pow(a, b)`. Two args required.
  if (v.length !== 3) {
    warnings.push(`Malformed ["^"] expression: expected 2 arguments, got ${v.length - 1}.`)
    return null
  }
  const a = recurse(v[1], warnings)
  const b = recurse(v[2], warnings)
  if (a === null || b === null) return null
  return `pow(${a}, ${b})`
}

export const unaryMathHandler: ExprHandler = (v, warnings, recurse, _recurseFilter, op) => {
  // Mapbox spec: all of these take exactly one argument.
  // A bare `["abs"]` (no operand) used to silently drop because
  // exprToXgis(undefined) returns null; the user got no
  // diagnostic and wondered why the abs() didn't convert.
  if (v.length !== 2) {
    warnings.push(`Malformed ["${op}"] expression: expected 1 argument, got ${v.length - 1}.`)
    return null
  }
  const inner = recurse(v[1], warnings)
  return inner !== null ? `${op}(${inner})` : null
}

export const mathConstantHandler: ExprHandler = (v, warnings, _recurse, _recurseFilter, op) => {
  // Zero-arg constants — Mapbox emits `["pi"]`. The evaluator
  // resolves these as builtin calls with empty arg lists.
  // Extra args would be silently dropped — warn so the author
  // doesn't accidentally pass operands to a no-arg constant.
  if (v.length !== 1) {
    warnings.push(
      `Malformed ["${op}"] expression: zero-arg constant takes no arguments, got ${v.length - 1}.`,
    )
  }
  return `${op}()`
}
