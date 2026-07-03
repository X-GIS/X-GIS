import { describe, expect, it } from 'vitest'
import { XGISMap } from './map'
import type { GeoJSONFeatureCollection } from '@xgis/data'

// ═══ EPSG ingest-reprojection wiring (Task T4 — AC3 / AC7 / AC8 / AC9) ═══
//
// XGISMap reprojects declared-CRS input GeoJSON to WGS84 lon/lat at every
// real-FC ingest site (inline-seed, legacy-URL, setSourceData,
// _attachGeoJSONViaVirtualPMTiles) via the shared chokepoint helper
// `_reprojectIngest`. All four sites resolve `fromEPSG` the same way — by
// source name in the `sourceCRS` registry (built in `run()` from
// `commands.loads[].crs`) — so driving `_reprojectIngest` directly is an
// integration-style proof of the wired behaviour without a GPU device
// (`rebuildLayers` needs a GPU context). The bounds-fit gate test
// (`map-bounds-fit-gate.test.ts`) establishes the mock-canvas + underscore
// test-seam pattern this file reuses.
//
// Ground-truth: EPSG:5179 (UTM-K) Seoul City Hall (953931.78, 1953317.84)
// reprojects to WGS84 (126.97826581…, 37.57809031…), which falls in the
// z14 Web-Mercator slippy tile (13970, 6344). These values were derived
// from the pyproj cross-validation reference (cross-validation.fixture.json
// → epsg_reprojection → "Seoul city hall" → refMercX/refMercY → lon/lat →
// z14 tile).

function mockCanvas(): HTMLCanvasElement {
  return { width: 1200, height: 800 } as unknown as HTMLCanvasElement
}

/** Seed a source's declared CRS in the registry the ingest sites read.
 *  Mirrors what `run()` does from `commands.loads[].crs`. */
function setSourceCRS(map: XGISMap, sourceName: string, crs: string): void {
  ;(map as unknown as { sourceCRS: Map<string, string> }).sourceCRS.set(sourceName, crs)
}

// EPSG:5179 inputs (UTM-K metres) and their known WGS84 ground truth.
const SEOUL_5179: [number, number] = [953931.78, 1953317.84]
const SEOUL_LON = 126.97826581280488
const SEOUL_LAT = 37.57809031162137
// A nearby second 5179 point so the LineString spans real geometry. +100 m
// in each axis keeps it inside the same z14 tile as City Hall (the hall sits
// near a tile corner, so a larger offset would straddle the boundary).
const SEOUL_5179_B: [number, number] = [953931.78 + 100, 1953317.84 + 100]

const Z14 = 14
function tileXY(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z
  const x = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  return [x, y]
}

function koreaFC(): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [...SEOUL_5179] },
        properties: { name: 'city hall' },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [[...SEOUL_5179], [...SEOUL_5179_B]],
        },
        properties: { name: 'a street' },
      },
    ],
  }
}

function pointCoords(fc: GeoJSONFeatureCollection): number[] {
  return (fc.features[0]!.geometry as { coordinates: number[] }).coordinates
}
function lineCoords(fc: GeoJSONFeatureCollection): number[][] {
  return (fc.features[1]!.geometry as { coordinates: number[][] }).coordinates
}

describe('XGISMap EPSG ingest reprojection (T4 wiring)', () => {
  it('reprojects declared-CRS input to WGS84 LL pre-tiling (AC3)', () => {
    const map = new XGISMap(mockCanvas())
    setSourceCRS(map, 'korea', 'EPSG:5179')

    const out = map._reprojectIngest('korea', koreaFC())

    // Point: 5179 metres → WGS84 degrees.
    const [lon, lat] = pointCoords(out)
    expect(lon).toBeCloseTo(SEOUL_LON, 6)
    expect(lat).toBeCloseTo(SEOUL_LAT, 6)

    // Degrees, not the ~10^6-metre 5179 inputs (proves it ran pre-tiling).
    expect(Math.abs(lon)).toBeLessThanOrEqual(180)
    expect(Math.abs(lat)).toBeLessThanOrEqual(90)
  })

  it('LineString + Point land in the correct z14 tile (AC8)', () => {
    const map = new XGISMap(mockCanvas())
    setSourceCRS(map, 'korea', 'EPSG:5179')

    const out = map._reprojectIngest('korea', koreaFC())
    const expectedTile = tileXY(SEOUL_LON, SEOUL_LAT, Z14)
    expect(expectedTile).toEqual([13970, 6344])

    const [plon, plat] = pointCoords(out)
    expect(tileXY(plon, plat, Z14)).toEqual(expectedTile)

    for (const [llon, llat] of lineCoords(out)) {
      const [tx, ty] = tileXY(llon!, llat!, Z14)
      // Every LineString vertex lands in the expected Seoul tile (±0 here;
      // ±1 tolerance documents that the assertion is a Seoul-neighbourhood
      // guard, not garbage from un-reprojected 5179 metres — those would be
      // billions of tiles away).
      expect(Math.abs(tx - expectedTile[0])).toBeLessThanOrEqual(1)
      expect(Math.abs(ty - expectedTile[1])).toBeLessThanOrEqual(1)
    }
  })

  it('reprojected bounds feeding camera-fit are WGS84, not 5179 metres (AC9)', () => {
    // camera-fit at the ingest sites consumes the SAME (reprojected) FC the
    // tiler does (computeGeoJSONBounds is called after _reprojectIngest in
    // _attachGeoJSONViaVirtualPMTiles). Bounds of the reprojected FC must be
    // in degrees — if reprojection ran AFTER bounds, these would be ~10^6.
    const map = new XGISMap(mockCanvas())
    setSourceCRS(map, 'korea', 'EPSG:5179')
    const out = map._reprojectIngest('korea', koreaFC())

    let minLon = Infinity,
      minLat = Infinity,
      maxLon = -Infinity,
      maxLat = -Infinity
    const visit = (c: unknown): void => {
      if (!Array.isArray(c)) return
      if (typeof c[0] === 'number' && typeof c[1] === 'number') {
        const lon = c[0] as number,
          lat = c[1] as number
        if (lon < minLon) minLon = lon
        if (lon > maxLon) maxLon = lon
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
        return
      }
      for (const inner of c) visit(inner)
    }
    for (const f of out.features) visit((f.geometry as { coordinates?: unknown }).coordinates)

    expect(minLon).toBeGreaterThan(126)
    expect(maxLon).toBeLessThan(128)
    expect(minLat).toBeGreaterThan(37)
    expect(maxLat).toBeLessThan(38)
  })

  it('source with no declared CRS is a no-op (returns same ref, AC3)', () => {
    const map = new XGISMap(mockCanvas())
    const fc = koreaFC()
    // No setSourceCRS → absent ⇒ EPSG:4326 / no-op.
    expect(map._reprojectIngest('unknown-src', fc)).toBe(fc)
  })

  it('explicit EPSG:4326 declared CRS is a no-op (returns same ref)', () => {
    const map = new XGISMap(mockCanvas())
    setSourceCRS(map, 'wgs84', 'EPSG:4326')
    const fc = koreaFC()
    expect(map._reprojectIngest('wgs84', fc)).toBe(fc)
  })

  it('invalid / unsupported EPSG throws an error naming the source (AC7)', () => {
    const map = new XGISMap(mockCanvas())
    setSourceCRS(map, 'bad-src', 'EPSG:99999')
    expect(() => map._reprojectIngest('bad-src', koreaFC())).toThrow(/bad-src/)
    // The error is tagged so run()'s parallel-load loop can isolate it.
    try {
      map._reprojectIngest('bad-src', koreaFC())
    } catch (e) {
      expect((e as { xgisReprojectFailure?: boolean }).xgisReprojectFailure).toBe(true)
    }
  })

  it('malformed EPSG string throws an error naming the source (AC7)', () => {
    const map = new XGISMap(mockCanvas())
    setSourceCRS(map, 'junk-src', 'not-an-epsg')
    expect(() => map._reprojectIngest('junk-src', koreaFC())).toThrow(/junk-src/)
  })
})
