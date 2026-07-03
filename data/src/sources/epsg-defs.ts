import proj4 from 'proj4'

// ═══ EPSG definitions registry ═══
//
// proj4 ships built-in definitions for the two CRS the display pipeline
// already uses end-to-end — EPSG:4326 (WGS84 lon/lat) and EPSG:3857
// (Web Mercator). Input data, however, can arrive in any authority code.
// This module registers proj4 def strings for the EPSG codes X-GIS needs
// for input-reprojection that proj4 does NOT bundle, and exposes a single
// lookup that throws a clear, source-attributable error for anything that
// is unregistered or malformed. A silent fallback to 4326 would render
// data in the wrong place — per the plan, invalid EPSG is a hard error.
//
// AC0 precision (spike, 2026-05-22): proj4js reprojection of EPSG:5179 and
// EPSG:5186 reference points was compared against the pyproj cross-validation
// reference (scripts/cross-validation), measured at FINAL Web Mercator
// (EPSG:3857) meters. Max divergence across 10 Korea reference points was
// 3.73e-9 m (≈ 3.7 nanometres) — pure f64 round-off; proj4js and pyproj
// agree on the Transverse-Mercator + Web-Mercator math when GRS80 is used
// with no datum shift to WGS84.
//
//   DECIDED <1mm CROSS-VALIDATION TOLERANCE: 1e-3 m (1 mm), measured at
//   EPSG:3857 meters. Achievable with ~6 orders of magnitude of margin
//   using the standard def strings below — no high-precision pinning or
//   tolerance relaxation required. Downstream cross-validation (AC5) MUST
//   use this 1mm bound.

// ─── def strings for codes proj4 does not bundle ───
//
// Both are Korea 2000 datum (GRS80 ellipsoid). Korea 2000 is realised on
// ITRF and is treated as coincident with WGS84 at MVP precision (no
// +towgs84 shift needed — the AC0 spike confirmed sub-nanometre agreement
// with pyproj, which also applies no datum shift for these codes).
const BUNDLED_DEFS: Readonly<Record<string, string>> = {
  // EPSG:5179 — Korea 2000 / Unified CS (UTM-K). Single nationwide TM zone.
  'EPSG:5179':
    '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 ' +
    '+ellps=GRS80 +units=m +no_defs +type=crs',
  // EPSG:5186 — Korea 2000 / Central Belt 2010. lon_0=127, k=1.
  'EPSG:5186':
    '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 ' +
    '+ellps=GRS80 +units=m +no_defs +type=crs',
}

// proj4's own built-ins, recognised without registration.
const PROJ4_BUILTINS = new Set(['EPSG:4326', 'EPSG:3857', 'WGS84'])

let registered = false

/** Idempotently register the def strings above with proj4. */
function ensureRegistered(): void {
  if (registered) return
  for (const [code, def] of Object.entries(BUNDLED_DEFS)) {
    proj4.defs(code, def)
  }
  registered = true
}

/**
 * Normalise an EPSG identifier to canonical `EPSG:<code>` form.
 *
 * Accepts `"EPSG:5179"`, `"epsg:5179"`, `"5179"`, or `5179`. Anything else
 * — empty, non-numeric, malformed — throws.
 */
export function normalizeEPSG(code: string | number): string {
  if (typeof code === 'number') {
    if (!Number.isInteger(code) || code <= 0) {
      throw new Error(`Invalid EPSG code: ${code} (expected a positive integer)`)
    }
    return `EPSG:${code}`
  }
  const trimmed = code.trim()
  if (trimmed === '') {
    throw new Error('Invalid EPSG code: empty string')
  }
  // Bare numeric form, e.g. "5179".
  if (/^\d+$/.test(trimmed)) {
    return `EPSG:${trimmed}`
  }
  // "EPSG:5179" / "epsg:5179" form.
  const m = /^epsg:(\d+)$/i.exec(trimmed)
  if (m) {
    return `EPSG:${m[1]}`
  }
  throw new Error(`Invalid EPSG code: "${code}" (expected "EPSG:<n>" or "<n>")`)
}

/**
 * Resolve an EPSG identifier to a proj4-recognised CRS name, registering
 * the bundled def strings on first use.
 *
 * @returns the canonical `EPSG:<code>` string ready to pass to `proj4(...)`.
 * @throws if the code is malformed, or if it is neither a proj4 built-in
 *         nor one of the registered defs.
 */
export function resolveEPSG(code: string | number): string {
  ensureRegistered()
  const normalized = normalizeEPSG(code)
  if (PROJ4_BUILTINS.has(normalized) || normalized in BUNDLED_DEFS) {
    return normalized
  }
  throw new Error(
    `Unsupported EPSG code: "${normalized}". ` +
      `Registered codes: ${Object.keys(BUNDLED_DEFS).join(', ')}, ` +
      `EPSG:4326, EPSG:3857. ` +
      `Register a proj4 def for "${normalized}" to use it.`,
  )
}

/** The EPSG codes for which this registry ships proj4 def strings. */
export const REGISTERED_EPSG_CODES: readonly string[] = Object.keys(BUNDLED_DEFS)
