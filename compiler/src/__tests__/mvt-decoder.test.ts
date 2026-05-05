import { describe, expect, it } from 'vitest'
// @ts-expect-error — no published types
import geojsonVt from 'geojson-vt'
// @ts-expect-error — no published types
import vtpbf from 'vt-pbf'
import { decodeMvtTile } from '../input/mvt-decoder'

// Round-trip: GeoJSON → geojson-vt slice → vt-pbf serialize → decodeMvtTile.
// Assert the un-quantized lon/lat lands close to the original (within
// 1 / extent ≈ 1/4096 of tile width — sub-meter at z>=14).
describe('decodeMvtTile (round-trip)', () => {
  // World tile z=0/x=0/y=0 covers all of Web Mercator.
  const z = 0
  const x = 0
  const y = 0

  it('decodes a Point feature with un-quantized lon/lat', () => {
    const orig = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [10, 20] },
        properties: { name: 'p1', kind: 1 },
      }],
    }
    const idx = geojsonVt(orig, { maxZoom: 0, indexMaxZoom: 0 })
    const tile = idx.getTile(z, x, y)
    const buf = vtpbf.fromGeojsonVt({ pts: tile })

    const features = decodeMvtTile(buf, z, x, y)
    expect(features).toHaveLength(1)
    expect(features[0].geometry.type).toBe('Point')
    const [lon, lat] = (features[0].geometry as { coordinates: number[] }).coordinates
    // Quantization: 4096 units across world (~10° per unit at z=0); error ≤ ~0.05°.
    expect(Math.abs(lon - 10)).toBeLessThan(0.1)
    expect(Math.abs(lat - 20)).toBeLessThan(0.1)
    expect(features[0].properties.name).toBe('p1')
    expect(features[0].properties.kind).toBe(1)
    expect(features[0].properties._layer).toBe('pts')
  })

  it('decodes LineString and Polygon, stamps _layer for each', () => {
    const orig = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[0, 0], [10, 10], [20, 0]] },
          properties: {},
        },
        {
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
          properties: { kind: 'park' },
        },
      ],
    }
    const idx = geojsonVt(orig, { maxZoom: 0, indexMaxZoom: 0 })
    const tile = idx.getTile(z, x, y)
    const buf = vtpbf.fromGeojsonVt({ shapes: tile })

    const features = decodeMvtTile(buf, z, x, y)
    expect(features.length).toBeGreaterThanOrEqual(2)
    const types = features.map(f => f.geometry.type).sort()
    expect(types).toContain('LineString')
    expect(types).toContain('Polygon')
    for (const f of features) {
      expect(f.properties._layer).toBe('shapes')
    }
  })

  it('flattens multi-layer MVTs and tags each feature with its layer', () => {
    const water = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]] },
        properties: {},
      }],
    }
    const roads = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[10, 0], [15, 5]] },
        properties: {},
      }],
    }
    const t1 = geojsonVt(water, { maxZoom: 0, indexMaxZoom: 0 }).getTile(z, x, y)
    const t2 = geojsonVt(roads, { maxZoom: 0, indexMaxZoom: 0 }).getTile(z, x, y)
    const buf = vtpbf.fromGeojsonVt({ water: t1, roads: t2 })

    const features = decodeMvtTile(buf, z, x, y)
    const layers = new Set(features.map(f => f.properties._layer as string))
    expect(layers).toEqual(new Set(['water', 'roads']))
  })

  it('layers option restricts to the named subset', () => {
    const water = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [0, 0] },
        properties: {},
      }],
    }
    const roads = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [5, 5] },
        properties: {},
      }],
    }
    const t1 = geojsonVt(water, { maxZoom: 0, indexMaxZoom: 0 }).getTile(z, x, y)
    const t2 = geojsonVt(roads, { maxZoom: 0, indexMaxZoom: 0 }).getTile(z, x, y)
    const buf = vtpbf.fromGeojsonVt({ water: t1, roads: t2 })

    const features = decodeMvtTile(buf, z, x, y, { layers: ['roads'] })
    expect(features.every(f => f.properties._layer === 'roads')).toBe(true)
    expect(features.length).toBeGreaterThan(0)
  })
})
