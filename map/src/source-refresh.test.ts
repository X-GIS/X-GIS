// ═══ SourceRefreshScheduler — the `refresh:` polling timer (#1304) ═══
//
// Pure timer-discipline tests, no GPU / fetch involved (source-manager-refresh.test.ts
// covers the actual re-fetch + setSourceData swap). Mirrors coverage-refresh.test.ts's
// fake-timer idiom (vi.useFakeTimers + vi.advanceTimersByTimeAsync, since `start`'s loop
// awaits `tick`).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SourceRefreshScheduler } from './source-refresh'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('SourceRefreshScheduler', () => {
  it('does not tick before the interval elapses, then ticks once per interval', async () => {
    const s = new SourceRefreshScheduler()
    let calls = 0
    s.start('a', 5000, async () => {
      calls++
    })
    await vi.advanceTimersByTimeAsync(4000)
    expect(calls).toBe(0)
    await vi.advanceTimersByTimeAsync(1100)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(2)
  })

  it('clamps a sub-second interval to 1000ms', async () => {
    const s = new SourceRefreshScheduler()
    let calls = 0
    s.start('a', 10, async () => {
      calls++
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toBe(0)
    await vi.advanceTimersByTimeAsync(600)
    expect(calls).toBe(1)
  })

  it('re-arms only after the previous tick settles — a slow tick cannot stack up', async () => {
    const s = new SourceRefreshScheduler()
    let inFlight = 0
    let maxConcurrent = 0
    let resolveTick: (() => void) | null = null
    s.start('a', 1000, async () => {
      inFlight++
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise<void>((r) => (resolveTick = r))
      inFlight--
    })
    await vi.advanceTimersByTimeAsync(1100) // first tick starts, parks mid-flight
    expect(inFlight).toBe(1)
    // Time keeps moving while the tick is still parked — no second tick fires,
    // because re-arm only happens AFTER the in-flight tick resolves.
    await vi.advanceTimersByTimeAsync(5000)
    expect(inFlight).toBe(1)
    expect(maxConcurrent).toBe(1)
    resolveTick!()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('a tick that throws does not kill the loop — it keeps polling', async () => {
    const s = new SourceRefreshScheduler()
    let calls = 0
    s.start('a', 1000, async () => {
      calls++
      throw new Error('network blip')
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(2)
  })

  it('stop() clears the timer — no further ticks', async () => {
    const s = new SourceRefreshScheduler()
    let calls = 0
    s.start('a', 1000, async () => {
      calls++
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(calls).toBe(1)
    s.stop('a')
    expect(s.isRunning('a')).toBe(false)
    await vi.advanceTimersByTimeAsync(10000)
    expect(calls).toBe(1)
  })

  it('stopAll() clears every source', async () => {
    const s = new SourceRefreshScheduler()
    let a = 0
    let b = 0
    s.start('a', 1000, async () => {
      a++
    })
    s.start('b', 1000, async () => {
      b++
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(a).toBe(1)
    expect(b).toBe(1)
    s.stopAll()
    expect(s.isRunning('a')).toBe(false)
    expect(s.isRunning('b')).toBe(false)
    await vi.advanceTimersByTimeAsync(10000)
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  it('restarting a source (start called again) replaces the loop cleanly — no double-tick', async () => {
    const s = new SourceRefreshScheduler()
    let calls = 0
    s.start('a', 1000, async () => {
      calls++
    })
    s.start('a', 1000, async () => {
      calls++
    })
    await vi.advanceTimersByTimeAsync(1100)
    expect(calls).toBe(1)
  })
})
