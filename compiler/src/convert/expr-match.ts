// Mapbox `["match", …]` family → xgis match / ternary / boolean-filter
// conversion.
//
// Extracted verbatim from expressions.ts so the `_exprToXgisImpl`
// god-function shrinks without changing output. These three members
// explicitly stay in sync (their comments cross-reference each other):
//   - convertMatch          (the `match` switch arm body)
//   - matchToTernary        (complex-input fallback)
//   - matchToBooleanFilter  (filter-context boolean lowering)
//
// All recurse into the public converter (`exprToXgis`); to avoid an
// import cycle each takes that recursion fn as a `recurse` parameter
// rather than importing expressions.ts.

export function convertMatch(
  v: unknown[],
  warnings: string[],
  recurse: (x: unknown, w: string[]) => string | null,
): string | null {
  // ["match", input, key1, val1, key2, val2, …, default]
  // → match(.field) { key -> value, _ -> default }
  const input = v[1]
  const args = v.slice(2)
  if (args.length < 1 || args.length % 2 !== 1) {
    warnings.push(`Malformed ["match"] expression: ${JSON.stringify(v).slice(0, 120)}`)
    return null
  }
  const inputXgis = recurse(input, warnings)
  if (inputXgis === null || !inputXgis.startsWith('.')) {
    // X-GIS match() takes a field access; complex inputs fall
    // back to a chained ternary.
    return matchToTernary(input, args, warnings, recurse)
  }
  const arms: string[] = []
  const def = args[args.length - 1]
  let droppedArms = 0
  let invalidKeyArms = 0
  // Set of known Mapbox expression operators. If a label position
  // is a bare array whose first element matches one of these, the
  // user passed an expression where Mapbox spec requires a literal.
  // Pre-fix the code treated such arrays as `[k1, k2]` shorthand —
  // e.g. `["get", "k"]` matched features with property "get" or "k".
  const EXPR_OPS = new Set([
    'get', 'has', '!has', 'in', '!in', 'literal', 'var', 'let',
    'case', 'match', 'coalesce', 'step', 'interpolate', 'interpolate-lab',
    'interpolate-hcl', 'concat', 'format', 'rgb', 'rgba', 'hsl', 'hsla',
    'to-color', 'to-number', 'to-string', 'to-boolean', 'typeof',
    'zoom', 'pi', 'e', 'ln2', 'all', 'any', '!',
    '==', '!=', '<', '<=', '>', '>=', '+', '-', '*', '/', '%', '^',
    'abs', 'ceil', 'floor', 'round', 'sqrt', 'sin', 'cos', 'tan',
    'asin', 'acos', 'atan', 'ln', 'log10', 'log2', 'min', 'max',
    'length', 'upcase', 'downcase', 'slice', 'index-of', 'at',
    'geometry-type', 'id', 'properties', 'feature-state',
    'image', 'number-format', 'array',
  ])
  for (let i = 0; i < args.length - 1; i += 2) {
    // Mapbox v8 strict tooling can emit `["literal", [k1, k2]]`
    // for the keys-array form. Without unwrap, the outer
    // Array.isArray check passed and the iteration produced
    // arms `"literal" -> val`, `[k1, k2] -> val` — both wrong.
    // The bare-array shape `[k1, k2]` is still accepted.
    // Loop peel for multi-level wraps emitted by some v8 strict
    // preprocessor chains (`["literal", ["literal", k]]`).
    let key = args[i]
    // Spec strict: reject bare expression at label position
    // (e.g. `["get", "k"]`, `["case", …]`). After literal unwrap
    // a still-array key whose first elt is a known operator name
    // is an expression, not a literal-array shorthand.
    if (Array.isArray(key) && key.length > 0 && typeof key[0] === 'string'
        && EXPR_OPS.has(key[0]) && key[0] !== 'literal') {
      invalidKeyArms++
      continue
    }
    while (Array.isArray(key) && key.length === 2 && key[0] === 'literal') {
      key = key[1]
    }
    const val = recurse(args[i + 1], warnings)
    if (val === null) { droppedArms++; continue }
    const keyStrs = Array.isArray(key) ? key : [key]
    for (let k of keyStrs) {
      // Inner per-element literal-wrap. Mapbox v8 strict tooling
      // can emit `["literal", [["literal", "x"], "y"]]` — outer
      // unwrap gave the inner array but each k might still be a
      // wrapped scalar. Without this, `[object Object]` / `literal,x`
      // landed in the arm patterns and the match never matched.
      // Loop peel for multi-level wraps emitted by preprocessor
      // chains. Mirror of colorToXgis (921d5ad).
      while (Array.isArray(k) && k.length === 2 && k[0] === 'literal') {
        k = k[1]
      }
      // Mapbox style-spec strict: match labels MUST be literal
      // string or number (or array of those). Expression-form keys
      // (e.g. `["get", "x"]`) silently coerced to `[object Object]`
      // pre-fix — never matched a real feature value. Drop the
      // invalid key and surface a warning so the authored intent
      // is visible at convert time instead of as a runtime
      // mystery (matched arm never fires).
      if (typeof k !== 'string' && typeof k !== 'number') {
        invalidKeyArms++
        continue
      }
      arms.push(`    ${typeof k === 'string' ? JSON.stringify(k) : k} -> ${val}`)
    }
  }
  if (invalidKeyArms > 0) {
    warnings.push(`["match"] dropped ${invalidKeyArms} arm key(s) that are not literal string/number; Mapbox spec requires literal labels. Matching values for those keys will fall through to default.`)
  }
  // Mapbox spec: match labels must be unique within a single
  // expression. Duplicates produce undefined behaviour (MapLibre
  // uses the FIRST matching arm); silently emitting both arms
  // means the second one is dead code that the author probably
  // didn't notice. Compare the parsed label values across arms.
  {
    const seenLabels = new Set<string>()
    const duplicates: string[] = []
    for (const armLine of arms) {
      // Each arm line is "    <label> -> <val>" or "    _ -> <default>".
      // Extract the label prefix.
      const labelStart = armLine.indexOf('    ') + 4
      const arrowAt = armLine.indexOf(' -> ', labelStart)
      if (arrowAt < 0) continue
      const label = armLine.slice(labelStart, arrowAt)
      if (label === '_') continue // default arm
      if (seenLabels.has(label)) {
        duplicates.push(label)
      } else {
        seenLabels.add(label)
      }
    }
    if (duplicates.length > 0) {
      warnings.push(`["match"] duplicate label(s) ${duplicates.slice(0, 4).map(d => `"${d}"`).join(', ')}${duplicates.length > 4 ? ` + ${duplicates.length - 4} more` : ''}. Mapbox spec requires unique labels; only the FIRST occurrence wins, the rest are dead arms.`)
    }
  }
  const defXgis = recurse(def, warnings)
  if (defXgis !== null) arms.push(`    _ -> ${defXgis}`)
  // Mirror of case + coalesce partial-drop warnings — surface arms
  // whose value failed to convert. The match would have routed
  // matching keys to the (possibly missing) default arm with no
  // diagnostic; surfacing the count makes it obvious which arms
  // disappeared from the authored ladder.
  if (droppedArms > 0) {
    warnings.push(`["match"] dropped ${droppedArms} arm(s) whose value failed to convert; matching keys will fall through to default.`)
  }
  return `match(${inputXgis}) {\n${arms.join(',\n')}\n  }`
}

/** Lower `["match", input, k1, val1, …, default]` to a boolean
 *  expression when every val (and the default) is a boolean literal.
 *  Returns null when the match is value-typed (caller should keep it
 *  as match()).
 *
 *  Standard Mapbox idiom: `["match", input, [keys...], true, false]`
 *  meaning "input is one of these keys". xgis filter context wants a
 *  plain boolean expression, not match() (which is a value-mapping
 *  form), so we fan out into an OR/AND chain. */
export function matchToBooleanFilter(
  v: unknown[],
  warnings: string[],
  recurse: (x: unknown, w: string[]) => string | null,
): string | null {
  if (v[0] !== 'match' || v.length < 4) return null
  const input = v[1]
  const args = v.slice(2)
  if (args.length % 2 !== 1) return null
  const def = args[args.length - 1]

  // Unwrap v8 literal-wraps on the boolean values + default. A
  // strict-tooling-emitted form like
  // `["match", input, k, ["literal", true], ["literal", false]]`
  // would pre-fix fail the `typeof ... === 'boolean'` gate and
  // matchToBooleanFilter returned null — the filter fell to the
  // generic match() path and the merge / dispatch lost its
  // boolean-fast-path opportunity.
  const unwrapBool = (x: unknown): unknown => {
    while (Array.isArray(x) && x.length === 2 && x[0] === 'literal') x = x[1]
    return x
  }
  const defUnwrapped = unwrapBool(def)
  // All values + default must be boolean literals.
  const allBool = (() => {
    if (typeof defUnwrapped !== 'boolean') return false
    for (let i = 1; i < args.length - 1; i += 2) {
      if (typeof unwrapBool(args[i]) !== 'boolean') return false
    }
    return true
  })()
  if (!allBool) return null

  const inputXgis = recurse(input, warnings)
  if (inputXgis === null) return null

  // Polarity: default `false` → OR of equality for true-arms.
  // Default `true` → AND of inequality for false-arms (the "not in
  // <keys>" form).
  const polarity = defUnwrapped === false
  const eqOp = polarity ? '==' : '!='
  const join = polarity ? ' || ' : ' && '
  const targetVal = polarity

  const parts: string[] = []
  for (let i = 0; i < args.length - 1; i += 2) {
    // Unwrap Mapbox v8 `["literal", [k1, k2]]` keys-array wrapper —
    // mirror of the main match handler. Pre-fix the wrapped form
    // iterated "literal" + the actual key list as separate arms.
    let key = args[i]
    while (Array.isArray(key) && key.length === 2 && key[0] === 'literal') {
      key = key[1]
    }
    const val = unwrapBool(args[i + 1])
    if (val !== targetVal) continue
    const keys = Array.isArray(key) ? key : [key]
    for (let k of keys) {
      // Inner per-element literal-wrap, mirror of the main + ternary
      // match handlers — keep all three in sync.
      while (Array.isArray(k) && k.length === 2 && k[0] === 'literal') k = k[1]
      parts.push(`${inputXgis} ${eqOp} ${typeof k === 'string' ? JSON.stringify(k) : k}`)
    }
  }
  if (parts.length === 0) {
    // No matching arms — match collapses to the default literal.
    return String(defUnwrapped)
  }
  return parts.join(join)
}

/** Used when `["match", <complex>, …]` can't go through xgis match()
 *  because match() requires a field-access input. Falls back to a
 *  chain of `input == key ? value : …`. Less efficient but always
 *  expressible. */
export function matchToTernary(
  input: unknown,
  args: unknown[],
  warnings: string[],
  recurse: (x: unknown, w: string[]) => string | null,
): string | null {
  const inputXgis = recurse(input, warnings)
  if (inputXgis === null) return null
  // Type-neutral fallback (mirror of case-default fix 4c6fd74).
  // Pre-fix '0' fallback type-mismatched colour matches.
  const def = recurse(args[args.length - 1], warnings) ?? 'null'
  let result = def
  let droppedArms = 0
  for (let i = args.length - 3; i >= 0; i -= 2) {
    // Same literal-wrap unwrap pattern as the main match + boolean
    // filter paths — keep the three match handlers in sync.
    let key = args[i]
    while (Array.isArray(key) && key.length === 2 && key[0] === 'literal') {
      key = key[1]
    }
    const val = recurse(args[i + 1], warnings)
    if (val === null) { droppedArms++; continue }
    const keyStrs = Array.isArray(key) ? key : [key]
    const cond = keyStrs.map(k => {
      // Inner per-element literal-wrap, mirror of the main match handler.
      while (Array.isArray(k) && k.length === 2 && k[0] === 'literal') k = k[1]
      return `${inputXgis} == ${typeof k === 'string' ? JSON.stringify(k) : k}`
    }).join(' || ')
    result = `(${cond}) ? ${val} : ${result}`
  }
  // Mirror of the main match + case + coalesce partial-drop warnings.
  // The chained-ternary path is hit when the match input isn't a
  // field-access (e.g. `["concat", …]`, `["downcase", …]`); arms
  // dropped here would otherwise collapse silently to the default
  // for the affected keys.
  if (droppedArms > 0) {
    warnings.push(`["match"] (chained-ternary path) dropped ${droppedArms} arm(s) whose value failed to convert; matching keys will fall through to default.`)
  }
  return result
}
