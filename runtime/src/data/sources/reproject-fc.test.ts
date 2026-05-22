// Unit test for reprojectFeatureCollection (EPSG input-reprojection, AC8).
//
// Covers:
//   1. Polygon + LineString + Point in EPSG:5179 reproject to the expected
//      WGS84 lon/lat (cross-checked against a proj4 round-trip reference).
//   2. MultiPolygon / MultiLineString / MultiPoint / GeometryCollection
//      recurse to every coordinate pair.
//   3. EPSG:4326 (and alternate spellings) is a no-op returning the input.
//   4. Unregistered EPSG throws (propagated from resolveEPSG).
//   5. The input FeatureCollection is NOT mutated (clone semantics).

import { describe, expect, it } from 'vitest'
import proj4 from 'proj4'
import { reprojectFeatureCollection } from './reproject-fc'
import type { GeoJSONFeatureCollection } from '../../loader/geojson'

// Reference: Seoul City Hall ≈ [126.9784, 37.5665] (WGS84) ⇒ EPSG:5179.
// proj4 round-trips this pair to itself (verified), so the 5179 → 4326
// transform of these meters must land back on the known lon/lat.
const LONLAT: [number, number] = [126.9784, 37.5665]
const M5179: [number, number] = [953936.4903427484, 1952031.8848331424]

// Tight tolerance: the AC0-decided cross-validation bound is 1mm at
// EPSG:3857; in lon/lat degrees a few 1e-9 round-off is the real residual.
const TOL = 1e-7

describe('reprojectFeatureCollection', () => {
  it('reprojects Point / LineString / Polygon from EPSG:5179 to WGS84', () => {
    const fc: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: M5179.slice() }, properties: {} },
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [M5179.slice(), M5179.slice()] },
          properties: {},
        },
        {
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[M5179.slice(), M5179.slice(), M5179.slice(), M5179.slice()]] },
          properties: {},
        },
      ],
    }

    const out = reprojectFeatureCollection(fc, 'EPSG:5179')

    const pt = out.features[0]!.geometry as { type: 'Point'; coordinates: number[] }
    expect(pt.coordinates[0]).toBeCloseTo(LONLAT[0], 7)
    expect(pt.coordinates[1]).toBeCloseTo(LONLAT[1], 7)

    const line = out.features[1]!.geometry as { type: 'LineString'; coordinates: number[][] }
    for (const c of line.coordinates) {
      expect(Math.abs(c[0]! - LONLAT[0])).toBeLessThan(TOL)
      expect(Math.abs(c[1]! - LONLAT[1])).toBeLessThan(TOL)
    }

    const poly = out.features[2]!.geometry as { type: 'Polygon'; coordinates: number[][][] }
    for (const ring of poly.coordinates) {
      for (const c of ring) {
        expect(Math.abs(c[0]! - LONLAT[0])).toBeLessThan(TOL)
        expect(Math.abs(c[1]! - LONLAT[1])).toBeLessThan(TOL)
      }
    }
  })

  it('accepts bare-numeric and "5179" CRS spellings', () => {
    const fc: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: M5179.slice() }, properties: {} }],
    }
    for (const crs of ['5179', 5179] as const) {
      const out = reprojectFeatureCollection(fc, crs)
      const pt = out.features[0]!.geometry as { type: 'Point'; coordinates: number[] }
      expect(pt.coordinates[0]).toBeCloseTo(LONLAT[0], 7)
      expect(pt.coordinates[1]).toBeCloseTo(LONLAT[1], 7)
    }
  })

  it('recurses MultiPoint / MultiLineString / MultiPolygon / GeometryCollection', () => {
    const fc: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [M5179.slice()] }, properties: {} },
        {
          type: 'Feature',
          geometry: { type: 'MultiLineString', coordinates: [[M5179.slice(), M5179.slice()]] },
          properties: {},
        },
        {
          type: 'Feature',
          geometry: { type: 'MultiPolygon', coordinates: [[[M5179.slice(), M5179.slice(), M5179.slice()]]] },
          properties: {},
        },
        {
          type: 'Feature',
          geometry: {
            type: 'GeometryCollection',
            geometries: [
              { type: 'Point', coordinates: M5179.slice() },
              { type: 'LineString', coordinates: [M5179.slice(), M5179.slice()] },
            ],
          },
          properties: {},
        },
      ],
    }

    const out = reprojectFeatureCollection(fc, 'EPSG:5179')

    // Walk every leaf position and assert it landed on the reference lon/lat.
    const check = (coords: unknown): void => {
      if (!Array.isArray(coords)) return
      if (typeof coords[0] === 'number') {
        expect(Math.abs((coords[0] as number) - LONLAT[0])).toBeLessThan(TOL)
        expect(Math.abs((coords[1] as number) - LONLAT[1])).toBeLessThan(TOL)
        return
      }
      for (const c of coords) check(c)
    }
    const mp = out.features[0]!.geometry as { coordinates: unknown }
    check(mp.coordinates)
    const mls = out.features[1]!.geometry as { coordinates: unknown }
    check(mls.coordinates)
    const mpoly = out.features[2]!.geometry as { coordinates: unknown }
    check(mpoly.coordinates)
    const gc = out.features[3]!.geometry as { type: 'GeometryCollection'; geometries: { coordinates: unknown }[] }
    for (const g of gc.geometries) check(g.coordinates)
  })

  it('is a no-op for EPSG:4326 (returns the same reference)', () => {
    const fc: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [126.9784, 37.5665] }, properties: {} }],
    }
    for (const crs of ['EPSG:4326', '4326', 4326, 'epsg:4326'] as const) {
      expect(reprojectFeatureCollection(fc, crs)).toBe(fc)
    }
  })

  it('throws on an unregistered EPSG code', () => {
    const fc: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }],
    }
    expect(() => reprojectFeatureCollection(fc, 'EPSG:9999')).toThrow(/Unsupported EPSG/)
    expect(() => reprojectFeatureCollection(fc, 'not-an-epsg')).toThrow(/Invalid EPSG/)
  })

  it('does not mutate the input FeatureCollection', () => {
    const original = M5179.slice()
    const fc: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: original }, properties: { name: 'x' } }],
    }
    const out = reprojectFeatureCollection(fc, 'EPSG:5179')

    // Input coordinates untouched.
    expect(original).toEqual(M5179)
    expect((fc.features[0]!.geometry as { coordinates: number[] }).coordinates).toEqual(M5179)
    // Output is a different object.
    expect(out).not.toBe(fc)
    expect(out.features[0]).not.toBe(fc.features[0])
    // properties carried through.
    expect(out.features[0]!.properties).toEqual({ name: 'x' })
  })

  it('matches a direct proj4 transform for an arbitrary 5179 point', () => {
    const xy = [1000000, 2000000] // 5179 false-origin ⇒ lon_0=127.5, lat_0=38
    const fc: GeoJSONFeatureCollection = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: xy.slice() }, properties: {} }],
    }
    const out = reprojectFeatureCollection(fc, 'EPSG:5179')
    const expected = proj4('EPSG:5179', 'EPSG:4326', xy.slice())
    const got = (out.features[0]!.geometry as { coordinates: number[] }).coordinates
    expect(got[0]).toBeCloseTo(expected[0]!, 9)
    expect(got[1]).toBeCloseTo(expected[1]!, 9)
  })
})
