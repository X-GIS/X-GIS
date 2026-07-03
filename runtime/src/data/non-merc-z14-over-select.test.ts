// Memory: project_non_merc_z14_pitch_over_select — sphere-routed
// projections (3/4/5/6/7) at z=14 with pitch select ~1320 tiles vs
// mercator ~297 (4.5× over). This is user-visible: drag p95 =
// 144-211 ms (5-7 fps) on the harness `_perf-projection-seoul-pitch-
// drag`.
//
// Memory acceptance: "sphere-routed projs drop from 1322 to ≤ 600
// (still some over-vs-merc-300 is acceptable since the projection
// itself is more expensive per-tile)" — ratio target ≤ 2×.
//
// This unit-level perf gate pins the ratio. The over-select happens
// entirely on CPU before any draw — so a unit test on the two
// selectors is sufficient to demonstrate the fix. We can't reproduce
// the WGSL render path here, but the playground `_perf-projection-
// seoul-pitch-drag` spec carries the visual regression gate.

import { describe, it, expect } from 'vitest'
import { globeVisibleTiles } from '@xgis/engine'
import { visibleTilesSSE } from '@xgis/data'
import { mercator } from '@xgis/engine'
import { Camera } from '@xgis/engine'

const W = 800
const H = 800
const SEOUL_LON = 126.978
const SEOUL_LAT = 37.566

// Real harness reproduction zoom: z=14 = maxLevel for the OFM Bright
// PMTiles archive (matches `_perf-projection-seoul-pitch-drag` startup).
const Z = 14
const MAX_Z = 14

// Pitch=75 — within the harness's matrix (45° and 60° were both
// pinned by the 4× ratio in iter-172).
const PITCH = 75

describe('non-merc z=14 over-select — ratio gate vs mercator control', () => {
  // Sphere-routed projType matrix (3=ortho, 4=azi, 5=stereo,
  // 6=oblique, 7=globe). They all funnel through globeVisibleTiles —
  // memory project_non_merc_z14_pitch_over_select-2026_05_20.
  const SPHERE_ROUTED: ReadonlyArray<number> = [3, 4, 5, 6, 7]

  // Mercator control (visibleTilesFrustumSampled is what the VTR
  // selects for projType=0). pitch field is set after construction
  // because Camera's constructor only takes (lon, lat, zoom).
  function mercatorTileCount(): number {
    const cam = new Camera(SEOUL_LON, SEOUL_LAT, Z)
    cam.pitch = PITCH
    cam.bearing = 0
    // visibleTilesSSE is what the VTR uses for projType=0 by default
    // (the iter-321 SSE rollout; `__XGIS_USE_SSE_SELECTOR=false`
    // is just the rollback escape valve). Match production so the
    // ratio gate compares the same envelope.
    const tiles = visibleTilesSSE(cam, mercator, MAX_Z, W, H, 0, 1)
    return tiles.length
  }

  const mercCount = mercatorTileCount()
  // Sanity: mercator should be in the ~200-400 range memory cites
  // (297 at p=45/60 from the harness). Pin a loose upper bound.
  it('mercator control selects a normal tile budget (≤ 500)', () => {
    expect(mercCount, `mercator z=${Z} p=${PITCH} = ${mercCount}`).toBeLessThanOrEqual(500)
    expect(mercCount).toBeGreaterThan(0)
  })

  for (const p of SPHERE_ROUTED) {
    it(`projType ${p}: globeVisibleTiles ≤ 2.2× mercator (was ~8×)`, () => {
      const n = globeVisibleTiles(SEOUL_LON, SEOUL_LAT, Z, MAX_Z, W, H, PITCH, 0).length
      const ratio = n / mercCount
      // The bug: at z=14 p=75 sphere selector emitted ~189 tiles vs
      // mercator ~24 (7.9×) on 800×800. Memory cites 1322/297=4.5×
      // at production resolution. Floor target after the fix: ≤ 2×
      // — sphere-routed projections legitimately need slightly more
      // coverage for the hemisphere visibility cull, but the bug
      // emitted 4-8× over control. Allow a 10 % tolerance on top of
      // the 2× floor (= 2.2×) to absorb measurement noise.
      expect(
        ratio,
        `projType ${p} z=${Z} p=${PITCH}: tiles=${n} mercControl=${mercCount} ratio=${ratio.toFixed(2)}`,
      ).toBeLessThanOrEqual(2.2)
    })
  }

  // Production-ish 1280×720 ratio at pitch=60° (memory's iter-172
  // matrix value) — drag p95 was 144 ms / 17 ms = 8.5× mercator drag
  // time, with the tile count over-selecting 4.5×. The fix MUST cut
  // the production-resolution ratio below 2× (i.e. matches the
  // memory's success-criteria ceiling of 600/300).
  it('1280×720 production resolution p=60: ratio ≤ 2× (memory target)', () => {
    const WP = 1280,
      HP = 720
    const cam = new Camera(SEOUL_LON, SEOUL_LAT, Z)
    cam.pitch = 60
    cam.bearing = 0
    const merc = visibleTilesSSE(cam, mercator, MAX_Z, WP, HP, 0, 1).length
    const globe = globeVisibleTiles(SEOUL_LON, SEOUL_LAT, Z, MAX_Z, WP, HP, 60, 0).length
    const ratio = globe / merc
    expect(
      ratio,
      `1280×720 z=${Z} p=60: globe=${globe} merc=${merc} ratio=${ratio.toFixed(2)}`,
    ).toBeLessThanOrEqual(2.0)
  })
})
