// ═══ #2137 — CPU-f64 trig for the raster/drape grid vertex ═══
//
// `vs_tile` used to build the ~6.4e6 m ECEF from angles on the GPU. Every
// transcendental on that path multiplies the EARTH RADIUS, so a backend's
// relative trig error lands as METRES of ground displacement — 1.17e+3 m
// measured on SwiftShader against a 2 m f32 floor
// (playground/e2e/_raster-grid-lat-parity.spec.ts).
//
// Deriving the LATITUDE more precisely does NOT help, and that was measured, not
// assumed: feeding the shader an exact latitude left the error unchanged, because
// `lonlat_to_ecef`'s own sin/cos/sqrt dominate. The fix is to remove every
// transcendental from that path, which is what this table does — the shader then
// only multiplies. Same reason #2089 worked for lines: its ENU trig scales the
// small corner offset, never R.
//
// Extracted from raster-renderer.ts rather than growing it: the LOC ratchet's
// "extract, don't grow" is the right call for a self-contained pure function.

import { activeBody } from '@xgis/shared'

/** Rows/cols of the vs_tile trig table (#2137) — 9 vec4s each, flat lanes.
 *
 *  The VS used to build the ~6.4e6 m ECEF from angles itself, so every
 *  transcendental it evaluated multiplied the Earth radius and a backend's
 *  relative trig error landed as METRES of ground displacement (1.17e+3 m
 *  measured on SwiftShader). These are the same values computed in f64 here, so
 *  the shader only multiplies.
 *
 *  Filled ONLY for gridN 8 — `rasterGridN` floors there for every tileZoom ≥ 4,
 *  which is where the error is visible, and the shader's `useTrigTable` reads
 *  the table only then. Coarser tiles get zeros they never sample.
 *
 *  `merc_y` holds the DIMENSIONLESS log-tangent (vector-drape-renderer's
 *  `mercY`, and vs_tile's `2*atan(exp(mercYAbs)) - PI/2` with no radius
 *  divide) — NOT Mercator metres. `mercatorYToLatRad` divides by EARTH_RADIUS
 *  and is therefore the wrong inverse here; using it would shift every grid
 *  vertex silently. */
export function rasterGridTrig(
  west: number,
  east: number,
  mercSouth: number,
  mercDiff: number,
  gridN: number,
): { rows: number[]; cols: number[] } {
  const rows = new Array<number>(36).fill(0)
  const cols = new Array<number>(36).fill(0)
  if (gridN !== 8) return { rows, cols }
  // Same body seam the emitted WGSL constants route through, so the CPU table
  // and the shader's (1 - e2) factor cannot describe different ellipsoids.
  const body = activeBody()
  const A = body.a
  const E2 = body.e2
  for (let j = 0; j <= 8; j++) {
    // Mirrors vs_tile exactly: vv = gy / N, mercYAbs = merc_south + (1 - vv) * merc_diff.
    const vv = j / 8
    const mercYAbs = mercSouth + (1 - vv) * mercDiff
    const lat = 2 * Math.atan(Math.exp(mercYAbs)) - Math.PI / 2
    const sinLat = Math.sin(lat)
    const cosLat = Math.cos(lat)
    rows[j * 4] = sinLat
    rows[j * 4 + 1] = cosLat
    rows[j * 4 + 2] = A / Math.sqrt(1 - E2 * sinLat * sinLat) // prime vertical N
  }
  for (let i = 0; i <= 8; i++) {
    // Mirrors vs_tile's `lon = mix(bounds.x, bounds.z, uu)`, uu = gx / N. `west`
    // and `east` are already world-copy shifted by the caller, so the table is
    // per-copy — exactly like the `bounds` lanes it mirrors.
    const uu = i / 8
    const lonRad = ((west + (east - west) * uu) * Math.PI) / 180
    cols[i * 4] = Math.sin(lonRad)
    cols[i * 4 + 1] = Math.cos(lonRad)
  }
  return { rows, cols }
}
