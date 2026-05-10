import { describe, expect, it } from 'vitest'
import { Camera } from '../projection/camera'
import { visibleTilesFrustum } from '../../data/tile-select'
import { mercator } from '../projection/projection'

// Regression: 2026-05-04 user report. At
//   demo.html?id=fixture_cap_arrow#8.34/-0.14642/29.19268/90.0/74.8
// the GeoJSON line at lat=0 from (-30,0) to (30,0) only rendered as a
// tiny segment near the horizon. CPU diagnosis: visibleTilesFrustum
// returned ZERO z=8 tiles south of the equator — the camera tile
// (8/148/128, which contains the camera at lat=-0.146 AND the line at
// lat=0) was not selected. Cause: the DFS quadtree walk visits child
// quadrants in NW→NE→SW→SE order; at extreme pitch + bearing the
// 300-tile MAX_FRUSTUM_TILES budget is exhausted by tiles in the
// three quadrants visited before the camera quadrant (SE here).
// Fix: inject a 5×5 ring of maxZ tiles around the camera tile after
// the DFS, bypassing MAX_FRUSTUM_TILES.

const W = 1500
const H = 1040

describe('fixture_cap_arrow z=8.34 / pitch=74.8 / bearing=90', () => {
  const cam = new Camera(29.19268, -0.14642, 8.34)
  cam.pitch = 74.8
  cam.bearing = 90

  it('selects the camera tile (8, 148, 128) — south of equator', () => {
    const tiles = visibleTilesFrustum(cam, mercator, 8, W, H)
    const z8 = tiles.filter(t => t.z === 8)
    expect(
      z8.some(t => t.x === 148 && t.y === 128),
      'camera tile (8/148/128) must be selected — line at lat=0 lives in y=128',
    ).toBe(true)
  })

  it('selects at least some z=8 tiles south of equator (y >= 128)', () => {
    const tiles = visibleTilesFrustum(cam, mercator, 8, W, H)
    const z8south = tiles.filter(t => t.z === 8 && t.y >= 128)
    expect(z8south.length, 'no z=8 tiles south of equator selected').toBeGreaterThan(0)
  })
})
