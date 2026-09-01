import type { CoverageEntry } from './types'

// ─── 6. Expression operators ──────────────────────────────────────────
export const EXPRESSIONS: readonly CoverageEntry[] = [
  // Lookups + control flow
  {
    name: 'literal',
    status: 'supported',
    note: 'Scalar + array forms. Null-valued wrappers (`["literal", null]`) treated as "property omitted" by the paint-helper gate (isOmitted in paint.ts).',
    source: 'expressions.ts:33',
  },
  {
    name: 'get',
    status: 'supported',
    note: 'Bare field for identifier-safe names; `get("name:xx")` for colon-bearing locale keys.',
    source: 'expressions.ts:25',
  },
  { name: 'has', status: 'supported', source: 'expressions.ts:43' },
  { name: '!has', status: 'supported', source: 'expressions.ts:52' },
  {
    name: 'coalesce',
    status: 'supported',
    note: 'Lowers to xgis `??` chain.',
    source: 'expressions.ts:59',
  },
  { name: 'case', status: 'supported', source: 'expressions.ts:65' },
  {
    name: 'match',
    status: 'supported',
    note: 'Routes through `match() { … }` when input is FieldAccess; ternary fallback otherwise.',
    source: 'expressions.ts:83',
  },
  { name: 'step', status: 'supported', source: 'expressions.ts:185' },
  {
    name: 'let / var',
    status: 'supported',
    note: 'Pure substitution at convert time.',
    source: 'expressions.ts:199',
  },
  // Logic + comparison
  { name: 'all', status: 'supported' },
  { name: 'any', status: 'supported' },
  {
    name: 'none',
    status: 'supported',
    note: 'Legacy filter combinator. Lowers to `!(f1 || f2 || …)`.',
  },
  { name: '!', status: 'supported' },
  { name: '== / != / < / <= / > / >=', status: 'supported' },
  {
    name: 'in',
    status: 'supported',
    note: 'Both expression form and legacy form. Empty value list lowers to constant `false` per spec.',
    source: 'expr-lookup.ts:502',
  },
  { name: '!in', status: 'supported' },
  // Arithmetic + math
  { name: '+ / - / * / / / %', status: 'supported' },
  { name: 'min / max', status: 'supported' },
  { name: '^ / abs / ceil / floor / round / sqrt', status: 'supported' },
  { name: 'sin / cos / tan / asin / acos / atan', status: 'supported' },
  { name: 'ln / log10 / log2', status: 'supported' },
  { name: 'pi / e / ln2', status: 'supported', note: 'Zero-arg constants.' },
  // String + array
  { name: 'concat', status: 'supported' },
  { name: 'length', status: 'supported' },
  { name: 'upcase / downcase', status: 'supported' },
  { name: 'at', status: 'supported', note: 'Array indexing.' },
  {
    name: 'split / join',
    status: 'supported',
    note: '#2008 C-tier. Plain JS String#split / Array#join — no MapLibre-specific edge-case handling, per the reference implementation (@maplibre/maplibre-gl-style-spec 24.8.5, expression/compound_expression.ts:511-520). CPU-only (arrays can\'t reach the GPU — ir/classify.ts). Witness: `["join", ["split", ["get", "name"], ","], " / "]` on a text-field converts to `join(split(.name, ","), " / ")` and evaluates "a,b,c" → "a / b / c".',
    source:
      'expr-string.ts splitHandler/joinHandler + eval/evaluator-helpers.ts callBuiltin split/join',
  },
  // Coercions
  {
    name: 'to-number / number',
    status: 'supported',
    note: 'Converter passes through to a coalesce chain; xgis evaluator coerces in arithmetic context. Iter 539 added spec-compliant `to_number(v, fallback…)` builtin in the evaluator for hand-authored xgis source / tooling chains that bypass the converter.',
    source: 'evaluator.ts:to_number',
  },
  {
    name: 'to-string / string / to-boolean / boolean / to-color',
    status: 'supported',
    note: 'Converter passes through to coalesce chains; iter 539 added spec-compliant `to_string` / `to_boolean` builtins in the evaluator (null → "", number → str, etc.); iter 541 added `to_color` (hex regex validation, X-GIS hex-only — converter pre-resolves CSS names like "red" via tokens/colors.ts:resolveColor). The bare ASSERTION forms `string` / `boolean` (as opposed to their `to-`-prefixed COERCION siblings) route through the identical typeCoercionHandler — same fallback-chain treatment, just previously untracked by name here (#2008 C-tier fold-in; converter-probed 2026-08-24, already implemented and tested — see type-coercion-fallback-coverage.test.ts).',
    source:
      'evaluator.ts:to_string + to_boolean + to_color; expr-registry.ts (typeCoercionHandler)',
  },
  {
    name: 'object',
    status: 'supported',
    note: '#2008 C-tier. Mapbox `["object", value_1, …, value_n]` has the IDENTICAL fallback-chain overload shape as the `string` / `number` / `boolean` asserts above (first arg that converts wins) — reuses typeCoercionHandler verbatim, no new handler. Like its siblings this does not runtime-verify the value is actually an object; X-GIS has no per-value type tag (same trade-off the `array` row above documents).',
    source: 'expr-registry.ts (typeCoercionHandler)',
  },
  // Colour
  {
    name: 'rgb / rgba',
    status: 'supported',
    note: 'Constant channels hex-encode at convert time; per-feature (data-driven) channels — `["rgb", ["get","r"], …]` — now lower to a runtime `rgb(…)` / `rgba(…)` call (expr-string.ts rgbHandler) that the evaluator\'s rgb/rgba builtin resolves per feature into a hex string (encoding byte-matches the constant path). Classified per-feature-CPU (rgb ∉ GPU_SAFE_BUILTINS). Per-channel v8 literal-wrap (`["literal", N]`) accepted.',
    source: 'expr-string.ts rgbHandler + eval/evaluator-helpers.ts callBuiltin rgb/rgba',
  },
  {
    name: 'to-rgba',
    status: 'supported',
    note: '#2008 C-tier — real coercion, not pass-through (a pass-through would be UNSOUND: the spec output is a 4-element numeric array, not the input colour, so downstream `["at", 0, ["to-rgba", c]]` needs the actual decomposition). Spec (@maplibre/maplibre-gl-style-spec 24.8.5, expression/compound_expression.ts:228-234): `[r*255, g*255, b*255, a]` from the colour\'s normalised [0,1] channels — r/g/b 0-255, a 0-1. Constant colours fold to a literal xgis array at convert time (colorToXgis + tokens/colors.ts:resolveColorToRgba, same resolver the paint-color pipeline uses); data-driven colours emit a runtime `to_rgba(…)` CPU builtin call. Unresolvable input returns null (X-GIS evaluator convention: fail soft, not the spec\'s throw).',
    source: 'expr-string.ts toRgbaHandler + eval/evaluator-helpers.ts callBuiltin to_rgba',
  },
  {
    name: 'hsl / hsla',
    status: 'supported',
    note: "Constant channels convert via CSS hsl()/hsla() and re-hex at convert time; per-feature channels now lower to a runtime `hsl(…)` / `hsla(…)` call (expr-string.ts hslHandler) that the evaluator's hsl/hsla builtin resolves per feature through the CSS colour parser (tokens/colors.ts). Per-channel v8 literal-wrap accepted.",
    source: 'expr-string.ts hslHandler + eval/evaluator-helpers.ts callBuiltin hsl/hsla',
  },
  { name: 'interpolate (linear)', status: 'supported' },
  {
    name: 'interpolate (exponential)',
    status: 'supported',
    note: 'Mapbox `["exponential", N]` lowers to `interpolate_exp(zoom, N, …)`; runtime applies the Mapbox curve formula. base=1 collapses to the linear fast path.',
    source: 'paint.ts:46',
  },
  {
    name: 'interpolate (cubic-bezier)',
    status: 'partial',
    impact: 'low',
    note: "Numeric-valued AND hex-colour-valued interpolates densify at compile time into a piecewise-linear approximation (6 samples per segment, CSS bezier-eased via Newton-Raphson through cssBezierEase; a plain `interpolate`'s colour stops sampled in sRGB at the eased fraction). BOTH axes do it: the data-driven densifier (isBezier, expr-interpolate.ts) and its zoom-axis twin (interpolateZoomStops, paint-helpers.ts), which gained the colour branch in #2166 — before that a zoom-axis colour ramp emitted the same two stops a ['linear'] ramp did, discarding the authored curve with only a warning. `interpolate-lab` / `interpolate-hcl` are NOT sampled in sRGB: both axes hand a bezier ramp to their Lab/LCh densifier, which applies the same easing in the authored space (see those rows). Runtime sees a longer linear stop list and visually approximates the bezier. PARTIAL for three residuals, ALL of which discard the authored curve. (1) Expression-valued (non-literal) stops warn and fold to pure linear — an eased sample cannot be computed until feature eval. (2) A LITERAL non-hex colour spelling (named / rgb() / rgba() / hsl()) folds on BOTH axes, because the densifier tests the authored string before colour normalisation: `['interpolate', ['cubic-bezier', …], ['zoom'], 0, 'red', 10, 'blue']` emits two stops even though resolveColor would have produced the #rrggbb the branch densifies. (3) An alpha-carrying 4-/8-digit hex folds on the ZOOM axis (parseSrgbHex drops alpha and densifying would delete it), but the DATA axis densifies the same input and DOES delete the alpha — the two axes disagree on that one input; filed on #2166, not fixed here. Iter 60-62 + colour-stop landing + #2166 zoom axis + #2166 review round.",
    source: 'expr-interpolate.ts (isBezier densify) + paint.ts:cssBezierEase',
  },
  {
    name: 'interpolate-hcl',
    status: 'supported',
    note: "LCh (polar Lab, hue shortest-path) colour interpolation: hex stops densify at compile time (iter 61-62 linear, iter 137 exponential, #2166 review round cubic-bezier — 6 samples / segment); non-hex (data-driven) stops now route to the runtime evaluator case interpolate_hcl (iter 164) which parses each stop's y at eval time, interpolates in LCh, and returns a hex. A cubic-bezier curve eases the COLOUR parameter while the dense stop's input position stays linear, on both the zoom axis (interpolateZoomStops) and the data axis (expr-interpolate.ts) — measured byte-exact against the pinned reference implementation at all 7 emitted stops for cubic-bezier(0.42, 0, 0.58, 1), (0.25, 0.1, 0.25, 1) and (0.9, 0, 1, 1). Full coverage modulo two rare combinations that still warn and downgrade: exponential×non-hex, and cubic-bezier×non-hex (the runtime case interpolates linearly, so the curve is dropped — the warning says so).",
    source: 'paint.ts + expressions.ts + eval/evaluator.ts interpolate_hcl',
  },
  {
    name: 'interpolate-lab',
    status: 'supported',
    note: "Lab (D50) colour interpolation: hex stops densify at compile time (iter 61-62 linear, iter 137 exponential, #2166 review round cubic-bezier — 6 samples / segment); non-hex (data-driven) stops now route to the runtime evaluator case interpolate_lab (iter 164) which parses each stop's y at eval time, interpolates in Lab, and returns a hex. A cubic-bezier curve eases the COLOUR parameter while the dense stop's input position stays linear, on both the zoom axis (interpolateZoomStops) and the data axis (expr-interpolate.ts) — measured byte-exact against the pinned reference implementation at all 7 emitted stops for cubic-bezier(0.42, 0, 0.58, 1), (0.25, 0.1, 0.25, 1) and (0.9, 0, 1, 1). Full coverage modulo two rare combinations that still warn and downgrade: exponential×non-hex, and cubic-bezier×non-hex (the runtime case interpolates linearly, so the curve is dropped — the warning says so).",
    source: 'paint.ts + expressions.ts + eval/evaluator.ts interpolate_lab',
  },
  // Feature meta
  {
    name: 'geometry-type',
    status: 'supported',
    note: 'Routes via synthetic `$geometryType` prop injected at filter-eval time.',
    source: 'expressions.ts:263',
  },
  {
    name: 'id',
    status: 'supported',
    note: 'Routes via synthetic `$featureId` prop injected from `feature.id` (GeoJSON RFC 7946 §3.2; MVT feature.id) at every filter-eval site. Same pattern as `geometry-type`.',
    source: 'expressions.ts:278',
  },
  {
    name: 'properties',
    status: 'supported',
    note: 'Mapbox `["properties"]` lowers to a `properties()` builtin (mirror of the `geometry-type` / `id` accessor pattern). The evaluator special-cases it (eval/evaluator.ts evaluateFnCall) — it holds the live props bag and returns a shallow copy of feature.properties with the reserved $-sigil keys ($zoom / $pitch / $featureId / $geometryType) stripped, matching Mapbox\'s "the feature\'s own properties" semantic. Useful as the whole-object operand to a downstream comparison; per-field access still prefers `.field` / `get("field")`.',
    source: 'expr-lookup.ts propertiesHandler',
  },
  {
    name: 'feature-state',
    status: 'na',
    note: 'Mapbox v8 dynamic property setter — no xgis equivalent.',
  },
  // Formatting / advanced
  {
    name: 'typeof',
    status: 'supported',
    note: 'Returns Mapbox-shaped strings ("string" / "number" / "boolean" / "object" / "null").',
    source: 'expressions.ts:237',
  },
  {
    name: 'format',
    status: 'partial',
    impact: 'low',
    note: 'Span texts concatenated via xgis concat(); per-span TYPOGRAPHY opts (font-scale / text-color / text-font / vertical-align) dropped — X-GIS labels render with one style per layer. Per-section partial-drop semantics: when one section fails to convert (e.g. uses an unsupported accessor), surviving sections still concat — only ALL-sections-fail returns null. An `["image", …]` section IS carried now (#777 I-G): it lowers to the `image(name)` builtin → an inline sprite quad on the text baseline (imageHandler + evaluator; see the `image` row). Still partial only for the typography opts.',
    source: 'expressions.ts:208',
  },
  {
    name: 'image',
    status: 'supported',
    note: 'Resolved in BOTH contexts. icon-image PROPERTY (#777 I2): the converter strips the `["image", …]` wrapper (recursively, incl. nested inside the coalesce/match arms of a data-driven icon-image) and lowers the inner sprite-name — constant `["image","airport"]` → LabelDef.iconImage "airport"; data-driven → per-feature LabelDef.iconImageExpr → IconStage.addIcon. TEXT/format inline image (#777 I-G): the bare `text-field: ["image","pat"]` form AND an `["image", …]` section inside `["format", …]` lower to the `image(name)` builtin (imageHandler) whose evaluator wraps the resolved name in PUA sentinels; the runtime label shaper (TextStage) reserves the sprite CSS-width advance and hands the placement to IconStage → an inline sprite quad on the text baseline. Missing sprite → the image is skipped, surrounding text keeps rendering (MapLibre parity).',
    source:
      'expr-string.ts imageHandler + evaluator-helpers.ts case image + layers-helpers.ts unwrapImageExpr',
  },
  {
    name: 'number-format',
    status: 'supported',
    note: 'Lowers to positional `number_format(input, minFrac, maxFrac, locale, currency)` (xgis has no object-literal syntax). Routes through Intl.NumberFormat at runtime; null slots use spec defaults.',
    source: 'expressions.ts:275',
  },
  {
    name: 'collator',
    status: 'partial',
    impact: 'low',
    note: 'Locale-aware comparator as the trailing 4th arg of ==/!=/</<=/>/>=. comparisonHandler lowers `["==", a, b, ["collator", opts]]` to the `collator_cmp` CPU builtin (eval/collator.ts) backed by Intl.Collator. Constant options (case-sensitive / diacritic-sensitive / locale) bake into the call via extractCollatorOpts; since #2166 a PER-FEATURE expression in any of the three slots lowers into that slot instead (lowerCollatorOptSlots) — callBuiltin dispatches on already-evaluated arguments, so an option expression is decided at eval time, which is what the Mapbox reference implementation does too (it holds all three options as expressions and evaluates them per feature). PARTIAL for four residuals. (1) A non-object options argument — rejected at parse time by that implementation too; X-GIS warns and drops to byte-exact compare. (2) A constant of the wrong type (`"case-sensitive": "yes"`) — likewise rejected there, and it must not be recursed here: the coercion would invent a sensitivity the style never authored. (3) A STANDALONE `["collator", …]` off a comparison, which still warns because X-GIS has no first-class collator value type. (4) NOT co-extensive with the reference, measured against the pinned 24.8.5 dist: it type-asserts each option EXPRESSION, both at parse (a wrong-TYPED expression such as `["array", ["get","k"]]` in `case-sensitive` is a parse error) and at eval (an expression whose runtime value is the wrong type or absent raises, and the property falls back to its default). X-GIS has no evaluation-error channel — the same gap the `array` row records — so `collator_cmp` coerces instead: `String(… ?? "")` on the locale slot and `Boolean(…)` on the two sensitivity slots. A tile that stringifies its booleans therefore flips the answer, not the property: `{"case-sensitive": ["get","cs"]}` with `cs: "false"` selects a case-SENSITIVE compare here and yields the default there. Pinned by collator-convert.test.ts. One narrower divergence in the same family: a falsy non-string constant `locale` (`"locale": 0`) is ACCEPTED by the reference (it reads a falsy locale as absent and defaults) and dropped here — filed on #2166, not fixed.',
  },
  {
    name: 'resolved-locale',
    status: 'partial',
    impact: 'low',
    note: 'Returns the BCP-47 tag a collator resolves to. Constant collator locale supported: resolvedLocaleHandler lowers `["resolved-locale", ["collator", opts]]` to the `resolved_locale` CPU builtin (Intl.Collator.resolvedOptions().locale). The handler reads ONLY the collator\'s `locale`, so a non-constant case-/diacritic-sensitivity SIBLING opt no longer drops the expression — those opts cannot change the resolved tag. It deliberately does NOT go through the shared all-or-nothing `extractCollatorOpts`, whose contract is extracting COMPILE-TIME CONSTANTS — not a statement about what the comparison path can express, which since #2166 lowers a per-feature option into its `collator_cmp` slot rather than requiring a literal. PARTIAL for one remaining reason: a non-constant LOCALE is undecidable at compile time and still warns + drops (as does a non-collator argument, or a non-object opts).',
  },
  {
    name: 'is-supported-script',
    status: 'supported',
    note: 'Mapbox `["is-supported-script", str]` returns true when every char is shapeable. X-GIS rasterises through Canvas2D / the MapLibre PBF atlas with a CJK + Latin + Arabic fallback chain and makes no per-script capability distinction — it treats all Unicode as renderable. The converter lowers the accessor to the constant `true` identifier (isSupportedScriptHandler in expr-lookup); styles that gate a label via `["case", ["is-supported-script", text], text, <fallback>]` always take the supported branch, matching X-GIS\' actual capability.',
    source: 'expr-lookup.ts isSupportedScriptHandler',
  },
  {
    name: 'array',
    status: 'partial',
    impact: 'low',
    note: '#2166 B3 — a real assertion, not a pass-through. `["array", value]` / `["array", type, value]` / `["array", type, N, value]` lower to the `assert_array` CPU builtin (arrayHandler in expr-string.ts, dispatched by eval/evaluator-helpers.ts callBuiltin): the value comes back only when it IS an array whose elements match the declared type (string / number / boolean) and count, else null. Both halves of the previous note were false. "X-GIS arrays carry no per-element type tag" is a GPU-lane fact about an op classifyExpr routes to per-feature-CPU, where the evaluator holds the real JS values. And "in paint/filter use a non-array would null-cascade anyway" was measured wrong on the pre-fix base: only the `["at", …]` consumer nulled — `["length", ["array", ["get", "pts"]]]` measured a STRING property as 5 and `["slice", ["array", …], 0, 2]` returned a substring, because both builtins accept strings. PARTIAL for one remaining reason: the spec ABORTS a failed assertion (the enclosing property falls back to its default), while X-GIS has no evaluation-error channel and yields null, which the enclosing expression keeps computing with — that same `length` now returns 0, not the property default. An item type outside string / number / boolean (which the spec rejects at parse time) keeps the arrayness half rather than dropping the expression.',
    source: 'expr-string.ts arrayHandler + eval/evaluator-helpers.ts callBuiltin assert_array',
  },
  {
    name: 'slice',
    status: 'supported',
    note: 'String or array; Mapbox `["slice", input, start[, end]]`. Routes to JS String/Array `.slice` semantics.',
    source: 'expressions.ts:248',
  },
  {
    name: 'index-of',
    status: 'supported',
    note: 'Lowers to xgis `index_of(needle, haystack[, from])`. Returns -1 when not found.',
    source: 'expressions.ts:257',
  },
  // Camera / spatial
  {
    name: 'zoom',
    status: 'supported',
    note: 'Lowers to bare `zoom` identifier. Works in `interpolate(zoom, …)` / `step(zoom, …)` AND anywhere else (filter compare, case condition, arithmetic).',
    source: 'expr-lookup.ts:152',
  },
  {
    name: 'pitch',
    status: 'supported',
    impact: 'low',
    note: 'Mapbox `["pitch"]` lowers to a bare `pitch` identifier (mirror of the `zoom` path). The evaluator resolves it via the reserved `$pitch` key (CAMERA_PITCH_KEY), injected by the render-path eval sites (map.ts applyFilter + per-feature paint/size eval, feature-helpers applyFilter/applyGeometry) from `camera.pitch` (degrees). Decode-time/worker sites have no camera so `["pitch"]` resolves to null there — same proxy contract `["zoom"]` has with tileZoom.',
    source: 'expressions.ts case pitch / eval/evaluator.ts + reserved-keys.ts',
  },
  {
    name: 'distance-from-center',
    status: 'partial',
    impact: 'low',
    note: 'Feature anchor\'s distance from the viewport centre, in units of the viewport HALF-DIAGONAL (0 centre, 1 at any corner, >1 off-screen — eval/distance-from-center.ts owns that arithmetic and its witnesses; half-width or half-height alone is the silent bug, invisible on a square viewport). #2119 converted this from unsupported: the op no longer warns, distanceFromCenterHandler lowers it to `get("$distanceFromCenter")` — the same channel `geometry-type` / `id` use, because the hyphen makes a bare identifier impossible (the lexer reads `-` as Minus) — and DISTANCE_FROM_CENTER_KEY reserves the slot, so shadowing by a feature property literally named `distance-from-center` is structurally impossible rather than checked. PARTIAL, not supported, for one reason: NO render-path caller injects the value yet, so it evaluates to null at runtime, the same absence contract `["pitch"]` has at a decode-time site. The blocker is measured, not unexamined — label-pass.ts applyFeatureExprs caches per-feature evaluation on (props ref, zoomBucket) because it was 73% of frame time, and a quantity that changes on PAN moves neither key. Injecting it there either serves stale values or gives that cache up. Line-placed labels additionally have no single anchor at all, and get a precise per-layer warning (distanceFromCenterAnchorWarning) rather than a silent drop.',
    source: 'expr-lookup.ts distanceFromCenterHandler / eval/distance-from-center.ts',
  },
  {
    name: 'distance',
    status: 'partial',
    impact: 'low',
    note: 'Shortest distance (metres) between the feature and a target GeoJSON. distanceHandler decomposes the constant target into points/segments/polygons (compile time) and lowers to the `distance(get("$geometry"), …)` CPU builtin (eval/distance.ts), which uses a cheap-ruler (latitude-corrected planar) metre metric and treats inside-polygon as 0. Point/MultiPoint feature-geometry is supported on GeoJSON AND MVT/PMTiles sources alike: #2166 gave the vector-tile slice-filter path the same `$geometry` injection applyFilter already did, via one shared helper both the MVT worker and the PMTiles inline compiler call. NO reprojection is involved on either path — the MVT decoder un-quantizes tile coordinates to lng/lat before any filter sees a feature, the space the target is emitted in, and tile clipping cannot move a point, so a per-tile fragment answers as the whole feature does. PARTIAL for two reasons that remain. (1) FILTER-ONLY: `$geometry` is injected at the filter-eval sites; every per-feature paint/layout/label eval bag still omits it, so `["distance"]` in a paint property resolves to null. (2) evalDistance reduces the feature through featurePoints, which returns null for anything but Point/MultiPoint — LineString/Polygon feature-geometry (which the reference implementation does evaluate) needs segment-vs-segment / ring-vs-ring math and is deferred.',
  },
  {
    name: 'within',
    status: 'partial',
    impact: 'low',
    note: 'Geometry-containment filter. The converter lowers ["within", poly] to `within(get("$geometry"), <coords>)` (expr-lookup.ts withinHandler); the CPU even-odd containment test (eval/within.ts) honours holes + MultiPolygon. Point/MultiPoint tested-geometry vs a Polygon/MultiPolygon argument is supported on GeoJSON AND MVT/PMTiles sources alike: #2166 gave the vector-tile slice-filter path the same `$geometry` injection applyFilter already did, via one shared helper both the MVT worker and the PMTiles inline compiler call. NO reprojection is involved on either path — the MVT decoder un-quantizes tile coordinates to lng/lat before any filter sees a feature, the same space the polygon argument is emitted in, and tile clipping cannot move a point, so a per-tile fragment answers as the whole feature does. PARTIAL for two reasons that remain. (1) FILTER-ONLY: `$geometry` is injected at the filter-eval sites; every per-feature paint/layout/label eval bag still omits it. (2) evalWithin has no segment-vs-ring intersection routine, so LineString tested-geometry is deferred (returns false). Polygon tested-geometry is NOT a gap: the reference implementation evaluates Point and LineString only and returns false for anything else, so the earlier "LineString/Polygon" deferral over-stated the gap by one type.',
  },
  { name: 'accumulated', status: 'na', note: 'Heatmap-only.' },
  { name: 'heatmap-density', status: 'na', note: 'Heatmap-only.' },
  {
    name: 'line-progress',
    status: 'na',
    note: 'line-gradient only — and as of #2117 the line converter lowers that ramp itself (paint-line.ts addLineGradient), the way layers-heatmap.ts owns heatmap-density. It still has no value in a GENERIC expression context, which is what this row records; the generic path warns and says where it IS meaningful.',
  },
  { name: 'sky-radial-progress', status: 'na' },
]
