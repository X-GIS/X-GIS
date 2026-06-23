// Regression test for FIX #7: latToTileY clamp must use ±85.0511287 (canonical
// Web Mercator limit), not ±85.
//
// The bug: the scatter step in processZoomLevelShared calls latToTileY on
// part.maxLat / part.minLat to compute fyMin/fyMax. With the ±85 clamp, any
// latitude in (85.0, 85.0511287) is clamped to 85.0 before being projected,
// producing row 26 at z=14. The CORRECT row (per tileBounds) is 1–25.
// When ALL vertices of a polygon are in the polar band, fyMin==fyMax==26 and
// the feature is scattered exclusively to tile row 26. compileSingleTile for
// the correct row (e.g. 5) receives zero candidates → returns null → feature
// is SILENTLY DROPPED.
//
// The test goes through compileGeoJSONToTiles (which runs the scatter step),
// then looks up the expected tile by key. Fail-before: tile absent (null).
// Pass-after: tile present with non-zero fill indices.

import { describe, it, expect } from 'vitest'
import { compileGeoJSONToTiles, tileKey } from './vector-tiler'
import type { GeoJSONFeatureCollection } from './geojson-types'

// ── helpers ────────────────────────────────────────────────────────────────

/** Tile column for a longitude at zoom z. */
function lonToTileX(lon: number, z: number): number {
  const n = Math.pow(2, z)
  return Math.max(0, Math.min(n - 1, Math.floor((lon + 180) / 360 * n)))
}

// ── constants ──────────────────────────────────────────────────────────────

// At z=14 tile row 5 has tileBounds south≈85.039743, north≈85.041642.
// This tile is entirely within the (85.0, 85.0511287) polar band.
// A polygon whose ALL vertices are in this band should scatter to row 5,
// but the buggy ±85 clamp maps those latitudes to row 26 instead.
const Z = 14
const CORRECT_ROW = 5  // tileBounds(14,5): south=85.039743, north=85.041642
const LAT_SOUTH = 85.0400  // inside tile row 5's bounds
const LAT_NORTH = 85.0415  // inside tile row 5's bounds
const LON = 10.0

function makeFC(): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [LON - 0.001, LAT_SOUTH],
          [LON + 0.001, LAT_SOUTH],
          [LON + 0.001, LAT_NORTH],
          [LON - 0.001, LAT_NORTH],
          [LON - 0.001, LAT_SOUTH],
        ]],
      },
    }],
  }
}

// ── test ───────────────────────────────────────────────────────────────────

describe('latToTileY polar-band clamp fix (FIX #7)', () => {
  it('polygon entirely within polar band (85.039–85.042) appears in scatter-assigned tile at z=14', () => {
    const fc = makeFC()
    // maxZoom=14 ensures z=14 tiles are generated.
    const tileset = compileGeoJSONToTiles(fc, { minZoom: Z, maxZoom: Z })

    const level = tileset.levels.find(l => l.zoom === Z)
    expect(level, 'zoom level 14 must be present').toBeDefined()

    const x = lonToTileX(LON, Z)
    const key = tileKey(Z, x, CORRECT_ROW)
    const tile = level!.tiles.get(key)

    // With the ±85 bug, the scatter places this polygon in tile row 26 only.
    // The correct tile (row 5) is absent → tile === undefined.
    // After the fix, the polygon is scattered to row 5 and the tile is present
    // with non-zero fill geometry.
    expect(tile,
      `tile (z=${Z}, x=${x}, y=${CORRECT_ROW}) must exist; ` +
      `undefined means the polar-band polygon was scattered to the wrong row`
    ).toBeDefined()

    expect(tile!.indices.length,
      'polar-band polygon must produce fill triangles in the correct tile'
    ).toBeGreaterThan(0)
  })

  it('buggy ±85 clamp maps lat=85.04 to a different row than canonical ±85.0511287 clamp at z=14 (documents the numerical mismatch)', () => {
    const n = Math.pow(2, Z)
    const project = (lat: number) =>
      Math.max(0, Math.min(n - 1,
        Math.floor(
          (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n
        )
      ))

    const buggyRow = project(Math.max(-85, Math.min(85, 85.04)))
    const correctRow = project(Math.max(-85.0511287, Math.min(85.0511287, 85.04)))

    expect(buggyRow).not.toEqual(correctRow)
    // buggy clamp collapses to lat=85.0 → row 26; correct → row 5
    expect(correctRow).toBeLessThan(buggyRow)
  })
})
