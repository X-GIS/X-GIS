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
 *  Replace anything outside the allowed set with `_`. Reserved xgis
 *  keywords (`place`, `source`, `layer`, …) get a `_` suffix because
 *  raw style ids like `"place"` or `"layer"` from OpenMapTiles /
 *  OSM Liberty would otherwise produce a parse error. */
// Mirrors compiler/src/lexer/tokens.ts:KEYWORDS — keep in sync if
// new keywords land. Unit suffixes (px/m/km/…) are excluded; they
// only tokenise as units after a number, not in identifier position.
const XGIS_RESERVED = new Set([
  'let', 'fn', 'show', 'place', 'view', 'on', 'if', 'else', 'for', 'in',
  'return', 'simulate', 'analyze', 'import', 'struct', 'enum',
  'source', 'layer', 'background', 'preset', 'from', 'to', 'export',
  'symbol', 'style', 'keyframes',
  'true', 'false',
])
export function sanitizeId(s: string): string {
  let cleaned = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) ? s : s.replace(/[^a-zA-Z0-9_]/g, '_')
  // An id that starts with a digit ("1km-grid", "3d-buildings", …) — the
  // dash-replacement above doesn't help: the result still starts with a
  // digit and the parser rejects it at lex time. Prefix with `_` so the
  // identifier is well-formed without losing the original token.
  // Pre-fix Mapbox styles authored with digit-leading layer ids (common
  // in OSM tooling and gridded overlays) failed conversion silently —
  // the emitted layer block parsed as an expression, the whole style
  // failed to load.
  if (/^[0-9]/.test(cleaned)) cleaned = `_${cleaned}`
  return XGIS_RESERVED.has(cleaned) ? `${cleaned}_` : cleaned
}
