// Unit tests for PerfMarks (Plan AAA Phase C.3, iter-256).

import { describe, it, expect, beforeEach } from 'vitest'
import {
  markStart, markEnd, getPhaseAverages, resetPhaseTimings,
} from './perf-marks'

beforeEach(() => {
  resetPhaseTimings()
})

describe('PerfMarks — basic flow', () => {
  it('empty profile when no marks', () => {
    expect(getPhaseAverages()).toEqual([])
  })

  it('markStart + markEnd records a sample', () => {
    markStart('test.phase')
    // Simulate work via a synchronous busy loop to advance the clock.
    const t0 = performance.now()
    while (performance.now() - t0 < 2) { /* spin */ }
    markEnd('test.phase')
    const profile = getPhaseAverages()
    expect(profile.length).toBe(1)
    expect(profile[0]!.name).toBe('test.phase')
    expect(profile[0]!.meanMs).toBeGreaterThan(0)
    expect(profile[0]!.samples).toBe(1)
  })

  it('markEnd without markStart is no-op', () => {
    markEnd('not-started')
    expect(getPhaseAverages()).toEqual([])
  })

  it('multiple phases tracked independently', () => {
    markStart('a')
    markEnd('a')
    markStart('b')
    markEnd('b')
    const profile = getPhaseAverages()
    expect(profile.map(p => p.name).sort()).toEqual(['a', 'b'])
  })

  it('repeat samples accumulate', () => {
    for (let i = 0; i < 5; i++) {
      markStart('x')
      markEnd('x')
    }
    const profile = getPhaseAverages()
    expect(profile[0]!.samples).toBe(5)
  })
})

describe('PerfMarks — ring buffer', () => {
  it('caps at WINDOW=60 samples', () => {
    for (let i = 0; i < 100; i++) {
      markStart('y')
      markEnd('y')
    }
    const profile = getPhaseAverages()
    expect(profile[0]!.samples).toBeLessThanOrEqual(60)
  })

  it('sorted by descending meanMs', () => {
    // Phase 'slow' gets a 2ms sample; 'fast' gets 0ms.
    markStart('fast')
    markEnd('fast')
    markStart('slow')
    const t0 = performance.now()
    while (performance.now() - t0 < 3) { /* spin */ }
    markEnd('slow')
    const profile = getPhaseAverages()
    expect(profile[0]!.name).toBe('slow')
    expect(profile[0]!.meanMs).toBeGreaterThanOrEqual(profile[1]!.meanMs)
  })
})

describe('PerfMarks — global API exposure', () => {
  it('globalThis.__xgisPerfPhases.getPhaseAverages works', () => {
    interface API { getPhaseAverages: typeof getPhaseAverages }
    const api = (globalThis as { __xgisPerfPhases?: API }).__xgisPerfPhases
    expect(api).toBeDefined()
    expect(typeof api!.getPhaseAverages).toBe('function')
  })
})
