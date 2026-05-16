import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mercator, MERCATOR_LAT_LIMIT } from './projection'
import { lonLatToMercator } from '../../loader/geojson'

// Phase 1-A (A-2): CPU-side Mercator latitude clamps diverged across the
// repo — projection.ts and geojson.ts clamped at 85.05, tiles.ts and other
// code at 85.051, and WGSL shaders + compiler at 85.051129 (the actual
// Mercator limit). Latitudes between 85.05 and 85.051129 projected to
// different Y values depending on which module did the math.
// These tests lock the CPU-side clamp to the canonical limit.

describe('Mercator latitude clamp consistency', () => {
  it('projection.ts exports canonical MERCATOR_LAT_LIMIT = 85.051129', () => {
    expect(MERCATOR_LAT_LIMIT).toBe(85.051129)
  })

  it('mercator.forward does not clamp lat=85.051 (within canonical limit)', () => {
    // Before the fix, projection.ts clamped at 85.05, rounding 85.051
    // DOWN and shrinking the Mercator Y by ~1.4 km (Y grows exponentially
    // near the pole). After the fix, 85.051 is inside the canonical
    // 85.051129 limit and should project without being modified.
    const R = 6378137, DEG2RAD = Math.PI / 180
    const expected = Math.log(Math.tan(Math.PI / 4 + 85.051 * DEG2RAD / 2)) * R
    const [, actual] = mercator.forward(0, 85.051)
    expect(actual).toBeCloseTo(expected, 3)
  })

  it('lonLatToMercator does not clamp lat=85.051 either', () => {
    const R = 6378137, DEG2RAD = Math.PI / 180
    const expected = Math.log(Math.tan(Math.PI / 4 + 85.051 * DEG2RAD / 2)) * R
    const [, actual] = lonLatToMercator(0, 85.051)
    expect(actual).toBeCloseTo(expected, 3)
  })

  it('mercator.forward and lonLatToMercator agree at every latitude', () => {
    // Cross-module consistency: the two CPU Mercator paths must produce
    // identical results at all latitudes, including those between the old
    // clamp values (85.05, 85.051) and the canonical limit.
    for (const lat of [-89, -85.2, -85.051, -85.05, 0, 85.05, 85.051, 85.2, 89]) {
      const [, yA] = mercator.forward(0, lat)
      const [, yB] = lonLatToMercator(0, lat)
      expect(yB).toBeCloseTo(yA, 3)
    }
  })

  it('clamp applies at MERCATOR_LAT_LIMIT exactly (supra-limit latitudes collapse)', () => {
    // Two latitudes both above the canonical limit should project to the
    // same Y — the clamp kicks in at MERCATOR_LAT_LIMIT.
    const [, y86] = mercator.forward(0, 86)
    const [, y89] = mercator.forward(0, 89)
    expect(y86).toBeCloseTo(y89, 3)
  })
})

// The Phase 1-A fix above only locked projection.ts + geojson.ts. The tile
// selector (data/tile-select.ts) kept its own inline clamps — 85.051 in
// the frustum classifier, 85.0511 in the child / camera-tile math — so the
// CPU tile-corner Mercator Y diverged from the renderer's canonical
// 85.051129 by ~166 m at the clamp latitude (dy/dφ = R/cosφ ≈ 7.4e7 m/rad
// there). Lock the selector to the imported MERCATOR_LAT_LIMIT so the
// "split clamp across modules" regression projection.ts:10-13 warns about
// can't reappear in the selector path.
describe('tile selector uses the canonical Mercator clamp', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../data/tile-select.ts', import.meta.url)),
    'utf8',
  )

  it('imports MERCATOR_LAT_LIMIT from projection.ts', () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bMERCATOR_LAT_LIMIT\b[^}]*\}\s*from\s*['"][^'"]*projection['"]/,
    )
  })

  it('bakes in no divergent Mercator latitude literal (must use the constant)', () => {
    const offenders = src.match(/85\.05\d*/g) ?? []
    expect(offenders).toEqual([])
  })
})
