import { describe, expect, it, vi } from 'vitest'
import { startSettledLoop, type SettledLoopMap } from './settled-loop'

/** A map whose `idle` fires `settleMs` after each push — the shape a real re-tile has.
 *  `settleMs: null` never settles, exercising the maxWait fallback. */
function fakeMap(settleMs: number | null): SettledLoopMap & { push(): void } {
  let listener: (() => void) | null = null
  return {
    once: (_t, l) => void (listener = l),
    off: (_t, l) => void (listener === l && (listener = null)),
    push: () => {
      if (settleMs === null) return
      setTimeout(() => listener?.(), settleMs)
    },
  }
}

describe('startSettledLoop (#1372 — the animate-line / realtime-update cadence)', () => {
  it('paces to the SETTLE, not to a guessed interval — a fast pipeline steps fast', async () => {
    vi.useFakeTimers()
    try {
      const map = fakeMap(40)
      let steps = 0
      const stop = startSettledLoop(
        map,
        () => {
          steps++
          map.push()
        },
        { minStepMs: 10, maxWaitMs: 1000 },
      )
      await vi.advanceTimersByTimeAsync(1000)
      stop()
      // ~50 ms per cycle (40 settle + 10 floor) → ~20 steps, vs 0 under a blind 3 s interval.
      expect(steps).toBeGreaterThan(15)
      expect(steps).toBeLessThan(25)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never preempts itself — a SLOW pipeline gets exactly one push per settle', async () => {
    vi.useFakeTimers()
    try {
      const map = fakeMap(400) // one re-tile costs 400 ms
      const at: number[] = []
      let now = 0
      const stop = startSettledLoop(
        map,
        () => {
          at.push(now)
          map.push()
        },
        { minStepMs: 10, maxWaitMs: 5000 },
      )
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(100)
        now += 100
      }
      stop()
      // 2000 ms / (400 + 10) ≈ 4-5 steps, each strictly after the previous one settled.
      expect(at.length).toBeGreaterThanOrEqual(4)
      expect(at.length).toBeLessThanOrEqual(6)
      for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(400)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a map that never settles still advances, bounded by maxWaitMs', async () => {
    vi.useFakeTimers()
    try {
      const map = fakeMap(null) // `idle` never fires
      let steps = 0
      const stop = startSettledLoop(map, () => steps++, { minStepMs: 0, maxWaitMs: 500 })
      await vi.advanceTimersByTimeAsync(2000)
      stop()
      expect(steps).toBeGreaterThanOrEqual(4) // one per maxWait, never stalled
      expect(steps).toBeLessThanOrEqual(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop() halts it and leaves no idle listener subscribed', async () => {
    vi.useFakeTimers()
    try {
      let listener: (() => void) | null = null
      const map: SettledLoopMap = {
        once: (_t, l) => void (listener = l),
        off: (_t, l) => void (listener === l && (listener = null)),
      }
      let steps = 0
      const stop = startSettledLoop(map, () => steps++, { minStepMs: 10, maxWaitMs: 100 })
      await vi.advanceTimersByTimeAsync(350)
      const atStop = steps
      stop()
      await vi.advanceTimersByTimeAsync(2000)
      expect(steps).toBe(atStop) // no further pushes
      expect(listener).toBeNull() // and nothing left listening on the map
    } finally {
      vi.useRealTimers()
    }
  })
})
