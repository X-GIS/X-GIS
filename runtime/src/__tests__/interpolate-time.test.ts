import { describe, expect, it } from 'vitest'
import { interpolateTime, interpolateTimeColor, type Easing } from '../engine/renderer'

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
