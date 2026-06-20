// Boolean-logic / branching expression cluster → xgis.
//
// Extracted verbatim from expressions.ts's `_exprToXgisImpl` switch:
// the coalesce / case / all / any / ! arms. `all` / `any` / `!` recurse
// through the FILTER converter (`recurseFilter`); coalesce / case recurse
// through the expression converter (`recurse`). Both entrypoints are
// passed in to avoid importing expressions.ts (cycle).

import { parenthesize, parenthesizeTernary } from './utils'
import type { ExprHandler } from './expr-handler-types'

export const coalesceHandler: ExprHandler = (v, warnings, recurse) => {
  // Mapbox spec: at least one argument required.
  if (v.length < 2) {
    warnings.push(`Malformed ["coalesce"] expression: expected at least 1 argument, got 0.`)
    return null
  }
  const args = v.slice(1).map(a => recurse(a, warnings))
  const valid = args.filter((a): a is string => a !== null)
  // Surface partial-drop when SOME but not all args converted —
  // pre-fix the invalid arms vanished silently so a coalesce
  // expression that authored a fallback chain
  // `["coalesce", ["image", "icon"], ["literal", "#abc"]]` could
  // drop the unsupported `image` head and the runtime would always
  // hit the colour fallback even when the icon was meant to
  // resolve. Total-failure (length === 0) keeps the existing
  // bail-to-null so callers know nothing converted.
  if (valid.length === 0) return null
  if (valid.length < args.length) {
    warnings.push(`["coalesce"] dropped ${args.length - valid.length} of ${args.length} args that failed to convert; resulting fallback chain may differ from the authored intent.`)
  }
  // Parenthesize ternary arms so the `??` fallback can't migrate
  // into a non-final arm's else-branch (parser puts `?:` above `??`).
  return valid.map(parenthesizeTernary).join(' ?? ')
}

export const caseHandler: ExprHandler = (v, warnings, recurse) => {
  // ["case", cond1, val1, cond2, val2, …, default]
  // → cond1 ? val1 : cond2 ? val2 : … : default
  const args = v.slice(1)
  if (args.length < 3 || args.length % 2 === 0) {
    warnings.push(`Malformed ["case"] expression: ${JSON.stringify(v).slice(0, 120)}`)
    return null
  }
  const def = recurse(args[args.length - 1], warnings)
  // Fall back to `null` (not `0`) when the default arm fails to
  // convert. Pre-fix the numeric '0' fallback type-mismatched
  // colour cases — the runtime received '0' where a hex was
  // expected and the layer rendered transparent. `null` reads
  // as the Identifier(null), which the evaluator coerces by
  // context (colour → no fill default; number → 0; bool → false).
  let result = def ?? 'null'
  let droppedArms = 0
  for (let i = args.length - 3; i >= 0; i -= 2) {
    const cond = recurse(args[i], warnings)
    const val = recurse(args[i + 1], warnings)
    if (cond === null || val === null) { droppedArms++; continue }
    result = `${cond} ? ${val} : ${result}`
  }
  // Surface partial-drop: a case arm whose cond OR val failed to
  // convert was previously silently skipped — the resulting
  // ternary chain fell through to the default for that condition
  // with NO diagnostic. Real styles with one experimental arm
  // (e.g. `["image", …]` head, currently unsupported) would lose
  // the entire conditional path silently.
  if (droppedArms > 0) {
    warnings.push(`["case"] dropped ${droppedArms} arm(s) whose cond or value failed to convert; remaining chain may collapse to default for the affected conditions.`)
  }
  return result
}

export const allHandler: ExprHandler = (v, warnings, _recurse, recurseFilter) => {
  const rawCount = v.length - 1
  const parts = v.slice(1).map(a => recurseFilter(a, warnings)).filter((s): s is string => !!s)
  // Surface partial-drop — pre-fix a sub-filter that couldn't
  // convert (e.g. `["image", …]` head) silently disappeared
  // from the AND chain, so `["all", real-filter, unsupported]`
  // collapsed to just `real-filter` and the layer's authored
  // AND constraint was lost.
  if (parts.length < rawCount && rawCount > 0) {
    warnings.push(`["all"] dropped ${rawCount - parts.length} of ${rawCount} sub-filter(s) that failed to convert; remaining AND chain is more permissive than the authored intent.`)
  }
  if (parts.length === 0) return 'true'
  return parts.map(parenthesize).join(' && ')
}

export const anyHandler: ExprHandler = (v, warnings, _recurse, recurseFilter) => {
  const rawCount = v.length - 1
  const parts = v.slice(1).map(a => recurseFilter(a, warnings)).filter((s): s is string => !!s)
  // Same partial-drop pattern as ["all"]. OR-chains hurt
  // DIFFERENTLY — dropping an arm narrows the accepted set, so
  // the layer becomes MORE restrictive than the author intended.
  if (parts.length < rawCount && rawCount > 0) {
    warnings.push(`["any"] dropped ${rawCount - parts.length} of ${rawCount} sub-filter(s) that failed to convert; remaining OR chain accepts fewer features than the authored intent.`)
  }
  if (parts.length === 0) return 'false'
  return parts.map(parenthesize).join(' || ')
}

export const notHandler: ExprHandler = (v, warnings, _recurse, recurseFilter) => {
  if (v.length < 2) {
    warnings.push(`Malformed ["!"] expression: missing inner filter argument.`)
    return null
  }
  const inner = recurseFilter(v[1], warnings)
  return inner ? `!(${inner})` : null
}
