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
  adaptiveFarLodBoost,
  adaptiveQualityStep,
  setAdaptiveQualityEnabled,
  isAdaptiveQualityEnabled,
  _resetAdaptiveQualityForTests,
} from './adaptive-quality'

/** Feed `n` frames of `ms` and report how many times the scale changed. */
function feed(ms: number, n: number): number {
  let changes = 0
  for (let i = 0; i < n; i++) if (noteFrameInterval(ms)) changes++
  return changes
}

const FAST = 8 // ~120 fps — comfortably under the restore bar
const OK = 25 // between the two thresholds — the hysteresis dead zone
const SLOW = 60 // ~16 fps — over the degrade bar

beforeEach(() => _resetAdaptiveQualityForTests())

describe('adaptive DPR — never engages on a host that keeps up', () => {
  it('a 60 fps stream never leaves scale 1', () => {
    expect(feed(16, 600)).toBe(0)
    expect(adaptiveDprScale()).toBe(1)
    expect(adaptiveQualityStep()).toBe(0)
  })

  it('a stream inside the hysteresis dead zone never moves', () => {
    expect(feed(OK, 600)).toBe(0)
    expect(adaptiveDprScale()).toBe(1)
  })

  it('a short burst of bad frames is not enough — the window must fill', () => {
    // Fewer than one window of slow frames, then healthy again.
    feed(SLOW, 6)
    feed(FAST, 6)
    expect(adaptiveQualityStep()).toBe(0)
  })

  it('one catastrophic frame cannot move a healthy stream (median, not mean)', () => {
    for (let round = 0; round < 40; round++) {
      feed(FAST, 11)
      noteFrameInterval(5000) // a GC pause / tab resume
    }
    expect(adaptiveQualityStep()).toBe(0)
  })
})

describe('adaptive DPR — degrades under sustained overload, and stops at the floor', () => {
  it('a sustained slow stream steps QUALITY down monotonically, one notch per window', () => {
    // Stated over the ladder, not over DPR alone: the early notches spend far-field LOD
    // and leave DPR at 1 on purpose (see the LOD-before-pixels suite below), so "DPR
    // strictly decreases every notch" is no longer the invariant — "every notch is
    // strictly worse in at least one lever, and better in neither" is.
    let prev = { lod: adaptiveFarLodBoost(), dpr: adaptiveDprScale() }
    for (let i = 0; i < 4; i++) {
      feed(SLOW, 12)
      const now = { lod: adaptiveFarLodBoost(), dpr: adaptiveDprScale() }
      expect(now.lod).toBeGreaterThanOrEqual(prev.lod)
      expect(now.dpr).toBeLessThanOrEqual(prev.dpr)
      expect(now.lod > prev.lod || now.dpr < prev.dpr).toBe(true)
      prev = now
    }
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
    expect(adaptiveQualityStep()).toBe(1)
  })
})

describe('adaptive DPR — recovers, and cannot oscillate', () => {
  it('restores step by step once the host is comfortably fast again', () => {
    feed(SLOW, 12 * 4)
    const degraded = adaptiveQualityStep()
    expect(degraded).toBeGreaterThan(0)
    feed(FAST, 12 * 10)
    expect(adaptiveQualityStep()).toBe(0)
    expect(adaptiveDprScale()).toBe(1)
  })

  it('a stream sitting between the thresholds SETTLES — the hysteresis gap holds', () => {
    // Degrade first, then hand it a stream that is neither slow nor fast. A
    // single-threshold controller would hunt here forever.
    feed(SLOW, 12)
    const settled = adaptiveQualityStep()
    expect(feed(OK, 12 * 500)).toBe(0)
    expect(adaptiveQualityStep()).toBe(settled)
  })

  it('the window is cleared on every change — stale samples cannot reverse it', () => {
    // Exactly one window of slow frames degrades once. If the samples that caused
    // the degrade survived, the very next fast frame would sit in a window still
    // dominated by them; assert instead that a restore needs a FULL fresh window.
    feed(SLOW, 12)
    expect(adaptiveQualityStep()).toBe(1)
    for (let i = 0; i < 11; i++) expect(noteFrameInterval(FAST)).toBe(false)
    expect(adaptiveQualityStep()).toBe(1) // 11 fast frames: not yet a full window
    expect(noteFrameInterval(FAST)).toBe(true) // the 12th completes it
    expect(adaptiveQualityStep()).toBe(0)
  })

  it('alternating slow/fast phases end where the host actually is', () => {
    for (let i = 0; i < 6; i++) {
      feed(SLOW, 12 * 3)
      feed(FAST, 12 * 6)
    }
    expect(adaptiveQualityStep()).toBe(0)
    feed(SLOW, 12 * 8)
    expect(adaptiveQualityStep()).toBeGreaterThan(0)
  })
})

// The ORDER the ladder spends quality in is a product decision, not an implementation
// detail: coarsening the horizon is close to invisible, blurring the frame is not. If a
// future edit reorders the ladder, these fail — which is the point.
describe('adaptive quality — the ladder spends far-field LOD before device pixels', () => {
  it('the first degrade coarsens the far field and leaves DPR untouched', () => {
    feed(SLOW, 12)
    expect(adaptiveQualityStep()).toBe(1)
    expect(adaptiveFarLodBoost()).toBeGreaterThan(1)
    expect(adaptiveDprScale()).toBe(1)
  })

  it('DPR only moves after the LOD lever has been spent', () => {
    let firstDprMove = -1
    let lodAtFirstDprMove = -1
    for (let notch = 1; notch < 20; notch++) {
      feed(SLOW, 12)
      if (adaptiveDprScale() < 1) {
        firstDprMove = adaptiveQualityStep()
        lodAtFirstDprMove = adaptiveFarLodBoost()
        break
      }
    }
    expect(firstDprMove).toBeGreaterThan(1) // not the first notch
    expect(lodAtFirstDprMove).toBeGreaterThan(1) // and LOD was already spent
  })

  it('neither lever ever moves the wrong way as the ladder descends', () => {
    let lod = adaptiveFarLodBoost()
    let dpr = adaptiveDprScale()
    for (let i = 0; i < 12; i++) {
      feed(SLOW, 12)
      expect(adaptiveFarLodBoost()).toBeGreaterThanOrEqual(lod) // coarser or equal
      expect(adaptiveDprScale()).toBeLessThanOrEqual(dpr) // smaller or equal
      lod = adaptiveFarLodBoost()
      dpr = adaptiveDprScale()
    }
  })

  it('both levers are bounded, however long the overload lasts', () => {
    feed(SLOW, 12 * 200)
    expect(adaptiveDprScale()).toBeGreaterThanOrEqual(0.5)
    // The selector clamps the boosted ceiling to its own 24 px top, but the ladder must
    // not hand it an absurd multiplier to clamp in the first place.
    expect(adaptiveFarLodBoost()).toBeLessThanOrEqual(8)
  })

  it('recovery restores BOTH levers, in reverse — DPR back first, LOD last', () => {
    feed(SLOW, 12 * 20)
    expect(adaptiveDprScale()).toBeLessThan(1)
    // Climb back one notch at a time and record when each lever returns to pristine.
    let dprRestoredAt = -1
    let lodRestoredAt = -1
    for (let i = 0; i < 20 && adaptiveQualityStep() > 0; i++) {
      feed(FAST, 12)
      if (dprRestoredAt < 0 && adaptiveDprScale() === 1) dprRestoredAt = i
      if (lodRestoredAt < 0 && adaptiveFarLodBoost() === 1) lodRestoredAt = i
    }
    expect(adaptiveQualityStep()).toBe(0)
    expect(dprRestoredAt).toBeGreaterThanOrEqual(0)
    expect(lodRestoredAt).toBeGreaterThan(dprRestoredAt)
  })

  it('an untouched controller is a no-op for BOTH levers — selection stays byte-identical', () => {
    expect(adaptiveFarLodBoost()).toBe(1)
    expect(adaptiveDprScale()).toBe(1)
    setAdaptiveQualityEnabled(false)
    feed(SLOW, 12 * 50)
    expect(adaptiveFarLodBoost()).toBe(1)
    expect(adaptiveDprScale()).toBe(1)
  })
})

describe('adaptive DPR — opt-out and input hygiene', () => {
  it('disabled: every sample is dropped and the scale is pinned at 1', () => {
    setAdaptiveQualityEnabled(false)
    expect(isAdaptiveQualityEnabled()).toBe(false)
    expect(feed(SLOW, 12 * 50)).toBe(0)
    expect(adaptiveDprScale()).toBe(1)
  })

  it('re-enabling starts from a clean slate, not the pre-disable state', () => {
    feed(SLOW, 12 * 4)
    expect(adaptiveQualityStep()).toBeGreaterThan(0)
    setAdaptiveQualityEnabled(false)
    expect(adaptiveQualityStep()).toBe(0)
    setAdaptiveQualityEnabled(true)
    expect(adaptiveDprScale()).toBe(1)
  })

  it('clock artifacts (0, negative, NaN, Infinity) are ignored, not sampled', () => {
    for (const bad of [0, -1, -1000, NaN, Infinity]) {
      expect(noteFrameInterval(bad)).toBe(false)
    }
    expect(adaptiveQualityStep()).toBe(0)
    // …and they did not partially fill the window either: a full slow window still
    // takes exactly 12 samples to act.
    for (let i = 0; i < 11; i++) expect(noteFrameInterval(SLOW)).toBe(false)
    expect(noteFrameInterval(SLOW)).toBe(true)
  })
})

// ═══ #1567 — per-source sample windows, one shared notch ═══════════════════
//
// Two concurrent maps are a supported configuration, and they used to interleave
// their frame intervals into ONE 12-slot ring. The median then described neither
// map: a fast map could fill the window with its own good frames and deny a
// struggling sibling the degrade it needed. The NOTCH stays process-global — that
// is documented and deliberate (adaptive-quality.ts header) — only the window is
// per-source now.
describe('#1567 per-source sample windows', () => {
  beforeEach(() => {
    _resetAdaptiveQualityForTests()
  })

  it('a fast sibling cannot deny a slow map its degrade', () => {
    const slowMap = {}
    const fastMap = {}
    // Interleave: one slow frame, one fast frame, twelve times each. Under the old
    // shared ring the window holds 6 slow + 6 fast and the lower-middle median is
    // FAST — the slow map never degrades. Per-source, the slow map's own window
    // fills with slow frames and it degrades on its 12th.
    let slowChanges = 0
    for (let i = 0; i < 12; i++) {
      if (noteFrameInterval(SLOW, slowMap)) slowChanges++
      noteFrameInterval(FAST, fastMap)
    }
    expect(slowChanges, 'the slow map must act on its OWN twelve frames').toBe(1)
    expect(adaptiveQualityStep()).toBe(1)
  })

  it('one source filling its window does not fill another source-s', () => {
    const a = {}
    const b = {}
    // 11 samples into A — one short of a decision.
    for (let i = 0; i < 11; i++) expect(noteFrameInterval(SLOW, a)).toBe(false)
    // B is untouched, so its first 11 must also decide nothing. If the rings were
    // shared, B's very first sample would complete A's window and act here.
    for (let i = 0; i < 11; i++) expect(noteFrameInterval(SLOW, b)).toBe(false)
    expect(adaptiveQualityStep(), 'neither window is full yet').toBe(0)
    expect(noteFrameInterval(SLOW, b), 'B-s twelfth completes B-s own window').toBe(true)
  })

  it('a notch change clears EVERY source window, not just the one that moved', () => {
    const a = {}
    const b = {}
    // Fill B to 11 slow samples, then let A trigger a degrade.
    for (let i = 0; i < 11; i++) noteFrameInterval(SLOW, b)
    for (let i = 0; i < 12; i++) noteFrameInterval(SLOW, a)
    expect(adaptiveQualityStep(), 'A degraded').toBe(1)
    // B's 11 pre-change samples were measured at the OLD notch. If they survived,
    // B's next single sample would complete a full slow window and degrade again
    // immediately — header property 2 violated across sources.
    expect(noteFrameInterval(SLOW, b), 'B-s stale window must have been cleared').toBe(false)
    expect(adaptiveQualityStep()).toBe(1)
  })

  it('the notch itself stays process-global across sources', () => {
    const a = {}
    const b = {}
    for (let i = 0; i < 12; i++) noteFrameInterval(SLOW, a)
    expect(adaptiveQualityStep()).toBe(1)
    // B never fed a sample, but it reads the SAME learned notch — this is the
    // host-capability semantics the file header requires, and it must survive the
    // per-source split.
    for (let i = 0; i < 12; i++) noteFrameInterval(SLOW, b)
    expect(adaptiveQualityStep(), 'B stepped down from A-s notch, not from 0').toBe(2)
    expect(adaptiveDprScale()).toBe(1) // notch 2 is still a pure-LOD rung
  })
})
