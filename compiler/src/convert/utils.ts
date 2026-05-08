// String-shaping helpers used across the Mapbox → xgis converter.
// Kept tiny so the topology of the rest of the converter stays
// readable — every other module imports from here, never the
// other way round.

/** Short numeric / identifier values stay bare (`stroke-1.5`); any
 *  expression-shaped string gets wrapped in `[…]` so the xgis
 *  utility lexer recognises the data-driven form. */
export function maybeBracket(x: string): string {
  if (/^-?\d+(\.\d+)?$/.test(x)) return x
  if (/^[\w-]+$/.test(x)) return x
  return `[${x}]`
}

/** Wrap with parens when the string contains binary operators that
 *  could re-bind under outer `&&` / `||`. */
export function parenthesize(s: string): string {
  return / (\?\?|\|\||&&|==|!=|<|>|<=|>=|\+|-|\*|\/|%) /.test(s) ? `(${s})` : s
}

/** xgis identifiers must be `[a-zA-Z_][a-zA-Z0-9_]*` — Mapbox often
 *  uses kebab-case (`landcover_glacier` is fine, `road-major` isn't).
 *  Replace anything outside the allowed set with `_`. */
export function sanitizeId(s: string): string {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) ? s : s.replace(/[^a-zA-Z0-9_]/g, '_')
}
