// Regression gate: globeVisibleTiles must return the focal-point covering tile
// at z0 / maxZ=0 even when the camera is centred off-origin.
//
// Bug (project_non_merc_z0_disc_render_fail, root-caused 2026-05-31 via headed
// real-GPU draw-count probe): the flat ortho/azi/stereo projections are
// sphere-routed (routeToSphereSelector → globeVisibleTiles, vtr.ts), and at
// camera zoom 0 the render loop calls globeVisibleTiles with maxZ = currentZ =
// 0. The z0 root tile cannot subdivide (tz === maxZ), and its 5 coarse samples
// (corners at lon ±180 / the poles, centre at lon 0) all missed the off-centre
// visible cap → anyFront / anyOnScreenEmit both failed → ZERO tiles selected →
// the whole frame issued 0 draws → a fully BLACK canvas (verified: ortho z0 p0
// drew 0 vs mercator z0's 9). Mercator was unaffected (flat visibleTilesSSE).
//
// Fix: the tile geometrically containing the camera target is always at screen
// centre and must emit even when its coarse samples miss — it reaches the emit
// gate only as a leaf (tz === maxZ), so this adds at most the focal column (one
// tile generically; up to four when the centre lands exactly on a tile corner).

import { describe, it, expect } from 'vitest'
import { globeVisibleTiles } from './globe'

const W = 800, H = 800

describe('globeVisibleTiles z0 focal-tile (non-merc z0 black-canvas fix)', () => {
  it('returns the covering root tile at z0/maxZ=0 centred off-origin (was 0 → black)', () => {
    // lon 126.97 (Seoul meridian); z0 clamps centerY→0 (equator); zoom 0.
    const tiles = globeVisibleTiles(126.97, 0, 0, 0, W, H, 0, 0)
    expect(tiles.length, 'z0 off-centre selected zero tiles → black canvas').toBeGreaterThan(0)
    expect(tiles.some(t => t.z === 0 && t.x === 0 && t.y === 0), 'root 0/0/0 not selected').toBe(true)
  })

  it('still returns the root tile centred at lon 0 and at the antimeridian', () => {
    expect(globeVisibleTiles(0, 0, 0, 0, W, H, 0, 0).length).toBeGreaterThan(0)
    expect(globeVisibleTiles(180, 0, 0, 0, W, H, 0, 0).length).toBeGreaterThan(0)
  })

  it('does not over-emit at normal zoom (focal fix adds at most the focal leaf)', () => {
    const n = globeVisibleTiles(126.97, 0, 0, 14, W, H, 0, 0).length
    expect(n).toBeGreaterThan(10)
    expect(n).toBeLessThanOrEqual(300) // MAX_TILES cap — not an explosion
  })
})
