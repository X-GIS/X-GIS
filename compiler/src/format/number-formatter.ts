// ═══════════════════════════════════════════════════════════════════
// Number formatter (Batch 1c-2)
// ═══════════════════════════════════════════════════════════════════
//
// Two execution paths:
//   - locale === 'C'  → deterministic ASCII formatter, no Intl
//   - otherwise       → Intl.NumberFormat (browser builtin)
//
// The 'C' path is what audit / regression tests pin against. Intl
// output drifts with the runtime's CLDR version, so anything that
// must be byte-identical across browsers/OSes routes through here.
//
// Width / align / fill are applied as a post-step on the formatted
// digit string — the Intl output is never padded by Intl itself.

import type { FormatSpec } from '../ir/render-node'

/** Format a number using a FormatSpec. Throws when `spec.type` is
 *  not numeric — caller is responsible for routing strings/dates/
 *  GIS to the right formatter. */
export function formatNumber(value: number, spec: FormatSpec): string {
  if (!Number.isFinite(value)) {
    // NaN / Infinity short-circuit. Pad to width if requested.
    return padOrTruncate(String(value), spec)
  }

  let body: string
  switch (spec.type) {
    case undefined:
      // Python parity: bare grouping on an integer value uses integer
      // formatting (`{:,}` of 9733509 → "9,733,509"). Without that
      // tweak we'd hit the `g` branch and emit scientific notation.
      if (spec.grouping !== undefined && Number.isInteger(value)) {
        body = formatInteger(value, spec)
        break
      }
      body = formatGeneric(value, spec)
      break
    case 'g':
    case 'G':
      body = formatGeneric(value, spec)
      break
    case 'd':
      body = formatInteger(value, spec)
      break
    case 'f':
      body = formatFixed(value, spec)
      break
    case 'e':
    case 'E':
      body = formatScientific(value, spec)
      break
    case '%':
      body = formatPercent(value, spec)
      break
    case 'n':
      body = formatLocaleNumber(value, spec)
      break
    default:
      throw new Error(`numeric formatter: unsupported type "${spec.type}"`)
  }

  // Sign override (default '-' = only negatives — that's already
  // what the body produced; apply '+' / ' ' if explicitly requested).
  if (spec.sign === '+' && value >= 0 && !body.startsWith('-')) {
    body = '+' + body
  } else if (spec.sign === ' ' && value >= 0 && !body.startsWith('-')) {
    body = ' ' + body
  }

  return padOrTruncate(body, spec)
}

// ─── individual type formatters ───────────────────────────────────

function formatFixed(value: number, spec: FormatSpec): string {
  const precision = spec.precision ?? 6
  if (spec.locale && spec.locale !== 'C') {
    return new Intl.NumberFormat(spec.locale, {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
      useGrouping: spec.grouping !== undefined,
    }).format(value)
  }
  // 'C' or default: deterministic ASCII via toFixed + manual grouping.
  let s = value.toFixed(precision)
  if (spec.grouping) s = applyGrouping(s, spec.grouping)
  return s
}

function formatScientific(value: number, spec: FormatSpec): string {
  const precision = spec.precision ?? 6
  let s = value.toExponential(precision)
  if (spec.type === 'E') s = s.toUpperCase()
  return s
}

function formatPercent(value: number, spec: FormatSpec): string {
  const precision = spec.precision ?? 0
  const scaled = value * 100
  let s = scaled.toFixed(precision)
  if (spec.grouping) s = applyGrouping(s, spec.grouping)
  return s + '%'
}

function formatInteger(value: number, spec: FormatSpec): string {
  const truncated = Math.trunc(value)
  let s = String(truncated)
  if (spec.grouping) s = applyGrouping(s, spec.grouping)
  return s
}

function formatGeneric(value: number, spec: FormatSpec): string {
  // Default Python 'g' picks fixed or scientific based on exponent.
  // Simple approximation: precision=6 significant digits via
  // toPrecision, strip trailing zeros unless 'alt' is set.
  const precision = spec.precision ?? 6
  let s = value.toPrecision(precision)
  if (!spec.alt) {
    // Strip trailing zeros after decimal
    if (s.includes('.') && !s.includes('e')) {
      s = s.replace(/0+$/, '').replace(/\.$/, '')
    }
  }
  if (spec.grouping) s = applyGrouping(s, spec.grouping)
  if (spec.type === 'G') s = s.toUpperCase()
  return s
}

function formatLocaleNumber(value: number, spec: FormatSpec): string {
  const locale = spec.locale && spec.locale !== 'C' ? spec.locale : undefined
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: spec.precision,
    maximumFractionDigits: spec.precision,
  }).format(value)
}

// ─── shared helpers ───────────────────────────────────────────────

/** Insert grouping separators into a numeric string. Handles a
 *  leading sign and an optional decimal portion. */
export function applyGrouping(s: string, sep: ',' | '_'): string {
  let sign = ''
  let body = s
  if (body[0] === '-' || body[0] === '+') { sign = body[0]; body = body.slice(1) }
  const dot = body.indexOf('.')
  const intPart = dot === -1 ? body : body.slice(0, dot)
  const fracPart = dot === -1 ? '' : body.slice(dot)
  // Insert separator every 3 from the right
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep)
  return sign + grouped + fracPart
}

/** Apply width/align/fill as post-formatting padding. */
export function padOrTruncate(s: string, spec: FormatSpec): string {
  const width = spec.width
  if (width === undefined || s.length >= width) return s

  const fill = spec.fill ?? (spec.zero ? '0' : ' ')
  const align = spec.align ?? defaultAlignFor(spec)
  const pad = fill.repeat(width - s.length)

  switch (align) {
    case '<': return s + pad
    case '>': return pad + s
    case '^': {
      const left = pad.slice(0, Math.floor(pad.length / 2))
      const right = pad.slice(left.length)
      return left + s + right
    }
    default: return pad + s
  }
}

/** Numbers default to right-align, strings to left-align. */
function defaultAlignFor(spec: FormatSpec): '<' | '>' | '^' {
  // If 'zero' flag, sign goes first then zeros — right-align.
  if (spec.zero) return '>'
  switch (spec.type) {
    case 's':
    case undefined:
      // Caller routes pure-string to formatString, but if a number
      // hits here without a type, default to right-align (numeric).
      return '>'
    case 'd': case 'f': case 'e': case 'E': case 'g': case 'G':
    case '%': case 'n':
      return '>'
    default:
      return '>'
  }
}

/** String formatting (width / align / truncate). Separated from
 *  formatNumber because the routing is unambiguous: the value is
 *  already a string. */
export function formatString(value: string, spec: FormatSpec): string {
  let s = value
  if (spec.precision !== undefined && s.length > spec.precision) {
    s = s.slice(0, spec.precision)
  }
  // String defaults to left-align unless caller overrode.
  const effectiveSpec: FormatSpec = {
    ...spec,
    align: spec.align ?? '<',
  }
  return padOrTruncate(s, effectiveSpec)
}
