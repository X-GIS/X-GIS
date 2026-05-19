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

// VTR clamps currentZ to the source's maxLevel BEFORE calling
// globeVisibleTiles (vector-tile-renderer.ts:2827-2830:
// `if (cz > sourceMaxLevel) cz = sourceMaxLevel`). OFM bright's
// vector source maxLevel is 14, so at camera zoom 16.5 the REAL
// maxZ arg is 14, NOT floor(16.5)=16. Model that.
const OFM_BRIGHT_SOURCE_MAXLEVEL = 14

function selectAt(zoom: number, sourceMaxLevel = OFM_BRIGHT_SOURCE_MAXLEVEL): number {
  const cz = Math.min(Math.floor(zoom), sourceMaxLevel)
  return globeVisibleTiles(
    SEOUL_LON, SEOUL_LAT, zoom, cz, CSS_W, CSS_H, 0, 0,
  ).length
}

describe('globeVisibleTiles deep-zoom probe (Seoul)', () => {
  it('z=11 selects tiles (known-good — globe/oblique render here)', () => {
    const n = selectAt(11)
    // eslint-disable-next-line no-console
    console.log(`[probe] globeVisibleTiles z=11 Seoul → ${n} tiles`)
    expect(n).toBeGreaterThan(0)
  })

  // RESULT (2026-05-19, with the CORRECT source-maxLevel-clamped
  // maxZ): selection COLLAPSES under overzoom —
  //   z11=35 z13=35 z14=40  z15=12  z16=4  z16.5=1
  // (an earlier revision used maxZ=floor(zoom) and wrongly read
  // 15-40 flat — VTR clamps cz to sourceMaxLevel BEFORE calling
  // globeVisibleTiles, so the realistic deep-zoom maxZ is 14, not
  // 16.) ROOT: once the camera zoom exceeds the source maxLevel,
  // a maxZ(=14) tile is far larger than the viewport; its corner
  // samples project off-screen so the anyFront / anyOnScreen
  // 5-sample test keeps only the ~1 tile whose centre still lands
  // on screen. The Mercator overzoom path (visibleTilesSSE) instead
  // returns every maxLevel tile whose GEOGRAPHIC extent meets the
  // frustum (~109 in the Seoul-deep harness) and the draw path
  // scales them up — that is why globe/oblique go near-blank at
  // z>~15 while ortho/azi/stereo/mercator do not.
  //
  // Locks the degradation curve so the fix (overzoom-aware
  // geographic-extent selection when camera zoom > maxZ) can be
  // verified to flatten it back toward the z14 count, and a
  // regression re-collapsing it fails here.
  it('selection collapses under overzoom — characterises the root', () => {
    const counts: Record<number, number> = {}
    for (const z of [13, 14, 15, 16, 16.5]) {
      counts[z] = selectAt(z)
      // eslint-disable-next-line no-console
      console.log(`[probe] globeVisibleTiles z=${z} Seoul (maxZ clamped) → ${counts[z]} tiles`)
    }
    // Pin the CURRENT broken behaviour exactly (so the fix's
    // before/after is unambiguous): selection still collapses to a
    // near-empty handful at extreme overzoom.
    expect(counts[14]!).toBeGreaterThan(20)
    expect(counts[16.5]!).toBeLessThanOrEqual(2) // BROKEN: ~1 tile
  })
})
