// ═══ Official IHO S-111 surface-current arrow portrayal — rule authority ═══
//
// Single-authority transcription of the vendored catalogue at `docs/standards/s-111/`
// (`portrayal/XSLT/Rules/select_arrow.xsl`, `Rules/main.xsl`). The band COLOURS are NOT
// duplicated here — they live in `BANDED_RAMPS['s111-speed']` (color-ramp.ts), the exact
// palette the GPU coverage fill bakes into its LUT (verbatim from the catalogue's
// `colorProfile.xml` / `SVGStyle_S111day.css`). This module owns only what the fill palette
// does NOT carry: the per-band arrow SCALE, the placement rule, and the black outline.
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

/** `SVGStyle_S111day.css` `.sCHBLK { stroke:#000000 }` — the black outline every SCAROW0N
 *  symbol strokes its band-coloured fill with (0.32 mm in the catalogue's viewBox units). */
export const S111_OUTLINE_COLOR: readonly [number, number, number] = [0, 0, 0]

/** Outline thickness (px, each side) drawn as a black arrow UNDER the coloured fill (the
 *  arrow primitive has no native stroke — see graphics-types.ts `ArrowDrawSpec`, solid fill
 *  only). A CONSTANT px delta rather than the catalogue's literal mm-proportional stroke
 *  (0.32/11 ≈ 2.9% of the symbol) — at the smallest on-screen arrows that ratio is
 *  sub-pixel and invisible; a fixed px keeps the outline legible at every band, the same
 *  screen-legibility tradeoff already made for `S111_ARROW_BASE_PX`. */
export const S111_OUTLINE_STROKE_PX = 1.5

/** The OUTLINE arrow's length (px): the fill length plus the stroke on both ends. Draw this
 *  batch FIRST (black, larger) and the fill batch SECOND (coloured, `s111ArrowLengthPx`) so
 *  the fill composites on top — the retained-arrow draper has no depth test, so draw order
 *  is the stacking order (graphics-manager.ts `renderRetained`). */
export function s111ArrowOutlineLengthPx(
  speedKnots: number,
  basePx: number = S111_ARROW_BASE_PX,
): number {
  return s111ArrowLengthPx(speedKnots, basePx) + 2 * S111_OUTLINE_STROKE_PX
}
