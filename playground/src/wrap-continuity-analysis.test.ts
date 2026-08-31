// #2110 — the wrap-continuity judgement, driven over shapes instead of cameras.
//
// The e2e gate can only reach these shapes by finding a camera that produces them, which
// is how the taper case went unnoticed until it reddened unrelated PRs. Here each shape is
// written down directly, so the two halves the gate must keep apart are pinned by
// construction: #1245's interior break FIRES, a frame-clipped end taper does NOT, and a
// break planted just inside a taper still FIRES (the property a wider cuff would have lost).

import { describe, it, expect } from 'vitest'
import { analyzeStrokeColumns, DIP_FRACTION, END_CUFF } from './wrap-continuity-analysis'

/** Build a column profile: `pad` empty columns, then the given thicknesses. */
function profile(pad: number, ...thickness: number[]): number[] {
  return [...new Array<number>(pad).fill(0), ...thickness]
}

describe('#1245 wrap continuity — the break it exists to catch', () => {
  it("fires on the owner's container signature: a zero column with 1 px stumps either side", () => {
    // median 4, the #1245 repro shape (gaps:[[844,844]], dips:[[843,1],[845,1]]) in
    // miniature: a long even stroke broken in the middle.
    const cols = profile(
      10,
      ...new Array<number>(20).fill(4),
      1,
      0,
      1,
      ...new Array<number>(20).fill(4),
    )
    const a = analyzeStrokeColumns(cols)
    expect(a.median).toBe(4)
    expect(a.gaps.map(([x]) => x)).toEqual([31])
    expect(a.dips.map(([x]) => x)).toEqual([30, 32])
  })

  it('fires on a break planted just INSIDE a taper — the case a wider cuff would blind', () => {
    // A 4 px taper at the left end, then a 1 px break 2 columns further in. The taper is
    // forgiven; the break is not. A cuff big enough to swallow the taper would swallow
    // this too, which is why the rule is shape-based.
    const cols = profile(5, 1, 2, 3, 4, 6, 6, 1, 6, 6, 6, 6, 6, 6)
    const a = analyzeStrokeColumns(cols)
    expect(a.median).toBe(6)
    // the 1 px column sits at index 5 + 6 = 11
    expect(a.dips.map(([x]) => x)).toEqual([11])
  })

  it('still reports a full-column gap in the interior', () => {
    const cols = profile(3, 5, 5, 5, 5, 5, 0, 5, 5, 5, 5, 5)
    const a = analyzeStrokeColumns(cols)
    expect(a.gaps).toEqual([[8, 0]])
  })
})

describe("#2110 — a frame-clipped end's own taper is not a break", () => {
  it('forgives the measured owner-z715 shape: a sub-threshold column at x1 - 2', () => {
    // The shape that reddened PRs touching nothing near the line path, reconstructed from
    // the measured numbers (extent x=[0,678], median 3, dip reported at [676, 1]): a
    // stroke running off the right edge, tapering 3 → 2 → 1, 1, 1. The taper is THREE
    // columns, so the old fixed 2 px cuff did not cover it — the scan's last column
    // (x1 - 2) held 1 px against a threshold of 3 × 0.4 = 1.2 and was called a break.
    // This is the shape the cut must redden: shortening the taper to two columns puts it
    // inside the old cuff and the test stops distinguishing the two rules.
    const cols = profile(0, ...new Array<number>(40).fill(3), 2, 1, 1, 1)
    const a = analyzeStrokeColumns(cols)
    expect(a.median).toBe(3)
    expect(a.x1).toBe(43)
    // x1 - 2 === 41 is the old scan's last column and holds 1 px of taper.
    expect(cols[41]).toBe(1)
    expect(a.dips).toEqual([])
    expect(a.gaps).toEqual([])
  })

  it('forgives a taper at the LEFT end too — the rule is symmetric', () => {
    // Mirrored, and again three columns wide so x0 + 2 lands inside the taper.
    const cols = profile(4, 1, 1, 1, 2, ...new Array<number>(40).fill(3))
    const a = analyzeStrokeColumns(cols)
    expect(a.x0).toBe(4)
    expect(cols[6]).toBe(1)
    expect(a.dips).toEqual([])
  })

  it('does NOT forgive a non-monotone end — 1, 3, 1 is not a taper', () => {
    // Thickness that drops back down after growing is not a stroke running off the frame;
    // the walk stops at the reversal and the gate keeps looking. This one fires under both
    // the old and the new rule — it is the negative control that proves the taper skip did
    // not simply widen the blind spot.
    const cols = profile(2, 1, 3, 1, ...new Array<number>(40).fill(4))
    const a = analyzeStrokeColumns(cols)
    expect(a.median).toBe(4)
    expect(a.dips.map(([x]) => x)).toEqual([4])
  })
})

describe('the analysis contract itself', () => {
  it('reports an absent stroke without inventing an extent', () => {
    expect(analyzeStrokeColumns([0, 0, 0])).toEqual({
      x0: -1,
      x1: -1,
      median: 0,
      gaps: [],
      dips: [],
      strokeCols: 0,
    })
  })

  it('counts every struck column, so the gate can prove it saw a stroke at all', () => {
    const cols = profile(6, 4, 4, 0, 4)
    expect(analyzeStrokeColumns(cols).strokeCols).toBe(3)
  })

  it('keeps #1245 sensitivity constants unchanged — this change moves the shape rule only', () => {
    expect(DIP_FRACTION).toBe(0.4)
    expect(END_CUFF).toBe(2)
  })
})
