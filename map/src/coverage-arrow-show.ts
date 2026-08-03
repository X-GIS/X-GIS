// Coverage arrow show → GraphicsManager.addCompiledArrowLayer — the ENGINE-side generator
// that turns a gridded S-111 surface-current coverage into the official IHO arrow field.
//
// Sibling of arrow-show.ts (the per-feature `| arrow` on a Point source): this reads the
// SPEED + DIRECTION bands of a CoverageHandle instead of Point features, applies the
// s111-portrayal rule (band colour + per-band scale + black outline + "no symbol for speed 0
// / noData"), and hands the flat arrays + S111_OUTLINE_FRAC to the shared compiled-arrow
// draper — no new render pass. The outline is a proper analytic SDF stroke INSIDE the shared
// arrow shader (arrow-retained.ts `stroke_units`), opt-in per batch (every other `| arrow`
// consumer defaults to 0 = no outline, unaffected). Placement / scale / rotation / colour /
// outline are the vendored catalogue (docs/standards/s-111/); the rule authority is
// ./render/s111-portrayal.ts + the s111-speed BANDED_RAMPS palette (color-ramp.ts), one
// source of truth with the fill.

import { cellUnitsToLonLat, isGeographicCRS, type CoverageHandle } from '@xgis/data'
import type { ShowCommand } from './render/renderer-types'
import type { GraphicsManager } from './graphics/graphics-manager'
import { bandedRampColor } from './color-ramp'
import { resolveVectorBands } from './coverage-vector-bands'

import { flowTrueSpans } from './render/flow-advect-params'
import {
  s111ArrowLengthPx,
  s111BandTableNormalized,
  s111HasArrow,
  S111_OUTLINE_FRAC,
  S111_SPEED_RAMP,
} from './render/s111-portrayal'
import type { AdvectedArrowInput } from './graphics/compiled-arrow-store'

/** The slice of XGISMap the coverage-arrow build reads. */
export interface CoverageArrowShowHost {
  graphics: GraphicsManager
}

/** Safety ceiling on emitted arrows. The retained-arrow path is proven N-independent to
 *  ~100k instances; an S-111 regional cell is well under it (CBOFS ≈ 69.7k valid cells). A
 *  larger grid is thinned UNIFORMLY over its VALID cells (not the land-filled bounding box),
 *  so the field still tiles the water. A truly global field (GFS wind, #1273) wants GPU
 *  instance generation instead — out of scope here. */
export const COVERAGE_ARROW_MAX = 100_000

/** Uniform thinning over the DRAWABLE cells, so an over-ceiling grid still tiles its water
 *  rather than losing a corner of the bbox. */
function arrowStride(drawable: number): number {
  return drawable > COVERAGE_ARROW_MAX ? Math.ceil(drawable / COVERAGE_ARROW_MAX) : 1
}

/** Every drawable cell, in the order the emit walks them.
 *
 *  Sub-cell SUBDIVISION is gone (#1520 step 2). It existed because the density had a hard ceiling
 *  at the grid's own resolution — a three-cell-wide channel drew three arrows at every zoom — and
 *  it bought exactly three zooms before the arithmetic ran out (`sub²` per cell scales with the
 *  GRID, so at z17 not one seeded node was on screen). The ADVECTED portrayal now seeds on the
 *  screen instead, at whatever spacing the screen wants, so it needs no seeded positions at all.
 *  The STATIC portrayal never subdivided: `main.xsl` places one symbol per cell, and that is a
 *  rule rather than an implementation choice. */
function forEachArrowSample(
  idx: readonly number[],
  nLon: number,
  stride: number,
  visit: (cell: number, x: number, y: number) => void,
): void {
  for (let k = 0; k < idx.length; k += stride) {
    const i = idx[k]!
    const row = Math.floor(i / nLon) // north-up storage: row 0 = northernmost
    visit(i, i - row * nLon, row)
  }
}

export interface CoverageArrowOptions {
  /** ADVECTED mode (#1409): the glyphs ARE the particles — streamline trains that drift through
   *  the current and are re-symbolized from the data under their current position.
   *
   *  NO INSTANCES ARE EMITTED IN THIS MODE (#1520 step 2). The static path's per-cell arrays are
   *  skipped entirely: the advected module binds no feat buffer, because its instance set is a
   *  lattice on the SCREEN whose size is a per-FRAME decision. All this arm contributes is the
   *  band table and the grid box (`CoverageArrowGrid`).
   *
   *  `peakSpeed` is the velocity textures' normalization scale (`packFlowFieldUV`), read off the
   *  UPLOADED field rather than re-derived here — the band table is expressed in those same
   *  units, and a second derivation of the peak is a second thing to keep in step. */
  advected?: { peakSpeed: number }
}

/** What the ADVECTED portrayal needs from the grid, and it is no longer per instance (#1520).
 *
 *  There are no seeded positions any more — the field is generated on the SCREEN and each node
 *  recovers its own geography — so the only thing the coverage has to say is WHERE IT IS: the
 *  affine box that turns a recovered lon/lat into grid-uv, matching the convention the velocity
 *  textures are packed in (`u = col/(n−1)`, `v = row/(n−1)`, row 0 northernmost).
 *
 *  That replaces two Float64Arrays per axis plus two Float32Arrays of origins, per batch, per
 *  re-arm — 6 arrays × up to 25 000 entries — with four numbers.
 *
 *  GEOGRAPHIC CELLS ONLY. `field_grid_uv` is an affine map in the shader, which a projected CRS
 *  is not; supporting one would need that CRS's forward ladder on the GPU (#1366 INC-3). A
 *  projected coverage falls back to the STATIC catalogue portrayal rather than drawing nothing,
 *  and `coverage-arrow-show.test.ts` pins the fallback so it cannot rot into a silent blank. */
export interface CoverageArrowGrid {
  /** lon/lat of grid-uv (0, 0) — the NORTH-WEST node. */
  originLon: number
  originLat: number
  /** Reciprocal spans; `invSpanLat` is NEGATIVE because grid-v runs southward. */
  invSpanLon: number
  invSpanLat: number
  /** `trueLonSpan / trueLatSpan` for this grid (flow-advect-params.ts). A batch scalar, uploaded
   *  in the band table's params row: a uv unit is a different true distance on each axis, so a
   *  velocity in metric east/north components has to become a uv rate before the screen basis can
   *  turn it into a direction. */
  uvAspect: number
}

/** Build the S-111 arrow field for a coverage layer carrying `| arrow`. One arrow per valid
 *  (finite speed > 0) cell: position = cell centre, bearing = the direction band (degrees
 *  true, the arrow primitive's own convention), length = the per-band scale rule, colour =
 *  the band palette (the layer's `ramp`, defaulting to s111-speed). No-op when the handle
 *  lacks a direction band or has no drawable cell (a later rebuild re-adds once data lands).
 *
 *  `region` tags the emitted batch with the mosaic domain it belongs to (#1272 E-④), so one
 *  domain's re-arm replaces only its own glyphs and adjacent domains keep theirs. */
export function addCoverageArrowShowLayer(
  host: CoverageArrowShowHost,
  show: ShowCommand,
  handle: CoverageHandle,
  region = '',
  opts: CoverageArrowOptions = {},
): void {
  // Is this a vector field at all? SINGLE AUTHORITY (coverage-vector-bands.ts) shared with
  // the flow-field upload, so the two cannot disagree about whether a coverage has a current.
  // Null for every scalar coverage — S-102 bathymetry above all, which the previous
  // resolve-by-index fallback here happily rendered as a current field (depth as speed,
  // uncertainty as bearing). Not an error: a bathymetry layer simply has nothing to portray.
  const vec = resolveVectorBands(handle)
  if (!vec) return

  const [nLon, nLat] = handle.header.size
  const [originX, originY] = handle.header.origin // SW cell CENTRE (point registration)
  const [dx, dy] = handle.header.spacing
  const crs = handle.header.crs
  const rampName = show.ramp ?? S111_SPEED_RAMP
  const speed = vec.speed
  const dir = vec.direction

  // ── ADVECTED: no per-cell instances at all (#1520 step 2) ────────────────────────────────
  //
  // The whole cell walk below exists to place ONE SYMBOL PER CELL, which is the static
  // catalogue's rule (`main.xsl`). The advected portrayal does not place symbols on cells any
  // more — it places them on a lattice the SCREEN decides — so running the walk would allocate
  // six arrays of up to 100 000 entries for a buffer nothing binds. It returns early instead,
  // with the band table and the grid box the screen lattice actually reads.
  //
  // The grid box is GEOGRAPHIC-ONLY, which is a stated fallback rather than a gap: the shader's
  // lon/lat → grid-uv step is affine, and a projected CRS is not. Such a coverage takes the
  // static branch below, which goes through `cellUnitsToLonLat` and is correct for any CRS.
  if (opts.advected && isGeographicCRS(crs)) {
    // One drawable cell is enough to arm the batch — the screen lattice decides where the glyphs
    // go, and the velocity texture's own packed (0, 0) is what keeps them off land. A coverage
    // with NO current at all still arms nothing, so an empty forecast hour draws nothing rather
    // than a field of zero-length glyphs.
    let drawable = false
    for (let i = 0; i < speed.length && !drawable; i++)
      drawable = s111HasArrow(speed[i]!) && Number.isFinite(dir[i]!)
    if (!drawable) return
    host.graphics.addCompiledArrowLayer(
      EMPTY_F64,
      EMPTY_F64,
      EMPTY_F32,
      EMPTY_F32,
      [],
      S111_OUTLINE_FRAC,
      region,
      advectedInput(handle, opts.advected.peakSpeed, rampName),
    )
    return
  }

  // Collect drawable cells first so an over-ceiling grid thins over WATER, not the bbox.
  const idx: number[] = []
  for (let i = 0; i < speed.length; i++) {
    if (s111HasArrow(speed[i]!) && Number.isFinite(dir[i]!)) idx.push(i)
  }
  if (idx.length === 0) return

  const lons: number[] = []
  const lats: number[] = []
  const bearings: number[] = []
  const sizes: number[] = []
  const colors: [number, number, number, number][] = []

  forEachArrowSample(idx, nLon, arrowStride(idx.length), (i, x, y) => {
    const s = speed[i]!
    const c = bandedRampColor(rampName, s) ?? bandedRampColor(S111_SPEED_RAMP, s) ?? [255, 255, 255]
    // Through the cell's OWN CRS (#1366). `origin + col·spacing` is in the GRID's units,
    // which are degrees only for a geographic cell — real S-111 cells are, which is why
    // this read as correct, but INC-3 made PROJECTED cells placeable and a UTM grid's
    // metres pushed as lon/lat would land continents away. One authority with the drape.
    const [lon, lat] = cellUnitsToLonLat(crs, originX + x * dx, originY + (nLat - 1 - y) * dy)
    lons.push(lon)
    lats.push(lat)
    bearings.push(dir[i]!)
    sizes.push(s111ArrowLengthPx(s))
    colors.push([c[0] / 255, c[1] / 255, c[2] / 255, 1])
  })

  host.graphics.addCompiledArrowLayer(
    Float64Array.from(lons),
    Float64Array.from(lats),
    Float32Array.from(bearings),
    Float32Array.from(sizes),
    colors,
    S111_OUTLINE_FRAC,
    region,
    null,
  )
}

const EMPTY_F64 = new Float64Array(0)
const EMPTY_F32 = new Float32Array(0)

/** Assemble the ADVECTED batch's inputs: the catalogue table in the shader's units, and the
 *  grid box that turns a recovered lon/lat into grid-uv. Both are batch scalars — there is
 *  nothing per instance left to build. */
function advectedInput(
  handle: CoverageHandle,
  peakSpeed: number,
  rampName: string,
): AdvectedArrowInput {
  const grid = coverageArrowGrid(handle)
  return {
    grid,
    bandTable: s111BandTableNormalized(peakSpeed, grid.uvAspect, rampName),
  }
}

/** The coverage's grid as the affine box `uv = (lonlat − origin) · invSpan`, in the SAME
 *  convention the velocity textures are packed in: `u = col/(nLon−1)` eastward and
 *  `v = row/(nLat−1)` SOUTHWARD, so uv (0, 0) is the north-west node.
 *
 *  Geographic cells only — the caller gates on `isGeographicCRS` and takes the static branch
 *  otherwise. A degenerate axis (a single-column or single-row coverage) gets a zero reciprocal,
 *  which pins every node to uv 0 on that axis: correct, since there is one sample to read. */
export function coverageArrowGrid(handle: CoverageHandle): CoverageArrowGrid {
  const [nLon, nLat] = handle.header.size
  const [originX, originY] = handle.header.origin // SW cell CENTRE (point registration)
  const [dx, dy] = handle.header.spacing
  const west = originX
  const east = originX + (nLon - 1) * dx
  const south = originY
  const north = originY + (nLat - 1) * dy
  // The SAME derivation the flow field's own params use — one function, so the drawn heading and
  // the travelled heading cannot disagree.
  const { trueLon, trueLat } = flowTrueSpans([east - west, north - south], (south + north) / 2)
  return {
    originLon: west,
    originLat: north,
    invSpanLon: nLon > 1 ? 1 / (east - west) : 0,
    // NEGATIVE: v runs southward, and folding the sign into the reciprocal keeps it from becoming
    // a branch somebody has to remember to keep in step with the packer.
    invSpanLat: nLat > 1 ? 1 / (south - north) : 0,
    uvAspect: trueLat > 0 ? trueLon / trueLat : 1,
  }
}
