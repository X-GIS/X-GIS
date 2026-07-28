// ═══ coverage format gates — coverageFromGrids + CoverageHandle + south-flip ═══
//
// Post-ADR-0010: there is no `.xgcov` wire format. A reader yields grids;
// `coverageFromGrids` builds the CoverageHandle the renderer + `valueAt` consume,
// with no encode/decode. These gates pin: the grids→handle mapping (values, nodata
// →NaN, min/max over valid cells, loud cell-count mismatch); the value-readout
// authority (`valueAt` nearest-cell, OOB null, nodata NaN, positive-down verbatim,
// the asymmetric-grid index math); and the ONE orientation normalize
// (`southFirstToNorthUp`), with a fail-before assertion proving the flip matters.

import { describe, it, expect } from 'vitest'
import { coverageFromGrids, southFirstToNorthUp, type CoverageInput } from './format'

const FILL = 1e6
// Asymmetric 3×2 grid, NORTH-UP (row 0 = north): distinct per cell so a transpose
// or a flip bug is caught; SE cell (south row, last col) is nodata.
const N_LON = 3
const N_LAT = 2
const DEPTH_NORTH_UP = new Float32Array([20, 21, 22, /* south */ 10, 11, FILL])

function baseInput(): CoverageInput {
  return {
    product: 's102',
    origin: [5, 50], // SW cell CENTRE
    spacing: [2, 1],
    size: [N_LON, N_LAT],
    bands: [
      { name: 'depth', unit: 'metres', kind: 'f32', nodata: FILL, values: DEPTH_NORTH_UP.slice() },
    ],
    vertical: { datumCode: 23, sign: 'down' },
  }
}

describe('coverageFromGrids — grids → CoverageHandle (ADR-0010)', () => {
  it('carries geometry + product + vertical, maps nodata → NaN, min/max over valid cells', () => {
    const h = coverageFromGrids(baseInput())
    expect(h.header.size).toEqual([3, 2])
    expect(h.header.origin).toEqual([5, 50])
    expect(h.header.spacing).toEqual([2, 1])
    expect(h.header.product).toBe('s102')
    expect(h.header.registration).toBe('point')
    expect(h.meta.vertical).toEqual({ datumCode: 23, sign: 'down' })

    const b = h.band('depth')
    // north-up values verbatim, the nodata fill → NaN
    expect([...b.values.slice(0, 5)]).toEqual([20, 21, 22, 10, 11])
    expect(Number.isNaN(b.values[5]!)).toBe(true)
    // min/max skip the nodata cell
    expect(b.header.min).toBe(10)
    expect(b.header.max).toBe(22)
    // in-memory handle is f32 — no quantization codes
    expect(b.codes).toBeUndefined()
  })

  it('maps a source fill AND a pre-existing NaN to NaN; min/max skip both', () => {
    const input = baseInput()
    input.bands[0]!.values = new Float32Array([20, NaN, 22, 10, FILL, 12])
    const b = coverageFromGrids(input).band('depth')
    expect(Number.isNaN(b.values[1]!)).toBe(true) // pre-existing NaN
    expect(Number.isNaN(b.values[4]!)).toBe(true) // source fill
    expect(b.header.min).toBe(10)
    expect(b.header.max).toBe(22)
  })

  it('a wrong cell count fails loudly (never a silent short grid)', () => {
    const input = baseInput()
    input.bands[0]!.values = new Float32Array([1, 2, 3]) // 3 ≠ 6
    expect(() => coverageFromGrids(input)).toThrow(/band "depth" has 3 cells, expected 6/)
  })
})

describe('CoverageHandle.valueAt — the value-readout authority', () => {
  it('nearest-cell, OOB null, nodata NaN, positive-down verbatim', () => {
    const h = coverageFromGrids(baseInput())
    // cells: lon ∈ {5,7,9}, lat ∈ {50 (south), 51 (north)}
    expect(h.valueAt(5, 51, 'depth')).toBe(20) // NW
    expect(h.valueAt(9, 51, 'depth')).toBe(22) // NE
    expect(h.valueAt(5, 50, 'depth')).toBe(10) // SW — a depth of 10 stays +10 (positive-down)
    expect(Number.isNaN(h.valueAt(9, 50, 'depth')!)).toBe(true) // SE nodata
    expect(h.valueAt(200, 200, 'depth')).toBeNull() // out of bounds
  })

  it('nearest-cell rounding: ±0.49 cell offsets snap to the cell centre', () => {
    const h = coverageFromGrids(baseInput())
    expect(h.valueAt(5.4, 51, 'depth')).toBe(20) // → lon 5
    expect(h.valueAt(6.6, 51, 'depth')).toBe(21) // → lon 7
    expect(h.valueAt(5, 50.4, 'depth')).toBe(10) // → lat 50
    expect(h.valueAt(5, 50.6, 'depth')).toBe(20) // → lat 51
  })
})

// ─── the handle carries the cell's REAL CRS (#1366 INC-2) ────────────────────
// `crs` used to be pinned to the literal 'EPSG:4326'. Real S-100 cells are frequently
// projected (a NOAA S-102 cell declares 32618 — UTM 18N, a metre grid), so a handle
// that always claims 4326 is a handle that lies about where its numbers live.
describe('coverageFromGrids — horizontal CRS', () => {
  it('defaults to EPSG:4326 when the cell declares none — the S-111 path, unchanged', () => {
    // Load-bearing back-compat: real NOAA S-111 cells omit horizontalCRS entirely and
    // have always been read as geographic. Omitted and explicit-null must both land on
    // exactly the string the header carried before this change.
    expect(coverageFromGrids(baseInput()).header.crs).toBe('EPSG:4326')
    expect(coverageFromGrids({ ...baseInput(), crs: null }).header.crs).toBe('EPSG:4326')
    expect(coverageFromGrids({ ...baseInput(), crs: 4326 }).header.crs).toBe('EPSG:4326')
  })

  it('carries a projected code through verbatim', () => {
    // The reader refuses to BUILD one of these from a real cell today
    // (assertGeographicCRS) — placing a projected grid is INC-3. This gate is at the
    // seam below that refusal, pinning that the code survives the grids→handle step.
    expect(coverageFromGrids({ ...baseInput(), crs: 32618 }).header.crs).toBe('EPSG:32618')
    expect(coverageFromGrids({ ...baseInput(), crs: 5179 }).header.crs).toBe('EPSG:5179')
  })

  it('rejects a non-integer CRS loudly instead of falling back to 4326', () => {
    // A silent fallback would relabel a projected grid as geographic — the exact
    // mis-render this field exists to prevent.
    expect(() => coverageFromGrids({ ...baseInput(), crs: 4326.5 })).toThrow(/positive EPSG/)
    expect(() => coverageFromGrids({ ...baseInput(), crs: -1 })).toThrow(/positive EPSG/)
    expect(() => coverageFromGrids({ ...baseInput(), crs: 0 })).toThrow(/positive EPSG/)
  })

  it('changes nothing else about the handle', () => {
    // The whole header, minus crs, must be identical whichever CRS was supplied —
    // this field must not perturb geometry, bands or the vertical datum.
    const geographic = coverageFromGrids(baseInput()).header
    const projected = coverageFromGrids({ ...baseInput(), crs: 32618 }).header
    const { crs: _a, ...restGeo } = geographic
    const { crs: _b, ...restProj } = projected
    expect(restProj).toEqual(restGeo)
  })
})

describe('southFirstToNorthUp — the ONE orientation normalize', () => {
  // The reader stores south-row-first (row 0 = grid origin = south); the handle is
  // north-up. This is the flip readCoverageFromHdf5 applies.
  const SOUTH_FIRST = new Float32Array([10, 11, FILL, /* north */ 20, 21, 22])

  it('flips the asymmetric grid (row 0 becomes north)', () => {
    const nu = southFirstToNorthUp(SOUTH_FIRST, N_LON, N_LAT)
    expect([...nu]).toEqual([...DEPTH_NORTH_UP])
  })

  it('FAIL-BEFORE: the SAME assertion on the UNFLIPPED grid fails (proves the flip matters)', () => {
    expect([...SOUTH_FIRST]).not.toEqual([...DEPTH_NORTH_UP])
  })

  it('a handle built from the flipped grid reads the correct geographic cell', () => {
    const input = baseInput()
    input.bands[0]!.values = southFirstToNorthUp(SOUTH_FIRST, N_LON, N_LAT)
    const h = coverageFromGrids(input)
    expect(h.valueAt(5, 51, 'depth')).toBe(20) // north row, col 0
    expect(h.valueAt(5, 50, 'depth')).toBe(10) // south row, col 0
  })
})
