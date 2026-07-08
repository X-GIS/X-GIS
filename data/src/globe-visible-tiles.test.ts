import { describe, expect, it } from 'vitest'
import { globeVisibleTiles } from './globe-visible-tiles'

describe('globe — dateline-wrapping tile selection', () => {
  it('a view centred on the antimeridian keeps tiles on BOTH sides (the half-tiles bug)', () => {
    const tiles = globeVisibleTiles(180, 0, 2, 4, 512, 512)
    expect(tiles.length).toBeGreaterThan(0)
    const n = (z: number) => Math.pow(2, z)
    // West-of-dateline tiles have lon near -180 → small x;
    // east-of-dateline tiles have lon near +180 → large x.
    const hasWest = tiles.some((t) => t.x / n(t.z) < 0.15)
    const hasEast = tiles.some((t) => (t.x + 1) / n(t.z) > 0.85)
    expect(hasWest).toBe(true)
    expect(hasEast).toBe(true)
  })

  it('only the camera-facing hemisphere is selected (centre lon 0 → no lon≈180 tiles)', () => {
    const tiles = globeVisibleTiles(0, 0, 2, 4, 512, 512)
    expect(tiles.length).toBeGreaterThan(0)
    for (const t of tiles) {
      const n = Math.pow(2, t.z)
      const lonW = (t.x / n) * 360 - 180
      const lonE = ((t.x + 1) / n) * 360 - 180
      // No selected tile should be entirely on the far side (|lon|>110).
      expect(Math.min(Math.abs(lonW), Math.abs(lonE))).toBeLessThan(120)
    }
  })

  it('tile count is bounded and ox === x (globe renders a single world)', () => {
    const tiles = globeVisibleTiles(127, 37, 3, 5, 1280, 720)
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles.length).toBeLessThanOrEqual(512)
    for (const t of tiles) expect(t.ox).toBe(t.x)
  })
})
