import { describe, expect, it } from 'vitest'
// @ts-expect-error — no published types
import geojsonVt from 'geojson-vt'
// @ts-expect-error — no published types
import vtpbf from 'vt-pbf'
import { decodeMvtTile } from './mvt-decoder'

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
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [10, 20] },
          properties: { name: 'p1', kind: 1 },
        },
      ],
    }
    const idx = geojsonVt(orig, { maxZoom: 0, indexMaxZoom: 0 })
    const tile = idx.getTile(z, x, y)
    const buf = vtpbf.fromGeojsonVt({ pts: tile })

    const features = decodeMvtTile(buf, z, x, y)
    expect(features).toHaveLength(1)
    expect(features[0].geometry!.type).toBe('Point')
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
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [10, 10],
              [20, 0],
            ],
          },
          properties: {},
        },
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [10, 0],
                [10, 10],
                [0, 10],
                [0, 0],
              ],
            ],
          },
          properties: { kind: 'park' },
        },
      ],
    }
    const idx = geojsonVt(orig, { maxZoom: 0, indexMaxZoom: 0 })
    const tile = idx.getTile(z, x, y)
    const buf = vtpbf.fromGeojsonVt({ shapes: tile })

    const features = decodeMvtTile(buf, z, x, y)
    expect(features.length).toBeGreaterThanOrEqual(2)
    const types = features.map((f) => f.geometry!.type).sort()
    expect(types).toContain('LineString')
    expect(types).toContain('Polygon')
    for (const f of features) {
      expect(f.properties._layer).toBe('shapes')
    }
  })

  // #1221 R4 — a LineString's antimeridian BUFFER vertices (geojson-vt emits
  // the seam continuation copy at lon just beyond ±180) MUST survive decode
  // unclamped. The pre-fix clampLon pinned that whole beyond-±180 run to
  // EXACTLY ±180, degenerating it into a vertical wall of collinear segments
  // on the seam that the line renderer drew as a spurious vertical stroke.
  it('does NOT clamp a line vertex beyond ±180 into a seam wall (#1221)', () => {
    // A line hugging the antimeridian; a generous buffer forces geojson-vt to
    // emit wrapped-copy vertices past ±180 in the west tile (z3/x0).
    const orig = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [165, 60],
              [175, 66],
              [179, 68],
            ],
          },
          properties: {},
        },
      ],
    }
    const idx = geojsonVt(orig, { maxZoom: 14, buffer: 2048, extent: 8192 })
    const tile = idx.getTile(3, 0, 2) // west tile — holds the wrapped copy
    expect(tile).toBeTruthy()
    const buf = vtpbf.fromGeojsonVt({ route: tile }, { extent: 8192 })
    const features = decodeMvtTile(buf, 3, 0, 2)
    const line = features.find((f) => f.geometry?.type === 'LineString')
    expect(line).toBeTruthy()
    const coords = (line!.geometry as { coordinates: number[][] }).coordinates
    // Pre-fix: EVERY vertex clamped to exactly -180 (a >=3-vertex wall).
    // Post-fix: the beyond-±180 buffer vertices keep their real (< -180) lon.
    const beyond = coords.filter((c) => c[0] < -180.001)
    expect(beyond.length).toBeGreaterThan(0)
    // And they are NOT all pinned to one longitude (the wall signature).
    const uniqueLons = new Set(coords.map((c) => Math.round(c[0] * 100)))
    expect(uniqueLons.size).toBeGreaterThan(1)
  })

  // #1221 R4 — the sibling POLYGON path KEEPS the full clamp (the original
  // horizontal-sliver fix): a polygon buffer vertex beyond ±180 still lands on
  // the seam, never leaking a beyond-planet longitude into the fill mesh.
  it('STILL clamps a polygon vertex beyond ±180 (sliver-fix intact, #1221)', () => {
    const orig = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [170, 60],
                [179, 60],
                [179, 70],
                [170, 70],
                [170, 60],
              ],
            ],
          },
          properties: {},
        },
      ],
    }
    const idx = geojsonVt(orig, { maxZoom: 14, buffer: 2048, extent: 8192 })
    const tile = idx.getTile(3, 0, 2)
    if (tile) {
      const buf = vtpbf.fromGeojsonVt({ area: tile }, { extent: 8192 })
      const features = decodeMvtTile(buf, 3, 0, 2)
      for (const f of features) {
        const rings = (f.geometry as { coordinates: number[][][] }).coordinates
        for (const ring of rings) {
          for (const c of ring) {
            expect(c[0]).toBeGreaterThanOrEqual(-180.0001)
          }
        }
      }
    }
  })

  it('flattens multi-layer MVTs and tags each feature with its layer', () => {
    const water = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [5, 0],
                [5, 5],
                [0, 5],
                [0, 0],
              ],
            ],
          },
          properties: {},
        },
      ],
    }
    const roads = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [10, 0],
              [15, 5],
            ],
          },
          properties: {},
        },
      ],
    }
    const t1 = geojsonVt(water, { maxZoom: 0, indexMaxZoom: 0 }).getTile(z, x, y)
    const t2 = geojsonVt(roads, { maxZoom: 0, indexMaxZoom: 0 }).getTile(z, x, y)
    const buf = vtpbf.fromGeojsonVt({ water: t1, roads: t2 })

    const features = decodeMvtTile(buf, z, x, y)
    const layers = new Set(features.map((f) => f.properties._layer as string))
    expect(layers).toEqual(new Set(['water', 'roads']))
  })

  it('layers option restricts to the named subset', () => {
    const water = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: {},
        },
      ],
    }
    const roads = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [5, 5] },
          properties: {},
        },
      ],
    }
    const t1 = geojsonVt(water, { maxZoom: 0, indexMaxZoom: 0 }).getTile(z, x, y)
    const t2 = geojsonVt(roads, { maxZoom: 0, indexMaxZoom: 0 }).getTile(z, x, y)
    const buf = vtpbf.fromGeojsonVt({ water: t1, roads: t2 })

    const features = decodeMvtTile(buf, z, x, y, { layers: ['roads'] })
    expect(features.every((f) => f.properties._layer === 'roads')).toBe(true)
    expect(features.length).toBeGreaterThan(0)
  })
})
