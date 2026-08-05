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

describe('CoverageTimePlayer.play — interpolated sub-stepping (#1333)', () => {
  it('ticks steps-1 fractional frames then the real step, at stepMs/steps cadence', async () => {
    vi.useFakeTimers()
    try {
      const player = new CoverageTimePlayer()
      let index = 0
      const fracs: [number, number, number][] = []
      const steps: number[] = []
      player.play(
        () => ({ index, count: 5 }),
        async (next) => {
          steps.push(next)
          index = next
        },
        100, // stepMs → subMs = 100/4 = 25
        {
          steps: 4,
          stepFraction: async (from, to, t) => {
            fracs.push([from, to, t])
          },
        },
      )
      await vi.advanceTimersByTimeAsync(25) // sub 1/4
      await vi.advanceTimersByTimeAsync(25) // sub 2/4
      await vi.advanceTimersByTimeAsync(25) // sub 3/4
      expect(fracs).toEqual([
        [0, 1, 0.25],
        [0, 1, 0.5],
        [0, 1, 0.75],
      ])
      expect(steps).toEqual([]) // the real step hasn't landed yet
      await vi.advanceTimersByTimeAsync(25) // sub 4/4 — the real landing
      expect(steps).toEqual([1])
      player.pause()
    } finally {
      vi.useRealTimers()
    }
  })

  it('total dwell per hour is unchanged (steps × subMs === stepMs) — same overall pace', async () => {
    vi.useFakeTimers()
    try {
      const player = new CoverageTimePlayer()
      let index = 0
      const landed: number[] = []
      player.play(
        () => ({ index, count: 5 }),
        async (next) => {
          landed.push(next)
          index = next
        },
        100,
        { steps: 5, stepFraction: async () => {} },
      )
      await vi.advanceTimersByTimeAsync(100) // exactly one stepMs later, the hour has landed
      expect(landed).toEqual([1])
      player.pause()
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues seamlessly into the NEXT hour after landing', async () => {
    vi.useFakeTimers()
    try {
      const player = new CoverageTimePlayer()
      let index = 0
      const fracs: [number, number][] = []
      const landed: number[] = []
      player.play(
        () => ({ index, count: 5 }),
        async (next) => {
          landed.push(next)
          index = next
        },
        60,
        { steps: 3, stepFraction: async (from, to) => void fracs.push([from, to]) },
      )
      // hour 0→1: 2 fractional ticks + 1 landing
      await vi.advanceTimersByTimeAsync(60)
      // hour 1→2: 2 more fractional ticks + 1 landing
      await vi.advanceTimersByTimeAsync(60)
      expect(landed).toEqual([1, 2])
      expect(fracs).toEqual([
        [0, 1],
        [0, 1],
        [1, 2],
        [1, 2],
      ])
      player.pause()
    } finally {
      vi.useRealTimers()
    }
  })

  // ── #1573 — a dropped frame is not the end of playback ──
  //
  // This assertion used to read "a rejecting stepFraction stops playback silently (same
  // crash-safety as step)". That was never the contract: `map.ts`'s `playCoverageTime`
  // docstring states the opposite in as many words — "a decode/interpolation failure just
  // skips that one frame... a single dropped frame should not kill playback" — and the doc,
  // the code and this test all landed in ONE squash (294eb360), so two in-repo authorities
  // have contradicted each other from birth with the test entrenching the wrong one.
  //
  // The crash-safety the old title borrowed belongs to the REAL step branch, which still
  // stops (a step works inside an already-loaded cell, so its failure is a fault, not a
  // blip) — see the sibling case below. Each interpolated sub-frame, by contrast, reads
  // every region at the target group over the network, which is allowed to fail.
  it('a rejecting stepFraction skips that frame and playback continues', async () => {
    vi.useFakeTimers()
    try {
      const player = new CoverageTimePlayer()
      const index = 0
      const fracs: number[] = []
      const landed: number[] = []
      player.play(
        () => ({ index, count: 5 }),
        async (i) => {
          landed.push(i)
        },
        100,
        {
          steps: 4,
          stepFraction: async (_f, _t2, t) => {
            fracs.push(t)
            throw new Error('simulated interpolation-frame failure')
          },
        },
      )
      await vi.advanceTimersByTimeAsync(25)
      expect(fracs).toEqual([0.25])
      // Before the fix both of these stayed frozen at their first value: the shared catch
      // returned without re-arming the timer, so nothing ever ticked again.
      await vi.advanceTimersByTimeAsync(75)
      expect(fracs, 'the later sub-frames still run').toEqual([0.25, 0.5, 0.75])
      expect(landed, 'and the hour still lands').toEqual([1])
      player.pause()
    } finally {
      vi.useRealTimers()
    }
  })

  it('CONTROL — a rejecting real step still stops playback', async () => {
    vi.useFakeTimers()
    try {
      const player = new CoverageTimePlayer()
      const fracs: number[] = []
      let stepCalls = 0
      player.play(
        () => ({ index: 0, count: 5 }),
        async () => {
          stepCalls++
          throw new Error('simulated forecast-step failure')
        },
        100,
        {
          steps: 4,
          stepFraction: async (_f, _t2, t) => {
            fracs.push(t)
          },
        },
      )
      // Three healthy sub-frames, then the landing throws.
      await vi.advanceTimersByTimeAsync(100)
      expect(fracs).toEqual([0.25, 0.5, 0.75])
      expect(stepCalls).toBe(1)
      // Without this arm, "skip and continue" applied to BOTH branches would pass the case
      // above while quietly discarding the crash-safety that branch is for.
      await vi.advanceTimersByTimeAsync(1000)
      expect(stepCalls, 'no further ticks are scheduled').toBe(1)
      expect(fracs).toEqual([0.25, 0.5, 0.75])
    } finally {
      vi.useRealTimers()
    }
  })

  // ── #1362 — the S-111 play button: "huge lag, and it never moves forward, it repeats" ──
  // Both symptoms are one root cause: playback work that costs MORE than its dwell. A loop
  // that neither drops sub-frames nor guards its generation then (a) stretches every hour so
  // the real landing keeps sliding, and (b) resurrects itself after a pause, stacking loops.

  it('a blended frame slower than subMs is DROPPED so the hour still lands within its dwell', async () => {
    vi.useFakeTimers()
    try {
      const player = new CoverageTimePlayer()
      let index = 0
      const landed: number[] = []
      const fracs: number[] = []
      let fracsAtFirstLanding = -1
      player.play(
        () => ({ index, count: 5 }),
        async (next) => {
          if (fracsAtFirstLanding < 0) fracsAtFirstLanding = fracs.length
          landed.push(next)
          index = next
        },
        100, // stepMs → subMs = 20
        {
          steps: 5,
          stepFraction: async (_f, _t2, t) => {
            fracs.push(t)
            // One blended frame costs 1.5× its slot (a real S-111 frame re-derives a 258k-cell
            // arrow field) — the loop must shed frames, not fall behind. The SYNC
            // advance models blocking work: the clock moves, no timer is flushed early.
            vi.advanceTimersByTime(30)
          },
        },
      )
      await vi.advanceTimersByTimeAsync(100)
      expect(landed[0]).toBe(1) // the hour LANDED inside one dwell despite the slow frames
      expect(fracsAtFirstLanding).toBeGreaterThan(0) // it still blended what fitted…
      expect(fracsAtFirstLanding).toBeLessThan(4) // …and dropped the frames whose slot had passed
      player.pause()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps landing hour after hour when EVERY hour overruns its dwell (never repeats one hour)', async () => {
    vi.useFakeTimers()
    try {
      const player = new CoverageTimePlayer()
      let index = 0
      const landed: number[] = []
      player.play(
        () => ({ index, count: 4 }),
        async (next) => {
          vi.advanceTimersByTime(150) // the swap alone costs 1.5× the whole dwell
          landed.push(next)
          index = next
        },
        100,
        { steps: 5, stepFraction: async () => void vi.advanceTimersByTime(40) },
      )
      await vi.advanceTimersByTimeAsync(2000)
      expect(landed.slice(0, 5)).toEqual([1, 2, 3, 0, 1]) // advances + wraps, never stuck
      player.pause()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pause() during an in-flight step stops the loop (an awaiting tick never re-arms)', async () => {
    vi.useFakeTimers()
    try {
      const player = new CoverageTimePlayer()
      let index = 0
      const calls: number[] = []
      let release: (() => void) | null = null
      player.play(
        () => ({ index, count: 5 }),
        async (next) => {
          calls.push(next)
          index = next
          await new Promise<void>((r) => (release = r)) // a swap still in flight when we pause
        },
        50,
      )
      await vi.advanceTimersByTimeAsync(50)
      expect(calls).toEqual([1])
      player.pause() // ← pressed while the step is awaiting
      release!()
      await vi.advanceTimersByTimeAsync(1000)
      expect(calls).toEqual([1]) // no tick was re-armed by the orphaned in-flight step
    } finally {
      vi.useRealTimers()
    }
  })

  it('play() while a step is in flight leaves exactly ONE loop (a play/pause toggle never stacks)', async () => {
    vi.useFakeTimers()
    try {
      const player = new CoverageTimePlayer()
      let index = 0
      const calls: number[] = []
      let release: (() => void) | null = null
      let block = true
      const axisFn = (): { index: number; count: number } => ({ index, count: 5 })
      const stepFn = async (next: number): Promise<void> => {
        calls.push(next)
        index = next
        if (block) await new Promise<void>((r) => (release = r))
      }
      player.play(axisFn, stepFn, 50)
      await vi.advanceTimersByTimeAsync(50)
      expect(calls).toEqual([1])
      block = false
      player.play(axisFn, stepFn, 50) // restart while the first loop's step is still awaiting
      release!()
      await vi.advanceTimersByTimeAsync(150) // 3 dwells → exactly 3 more steps, not 6
      expect(calls).toEqual([1, 2, 3, 4]) // a stacked second loop would double-step here
      player.pause()
    } finally {
      vi.useRealTimers()
    }
  })

  it('steps ≤ 1 (or omitted) is byte-identical to non-interpolated play', async () => {
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
        { steps: 1, stepFraction: async () => void calls.push(-1) }, // must never fire
      )
      await vi.advanceTimersByTimeAsync(50)
      await vi.advanceTimersByTimeAsync(50)
      expect(calls).toEqual([1, 2]) // no -1 sentinel — stepFraction never called
      player.pause()
    } finally {
      vi.useRealTimers()
    }
  })
})
