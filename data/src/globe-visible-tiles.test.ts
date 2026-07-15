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

  it('OVERZOOM antimeridian view keeps both sides — half-globe-blank repro #2.70/…/179.66', () => {
    // User bug (globe + OFM planet, hash #2.70/29.61151/179.66439/0.0/21.4):
    // at camera zoom 2.70 the globe is a SMALL DISC and maxZ = currentZ =
    // floor(zoom) = 2, so `zoom > maxZ` fires the overzoom bbox branch. Its
    // corner probes miss the disc; only the ~centre probes hit, all at the
    // sub-camera lon (≈179.66), so the lon bbox collapsed to a point and the
    // branch emitted only the single tile column under the camera — dropping
    // the entire trans-antimeridian half → "지도 반만 그려져" (half blank).
    // The overzoom branch now requires ALL probes to hit (full disc), so a
    // small-disc view routes to the descent, which wraps the dateline by
    // construction. Distinct from the descent-path test above (zoom < maxZ).
    const tiles = globeVisibleTiles(179.66, 29.61, 2.7, 2, 860, 720, 21.4, 0)
    expect(tiles.length).toBeGreaterThan(0)
    const n = (z: number) => Math.pow(2, z)
    const hasWest = tiles.some((t) => t.x / n(t.z) < 0.25) // lon −180..−90 (across the dateline)
    const hasEast = tiles.some((t) => (t.x + 1) / n(t.z) > 0.75) // lon 90..180
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
