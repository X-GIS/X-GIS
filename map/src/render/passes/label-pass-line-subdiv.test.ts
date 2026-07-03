import { describe, it, expect } from 'vitest'
import { lineLabelSubdivSteps } from './label-pass'

// Deep-zoom road-label vanish bug: line-label placement subdivided a segment
// only when it exceeded a METRE threshold (100 km). At high zoom a road segment
// is short in metres but spans the viewport in PIXELS; sampling only its
// endpoints (both off-screen) produced a degenerate (length-0) projected
// polyline and the label silently dropped. The fix subdivides by SCREEN length
// (metres x pxPerMeter). This pins the screen-based count.
//
// fail-before: revert lineLabelSubdivSteps to the metre rule (return 1 when
// segLenM < 1e5) and the high-zoom case below flips from ~26 to 1 (the bug).

const GAP = 96
const MAX = 32

describe('lineLabelSubdivSteps — screen-space line-label subdivision', () => {
  it('high-zoom short-metre / long-pixel segment subdivides (the fix)', () => {
    // z19 "Boulevard des Italiens" segment: ~361 m, ~6.8 px/m => ~2455 px.
    const steps = lineLabelSubdivSteps(361, 6.8, GAP, MAX)
    expect(steps).toBe(Math.min(MAX, Math.ceil((361 * 6.8) / GAP))) // 26
    expect(steps).toBeGreaterThanOrEqual(10) // the metre rule gave 1 -> label dropped
  })

  it('genuinely short on-screen segment resolves to 1 (low-zoom perf preserved)', () => {
    // 5 m at the same zoom = ~34 px < one gap => endpoints only.
    expect(lineLabelSubdivSteps(5, 6.8, GAP, MAX)).toBe(1)
  })

  it('low-zoom world-spanning segment still subdivides (original demotiles purpose)', () => {
    // 10 000 km at z2-ish (~1e-4 px/m) => ~1000 px => subdivided.
    expect(lineLabelSubdivSteps(1e7, 1e-4, GAP, MAX)).toBeGreaterThan(1)
  })

  it('clamps to maxSteps for an extreme screen length', () => {
    expect(lineLabelSubdivSteps(1e9, 6.8, GAP, MAX)).toBe(MAX)
  })

  it('falls back to 1 when pxPerMeter <= 0 (camera centre unprojectable)', () => {
    expect(lineLabelSubdivSteps(361, 0, GAP, MAX)).toBe(1)
    expect(lineLabelSubdivSteps(361, -1, GAP, MAX)).toBe(1)
  })

  it('falls back to 1 for a non-positive gap (guard)', () => {
    expect(lineLabelSubdivSteps(361, 6.8, 0, MAX)).toBe(1)
  })

  it('never returns below 1 even for a zero-length segment', () => {
    expect(lineLabelSubdivSteps(0, 6.8, GAP, MAX)).toBe(1)
  })
})
