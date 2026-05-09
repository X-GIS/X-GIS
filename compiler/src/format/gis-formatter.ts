// ═══════════════════════════════════════════════════════════════════
// GIS-specific formatters (Batch 1c-2)
// ═══════════════════════════════════════════════════════════════════
//
// Format types:
//   dms     — degrees-minutes-seconds: 37.5665 → "37°33'59.4\"N"
//   dm      — degrees-minutes:         37.5665 → "37°33.990'N"
//   bearing — 3-digit padded degrees:    5     → "005°"
//   mgrs    — Military Grid Reference: [lon,lat] → "52SCG1234567890"
//   utm     — UTM zone + easting/northing
//
// `dms`/`dm`/`bearing` accept a single number (degrees). `mgrs`
// and `utm` accept a [lon,lat] tuple — they need both coordinates
// to compute the grid square. Single-number callers will get a
// formatter error (caught by the template evaluator).
//
// Hemisphere suffix (N/S/E/W) for `dms`/`dm` is derived from the
// sign — but the formatter doesn't know if the value is latitude
// or longitude. Convention: positive → N or E, negative → S or W,
// driven by an optional axis hint. When the spec doesn't carry the
// hint, we omit the suffix (the user is expected to supply it as
// literal text in the template, e.g. "{lat:dms}N").

export type CoordTuple = [number, number]
export type Axis = 'lat' | 'lon' | undefined

/** Format a single signed-degree value as DMS.
 *  axis: 'lat' → N/S suffix; 'lon' → E/W suffix; undefined → no suffix. */
export function formatDMS(deg: number, axis: Axis = undefined, precision = 1): string {
  if (!Number.isFinite(deg)) return String(deg)
  const sign = deg < 0 ? -1 : 1
  const abs = Math.abs(deg)
  const d = Math.floor(abs)
  const minTotal = (abs - d) * 60
  const m = Math.floor(minTotal)
  const s = (minTotal - m) * 60
  const sStr = s.toFixed(precision)
  const suffix = axis === 'lat' ? (sign < 0 ? 'S' : 'N')
    : axis === 'lon' ? (sign < 0 ? 'W' : 'E')
    : (sign < 0 ? '-' : '')
  const prefix = axis ? '' : (sign < 0 ? '' : '')
  return `${prefix}${d}°${m}'${sStr}"${suffix}`
}

/** Degrees-decimal-minutes (no seconds). */
export function formatDM(deg: number, axis: Axis = undefined, precision = 3): string {
  if (!Number.isFinite(deg)) return String(deg)
  const sign = deg < 0 ? -1 : 1
  const abs = Math.abs(deg)
  const d = Math.floor(abs)
  const minTotal = (abs - d) * 60
  const mStr = minTotal.toFixed(precision)
  const suffix = axis === 'lat' ? (sign < 0 ? 'S' : 'N')
    : axis === 'lon' ? (sign < 0 ? 'W' : 'E')
    : (sign < 0 ? '-' : '')
  return `${d}°${mStr}'${suffix}`
}

/** 3-digit bearing (000–360). Wraps negatives into 0-360 range. */
export function formatBearing(deg: number): string {
  if (!Number.isFinite(deg)) return String(deg)
  const wrapped = ((deg % 360) + 360) % 360
  const rounded = Math.round(wrapped)
  return `${String(rounded).padStart(3, '0')}°`
}

// ─── MGRS / UTM ───────────────────────────────────────────────────
//
// Full MGRS implementation involves the World Geodetic System +
// universal grid system reference — non-trivial. For 1c-2 we
// stub these to produce a clearly-marked placeholder ("[MGRS not
// yet implemented]") so labels don't crash; the algorithm lands
// in 1c-2b along with cross-validation against the canonical
// proj4/mgrs.js outputs (the cross-validation infra at
// scripts/cross-validation already pins coordinate math to
// external references — same pattern applies here).
//
// Including the formatter signatures now (rather than throwing)
// lets the converter and template parser wire types correctly
// without runtime failures during early Batch 1c iterations.

export function formatMGRS(_coord: CoordTuple, _precision = 5): string {
  return '[MGRS pending impl]'
}

export function formatUTM(_coord: CoordTuple): string {
  return '[UTM pending impl]'
}
