// ═══ Adaptive resolution scaling — control-law gate ═══
//
// The controller changes what every user sees, so its safety properties are proven
// here rather than trusted: it must never engage on a healthy host, never oscillate,
// never fall below its floor, and always recover when the host does. The law is a
// pure function of a sample stream, so these are exhaustive over the behaviours that
// matter — no GPU, no timing flake.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  noteFrameInterval,
  adaptiveDprScale,
  adaptiveDprStep,
  setAdaptiveDprEnabled,
  isAdaptiveDprEnabled,
  _resetAdaptiveDprForTests,
} from './adaptive-dpr'

/** Feed `n` frames of `ms` and report how many times the scale changed. */
function feed(ms: number, n: number): number {
  let changes = 0
  for (let i = 0; i < n; i++) if (noteFrameInterval(ms)) changes++
  return changes
}

const FAST = 8 // ~120 fps — comfortably under the restore bar
const OK = 25 // between the two thresholds — the hysteresis dead zone
const SLOW = 60 // ~16 fps — over the degrade bar

beforeEach(() => _resetAdaptiveDprForTests())

describe('adaptive DPR — never engages on a host that keeps up', () => {
  it('a 60 fps stream never leaves scale 1', () => {
    expect(feed(16, 600)).toBe(0)
    expect(adaptiveDprScale()).toBe(1)
    expect(adaptiveDprStep()).toBe(0)
  })

  it('a stream inside the hysteresis dead zone never moves', () => {
    expect(feed(OK, 600)).toBe(0)
    expect(adaptiveDprScale()).toBe(1)
  })

  it('a short burst of bad frames is not enough — the window must fill', () => {
    // Fewer than one window of slow frames, then healthy again.
    feed(SLOW, 6)
    feed(FAST, 6)
    expect(adaptiveDprStep()).toBe(0)
  })

  it('one catastrophic frame cannot move a healthy stream (median, not mean)', () => {
    for (let round = 0; round < 40; round++) {
      feed(FAST, 11)
      noteFrameInterval(5000) // a GC pause / tab resume
    }
    expect(adaptiveDprStep()).toBe(0)
  })
})

describe('adaptive DPR — degrades under sustained overload, and stops at the floor', () => {
  it('a sustained slow stream steps the scale down monotonically', () => {
    const seen: number[] = [adaptiveDprScale()]
    for (let i = 0; i < 4; i++) {
      feed(SLOW, 12)
      seen.push(adaptiveDprScale())
    }
    // Strictly decreasing, one notch per full window.
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeLessThan(seen[i - 1]!)
  })

  it('never falls below the floor, however long the overload lasts', () => {
    feed(SLOW, 12 * 200)
    const floor = adaptiveDprScale()
    expect(floor).toBeGreaterThan(0)
    expect(floor).toBeGreaterThanOrEqual(0.5)
    // Still pinned after yet more overload — no runaway.
    feed(SLOW, 12 * 200)
    expect(adaptiveDprScale()).toBe(floor)
  })

  it('a degrade costs at most one notch per window — no multi-step lurch', () => {
    expect(feed(SLOW, 12)).toBe(1)
    expect(adaptiveDprStep()).toBe(1)
  })
})

describe('adaptive DPR — recovers, and cannot oscillate', () => {
  it('restores step by step once the host is comfortably fast again', () => {
    feed(SLOW, 12 * 4)
    const degraded = adaptiveDprStep()
    expect(degraded).toBeGreaterThan(0)
    feed(FAST, 12 * 10)
    expect(adaptiveDprStep()).toBe(0)
    expect(adaptiveDprScale()).toBe(1)
  })

  it('a stream sitting between the thresholds SETTLES — the hysteresis gap holds', () => {
    // Degrade first, then hand it a stream that is neither slow nor fast. A
    // single-threshold controller would hunt here forever.
    feed(SLOW, 12)
    const settled = adaptiveDprStep()
    expect(feed(OK, 12 * 500)).toBe(0)
    expect(adaptiveDprStep()).toBe(settled)
  })

  it('the window is cleared on every change — stale samples cannot reverse it', () => {
    // Exactly one window of slow frames degrades once. If the samples that caused
    // the degrade survived, the very next fast frame would sit in a window still
    // dominated by them; assert instead that a restore needs a FULL fresh window.
    feed(SLOW, 12)
    expect(adaptiveDprStep()).toBe(1)
    for (let i = 0; i < 11; i++) expect(noteFrameInterval(FAST)).toBe(false)
    expect(adaptiveDprStep()).toBe(1) // 11 fast frames: not yet a full window
    expect(noteFrameInterval(FAST)).toBe(true) // the 12th completes it
    expect(adaptiveDprStep()).toBe(0)
  })

  it('alternating slow/fast phases end where the host actually is', () => {
    for (let i = 0; i < 6; i++) {
      feed(SLOW, 12 * 3)
      feed(FAST, 12 * 6)
    }
    expect(adaptiveDprStep()).toBe(0)
    feed(SLOW, 12 * 8)
    expect(adaptiveDprStep()).toBeGreaterThan(0)
  })
})

describe('adaptive DPR — opt-out and input hygiene', () => {
  it('disabled: every sample is dropped and the scale is pinned at 1', () => {
    setAdaptiveDprEnabled(false)
    expect(isAdaptiveDprEnabled()).toBe(false)
    expect(feed(SLOW, 12 * 50)).toBe(0)
    expect(adaptiveDprScale()).toBe(1)
  })

  it('re-enabling starts from a clean slate, not the pre-disable state', () => {
    feed(SLOW, 12 * 4)
    expect(adaptiveDprStep()).toBeGreaterThan(0)
    setAdaptiveDprEnabled(false)
    expect(adaptiveDprStep()).toBe(0)
    setAdaptiveDprEnabled(true)
    expect(adaptiveDprScale()).toBe(1)
  })

  it('clock artifacts (0, negative, NaN, Infinity) are ignored, not sampled', () => {
    for (const bad of [0, -1, -1000, NaN, Infinity]) {
      expect(noteFrameInterval(bad)).toBe(false)
    }
    expect(adaptiveDprStep()).toBe(0)
    // …and they did not partially fill the window either: a full slow window still
    // takes exactly 12 samples to act.
    for (let i = 0; i < 11; i++) expect(noteFrameInterval(SLOW)).toBe(false)
    expect(noteFrameInterval(SLOW)).toBe(true)
  })
})
