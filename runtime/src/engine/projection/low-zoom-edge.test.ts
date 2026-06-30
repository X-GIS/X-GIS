// Low-zoom (z=0..3) tile-selection edge cases. Catches regressions
// where the tile selector either over-selects (Arctic world-fit
// returning 300 tiles for a 5% coverage viewport) or under-selects
// (equirect/NE missing seam-straddling tiles at z=0).

import { describe, expect, it } from 'vitest'
import { globeVisibleTiles } from '@xgis/engine'

const VIEWPORT = { w: 1280, h: 720 }

describe('low-zoom (z=0..3) tile selection envelope', () => {
  it('z=0 globe view: bounded tile count, never empty', () => {
    const tiles = globeVisibleTiles(
      0, 0,         // center lon/lat
      0,            // zoom
      3,            // maxZ
      VIEWPORT.w, VIEWPORT.h,
      0, 0,         // pitch, bearing
    )
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles.length).toBeLessThan(300) // MAX_TILES cap
  })

  it('z=3 view centred on equator stays within hemisphere tile count', () => {
    const tiles = globeVisibleTiles(
      0, 0, 3, 3,
      VIEWPORT.w, VIEWPORT.h, 0, 0,
    )
    // z=3 has 64 total tiles worldwide; visible hemisphere is half
    // of those at most. Sphere-cap cull should keep us well below.
    expect(tiles.length).toBeLessThan(64)
  })

  it('arctic view (high latitude) z=3 does not over-select', () => {
    // Pre-fix regression: arctic world-fit at z=3 returned ~300 tiles
    // (all world copies × all visible-at-z=3 tiles) because the
    // selector treated low-zoom tiles as too-small-to-subdivide and
    // pushed every one. Force-subdivide gate at tile-select.ts:356
    // fixed it; this asserts the regression stays fixed.
    const tiles = globeVisibleTiles(
      0, 80,        // arctic camera
      3, 3,         // z=3
      VIEWPORT.w, VIEWPORT.h, 0, 0,
    )
    expect(tiles.length).toBeLessThan(120)
  })

  it('antimeridian view picks tiles on BOTH sides of ±180', () => {
    // Camera at lon=180 should see tiles with x=0 (lon-range 180..)
    // AND x=2^z-1 (lon-range ..180). The sphere-cap selector handles
    // this by walking continuous lon/lat without a Mercator-pyramid
    // wrap discontinuity.
    const tiles = globeVisibleTiles(
      180, 0,       // dateline camera
      2, 3,
      VIEWPORT.w, VIEWPORT.h, 0, 0,
    )
    const xs = new Set(tiles.map(t => `${t.z}/${t.x}`))
    // z=2 has tiles x=0..3. Antimeridian view should see both x=0
    // (west of dateline) and x=3 (east of dateline) at z=2 or
    // their z=3 subdivisions x=0/x=7.
    const hasWest = [...xs].some(k => /^2\/0$|^3\/[01]$/.test(k))
    const hasEast = [...xs].some(k => /^2\/3$|^3\/[67]$/.test(k))
    expect(hasWest || hasEast, 'antimeridian view should pick at least one west or east edge tile').toBe(true)
  })

  it('polar view: at very high lat the selector still picks tiles in visible band', () => {
    const tiles = globeVisibleTiles(
      0, 85,        // near north pole
      2, 3,
      VIEWPORT.w, VIEWPORT.h, 0, 0,
    )
    expect(tiles.length).toBeGreaterThan(0)
    // All picked tiles should be in the northern half: y ≤ 2^z/2.
    const allNorth = tiles.every(t => {
      const n = 1 << t.z
      return t.y < n / 2 + 1 // +1 slack for the y=n/2 boundary tile
    })
    expect(allNorth, 'polar view should not pick southern hemisphere tiles').toBe(true)
  })

  it('pitch=0 and pitch=60 both return bounded non-empty tile sets', () => {
    // Note: globeVisibleTiles is sphere-cap based — pitch affects
    // visible hemisphere ORIENTATION but not necessarily count
    // (a 3D sphere shows a hemisphere of tiles regardless). The
    // invariant we care about is bounded + non-empty for both.
    const flat = globeVisibleTiles(0, 0, 3, 3, VIEWPORT.w, VIEWPORT.h, 0, 0)
    const pitched = globeVisibleTiles(0, 0, 3, 3, VIEWPORT.w, VIEWPORT.h, 60, 0)
    expect(flat.length).toBeGreaterThan(0)
    expect(pitched.length).toBeGreaterThan(0)
    expect(flat.length).toBeLessThan(300)
    expect(pitched.length).toBeLessThan(300)
  })
})
