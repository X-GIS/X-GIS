// ═══ Mapbox expression conversion: pure helpers ═══
// Side-effect-free helpers extracted from expressions.ts. Each operates
// purely on its arguments and closes over no module state. Kept here so
// expressions.ts stays focused on the conversion pipeline.

/** Recursively replace `["var", "name"]` nodes with their bound
 *  expression. Used by the `let` lowering — Mapbox lets are pure,
 *  so substitution is semantically equivalent to a runtime scope
 *  lookup and lets the rest of the converter walk a flat tree.
 *  `visited` short-circuits if the same node is re-entered (defensive
 *  against malformed input with circular references built up by a
 *  preprocessor; Mapbox styles in the wild are pure JSON so this is
 *  belt-and-braces). */
export function substituteVars(
  expr: unknown,
  bindings: Map<string, unknown>,
  visited: WeakSet<object> = new WeakSet(),
): unknown {
  if (!Array.isArray(expr)) return expr
  if (visited.has(expr)) return expr
  visited.add(expr)
  if (expr[0] === 'var' && typeof expr[1] === 'string') {
    return bindings.has(expr[1]) ? bindings.get(expr[1]) : expr
  }
  // Don't recurse into nested `let`s — their inner `var` references
  // belong to the inner scope. A heuristic, but matches the way
  // Mapbox styles in the wild are written (no shadowing).
  if (expr[0] === 'let') return expr
  return expr.map(c => substituteVars(c, bindings, visited))
}
