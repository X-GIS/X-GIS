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
//   - "thinned by zoom" falls out for free: the lattice is fixed in pixels, so zooming in
//     resolves more cells and zooming out fewer, with no zoom→stride rule to tune;
//   - off-screen cells cost nothing: the unprojector rejects them before any grid work.
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
// KNOWN GAP — GLOBE. `Camera.unprojectToLonLat` returns null for the globe and the
// azimuthal discs (projTypes 3/4/5/7), so the lattice finds nothing there and no numerals
// draw. The alternative — a second, grid-space selection path for those projections —
// would be a second authority for "which cell gets a numeral", which is exactly the
// divergence this codebase keeps paying for. So the gap is left OPEN and visible rather
// than papered over with a path that would silently disagree with this one.

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
  const step = opts.spacingPx
  if (!(step > 0) || nLon < 1 || nLat < 1) return []
  const max = opts.max ?? SOUNDING_MAX_CANDIDATES

  const out: SoundingAnchor[] = []
  const seen = new Set<number>()
  // Half-step inset so the lattice is centred in the viewport rather than hugging its
  // top-left corner — the labels then sit symmetrically as the camera pans.
  for (let py = step / 2; py < opts.height; py += step) {
    for (let px = step / 2; px < opts.width; px += step) {
      if (out.length >= max) return out
      const lonLat = unproject(px, py)
      if (!lonLat) continue
      const [x, y] = lonLatToCellUnits(crs, lonLat[0], lonLat[1])
      const col = Math.round((x - originX) / dx)
      const rowFromSouth = Math.round((y - originY) / dy)
      if (col < 0 || col >= nLon || rowFromSouth < 0 || rowFromSouth >= nLat) continue
      const key = rowFromSouth * nLon + col
      if (seen.has(key)) continue
      seen.add(key)
      // Snap to the cell CENTRE and read there, so the numeral marks the sounding it
      // reports. `valueAt` is unit-native, and these are already the grid's own units.
      const cx = originX + col * dx
      const cy = originY + rowFromSouth * dy
      const first = handle.valueAt(cx, cy)
      if (first === null || Number.isNaN(first)) continue
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
