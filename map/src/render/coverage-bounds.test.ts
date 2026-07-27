// ═══ Which region answers for a point — through the grid's own CRS (#1272 E-④ × #1366) ═══
//
// `coverageCovers` decides which region of a mosaic answers `getCoverage(id, at)`, by testing
// a lon/lat against the grid's outer edges. Those edges come from `header.origin`/`spacing`,
// which are in the grid's OWN units — degrees only for a geographic cell. Once projected
// cells became placeable (#1366 INC-3) the un-transformed test could never be true for one:
// a UTM cell's edges are metres in the hundreds of thousands, so every lon/lat on Earth falls
// outside and the source answers `null` for points plainly inside the drawn domain.
//
// The query moves into the grid's units rather than the edges into degrees — one transform of
// a point instead of four of a rectangle, and no question about what a reprojected bbox means.

import { describe, it, expect } from 'vitest'
import proj4 from 'proj4'
import { coverageCovers, coverageEdges } from './coverage-bounds'
import { coverageFromGrids, resolveEPSG, type CoverageHandle } from '@xgis/data'

function handle(
  crs: number | null,
  origin: [number, number],
  spacing: [number, number],
): CoverageHandle {
  return coverageFromGrids({
    product: 's102',
    crs,
    origin,
    spacing,
    size: [4, 3],
    bands: [
      { name: 'depth', unit: 'metres', kind: 'f32', nodata: 1e6, values: new Float32Array(12) },
    ],
    vertical: { datumCode: 23, sign: 'down' },
  })
}

describe('coverageEdges — the outer edges, half a cell beyond the centres', () => {
  it('runs half a cell out from the SW cell centre', () => {
    const h = handle(null, [5, 50], [2, 1])
    expect(coverageEdges(h)).toEqual([4, 49.5, 12, 52.5])
  })
})

describe('coverageCovers — a GEOGRAPHIC cell is unchanged', () => {
  const geo = handle(null, [5, 50], [2, 1])
  it('is edge-inclusive, so abutting NOAA domains leave no unclaimed hairline', () => {
    expect(coverageCovers(geo, 4, 49.5)).toBe(true) // exact SW corner
    expect(coverageCovers(geo, 12, 52.5)).toBe(true) // exact NE corner
    expect(coverageCovers(geo, 8, 51)).toBe(true) // interior
  })
  it('rejects outside', () => {
    expect(coverageCovers(geo, 3.9, 51)).toBe(false)
    expect(coverageCovers(geo, 8, 52.6)).toBe(false)
  })
})

describe('coverageCovers — a PROJECTED cell answers for real lon/lat (#1366)', () => {
  // The real Chesapeake cell's geometry class: UTM 18N, metre origin, 16 m cells.
  const UTM_ORIGIN: [number, number] = [420767.84475419234, 4183856.856912584]
  const utm = handle(32618, UTM_ORIGIN, [16, 16])

  // The footprint is only 4×3 cells at 16 m — ~64 m × 48 m — so the test point is COMPUTED
  // from the geometry rather than guessed at: a hand-picked lon/lat lands outside a plot
  // that small, and the assertion would then pass for the wrong reason.
  const centre = proj4(resolveEPSG('EPSG:32618'), 'EPSG:4326', [
    UTM_ORIGIN[0] + 1.5 * 16,
    UTM_ORIGIN[1] + 1 * 16,
  ]) as [number, number]

  it('covers a lon/lat inside its footprint, and rejects one outside', () => {
    // Fail-before: without the transform the test compares a ~−75.9 lon against a ~420 768
    // metre west edge, so EVERY point on Earth is "outside" and the mosaic answers null.
    expect(coverageCovers(utm, centre[0], centre[1])).toBe(true)
    // A degree away in either axis is genuinely outside this 64 m plot.
    expect(coverageCovers(utm, centre[0] + 1, centre[1])).toBe(false)
    expect(coverageCovers(utm, centre[0], centre[1] + 1)).toBe(false)
  })

  it('does NOT treat the raw metre coordinates as a position', () => {
    // The inverse mistake: feeding the grid's own units in as lon/lat must not "cover".
    expect(coverageCovers(utm, UTM_ORIGIN[0], UTM_ORIGIN[1])).toBe(false)
  })
})
