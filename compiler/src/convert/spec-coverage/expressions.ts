import type { CoverageEntry } from './types'

// ─── 6. Expression operators ──────────────────────────────────────────
export const EXPRESSIONS: readonly CoverageEntry[] = [
  // Lookups + control flow
  { name: 'literal',         status: 'supported', note: 'Scalar + array forms. Null-valued wrappers (`["literal", null]`) treated as "property omitted" by the paint-helper gate (isOmitted in paint.ts).', source: 'expressions.ts:33' },
  { name: 'get',             status: 'supported', note: 'Bare field for identifier-safe names; `get("name:xx")` for colon-bearing locale keys.', source: 'expressions.ts:25' },
  { name: 'has',             status: 'supported', source: 'expressions.ts:43' },
  { name: '!has',            status: 'supported', source: 'expressions.ts:52' },
  { name: 'coalesce',        status: 'supported', note: 'Lowers to xgis `??` chain.', source: 'expressions.ts:59' },
  { name: 'case',            status: 'supported', source: 'expressions.ts:65' },
  { name: 'match',           status: 'supported', note: 'Routes through `match() { … }` when input is FieldAccess; ternary fallback otherwise.', source: 'expressions.ts:83' },
  { name: 'step',            status: 'supported', source: 'expressions.ts:185' },
  { name: 'let / var',       status: 'supported', note: 'Pure substitution at convert time.', source: 'expressions.ts:199' },
  // Logic + comparison
  { name: 'all',             status: 'supported' },
  { name: 'any',             status: 'supported' },
  { name: '!',               status: 'supported' },
  { name: '== / != / < / <= / > / >=', status: 'supported' },
  { name: 'in',              status: 'supported', note: 'Both expression form and legacy form. Empty value list lowers to constant `false` per spec.', source: 'expressions.ts:560' },
  { name: '!in',             status: 'supported' },
  // Arithmetic + math
  { name: '+ / - / * / / / %', status: 'supported' },
  { name: 'min / max',       status: 'supported' },
  { name: '^ / abs / ceil / floor / round / sqrt', status: 'supported' },
  { name: 'sin / cos / tan / asin / acos / atan',  status: 'supported' },
  { name: 'ln / log10 / log2', status: 'supported' },
  { name: 'pi / e / ln2',    status: 'supported', note: 'Zero-arg constants.' },
  // String + array
  { name: 'concat',          status: 'supported' },
  { name: 'length',          status: 'supported' },
  { name: 'upcase / downcase', status: 'supported' },
  { name: 'at',              status: 'supported', note: 'Array indexing.' },
  // Coercions
  { name: 'to-number / number',  status: 'supported', note: 'Converter passes through to a coalesce chain; xgis evaluator coerces in arithmetic context. Iter 539 added spec-compliant `to_number(v, fallback…)` builtin in the evaluator for hand-authored xgis source / tooling chains that bypass the converter.', source: 'evaluator.ts:to_number' },
  { name: 'to-string / to-boolean / to-color', status: 'supported', note: 'Converter passes through to coalesce chains; iter 539 added spec-compliant `to_string` / `to_boolean` builtins in the evaluator (null → "", number → str, etc.); iter 541 added `to_color` (hex regex validation, X-GIS hex-only — converter pre-resolves CSS names like "red" via tokens/colors.ts:resolveColor).', source: 'evaluator.ts:to_string + to_boolean + to_color' },
  // Colour
  { name: 'rgb / rgba',      status: 'partial', impact: 'low', note: 'Constant channels only — hex-encoded at convert time. Per-channel v8 literal-wrap (`["literal", N]`) accepted.', source: 'expressions.ts:507' },
  { name: 'hsl / hsla',      status: 'partial', impact: 'low', note: 'Constant channels only — converted via CSS hsl()/hsla() and re-hexed at convert time. Per-channel v8 literal-wrap accepted.', source: 'colors.ts:69' },
  { name: 'interpolate (linear)',      status: 'supported' },
  { name: 'interpolate (exponential)', status: 'supported', note: 'Mapbox `["exponential", N]` lowers to `interpolate_exp(zoom, N, …)`; runtime applies the Mapbox curve formula. base=1 collapses to the linear fast path.', source: 'paint.ts:46' },
  { name: 'interpolate (cubic-bezier)',status: 'partial', impact: 'low', note: 'Numeric-valued zoom AND data-driven interpolates densify at compile time into a piecewise-linear approximation (6 samples per segment, CSS bezier-eased via Newton-Raphson). Runtime sees a longer linear stop list and visually approximates the bezier curve. Non-numeric values (colour stops) still warn and fold to pure linear. Iter 60-62 landings.', source: 'paint.ts:cssBezierEase + expressions.ts:interpolate handler' },
  { name: 'interpolate-hcl',           status: 'supported', note: 'LCh (polar Lab, hue shortest-path) colour interpolation: hex stops densify at compile time (iter 61-62 linear, iter 137 exponential — 6 samples / segment); non-hex (data-driven) stops now route to the runtime evaluator case interpolate_hcl (iter 164) which parses each stop\'s y at eval time, interpolates in LCh, and returns a hex. Full coverage modulo exponential×non-hex (rare combination — still warns and downgrades).', source: 'paint.ts + expressions.ts + eval/evaluator.ts interpolate_hcl' },
  { name: 'interpolate-lab',           status: 'supported', note: 'Lab (D50) colour interpolation: hex stops densify at compile time (iter 61-62 linear, iter 137 exponential — 6 samples / segment); non-hex (data-driven) stops now route to the runtime evaluator case interpolate_lab (iter 164) which parses each stop\'s y at eval time, interpolates in Lab, and returns a hex. Full coverage modulo exponential×non-hex (rare combination — still warns and downgrades).', source: 'paint.ts + expressions.ts + eval/evaluator.ts interpolate_lab' },
  // Feature meta
  { name: 'geometry-type',   status: 'supported', note: 'Routes via synthetic `$geometryType` prop injected at filter-eval time.', source: 'expressions.ts:263' },
  { name: 'id',              status: 'supported', note: 'Routes via synthetic `$featureId` prop injected from `feature.id` (GeoJSON RFC 7946 §3.2; MVT feature.id) at every filter-eval site. Same pattern as `geometry-type`.', source: 'expressions.ts:278' },
  { name: 'properties',      status: 'unsupported', impact: 'low', note: 'Returns whole feature properties object — X-GIS expressions access by field name (`.field` / `["get","field"]`); no object literal accessor.' },
  { name: 'feature-state',   status: 'na', note: 'Mapbox v8 dynamic property setter — no xgis equivalent.' },
  // Formatting / advanced
  { name: 'typeof',          status: 'supported', note: 'Returns Mapbox-shaped strings ("string" / "number" / "boolean" / "object" / "null").', source: 'expressions.ts:237' },
  { name: 'format',          status: 'partial', impact: 'low', note: 'Span texts concatenated via xgis concat(); per-span opts (font-scale / text-color / text-font / vertical-align) dropped — X-GIS labels render with one style per layer. Iter 25 added per-section partial-drop semantics: when one section fails to convert (e.g. uses an unsupported accessor), surviving sections still concat — only ALL-sections-fail returns null. Pre-fix any single failure bailed the whole format expression and dropped the label silently.', source: 'expressions.ts:208' },
  { name: 'image',           status: 'unsupported', impact: 'high', note: 'Sprite atlas (Batch 2).' },
  { name: 'number-format',   status: 'supported', note: 'Lowers to positional `number_format(input, minFrac, maxFrac, locale, currency)` (xgis has no object-literal syntax). Routes through Intl.NumberFormat at runtime; null slots use spec defaults.', source: 'expressions.ts:275' },
  { name: 'collator',        status: 'unsupported', impact: 'low', note: 'Locale-aware comparator for ==/!=/in. X-GIS uses byte-exact string compare. Surface as warning when authored.' },
  { name: 'resolved-locale', status: 'unsupported', impact: 'low', note: 'Returns locale string from a collator. Depends on collator support.' },
  { name: 'is-supported-script', status: 'unsupported', impact: 'low', note: 'Returns true if all chars in a string are renderable. X-GIS assumes Unicode-renderable. No-op gate.' },
  { name: 'array',           status: 'partial', impact: 'low', note: 'Type-assertion drops to value pass-through (X-GIS arrays carry no per-element type tag, so the spec\'s "abort if not array" semantic is lost; in paint/filter use a non-array would null-cascade anyway).', source: 'expressions.ts:163' },
  { name: 'slice',           status: 'supported', note: 'String or array; Mapbox `["slice", input, start[, end]]`. Routes to JS String/Array `.slice` semantics.', source: 'expressions.ts:248' },
  { name: 'index-of',        status: 'supported', note: 'Lowers to xgis `index_of(needle, haystack[, from])`. Returns -1 when not found.', source: 'expressions.ts:257' },
  // Camera / spatial
  { name: 'zoom',            status: 'supported', note: 'Lowers to bare `zoom` identifier. Works in `interpolate(zoom, …)` / `step(zoom, …)` AND anywhere else (filter compare, case condition, arithmetic).', source: 'expressions.ts:471' },
  { name: 'pitch',           status: 'supported', impact: 'low', note: 'Mapbox `["pitch"]` lowers to a bare `pitch` identifier (mirror of the `zoom` path). The evaluator resolves it via the reserved `$pitch` key (CAMERA_PITCH_KEY), injected by the render-path eval sites (map.ts applyFilter + per-feature paint/size eval, feature-helpers applyFilter/applyGeometry) from `camera.pitch` (degrees). Decode-time/worker sites have no camera so `["pitch"]` resolves to null there — same proxy contract `["zoom"]` has with tileZoom.', source: 'expressions.ts case pitch / eval/evaluator.ts + reserved-keys.ts' },
  { name: 'distance-from-center', status: 'unsupported', impact: 'low', note: 'Returns screen-space distance from viewport centre for the current feature. Would need per-feature distance evaluation in worker.' },
  { name: 'distance',        status: 'unsupported', impact: 'low', note: 'Geometry-to-geometry geodesic distance. Surface as warning when authored; would need spatial index for performance.' },
  { name: 'within',          status: 'unsupported', impact: 'low', note: 'Point-in-polygon test for filter context. Surface as warning when authored.' },
  { name: 'accumulated',     status: 'na', note: 'Heatmap-only.' },
  { name: 'heatmap-density', status: 'na', note: 'Heatmap-only.' },
  { name: 'line-progress',   status: 'na', note: 'line-gradient only.' },
  { name: 'sky-radial-progress', status: 'na' },
]
