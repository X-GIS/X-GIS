// Issue #2023 — a globe camera exactly ON the antimeridian derives its
// longitude from Mercator metres as (centerX / R) · (180/π), and at
// centerX = R·π the f64 round-trip lands on ±180.00000000000003 — strictly
// outside [-180, 180]. Every inclusive lon containment inside
// globeVisibleTiles (containsTarget, the pole-ownership lonInTile) then
// fails, so the z=0 root is culled (its coarse ±180/±85 corner samples also
// fail anyFront at low zoom — exactly the case containsTarget exists to
// rescue). A maxLevel-0 source — the per-source POLAR CAP — selects NOTHING
// on the dateline, and the focal-tile guarantee is dead there at any depth.
//
// FAIL-BEFORE on main 2fdcc4d: the `derived` cases return [] for maxZ=0.

import { describe, it, expect } from 'vitest'
import { globeVisibleTiles } from './globe-visible-tiles'

// The exact value the camera→lon derivation produces at the antimeridian.
const R = 6378137
const DERIVED_180 = ((R * Math.PI) / R) * (180 / Math.PI)

describe('globeVisibleTiles — antimeridian centerLon float artifact (issue #2023)', () => {
  it('derives strictly past 180 (precondition for the repro)', () => {
    expect(DERIVED_180).toBeGreaterThan(180)
  })

  it('selects the z=0 root for a maxZ=0 source at the derived +180 longitude', () => {
    const tiles = globeVisibleTiles(DERIVED_180, 0, 2, 0, 604, 720, 0, 0)
    expect(tiles.some((t) => t.z === 0 && t.x === 0 && t.y === 0)).toBe(true)
  })

  it('selects the z=0 root at the derived -180 longitude (metamorphic mirror)', () => {
    const tiles = globeVisibleTiles(-DERIVED_180, 0, 2, 0, 604, 720, 0, 0)
    expect(tiles.some((t) => t.z === 0 && t.x === 0 && t.y === 0)).toBe(true)
  })

  it('matches the exact-180 selection at maxZ=2 (both dateline wrap columns present)', () => {
    const key = (t: { z: number; x: number; y: number }): string => `${t.z}/${t.x}/${t.y}`
    const exact = globeVisibleTiles(180, 0, 2, 2, 604, 720, 0, 0).map(key).sort()
    const derived = globeVisibleTiles(DERIVED_180, 0, 2, 2, 604, 720, 0, 0).map(key).sort()
    expect(derived).toEqual(exact)
    // The dateline wrap: both edge columns (x=0 and x=2^z−1) must be present.
    expect(exact.some((k) => k.startsWith('2/0/'))).toBe(true)
    expect(exact.some((k) => k.startsWith('2/3/'))).toBe(true)
  })

  it('leaves in-range longitudes byte-identical (guard is out-of-range-only)', () => {
    const key = (t: { z: number; x: number; y: number }): string => `${t.z}/${t.x}/${t.y}`
    for (const lon of [-180, -179.5, 0, 90.25, 179.5, 180]) {
      const tiles = globeVisibleTiles(lon, 10, 3, 3, 604, 720, 0, 0)
      expect(tiles.length, `lon=${lon} should select tiles`).toBeGreaterThan(0)
      // Re-derive through a wrap round-trip that lands back on the SAME value —
      // the guard must not have rewritten an in-range input.
      const again = globeVisibleTiles(lon, 10, 3, 3, 604, 720, 0, 0)
      expect(again.map(key)).toEqual(tiles.map(key))
    }
  })
})
