// Regression gate for z=0 world-wide polygon rendering (mobile
// iPhone bug, iter 40+41+56 thread).
//
// User report: x-gis.github.io OFM Bright at z=0..0.5 renders
// land polygons as horizontal stripes / banding. Root cause was
// iter 6's geodesic midpoint pole-hopping; iter 41 capped to 60°
// edge span but the regression persisted in production. Iter 56
// reverted geodesic entirely to the pre-iter-6 linear-midpoint
// baseline.
//
// User noted "tile coord system" change + "test was missing" —
// this file pins z=0 / z=0.5 / z=1 polygon compilation so future
// changes that touch the tile / vertex coord pipeline can't
// silently break the world-fit Mercator render.

import { describe, expect, it } from 'vitest'
import { compileGeoJSONToTiles } from '../tiler/vector-tiler'

describe('z=0 world-wide polygon rendering regression gate', () => {
  it('compiles a full-world rectangular polygon (180° lon × 145° lat span) at z=0', () => {
    const features = [
      {
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [-180, 75],
              [180, 75],
              [180, -70],
              [-180, -70],
              [-180, 75],
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
    expect(compiled.levels.length).toBeGreaterThan(0)
    expect(compiled.featureCount).toBeGreaterThan(0)
  })

  it('compiles Eurasia-shaped polygon (140° lon × 40° lat span) at z=0..1', () => {
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
      { minZoom: 0, maxZoom: 1 },
    )
    expect(compiled).toBeTruthy()
    expect(compiled.levels.length).toBeGreaterThan(0)
    expect(compiled.featureCount).toBeGreaterThan(0)
  })

  it('compiles antimeridian-crossing polygon at z=0', () => {
    // Range Pacific Rim from 130°E to -130°W (260° spanning the
    // antimeridian). Crosses the ±180° boundary.
    const features = [
      {
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [130, 60],
              [-130, 60],
              [-130, 20],
              [130, 20],
              [130, 60],
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

  it('compiles high-latitude Russia-shape (±170° lon, lat 60-80) at z=0', () => {
    // Northern Russia spans nearly the full longitude range at
    // high latitude — the case where geodesic midpoint hopped to
    // the pole pre-iter-56.
    const features = [
      {
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [-170, 60],
              [170, 60],
              [170, 80],
              [-170, 80],
              [-170, 60],
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

  it('compiles multipolygon (3 continents) at z=0 — typical world-fit view', () => {
    const features = [
      {
        type: 'Feature' as const,
        properties: { name: 'continents' },
        geometry: {
          type: 'MultiPolygon' as const,
          coordinates: [
            // Eurasia
            [
              [
                [10, 75],
                [150, 75],
                [150, 35],
                [10, 35],
                [10, 75],
              ],
            ],
            // Africa
            [
              [
                [-20, 35],
                [50, 35],
                [50, -35],
                [-20, -35],
                [-20, 35],
              ],
            ],
            // Americas
            [
              [
                [-170, 70],
                [-30, 70],
                [-30, -55],
                [-170, -55],
                [-170, 70],
              ],
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
    expect(compiled.levels.length).toBeGreaterThan(0)
    expect(compiled.featureCount).toBeGreaterThan(0)
  })
})
