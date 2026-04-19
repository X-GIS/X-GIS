import { describe, expect, it } from 'vitest'
import { Camera } from '../engine/camera'
import { visibleTilesFrustum } from '../loader/tiles'
import { mercator } from '../engine/projection'

// Phase 2-B: Semantic oracles for tile selection.
//
// The existing tile-selection-pitch.test.ts asserts `count > 0` / `count
// <= 300`. Those are shape checks — they miss outright wrong selection.
// For example, an Arctic world-fit view at z=3 should need ~10 tiles but
// returns 300 (the MAX_FRUSTUM_TILES cap) because classifyTile's tz ≤ 3
// short-circuit returns SUBDIVIDE+1 unconditionally and the visit()
// function then pushes every tile without a viewport check when tz == maxZ.
//
// These tests lock in the observed behavior AND distinguish "works"
// from "broken but returns non-zero count".

const W = 1024
const H = 768

function makeCam(zoom: number, pitch: number, lon = 0, lat = 0, bearing = 0): Camera {
  const c = new Camera(lon, lat, zoom)
  c.pitch = pitch
  c.bearing = bearing
  return c
}

describe('tile selection — over-selection lock-in', () => {
  it('KNOWN BUG: Arctic (lat=75, zoom=3) saturates MAX_FRUSTUM_TILES=300 at every pitch', () => {
    // Root cause: classifyTile (tiles.ts:195) returns SUBDIVIDE+1 for any
    // tz <= 3. When tz == maxZ (here, maxZ=3), the visit() subdivide
    // branch requires `tz < maxZ` and fails, falling through to push
    // every tile without a viewport test. Result: every z=3 tile across
    // every world copy ends up in the set, clipped at 300.
    //
    // When this is fixed, the test will start failing. Replace with a
    // sensible upper bound (Arctic world-fit at z=3 sees ~12 tiles).
    for (const pitch of [0, 15, 30, 45, 60]) {
      const cam = makeCam(3, pitch, 0, 75)
      const tiles = visibleTilesFrustum(cam, mercator, 3, W, H)
      expect(tiles.length).toBe(300)
    }
  })

  it('KNOWN BUG: world-fit at zoom=1 returns 20 tiles (all 5 world copies)', () => {
    // Similar root cause — at maxZ=1, tz reaches 1 and classifyTile
    // short-circuits. Every z=1 tile in every world copy pushes.
    // 4 (per world) × 5 (copies) = 20.
    const cam = makeCam(1, 0)
    const tiles = visibleTilesFrustum(cam, mercator, 1, W, H)
    expect(tiles.length).toBe(20)
  })
})

describe('tile selection — semantic sanity (should pass)', () => {
  it('at zoom 8 pitch 0, the exact center tile is in the selected set', () => {
    // Strong semantic oracle: whatever else is in the selection, the
    // tile containing the screen center MUST be there — otherwise the
    // user's view of the map data would have a hole where their cursor is.
    for (const [lon, lat] of [[0, 0], [10, 50], [120, 35], [-75, 40]]) {
      const cam = makeCam(8, 0, lon, lat)
      const tiles = visibleTilesFrustum(cam, mercator, 8, W, H)
      const n = Math.pow(2, 8)
      const cx = Math.floor((lon + 180) / 360 * n)
      const clampedLat = Math.max(-85.051129, Math.min(85.051129, lat))
      const cy = Math.floor((1 - Math.log(Math.tan(Math.PI / 4 + clampedLat * Math.PI / 180 / 2)) / Math.PI) / 2 * n)
      const centerPresent = tiles.some(t => t.z === 8 && t.x === cx && t.y === cy)
      expect(centerPresent).toBe(true)
    }
  })

  it('at zoom 5 pitch 0 equator, selection is bounded by the visible area (<50 tiles)', () => {
    // The viewport at zoom 5 pitch 0 covers a small slice of the world.
    // If the budget ever saturates here, something is very wrong.
    const cam = makeCam(5, 0)
    const tiles = visibleTilesFrustum(cam, mercator, 5, W, H)
    expect(tiles.length).toBeLessThan(50)
  })

  it('selection is deterministic — same camera produces same tile set', () => {
    // Predictability check: given identical input, output must not drift.
    // If this fails, there is a sink (module-level side effect, time-
    // dependent state, etc.) in the selection pipeline.
    const cam1 = makeCam(6, 30, 10, 50, 45)
    const cam2 = makeCam(6, 30, 10, 50, 45)
    const tiles1 = visibleTilesFrustum(cam1, mercator, 6, W, H)
    const tiles2 = visibleTilesFrustum(cam2, mercator, 6, W, H)
    expect(tiles1.length).toBe(tiles2.length)
    const key = (t: typeof tiles1[0]) => `${t.z}/${t.x}/${t.y}/${t.ox ?? t.x}`
    const set1 = new Set(tiles1.map(key))
    const set2 = new Set(tiles2.map(key))
    expect(set1).toEqual(set2)
  })
})
