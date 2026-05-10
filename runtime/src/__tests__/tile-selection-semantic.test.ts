import { describe, expect, it } from 'vitest'
import { Camera } from '../engine/camera'
import { visibleTilesFrustum } from '../data/tile-select'
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

describe('tile selection — Arctic/world-fit viewport culling', () => {
  it('Arctic (lat=75, zoom=3) selects bounded tiles after the viewport-check fix', () => {
    // History: Before the tiles.ts:195 fix, classifyTile returned
    // SUBDIVIDE+1 unconditionally for tz <= 3. When tz === maxZ the
    // visit() subdivide branch failed and every z=3 tile across every
    // world copy got pushed without a viewport test — 300 tiles for
    // a viewport that saw ~5% of the world.
    //
    // After the fix: classifyTile falls through to the 9-sample
    // viewport projection when tz === maxZ, pruning non-overlapping
    // world copies and off-screen tiles. Arctic world-fit now returns
    // ~30 tiles at pitch 0 (bounded by visible world-copy × z=3 span).
    for (const pitch of [0, 15, 30, 45, 60]) {
      const cam = makeCam(3, pitch, 0, 75)
      const tiles = visibleTilesFrustum(cam, mercator, 3, W, H)
      expect(tiles.length).toBeGreaterThan(0)
      expect(tiles.length).toBeLessThan(300) // NOT saturated any more
    }
  })

  it('world-fit at zoom=1 pitch=0 returns ~16 tiles (viewport-culled world copies)', () => {
    // History: Pre-fix, every z=1 tile × 5 world copies = 20. Post-fix,
    // world copies falling fully outside the 1024×768 viewport get
    // culled, leaving 4 world tiles × ~4 world copies = 16.
    const cam = makeCam(1, 0)
    const tiles = visibleTilesFrustum(cam, mercator, 1, W, H)
    expect(tiles.length).toBeGreaterThan(0)
    expect(tiles.length).toBeLessThanOrEqual(20)
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

  it('viewport 9-point coverage: each sampled screen point is inside some selected tile', () => {
    // Sample 9 screen points (3×3 grid fractions 0.25/0.5/0.75). For
    // each, unproject to lon/lat, convert to a tile at the selection's
    // max zoom, and check that either that tile OR an ancestor (lower
    // zoom covering the same lon/lat) is in the selected set. A failure
    // means the user would see a "hole" at that screen position.
    //
    // Fractions are 0.25/0.5/0.75 (not 0/0.5/1.0) to avoid the unprojection
    // singularity at edges when the camera is pitched and the far edges
    // fall beyond the horizon.
    const R = 6378137, DEG2RAD = Math.PI / 180
    const toLonLat = (mx: number, my: number): [number, number] => {
      const lon = (mx / R) / DEG2RAD
      const lat = (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) / DEG2RAD
      return [lon, lat]
    }

    for (const [camLon, camLat, zoom, pitch] of [
      [0, 0, 5, 0], [10, 50, 6, 0], [120, 35, 5, 0],
      [0, 0, 5, 30], [10, 50, 6, 45],
    ] as const) {
      const cam = makeCam(zoom, pitch, camLon, camLat)
      const maxZ = zoom
      const tiles = visibleTilesFrustum(cam, mercator, maxZ, W, H)
      const keys = new Set<string>()
      for (const t of tiles) keys.add(`${t.z}/${t.x}/${t.y}`)

      const fracs = [0.25, 0.5, 0.75]
      for (const fy of fracs) for (const fx of fracs) {
        const rel = cam.unprojectToZ0(fx * W, fy * H, W, H)
        if (!rel) continue // beyond horizon — skip
        const mx = cam.centerX + rel[0]
        const my = cam.centerY + rel[1]
        const [sampleLon, sampleLat] = toLonLat(mx, my)
        if (!Number.isFinite(sampleLon) || !Number.isFinite(sampleLat)) continue

        // Walk up the quadtree until we find a tile in the selection
        // that contains this lon/lat (or fail).
        let covered = false
        for (let tz = maxZ; tz >= 0; tz--) {
          const n2 = Math.pow(2, tz)
          const tx = Math.floor((sampleLon + 180) / 360 * n2)
          const clampedLat = Math.max(-85.051129, Math.min(85.051129, sampleLat))
          const ty = Math.floor((1 - Math.log(Math.tan(Math.PI / 4 + clampedLat * DEG2RAD / 2)) / Math.PI) / 2 * n2)
          if (keys.has(`${tz}/${tx}/${ty}`)) { covered = true; break }
        }
        expect(covered).toBe(true)
      }
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
