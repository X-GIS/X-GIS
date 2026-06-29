// Tests for the `distance` predicate (CPU, GPU-free). Mapbox
// `["distance", <GeoJSON>]` returns the shortest distance in METRES
// between the feature geometry and the argument geometry. First slice:
// Point / MultiPoint feature-geometry vs a target decomposed (at compile
// time) into points / segments / polygons. Distance uses a cheap-ruler
// (latitude-corrected planar) metric — the same approach Mapbox uses.

import { describe, it, expect } from 'vitest'
import { evalDistance } from './distance'

const pt = (lng: number, lat: number) => ({ type: 'Point', coordinates: [lng, lat] })

// A 10×10 lng/lat square and its 4 edges, as the converter would emit them.
const squareRings = [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]]
const squareEdges = [
  [[0, 0], [10, 0]], [[10, 0], [10, 10]], [[10, 10], [0, 10]], [[0, 10], [0, 0]],
]

describe('evalDistance — point to point (metres)', () => {
  it('one degree of latitude ≈ 110.6 km', () => {
    const d = evalDistance(pt(0, 0), [[0, 1]], [], [])!
    expect(d).toBeGreaterThan(110000)
    expect(d).toBeLessThan(111000)
  })
  it('one degree of longitude at the equator ≈ 111.3 km', () => {
    const d = evalDistance(pt(0, 0), [[1, 0]], [], [])!
    expect(d).toBeGreaterThan(110800)
    expect(d).toBeLessThan(111800)
  })
})

describe('evalDistance — point to segment', () => {
  it('perpendicular distance to a segment is smaller than to either endpoint', () => {
    // Feature just east of a meridian segment from [0,0]→[0,1].
    const d = evalDistance(pt(0.01, 0.5), [], [[[0, 0], [0, 1]]], [])!
    // ~0.01° longitude ≈ 1.1 km perpendicular.
    expect(d).toBeGreaterThan(1000)
    expect(d).toBeLessThan(1300)
  })
})

describe('evalDistance — polygons', () => {
  it('point inside the polygon → 0', () => {
    expect(evalDistance(pt(5, 5), [], squareEdges, squareRings)).toBe(0)
  })
  it('point just south of the polygon → distance to the nearest edge', () => {
    const d = evalDistance(pt(5, -1), [], squareEdges, squareRings)!
    expect(d).toBeGreaterThan(110000)
    expect(d).toBeLessThan(111000)
  })
})

describe('evalDistance — MultiPoint feature takes the minimum', () => {
  it('nearest of the feature points wins', () => {
    const geom = { type: 'MultiPoint', coordinates: [[0, 0], [0, 0.5]] }
    const d = evalDistance(geom, [[0, 1]], [], [])!
    // min(110.6km, 55.3km) ≈ 55.3km via the [0,0.5] point.
    expect(d).toBeGreaterThan(55000)
    expect(d).toBeLessThan(56000)
  })
})

describe('evalDistance — deferred / degraded inputs', () => {
  it('LineString feature-geometry → null (deferred slice)', () => {
    expect(evalDistance({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, [[5, 5]], [], [])).toBeNull()
  })
  it('null geometry (MVT path) → null', () => {
    expect(evalDistance(null, [[0, 0]], [], [])).toBeNull()
  })
  it('empty target → null', () => {
    expect(evalDistance(pt(0, 0), [], [], [])).toBeNull()
  })
})
