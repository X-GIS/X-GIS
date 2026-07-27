// ═══ Sounding-anchor selection (#1366 INC-5) ═══
//
// The claims this gates, in order of what breaks if they rot:
//
//   1. The candidate count is bounded by the VIEWPORT, not the grid. A real NOAA cell is
//      3.5M cells; a selection that scaled with the grid would cost a frame.
//   2. A numeral sits on the CELL it reports, and shows that cell's own value. A label
//      that drifts to a lattice point, or shows an interpolated number, is a wrong
//      sounding — worse than no sounding.
//   3. The grid is walked through its own CRS. A UTM cell's lon/lat is not
//      `origin + col·spacing`, and getting that wrong puts numerals on another continent.
//   4. nodata is skipped: no numeral over land.

import { describe, it, expect } from 'vitest'
import { coverageFromGrids, type CoverageHandle } from '@xgis/data'
import proj4 from 'proj4'
import { resolveEPSG } from '@xgis/data'
import { coverageSoundingAnchors } from './coverage-sounding-anchors'

const SIZE: [number, number] = [8, 6]

/** Depth = col + 10·rowFromSouth, so every cell's value identifies the cell it came from.
 *  Cell (col 2, rowFromSouth 1) is nodata. Stored NORTH-UP (row 0 = north). */
function values(): Float32Array {
  const v = new Float32Array(SIZE[0] * SIZE[1])
  for (let rowS = 0; rowS < SIZE[1]; rowS++) {
    for (let col = 0; col < SIZE[0]; col++) {
      const idx = (SIZE[1] - 1 - rowS) * SIZE[0] + col
      v[idx] = col === 2 && rowS === 1 ? 1e6 : col + 10 * rowS
    }
  }
  return v
}

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
    size: SIZE,
    bands: [{ name: 'depth', unit: 'metres', kind: 'f32', nodata: 1e6, values: values() }],
    vertical: { datumCode: 23, sign: 'down' },
  })
}

const GEO_ORIGIN: [number, number] = [5, 50]
// 2^-4 — an EXACT binary fraction on purpose. With 0.01 the round-trip
// `origin + k·spacing → (lon − origin)/spacing` lands on 0.4999999999999946, so
// `Math.round` picks the neighbouring cell and a lattice sweep silently skips cells. That
// made an earlier version of the nodata gate below vacuous: it asserted a cell's absence
// that the sweep never sampled in the first place.
const GEO_SPACING: [number, number] = [0.0625, 0.0625]
const geo = handle(null, GEO_ORIGIN, GEO_SPACING)

/** A viewport mapping 20 px to one cell, with the lattice landing exactly on cell CENTRES:
 *  pixel (10,10) is the SW cell, +y goes NORTH. Deliberately trivial — the projection is
 *  not what is under test; what is, is that every cell of the 8×6 grid gets sampled once. */
const cellUnproject = (px: number, py: number): [number, number] => [
  GEO_ORIGIN[0] + (px / 20 - 0.5) * GEO_SPACING[0],
  GEO_ORIGIN[1] + (py / 20 - 0.5) * GEO_SPACING[1],
]

/** The same sweep shifted a QUARTER cell off centre — still inside the same cells, but no
 *  longer at their centres, so an anchor that failed to snap would be visibly off. */
const offsetUnproject = (px: number, py: number): [number, number] => [
  GEO_ORIGIN[0] + (px / 20 - 0.25) * GEO_SPACING[0],
  GEO_ORIGIN[1] + (py / 20 - 0.25) * GEO_SPACING[1],
]

describe('coverageSoundingAnchors — the value is the cell’s own', () => {
  it('snaps each anchor to its cell centre and reports that cell’s value', () => {
    // Sampled a QUARTER cell off centre, so "the anchor is the cell centre" is a real
    // assertion rather than one the fixture satisfies for free.
    const anchors = coverageSoundingAnchors(geo, offsetUnproject, {
      width: 160,
      height: 120,
      spacingPx: 20,
    })
    expect(anchors.length).toBeGreaterThan(0)
    for (const a of anchors) {
      // The anchor IS the cell centre, exactly — not the lattice point that found it.
      expect(a.lon).toBeCloseTo(GEO_ORIGIN[0] + a.col * GEO_SPACING[0], 12)
      expect(a.lat).toBeCloseTo(GEO_ORIGIN[1] + a.rowFromSouth * GEO_SPACING[1], 12)
      // …and the value is that cell's, by the col/row encoding above.
      expect(a.values['depth']).toBe(a.col + 10 * a.rowFromSouth)
    }
  })

  it('skips nodata — no numeral over land', () => {
    const anchors = coverageSoundingAnchors(geo, cellUnproject, {
      width: 160,
      height: 120,
      spacingPx: 20,
    })
    expect(anchors.some((a) => a.col === 2 && a.rowFromSouth === 1)).toBe(false)
    // …while its neighbours are present, so this is a per-cell skip, not a dropped row.
    expect(anchors.some((a) => a.col === 1 && a.rowFromSouth === 1)).toBe(true)
    expect(anchors.some((a) => a.col === 3 && a.rowFromSouth === 1)).toBe(true)
  })

  it('emits one anchor per cell however many lattice points land inside it', () => {
    // Zoomed in: 5 lattice points per cell across, so a naive walk would emit ~25 labels
    // stacked on one cell. Dedupe by cell identity is what keeps a numeral single.
    const dense = coverageSoundingAnchors(geo, cellUnproject, {
      width: 160,
      height: 120,
      spacingPx: 4,
    })
    const keys = new Set(dense.map((a) => `${a.col},${a.rowFromSouth}`))
    expect(keys.size).toBe(dense.length)
  })

  it('drops samples that miss the surface, and samples outside the grid', () => {
    const off = coverageSoundingAnchors(geo, () => null, {
      width: 160,
      height: 120,
      spacingPx: 20,
    })
    expect(off).toEqual([])
    // A viewport parked far off the grid's footprint yields nothing — the grid is not
    // clamped onto the nearest edge cell.
    const away = coverageSoundingAnchors(geo, (px) => [GEO_ORIGIN[0] + 40 + px / 20, 50], {
      width: 160,
      height: 120,
      spacingPx: 20,
    })
    expect(away).toEqual([])
  })
})

describe('coverageSoundingAnchors — bounded by the viewport, not the grid', () => {
  it('costs the same on a 3.5M-cell grid as on a 48-cell one', () => {
    // The load-bearing claim: a real NOAA S-102 cell (1663×2090) must not make selection
    // more expensive. Same viewport, same lattice ⇒ the same candidate count.
    const big = coverageFromGrids({
      product: 's102',
      crs: null,
      origin: GEO_ORIGIN,
      spacing: [1e-4, 1e-4],
      size: [1663, 2090],
      bands: [
        {
          name: 'depth',
          unit: 'metres',
          kind: 'f32',
          nodata: 1e6,
          values: new Float32Array(1663 * 2090).fill(7),
        },
      ],
      vertical: { datumCode: 23, sign: 'down' },
    })
    const anchors = coverageSoundingAnchors(
      big,
      (px, py) => [GEO_ORIGIN[0] + px * 1e-4, GEO_ORIGIN[1] + py * 1e-4],
      { width: 800, height: 600, spacingPx: 56 },
    )
    // The lattice starts half a step in and steps 56: floor((800−28)/56)+1 = 14 across,
    // floor((600−28)/56)+1 = 11 down. Every point is inside the grid, so all 154 land.
    expect(anchors.length).toBe(14 * 11)
    expect(anchors.every((a) => a.values['depth'] === 7)).toBe(true)
  })

  it('honours the candidate backstop', () => {
    const capped = coverageSoundingAnchors(geo, cellUnproject, {
      width: 160,
      height: 120,
      spacingPx: 4,
      max: 7,
    })
    expect(capped.length).toBe(7)
  })
})

describe('coverageSoundingAnchors — a PROJECTED cell walks its own CRS', () => {
  // The real Chesapeake cell's geometry class: UTM 18N, metre origin and spacing.
  const UTM_ORIGIN: [number, number] = [420767.84475419234, 4183856.856912584]
  const utm = handle(32618, UTM_ORIGIN, [16, 16])
  const toLonLat = (x: number, y: number): [number, number] =>
    proj4(resolveEPSG('EPSG:32618'), 'EPSG:4326', [x, y]) as [number, number]

  it('places a numeral at the cell’s true lon/lat, not at origin + col·spacing', () => {
    // Sweep the lattice across the cell in UTM, handing back the lon/lat of each point —
    // what a real camera over this cell would unproject to.
    const anchors = coverageSoundingAnchors(
      utm,
      (px, py) => toLonLat(UTM_ORIGIN[0] + px * 2, UTM_ORIGIN[1] + py * 2),
      { width: 64, height: 48, spacingPx: 8 },
    )
    expect(anchors.length).toBeGreaterThan(0)
    for (const a of anchors) {
      const [lon, lat] = toLonLat(UTM_ORIGIN[0] + a.col * 16, UTM_ORIGIN[1] + a.rowFromSouth * 16)
      expect(a.lon).toBeCloseTo(lon, 9)
      expect(a.lat).toBeCloseTo(lat, 9)
      expect(a.values['depth']).toBe(a.col + 10 * a.rowFromSouth)
    }
    // Fail-before witness: the "obvious" degrees derivation would put this cell in the
    // middle of the Indian Ocean, ~420 768° east. The gate above is what rejects it.
    expect(anchors[0]!.lon).toBeLessThan(0)
    expect(Math.abs(anchors[0]!.lon - UTM_ORIGIN[0])).toBeGreaterThan(1000)
  })
})
