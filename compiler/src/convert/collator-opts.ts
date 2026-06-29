// Shared extractor for Mapbox `["collator", { … }]` options. Used by the
// comparison handler (collator as the trailing 4th arg of ==/!=/</…) and
// the resolved-locale handler. Both lower to CPU builtins (eval/collator.ts).

export interface CollatorOpts {
  readonly locale: string
  readonly caseSensitive: boolean
  readonly diacriticSensitive: boolean
}

/** Peel v8 `["literal", v]` wraps a preprocessor may add around an opt. */
function unwrapLiteral(v: unknown): unknown {
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') v = v[1]
  return v
}

/** Extract constant collator options from a `["collator", optsObj]` node.
 *  Returns null when the node isn't a collator OR any option is a
 *  non-constant expression (this first slice supports only literal
 *  case-sensitive / diacritic-sensitive / locale — the common form). The
 *  caller then falls back to byte-exact compare with a warning. */
export function extractCollatorOpts(collator: unknown): CollatorOpts | null {
  if (!Array.isArray(collator) || collator[0] !== 'collator') return null
  const opts = collator[1]
  // `["collator"]` with no options object → all defaults.
  if (opts === undefined) return { locale: '', caseSensitive: false, diacriticSensitive: false }
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) return null
  const o = opts as Record<string, unknown>
  const cs = unwrapLiteral(o['case-sensitive'])
  const ds = unwrapLiteral(o['diacritic-sensitive'])
  const loc = unwrapLiteral(o['locale'])
  if (cs !== undefined && typeof cs !== 'boolean') return null
  if (ds !== undefined && typeof ds !== 'boolean') return null
  if (loc !== undefined && typeof loc !== 'string') return null
  return {
    locale: typeof loc === 'string' ? loc : '',
    caseSensitive: cs === true,
    diacriticSensitive: ds === true,
  }
}
