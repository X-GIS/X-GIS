// ═══ Coverage sounding anchors — which grid cells get a numeral (#1366 INC-5) ═══
//
// A colour ramp cannot be read to a metre, and that is not how a chart is meant to be
// read: real charts print sounding NUMERALS, thinned by scale. This picks which cells of
// a gridded coverage get one.
//
// The selection walks a lattice in SCREEN space, not in grid space, and that is the whole
// design:
//
//   - the candidate count is bounded by the VIEWPORT (≈ (w/spacing)·(h/spacing) ≈ a few
//     hundred), never by the grid — a real NOAA S-102 cell is 1663×2090 = 3.5M cells, and
//     a grid-space walk would have to visit them all every frame just to decide;
//   - thinning by scale falls out for free, with no zoom→stride rule to tune;
//   - off-screen cells cost nothing: the unprojector rejects them before any grid work.
//
// What that actually yields across zoom, MEASURED on the synthetic 32×32 fixture
// (1000×800, dpr 3) rather than assumed — collision dropped none of them:
//
//   z1  z2  z3  z4  z5  z6  z7  |  z8  z9  z10  z12  z14  z16
//    0   1   2  24  68  96 109  |  35   9    9    1    1    1
//
// Two regimes, split where one grid cell reaches the lattice pitch (z≈7 here, cell ≈45 px):
//
//   - cells FINER than the pitch: a roughly CONSTANT on-screen density, one numeral per
//     ~SOUNDING_LATTICE_CSS_PX. That is the chart behaviour. The rise from z1 to z7 above
//     is the grid growing to fill the viewport, not the density changing.
//   - cells COARSER than the pitch: several lattice points fall in one cell and dedupe to
//     one numeral, so the count falls toward one per visible cell. Also correct — a gridded
//     product holds no more soundings than cells, and repeating one value would invent
//     detail it does not have.
//
// So it is NOT "denser as you zoom in" past that crossover; an earlier version of this
// comment claimed that, and the sweep above is what corrected it.
//
// Each sample is then SNAPPED to its cell centre, so a numeral sits on the sounding it
// reports rather than at an arbitrary screen point, and duplicates (several lattice points
// inside one cell, at high zoom) collapse to one label. The value comes from
// `handle.valueAt` — the exact readout authority, nearest-cell, never interpolated — so a
// label can only ever show a number that is actually in the grid.
//
// Fine decluttering is NOT done here: the label pass's collision system already drops
// overlapping text far better than a spacing heuristic could. This only decides candidates.
//
// VIEWPORT INSIDE ONE CELL — measured, and deliberately NOT engineered around. Zoom far
// enough and the whole viewport sits inside a single cell; the numeral still anchors at
// that cell's CENTRE, so once the centre leaves the screen the numeral goes with it. On the
// fixture (z13) panning 0.2 of a cell off the centre takes it from 1 label to 0.
//
// The obvious fix — clamp the anchor into the visible part of its cell — is not built,
// because the regime is out of reach for the data this serves. Web Mercator at the real
// Chesapeake cell (16 m cells, 37.95°N) puts the crossover at z≈18.7 and "one cell fills a
// 1000 px viewport" at z≈22.9, while `Camera.maxZoom` is hard-capped at 22. The fixture hits
// it at z13 only because its synthetic cells are ~16 KM — a thousand times coarser than a
// real survey. So this is a fixture artifact, not a product behaviour, and clamping would be
// speculative complexity on the frame path. Recorded with the numbers so a future cell size
// (or a raised max zoom) can re-open it on evidence rather than on memory.
//
// KNOWN GAP — UNTILTED AZIMUTHAL DISCS ONLY. The globe and TILTED azimuthal (projType 7,
// globeMode) now invert via `soundingUnprojector` (dispatch-coverage-soundings.ts), the same
// ray↔sphere authority the pointer path uses. What remains out of reach is the untilted disc
// set at pitch 0 (projTypes 3/4/5, globeMode false) — no flat-disc inverse exists anywhere in
// the codebase yet (same scope `interaction-controller.ts` `clientToLngLat` leaves unsupported
// for #9), so the lattice still finds nothing there and no numerals draw. The alternative — a
// second, grid-space selection path for those projections — would be a second authority for
// "which cell gets a numeral", which is exactly the divergence this codebase keeps paying for.
// So this remaining gap is left OPEN and visible rather than papered over with a path that
// would silently disagree with this one.

import { cellUnitsToLonLat, lonLatToCellUnits, type CoverageHandle } from '@xgis/data'

/** One cell selected for a numeral: where it is, and every band's value there. */
export interface SoundingAnchor {
  lon: number
  lat: number
  /** Cell column / row-from-SOUTH — the stable identity a label's collision id is built
   *  from, so a numeral fades rather than pops as the camera moves. */
  col: number
  rowFromSouth: number
  /** Every band's value at this cell, keyed by band NAME — the property bag a label
   *  expression reads (`label-[round(.depth)]`). Uniform with a feature's properties. */
  values: Record<string, number>
}

/** Screen-space lattice pitch (CSS px) for sounding candidates. Chart-like density: dense
 *  enough to read the seabed's shape, sparse enough that collision has room to place a
 *  numeral rather than dropping most of them. */
export const SOUNDING_LATTICE_CSS_PX = 56

/** Backstop on candidates per frame. The lattice already bounds this by viewport area
 *  (a 4K screen at 56 px ≈ 2.4k), so this only catches a degenerate spacing. */
export const SOUNDING_MAX_CANDIDATES = 4096

export interface SoundingAnchorOptions {
  /** Canvas size in the same (physical) pixel space `unproject` takes. */
  width: number
  height: number
  /** Lattice pitch in that same pixel space. */
  spacingPx: number
  max?: number
}

/** Cells of `handle` that should carry a numeral for the current camera.
 *
 *  `unproject` maps a canvas pixel to lon/lat, returning null when the ray misses the
 *  surface (off a globe, past the horizon) — injected rather than reached for so this stays
 *  a pure function the tests can drive without a camera or a GPU.
 *
 *  A cell whose FIRST band is nodata is skipped: for S-102 that is land, and a chart prints
 *  no sounding there. Band 0 is the primary band by the same convention `valueAt` uses. */
export function coverageSoundingAnchors(
  handle: CoverageHandle,
  unproject: (px: number, py: number) => [number, number] | null,
  opts: SoundingAnchorOptions,
): SoundingAnchor[] {
  const { crs, origin, spacing, size } = handle.header
  const [nLon, nLat] = size
  const [originX, originY] = origin
  const [dx, dy] = spacing
  if (!(opts.spacingPx > 0) || nLon < 1 || nLat < 1) return []
  const max = opts.max ?? SOUNDING_MAX_CANDIDATES

  // What the camera can see, in CELL indices. Probed with the same unprojector, but only to
  // bound the walk — the cells chosen inside these bounds do not depend on where the probes
  // landed, which is the whole difference from the screen-anchored version.
  const view = visibleCellRange(handle, unproject, opts)
  if (!view) return []

  // One stride for both axes, so the pattern stays square on screen and a rotation cannot
  // swap which axis is coarser. Quantised to a POWER OF TWO: any continuous stride would
  // change on every zoom delta, and each change re-picks every cell.
  const stride = quantiseStride(opts.spacingPx / view.pxPerCell)

  const out: SoundingAnchor[] = []
  // Anchored on cell 0, NOT on the visible range: a phase tied to the view would slide the
  // whole pattern as the camera moves, which is the churn this design exists to remove.
  const first = (lo: number): number => Math.ceil(lo / stride) * stride
  for (let rowFromSouth = first(view.rowLo); rowFromSouth <= view.rowHi; rowFromSouth += stride) {
    for (let col = first(view.colLo); col <= view.colHi; col += stride) {
      if (out.length >= max) return out
      // Cell CENTRE — the numeral marks the sounding it reports, and `valueAt` is
      // unit-native, so these are already the grid's own units.
      const cx = originX + col * dx
      const cy = originY + rowFromSouth * dy
      const primary = handle.valueAt(cx, cy)
      if (primary === null || Number.isNaN(primary)) continue
      const values: Record<string, number> = {}
      for (const band of handle.bands) {
        const v = handle.valueAt(cx, cy, band.header.name)
        if (v !== null) values[band.header.name] = v
      }
      const [lon, lat] = cellUnitsToLonLat(crs, cx, cy)
      out.push({ lon, lat, col, rowFromSouth, values })
    }
  }
  return out
}

/** Round a desired stride to a power of two, ≥ 1.
 *
 *  The quantisation is the point, not tidiness. A stride that tracked zoom continuously would
 *  take a new value on every wheel delta, and since the chosen cells are `col % stride === 0`,
 *  every change re-picks the ENTIRE set — the numerals would boil during a zoom. Powers of two
 *  change rarely, and when they do, half the previous cells SURVIVE (every second one), so the
 *  transition reads as thinning rather than as a new pattern. */
function quantiseStride(want: number): number {
  if (!Number.isFinite(want) || want <= 1) return 1
  return 2 ** Math.round(Math.log2(want))
}

/** The cell-index rectangle the camera can see, plus how many pixels one cell spans.
 *
 *  Probes a small screen lattice rather than the four corners alone: under pitch or on a
 *  globe the corners are exactly where the ray misses the surface, and four nulls would read
 *  as "nothing visible" while the middle of the screen is full of grid. Returns null when no
 *  probe lands on the surface at all. */
function visibleCellRange(
  handle: CoverageHandle,
  unproject: (px: number, py: number) => [number, number] | null,
  opts: SoundingAnchorOptions,
): { colLo: number; colHi: number; rowLo: number; rowHi: number; pxPerCell: number } | null {
  const { crs, origin, spacing, size } = handle.header
  const [nLon, nLat] = size
  const [originX, originY] = origin
  const [dx, dy] = spacing
  let colLo = Infinity
  let colHi = -Infinity
  let rowLo = Infinity
  let rowHi = -Infinity
  const PROBES = 8
  for (let iy = 0; iy <= PROBES; iy++) {
    for (let ix = 0; ix <= PROBES; ix++) {
      const lonLat = unproject((ix / PROBES) * opts.width, (iy / PROBES) * opts.height)
      if (!lonLat) continue
      const [x, y] = lonLatToCellUnits(crs, lonLat[0], lonLat[1])
      const col = (x - originX) / dx
      const row = (y - originY) / dy
      if (col < colLo) colLo = col
      if (col > colHi) colHi = col
      if (row < rowLo) rowLo = row
      if (row > rowHi) rowHi = row
    }
  }
  if (!Number.isFinite(colLo)) return null
  // Clamp to the grid, and widen by one cell so a numeral whose centre sits just outside the
  // probed hull still enters the walk (it is the collision pass's job to drop it, not this).
  const cLo = Math.max(0, Math.floor(colLo) - 1)
  const cHi = Math.min(nLon - 1, Math.ceil(colHi) + 1)
  const rLo = Math.max(0, Math.floor(rowLo) - 1)
  const rHi = Math.min(nLat - 1, Math.ceil(rowHi) + 1)
  if (cLo > cHi || rLo > rHi) return null
  const pxPerCell = localPxPerCell(handle, unproject, opts)
  if (pxPerCell === null) return null
  return { colLo: cLo, colHi: cHi, rowLo: rLo, rowHi: rHi, pxPerCell }
}

/** Pixels per grid cell, measured LOCALLY at the screen centre.
 *
 *  Deliberately not derived from the visible range: the axis-aligned hull of a ROTATED
 *  viewport is up to √2 larger than the viewport itself, so a hull-based scale reads a
 *  rotation as a zoom-out and can flip the stride — numerals thinning by half purely because
 *  the user turned the map. A local finite difference is rotation-invariant by construction,
 *  because a rotation preserves distance. */
function localPxPerCell(
  handle: CoverageHandle,
  unproject: (px: number, py: number) => [number, number] | null,
  opts: SoundingAnchorOptions,
): number | null {
  const { crs, origin, spacing } = handle.header
  const [originX, originY] = origin
  const [dx, dy] = spacing
  const D = Math.max(8, Math.min(opts.width, opts.height) / 8)
  const midX = opts.width / 2
  const midY = opts.height / 2
  const at = (px: number, py: number): [number, number] | null => {
    const lonLat = unproject(px, py)
    if (!lonLat) return null
    const [x, y] = lonLatToCellUnits(crs, lonLat[0], lonLat[1])
    return [(x - originX) / dx, (y - originY) / dy]
  }
  // Probe both axes and take the LARGER cell-space step: under pitch the two differ (the
  // far side of the screen covers more ground), and the smaller one would make the stride
  // too fine for the far field, which is where crowding actually happens.
  const c = at(midX, midY)
  const ex = at(midX + D, midY)
  const ey = at(midX, midY + D)
  if (!c) return null
  let cells = 0
  if (ex) cells = Math.max(cells, Math.hypot(ex[0] - c[0], ex[1] - c[1]))
  if (ey) cells = Math.max(cells, Math.hypot(ey[0] - c[0], ey[1] - c[1]))
  if (!(cells > 0)) return null
  return D / cells
}
