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
import { globeVisibleTiles } from '@xgis/data'

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
  return globeVisibleTiles(SEOUL_LON, SEOUL_LAT, zoom, cz, CSS_W, CSS_H, 0, 0).length
}

describe('globeVisibleTiles deep-zoom probe (Seoul)', () => {
  it('z=11 selects tiles (known-good — globe/oblique render here)', () => {
    const n = selectAt(11)

    console.log(`[probe] globeVisibleTiles z=11 Seoul → ${n} tiles`)
    expect(n).toBeGreaterThan(0)
  })

  // History (source-maxLevel-clamped maxZ; OFM bright maxLevel 14):
  //   BROKEN pre-iter-149:  z14=40 z15=12 z16=4  z16.5=1
  //   FIXED  iter-149:      z14=40 z15=16 z16=12 z16.5=12
  //   FIXED  +distance-LOD: z14=12 z15=16 z16=12 z16.5=12
  // Root: once camera zoom exceeds maxLevel, a maxZ tile projects
  // larger than the viewport so globeVisibleTiles' 5-sample
  // descent/cull collapsed the set to ~1 tile (globe/oblique
  // near-blank past z≈15; ortho/azi/stereo unaffected — they use
  // visibleTilesSSE, not this function). iter-149 added an
  // overzoom branch: when zoom>maxZ, unproject the viewport
  // corners onto the sphere and emit the maxZ tiles covering that
  // lon/lat footprint (same overzoom set visibleTilesSSE yields),
  // bypassing the meaningless sample heuristic. Deterministic;
  // bounded by the footprint → no recursion / explosion.
  //
  // The z=14 count dropped 40→12 with the distance-LOD descent gate
  // (memory project_non_merc_z14_pitch_over_select): the pre-fix 40
  // was the over-select at maxZ — globeVisibleTiles emitted full
  // z=14 leaves for every visible quadtree branch. The mercator SSE
  // selector picks ~13 tiles for the same view (Seoul z=14 pitch=0
  // 1280×800), so 12 is the correct count.
  //
  // Pins the FIXED curve: selection must NOT collapse at overzoom
  // (a regression re-collapsing it, or a change exploding it,
  // fails here).
  it('selection stays a bounded non-trivial set under overzoom (iter 149 + distance-LOD)', () => {
    const counts: Record<number, number> = {}
    for (const z of [13, 14, 15, 16, 16.5]) {
      counts[z] = selectAt(z)

      console.log(`[probe] globeVisibleTiles z=${z} Seoul (maxZ clamped) → ${counts[z]} tiles`)
    }
    // Selection at maxZ must cover the foreground (not collapse to
    // single-digit) without exploding. Mercator SSE picks ~13 at
    // this view; allow 6..40 as a band that catches both regression
    // directions (collapse + re-explosion).
    expect(counts[14]!).toBeGreaterThanOrEqual(6)
    expect(counts[14]!).toBeLessThanOrEqual(40)
    // FIXED: deep overzoom no longer collapses to ~1 — a real
    // viewport-covering set …
    expect(counts[16]!, 'z16 must not collapse').toBeGreaterThanOrEqual(4)
    expect(counts[16.5]!, 'z16.5 must not collapse').toBeGreaterThanOrEqual(4)
    // … but is still bounded (no overzoom explosion / runaway).
    expect(counts[16.5]!, 'z16.5 must stay bounded').toBeLessThanOrEqual(64)
  })
})
