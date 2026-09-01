// Shared extractor for Mapbox `["collator", { … }]` options. Used by the
// comparison handler (collator as the trailing 4th arg of ==/!=/</…), which
// lowers to the `collator_cmp` CPU builtin (eval/collator.ts). The
// resolved-locale handler reads the `locale` opt itself and deliberately does
// NOT come through here — see expr-lookup.ts:resolvedLocaleHandler.

import type { Recurse } from './expr-handler-types'

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
 *  caller then tries {@link lowerCollatorOptSlots}, which admits a per-feature
 *  expression in any slot, and only falls back to byte-exact compare with a
 *  warning when that fails too. */
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

/** Lowered xgis source for `collator_cmp`'s three option slots. Each entry is
 *  either a literal (`false`, `"tr"`) or a converted expression (`.lang`). */
export interface CollatorOptSlots {
  readonly locale: string
  readonly caseSensitive: string
  readonly diacriticSensitive: string
}

/** Lower a `["collator", opts]` node's options to xgis source fragments,
 *  admitting a PER-FEATURE expression in any slot.
 *
 *  `collator_cmp` is a CPU builtin and `callBuiltin` dispatches on
 *  already-evaluated arguments, so an expression in an option slot is decided
 *  at eval time — it never had to be a compile-time literal. The Mapbox spec
 *  agrees: its collator holds all three options as expressions and evaluates
 *  them per feature.
 *
 *  Callers reach this only after {@link extractCollatorOpts} returned null, so
 *  the all-constant and no-options forms are already handled upstream.
 *
 *  Returns null — after pushing ONE warning that names the actual reason — for
 *  a non-object options argument, a constant of the wrong type
 *  (`"case-sensitive": "yes"`, which must NOT be recursed: the emitted string
 *  would be coerced to a case-sensitivity the style never authored), and an
 *  option expression this converter cannot lower. The three are distinct and
 *  the message says which: calling an unsupported-operator failure "malformed
 *  options" sends the author to fix an options object that is correct. */
export function lowerCollatorOptSlots(
  collator: unknown,
  warnings: string[],
  recurse: Recurse,
  op: string,
): CollatorOptSlots | null {
  if (!Array.isArray(collator) || collator[0] !== 'collator') return null
  const tail = 'falling back to byte-exact compare.'
  const opts = collator[1]
  // Mirrors the reference implementation's own "Collator options argument must
  // be an object." parse error. `undefined` lands here too and is likewise
  // rejected — the no-options form never reaches this function.
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    warnings.push(
      `["${op}"] ["collator", …] options argument must be an object literal; got ${JSON.stringify(opts) ?? typeof opts} — ${tail}`,
    )
    return null
  }
  const o = opts as Record<string, unknown>
  const slot = (key: string, kind: 'boolean' | 'string', missing: string): string | null => {
    const raw = o[key]
    // A genuine expression (`["get", …]`, `["case", …]`) lowers into the slot.
    // A `["literal", v]` wrap is the CONSTANT spelling — the same unwrap
    // extractCollatorOpts applies — so it never recurses.
    if (Array.isArray(raw) && raw[0] !== 'literal') {
      const lowered = recurse(raw, warnings)
      if (lowered === null) {
        // The options object is well-formed; the EXPRESSION in this slot is
        // one this converter has no lowering for. `recurse` has already said
        // which operator — don't repeat it, and don't call the object malformed.
        warnings.push(
          `["${op}"] ["collator", …] "${key}" option expression could not be converted (see the preceding diagnostic) — ${tail}`,
        )
      }
      return lowered
    }
    const v = unwrapLiteral(raw)
    if (v === undefined) return missing
    if (typeof v !== kind) {
      warnings.push(
        `["${op}"] ["collator", …] "${key}" must be a ${kind} or an expression yielding one; got ${JSON.stringify(v) ?? typeof v}. Recursing it would coerce a value the style never authored — ${tail}`,
      )
      return null
    }
    return JSON.stringify(v)
  }
  // Same order the reference implementation parses the options in.
  const caseSensitive = slot('case-sensitive', 'boolean', 'false')
  if (caseSensitive === null) return null
  const diacriticSensitive = slot('diacritic-sensitive', 'boolean', 'false')
  if (diacriticSensitive === null) return null
  const locale = slot('locale', 'string', '""')
  if (locale === null) return null
  return { locale, caseSensitive, diacriticSensitive }
}
