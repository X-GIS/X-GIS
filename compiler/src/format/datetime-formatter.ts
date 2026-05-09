// ═══════════════════════════════════════════════════════════════════
// Datetime formatter (Batch 1c-2)
// ═══════════════════════════════════════════════════════════════════
//
// Accepts a Date, an ISO 8601 string, or a Unix epoch (ms or s,
// auto-detected by magnitude). Formats via a strftime-subset
// pattern. The pattern itself is in `spec.type` (templates that
// start with '%' are routed here).
//
// Two execution paths, mirroring number-formatter:
//   - locale 'C' or undefined → deterministic ASCII (UTC-based)
//   - other locale            → Intl.DateTimeFormat for parts
//
// strftime tokens supported (subset that covers GIS use):
//   %Y  4-digit year       %m  2-digit month       %d  2-digit day
//   %H  2-digit hour 24    %M  2-digit minute      %S  2-digit second
//   %y  2-digit year       %j  day of year         %s  unix seconds
//   %a  short weekday      %A  long weekday        %b  short month
//   %B  long month         %p  AM/PM               %Z  timezone abbr
//   %z  ±HHMM offset       %%  literal %

import type { FormatSpec } from '../ir/render-node'

export type DateInput = Date | string | number

export function formatDate(value: DateInput, spec: FormatSpec): string {
  const date = coerceDate(value)
  if (!date || isNaN(date.getTime())) return String(value)
  const pattern = spec.type ?? ''
  const useIntl = spec.locale !== undefined && spec.locale !== 'C'
  const useUTC = !useIntl  // 'C' or undefined → UTC for determinism

  return pattern.replace(/%[YymdHMSjsaAbBpZz%]/g, token => {
    switch (token) {
      case '%Y': return String(useUTC ? date.getUTCFullYear() : date.getFullYear())
      case '%y': return pad2((useUTC ? date.getUTCFullYear() : date.getFullYear()) % 100)
      case '%m': return pad2((useUTC ? date.getUTCMonth() : date.getMonth()) + 1)
      case '%d': return pad2(useUTC ? date.getUTCDate() : date.getDate())
      case '%H': return pad2(useUTC ? date.getUTCHours() : date.getHours())
      case '%M': return pad2(useUTC ? date.getUTCMinutes() : date.getMinutes())
      case '%S': return pad2(useUTC ? date.getUTCSeconds() : date.getSeconds())
      case '%j': return String(dayOfYear(date, useUTC)).padStart(3, '0')
      case '%s': return String(Math.floor(date.getTime() / 1000))
      case '%a': return weekdayShort(date, useUTC, spec.locale)
      case '%A': return weekdayLong(date, useUTC, spec.locale)
      case '%b': return monthShort(date, useUTC, spec.locale)
      case '%B': return monthLong(date, useUTC, spec.locale)
      case '%p': return (useUTC ? date.getUTCHours() : date.getHours()) < 12 ? 'AM' : 'PM'
      case '%Z': return useUTC ? 'UTC' : tzAbbr(date, spec.locale)
      case '%z': return useUTC ? '+0000' : tzOffset(date)
      case '%%': return '%'
      default: return token
    }
  })
}

// ─── helpers ──────────────────────────────────────────────────────

function coerceDate(v: DateInput): Date | null {
  if (v instanceof Date) return v
  if (typeof v === 'number') {
    // Heuristic: > 1e12 → ms; otherwise seconds. (1e12 ms = 2001.)
    return new Date(v > 1e12 ? v : v * 1000)
  }
  if (typeof v === 'string') {
    const d = new Date(v)
    return isNaN(d.getTime()) ? null : d
  }
  return null
}

function pad2(n: number): string { return n < 10 ? '0' + n : String(n) }

function dayOfYear(d: Date, utc: boolean): number {
  const start = utc
    ? Date.UTC(d.getUTCFullYear(), 0, 0)
    : new Date(d.getFullYear(), 0, 0).getTime()
  return Math.floor((d.getTime() - start) / 86400000)
}

const C_WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const C_WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const C_MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const C_MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

function weekdayShort(d: Date, utc: boolean, locale?: string): string {
  if (utc || !locale) return C_WEEKDAY_SHORT[d.getUTCDay()]!
  return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(d)
}
function weekdayLong(d: Date, utc: boolean, locale?: string): string {
  if (utc || !locale) return C_WEEKDAY_LONG[d.getUTCDay()]!
  return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(d)
}
function monthShort(d: Date, utc: boolean, locale?: string): string {
  if (utc || !locale) return C_MONTH_SHORT[d.getUTCMonth()]!
  return new Intl.DateTimeFormat(locale, { month: 'short' }).format(d)
}
function monthLong(d: Date, utc: boolean, locale?: string): string {
  if (utc || !locale) return C_MONTH_LONG[d.getUTCMonth()]!
  return new Intl.DateTimeFormat(locale, { month: 'long' }).format(d)
}

function tzAbbr(d: Date, locale?: string): string {
  // Best-effort short timezone name via Intl.
  try {
    const parts = new Intl.DateTimeFormat(locale ?? 'en-US', {
      timeZoneName: 'short',
    }).formatToParts(d)
    const tz = parts.find(p => p.type === 'timeZoneName')
    return tz?.value ?? ''
  } catch { return '' }
}

function tzOffset(d: Date): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`
}
