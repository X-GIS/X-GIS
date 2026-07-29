// ═══ The rendered-frame clock, as a MEASURABLE quantity (#1468) ═══
//
// `StatsTracker.beginFrame` has always been the single authority for the interval the
// adaptive controller decides on — it just never let anyone else read it. That gap is
// what left the ladder gate asserting on the wall time of two rAF turns, a quantity
// floored at the compositor's 2 × 16.6̄ ms tick and therefore identical (33.4 ms) for a
// 28 794-triangle scene and a 71 790-triangle one.
//
// So `medianFrameMs` is pinned here on the two properties that make it usable as that
// replacement: it is a MEDIAN (one catastrophic frame cannot move it), and it keeps
// measuring while the adaptive controller is switched OFF — the gate's control arm runs
// with `?adaptive=0`, which makes the controller drop every sample it is fed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StatsTracker } from './stats'
import { setAdaptiveQualityEnabled, _resetAdaptiveQualityForTests } from '@xgis/engine'

/** Drive `intervals.length + 1` frames whose gaps are exactly `intervals`. */
function drive(t: StatsTracker, intervals: readonly number[]): void {
  let clock = 1000
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
  t.beginFrame()
  for (const dt of intervals) {
    clock += dt
    t.beginFrame()
  }
  now.mockRestore()
}

describe('StatsTracker.medianFrameMs — the frame-cost signal (#1468)', () => {
  beforeEach(() => _resetAdaptiveQualityForTests())
  afterEach(() => _resetAdaptiveQualityForTests())

  it('is -1 until a second frame has been drawn — one frame has no interval', () => {
    const t = new StatsTracker()
    expect(t.get().medianFrameMs).toBe(-1)
    drive(t, [])
    expect(t.get().medianFrameMs).toBe(-1)
  })

  it('reports the median of the intervals, not the mean', () => {
    const t = new StatsTracker()
    drive(t, [10, 12, 14, 16, 18])
    expect(t.get().medianFrameMs).toBe(14)
  })

  it('one catastrophic frame does not move it (the reason it is a median)', () => {
    // A tab resume / GC pause / style recompile is a single sample, and the ladder must
    // not read it as "this host cannot keep up" — nor may a test reading this signal.
    const t = new StatsTracker()
    drive(t, [10, 10, 5000, 10, 10])
    expect(t.get().medianFrameMs).toBe(10)
  })

  it('keeps only the last 30 intervals, so a settled scene is not held back by its load', () => {
    const t = new StatsTracker()
    drive(t, [...Array<number>(30).fill(900), ...Array<number>(30).fill(20)])
    expect(t.get().medianFrameMs).toBe(20)
  })

  it('THE POINT: it still measures while the adaptive controller is switched OFF', () => {
    // `?adaptive=0` makes `noteFrameInterval` drop every sample. A measurement comparing a
    // pinned arm against a free one needs the same clock running on both sides, which is
    // why this ring lives in stats.ts rather than being read back off the controller.
    setAdaptiveQualityEnabled(false)
    const t = new StatsTracker()
    drive(t, [40, 42, 44])
    expect(t.get().medianFrameMs).toBe(42)
  })
})
