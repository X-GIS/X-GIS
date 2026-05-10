import { describe, expect, it } from 'vitest'
import { interpolateTime, interpolateTimeColor, type Easing } from '../engine/render/renderer'

// ═══ interpolateTime: time-axis sibling of interpolateZoom ═══
//
// These tests cover the linear segment-lookup logic plus the four supported
// easing functions, loop wraparound, clamping when loop is false, and the
// delayMs offset. They exist entirely in pure JS so they run 10ms cold.

const STOPS = [
  { timeMs: 0,    value: 1.0 },
  { timeMs: 500,  value: 0.0 },
  { timeMs: 1000, value: 1.0 },
]

describe('interpolateTime — boundary & midpoint', () => {
  it('returns first stop at t = 0', () => {
    expect(interpolateTime(STOPS, 0, false, 'linear', 0)).toBe(1.0)
  })

  it('returns last stop at t = last timeMs (non-loop)', () => {
    expect(interpolateTime(STOPS, 1000, false, 'linear', 0)).toBe(1.0)
  })

  it('linearly interpolates at exact midpoint of first segment', () => {
    // Between 0 and 500, so t=250 → raw k=0.5, linear easing
    // Value = 1.0 + 0.5 * (0.0 - 1.0) = 0.5
    expect(interpolateTime(STOPS, 250, false, 'linear', 0)).toBeCloseTo(0.5, 6)
  })

  it('linearly interpolates at exact midpoint of second segment', () => {
    // Between 500 and 1000, so t=750 → raw k=0.5
    // Value = 0.0 + 0.5 * (1.0 - 0.0) = 0.5
    expect(interpolateTime(STOPS, 750, false, 'linear', 0)).toBeCloseTo(0.5, 6)
  })

  it('returns 1 for empty stop list', () => {
    expect(interpolateTime([], 500, false, 'linear', 0)).toBe(1.0)
  })
})

describe('interpolateTime — loop wraparound', () => {
  it('wraps modulo last timeMs when loop=true', () => {
    // 1250 % 1000 = 250 → midpoint of first segment → 0.5
    expect(interpolateTime(STOPS, 1250, true, 'linear', 0)).toBeCloseTo(0.5, 6)
  })

  it('wraps across multiple cycles', () => {
    // 3750 % 1000 = 750 → midpoint of second segment → 0.5
    expect(interpolateTime(STOPS, 3750, true, 'linear', 0)).toBeCloseTo(0.5, 6)
  })

  it('does not wrap when loop=false — clamps to last', () => {
    // 5000 with loop=false → clamp to t=1000 → last value
    expect(interpolateTime(STOPS, 5000, false, 'linear', 0)).toBe(1.0)
  })
})

describe('interpolateTime — delay', () => {
  it('returns first stop value before delay elapses', () => {
    // elapsed=200, delay=500 → effective=-300 → first stop
    expect(interpolateTime(STOPS, 200, false, 'linear', 500)).toBe(1.0)
  })

  it('starts interpolating after delay elapses', () => {
    // elapsed=750, delay=500 → effective=250 → midpoint of first segment
    expect(interpolateTime(STOPS, 750, false, 'linear', 500)).toBeCloseTo(0.5, 6)
  })

  it('supports negative delay (start mid-cycle)', () => {
    // elapsed=0, delay=-500 → effective=500 → exactly second stop value
    expect(interpolateTime(STOPS, 0, false, 'linear', -500)).toBe(0.0)
  })
})

describe('interpolateTime — easing functions', () => {
  const EASINGS: Easing[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out']

  for (const e of EASINGS) {
    it(`${e}: returns first stop at t=0`, () => {
      expect(interpolateTime(STOPS, 0, false, e, 0)).toBe(1.0)
    })

    it(`${e}: returns intermediate stop at exact segment boundary`, () => {
      // t=500 is the exact second stop — easing irrelevant at the boundary
      expect(interpolateTime(STOPS, 500, false, e, 0)).toBe(0.0)
    })
  }

  it('ease-in is slower at the start than linear', () => {
    // At t=100 (20% into segment 0-500), linear = 0.8, ease-in is closer to 1
    const linearVal = interpolateTime(STOPS, 100, false, 'linear', 0)
    const easeInVal = interpolateTime(STOPS, 100, false, 'ease-in', 0)
    expect(easeInVal).toBeGreaterThan(linearVal)
  })

  it('ease-out is faster at the start than linear', () => {
    // At t=100, ease-out should drop faster than linear
    const linearVal = interpolateTime(STOPS, 100, false, 'linear', 0)
    const easeOutVal = interpolateTime(STOPS, 100, false, 'ease-out', 0)
    expect(easeOutVal).toBeLessThan(linearVal)
  })

  it('ease-in-out is symmetric around segment midpoint', () => {
    // At segment midpoint, ease-in-out equals linear (0.5)
    expect(interpolateTime(STOPS, 250, false, 'ease-in-out', 0)).toBeCloseTo(0.5, 6)
  })
})

describe('interpolateTime — degenerate stops', () => {
  it('handles a single stop', () => {
    expect(interpolateTime([{ timeMs: 0, value: 0.75 }], 5000, true, 'linear', 0)).toBe(0.75)
  })

  it('handles zero-span segments (coincident timeMs)', () => {
    const stops = [
      { timeMs: 0, value: 0 },
      { timeMs: 500, value: 0.5 },
      { timeMs: 500, value: 1.0 },
      { timeMs: 1000, value: 0 },
    ]
    // At exactly t=500 the segment-lookup returns the second stop's value
    expect(interpolateTime(stops, 500, false, 'linear', 0)).toBe(0.5)
  })
})

// ═══ interpolateTimeColor: vec4 companion to interpolateTime ═══

const COLOR_STOPS: { timeMs: number; value: [number, number, number, number] }[] = [
  { timeMs: 0,    value: [1, 0, 0, 1] },  // red
  { timeMs: 500,  value: [0, 1, 0, 1] },  // green
  { timeMs: 1000, value: [0, 0, 1, 1] },  // blue
]

describe('interpolateTimeColor — boundary & midpoint', () => {
  it('returns first stop at t=0', () => {
    expect(interpolateTimeColor(COLOR_STOPS, 0, false, 'linear', 0)).toEqual([1, 0, 0, 1])
  })

  it('returns last stop at t=last', () => {
    expect(interpolateTimeColor(COLOR_STOPS, 1000, false, 'linear', 0)).toEqual([0, 0, 1, 1])
  })

  it('componentwise lerps at segment midpoint', () => {
    // t=250 is halfway between red [1,0,0] and green [0,1,0]
    const c = interpolateTimeColor(COLOR_STOPS, 250, false, 'linear', 0)
    expect(c[0]).toBeCloseTo(0.5, 6)
    expect(c[1]).toBeCloseTo(0.5, 6)
    expect(c[2]).toBeCloseTo(0.0, 6)
    expect(c[3]).toBeCloseTo(1.0, 6)
  })

  it('componentwise lerps at second segment midpoint', () => {
    // t=750 is halfway between green [0,1,0] and blue [0,0,1]
    const c = interpolateTimeColor(COLOR_STOPS, 750, false, 'linear', 0)
    expect(c[0]).toBeCloseTo(0.0, 6)
    expect(c[1]).toBeCloseTo(0.5, 6)
    expect(c[2]).toBeCloseTo(0.5, 6)
  })
})

describe('interpolateTimeColor — loop + delay', () => {
  it('wraps when loop=true', () => {
    // 1250 % 1000 = 250 → midpoint of red/green segment
    const c = interpolateTimeColor(COLOR_STOPS, 1250, true, 'linear', 0)
    expect(c[0]).toBeCloseTo(0.5, 6)
    expect(c[1]).toBeCloseTo(0.5, 6)
  })

  it('respects delayMs', () => {
    // elapsed=200, delay=500 → effective=-300 → returns first stop
    expect(interpolateTimeColor(COLOR_STOPS, 200, false, 'linear', 500)).toEqual([1, 0, 0, 1])
  })
})

describe('interpolateTimeColor — allocation reuse', () => {
  it('writes into provided `out` buffer without allocating', () => {
    const out: [number, number, number, number] = [9, 9, 9, 9]
    const result = interpolateTimeColor(COLOR_STOPS, 500, false, 'linear', 0, out)
    // Returned array is the SAME reference as `out` — caller can keep
    // a pooled Float32-friendly tuple across frames.
    expect(result).toBe(out)
    expect(out).toEqual([0, 1, 0, 1])
  })
})

// ═══ Bug 1 regression — multi-cycle frame loop simulation ═══
//
// Bug 1 (commit 1317263): color/width/dashoffset keyframe animations
// ran one full cycle and then froze at the last stop value. The
// classifier passed `loop=false` instead of `loop=true` because
// emit-commands was reading lifecycle metadata from the wrong IR
// union.
//
// These tests drive `interpolateTime` and `interpolateTimeColor` at
// 60Hz across 5 full cycles and assert:
//   1. the output reaches both extreme values multiple times (the
//      animation is actually moving, not stuck)
//   2. value at t === value at t+cycleMs (proves wraparound, the
//      structural property the bug violated)
//   3. with loop=false, the value DOES freeze at the end (negative
//      control — proves the test is sensitive to the bug shape)

const PULSE_STOPS = [
  { timeMs: 0,    value: 1.0 },
  { timeMs: 750,  value: 0.3 },
  { timeMs: 1500, value: 1.0 },
]
const CYCLE_MS = 1500
const FRAME_MS = 1000 / 60 // 16.67ms — vsync cadence

describe('interpolateTime — multi-cycle frame loop (Bug 1 regression)', () => {
  function simulateFrames(loop: boolean): number[] {
    const out: number[] = []
    // 5 full cycles at 60Hz = ~450 samples
    for (let elapsed = 0; elapsed <= CYCLE_MS * 5; elapsed += FRAME_MS) {
      out.push(interpolateTime(PULSE_STOPS, elapsed, loop, 'linear', 0))
    }
    return out
  }

  it('loop=true: animation reaches BOTH extreme values multiple times', () => {
    const samples = simulateFrames(true)
    // Count samples within 0.05 of each extreme. With 450 samples
    // across 5 cycles of a triangle wave, we should hit each
    // extreme region ~5 times.
    const nearMax = samples.filter(v => v > 0.95).length
    const nearMin = samples.filter(v => v < 0.35).length
    expect(nearMax,
      `frame loop never returned to opacity ≈ 1.0 (saw ${nearMax} near-max samples) — animation stuck`)
      .toBeGreaterThan(20)
    expect(nearMin,
      `frame loop never reached opacity ≈ 0.3 (saw ${nearMin} near-min samples) — animation never moved`)
      .toBeGreaterThan(20)
  })

  it('loop=true: value at t === value at t+cycleMs (wraparound invariant)', () => {
    // Sample a few non-aligned times and verify the value at
    // t+cycleMs matches t. This is the structural property Bug 1
    // violated: under the bug, t+cycleMs returned 1.0 (frozen at
    // last stop) for every t past the first cycle.
    for (const t of [100, 350, 700, 1100, 1450]) {
      const v1 = interpolateTime(PULSE_STOPS, t, true, 'linear', 0)
      const v2 = interpolateTime(PULSE_STOPS, t + CYCLE_MS, true, 'linear', 0)
      const v3 = interpolateTime(PULSE_STOPS, t + 3 * CYCLE_MS, true, 'linear', 0)
      expect(v2).toBeCloseTo(v1, 6)
      expect(v3).toBeCloseTo(v1, 6)
    }
  })

  it('loop=false: animation freezes at last stop after one cycle (negative control)', () => {
    // This is what Bug 1 looked like when it shipped: every sample
    // past the first cycle is pinned to the last stop's value.
    // Asserting THIS pins the test sensitivity — if a future
    // refactor accidentally makes loop=false also wrap, the loop=true
    // test above would still pass but this one would fail.
    const samples = simulateFrames(false)
    const lastCycleSamples = samples.slice(Math.floor(samples.length * 0.6))
    const allFrozen = lastCycleSamples.every(v => Math.abs(v - 1.0) < 1e-6)
    expect(allFrozen).toBe(true)
  })

  it('loop=true with ease-in-out: values still cycle (easing does not break wraparound)', () => {
    const out: number[] = []
    for (let elapsed = 0; elapsed <= CYCLE_MS * 3; elapsed += FRAME_MS) {
      out.push(interpolateTime(PULSE_STOPS, elapsed, true, 'ease-in-out', 0))
    }
    const distinct = new Set(out.map(v => Math.round(v * 100))).size
    // Triangle wave with ease-in-out should hit ~30+ distinct
    // 0.01-rounded values across 3 cycles. If the value is stuck,
    // distinct ≈ 1.
    expect(distinct).toBeGreaterThan(15)
  })
})

describe('interpolateTimeColor — multi-cycle frame loop (Bug 1 regression)', () => {
  // The animation_showcase heat keyframe — slate → rose → slate
  // over 2000ms. Bug 1's exact shape was this color animation
  // freezing at slate after one cycle.
  const HEAT_STOPS: { timeMs: number; value: [number, number, number, number] }[] = [
    { timeMs: 0,    value: [0.20, 0.25, 0.33, 1] }, // slate-700
    { timeMs: 1000, value: [0.88, 0.11, 0.28, 1] }, // rose-600
    { timeMs: 2000, value: [0.20, 0.25, 0.33, 1] }, // slate-700
  ]
  const HEAT_CYCLE = 2000

  it('reaches BOTH the slate and rose extremes across 5 cycles', () => {
    const samples: [number, number, number, number][] = []
    for (let elapsed = 0; elapsed <= HEAT_CYCLE * 5; elapsed += FRAME_MS) {
      samples.push(interpolateTimeColor(HEAT_STOPS, elapsed, true, 'linear', 0))
    }
    // slate has high R component (>0.8) only briefly per cycle (the rose phase)
    const nearRose = samples.filter(c => c[0] > 0.75).length
    const nearSlate = samples.filter(c => c[0] < 0.30).length
    expect(nearRose).toBeGreaterThan(20)
    expect(nearSlate).toBeGreaterThan(20)
  })

  it('color at t === color at t+cycleMs (the literal Bug 1 invariant)', () => {
    // Bug 1 made this fail: at t=500 (ramping toward rose), the
    // color was magenta-ish; at t=2500 (one full cycle later), it
    // was frozen-slate instead of magenta-ish. This test fixes
    // the contract.
    for (const t of [200, 500, 950, 1300, 1800]) {
      const c1 = interpolateTimeColor(HEAT_STOPS, t, true, 'linear', 0)
      const c2 = interpolateTimeColor(HEAT_STOPS, t + HEAT_CYCLE, true, 'linear', 0)
      const c3 = interpolateTimeColor(HEAT_STOPS, t + 3 * HEAT_CYCLE, true, 'linear', 0)
      for (let i = 0; i < 4; i++) {
        expect(c2[i]).toBeCloseTo(c1[i], 6)
        expect(c3[i]).toBeCloseTo(c1[i], 6)
      }
    }
  })

  it('reusing an out buffer across frames produces correct results', () => {
    // Allocation-pooled hot path: the runtime calls
    // interpolateTimeColor without a fresh `out` buffer per frame.
    // Verify the in-place writes produce the same answer as
    // fresh-allocation calls.
    const out: [number, number, number, number] = [0, 0, 0, 0]
    for (const t of [0, 333, 666, 1000, 1333, 1666, 2000]) {
      const inPlace = interpolateTimeColor(HEAT_STOPS, t, true, 'linear', 0, out)
      const fresh = interpolateTimeColor(HEAT_STOPS, t, true, 'linear', 0)
      for (let i = 0; i < 4; i++) {
        expect(inPlace[i]).toBeCloseTo(fresh[i], 6)
      }
      // Same reference (pooled allocation):
      expect(inPlace).toBe(out)
    }
  })
})
