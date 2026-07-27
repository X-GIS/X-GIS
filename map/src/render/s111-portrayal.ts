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
