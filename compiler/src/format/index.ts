// ═══════════════════════════════════════════════════════════════════
// Format dispatch (Batch 1c-2)
// ═══════════════════════════════════════════════════════════════════
//
// Single entry point: `formatValue(value, spec)`. Routes to the
// right typed formatter based on `spec.type`. Used by the template
// evaluator (1c-3) — given a resolved expression value + its
// associated FormatSpec, it returns the display string.
//
// Routing:
//   undefined / 'd' 'f' 'e' 'g' '%' 'n'   → number-formatter
//   's' (or undefined w/ string value)    → number-formatter (string path)
//   'dms' 'dm' 'bearing'                  → gis-formatter (single deg)
//   'mgrs' 'utm'                          → gis-formatter (coord tuple)
//   string starting with '%'              → datetime-formatter (strftime)

import type { FormatSpec } from '../ir/render-node'
import { formatNumber, formatString, padOrTruncate } from './number-formatter'
import {
  formatDMS, formatDM, formatBearing, formatMGRS, formatUTM,
} from './gis-formatter'
import { formatDate } from './datetime-formatter'

export { parseFormatSpec, GIS_TYPES } from './spec-parser'
export { formatNumber, formatString } from './number-formatter'
export { formatDMS, formatDM, formatBearing, formatMGRS, formatUTM } from './gis-formatter'
export { formatDate } from './datetime-formatter'

/** Dispatch a value through the appropriate formatter for its spec.
 *  Returns the value's `String(...)` (padded if width given) when no
 *  spec is provided — letting `{name}` do the obvious thing without
 *  the caller having to special-case it. */
export function formatValue(value: unknown, spec: FormatSpec | undefined): string {
  if (spec === undefined || Object.keys(spec).length === 0) {
    return value === undefined || value === null ? '' : String(value)
  }

  const type = spec.type

  // strftime
  if (type !== undefined && type.startsWith('%')) {
    if (value === null || value === undefined) return ''
    return formatDate(value as never, spec)
  }

  // GIS — single-degree
  if (type === 'dms') return formatDMS(toNumber(value), undefined, spec.precision)
  if (type === 'dm') return formatDM(toNumber(value), undefined, spec.precision)
  if (type === 'bearing') return formatBearing(toNumber(value))

  // GIS — coord tuple
  if (type === 'mgrs') return formatMGRS(toCoordTuple(value), spec.precision)
  if (type === 'utm') return formatUTM(toCoordTuple(value))

  // String type, or no type with string value
  if (type === 's' || (type === undefined && typeof value === 'string')) {
    return formatString(value === null || value === undefined ? '' : String(value), spec)
  }

  // Numeric (default for numbers, or explicit numeric type)
  const n = toNumber(value)
  if (Number.isNaN(n) && typeof value === 'string') {
    // Fall back to string padding for non-numeric strings sent
    // through a numeric spec — keeps templates from crashing on
    // unexpected null/missing properties.
    return padOrTruncate(value, spec)
  }
  return formatNumber(n, spec)
}

// ─── coercion helpers ─────────────────────────────────────────────

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') return parseFloat(v)
  if (typeof v === 'boolean') return v ? 1 : 0
  return NaN
}

function toCoordTuple(v: unknown): [number, number] {
  if (Array.isArray(v) && v.length >= 2) {
    return [Number(v[0]), Number(v[1])]
  }
  return [NaN, NaN]
}
