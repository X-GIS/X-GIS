// INC-1 of docs/plans/2026-07-27-line-label-world-anchored-placement.md — the
// along-line walk anchors its chain to a WORLD origin, not to wherever the
// projected run happens to start.
//
// MapLibre lays line symbols out on the tile-clipped line, so its anchors sit at
// `tileEntry + k · symbol-spacing`. X-GIS walked from `spacingPx * 0.5` of the
// VISIBLE run instead, so the whole chain slid with the viewport — measured as a
// ~119 px phase error against MapLibre on OFM Positron at
// #16.7/37.79172/126.79102, exactly the MVT buffer overhang of the tile the
// shields came from.
//
// The property that matters is pan-invariance: clipping the run must not move the
// surviving anchors. These tests state it directly.

import { describe, expect, it } from 'vitest'
import { placeLabelsAlongLine } from './place-labels-along-line'

/** Straight horizontal polyline from x=0 to x=len at y=0, one segment. */
function straight(len: number): { px: Float32Array; py: Float32Array; pn: number } {
  return { px: new Float32Array([0, len]), py: new Float32Array([0, 0]), pn: 2 }
}

/** Along-line offsets of every stop the walk emits. */
function stops(
  px: Float32Array,
  py: Float32Array,
  pn: number,
  spacingPx: number,
  phasePx?: number,
): number[] {
  const out: number[] = []
  placeLabelsAlongLine(
    px,
    py,
    pn,
    spacingPx,
    (pax, pay, pbx, pby, t) => {
      out.push(Math.hypot(pax + (pbx - pax) * t, pay + (pby - pay) * t))
    },
    undefined,
    phasePx,
  )
  return out
}

describe('placeLabelsAlongLine — world-anchored phase (INC-1)', () => {
  it('walks from spacingPx * 0.5 when no phase is supplied (historical cadence)', () => {
    const { px, py, pn } = straight(1000)
    expect(stops(px, py, pn, 200)).toEqual([100, 300, 500, 700, 900])
  })

  it('walks from the supplied phase instead of the half-step default', () => {
    const { px, py, pn } = straight(1000)
    expect(stops(px, py, pn, 200, 40)).toEqual([40, 240, 440, 640, 840])
  })

  it('folds a phase larger than one step into the same lattice', () => {
    const { px, py, pn } = straight(1000)
    // 640 ≡ 40 (mod 200) — adding whole steps cannot move the emitted set.
    expect(stops(px, py, pn, 200, 640)).toEqual(stops(px, py, pn, 200, 40))
  })

  it('folds a NEGATIVE phase (anchor behind the run start) into [0, spacing)', () => {
    const { px, py, pn } = straight(1000)
    // The tile entry commonly sits BEHIND the projected run's first sample, so the
    // caller's `tileEntry - headSkip` is negative. JS `%` keeps the sign; a raw
    // `-160 % 200 = -160` would walk from a negative offset and emit a phantom
    // stop before the polyline.
    expect(stops(px, py, pn, 200, -160)).toEqual([40, 240, 440, 640, 840])
    expect(stops(px, py, pn, 200, -160).every((s) => s >= 0)).toBe(true)
  })

  it('is pan-invariant: clipping the run leaves the surviving anchors in place', () => {
    // The whole point of INC-1. A road whose visible run starts 130 px later must
    // keep the SAME world anchors, only fewer of them. Without the phase the
    // clipped run restarts at its own half-step and every anchor slides.
    const SPACING = 200
    const full = straight(1000)
    const fullStops = stops(full.px, full.py, full.pn, SPACING, 40)

    const CLIP = 130
    const clipped = {
      px: new Float32Array([CLIP, 1000]),
      py: new Float32Array([0, 0]),
      pn: 2,
    }
    // Same world origin, now measured from the clipped run's start.
    const clippedStops = stops(clipped.px, clipped.py, clipped.pn, SPACING, 40 - CLIP).map(
      (s) => s, // `stops` already reports absolute x here (run starts at x = CLIP)
    )
    expect(clippedStops).toEqual(fullStops.filter((s) => s >= CLIP))
  })

  it('ignores a non-finite phase rather than collapsing the chain to NaN', () => {
    const { px, py, pn } = straight(1000)
    expect(stops(px, py, pn, 200, Number.NaN)).toEqual(stops(px, py, pn, 200))
  })

  it('leaves the short-line / line-center midpoint case untouched', () => {
    // total (60) < spacingPx * 0.5 (100) → one label at the midpoint, phase or not.
    const { px, py, pn } = straight(60)
    expect(stops(px, py, pn, 200, 40)).toEqual([30])
    expect(stops(px, py, pn, 0, 40)).toEqual([30])
  })

  it('spans segment boundaries on a multi-segment polyline', () => {
    // Dog-leg: 300 px east, then 300 px north. Stops keep their ARC-length cadence
    // across the corner even though straight-line distance from the origin does not.
    const px = new Float32Array([0, 300, 300])
    const py = new Float32Array([0, 0, -300])
    const arc: number[] = []
    placeLabelsAlongLine(
      px,
      py,
      3,
      200,
      (pax, pay, pbx, pby, t) => {
        const x = pax + (pbx - pax) * t
        const y = pay + (pby - pay) * t
        arc.push(x + Math.abs(y)) // arc length on this L-shape
      },
      undefined,
      40,
    )
    expect(arc).toEqual([40, 240, 440])
  })
})
