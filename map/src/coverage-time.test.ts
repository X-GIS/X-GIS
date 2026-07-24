import { describe, expect, it, vi } from 'vitest'
import { resolveForecastGroup, CoverageTimePlayer } from './coverage-time'
import type { CoverageTime } from '@xgis/data'

const axis = (over: Partial<CoverageTime> = {}): CoverageTime => ({
  index: 0,
  count: 48,
  valueISO: null,
  firstISO: '2026-07-22T00:00:00Z',
  intervalSeconds: 3600,
  ...over,
})

describe('resolveForecastGroup (#1272 E-③)', () => {
  it('maps a 0-based hour index to a 1-based group', () => {
    expect(resolveForecastGroup(axis(), 0)).toBe(1)
    expect(resolveForecastGroup(axis(), 5)).toBe(6)
    expect(resolveForecastGroup(axis(), 47)).toBe(48)
  })

  it('clamps an out-of-range index to the axis ends (never throws — play can wrap)', () => {
    expect(resolveForecastGroup(axis({ count: 48 }), -3)).toBe(1)
    expect(resolveForecastGroup(axis({ count: 48 }), 999)).toBe(48)
  })

  it('maps an ISO valid-time onto the regular axis (nearest hour)', () => {
    // firstISO 00:00Z, hourly → 03:00Z is hour index 3 → group 4
    expect(resolveForecastGroup(axis(), '2026-07-22T03:00:00Z')).toBe(4)
    // 02:40Z rounds to hour 3 → group 4
    expect(resolveForecastGroup(axis(), '2026-07-22T02:40:00Z')).toBe(4)
    // before the first record clamps to group 1
    expect(resolveForecastGroup(axis(), '2026-07-21T23:00:00Z')).toBe(1)
  })

  it('throws for an ISO time when the cell has no regular axis (interval 0)', () => {
    expect(() =>
      resolveForecastGroup(axis({ intervalSeconds: 0 }), '2026-07-22T03:00:00Z'),
    ).toThrow(/regular time axis/)
  })
})

describe('CoverageTimePlayer.play — a rejecting step never throws unhandled (play-button crash regression)', () => {
  it('a step that rejects stops playback silently instead of crashing', async () => {
    vi.useFakeTimers()
    try {
      const player = new CoverageTimePlayer()
      const index = 0
      const calls: number[] = []
      player.play(
        () => ({ index, count: 5 }),
        async (next) => {
          calls.push(next)
          throw new Error('simulated range-read failure (e.g. a 200 not 206)')
        },
        100,
      )
      await vi.advanceTimersByTimeAsync(100) // first tick: step rejects
      expect(calls).toEqual([1]) // stepped once, then the rejection stopped the loop
      await vi.advanceTimersByTimeAsync(1000) // no further ticks scheduled
      expect(calls).toEqual([1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a succeeding step keeps looping and wraps at the axis end', async () => {
    vi.useFakeTimers()
    try {
      const player = new CoverageTimePlayer()
      let index = 0
      const calls: number[] = []
      player.play(
        () => ({ index, count: 3 }),
        async (next) => {
          calls.push(next)
          index = next
        },
        50,
      )
      await vi.advanceTimersByTimeAsync(50)
      await vi.advanceTimersByTimeAsync(50)
      await vi.advanceTimersByTimeAsync(50)
      expect(calls).toEqual([1, 2, 0]) // wraps 0→1→2→0
      player.pause()
    } finally {
      vi.useRealTimers()
    }
  })
})
