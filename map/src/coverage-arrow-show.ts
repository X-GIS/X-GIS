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

import { cellUnitsToLonLat, type CoverageHandle } from '@xgis/data'
import type { ShowCommand } from './render/renderer-types'
import type { GraphicsManager } from './graphics/graphics-manager'
import { bandedRampColor } from './color-ramp'
import { resolveVectorBands } from './coverage-vector-bands'
import { ARROW_ADVECT_COUNT } from './render/arrow-advect-state'
import {
  s111ArrowLengthPx,
  s111HasArrow,
  S111_OUTLINE_FRAC,
  S111_SPEED_RAMP,
} from './render/s111-portrayal'

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

export interface CoverageArrowOptions {
  /** ADVECTED mode (#1409): the arrows are the particles — each one drifts through the current
   *  and is re-symbolized from the data under its new position.
   *
   *  Two things change here, and only here; the static portrayal is untouched.
   *
   *  1. THE COUNT IS CAPPED at `ARROW_ADVECT_COUNT`. The arrow-position state is one TEXEL per
   *     arrow, so instance `i` and state texel `i` must correspond 1:1. A grid with more valid
   *     cells than texels is thinned over its WATER (the same uniform thinning the ceiling
   *     already does), which is also the right display choice: a moving field reads as full at
   *     16 384 arrows whatever the grid size.
   *
   *  2. EACH INSTANCE CARRIES ITS ORIGIN in grid-uv. The shader adds the drift displacement to
   *     it to know WHERE to sample the field for this frame's band, bearing and scale. Without
   *     it the arrow would move but keep the colour it launched with — an animation that looks
   *     entirely correct and reports the wrong current. */
  advected?: boolean
}

/** Instance origins in grid-uv, parallel to the arrays handed to `addCompiledArrowLayer`.
 *  Populated only in advected mode; the static portrayal has no use for it. */
export interface CoverageArrowOrigins {
  u: Float32Array
  v: Float32Array
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

  // Collect drawable cells first so an over-ceiling grid thins over WATER, not the bbox.
  const idx: number[] = []
  for (let i = 0; i < speed.length; i++) {
    if (s111HasArrow(speed[i]!) && Number.isFinite(dir[i]!)) idx.push(i)
  }
  if (idx.length === 0) return
  // The advected mode's ceiling is the state texture's texel count, not COVERAGE_ARROW_MAX:
  // instance `i` and state texel `i` must correspond 1:1 (see CoverageArrowOptions).
  const ceiling = opts.advected ? ARROW_ADVECT_COUNT : COVERAGE_ARROW_MAX
  const stride = idx.length > ceiling ? Math.ceil(idx.length / ceiling) : 1

  const lons: number[] = []
  const lats: number[] = []
  const bearings: number[] = []
  const sizes: number[] = []
  const colors: [number, number, number, number][] = []

  for (let k = 0; k < idx.length; k += stride) {
    const i = idx[k]!
    const row = Math.floor(i / nLon) // north-up storage: row 0 = northernmost
    const col = i - row * nLon
    const s = speed[i]!
    const c = bandedRampColor(rampName, s) ?? bandedRampColor(S111_SPEED_RAMP, s) ?? [255, 255, 255]
    // Through the cell's OWN CRS (#1366). `origin + col·spacing` is in the GRID's units,
    // which are degrees only for a geographic cell — real S-111 cells are, which is why
    // this read as correct, but INC-3 made PROJECTED cells placeable and a UTM grid's
    // metres pushed as lon/lat would land continents away. One authority with the drape.
    const [lon, lat] = cellUnitsToLonLat(crs, originX + col * dx, originY + (nLat - 1 - row) * dy)
    lons.push(lon)
    lats.push(lat)
    bearings.push(dir[i]!)
    sizes.push(s111ArrowLengthPx(s))
    colors.push([c[0] / 255, c[1] / 255, c[2] / 255, 1])
  }

  host.graphics.addCompiledArrowLayer(
    Float64Array.from(lons),
    Float64Array.from(lats),
    Float32Array.from(bearings),
    Float32Array.from(sizes),
    colors,
    S111_OUTLINE_FRAC,
    region,
  )
}

/** The origins the ADVECTED mode needs, for the same inputs and in the SAME order
 *  `addCoverageArrowShowLayer` emits its instances.
 *
 *  Separate from the emit rather than returned by it, because the static path — every existing
 *  `| arrow` caller — must keep allocating nothing extra. The ORDER is the contract: origin `i`
 *  belongs to instance `i`, so both walk `idx` with the identical stride, and
 *  `coverage-arrow-show.test.ts` pins that they agree rather than trusting two loops to stay in
 *  step. */
export function coverageArrowOrigins(handle: CoverageHandle): CoverageArrowOrigins | null {
  const vec = resolveVectorBands(handle)
  if (!vec) return null
  const [nLon, nLat] = handle.header.size
  const idx: number[] = []
  for (let i = 0; i < vec.speed.length; i++) {
    if (s111HasArrow(vec.speed[i]!) && Number.isFinite(vec.direction[i]!)) idx.push(i)
  }
  if (idx.length === 0) return null
  const stride = idx.length > ARROW_ADVECT_COUNT ? Math.ceil(idx.length / ARROW_ADVECT_COUNT) : 1
  const u: number[] = []
  const v: number[] = []
  for (let k = 0; k < idx.length; k += stride) {
    const i = idx[k]!
    const row = Math.floor(i / nLon)
    const col = i - row * nLon
    u.push(nLon > 1 ? col / (nLon - 1) : 0)
    v.push(nLat > 1 ? row / (nLat - 1) : 0)
  }
  return { u: Float32Array.from(u), v: Float32Array.from(v) }
}
