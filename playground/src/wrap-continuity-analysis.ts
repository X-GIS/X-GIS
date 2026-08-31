// ═══ #1245 wrap-continuity: what counts as a break in a column profile (#2110) ═══
//
// `playground/e2e/_1245-wrap-continuity-sweep.spec.ts` reads the stroke's per-column
// thickness off a GL frame and asks whether the wrapped continuation is continuous. The
// READING is a GPU job and stays in the page; the JUDGEMENT is pure arithmetic over a
// number[], so it lives here where a unit test can drive it over shapes no camera has to
// be found for — including the one that made the gate red on trees that had not touched
// the line path at all (#2110).
//
// THE DISTINCTION THIS FILE EXISTS TO DRAW. The gate's own signature (#1245, measured in
// the owner's container repro at z5/cam180) is `gaps:[[844,844]], dips:[[843,1],[845,1]]`
// against a median of 4: a zero column with one-pixel stumps either side, sitting in the
// INTERIOR of the stroke. A frame-CLIPPED end produces thin columns too — the stroke's
// antialiased taper running out at the frame edge — and those are not breaks.
//
// The previous rule separated them by POSITION: skip a fixed 2 px cuff at each visible
// end. That fails because the taper is not 2 px wide at every camera. Measured at
// `owner-z715`: extent `x=[0,678]`, median 3, so the scan's last column is `x1 - 2 = 676`
// and the threshold is 1.2 — and column 676 holds exactly 1 px of taper, so the gate
// reported a break where the stroke was merely running off the frame. Sub-pixel camera
// state decides whether that column lands at 1 or 2, which is why it was intermittent and
// why the reported x wandered between 675 and 676 between attempts.
//
// The rule here separates them by SHAPE instead, which is the property that actually
// differs: a clipped end is a MONOTONE run of sub-threshold columns reaching the visible
// edge, while a real break is a local minimum with full-thickness stroke on both sides.
// Widening the cuff would have bought the same green by blinding the gate to a one-column
// discontinuity near the end — the exact defect #1245 exists to catch — so it is rejected;
// `wrap-continuity-analysis.test.ts` pins both halves (the #1245 shape still fires, the
// taper does not, and a break planted just inside a taper still fires).

/** Per-column stroke thickness, `cols[x]` = struck pixels in column `x`. */
export type ColumnProfile = readonly number[]

export interface StrokeAnalysis {
  /** First and last struck column, or `-1` when the stroke is absent. */
  x0: number
  x1: number
  /** Median thickness over struck columns; `0` when the stroke is absent. */
  median: number
  /** `[x, thickness]` for a zero column flanked by struck ones. */
  gaps: [number, number][]
  /** `[x, thickness]` for a sub-`DIP_FRACTION` local minimum (never an end taper). */
  dips: [number, number][]
  /** How many columns hold any stroke — the non-vacuity measure. */
  strokeCols: number
}

/** A column thinner than this fraction of the median is a candidate break. MapLibre has no
 *  equivalent; the value is #1245's own, kept as-is so this change moves the SHAPE rule
 *  only and cannot be confused with a sensitivity change. */
export const DIP_FRACTION = 0.4

/** Columns at each visible end that are skipped unconditionally — the residual
 *  frame-clip AA cuff #1245 shipped with. Kept because it costs nothing once the taper
 *  rule below is doing the real work, and removing it would be a second change riding
 *  along with this one. */
export const END_CUFF = 2

/** Walk inward from a visible end across the stroke's own taper: sub-threshold columns
 *  that only ever get thicker as they move inward. The first column that is at or above
 *  the threshold, or that dips back down, ends the run — a non-monotone end is not a
 *  taper and stays under the gate's eye.
 *
 *  `step` is +1 walking right from `x0` and −1 walking left from `x1`. Returns the first
 *  index that is NOT part of the taper. */
function taperEnd(
  cols: ColumnProfile,
  from: number,
  to: number,
  step: number,
  thr: number,
): number {
  let x = from
  let prev = -1
  while (step > 0 ? x <= to : x >= to) {
    const n = cols[x]!
    if (n >= thr) break
    if (prev >= 0 && n < prev) break
    prev = n
    x += step
  }
  return x
}

/** Judge a column profile. Pure — the GL readback happens in the page, this decides. */
export function analyzeStrokeColumns(cols: ColumnProfile): StrokeAnalysis {
  let x0 = -1
  let x1 = -1
  for (let x = 0; x < cols.length; x++) {
    if (cols[x]! > 0) {
      if (x0 < 0) x0 = x
      x1 = x
    }
  }
  if (x0 < 0) return { x0: -1, x1: -1, median: 0, gaps: [], dips: [], strokeCols: 0 }

  const struck = cols
    .slice(x0, x1 + 1)
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
  const median = struck[Math.floor(struck.length / 2)] ?? 0
  const thr = median * DIP_FRACTION

  // The interior: past the fixed cuff AND past each end's own taper.
  const lead = Math.max(x0 + END_CUFF, taperEnd(cols, x0, x1, 1, thr))
  const trail = Math.min(x1 - END_CUFF, taperEnd(cols, x1, x0, -1, thr))

  const gaps: [number, number][] = []
  const dips: [number, number][] = []
  for (let x = lead; x <= trail; x++) {
    const n = cols[x]!
    if (n === 0 && cols[x - 1]! > 0 && cols[x + 1]! > 0) gaps.push([x, n])
    if (n > 0 && median > 0 && n < thr) dips.push([x, n])
  }

  let strokeCols = 0
  for (let x = x0; x <= x1; x++) if (cols[x]! > 0) strokeCols++

  return { x0, x1, median, gaps: gaps.slice(0, 20), dips: dips.slice(0, 20), strokeCols }
}
