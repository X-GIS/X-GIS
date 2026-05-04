import { describe, expect, it } from 'vitest'
import { Camera } from '../engine/camera'
import { visibleTilesFrustum } from '../loader/tiles'
import { mercator } from '../engine/projection'

// HIGH-PITCH tile selection — coverage for pitch > 55°, which the
// original animation-coverage suite explicitly caps at.
//
// REPRODUCED BUG (2026-04-20):
//   https://x-gis.github.io/X-GIS/demo.html?id=physical_map_50m
//     #10.29/30.94565/117.95751/359.5/84.0
//
//   User reported "no tiles loading" at this camera state. Memory
//   entry project_tile_pitch_matrix.md hypothesized that the 300-tile
//   frustum budget doesn't account for perspective foreshortening;
//   the existing tile-animation-coverage suite explicitly caps its
//   inclusion oracle at pitch 55° (see its line ~58 comment), so any
//   regression in the pitch 60°–89° regime is untested.
//
// Oracle design for pitch > 55°:
//   The old "camera-foot tile must be in selection" oracle FAILS at
//   high pitch — the tile directly below the camera legitimately
//   falls off-screen behind the horizon. The correct oracles are:
//
//   1. NON-EMPTINESS — for any realistic camera over populated terrain,
//      visibleTilesFrustum must return at least one tile. Zero tiles
//      is the exact symptom the user saw.
//
//   2. FORWARD-GROUND COVERAGE — sample points in the LOWER half of
//      the canvas (screen y > 0.5 × H), unproject to lon/lat, and
//      verify at least one selected tile at some zoom covers each
//      point. "Below the horizon" is reliably inside the frustum at
//      any pitch < 90°; "above the horizon" may horizon-clip and is
//      skipped when unprojection returns null.
//
//   3. BUDGET SANITY — tile count must not hit the 300-tile cap for
//      realistic states at moderate zoom. Hitting the cap at z=10
//      pitch=60° signals the tile selector has "given up" rather than
//      made precise picks (the over-selection pathology from memory
//      project_tile_pitch_matrix.md).
//
//   4. CONTINUITY — pitch is animated in small steps in practice.
//      A single-degree pitch step from P to P+1 dropping the tile
//      count from N > 0 to exactly 0 is a discontinuity bug.

const W = 1024
const H = 768
const R = 6378137
const DEG2RAD = Math.PI / 180

function makeCam(zoom: number, pitch: number, lon: number, lat: number, bearing = 0): Camera {
  const c = new Camera(lon, lat, zoom)
  c.pitch = pitch
  c.bearing = bearing
  return c
}

/** Quadtree walk: does any selected tile at any zoom ≤ maxZ cover (lon, lat)? */
function anyTileCoversLonLat(
  tiles: Array<{ z: number; x: number; y: number }>,
  lon: number,
  lat: number,
  maxZ: number,
): boolean {
  for (let tz = maxZ; tz >= 0; tz--) {
    const n = Math.pow(2, tz)
    const tx = Math.floor((lon + 180) / 360 * n)
    const clampedLat = Math.max(-85.051129, Math.min(85.051129, lat))
    const ty = Math.floor(
      (1 - Math.log(Math.tan(Math.PI / 4 + clampedLat * DEG2RAD / 2)) / Math.PI) / 2 * n,
    )
    if (tiles.some(t => t.z === tz && t.x === tx && t.y === ty)) return true
  }
  return false
}

/** Screen fraction → lon/lat via Camera.unprojectToZ0 + Mercator inverse.
 *  Returns null if the ray misses the ground plane (at/above horizon). */
function unprojectFractionToLonLat(
  cam: Camera, fx: number, fy: number,
): [number, number] | null {
  const rel = cam.unprojectToZ0(fx * W, fy * H, W, H)
  if (!rel) return null
  const mx = cam.centerX + rel[0]
  const my = cam.centerY + rel[1]
  const lon = (mx / R) / DEG2RAD
  const lat = (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) / DEG2RAD
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  return [lon, lat]
}

// ═══════════════════════════════════════════════════════════════════
// Phase 1: Exact bug reproduction — URL-level oracle
// ═══════════════════════════════════════════════════════════════════

describe('High-pitch: exact bug reproduction (2026-04-20 report)', () => {
  // URL hash `#zoom/lat/lon/bearing/pitch`:
  //   https://x-gis.github.io/X-GIS/demo.html?id=physical_map_50m
  //     #10.29/30.94565/117.95751/359.5/84.0
  const BUG = {
    zoom: 10.29,
    lat: 30.94565,
    lon: 117.95751,
    bearing: 359.5,
    pitch: 84.0,
  } as const

  it('visibleTilesFrustum returns a non-empty tile set at the bug camera state', () => {
    const cam = makeCam(BUG.zoom, BUG.pitch, BUG.lon, BUG.lat, BUG.bearing)
    const tiles = visibleTilesFrustum(cam, mercator, Math.round(BUG.zoom), W, H)
    expect(
      tiles.length,
      `BUG REPRO: got ${tiles.length} tiles for the URL's camera state`,
    ).toBeGreaterThan(0)
  })

  it('the center-of-lower-half forward sample is covered', () => {
    const cam = makeCam(BUG.zoom, BUG.pitch, BUG.lon, BUG.lat, BUG.bearing)
    const tiles = visibleTilesFrustum(cam, mercator, Math.round(BUG.zoom), W, H)
    // (0.5, 0.7) is in the lower-middle of the screen — the forward-
    // ground right in front of the camera at any realistic pitch < 90°.
    const ll = unprojectFractionToLonLat(cam, 0.5, 0.7)
    expect(ll, 'forward-ground sample must unproject at pitch=84').not.toBeNull()
    if (!ll) return
    const [lon, lat] = ll
    expect(
      anyTileCoversLonLat(tiles, lon, lat, Math.round(BUG.zoom)),
      `BUG: forward-ground (${lon.toFixed(4)}, ${lat.toFixed(4)}) uncovered`,
    ).toBe(true)
  })

  it('a 3×5 lower-half sample grid is fully covered', () => {
    const cam = makeCam(BUG.zoom, BUG.pitch, BUG.lon, BUG.lat, BUG.bearing)
    const tiles = visibleTilesFrustum(cam, mercator, Math.round(BUG.zoom), W, H)
    // Lower half only. Above-horizon samples at pitch=84 are unsafe
    // (may horizon-clip); we only assert on points guaranteed to be
    // on the visible ground.
    const fractionsY = [0.55, 0.65, 0.75, 0.85, 0.95]
    const fractionsX = [0.25, 0.5, 0.75]
    const missed: string[] = []
    let checked = 0
    for (const fy of fractionsY) for (const fx of fractionsX) {
      const ll = unprojectFractionToLonLat(cam, fx, fy)
      if (!ll) continue
      checked++
      if (!anyTileCoversLonLat(tiles, ll[0], ll[1], Math.round(BUG.zoom))) {
        missed.push(`(${fx}, ${fy}) → lon=${ll[0].toFixed(3)} lat=${ll[1].toFixed(3)}`)
      }
    }
    expect(checked, 'no samples in lower half unprojected').toBeGreaterThan(0)
    expect(
      missed,
      `${missed.length} / ${checked} forward samples uncovered:\n  ${missed.join('\n  ')}`,
    ).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════
// Phase 2: Systematic pitch sweep — 60° to 89° at the bug location
// ═══════════════════════════════════════════════════════════════════

describe('High-pitch: systematic pitch sweep at bug location (lon=117.96, lat=30.95)', () => {
  // One test per pitch so the failure message tells us at exactly
  // which pitch the contract breaks.
  for (const pitch of [60, 65, 70, 75, 80, 82, 84, 85, 87, 89]) {
    it(`pitch=${pitch}: non-empty + forward sample covered`, () => {
      const cam = makeCam(10, pitch, 117.95751, 30.94565, 0)
      const tiles = visibleTilesFrustum(cam, mercator, 10, W, H)
      expect(tiles.length, `pitch=${pitch}: 0 tiles`).toBeGreaterThan(0)

      const ll = unprojectFractionToLonLat(cam, 0.5, 0.7)
      expect(ll, `pitch=${pitch}: forward sample did not unproject`).not.toBeNull()
      if (!ll) return
      expect(
        anyTileCoversLonLat(tiles, ll[0], ll[1], 10),
        `pitch=${pitch}: forward (${ll[0].toFixed(3)}, ${ll[1].toFixed(3)}) uncovered`,
      ).toBe(true)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════
// Phase 3: Pitch × zoom matrix — catches zoom-specific regressions
// ═══════════════════════════════════════════════════════════════════

describe('High-pitch: pitch × zoom matrix', () => {
  // KNOWN COVERAGE HOLES (discovered 2026-04-20 by this very suite):
  //
  //   (pitch=60, zoom=12)
  //   (pitch=75, zoom=15)
  //   (pitch=84, zoom=15)
  //
  // At these states the forward-ground screen sample (0.5, 0.7)
  // unprojects to a lon/lat that no selected tile — at any zoom
  // 0..maxZ — covers. Symptom: user sees no tile at the middle of
  // the forward viewport.
  //
  // Consistent with memory project_tile_pitch_matrix.md:
  //   "300-slot tile budget doesn't understand perspective
  //    foreshortening" — at high zoom the per-tile screen size shrinks
  //   faster than the budget can compensate, so the selector's spatial
  //   reach falls short of the visible forward ground.
  //
  // Marked `it.fails` so the suite stays green while the bug is
  // captured as a non-regression target: when someone fixes the
  // foreshortening-aware budget, vitest will flip these to failing
  // (the test was "expected to fail") and alert the fixer to remove
  // the marker.
  // All three previously-failing entries — (pitch=60, zoom=12),
  // (pitch=75, zoom=15), (pitch=84, zoom=15) — pass since the 2026-05-04
  // camera-tile injection at the end of `visibleTilesFrustum`. The 5×5
  // ring around the camera tile at maxZ now covers the forward (0.5, 0.7)
  // unproject at every entry in the matrix.
  const KNOWN_FAIL_AT: ReadonlySet<string> = new Set<string>()

  for (const pitch of [60, 75, 84]) {
    for (const zoom of [5, 8, 10, 12, 15]) {
      const key = `pitch=${pitch} zoom=${zoom}`
      const runner = KNOWN_FAIL_AT.has(key) ? it.fails : it
      runner(`${key}: coverage holds`, () => {
        const cam = makeCam(zoom, pitch, 117.95751, 30.94565, 0)
        const tiles = visibleTilesFrustum(cam, mercator, zoom, W, H)
        expect(
          tiles.length,
          `${key}: 0 tiles`,
        ).toBeGreaterThan(0)

        const ll = unprojectFractionToLonLat(cam, 0.5, 0.7)
        // Very low zoom at high pitch may horizon-clip even the lower
        // half (the ground plane near the camera is already beyond the
        // visible earth disk). Skip when unprojection fails — the
        // non-emptiness assertion above still guards against zero-tile.
        if (!ll) return
        expect(
          anyTileCoversLonLat(tiles, ll[0], ll[1], zoom),
          `${key}: forward sample uncovered`,
        ).toBe(true)
      })
    }
  }
})

// ═══════════════════════════════════════════════════════════════════
// Phase 4: Pitch × bearing matrix — the bug URL had bearing ≈ 360°
// ═══════════════════════════════════════════════════════════════════

describe('High-pitch: pitch=80 × bearing sweep (bug URL had bearing=359.5)', () => {
  for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315, 359.5]) {
    it(`bearing=${bearing}: non-empty + forward sample covered`, () => {
      const cam = makeCam(10, 80, 117.95751, 30.94565, bearing)
      const tiles = visibleTilesFrustum(cam, mercator, 10, W, H)
      expect(tiles.length, `bearing=${bearing}: 0 tiles`).toBeGreaterThan(0)

      const ll = unprojectFractionToLonLat(cam, 0.5, 0.7)
      expect(ll, `bearing=${bearing}: forward sample did not unproject`).not.toBeNull()
      if (!ll) return
      expect(
        anyTileCoversLonLat(tiles, ll[0], ll[1], 10),
        `bearing=${bearing}: forward (${ll[0].toFixed(3)}, ${ll[1].toFixed(3)}) uncovered`,
      ).toBe(true)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════
// Phase 5: Pitch × location matrix — rules out location-specific bugs
// ═══════════════════════════════════════════════════════════════════

describe('High-pitch: pitch=80 × various globe locations', () => {
  const LOCATIONS: Array<[label: string, lon: number, lat: number]> = [
    ['bug-china',         117.95751,  30.94565],
    ['paris',             2.3522,     48.8566],
    ['tokyo',             139.6917,   35.6895],
    ['new-york',          -74.0060,   40.7128],
    ['sydney',            151.2093,   -33.8688],
    ['sao-paulo',         -46.6333,   -23.5505],
    ['equator-meridian',  0.0,        0.0],
    ['norway-north',      8.0,        70.0],
  ]
  for (const [label, lon, lat] of LOCATIONS) {
    it(`${label} (lon=${lon}, lat=${lat}): pitch=80 coverage holds`, () => {
      const cam = makeCam(10, 80, lon, lat, 0)
      const tiles = visibleTilesFrustum(cam, mercator, 10, W, H)
      expect(tiles.length, `${label}: 0 tiles`).toBeGreaterThan(0)

      const ll = unprojectFractionToLonLat(cam, 0.5, 0.7)
      // Polar locations at pitch=80 may horizon-clip the lower half
      // (the earth-disk edge can be above the 0.7-fraction line at
      // high latitude). Non-emptiness above still guards correctness.
      if (!ll) return
      expect(
        anyTileCoversLonLat(tiles, ll[0], ll[1], 10),
        `${label}: forward sample uncovered`,
      ).toBe(true)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════
// Phase 6: Budget sanity & continuity across the pitch axis
// ═══════════════════════════════════════════════════════════════════

describe('High-pitch: budget & continuity invariants', () => {
  it('tile count stays in (0, 300) across pitch 0→89 in 1° steps at zoom 10', () => {
    // MAX_FRUSTUM_TILES = 300 (desktop). Hitting 300 exactly means the
    // selector hit the cap — a sign of over-selection under
    // foreshortening. Zero means the frustum culler discarded
    // everything — the exact symptom of the bug URL.
    const breaches: string[] = []
    for (let pitch = 0; pitch <= 89; pitch += 1) {
      const cam = makeCam(10, pitch, 117.95751, 30.94565, 0)
      const tiles = visibleTilesFrustum(cam, mercator, 10, W, H)
      if (tiles.length === 0) breaches.push(`pitch=${pitch}: 0 tiles (empty)`)
      else if (tiles.length >= 300) breaches.push(`pitch=${pitch}: ${tiles.length} tiles (cap hit)`)
    }
    expect(
      breaches,
      `${breaches.length} pitches breached the (0, 300) budget:\n  ${breaches.slice(0, 15).join('\n  ')}`,
    ).toEqual([])
  })

  it('no single-degree pitch step drops tile count to 0', () => {
    // Pitch is animated in continuous frames in practice — a discrete
    // step from N > 0 to N === 0 between two adjacent pitch values is
    // a discontinuity bug (the frustum/budget math crossed a threshold
    // that shouldn't exist).
    const drops: string[] = []
    let prev = -1
    for (let pitch = 0; pitch <= 89; pitch++) {
      const cam = makeCam(10, pitch, 117.95751, 30.94565, 0)
      const tiles = visibleTilesFrustum(cam, mercator, 10, W, H)
      if (prev > 0 && tiles.length === 0) {
        drops.push(`pitch=${pitch - 1}→${pitch}: ${prev}→0`)
      }
      prev = tiles.length
    }
    expect(drops, `cliff-drops:\n  ${drops.join('\n  ')}`).toEqual([])
  })

  it('tile count as a function of pitch has no order-of-magnitude jumps', () => {
    // Ratio test: N(pitch) / N(pitch-1) should stay in a reasonable
    // range. A 10× jump implies the selector is dramatically changing
    // strategy mid-animation (bad for user-perceptible load patterns).
    const jumps: string[] = []
    let prev = -1
    for (let pitch = 0; pitch <= 89; pitch++) {
      const cam = makeCam(10, pitch, 117.95751, 30.94565, 0)
      const tiles = visibleTilesFrustum(cam, mercator, 10, W, H)
      if (prev > 0 && tiles.length > 0) {
        const r = Math.max(prev, tiles.length) / Math.min(prev, tiles.length)
        if (r > 10) jumps.push(`pitch=${pitch - 1}→${pitch}: ${prev}→${tiles.length} (×${r.toFixed(1)})`)
      }
      prev = tiles.length
    }
    expect(jumps, `order-of-magnitude jumps:\n  ${jumps.join('\n  ')}`).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════
// Phase 7: Non-duplication & well-formedness at high pitch
// ═══════════════════════════════════════════════════════════════════

describe('High-pitch: tile set well-formedness', () => {
  it('no duplicate (z, x, y, ox) across pitch × zoom at the bug location', () => {
    for (const pitch of [60, 70, 80, 84, 87]) {
      for (const zoom of [5, 8, 10, 12, 15]) {
        const cam = makeCam(zoom, pitch, 117.95751, 30.94565, 0)
        const tiles = visibleTilesFrustum(cam, mercator, zoom, W, H)
        const seen = new Set<string>()
        for (const t of tiles) {
          const k = `${t.z}/${t.x}/${t.y}/${t.ox ?? t.x}`
          expect(
            seen.has(k),
            `pitch=${pitch} zoom=${zoom}: duplicate tile ${k}`,
          ).toBe(false)
          seen.add(k)
        }
      }
    }
  })

  it('every selected tile has z ∈ [0, maxZ] and integer x, y', () => {
    for (const pitch of [60, 75, 84, 89]) {
      const cam = makeCam(10, pitch, 117.95751, 30.94565, 0)
      const tiles = visibleTilesFrustum(cam, mercator, 10, W, H)
      for (const t of tiles) {
        expect(Number.isInteger(t.z) && t.z >= 0 && t.z <= 10,
          `pitch=${pitch}: bad z=${t.z}`).toBe(true)
        expect(Number.isInteger(t.x) && Number.isInteger(t.y),
          `pitch=${pitch}: non-integer tile coord`).toBe(true)
        const n = Math.pow(2, t.z)
        // Y must be in-range (no wrapping in lat direction).
        expect(t.y >= 0 && t.y < n,
          `pitch=${pitch}: y=${t.y} out of [0, ${n})`).toBe(true)
      }
    }
  })
})
