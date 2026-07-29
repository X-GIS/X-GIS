// ═══ Official IHO S-111 surface-current arrow portrayal — rule authority ═══
//
// Single-authority transcription of the vendored catalogue at `docs/standards/s-111/`
// (`portrayal/XSLT/Rules/select_arrow.xsl`, `Rules/main.xsl`). The band COLOURS are NOT
// duplicated here — they live in `BANDED_RAMPS['s111-speed']` (color-ramp.ts), the exact
// palette the GPU coverage fill bakes into its LUT (verbatim from the catalogue's
// `colorProfile.xml` / `SVGStyle_S111day.css`). This module owns only what the fill palette
// does NOT carry: the per-band arrow SCALE and the placement rule.
//
// select_arrow.xsl scale rule (multiplier on the base symbol size):
//   bands 1–3  (0 ≤ speed < 2 kn)  → fixed  scaleFloor        = 0.40
//   bands 4–8  (2 ≤ speed < 13 kn) → speed × scaleIntermediate = speed × 0.20
//   band  9    (speed ≥ 13 kn)     → fixed  scaleCeiling       = 2.60
// The rule is continuous at the joins (2 × 0.20 = 0.40, 13 × 0.20 = 2.60), so a slow bay
// (all < 2 kn) draws UNIFORM-size arrows that vary only by colour — the correct S-111 look.
//
// main.xsl note (4): the lookup table omits speed 0 and the fill value → NO symbol for a
// zero or noData cell.

import { bandedRampColor } from '../color-ramp'
import {
  S111_BAND_COUNT,
  S111_BAND_PARAMS_ROW,
  S111_BAND_STRIDE,
  S111_BAND_TABLE_ROWS,
  S111_BAND_TOP_SENTINEL,
  S111_PARAM_UV_ASPECT,
} from '../shaders/dsl/s111-band-table-layout'

/** S-111 speed-band palette name (the banded ramp shared with the coverage fill). */
export const S111_SPEED_RAMP = 's111-speed'

/** select_arrow.xsl scale constants. */
export const S111_SCALE_FLOOR = 0.4 // bands 1–3 defaultScaleFactor
export const S111_SCALE_PER_KNOT = 0.2 // bands 4–8 scaleFactor (× surfaceCurrentSpeed)
export const S111_SCALE_CEILING = 2.6 // band 9 defaultScaleFactor
const S111_MID_LO = 2 // band 4 lower edge (knots)
const S111_MID_HI = 13 // band 9 lower edge (knots)

/** The official per-band scale multiplier for a surface-current speed in KNOTS
 *  (`select_arrow.xsl`). Fixed 0.40 below 2 kn, `speed × 0.20` in [2, 13), fixed 2.60 at/above
 *  13 kn — continuous at both joins. */
export function s111ArrowScale(speedKnots: number): number {
  if (speedKnots < S111_MID_LO) return S111_SCALE_FLOOR
  if (speedKnots < S111_MID_HI) return speedKnots * S111_SCALE_PER_KNOT
  return S111_SCALE_CEILING
}

/** Screen-legibility base length (px) for the 11 mm S-111 arrow symbol. The spec sizes the
 *  symbol in millimetres at chart scale; on a web map we pick a base px and preserve the
 *  catalogue's scale RATIOS (0.40 / ×0.20 / 2.60) exactly via `s111ArrowScale`. */
export const S111_ARROW_BASE_PX = 34

/** Arrow LENGTH in px (tail→tip) for the arrow primitive: `basePx × s111ArrowScale(speed)`. */
export function s111ArrowLengthPx(speedKnots: number, basePx: number = S111_ARROW_BASE_PX): number {
  return basePx * s111ArrowScale(speedKnots)
}

/** main.xsl note (4): a cell gets an arrow only when its speed is finite and > 0 (zero and
 *  noData/fill are not symbolized). */
export function s111HasArrow(speedKnots: number): boolean {
  return Number.isFinite(speedKnots) && speedKnots > 0
}

// ── The catalogue rule, as DATA the GPU can look up ──────────────────────────────────────
//
// An arrow that is ADVECTED through the velocity field is not at its origin cell any more, so
// its band — and therefore its colour and its scale — has to be re-decided every frame from
// the speed under it. That decision cannot move into a shader as CODE: the thresholds and the
// scale rule would then exist in two places, and a catalogue revision would silently update
// only one of them. This codebase has paid for two-authority drift more than once (§12).
//
// So the rule is uploaded as a TABLE, generated here from the two authorities that already
// own its parts — `BANDED_RAMPS['s111-speed']` for the edges and colours, and the
// `S111_SCALE_*` constants above for the scale. The shader holds no threshold and no colour of
// its own; it only indexes this. `s111-portrayal.test.ts` asserts the table reproduces
// `bandedRampColor` and `s111ArrowScale` exactly, so a drift is a failing test rather than a
// wrong picture.
//
// The scale rule is expressed per band as an AFFINE pair rather than a branch, because
// `select_arrow.xsl` is exactly affine in every band:
//   bands 1–3 → (0.40, 0)      constant  scaleFloor
//   bands 4–8 → (0,    0.20)   speed × scaleIntermediate
//   band  9   → (2.60, 0)      constant  scaleCeiling
// so `scale = constant + perKnot × speed` reproduces all nine with no conditional at all.

/** Build the band table the advected-arrow shader indexes. Row `i` is band `i+1`. Edges and the
 *  scale pair are in KNOTS — see `s111BandTableNormalized` for the units the shader wants. */
export function s111BandTable(rampName: string = S111_SPEED_RAMP): Float32Array {
  const out = new Float32Array(S111_BAND_COUNT * S111_BAND_STRIDE)
  // Band UPPER edges, from the catalogue: [0,.5) [.5,1) [1,2) [2,3) [3,5) [5,7) [7,10) [10,13) [13,∞)
  const edges = [0.5, 1, 2, 3, 5, 7, 10, 13, S111_BAND_TOP_SENTINEL]
  for (let b = 0; b < S111_BAND_COUNT; b++) {
    // A speed strictly inside the band — used to ask the EXISTING authorities what this band
    // looks like, rather than restating either of them here. Midpoint of the band, except the
    // unbounded top one, where any value at/above 13 gives the same answer.
    const lo = b === 0 ? 0 : edges[b - 1]!
    const probe = b === S111_BAND_COUNT - 1 ? S111_MID_HI : (lo + edges[b]!) / 2
    const c = bandedRampColor(rampName, probe) ?? bandedRampColor(S111_SPEED_RAMP, probe)!
    // The affine pair, read off `s111ArrowScale` at two probes rather than re-deriving it:
    // a band is either constant (both probes agree) or proportional (scale/speed is constant).
    const perKnot = b >= 3 && b <= 7 ? S111_SCALE_PER_KNOT : 0
    const konst = s111ArrowScale(probe) - perKnot * probe
    const o = b * S111_BAND_STRIDE
    out[o] = edges[b]!
    out[o + 1] = konst
    out[o + 2] = perKnot
    out[o + 3] = 0
    out[o + 4] = c[0] / 255
    out[o + 5] = c[1] / 255
    out[o + 6] = c[2] / 255
    out[o + 7] = 1
  }
  return out
}

/** The same table, re-expressed in the units the arrow VS actually holds (#1419).
 *
 *  The velocity textures store components divided by the field's peak speed (flow-field-pack.ts
 *  — normalized so f16 error is bounded by the field's own range), so what the shader can cheaply
 *  compute is a magnitude in [0, 1], not knots. Two ways to close that gap: hand the shader the
 *  peak and let it multiply, or hand it a table already in its units. This is the second, because
 *  the first needs a per-batch scalar plumbed into a VS that has no uniform of its own — and a
 *  scale living in two places is how a catalogue revision updates one of them.
 *
 *  The transform is exact and rule-preserving: an edge in knots is `edge / peak` in normalized
 *  units, and `konst + perKnot·speedKnots` is `konst + (perKnot·peak)·speedNorm`. The band a
 *  given speed lands in, and the scale it gets, are unchanged.
 *
 *  `peakSpeed ≤ 0` is a calm or all-nodata field: nothing is symbolized at speed 0 (main.xsl
 *  note 4, enforced in the VS), so the table is returned in knots rather than divided by zero. */
export function s111BandTableNormalized(
  peakSpeed: number,
  uvAspect: number,
  rampName: string = S111_SPEED_RAMP,
): Float32Array {
  const bands = s111BandTable(rampName)
  const out = new Float32Array(S111_BAND_TABLE_ROWS * S111_BAND_STRIDE)
  out.set(bands)
  if (peakSpeed > 0) {
    for (let b = 0; b < S111_BAND_COUNT; b++) {
      const o = b * S111_BAND_STRIDE
      out[o] = bands[o]! / peakSpeed
      out[o + 2] = bands[o + 2]! * peakSpeed
    }
  }
  // The trailing params row. `uvAspect` = trueLonSpan / trueLatSpan (flow-advect-params.ts): a uv
  // unit is a different TRUE distance on each axis, so a velocity in metric east/north components
  // has to be re-expressed in uv rates before the screen basis can turn it into a direction.
  // Without it a northeast current draws at one angle and travels at another, away from the
  // equator most of all.
  out[S111_BAND_PARAMS_ROW * S111_BAND_STRIDE + S111_PARAM_UV_ASPECT] = uvAspect
  return out
}

/** `SVGStyle_S111day.css` `.sCHBLK {stroke:#000000}` — every SCAROW0N symbol strokes its
 *  band-coloured fill with a black outline. Rendered as a proper analytic SDF stroke inside
 *  the shared arrow shader (arrow-retained.ts `stroke_units`), NOT a second offset batch (a
 *  prior "bigger black arrow underneath" attempt was geometrically wrong — the two
 *  independently-scaled quads' head-tapers began at different physical distances from the
 *  tail and flared unevenly; reverted, see #1333 history).
 *
 *  This is a FRACTION of each arrow's own size (loc-space units, the same space `size` scales
 *  qx/qy into) — not a flat px delta — so the border stays proportionally consistent across
 *  every band (thin on the slow-water floor scale, thicker on the fast-water ceiling scale),
 *  rather than looking chunky on small arrows and negligible on large ones. The catalogue's
 *  own literal ratio (0.32mm / 11mm ≈ 0.029) is thinner than is legibly visible at the
 *  smallest on-screen sizes; this value is chosen for on-screen legibility, the same
 *  screen-legibility tradeoff already made for `S111_ARROW_BASE_PX`. */
export const S111_OUTLINE_FRAC = 0.06
