// ═══ Mapbox `collator` locale-aware comparison (CPU, GPU-free) ═══
//
// Mapbox lets a comparison op carry a trailing collator:
//   ["==", a, b, ["collator", { "case-sensitive": false,
//                               "diacritic-sensitive": false,
//                               "locale": "tr" }]]
// The collator controls how the two strings compare — case folding,
// diacritic folding, and locale-specific ordering. `["resolved-locale",
// collator]` reports the BCP-47 tag the collator actually resolved to.
//
// Both are pure CPU primitives backed by the platform `Intl.Collator`, so
// they need no GPU/runtime support and are verifiable by unit tests. The
// converter lowers the collator-bearing comparison to
//   collator_cmp("==", a, b, "<locale>", <caseSensitive>, <diacriticSensitive>)
// and `["resolved-locale", c]` to `resolved_locale("<locale>")`, both
// dispatched through callBuiltin into the functions below.

/** Map Mapbox's two booleans to an Intl.Collator `sensitivity`:
 *   - neither → 'base'    (a = A = á)
 *   - diacritic only → 'accent' (a = A, a ≠ á)
 *   - case only → 'case'  (a ≠ A, a = á)
 *   - both → 'variant'    (a ≠ A ≠ á) */
function sensitivityOf(
  caseSensitive: boolean,
  diacriticSensitive: boolean,
): 'base' | 'accent' | 'case' | 'variant' {
  if (caseSensitive && diacriticSensitive) return 'variant'
  if (caseSensitive) return 'case'
  if (diacriticSensitive) return 'accent'
  return 'base'
}

/** Build an Intl.Collator, falling back to the default locale if the tag
 *  is malformed (Intl.Collator throws a RangeError on bad BCP-47 syntax;
 *  a filter must not die on one authored typo). */
function makeCollator(locale: string, sensitivity: Intl.CollatorOptions['sensitivity']): Intl.Collator {
  const loc = locale === '' ? undefined : locale
  try {
    return new Intl.Collator(loc, { sensitivity })
  } catch {
    return new Intl.Collator(undefined, { sensitivity })
  }
}

function stringify(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}

/** Compare `a` and `b` with the collator's locale/sensitivity and apply
 *  the comparison operator. Non-string operands are stringified (matches
 *  the Intl.Collator contract). */
export function collatorCompare(
  op: string,
  a: unknown,
  b: unknown,
  locale: string,
  caseSensitive: boolean,
  diacriticSensitive: boolean,
): boolean {
  const c = makeCollator(locale, sensitivityOf(caseSensitive, diacriticSensitive))
    .compare(stringify(a), stringify(b))
  switch (op) {
    case '==': return c === 0
    case '!=': return c !== 0
    case '<': return c < 0
    case '<=': return c <= 0
    case '>': return c > 0
    case '>=': return c >= 0
    default: return false
  }
}

/** BCP-47 tag the collator resolves to for `locale` (Mapbox
 *  `["resolved-locale", collator]`). Falls back to the platform default
 *  for an empty or malformed tag. */
export function resolvedLocale(locale: string): string {
  const loc = locale === '' ? undefined : locale
  try {
    return new Intl.Collator(loc).resolvedOptions().locale
  } catch {
    return new Intl.Collator().resolvedOptions().locale
  }
}
