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

import { ARROW_DRIFT_UV } from './shaders/dsl/arrow-drift'
import { flowTrueSpans } from './render/flow-advect-params'
import {
  S111_ARROW_BASE_PX,
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

/** The SAMPLE LATTICE an arrow batch is seeded on: which cells are walked, and how finely each
 *  one is subdivided. Both numbers in one place because they are the two ends of a single
 *  budget — the ceiling is spent either on thinning a grid too big for it or on filling a grid
 *  small enough to leave room, never on both. */
interface ArrowLattice {
  /** Walk every `stride`-th drawable cell. > 1 only over the ceiling, where `sub` is 1. */
  stride: number
  /** Sub-nodes per cell AXIS, a power of two. 1 = one arrow per cell, today's density. */
  sub: number
}

/** How the batch spends `COVERAGE_ARROW_MAX` (#1511).
 *
 *  THE DENSITY HAD A HARD CEILING AT THE GRID'S OWN RESOLUTION. Nothing produced a second arrow
 *  for one cell, so a channel three water cells wide drew three arrows across its width at every
 *  zoom — and zooming in magnified the cells without adding anything between them, which is why
 *  it looked worse the closer you looked.
 *
 *  So the field is seeded DENSE and thinned by the view (`arrow-retained.ts`), and the level
 *  runs in both directions from one rule. Filling belongs here because it changes the origin
 *  SET; thinning belongs in the VS because it must not change the instance COUNT (the count is
 *  part of the origin key, and an unequal key re-seeds every arrow back to its cell).
 *
 *  DERIVED FROM THE BUDGET, and the budget is available exactly where the need is: a narrow
 *  domain has few cells, so 4x or 16x of few is still far under the ceiling, while the ceiling
 *  binds on a basin-wide grid — which is the case that wants thinning, not filling. That makes
 *  the two halves mutually exclusive by construction rather than by a rule that has to be kept.
 *
 *  AND CAPPED, because the budget alone is not a bound on a SMALL grid: a 3x2 coverage has four
 *  drawable cells, and `4 · 4^7 = 65 536` fits the ceiling with room — 16 384 arrows per cell,
 *  every one of them reporting the same datum. Two reasons that is the wrong answer, and only
 *  the second is about taste:
 *
 *   • Cost stops tracking the data. Every seeded arrow runs the vertex stage every frame whether
 *     or not the cull draws it, so seeding to the ceiling makes a four-cell coverage as expensive
 *     as a basin. The ceiling was argued for a field where every instance is DRAWN.
 *   • Past a few levels there is nothing left to gain. The cull holds the drawn spacing in
 *     [34, 68) px whatever is seeded, so a level does not add density — it extends the ZOOM
 *     RANGE over which that density survives, by exactly one zoom each. Measured on the demo
 *     fixture (2.2 km cells, TILE_PX 512), painted pixels, `| flow` against `| arrow`:
 *
 *       zoom      z10    z11    z12    z13    z14
 *       ratio    0.98   3.79  12.08  10.45      —   (the catalogue field paints 0 at z14)
 *
 *     One arrow per cell is right at z10, and the two seeded levels carry it to z12 — where it
 *     peaks and then expires exactly as the arithmetic says. Past that the screen spans a few
 *     hundred metres of a 2.2 km cell and the datum itself has nothing finer to say.
 *
 *  So: at most 64 arrows per cell, three zooms past the level-0 rung — and in practice the
 *  SEED bound below is what binds first on a grid of any size. */
const S111_SUBCELL_MAX_LEVEL = 3

/** …and at most this many SEEDED arrows in one batch, because THE CEILING IS SHARED.
 *
 *  `COVERAGE_ARROW_MAX` reads like a per-batch bound and is not one: the advect state is a single
 *  texture serving every resident mosaic domain, each owning a contiguous texel range, and it
 *  sizes itself to `end` — the SUM over regions — clamped to that same number
 *  (`arrow-advect-state.ts` `arrowAdvectDim`). Spend the whole ceiling on one batch and the next
 *  domain's texels are addressed past the end of the texture: those arrows read zeros, decode to
 *  grid-uv (0, 0) and stack in one corner.
 *
 *  Caught by `_s111-multiregion-gate`, not by reasoning — the two-domain demo seeded 2 × 75 968
 *  against a texture holding 100 489. A quarter of the ceiling lets four fully-subdivided domains
 *  be resident at once, which is more than the demo's mosaic loads.
 *
 *  It does NOT fix the over-subscription itself: two domains that each need 60 000 cells at one
 *  arrow per cell still exceed the shared texture, and did before subdivision existed. That is
 *  the state's own bound to enforce, and it is filed rather than papered over here (#1513). */
const S111_SUBCELL_SEED_MAX = COVERAGE_ARROW_MAX / 4

function arrowLattice(drawable: number): ArrowLattice {
  let level = 0
  while (level < S111_SUBCELL_MAX_LEVEL && drawable * 4 ** (level + 1) <= S111_SUBCELL_SEED_MAX)
    level++
  return { stride: level === 0 ? arrowStride(drawable) : 1, sub: 2 ** level }
}

/** Every seeded position, in THE order both consumers must agree on — origin `i` belongs to
 *  instance `i`. ONE walker rather than two loops a test pins into step: the emit below and
 *  `coverageArrowOrigins` both call this, so a subdivision that reached one and not the other
 *  is not a thing that can be written.
 *
 *  THE LATTICE, and why this one. Nodes sit at `col + a/sub` for `a` in `[-sub/2, sub/2)`, so
 *  each node lies within HALF A CELL of exactly one cell centre — the cell whose footprint
 *  contains it under point registration. Two properties follow, and both are load-bearing:
 *
 *   • VALIDITY IS THE CELL'S OWN. `s111HasArrow` is per cell, so a lattice that straddled cells
 *     would need a sub-position rejected whenever anything it interpolates from is land — and a
 *     missed case is an arrow drawn over land, a visibly wrong chart. Here the walker only ever
 *     visits nodes owned by a cell it has already accepted, so there is no interpolation to
 *     guard and no rejection rule to get wrong. The half-open offset range is what makes the
 *     ownership exact: the nodes tile the cell, no node has two owners and none has none.
 *
 *   • THE CELL CENTRES ARE IN IT (`a = 0`). The VS thins by keeping every 2^L-th node, so at
 *     L = log2(sub) the drawn set is EXACTLY the cell centres — the static catalogue placement,
 *     as one rung of the density ladder rather than as a separate portrayal.
 *
 *  `sub = 1` visits `a = b = 0` only, which is the pre-subdivision emit unchanged.
 *
 *  Positions are in CELL UNITS (`x` eastward, `y` in ROWS, which run southward). Nodes outside
 *  the grid's own uv box are skipped rather than clamped: the position encoding saturates at
 *  [0, 1), so a clamped node would stack on the edge node and be drawn somewhere it was not
 *  seeded. */
function forEachArrowSample(
  idx: readonly number[],
  nLon: number,
  nLat: number,
  { stride, sub }: ArrowLattice,
  visit: (cell: number, x: number, y: number) => void,
): void {
  const half = sub >> 1
  for (let k = 0; k < idx.length; k += stride) {
    const i = idx[k]!
    const row = Math.floor(i / nLon) // north-up storage: row 0 = northernmost
    const col = i - row * nLon
    for (let b = -half; b < sub - half; b++) {
      const y = row + b / sub
      if (y < 0 || y > nLat - 1) continue
      for (let a = -half; a < sub - half; a++) {
        const x = col + a / sub
        if (x < 0 || x > nLon - 1) continue
        visit(i, x, y)
      }
    }
  }
}

export interface CoverageArrowOptions {
  /** ADVECTED mode (#1409): the arrows are the particles — each one drifts through the current
   *  and is re-symbolized from the data under its new position.
   *
   *  Two things change here, and only here; the static portrayal is untouched.
   *
   *  1. THE COUNT IS THE SAME as the static path's — ONE ceiling for both (#1450 A). The
   *     arrow-position state is one TEXEL per arrow, so instance `i` and state texel `i` must
   *     correspond 1:1; the state now SIZES ITSELF to the batch, so that contract no longer
   *     costs a second, lower ceiling. It used to (16 384 against 100 000), which put the two
   *     portrayals of one field on different cells at 5x different densities — #1449.
   *
   *  2. EACH INSTANCE CARRIES ITS ORIGIN in grid-uv. The shader adds the drift displacement to
   *     it to know WHERE to sample the field for this frame's band, bearing and scale. Without
   *     it the arrow would move but keep the colour it launched with — an animation that looks
   *     entirely correct and reports the wrong current.
   *
   *  `peakSpeed` is the velocity textures' normalization scale (`packFlowFieldUV`), read off the
   *  UPLOADED field rather than re-derived here — the band table is expressed in those same
   *  units, and a second derivation of the peak is a second thing to keep in step. */
  advected?: { peakSpeed: number }
}

/** Instance origins in grid-uv, plus the two BASIS ANCHORS the advected VS projects, parallel
 *  to the arrays handed to `addCompiledArrowLayer`. Populated only in advected mode; the static
 *  portrayal has no use for either.
 *
 *  The anchors are the geographic positions of `origin + ARROW_DRIFT_UV` along grid-u and along
 *  grid-v. The VS projects all three points and maps a displacement to screen as
 *  `(d/ARROW_DRIFT_UV)·(anchorClip − originClip)`, so the linearization spans EXACTLY the
 *  excursion the leash allows — no uniform, no scale factor, no trigonometry in the shader.
 *
 *  They are computed HERE, through the cell's own CRS (`cellUnitsToLonLat`), and not in the
 *  packer: a packer that steps degrees is right for a geographic grid and silently wrong for a
 *  projected one, which is the #1366 failure this generator already paid for once. */
export interface CoverageArrowOrigins {
  u: Float32Array
  v: Float32Array
  /** Geographic position of origin + ARROW_DRIFT_UV along grid-u (lon, lat interleaved pairs
   *  would hide the parallel-array contract; two arrays keep it explicit). */
  uStepLon: Float64Array
  uStepLat: Float64Array
  /** Same, along grid-v — which runs SOUTHWARD (row 0 is the northernmost row), the identical
   *  sign convention the advect step derives in its header. */
  vStepLon: Float64Array
  vStepLat: Float64Array
  /** `trueLonSpan / trueLatSpan` for this grid (flow-advect-params.ts). A batch scalar, uploaded
   *  in the band table's params row: the VS needs it to point each glyph along the direction the
   *  advection actually moves it, since a uv unit is a different true distance on each axis. */
  uvAspect: number
  /** SAMPLE STEPS spanning uv 0→1 on each axis — `(n − 1) · sub`, the reciprocal of the lattice's
   *  own uv step (#1511). Batch scalars, uploaded in the params row alongside `uvAspect`.
   *
   *  ONE number serving the VS's two density questions, which is why it is this quantity and not
   *  the cell count: `|basis| / (ARROW_DRIFT_UV · steps)` is the on-screen spacing of adjacent
   *  SEEDED positions, and `origin · steps` is the node's own index on the lattice — both exact,
   *  because both are the same reciprocal. Handing the shader `n` instead makes each of them
   *  wrong by the `n / (n − 1)` the uv convention carries: harmless at one arrow per cell, a
   *  full node of index skew once the lattice is finer than a cell. */
  stepsU: number
  stepsV: number
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
  // ONE ceiling for both portrayals (#1450 A) — the state texture sizes itself to the batch,
  // so the 1:1 instance/texel contract no longer needs a lower one of its own. The STATIC path
  // never subdivides: the catalogue places one symbol per cell (`main.xsl`), and that is a rule,
  // not an implementation choice. Sub-cell arrows exist only where the portrayal already
  // re-symbolizes at a position the producer did not tabulate — the advected field (#1511).
  const lattice = opts.advected
    ? arrowLattice(idx.length)
    : { stride: arrowStride(idx.length), sub: 1 }

  const lons: number[] = []
  const lats: number[] = []
  const bearings: number[] = []
  const sizes: number[] = []
  const colors: [number, number, number, number][] = []

  forEachArrowSample(idx, nLon, nLat, lattice, (i, x, y) => {
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
    // ADVECTED: the BASE length only. The band multiplier is re-applied in the shader from the
    // speed under the arrow's CURRENT position (`s111BandTableNormalized`), so baking this
    // cell's multiplier in as well would scale every arrow twice — by the water it launched
    // from and by the water it is in. Bearing and colour are likewise ignored downstream in
    // that mode; they stay in the call because the batch shape is shared with the static path.
    //
    // A sub-cell node carries its OWNER cell's speed and direction, undiluted — the catalogue
    // tabulates one value per cell, and that value is a statement about the whole cell, so the
    // finer sampling reports the same datum rather than inventing one between cells.
    sizes.push(opts.advected ? S111_ARROW_BASE_PX : s111ArrowLengthPx(s))
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
    opts.advected ? advectedInput(handle, opts.advected.peakSpeed, rampName) : null,
  )
}

/** Assemble the advected batch's extra inputs. Separate from the emit loop above so the static
 *  path allocates none of it, and built from `coverageArrowOrigins` so the ORDER contract (origin
 *  `i` belongs to instance `i`) has exactly one implementation. */
function advectedInput(
  handle: CoverageHandle,
  peakSpeed: number,
  rampName: string,
): AdvectedArrowInput | null {
  const o = coverageArrowOrigins(handle)
  if (!o) return null
  return {
    originU: o.u,
    originV: o.v,
    uStepLon: o.uStepLon,
    uStepLat: o.uStepLat,
    vStepLon: o.vStepLon,
    vStepLat: o.vStepLat,
    bandTable: s111BandTableNormalized(peakSpeed, o.uvAspect, rampName, [o.stepsU, o.stepsV]),
  }
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
  const [originX, originY] = handle.header.origin
  const [dx, dy] = handle.header.spacing
  const crs = handle.header.crs
  const idx: number[] = []
  for (let i = 0; i < vec.speed.length; i++) {
    if (s111HasArrow(vec.speed[i]!) && Number.isFinite(vec.direction[i]!)) idx.push(i)
  }
  if (idx.length === 0) return null
  const lattice = arrowLattice(idx.length) // the SAME lattice the emit walks — the order contract
  // One leash-length in GRID UNITS. A uv of 1 spans (n−1) cells, so this is the number of cells
  // an arrow may drift before it recycles — and the length of the basis the VS scales.
  const uSpan = ARROW_DRIFT_UV * (nLon > 1 ? nLon - 1 : 1) * dx
  const vSpan = ARROW_DRIFT_UV * (nLat > 1 ? nLat - 1 : 1) * dy
  const u: number[] = []
  const v: number[] = []
  const uStepLon: number[] = []
  const uStepLat: number[] = []
  const vStepLon: number[] = []
  const vStepLat: number[] = []
  forEachArrowSample(idx, nLon, nLat, lattice, (_i, x, y) => {
    u.push(nLon > 1 ? x / (nLon - 1) : 0)
    v.push(nLat > 1 ? y / (nLat - 1) : 0)
    const gx = originX + x * dx
    const gy = originY + (nLat - 1 - y) * dy
    // +u is +x in the grid's own units; +v is SOUTHWARD, which is −y (row 0 is northernmost —
    // the same derivation arrow-advect-step.ts's header spells out for the advection sign).
    const [ulon, ulat] = cellUnitsToLonLat(crs, gx + uSpan, gy)
    const [vlon, vlat] = cellUnitsToLonLat(crs, gx, gy - vSpan)
    uStepLon.push(ulon)
    uStepLat.push(ulat)
    vStepLon.push(vlon)
    vStepLat.push(vlat)
  })
  // The SAME derivation the advect step's own params use — one function, so the drawn heading
  // and the drifted heading cannot disagree.
  const [swLon, swLat] = cellUnitsToLonLat(crs, originX, originY)
  const [neLon, neLat] = cellUnitsToLonLat(
    crs,
    originX + (nLon - 1) * dx,
    originY + (nLat - 1) * dy,
  )
  const { trueLon, trueLat } = flowTrueSpans([neLon - swLon, neLat - swLat], (swLat + neLat) / 2)
  return {
    u: Float32Array.from(u),
    v: Float32Array.from(v),
    uStepLon: Float64Array.from(uStepLon),
    uStepLat: Float64Array.from(uStepLat),
    vStepLon: Float64Array.from(vStepLon),
    vStepLat: Float64Array.from(vStepLat),
    uvAspect: trueLat > 0 ? trueLon / trueLat : 1,
    stepsU: (nLon > 1 ? nLon - 1 : 1) * lattice.sub,
    stepsV: (nLat > 1 ? nLat - 1 : 1) * lattice.sub,
  }
}
