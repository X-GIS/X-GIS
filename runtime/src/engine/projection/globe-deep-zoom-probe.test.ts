// Probe: does globeVisibleTiles itself return tiles at deep zoom?
//
// _perf-projection-seoul-deep harness shows globe/oblique render at
// z11 (826 tiles drawn) but deepTiles=0 at z16.5. The frame counter
// (_frameGlobeTilesSelected) is unreliable (per-render reset ×
// multi-source). globeVisibleTiles is pure + exported, so call it
// directly with the exact VTR args at both zooms to get a flake-free
// answer: is the deep-zoom blank a SELECTION-empty bug (root in
// globeVisibleTiles) or a downstream draw cull?
//
// VTR call site (vector-tile-renderer.ts ~2955):
//   globeVisibleTiles(lon, lat, camera.zoom, currentZ, cssW, cssH,
//                      pitch, bearing)
// currentZ = floor(camera.zoom) (vector-tile-renderer.ts:2662).
// Harness viewport 1280×800 CSS; Seoul 126.9776, 37.5558; pitch 0.
//
// (memory project_non_mercator_systemic_2026_05_19)

import { describe, expect, it } from 'vitest'
import { globeVisibleTiles } from './globe'

const SEOUL_LON = 126.9776
const SEOUL_LAT = 37.5558
const CSS_W = 1280
const CSS_H = 800

function selectAt(zoom: number): number {
  const maxZ = Math.floor(zoom)
  return globeVisibleTiles(
    SEOUL_LON, SEOUL_LAT, zoom, maxZ, CSS_W, CSS_H, 0, 0,
  ).length
}

describe('globeVisibleTiles deep-zoom probe (Seoul)', () => {
  it('z=11 selects tiles (known-good — globe/oblique render here)', () => {
    const n = selectAt(11)
    // eslint-disable-next-line no-console
    console.log(`[probe] globeVisibleTiles z=11 Seoul → ${n} tiles`)
    expect(n).toBeGreaterThan(0)
  })

  // RESULT (2026-05-19): selection is NON-ZERO at every zoom —
  // z11=35, z13=35, z14=40, z15=35, z16=35, z16.5=15. globeVisible-
  // Tiles is NOT the deep-zoom blocker; the Seoul-deep harness
  // deepTiles=0 for globe/oblique is a DOWNSTREAM draw-path cull
  // (iter-142 case (c)). This test now LOCKS that fact: selection
  // must stay non-zero through deep zoom, so a future regression
  // that empties it (or a "fix" that wrongly blames selection)
  // fails here.
  it('selection stays non-zero through deep zoom (root is downstream)', () => {
    for (const z of [13, 14, 15, 16, 16.5]) {
      const n = selectAt(z)
      // eslint-disable-next-line no-console
      console.log(`[probe] globeVisibleTiles z=${z} Seoul → ${n} tiles`)
      expect(n, `globeVisibleTiles must select tiles at z=${z}`).toBeGreaterThan(0)
    }
  })
})
