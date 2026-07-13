// ═══ Tile camera-anchor authority — the drift guard for #1044 ═══
//
// This is the test tile-camera-anchor.ts names ("guarded by
// tile-camera-anchor-authority.test.ts"). It pins TWO things:
//
//   Part 1 — the f64 math of computeTileCameraAnchor, recomputed here with the
//     same double-precision formulas and op order and asserted lane-for-lane
//     (===, not tolerance). If someone "simplifies" the Mercator DSFUN split or
//     drops the ellipsoid camera term, an exact lane diverges here — including
//     the ellipsoid-vs-sphere guard that documents the ~21.5 km class regression
//     #1044 was adjacent to.
//
//   Part 2 — the source-authority gate: the single-authority invariant is a
//     text fact about vector-tile-renderer.ts (exactly four callers route
//     through the helper; exactly one block hard-zeros the ECEF lanes; only the
//     clip_bounds pair inlines the Mercator-Y formula). #1044 was a twin pack
//     hard-zeroing cam_ecef_off — re-inlining or re-zeroing anchor math is how
//     the seam drifts back, so the counts are frozen with actionable messages.
//
// GPU-free; rides the `test (map)` CI leg like the co-located ratchets.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EARTH, activeBody } from '@xgis/shared'
import { computeTileCameraAnchor, clampMercLat } from './tile-camera-anchor'

// Same three constants the authority reads (activeBody() defaults to EARTH here
// — no configureBody call, so R stays the WGS84 semi-major axis).
const DEG2RAD = Math.PI / 180
const R = activeBody().sphereR
const E2 = EARTH.e2

interface AnchorCase {
  label: string
  west: number
  south: number
  worldOff: number
  camLon: number
  camLat: number
}

// (a) Tokyo-ish z14; (b) world tile at the z0 corner; (c) = (a) shifted one
// world copy east; (d) tileSouth above the Mercator singularity (clamp must keep
// tileMercY finite — without the clamp log(tan(90°)) = +Inf).
const CASES: readonly AnchorCase[] = [
  {
    label: 'Tokyo z14',
    west: 139.74609375,
    south: 35.68359375,
    worldOff: 0,
    camLon: 139.7671,
    camLat: 35.6812,
  },
  { label: 'world z0 corner', west: -180, south: -85.051129, worldOff: 0, camLon: 10, camLat: 20 },
  {
    label: 'Tokyo z14, worldOff=360',
    west: 139.74609375,
    south: 35.68359375,
    worldOff: 360,
    camLon: 139.7671,
    camLat: 35.6812,
  },
  {
    label: 'tileSouth=90 (above Mercator limit)',
    west: 139.74609375,
    south: 90,
    worldOff: 0,
    camLon: 139.7671,
    camLat: 35.6812,
  },
]

// ── Reference math — byte-identical formulas / op order to the authority ──
const rawTileMercX = (west: number, worldOff: number): number => (west + worldOff) * DEG2RAD * R
const rawMercY = (latDeg: number): number =>
  Math.log(Math.tan(Math.PI / 4 + (clampMercLat(latDeg) * DEG2RAD) / 2)) * R
const camMercX = (camLon: number): number => camLon * DEG2RAD * R

// ECEF RTC offset with independent tile/camera eccentricity so the sphere guard
// below can force the CAMERA term onto a sphere while the tile stays ellipsoid.
// With the defaults (tileE2 = camE2 = EARTH.e2) this is bit-identical to the
// authority's offX/offY/offZ. Latitudes clamped before the trig; longitudes not.
function refEcef(
  c: AnchorCase,
  tileE2: number = E2,
  camE2: number = E2,
): { offX: number; offY: number; offZ: number } {
  const tLatR = clampMercLat(c.south) * DEG2RAD
  const tLonR = c.west * DEG2RAD
  const tSin = Math.sin(tLatR)
  const tCos = Math.cos(tLatR)
  const tN = R / Math.sqrt(1 - tileE2 * tSin * tSin)
  const camLatR = clampMercLat(c.camLat) * DEG2RAD
  const camLonR = c.camLon * DEG2RAD
  const camSin = Math.sin(camLatR)
  const camCos = Math.cos(camLatR)
  const cN = R / Math.sqrt(1 - camE2 * camSin * camSin)
  const offX = tN * tCos * Math.cos(tLonR) - cN * camCos * Math.cos(camLonR)
  const offY = tN * tCos * Math.sin(tLonR) - cN * camCos * Math.sin(camLonR)
  const offZ = tN * (1 - tileE2) * tSin - cN * (1 - camE2) * camSin
  return { offX, offY, offZ }
}

describe('computeTileCameraAnchor: f64 lane parity (#1044)', () => {
  for (const c of CASES) {
    it(`every lane === the recomputed reference — ${c.label}`, () => {
      const a = computeTileCameraAnchor(c.west, c.south, c.worldOff, c.camLon, c.camLat)

      // Mercator tile-origin lanes (f32-rounded, worldOff applied).
      expect(a.tileMercX).toBe(Math.fround(rawTileMercX(c.west, c.worldOff)))
      expect(a.tileMercY).toBe(Math.fround(rawMercY(c.south)))
      // The clamp keeps the singular tile finite (case d proves +Inf is avoided).
      expect(Number.isFinite(a.tileMercY)).toBe(true)

      // Mercator camera-relative DSFUN pair — the cancellation uses the RAW
      // (non-fround) tile origin, split hi/lo with the same op order.
      const relX = camMercX(c.camLon) - rawTileMercX(c.west, c.worldOff)
      const relY = rawMercY(c.camLat) - rawMercY(c.south)
      const camXH = Math.fround(relX)
      const camYH = Math.fround(relY)
      expect(a.camXH).toBe(camXH)
      expect(a.camXL).toBe(Math.fround(relX - camXH))
      expect(a.camYH).toBe(camYH)
      expect(a.camYL).toBe(Math.fround(relY - camYH))

      // Ellipsoid ECEF RTC lanes — hi = fround(off), lo = fround(off − hi).
      const { offX, offY, offZ } = refEcef(c)
      const xh = Math.fround(offX)
      const yh = Math.fround(offY)
      const zh = Math.fround(offZ)
      expect(a.ecefXH).toBe(xh)
      expect(a.ecefXL).toBe(Math.fround(offX - xh))
      expect(a.ecefYH).toBe(yh)
      expect(a.ecefYL).toBe(Math.fround(offY - yh))
      expect(a.ecefZH).toBe(zh)
      expect(a.ecefZL).toBe(Math.fround(offZ - zh))
    })
  }

  it('ECEF is world-copy invariant; Mercator/cam lanes shift with worldOff', () => {
    const base = CASES[0]
    const a = computeTileCameraAnchor(base.west, base.south, 0, base.camLon, base.camLat)
    const c = computeTileCameraAnchor(base.west, base.south, 360, base.camLon, base.camLat)
    // ECEF uses the tile longitude WITHOUT worldOff — world copies share one
    // ellipsoid origin, so all six lanes are strictly identical.
    expect(c.ecefXH).toBe(a.ecefXH)
    expect(c.ecefXL).toBe(a.ecefXL)
    expect(c.ecefYH).toBe(a.ecefYH)
    expect(c.ecefYL).toBe(a.ecefYL)
    expect(c.ecefZH).toBe(a.ecefZH)
    expect(c.ecefZL).toBe(a.ecefZL)
    // The Mercator lanes DO move one world copy east.
    expect(c.tileMercX).not.toBe(a.tileMercX)
    expect(c.camXH).not.toBe(a.camXH)
    expect(c.camXL).not.toBe(a.camXL)
  })

  it('the ellipsoid CAMERA term matters — a sphere camera shifts offZ >10 km', () => {
    const c = CASES[0] // Tokyo z14
    const ellipsoidOffZ = refEcef(c, E2, E2).offZ
    // Force E2→0 on the CAMERA term only (ellipsoid tile vertices + spherical
    // camera origin) — the #1044-adjacent regression the authority names. NOTE:
    // forcing E2→0 on BOTH terms (a full sphere) would NOT trip this — the
    // ellipsoid−sphere bias cancels between the two ~1 km-apart points in the RTC
    // difference (~0.7 m). The regression lives in the camera term, where the
    // ~21.5 km class error is; the guard isolates exactly that.
    const sphereCameraOffZ = refEcef(c, E2, 0).offZ
    expect(Math.abs(ellipsoidOffZ - sphereCameraOffZ)).toBeGreaterThan(10_000)
  })

  it('clampMercLat pins the Web-Mercator singularity limit', () => {
    expect(clampMercLat(90)).toBe(85.051129)
    expect(clampMercLat(-90)).toBe(-85.051129)
    expect(clampMercLat(12.34)).toBe(12.34)
  })
})

// ── Part 2 — source-authority gate ──
// Read the SIBLING source (resolve relative to this file's directory, mirroring
// the ratchet-test convention) and freeze the single-authority footprint.
const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'vector-tile-renderer.ts'),
  'utf8',
)

describe('source-authority gate: the anchor seam cannot silently drift (#1044)', () => {
  it('exactly four callers route through computeTileCameraAnchor()', () => {
    const n = (SOURCE.match(/computeTileCameraAnchor\(/g) ?? []).length
    expect(
      n,
      `expected 4 computeTileCameraAnchor() call sites (renderTileKeys, renderFillsRhi, ` +
        `renderLinesRhi, fill-bake); got ${n}. HIGHER: a new pack consciously calling the ` +
        `authority — bump this to ${n}. LOWER: someone re-inlined the anchor math — forbidden ` +
        `(#1044); route it through the helper instead.`,
    ).toBe(4)
  })

  it('only the fill-bake block hard-zeros the ECEF lanes', () => {
    const h = (SOURCE.match(/cam_ecef_off_h\(0/g) ?? []).length
    const l = (SOURCE.match(/cam_ecef_off_l\(0/g) ?? []).length
    expect(
      h,
      `expected 1 hard-zeroed cam_ecef_off_h( (the fill-bake tile-local ortho); got ${h}. ` +
        `A second hard-zeroed ECEF write is the #1044 bug pattern reborn (a pack drawing the ` +
        `globe against a zeroed ECEF origin).`,
    ).toBe(1)
    expect(
      l,
      `expected 1 hard-zeroed cam_ecef_off_l( (the fill-bake tile-local ortho); got ${l}. ` +
        `A second hard-zeroed ECEF write is the #1044 bug pattern reborn.`,
    ).toBe(1)
  })

  it('only the two clip_bounds conversions inline the Mercator-Y formula', () => {
    const n = (SOURCE.match(/Math\.log\(Math\.tan\(/g) ?? []).length
    expect(
      n,
      `expected 2 inline Math.log(Math.tan()) (the clip_bounds vSouth/vNorth conversions); ` +
        `got ${n}. Every other Mercator-metre conversion must go through ` +
        `computeTileCameraAnchor, not a fresh inline.`,
    ).toBe(2)
  })
})
