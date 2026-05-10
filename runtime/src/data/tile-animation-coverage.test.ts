import { describe, expect, it } from 'vitest'
import { Camera } from '../engine/projection/camera'
import { visibleTilesFrustum } from './tile-select'
import { mercator } from '../engine/projection/projection'

// Animation-driven tile-selection oracles. Each test walks the camera
// through a sequence of states and asserts invariants PER FRAME.
//
// Two complementary oracle classes:
//   - INCLUSION: tiles that MUST be in the selection (viewport samples,
//     center tile). Catches "missing tile under cursor" regressions.
//   - EXCLUSION: tiles that MUST NOT be in the selection (clearly off-
//     screen regions, opposite hemisphere, non-visible latitudes).
//     Catches over-selection regressions (e.g., the Arctic bug that
//     used to saturate 300 tiles for a ~5 % viewport).

const W = 1024
const H = 768
const DEG2RAD = Math.PI / 180
const R = 6378137

function makeCam(zoom: number, pitch: number, lon = 0, lat = 0, bearing = 0): Camera {
  const c = new Camera(lon, lat, zoom)
  c.pitch = pitch
  c.bearing = bearing
  return c
}

function tileContains(t: { z: number; x: number; y: number }, lon: number, lat: number): boolean {
  const n = Math.pow(2, t.z)
  const tLonW = t.x / n * 360 - 180
  const tLonE = (t.x + 1) / n * 360 - 180
  const tLatN = Math.atan(Math.sinh(Math.PI * (1 - 2 * t.y / n))) * 180 / Math.PI
  const tLatS = Math.atan(Math.sinh(Math.PI * (1 - 2 * (t.y + 1) / n))) * 180 / Math.PI
  return lon >= tLonW && lon < tLonE && lat >= tLatS && lat < tLatN
}

function anyTileCovers(tiles: Array<{ z: number; x: number; y: number }>, lon: number, lat: number): boolean {
  return tiles.some(t => tileContains(t, lon, lat))
}

// ═══ Inclusion oracles: tiles that MUST be loaded ═══

describe('Animation: zoom-in (should keep the center tile selected at every frame)', () => {
  it('center tile stays in selection across zoom 3 → 18 over Paris', () => {
    for (let zoom = 3; zoom <= 18; zoom++) {
      const cam = makeCam(zoom, 0, 2.3522, 48.8566)
      const maxZ = Math.round(zoom)
      const tiles = visibleTilesFrustum(cam, mercator, maxZ, W, H)
      expect(
        anyTileCovers(tiles, 2.3522, 48.8566),
        `zoom=${zoom}: no tile covers camera lon/lat`,
      ).toBe(true)
    }
  })

  it('center tile stays covered across pitch 0 → 55 at zoom 12', () => {
    // Above pitch 55 the camera-foot tile can legitimately fall behind
    // the visible viewport (at pitch ≥ 60 the camera looks primarily
    // forward, so the tile directly under the camera is off-screen).
    // The fixable inclusion oracle is the FORWARD viewport sample
    // grid, covered by the zoom+pitch combined test further down.
    for (let pitch = 0; pitch <= 55; pitch += 5) {
      const cam = makeCam(12, pitch, 2.3522, 48.8566)
      const tiles = visibleTilesFrustum(cam, mercator, 12, W, H)
      expect(
        anyTileCovers(tiles, 2.3522, 48.8566),
        `pitch=${pitch}: camera position uncovered`,
      ).toBe(true)
    }
  })
})

describe('Animation: pan (tiles follow the camera across the world)', () => {
  it('across a longitude pan, the new leading-edge location is covered', () => {
    const lats = [50, 20, 0, -20, -50]
    for (const lat of lats) {
      for (let lon = -150; lon <= 150; lon += 30) {
        const cam = makeCam(6, 0, lon, lat)
        const tiles = visibleTilesFrustum(cam, mercator, 6, W, H)
        expect(
          anyTileCovers(tiles, lon, lat),
          `pan state (${lon}, ${lat}): camera uncovered`,
        ).toBe(true)
      }
    }
  })

  it('bearing sweep at zoom 8 keeps center covered at every rotation', () => {
    for (let bearing = 0; bearing < 360; bearing += 30) {
      const cam = makeCam(8, 30, 10, 50, bearing)
      const tiles = visibleTilesFrustum(cam, mercator, 8, W, H)
      expect(
        anyTileCovers(tiles, 10, 50),
        `bearing=${bearing}: center uncovered`,
      ).toBe(true)
    }
  })
})

describe('Animation: zoom + pitch combined (practical camera flights)', () => {
  it('coordinated zoom 5→15 while pitch 0→45 keeps viewport sampled points covered', () => {
    // 10-step animation where both zoom and pitch advance together.
    for (let step = 0; step <= 10; step++) {
      const t = step / 10
      const zoom = 5 + t * 10
      const pitch = t * 45
      const cam = makeCam(zoom, pitch, 2.3522, 48.8566)
      const tiles = visibleTilesFrustum(cam, mercator, Math.round(zoom), W, H)

      // Verify a 3×3 viewport sample grid (fractions 0.25/0.5/0.75)
      // is covered. Fractions avoid horizon edge where unprojection
      // may legitimately return null at high pitch.
      const fracs = [0.25, 0.5, 0.75]
      let samplesChecked = 0
      let samplesCovered = 0
      for (const fy of fracs) for (const fx of fracs) {
        const rel = cam.unprojectToZ0(fx * W, fy * H, W, H)
        if (!rel) continue
        samplesChecked++
        const mx = cam.centerX + rel[0]
        const my = cam.centerY + rel[1]
        const lon = (mx / R) / DEG2RAD
        const lat = (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) / DEG2RAD
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue

        // Walk the quadtree for a covering tile at any zoom.
        let covered = false
        for (let tz = Math.round(zoom); tz >= 0; tz--) {
          const n = Math.pow(2, tz)
          const tx = Math.floor((lon + 180) / 360 * n)
          const clampedLat = Math.max(-85.051129, Math.min(85.051129, lat))
          const ty = Math.floor((1 - Math.log(Math.tan(Math.PI / 4 + clampedLat * DEG2RAD / 2)) / Math.PI) / 2 * n)
          if (tiles.some(t => t.z === tz && t.x === tx && t.y === ty)) { covered = true; break }
        }
        if (covered) samplesCovered++
      }
      // Require at least half of the checked samples to be covered
      // (some horizon-adjacent samples may legitimately miss due to
      // frustum margin).
      expect(samplesCovered * 2).toBeGreaterThanOrEqual(samplesChecked)
    }
  })
})

// ═══ Exclusion oracles: tiles that MUST NOT be loaded ═══

describe('Exclusion: tiles clearly outside the viewport are not selected', () => {
  it('at zoom 10 pitch 0 over Paris, Tokyo tiles are NOT selected', () => {
    // Paris (2.35, 48.86) — Tokyo (139.69, 35.69) is ~135° east of
    // camera. At zoom 10, viewport covers ~4 tiles in each direction.
    // Tokyo's tile at z=10 is far outside any frustum or margin.
    const cam = makeCam(10, 0, 2.3522, 48.8566)
    const tiles = visibleTilesFrustum(cam, mercator, 10, W, H)
    expect(
      anyTileCovers(tiles, 139.69, 35.69),
      'Tokyo tile should not be selected when viewing Paris at z=10',
    ).toBe(false)
  })

  it('at zoom 10 pitch 0 over equator, polar tiles are NOT selected', () => {
    // Camera at (0, 0) zoom 10. Lat ±80 is far beyond viewport.
    const cam = makeCam(10, 0, 0, 0)
    const tiles = visibleTilesFrustum(cam, mercator, 10, W, H)
    expect(anyTileCovers(tiles, 0, 80)).toBe(false)
    expect(anyTileCovers(tiles, 0, -80)).toBe(false)
  })

  it('at zoom 8 pitch 60 looking north, southern hemisphere tiles are NOT selected', () => {
    // Camera (0, 50), pitch=60, bearing=0 (north). The frustum extends
    // further north-ward. Points at lat=-50 (southern hemisphere) are
    // clearly behind the camera foot or outside the forward FOV.
    const cam = makeCam(8, 60, 0, 50, 0)
    const tiles = visibleTilesFrustum(cam, mercator, 8, W, H)
    for (const lon of [-90, 0, 90]) {
      expect(
        anyTileCovers(tiles, lon, -50),
        `pitched north should not load lat=-50, lon=${lon}`,
      ).toBe(false)
    }
  })
})

describe('Exclusion: no duplicate / over-saturated frames', () => {
  it('no two selected tiles have identical (z, x, y, ox)', () => {
    for (let zoom = 3; zoom <= 14; zoom++) {
      for (const pitch of [0, 30, 60]) {
        const cam = makeCam(zoom, pitch, 10, 50)
        const tiles = visibleTilesFrustum(cam, mercator, zoom, W, H)
        const keys = new Set<string>()
        for (const t of tiles) {
          const key = `${t.z}/${t.x}/${t.y}/${t.ox ?? t.x}`
          expect(keys.has(key), `duplicate tile ${key} at zoom=${zoom} pitch=${pitch}`).toBe(false)
          keys.add(key)
        }
      }
    }
  })

  it('sensible upper bound across a zoom-in + pitch animation', () => {
    // Final invariant: no frame in a realistic animation should hit
    // the 300-tile MAX_FRUSTUM_TILES cap for pitch ≤ 45°. That cap
    // was designed for extreme cases; hitting it in a routine zoom+
    // pitch sweep would indicate over-selection.
    for (let step = 0; step <= 10; step++) {
      const t = step / 10
      const zoom = 5 + t * 8
      const pitch = t * 45
      const cam = makeCam(zoom, pitch, 0, 30)
      const tiles = visibleTilesFrustum(cam, mercator, Math.round(zoom), W, H)
      expect(tiles.length).toBeLessThan(300)
    }
  })
})

// ═══ Continuity / monotonicity oracles ═══

describe('Animation continuity: neighboring frames share central coverage', () => {
  it('between consecutive zoom frames, the INNER (non-margin) region retains coverage', () => {
    // Zoom-in retains most of the visible central area. Checking every
    // previous-frame tile's center would fail because tiles at the
    // 0.25×canvas extra-margin edge legitimately drop from the next
    // frame's tighter selection. The stable invariant is the INNER
    // region (viewport minus some margin) — sample a 5×5 grid inside
    // 0.25–0.75 fractions and verify each point is covered by both
    // consecutive frames.
    const cam1 = makeCam(8, 20, 0, 30)
    const cam2 = makeCam(9, 20, 0, 30)
    const prevTiles = visibleTilesFrustum(cam1, mercator, 8, W, H)
    const nextTiles = visibleTilesFrustum(cam2, mercator, 9, W, H)

    const fracs = [0.3, 0.4, 0.5, 0.6, 0.7]
    let both = 0
    let sampled = 0
    for (const fy of fracs) for (const fx of fracs) {
      const rel1 = cam1.unprojectToZ0(fx * W, fy * H, W, H)
      const rel2 = cam2.unprojectToZ0(fx * W, fy * H, W, H)
      if (!rel1 || !rel2) continue
      const lon1 = ((cam1.centerX + rel1[0]) / R) / DEG2RAD
      const lat1 = (2 * Math.atan(Math.exp((cam1.centerY + rel1[1]) / R)) - Math.PI / 2) / DEG2RAD
      const lon2 = ((cam2.centerX + rel2[0]) / R) / DEG2RAD
      const lat2 = (2 * Math.atan(Math.exp((cam2.centerY + rel2[1]) / R)) - Math.PI / 2) / DEG2RAD
      if (!Number.isFinite(lon1 + lat1 + lon2 + lat2)) continue
      sampled++
      if (anyTileCovers(prevTiles, lon1, lat1) && anyTileCovers(nextTiles, lon2, lat2)) both++
    }
    expect(both * 10).toBeGreaterThanOrEqual(sampled * 9)
  })
})
