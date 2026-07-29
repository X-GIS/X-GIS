import { describe, expect, it } from 'vitest'
// @ts-expect-error — no published types
import geojsonVt from 'geojson-vt'
// @ts-expect-error — no published types
import vtpbf from 'vt-pbf'
import Pbf from 'pbf'
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

  // #1221 R4 hardening — dropping the line-arm lon RANGE clamp must NOT drop
  // the iter-296 NON-FINITE guard. A malformed MVT declaring extent 0 makes
  // toGeoJSON's un-quantisation divide by zero (NaN/±Infinity lon), and the
  // downstream Liang-Barsky clip fails OPEN on non-finite input, leaking NaN
  // vertices into the f32 tile mesh. Every decoded coordinate must be finite.
  // (vtpbf can't author this — `extent: 0` is falsy and falls back to 4096 —
  // so the layer bytes are hand-written with pbf.)
  it('sanitises non-finite line lon from a malformed extent-0 MVT (iter-296 guard)', () => {
    const writeFeature = (_: unknown, fpbf: InstanceType<typeof Pbf>) => {
      fpbf.writeVarintField(3, 2) // GeomType = LINESTRING
      // MoveTo(0,0) + LineTo(+10,+10): [cmd(1,1), zz(0), zz(0), cmd(2,1), zz(10), zz(10)]
      fpbf.writePackedVarint(4, [9, 0, 0, 10, 20, 20])
    }
    const writeLayer = (_: unknown, lpbf: InstanceType<typeof Pbf>) => {
      lpbf.writeVarintField(15, 2) // version
      lpbf.writeStringField(1, 'bad') // name
      lpbf.writeVarintField(5, 0) // extent = 0 ← the malformation
      lpbf.writeMessage(2, writeFeature, null)
    }
    const tilePbf = new Pbf()
    tilePbf.writeMessage(3, writeLayer, null)
    const features = decodeMvtTile(tilePbf.finish(), 0, 0, 0)
    expect(features.length).toBeGreaterThan(0)
    for (const f of features) {
      const coords = (f.geometry as { coordinates: number[][] }).coordinates
      for (const c of coords) {
        expect(Number.isFinite(c[0]), `lon finite, got ${c[0]}`).toBe(true)
        expect(Number.isFinite(c[1]), `lat finite, got ${c[1]}`).toBe(true)
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

// #1497 — fetched MVT was the one source path that reached the GPU with its
// authored vertices only. On Mercator that is harmless; on every other
// projection a long authored edge is a chord across a curve, and its
// Mercator-space extrusion collapses (#1495: the same style draws continuous
// lines from a GeoJSON source and disconnected dots from MVT, same camera).
//
// These assert the CONTRACT, not the implementation: no emitted edge spans
// more than the tiler's own subdivision bound, and the original vertices
// survive. A test that pinned the exact interpolated positions would just
// re-encode subdivideGreatCircle and break on any refinement to it.
describe('decodeMvtTile — line densification (#1497)', () => {
  const z = 0,
    x = 0,
    y = 0

  /** Longest great-circle edge in the polyline, in degrees. */
  const maxEdgeDeg = (coords: number[][]): number => {
    let worst = 0
    for (let i = 0; i < coords.length - 1; i++) {
      const [lon1, lat1] = coords[i]
      const [lon2, lat2] = coords[i + 1]
      const r = Math.PI / 180
      const c =
        Math.sin(lat1 * r) * Math.sin(lat2 * r) +
        Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r)
      worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, c))) / r)
    }
    return worst
  }

  const decodeLine = (coordinates: number[][]): number[][] => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: {} },
      ],
    }
    const tile = geojsonVt(fc, { maxZoom: 0, indexMaxZoom: 0 }).getTile(z, x, y)
    const buf = vtpbf.fromGeojsonVt({ l: tile })
    const features = decodeMvtTile(buf, z, x, y)
    return (features[0].geometry as { coordinates: number[][] }).coordinates
  }

  it('breaks a world-spanning edge into sub-degree pieces', () => {
    // A single 120°-long authored edge — the shape a z0-z2 coastline tile
    // actually contains. Pre-fix this decoded to exactly two vertices.
    const out = decodeLine([
      [-60, 10],
      [60, 10],
    ])
    expect(out.length).toBeGreaterThan(60)
    expect(maxEdgeDeg(out)).toBeLessThan(2)
  })

  it('leaves an already-short edge alone', () => {
    // Below the tiler's 0.5° skip threshold: the decoder must not pay for,
    // or perturb, geometry that is already dense. This is the high-zoom case
    // — every tile above ~z9 spans less than this.
    const src = [
      [10, 20],
      [10.1, 20.05],
      [10.2, 20.1],
    ]
    const out = decodeLine(src)
    expect(out).toHaveLength(src.length)
  })

  it('keeps a >±180 antimeridian wrap monotone', () => {
    // MapLibre's convention authors a seam-crossing line past ±180 and the
    // decoder deliberately does NOT clamp longitude (clampPosLatOnly), so the
    // renderer can draw it at world-copy +1. Interpolated vertices must stay
    // on that same 360° branch — a naive slerp folds 185° back to -175° and
    // shreds the polyline into ±360° jumps at the seam (#1221).
    const out = decodeLine([
      [170, 0],
      [190, 0],
    ])
    // Non-vacuity: with only the two authored vertices the monotone check
    // below is trivially true, so it would pass with densification removed
    // and assert nothing. The interpolated vertices are the ones at risk.
    expect(out.length).toBeGreaterThan(2)
    for (let i = 0; i < out.length - 1; i++) {
      expect(Math.abs(out[i + 1][0] - out[i][0])).toBeLessThan(180)
    }
  })

  it('still clamps interpolated vertices to the planet in latitude', () => {
    // The densify runs BEFORE the clamp, so an interpolated vertex is as
    // capable of landing beyond ±85.05 as an authored one.
    // A 160°-long great-circle arc between two 84°N endpoints bulges to
    // ~88.95°N at its midpoint — measured, not assumed — so the interpolated
    // vertices are genuinely out of range while both authored endpoints are
    // in range. Without densification this assertion would only ever see the
    // two in-range points and would assert nothing.
    const out = decodeLine([
      [-170, 84],
      [-10, 84],
    ])
    expect(out.length).toBeGreaterThan(2)
    expect(out.some(([, lat]) => lat === 85.0511287)).toBe(true)
    expect(out.every(([, lat]) => Math.abs(lat) <= 85.0511287)).toBe(true)
  })
})
