// INC-2 of docs/plans/2026-07-27-line-label-world-anchored-placement.md.
//
// INC-1 world-anchored the viewport-aligned branch; the curved (tangent-rotated)
// branch still started at half a step into whatever the viewport showed. Two
// branches placing the same road on two different lattices is the drift this pins:
// `lineLabelFirstStopPx` is now the single authority both call, and these tests
// assert they agree stop-for-stop rather than trusting that they call the same
// function today.

import { describe, expect, it } from 'vitest'
import { lineLabelFirstStopPx, placeLabelsAlongLine } from './place-labels-along-line'

/** The offsets `placeLabelsAlongLine` emits along a straight run of `len` px. */
function viewportStops(len: number, spacingPx: number, phasePx?: number): number[] {
  const out: number[] = []
  placeLabelsAlongLine(
    new Float32Array([0, len]),
    new Float32Array([0, 0]),
    2,
    spacingPx,
    (pax, _pay, pbx, _pby, t) => out.push(pax + (pbx - pax) * t),
    undefined,
    phasePx,
  )
  return out
}

/** label-pass.ts's curved walk, transcribed: first stop from the shared authority,
 *  then one every `spacingPx` while the offset stays on the run. */
function curvedStops(len: number, spacingPx: number, phasePx?: number): number[] {
  const out: number[] = []
  if (len < spacingPx * 0.5) return [len * 0.5]
  for (let s = lineLabelFirstStopPx(phasePx, spacingPx); s <= len; s += spacingPx) out.push(s)
  return out
}

describe('lineLabelFirstStopPx — the shared world lattice (INC-2)', () => {
  it('falls back to the half-step cadence with no world anchor', () => {
    expect(lineLabelFirstStopPx(undefined, 200)).toBe(100)
  })

  it('folds a raw anchor into [0, spacing)', () => {
    expect(lineLabelFirstStopPx(40, 200)).toBeCloseTo(40, 9)
    expect(lineLabelFirstStopPx(640, 200)).toBeCloseTo(40, 9)
  })

  it('folds a NEGATIVE anchor forward instead of leaving it behind the run', () => {
    // The usual case: the tile entry sits in the MVT buffer, before the run starts.
    // JS `%` keeps the dividend's sign, so the naive form yields −160 and the walk
    // would emit a stop before the polyline begins.
    expect(-160 % 200).toBe(-160) // the trap this guards
    expect(lineLabelFirstStopPx(-160, 200)).toBeCloseTo(40, 9)
    expect(lineLabelFirstStopPx(-160, 200)).toBeGreaterThanOrEqual(0)
  })

  it('treats a non-finite anchor as absent rather than emitting nothing', () => {
    // A NaN first stop makes `nextStop <= total` false forever — the chain would
    // vanish silently instead of falling back.
    expect(lineLabelFirstStopPx(Number.NaN, 200)).toBe(100)
    expect(lineLabelFirstStopPx(Number.POSITIVE_INFINITY, 200)).toBe(100)
  })
})

describe('curved and viewport branches share one lattice (INC-2)', () => {
  const SPACING = 200

  it('emit identical stops for the same world anchor', () => {
    for (const phase of [-460, -160, 0, 40, 137.6, 640]) {
      expect(curvedStops(1000, SPACING, phase)).toEqual(viewportStops(1000, SPACING, phase))
    }
  })

  it('emit identical stops with no world anchor (the historical cadence)', () => {
    expect(curvedStops(1000, SPACING)).toEqual(viewportStops(1000, SPACING))
  })

  it('agree on the short-line midpoint case, anchor or not', () => {
    expect(curvedStops(60, SPACING, 40)).toEqual(viewportStops(60, SPACING, 40))
    expect(curvedStops(60, SPACING)).toEqual(viewportStops(60, SPACING))
  })

  it('agree that a lattice can miss a run entirely — KNOWN GAP, both branches', () => {
    // total = 180 clears the short-line branch (>= 100) but the only lattice stop
    // sits at 190, past the end, so neither branch labels this run. A world lattice
    // genuinely can skip a run; MapLibre re-resamples from the middle when its own
    // resample yields no anchor, and X-GIS does not.
    //
    // Deliberately NOT fixed here. A midpoint retry was implemented and measured: it
    // restores the label but places it where MapLibre puts none, and cost +314 px of
    // MapLibre divergence at z16.0 and +429 px at z16.7/pitch 60 — worse on both the
    // pixel diff and the text-coverage measure than leaving the run unlabelled. The
    // retry only pays once anchors are filtered the way MapLibre filters them
    // (max-angle, does-the-label-fit), which is INC-3/INC-4 territory. This test
    // pins the CURRENT behaviour so the gap is visible rather than forgotten.
    expect(lineLabelFirstStopPx(190, 200)).toBeCloseTo(190, 9)
    expect(curvedStops(180, 200, 190)).toEqual([])
    expect(viewportStops(180, 200, 190)).toEqual([])
  })

  it('place exactly one stop when the lattice does land on a short run', () => {
    expect(curvedStops(180, 200, 40)).toEqual([40])
    expect(viewportStops(180, 200, 40)).toEqual([40])
  })

  it('are pan-invariant together: clipping the run drops stops, never moves them', () => {
    const CLIP = 130
    const full = curvedStops(1000, SPACING, 40)
    // Same world anchor, now measured from the clipped run's own start.
    const clipped = curvedStops(1000 - CLIP, SPACING, 40 - CLIP).map((s) => s + CLIP)
    expect(clipped).toEqual(full.filter((s) => s >= CLIP))
    expect(viewportStops(1000 - CLIP, SPACING, 40 - CLIP).map((s) => s + CLIP)).toEqual(clipped)
  })
})
