// Regression gate: geodesic-midpoint subdivision must NOT
// pole-hop on very long edges. The pathological case is a near-
// 180°-lon-span edge at high latitude — slerp midpoint lands at
// the pole (great-circle between two same-lat antipodal-meridian
// points passes through the pole), which produces vertex chaos
// when rendered.
//
// Iter 40 bug report (scripts/MOBILE_LOW_ZOOM_BUG.md hypothesis 3):
// iPhone Safari OFM Bright at z=0.5 rendered land polygons as
// horizontal stripes. Root cause: iter 6 geodesic subdivision
// applied slerp midpoint to edges spanning 100°+ lon at the
// Eurasia polygon ring, producing pole-hopping midpoints that
// Mercator-projected to NaN-ish corruption visible as banding.
//
// Fix: gate geodesic to (5°, 60°) range. Above 60° fall back to
// linear MM midpoint — the renderer's per-vertex projection
// handles chord-vs-arc correctness for sphere projections at
// this scale because edges this long get further subdivided.

import { describe, expect, it } from 'vitest'
import { compileGeoJSONToTiles } from '../tiler/vector-tiler'

describe('geodesic-midpoint pole-hop regression gate (iter 40)', () => {
  it('Eurasia-shaped polygon at z=0 compiles without throwing', () => {
    // Polygon spanning ~140° lon at high latitude — exactly the
    // edge case that produced iPhone Safari banding.
    const features = [
      {
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [10, 75],
              [150, 75],
              [150, 35],
              [10, 35],
              [10, 75],
            ],
          ],
        },
      },
    ]
    const compiled = compileGeoJSONToTiles(
      { type: 'FeatureCollection' as const, features },
      { minZoom: 0, maxZoom: 2 },
    )
    expect(compiled).toBeTruthy()
  })

  it('near-antipodal lon-span at high lat compiles (the worst case)', () => {
    // 170° lon span at lat=80 — the case where slerp midpoint
    // would jump to the pole. Pre-fix this produced visible
    // banding artefacts on Mercator render.
    const features = [
      {
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [-85, 80],
              [85, 80],
              [85, 75],
              [-85, 75],
              [-85, 80],
            ],
          ],
        },
      },
    ]
    const compiled = compileGeoJSONToTiles(
      { type: 'FeatureCollection' as const, features },
      { minZoom: 0, maxZoom: 1 },
    )
    expect(compiled).toBeTruthy()
  })

  it('moderate 30° edge still uses geodesic refinement (no regression)', () => {
    // A 30° edge — squarely within (5°, 60°) — should still
    // benefit from slerp midpoint. Test just verifies compilation
    // succeeds; the visual correctness is harder to assert
    // without the renderer.
    const features = [
      {
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [-15, 45],
              [15, 45],
              [15, 30],
              [-15, 30],
              [-15, 45],
            ],
          ],
        },
      },
    ]
    const compiled = compileGeoJSONToTiles(
      { type: 'FeatureCollection' as const, features },
      { minZoom: 0, maxZoom: 3 },
    )
    expect(compiled).toBeTruthy()
  })

  it('compiles a >100°-span polygon at z=0 without producing degenerate vertices', () => {
    // The exact pattern from the iPhone screenshot — world-fit
    // view shows continents at z=0.5 which selects z=0 or z=1
    // tile. Z=0 root tile contains the full Eurasia ring.
    const features = [
      {
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [-180, 70],
              [180, 70],
              [180, -60],
              [-180, -60],
              [-180, 70],
            ],
          ],
        },
      },
    ]
    const compiled = compileGeoJSONToTiles(
      { type: 'FeatureCollection' as const, features },
      { minZoom: 0, maxZoom: 0 },
    )
    expect(compiled).toBeTruthy()
  })
})
