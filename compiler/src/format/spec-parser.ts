// ═══════════════════════════════════════════════════════════════════
// Format spec mini-language parser (Batch 1c-2)
// ═══════════════════════════════════════════════════════════════════
//
// Parses the spec portion of `{<expr>:<spec>;<locale>}` into a
// FormatSpec object. The spec subset we support:
//
//   [<fill><align>][<sign>][#][0][<width>][<grouping>][.<precision>][<type>]
//
// Plus an X-GIS extension: `;<locale>` tail (BCP-47 tag, or the
// special value `C` for deterministic POSIX output).
//
// Examples (the bit AFTER the `:` in `{expr:spec}`):
//   ".4f"        precision 4, type 'f'
//   ",.0f"       grouping ',', precision 0, type 'f'
//   ">10"        right-align width 10 (string default)
//   "*^15s"      fill '*', center-align, width 15, type 's'
//   "+.3e"       force sign, precision 3, scientific
//   "03d"        zero-padded width 3 integer
//   "%Y-%m-%d"   strftime — leading '%' triggers date type capture
//   "dms"        GIS type — degrees-minutes-seconds
//   ".2f;C"      precision 2 fixed-point, deterministic locale
//
// Returns `undefined` on empty input. Throws on syntactically
// invalid input — caller (template parser) decides whether to
// surface a converter warning or fall back to a default spec.

import type { FormatSpec } from '../ir/render-node'

export interface ParseResult {
  spec: FormatSpec
  /** Number of input characters consumed. Useful when the spec is
   *  embedded in a larger token (the template parser scans until
   *  the closing `}` and slices). */
  consumed: number
}

const ALIGN_CHARS = new Set(['<', '>', '^'])
const SIGN_CHARS = new Set(['+', '-', ' '])
const GROUPING_CHARS = new Set([',', '_'])

/** GIS-specific type names (no Python equivalent). Distinguished
 *  from numeric/string types so the formatter dispatcher knows to
 *  reject precision/grouping that don't apply. */
export const GIS_TYPES = new Set(['dms', 'dm', 'mgrs', 'utm', 'bearing'])

/** Single-character Python format types (numeric + string). */
const SINGLE_CHAR_TYPES = new Set([
  'd', 'f', 'e', 'E', 'g', 'G', '%', 'n',  // numeric
  's',                                      // string
  'b', 'o', 'x', 'X', 'c',                  // ints (rare for labels)
])

/** Parse a format spec string. Returns spec + how many input
 *  characters were consumed (so callers embedding this in a larger
 *  expression can resume parsing after). When `input` is empty or
 *  whitespace-only, returns spec={} consumed=0. */
export function parseFormatSpec(input: string): ParseResult {
  const spec: FormatSpec = {}
  if (!input) return { spec, consumed: 0 }

  // strftime fast-path: a spec starting with '%' is a date format.
  // Capture until ';' (locale) or end. The rest of the mini-language
  // doesn't apply.
  if (input.startsWith('%')) {
    const semi = input.indexOf(';')
    const end = semi === -1 ? input.length : semi
    spec.type = input.slice(0, end)
    if (semi !== -1) {
      const loc = parseLocaleTail(input.slice(semi))
      spec.locale = loc.locale
      return { spec, consumed: end + loc.consumed }
    }
    return { spec, consumed: end }
  }

  // GIS type fast-path: the WHOLE spec is one of the GIS type
  // names (optionally followed by ;<locale>). They cannot be
  // mixed with width/precision/etc — formatter owns the layout.
  const gisMatch = matchGisTypePrefix(input)
  if (gisMatch !== null) {
    spec.type = gisMatch.type
    let consumed = gisMatch.length
    if (input[consumed] === ';') {
      const loc = parseLocaleTail(input.slice(consumed))
      spec.locale = loc.locale
      consumed += loc.consumed
    }
    return { spec, consumed }
  }

  let i = 0

  // [fill][align] — fill is any single char, but we can only know
  // it's fill if the NEXT char is an align char. Otherwise the
  // first char is the align (and fill defaults).
  if (i + 1 < input.length && ALIGN_CHARS.has(input[i + 1] ?? '')) {
    spec.fill = input[i]
    spec.align = input[i + 1] as '<' | '>' | '^'
    i += 2
  } else if (ALIGN_CHARS.has(input[i] ?? '')) {
    spec.align = input[i] as '<' | '>' | '^'
    i += 1
  }

  // [sign]
  if (SIGN_CHARS.has(input[i] ?? '')) {
    spec.sign = input[i] as '+' | '-' | ' '
    i += 1
  }

  // [#]
  if (input[i] === '#') { spec.alt = true; i += 1 }

  // [0]
  if (input[i] === '0') { spec.zero = true; i += 1 }

  // [width] — digit run
  let widthStart = i
  while (i < input.length && isDigit(input[i] ?? '')) i += 1
  if (i > widthStart) spec.width = parseInt(input.slice(widthStart, i), 10)

  // [grouping]
  if (GROUPING_CHARS.has(input[i] ?? '')) {
    spec.grouping = input[i] as ',' | '_'
    i += 1
  }

  // [.precision]
  if (input[i] === '.') {
    i += 1
    const precStart = i
    while (i < input.length && isDigit(input[i] ?? '')) i += 1
    if (i === precStart) {
      throw new Error(`format spec: '.' must be followed by precision digits at "${input}"`)
    }
    spec.precision = parseInt(input.slice(precStart, i), 10)
  }

  // [type]
  if (i < input.length && input[i] !== ';') {
    const c = input[i] ?? ''
    if (SINGLE_CHAR_TYPES.has(c)) {
      spec.type = c
      i += 1
    } else {
      throw new Error(`format spec: unknown type "${c}" at "${input}"`)
    }
  }

  // [;locale]
  if (input[i] === ';') {
    const loc = parseLocaleTail(input.slice(i))
    spec.locale = loc.locale
    i += loc.consumed
  }

  return { spec, consumed: i }
}

// ─── helpers ──────────────────────────────────────────────────────

function isDigit(c: string): boolean { return c >= '0' && c <= '9' }

function matchGisTypePrefix(s: string): { type: string; length: number } | null {
  for (const t of GIS_TYPES) {
    if (s.startsWith(t)) {
      const after = s[t.length]
      if (after === undefined || after === ';') return { type: t, length: t.length }
    }
  }
  return null
}

function parseLocaleTail(s: string): { locale: string; consumed: number } {
  // s starts with ';'. Locale is the tail until next ';' or EOI.
  const rest = s.slice(1)
  const semi = rest.indexOf(';')
  const end = semi === -1 ? rest.length : semi
  const locale = rest.slice(0, end).trim()
  if (locale.length === 0) {
    throw new Error(`format spec: empty locale after ';' in "${s}"`)
  }
  return { locale, consumed: 1 + end }
}
