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
  /** A grid of `n × n` cells at `spacing`, filled with 7 — geometry is what matters here. */
  const gridOf = (n: number, spacing: number) =>
    coverageFromGrids({
      product: 's102',
      crs: null,
      origin: GEO_ORIGIN,
      spacing: [spacing, spacing],
      size: [n, n],
      bands: [
        {
          name: 'depth',
          unit: 'metres',
          kind: 'f32',
          nodata: 1e6,
          values: new Float32Array(n * n).fill(7),
        },
      ],
      vertical: { datumCode: 23, sign: 'down' },
    })

  it('costs the same on a 2000²-cell grid as on a 100²-cell one', () => {
    // The load-bearing claim: a real NOAA S-102 cell (1663×2090) must not make selection more
    // expensive. Asserted as the CLAIM — two grids of wildly different size, same cell size,
    // same viewport, must yield the same count — rather than as a magic number, which is what
    // the previous version pinned and which said nothing about grid-independence.
    const view = { width: 800, height: 600, spacingPx: 56 }
    const unproject = (px: number, py: number): [number, number] => [
      GEO_ORIGIN[0] + px * 1e-4,
      GEO_ORIGIN[1] + py * 1e-4,
    ]
    // BOTH grids must fully contain the viewport, or the comparison measures how much grid
    // is on screen rather than grid-independence — 100² cells at this scale covers an eighth
    // of the view, which is what an earlier version of this test actually compared.
    const small = coverageSoundingAnchors(gridOf(1000, 1e-4), unproject, view)
    const big = coverageSoundingAnchors(gridOf(3000, 1e-4), unproject, view)
    expect(big.length).toBe(small.length)
    expect(big.length).toBeGreaterThan(0)
    expect(big.every((a) => a.values['depth'] === 7)).toBe(true)
  })

  it('holds a chart-like on-screen density — one numeral per ~lattice pitch', () => {
    // The stride is chosen from px-per-cell, so the count should track the viewport's area in
    // lattice steps, not the grid. Bounds are loose because the stride is quantised to powers
    // of two; the point is the ORDER, and that it is neither 4 numerals nor 4000.
    const anchors = coverageSoundingAnchors(
      gridOf(2000, 1e-4),
      (px, py) => [GEO_ORIGIN[0] + px * 1e-4, GEO_ORIGIN[1] + py * 1e-4],
      { width: 800, height: 600, spacingPx: 56 },
    )
    const steps = (800 / 56) * (600 / 56) // ≈ 153
    expect(anchors.length).toBeGreaterThan(steps / 4)
    expect(anchors.length).toBeLessThan(steps * 4)
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

describe('coverageSoundingAnchors — the CELL SET is stable under camera motion', () => {
  // THE REGRESSION THIS FILE EXISTS FOR, after the fact. The first version anchored its
  // lattice to the SCREEN, so the map moved under it and every frame of a rotate picked a
  // DIFFERENT set of cells — measured at 41% of the set churning per frame at 1°/frame, which
  // on screen is numerals flickering in and out. Rotation is the sharp case because the label
  // pass compares bearing/pitch EXACTLY (only zoom gets a tolerance), so every frame of a
  // rotate is a full re-dispatch.
  //
  // Anchoring the lattice to the GRID — cells at `col % stride === 0`, stride quantised to a
  // power of two — makes the chosen set a function of scale and visible range alone. Rotation
  // and pitch change neither.

  const N = 64
  const ORIGIN: [number, number] = [5, 50]
  const SP = 0.0625
  const grid = coverageFromGrids({
    product: 's102',
    crs: null,
    origin: ORIGIN,
    spacing: [SP, SP],
    size: [N, N],
    bands: [
      {
        name: 'depth',
        unit: 'metres',
        kind: 'f32',
        nodata: 1e6,
        values: Float32Array.from({ length: N * N }, (_, i) => (i % 40) + 1),
      },
    ],
    vertical: { datumCode: 23, sign: 'down' },
  })

  const W = 1000
  const H = 800
  const VIEW = { width: W, height: H, spacingPx: 168 }
  const DEG_PER_PX = SP / 20
  const cx = ORIGIN[0] + (N / 2) * SP
  const cy = ORIGIN[1] + (N / 2) * SP

  /** A flat camera: rotate the screen offset by −bearing, then scale to degrees. */
  const cameraAt =
    (bearingDeg: number, panPx = 0, degPerPx = DEG_PER_PX) =>
    (px: number, py: number): [number, number] => {
      const t = (-bearingDeg * Math.PI) / 180
      const dx = px - W / 2 + panPx
      const dy = py - H / 2
      return [
        cx + (dx * Math.cos(t) - dy * Math.sin(t)) * degPerPx,
        cy - (dx * Math.sin(t) + dy * Math.cos(t)) * degPerPx,
      ]
    }

  const cellsAt = (bearing: number, pan = 0, degPerPx = DEG_PER_PX): Set<string> =>
    new Set(
      coverageSoundingAnchors(grid, cameraAt(bearing, pan, degPerPx), VIEW).map(
        (a) => `${a.col},${a.rowFromSouth}`,
      ),
    )

  it('ROTATION does not move the lattice — same stride, same phase, no re-picking', () => {
    // Rotation DOES change which cells are in view (a rotated viewport covers a different
    // rectangle of the grid), so set equality is the wrong claim and an earlier version of
    // this test asserted it and failed. What must hold is that the LATTICE itself is
    // bearing-independent: one stride, phase anchored on cell 0, so a cell either stays
    // chosen or leaves the view — it is never re-picked at a different position.
    const base = cellsAt(0)
    expect(base.size).toBeGreaterThan(4)
    const strideOf = (cells: Set<string>): number => {
      const cols = [...cells].map((k) => Number(k.split(',')[0])).sort((a, b) => a - b)
      const gaps = cols
        .slice(1)
        .map((c, i) => c - cols[i]!)
        .filter((g) => g > 0)
      return Math.min(...gaps)
    }
    const stride = strideOf(base)
    for (const bearing of [0.5, 1, 2, 5, 10, 45, 90, 180]) {
      const cur = cellsAt(bearing)
      const why = `bearing ${bearing}°`
      // Same lattice: every chosen cell sits on a multiple of the SAME stride.
      expect(strideOf(cur), why).toBe(stride)
      for (const k of cur) {
        const [c, r] = k.split(',').map(Number)
        expect(c! % stride, `${why} col phase`).toBe(0)
        expect(r! % stride, `${why} row phase`).toBe(0)
      }
      // …and the interior survives: a rotation exchanges edge cells, not the whole set.
      const shared = [...base].filter((k) => cur.has(k)).length
      expect(shared / base.size, `${why} interior kept`).toBeGreaterThan(0.5)
    }
  })

  it('PANNING by whole pixels does not re-pick the cells it still shows', () => {
    // Cells leave and enter at the EDGES as the view moves — that is correct and
    // unavoidable. What must not happen is the interior re-picking, so the assertion is on
    // the cells that stay visible, not on set equality.
    const base = cellsAt(0, 0)
    for (const pan of [1, 2, 4, 8, 16]) {
      const moved = cellsAt(0, pan)
      const stayed = [...base].filter((k) => moved.has(k))
      // A few-pixel pan cannot push more than an edge's worth out of view.
      expect(stayed.length / base.size, `pan ${pan}px`).toBeGreaterThan(0.7)
    }
  })

  it('ZOOM thins by HALVES — a stride change keeps every second cell, not none', () => {
    // The stride is a power of two precisely so a change is a thinning. If it tracked scale
    // continuously, every wheel delta would re-pick the entire set and the numerals would
    // boil during a zoom — a slower version of the rotation bug.
    //
    // Compared only over the cells VISIBLE IN BOTH views: zooming in also shrinks the visible
    // range, and counting that as churn measures the window, not the lattice (which is what
    // an earlier version of this test did, and it failed for that reason).
    const coarse = cellsAt(0, 0, DEG_PER_PX)
    const fine = cellsAt(0, 0, DEG_PER_PX / 2) // one doubling in
    const fineCols = [...fine].map((k) => Number(k.split(',')[0]))
    const fineRows = [...fine].map((k) => Number(k.split(',')[1]))
    const inFineView = (k: string): boolean => {
      const [c, r] = k.split(',').map(Number)
      return (
        c! >= Math.min(...fineCols) &&
        c! <= Math.max(...fineCols) &&
        r! >= Math.min(...fineRows) &&
        r! <= Math.max(...fineRows)
      )
    }
    const candidates = [...coarse].filter(inFineView)
    expect(candidates.length).toBeGreaterThan(0)
    const survivors = candidates.filter((k) => fine.has(k))
    expect(survivors.length / candidates.length).toBe(1)
  })
})
