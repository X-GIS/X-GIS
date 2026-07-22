import { describe, it, expect } from 'vitest'
import { pitchGestureDecision } from './controller'

// Two-finger pitch/pinch disambiguation hysteresis — fixes "lowering pitch on
// mobile is hard": incidental finger-distance wobble (worse when the fingers
// converge, i.e. dragging DOWN to lower pitch) used to fail the strict 2×
// dominance test EVERY noisy frame, stuttering the tilt back into pinch-zoom.
// Hysteresis: strict to ENTER, relaxed to STAY.

describe('pitchGestureDecision — two-finger pitch/pinch hysteresis', () => {
  it('strict ENTRY: a parallel vertical drag dominating distChange 2× engages + applies', () => {
    expect(pitchGestureDecision(5, 1, false)).toEqual({ apply: true, engaged: true })
  })

  it('strict ENTRY: a pinch (distChange dominating) never hijacks into pitch', () => {
    expect(pitchGestureDecision(3, 4, false)).toEqual({ apply: false, engaged: false })
    // A moderate vertical move that fails the 2× bar also stays pinch.
    expect(pitchGestureDecision(4, 3, false)).toEqual({ apply: false, engaged: false })
  })

  it('HYSTERESIS: once engaged, a wobble frame (distChange < centreMove < 2×) KEEPS pitching', () => {
    // THE FIX. fail-before: the strict test alone (4 > 3*2 → false) dropped the
    // tilt on this exact frame every time the fingers wobbled; pass-after: an
    // engaged tilt rides through it, so a sustained lower-pitch drag lands.
    expect(pitchGestureDecision(4, 3, true)).toEqual({ apply: true, engaged: true })
    expect(pitchGestureDecision(2, 1.5, true)).toEqual({ apply: true, engaged: true })
  })

  it('engaged DISENGAGES when a real pinch takes over (distChange dominates)', () => {
    expect(pitchGestureDecision(1, 5, true)).toEqual({ apply: false, engaged: false })
  })

  it('no vertical intent (centreMove ≤ 1) never pitches, engaged or not', () => {
    expect(pitchGestureDecision(0.5, 0, true)).toEqual({ apply: false, engaged: false })
    expect(pitchGestureDecision(1, 0, false)).toEqual({ apply: false, engaged: false })
  })

  it('is symmetric in direction — the sign of the drag lives in dy, not here', () => {
    // Both raising and lowering pass the same |centreMove| test; the fix helps
    // lowering because that is where the wobble is worst, not via any asymmetry.
    const up = pitchGestureDecision(4, 3, true)
    const down = pitchGestureDecision(4, 3, true)
    expect(up).toEqual(down)
  })
})
