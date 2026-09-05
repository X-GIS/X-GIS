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
  // Descend into a nested `let` instead of stopping at it: MapLibre
  // threads outer bindings through nested `let` scopes (lexical
  // scoping is spec-legal), and a bare `["var", name]` a few `let`s
  // deep must still resolve. Reconstruct the node with the outer
  // bindings substituted into place: each binding VALUE expression
  // is substituted against `bindings` only — it is evaluated in the
  // ENCLOSING scope, matching `letHandler`'s (expr-string.ts) own
  // convention of not resolving a binding against its own let's
  // siblings — while the BODY is substituted against a copy of
  // `bindings` overlaid with this let's own names, so an inner name
  // shadows an outer one of the same name. A malformed nested `let`
  // (wrong arg count) is left untouched; the recursive re-entry into
  // `letHandler` on the reconstructed node still reports it.
  // `visited` (added for this node above) still catches a truly
  // self-referential node before any of this runs, so a cycle
  // returns unchanged rather than recursing forever.
  if (expr[0] === 'let') {
    const args = expr.slice(1)
    if (args.length < 3 || args.length % 2 === 0) return expr
    const body = args[args.length - 1]
    const merged = new Map(bindings)
    const rebuilt: unknown[] = ['let']
    for (let i = 0; i < args.length - 1; i += 2) {
      const name = args[i]
      const value = substituteVars(args[i + 1], bindings, visited)
      rebuilt.push(name, value)
      if (typeof name === 'string') merged.set(name, value)
    }
    rebuilt.push(substituteVars(body, merged, visited))
    return rebuilt
  }
  return expr.map((c) => substituteVars(c, bindings, visited))
}
