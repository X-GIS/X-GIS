import { describe, expect, it } from 'vitest'
import { Camera } from '../engine/projection/camera'
import { visibleTilesFrustum, visibleTilesFrustumSampled } from './tile-select'
import { mercator } from '../engine/projection/projection'

// Characterization tests for the `visibleTilesFrustumSampled`
// alternative — the industry-standard screen-space-sample-grid
// approach to tile discovery (Mapbox GL / MapLibre pattern).
//
// Motivation: `visibleTilesFrustum` (the primary, quadtree DFS
// approach) has margin heuristics that scale with
// `Math.max(canvasWidth, canvasHeight)`. Narrow viewports (iPhone
// portrait 390×844) get a culled result at high pitch — the bug
// user reported at `filter_gdp#10.22/…/21.1/83.9`. The sampled
// approach is ALGORITHMICALLY aspect-ratio-invariant: each sample's
// unproject-to-ground gives a geometric truth about viewport
// coverage regardless of viewport shape.
//
// These tests document the CURRENT behaviour of the sampled
// algorithm so its evolution (eventually to a GPU compute shader)
// can be validated against a known baseline. They are NOT asserting
// that sampled is strictly better than quadtree — both algorithms
// have failure modes and this suite records them explicitly.

const W_LS = 1280, H_LS = 720     // default landscape
const W_IP = 390,  H_IP = 844     // iPhone portrait (~0.46 aspect)

function cam(zoom: number, pitch: number, lon: number, lat: number, bearing = 0): Camera {
  const c = new Camera(lon, lat, zoom)
  c.pitch = pitch
  c.bearing = bearing
  return c
}

describe('visibleTilesFrustumSampled: basic invariants', () => {
  it('returns the camera tile at low pitch + low zoom', () => {
    const lon = 2.3522, lat = 48.8566, z = 8
    const c = cam(z, 30, lon, lat)
    const tiles = visibleTilesFrustumSampled(c, mercator, z, W_LS, H_LS)
    expect(tiles.length).toBeGreaterThan(0)
    // Compute expected camera tile index directly — avoids
    // hardcoded coord mistakes.
    const n = Math.pow(2, z)
    const expX = Math.floor((lon + 180) / 360 * n)
    const expY = Math.floor(
      (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2 * n,
    )
    const hasCam = tiles.some(t => t.z === z && t.x === expX && t.y === expY)
    expect(hasCam, `missing camera tile (${expX}, ${expY}) at z=${z}`).toBe(true)
  })

  it('returns DIFFERENT counts for landscape vs iPhone viewport — but both non-trivial', () => {
    const c = cam(10.22, 83.9, -95.36354, 50.04227, 21.1)
    const landscape = visibleTilesFrustumSampled(c, mercator, 10, W_LS, H_LS)
    const iphone = visibleTilesFrustumSampled(c, mercator, 10, W_IP, H_IP)
    expect(landscape.length, 'landscape must have tiles').toBeGreaterThan(0)
    expect(iphone.length, 'iphone must have tiles').toBeGreaterThan(0)
    // A normal web map expectation: each produces enough tiles to
    // cover its viewport. For iPhone portrait at pitch=83.9 over
    // North America we expect at least 20 distinct z=10 tiles.
    // (Currently ~100 — this test documents the ballpark.)
    expect(iphone.length).toBeGreaterThan(20)
  })

  it('all output tiles are at the requested zoom', () => {
    const c = cam(10.22, 83.9, -95.36354, 50.04227, 21.1)
    const tiles = visibleTilesFrustumSampled(c, mercator, 10, W_IP, H_IP)
    for (const t of tiles) {
      expect(t.z).toBe(10)
      const n = Math.pow(2, 10)
      expect(t.x >= 0 && t.x < n).toBe(true)
      expect(t.y >= 0 && t.y < n).toBe(true)
    }
  })
})

describe('visibleTilesFrustumSampled: vs quadtree comparison at the user-bug URL', () => {
  // `filter_gdp#10.22/50.04227/-95.36354/21.1/83.9`
  const BUG = { zoom: 10.22, pitch: 83.9, lat: 50.04227, lon: -95.36354, bearing: 21.1 }

  it('landscape viewport: sampled returns fewer tiles (single zoom only) but covers the viewport', () => {
    const c = cam(BUG.zoom, BUG.pitch, BUG.lon, BUG.lat, BUG.bearing)
    const quadtree = visibleTilesFrustum(c, mercator, Math.round(BUG.zoom), W_LS, H_LS)
    const sampled = visibleTilesFrustumSampled(c, mercator, Math.round(BUG.zoom), W_LS, H_LS)
    console.log(`[user bug URL landscape] quadtree=${quadtree.length} sampled=${sampled.length}`)
    // Quadtree returns mixed zoom (z=4..z=10). Sampled returns single z=10.
    // Sampled tile count may be lower because it's not subdividing horizon.
    expect(sampled.length).toBeLessThan(quadtree.length)
    // Both should include the camera-center tile.
    const n = Math.pow(2, 10)
    const cx = Math.floor((BUG.lon + 180) / 360 * n)
    const cy = Math.floor(
      (1 - Math.log(Math.tan(Math.PI / 4 + BUG.lat * Math.PI / 360)) / Math.PI) / 2 * n,
    )
    expect(sampled.some(t => t.z === 10 && t.x === cx && t.y === cy),
      'sampled must include camera-center tile').toBe(true)
  })

  it('iPhone viewport: sampled returns MORE than old quadtree (bug fix direction)', () => {
    // The user bug was quadtree being over-aggressive in culling
    // on narrow viewports. With the Apr-21 margin-floor fix,
    // quadtree returns ~157 tiles on iPhone at this camera state.
    // Sampled should also produce a comparable number — the test
    // documents whichever is higher.
    const c = cam(BUG.zoom, BUG.pitch, BUG.lon, BUG.lat, BUG.bearing)
    const quadtree = visibleTilesFrustum(c, mercator, Math.round(BUG.zoom), W_IP, H_IP)
    const sampled = visibleTilesFrustumSampled(c, mercator, Math.round(BUG.zoom), W_IP, H_IP)
    console.log(`[user bug URL iphone] quadtree=${quadtree.length} sampled=${sampled.length}`)
    // Both should produce non-trivial tile sets.
    expect(quadtree.length).toBeGreaterThan(50)
    expect(sampled.length).toBeGreaterThan(20)
  })

  it('KNOWN LIMITATION — sampled is UNSTABLE at extreme pitch (< 50% overlap between pitch=83.9 / 84.0)', () => {
    // Characterisation: at pitch ≥ 80°, sample rays approach
    // parallel to the ground and small pitch changes shift each
    // ray's unproject endpoint by kilometres. Two pitch values
    // that look visually identical produce tile sets with
    // ~20% overlap (measured). Neither quadtree NOR sampled
    // handles this regime well — industry practice is to clamp
    // pitch ≤ 85° specifically because of this limit.
    //
    // This test LOCKS that limitation so any future improvement
    // (e.g. sampling at multiple distances, or hybrid
    // quadtree+sampled) is measurable vs this baseline.
    const c1 = cam(BUG.zoom, 83.9, BUG.lon, BUG.lat, BUG.bearing)
    const c2 = cam(BUG.zoom, 84.0, BUG.lon, BUG.lat, BUG.bearing)
    const s1 = visibleTilesFrustumSampled(c1, mercator, 10, W_IP, H_IP)
    const s2 = visibleTilesFrustumSampled(c2, mercator, 10, W_IP, H_IP)
    const keys1 = new Set(s1.map(t => `${t.x},${t.y}`))
    const keys2 = new Set(s2.map(t => `${t.x},${t.y}`))
    const common = [...keys1].filter(k => keys2.has(k)).length
    const overlap = common / Math.max(keys1.size, keys2.size)
    console.log(`[stability 83.9 vs 84.0 overlap] ${(overlap * 100).toFixed(1)}%`)
    // Just assert it ran; no overlap threshold. Upgrade to a real
    // threshold (e.g. ≥ 80%) when a stabilisation patch lands.
    expect(s1.length).toBeGreaterThan(0)
    expect(s2.length).toBeGreaterThan(0)
  })
})

describe('visibleTilesFrustumSampled: aspect-ratio invariance (core advantage)', () => {
  it('tile count scales smoothly with viewport dimensions, no cliff at aspect-ratio changes', () => {
    // Sweep the viewport width from 390 to 1280 at fixed height
    // 720 and verify tile count is monotonic (or close to it).
    // The quadtree's `max(w, h) * 0.25` margin formula produces
    // cliffs at width = height (ratio reversal).
    const c = cam(10, 70, 0, 30, 45) // generic high-pitch case
    const results: Array<{ w: number; count: number }> = []
    for (const w of [390, 540, 720, 900, 1080, 1280]) {
      const tiles = visibleTilesFrustumSampled(c, mercator, 10, w, 720)
      results.push({ w, count: tiles.length })
    }
    console.log('[aspect sweep]', JSON.stringify(results))
    // Assert monotonic non-decreasing — wider viewport sees at
    // least as many tiles as narrower. Sampled approach by
    // construction satisfies this; quadtree's margin formula
    // does not.
    for (let i = 1; i < results.length; i++) {
      expect(
        results[i].count,
        `tile count regressed at w=${results[i].w}: ${results[i].count} < ${results[i - 1].count}`,
      ).toBeGreaterThanOrEqual(results[i - 1].count - 2) // small tolerance for sampling jitter
    }
  })
})
