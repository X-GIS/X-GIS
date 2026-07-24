// Coverage arrow show → GraphicsManager.addCompiledArrowLayer — the ENGINE-side generator
// that turns a gridded S-111 surface-current coverage into the official IHO arrow field.
//
// Sibling of arrow-show.ts (the per-feature `| arrow` on a Point source): this reads the
// SPEED + DIRECTION bands of a CoverageHandle instead of Point features, applies the
// s111-portrayal rule (band colour + per-band scale + black outline + "no symbol for speed 0
// / noData"), and hands two flat-array batches — a black OUTLINE (larger, drawn first) and
// the banded-colour FILL (drawn second, on top) — to the shared compiled-arrow draper: no new
// GPU code, no new render pass. Placement / scale / rotation / colour / outline are the
// vendored catalogue (docs/standards/s-111/); the rule authority is ./render/s111-portrayal.ts
// + the s111-speed BANDED_RAMPS palette (color-ramp.ts), one source of truth with the fill.

import type { CoverageHandle } from '@xgis/data'
import type { ShowCommand } from './render/renderer-types'
import type { GraphicsManager } from './graphics/graphics-manager'
import { bandedRampColor } from './color-ramp'
import {
  s111ArrowLengthPx,
  s111ArrowOutlineLengthPx,
  s111HasArrow,
  S111_OUTLINE_COLOR,
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

/** Build the S-111 arrow field for a coverage layer carrying `| arrow`. One arrow per valid
 *  (finite speed > 0) cell: position = cell centre, bearing = the direction band (degrees
 *  true, the arrow primitive's own convention), length = the per-band scale rule, colour =
 *  the band palette (the layer's `ramp`, defaulting to s111-speed). No-op when the handle
 *  lacks a direction band or has no drawable cell (a later rebuild re-adds once data lands). */
export function addCoverageArrowShowLayer(
  host: CoverageArrowShowHost,
  show: ShowCommand,
  handle: CoverageHandle,
): void {
  const bands = handle.bands
  // Resolve by S-111 band name, falling back to index (speed = 0, direction = 1). `band()`
  // throws on a missing name, so probe `bands` directly to stay a safe no-op.
  const speedBand = bands.find((b) => b.header.name === 'surfaceCurrentSpeed') ?? bands[0]
  const dirBand = bands.find((b) => b.header.name === 'surfaceCurrentDirection') ?? bands[1]
  if (!speedBand || !dirBand) return // need magnitude + direction to orient an arrow

  const [nLon, nLat] = handle.header.size
  const [originLon, originLat] = handle.header.origin // SW cell CENTRE (point registration)
  const [dLon, dLat] = handle.header.spacing
  const rampName = show.ramp ?? S111_SPEED_RAMP
  const speed = speedBand.values
  const dir = dirBand.values

  // Collect drawable cells first so an over-ceiling grid thins over WATER, not the bbox.
  const idx: number[] = []
  for (let i = 0; i < speed.length; i++) {
    if (s111HasArrow(speed[i]!) && Number.isFinite(dir[i]!)) idx.push(i)
  }
  if (idx.length === 0) return
  const stride = idx.length > COVERAGE_ARROW_MAX ? Math.ceil(idx.length / COVERAGE_ARROW_MAX) : 1

  const lons: number[] = []
  const lats: number[] = []
  const bearings: number[] = []
  const fillSizes: number[] = []
  const outlineSizes: number[] = []
  const fillColors: [number, number, number, number][] = []
  const outlineColors: [number, number, number, number][] = []

  const [oR, oG, oB] = S111_OUTLINE_COLOR

  for (let k = 0; k < idx.length; k += stride) {
    const i = idx[k]!
    const row = Math.floor(i / nLon) // north-up storage: row 0 = northernmost
    const col = i - row * nLon
    const s = speed[i]!
    const c = bandedRampColor(rampName, s) ?? bandedRampColor(S111_SPEED_RAMP, s) ?? [255, 255, 255]
    lons.push(originLon + col * dLon)
    lats.push(originLat + (nLat - 1 - row) * dLat)
    bearings.push(dir[i]!)
    fillSizes.push(s111ArrowLengthPx(s))
    outlineSizes.push(s111ArrowOutlineLengthPx(s))
    fillColors.push([c[0] / 255, c[1] / 255, c[2] / 255, 1])
    outlineColors.push([oR / 255, oG / 255, oB / 255, 1])
  }

  const lonArr = Float64Array.from(lons)
  const latArr = Float64Array.from(lats)
  const bearingArr = Float32Array.from(bearings)
  // The retained-arrow draper has no depth test (alpha blend, painter's algorithm) — the
  // OUTLINE batch (black, larger) MUST be added first so the FILL batch (banded colour,
  // smaller) draws on top of it (graphics-manager.ts `renderRetained` draws
  // `_compiledArrows` in push order). Same position/bearing, only size + colour differ.
  host.graphics.addCompiledArrowLayer(
    lonArr,
    latArr,
    bearingArr,
    Float32Array.from(outlineSizes),
    outlineColors,
  )
  host.graphics.addCompiledArrowLayer(
    lonArr,
    latArr,
    bearingArr,
    Float32Array.from(fillSizes),
    fillColors,
  )
}
