// Pin GeometryCollection handling in loadGeoJSON (iter 452).
// Pre-fix the four `geom.type ===` arms silently dropped features
// whose geometry is a GeometryCollection — spec-permitted per RFC
// 7946 §3.1.8. OSM extracts that bundle polygon body + label-anchor
// point per landuse feature use this shape; the polygon side
// previously rendered as empty.

import { describe, it, expect } from 'vitest'
import { loadGeoJSON } from './geojson'
import type { GeoJSONFeatureCollection } from './geojson'

describe('loadGeoJSON GeometryCollection support', () => {
  it('flattens Polygon sub-geometry inside a GeometryCollection', () => {
    const fc: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          // @ts-expect-error — GeometryCollection isn't in the runtime
          // Geometry union but the loader handles it defensively.
          type: 'GeometryCollection',
          geometries: [
            {
              type: 'Polygon',
              coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
            },
          ],
        },
        properties: { kind: 'park' },
      }],
    }
    const result = loadGeoJSON(fc)
    expect(result.polygons.vertices.length).toBeGreaterThan(0)
  })

  it('flattens LineString sub-geometry', () => {
    const fc: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          // @ts-expect-error — see above
          type: 'GeometryCollection',
          geometries: [
            {
              type: 'LineString',
              coordinates: [[0, 0], [10, 10]],
            },
          ],
        },
        properties: {},
      }],
    }
    const result = loadGeoJSON(fc)
    expect(result.lines.vertices.length).toBeGreaterThan(0)
  })

  it('flattens mixed Polygon + LineString inside one collection', () => {
    const fc: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          // @ts-expect-error
          type: 'GeometryCollection',
          geometries: [
            {
              type: 'Polygon',
              coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]],
            },
            {
              type: 'LineString',
              coordinates: [[20, 20], [30, 30]],
            },
          ],
        },
        properties: { id: 'mix' },
      }],
    }
    const result = loadGeoJSON(fc)
    expect(result.polygons.vertices.length).toBeGreaterThan(0)
    expect(result.lines.vertices.length).toBeGreaterThan(0)
  })

  it('handles empty geometries array', () => {
    const fc: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          // @ts-expect-error
          type: 'GeometryCollection',
          geometries: [],
        },
        properties: {},
      }],
    }
    const result = loadGeoJSON(fc)
    expect(result.polygons.vertices.length).toBe(0)
    expect(result.lines.vertices.length).toBe(0)
  })

  it('handles MultiPolygon sub-geometry', () => {
    const fc: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          // @ts-expect-error
          type: 'GeometryCollection',
          geometries: [
            {
              type: 'MultiPolygon',
              coordinates: [
                [[[0, 0], [5, 0], [5, 5], [0, 0]]],
                [[[10, 10], [15, 10], [15, 15], [10, 10]]],
              ],
            },
          ],
        },
        properties: {},
      }],
    }
    const result = loadGeoJSON(fc)
    expect(result.polygons.vertices.length).toBeGreaterThan(0)
  })
})
