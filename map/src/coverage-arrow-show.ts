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

import type { CoverageHandle } from '@xgis/data'
import type { ShowCommand } from './render/renderer-types'
import type { GraphicsManager } from './graphics/graphics-manager'
import { bandedRampColor } from './color-ramp'
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

// ── Drift animation (NOT from the IHO catalogue) ──────────────────────────────────
// The vendored S-111 Portrayal Catalogue defines STATIC point symbols only — its
// `<lineStyles/>`, `<areaFills/>` and `<pixmaps/>` are all empty, so there is no standard
// streamline or animation to transcribe. The drift below is X-GIS presentation on top of
// the spec-exact symbol: each arrow glides along the bearing it already points, then fades
// and respawns at its cell. It changes nothing the catalogue does specify (position at
// phase 0, colour, band scale, rotation, outline), so the portrayal stays conformant.

/** Drift-and-respawn period, seconds. Long enough to read as flow rather than flicker. */
export const S111_DRIFT_LIFETIME_SECONDS = 3

/** Travel distance per knot over one lifetime, in px. Speed-proportional (not per-band) so
 *  the motion reads as the actual current: the band SCALE rule is flat across bands 1–3, so
 *  a size-derived drift would make a whole slow bay animate at one uniform speed. */
export const S111_DRIFT_PX_PER_KNOT = 18

/** Ceiling on drift as a multiple of the arrow's OWN length. Without it a fast band drifts
 *  several glyph-lengths per lifetime and the field reads as smear rather than as arrows. */
export const S111_DRIFT_MAX_LENGTHS = 2

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
  const sizes: number[] = []
  const colors: [number, number, number, number][] = []
  const drifts: number[] = []

  for (let k = 0; k < idx.length; k += stride) {
    const i = idx[k]!
    const row = Math.floor(i / nLon) // north-up storage: row 0 = northernmost
    const col = i - row * nLon
    const s = speed[i]!
    const c = bandedRampColor(rampName, s) ?? bandedRampColor(S111_SPEED_RAMP, s) ?? [255, 255, 255]
    const lengthPx = s111ArrowLengthPx(s)
    lons.push(originLon + col * dLon)
    lats.push(originLat + (nLat - 1 - row) * dLat)
    bearings.push(dir[i]!)
    sizes.push(lengthPx)
    colors.push([c[0] / 255, c[1] / 255, c[2] / 255, 1])
    drifts.push(Math.min(s * S111_DRIFT_PX_PER_KNOT, lengthPx * S111_DRIFT_MAX_LENGTHS))
  }

  host.graphics.addCompiledArrowLayer(
    Float64Array.from(lons),
    Float64Array.from(lats),
    Float32Array.from(bearings),
    Float32Array.from(sizes),
    colors,
    S111_OUTLINE_FRAC,
    {
      driftPx: Float32Array.from(drifts),
      lifetimeSeconds: S111_DRIFT_LIFETIME_SECONDS,
    },
  )
}
