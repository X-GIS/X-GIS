// ═══ CRS-aware coverage readout (#1366) ═══
//
// `CoverageHandle.valueAt` indexes in the grid's OWN units. That made every lon/lat
// readout in the codebase silently correct for the geographic cells shipping today and
// silently WRONG for a real NOAA S-102 cell, whose grid is UTM metres: measured in the
// browser on the live Chesapeake cell, `valueAt(-75.75, 37.95)` returned null — not a
// wrong depth, no depth at all, because a lon/lat lands ~4 million metres off a metre
// grid. `valueAtLonLat` is the readout that works for both.
//
// Two claims are gated here:
//   1. The geographic path is IDENTITY — the cells shipping today are untouched.
//   2. The projected path hits the cell a metre query hits, so the transform is a change
//      of coordinates only. The null / NaN semantics of `valueAt` survive it.

import { describe, it, expect } from 'vitest'
import proj4 from 'proj4'
import { isGeographicCRS, lonLatToCellUnits, valueAtLonLat } from './crs'
import { coverageFromGrids, type CoverageHandle } from './format'
import { resolveEPSG } from '../sources/epsg-defs'

describe('isGeographicCRS', () => {
  it('accepts WGS 84 2D and 3D only', () => {
    expect(isGeographicCRS('EPSG:4326')).toBe(true)
    expect(isGeographicCRS('EPSG:4979')).toBe(true)
    expect(isGeographicCRS('EPSG:32618')).toBe(false)
    expect(isGeographicCRS('EPSG:3857')).toBe(false) // projected, despite being "web"
  })
})

describe('lonLatToCellUnits', () => {
  it('is the exact identity for a geographic cell', () => {
    // Bit-exact, not "within a tolerance": the geographic branch returns the inputs
    // unchanged rather than round-tripping them through proj4, so no cell shipping today
    // can move by a projection library's ulp.
    const [x, y] = lonLatToCellUnits('EPSG:4326', -75.7512345678, 37.9587654321)
    expect(x).toBe(-75.7512345678)
    expect(y).toBe(37.9587654321)
    expect(lonLatToCellUnits('EPSG:4979', 12.5, -8.25)).toEqual([12.5, -8.25])
  })

  it('projects to the cell’s own units for a projected cell', () => {
    // The real Chesapeake cell's SW cell centre, in UTM 18N metres.
    const originX = 420767.84475419234
    const originY = 4183856.856912584
    const [lon, lat] = proj4(resolveEPSG('EPSG:32618'), 'EPSG:4326', [originX, originY]) as [
      number,
      number,
    ]
    const [x, y] = lonLatToCellUnits('EPSG:32618', lon, lat)
    // Round-trip closes to well under a millimetre — far inside the cell's 16 m spacing.
    expect(Math.abs(x - originX)).toBeLessThan(1e-3)
    expect(Math.abs(y - originY)).toBeLessThan(1e-3)
  })

  it('refuses a CRS the registry cannot resolve rather than guessing', () => {
    expect(() => lonLatToCellUnits('EPSG:9999', 0, 0)).toThrow(/Unsupported EPSG code/)
  })
})

// A 4×3 grid with the real Chesapeake cell's geometry class (UTM 18N, 16 m), plus a
// geographic twin over the SAME cell values so the two paths can be compared directly.
const UTM_ORIGIN: [number, number] = [420767.84475419234, 4183856.856912584]
const SPACING: [number, number] = [16, 16]
const SIZE: [number, number] = [4, 3]
// North-up, row 0 = north. Cell (col=1, rowFromSouth=1) carries the nodata fill.
// prettier-ignore
const VALUES = new Float32Array([
  20, 21, 22, 23, // north row
  10, 1e6, 12, 13,
  0, 1, 2, 3, // south row
])

function handle(crs: number | null, origin: [number, number]): CoverageHandle {
  return coverageFromGrids({
    product: 's102',
    crs,
    origin,
    spacing: crs === null ? [0.001, 0.001] : SPACING,
    size: SIZE,
    bands: [{ name: 'depth', unit: 'metres', kind: 'f32', nodata: 1e6, values: VALUES }],
    vertical: { datumCode: 23, sign: 'down' },
  })
}

/** lon/lat of a cell CENTRE of the projected handle, via proj4 directly — an independent
 *  reference rather than the code under test inverted. */
function cellCentreLonLat(col: number, rowFromSouth: number): [number, number] {
  const x = UTM_ORIGIN[0] + col * SPACING[0]
  const y = UTM_ORIGIN[1] + rowFromSouth * SPACING[1]
  return proj4(resolveEPSG('EPSG:32618'), 'EPSG:4326', [x, y]) as [number, number]
}

describe('valueAtLonLat — a projected cell', () => {
  const cov = handle(32618, UTM_ORIGIN)

  it('reads the cell a metre query reads — this is the whole fix', () => {
    // The regression this locks: the SAME point, expressed as lon/lat, used to miss the
    // grid entirely (null). Every cell of the grid must agree with its metre-native read.
    for (let rowS = 0; rowS < SIZE[1]; rowS++) {
      for (let col = 0; col < SIZE[0]; col++) {
        const [lon, lat] = cellCentreLonLat(col, rowS)
        const native = cov.valueAt(UTM_ORIGIN[0] + col * 16, UTM_ORIGIN[1] + rowS * 16)
        const viaLonLat = valueAtLonLat(cov, lon, lat)
        if (Number.isNaN(native)) expect(viaLonLat).toBeNaN()
        else expect(viaLonLat).toBe(native)
      }
    }
  })

  it('a raw lon/lat still misses the grid — the bug is real, not hypothetical', () => {
    // Kept as a live witness: valueAt is unit-native BY DESIGN, so this is the behaviour
    // callers must route around, not something to "fix" inside the handle.
    const [lon, lat] = cellCentreLonLat(0, 0)
    expect(cov.valueAt(lon, lat)).toBeNull()
  })

  it('keeps valueAt’s null / NaN semantics through the transform', () => {
    expect(valueAtLonLat(cov, ...cellCentreLonLat(1, 1))).toBeNaN() // the 1e6 nodata cell
    expect(valueAtLonLat(cov, ...cellCentreLonLat(0, 0))).toBe(0) // SW cell, real value
    // A lon/lat well outside the ~64 m footprint projects to metres outside it too.
    const [lon, lat] = cellCentreLonLat(0, 0)
    expect(valueAtLonLat(cov, lon + 0.5, lat)).toBeNull()
    expect(valueAtLonLat(cov, lon, lat - 0.5)).toBeNull()
  })

  it('reads a named band the same way', () => {
    expect(valueAtLonLat(cov, ...cellCentreLonLat(3, 2), 'depth')).toBe(23)
  })
})

describe('valueAtLonLat — a geographic cell is unchanged', () => {
  it('agrees with valueAt cell-for-cell', () => {
    const geo = handle(null, [5, 50])
    for (let rowS = 0; rowS < SIZE[1]; rowS++) {
      for (let col = 0; col < SIZE[0]; col++) {
        const lon = 5 + col * 0.001
        const lat = 50 + rowS * 0.001
        const direct = geo.valueAt(lon, lat)
        const viaLonLat = valueAtLonLat(geo, lon, lat)
        if (Number.isNaN(direct)) expect(viaLonLat).toBeNaN()
        else expect(viaLonLat).toBe(direct)
      }
    }
  })
})
