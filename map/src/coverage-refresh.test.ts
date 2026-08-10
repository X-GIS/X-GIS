// ═══ Coverage refresh — revalidation decisions + the poll loop's lifecycle ═══
//
// The two things that make an auto-refetch safe rather than merely present: it must not
// re-download an unchanged cell, and it must never leave a stale read armed or a loop
// running after it was stopped. Both are pure/timer logic, so they are gated here
// directly rather than through the Map god-file.
//
// The bias under test is deliberate and asymmetric: EVERY uncertain case reads. A
// needless read costs bandwidth; a wrongly-skipped one leaves a stale chart on screen.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CoverageRefreshScheduler,
  decideRefresh,
  probeValidator,
  readValidator,
  validatorsMatch,
  type CoverageValidator,
} from './coverage-refresh'

const etag = (v: string): CoverageValidator => ({ etag: v, lastModified: null })
const modified = (v: string): CoverageValidator => ({ etag: null, lastModified: v })

describe('validator extraction + comparison', () => {
  it('reads both validators, and reports none when the server exposes neither', () => {
    expect(
      readValidator(new Headers({ etag: '"abc"', 'last-modified': 'Mon, 01 Jan 2029' })),
    ).toEqual({ etag: '"abc"', lastModified: 'Mon, 01 Jan 2029' })
    expect(readValidator(new Headers({ 'content-type': 'application/x-hdf5' }))).toBeNull()
  })

  it('prefers ETag when both sides carry one', () => {
    // Same ETag but a bumped Last-Modified = the same representation re-stamped; the
    // strong validator must win, or a mirror that rewrites mtimes re-reads forever.
    const a = { etag: '"v1"', lastModified: 'Mon, 01 Jan 2029' }
    const b = { etag: '"v1"', lastModified: 'Tue, 02 Jan 2029' }
    expect(validatorsMatch(a, b)).toBe(true)
    expect(validatorsMatch({ ...a, etag: '"v2"' }, b)).toBe(false)
  })

  it('falls back to Last-Modified only when ETags are not on both sides', () => {
    expect(validatorsMatch(modified('Mon, 01 Jan 2029'), modified('Mon, 01 Jan 2029'))).toBe(true)
    expect(validatorsMatch(modified('Mon, 01 Jan 2029'), modified('Tue, 02 Jan 2029'))).toBe(false)
    // One side has only an ETag, the other only a date — nothing comparable.
    expect(validatorsMatch(etag('"v1"'), modified('Mon, 01 Jan 2029'))).toBe(false)
  })

  it('never treats absent information as a match', () => {
    // The load-bearing case: two nulls mean "we know nothing", which must read, NOT skip.
    expect(validatorsMatch(null, null)).toBe(false)
    expect(validatorsMatch(undefined, etag('"v1"'))).toBe(false)
    expect(validatorsMatch(etag('"v1"'), null)).toBe(false)
  })
})

describe('refresh decision — uncertainty always reads', () => {
  it('skips the read ONLY when a stored and a probed validator agree', () => {
    expect(decideRefresh(etag('"v1"'), etag('"v1"'))).toEqual({
      read: false,
      reason: 'unchanged',
    })
  })

  it('reads on a changed validator', () => {
    expect(decideRefresh(etag('"v1"'), etag('"v2"'))).toEqual({
      read: true,
      reason: 'validator-changed',
    })
  })

  it('reads when nothing is stored yet, when none was exposed, and when forced', () => {
    expect(decideRefresh(undefined, etag('"v1"'))).toEqual({ read: true, reason: 'first-probe' })
    expect(decideRefresh(etag('"v1"'), null)).toEqual({ read: true, reason: 'no-validator' })
    // force short-circuits even when the validators agree.
    expect(decideRefresh(etag('"v1"'), etag('"v1"'), true)).toEqual({
      read: true,
      reason: 'forced',
    })
  })
})

describe('probeValidator — degrades, never throws', () => {
  it('returns the validators from a successful HEAD', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(null, { headers: { etag: '"v1"' } }),
    )
    expect(await probeValidator('http://x/a.h5', fetchFn as unknown as typeof fetch)).toEqual({
      etag: '"v1"',
      lastModified: null,
    })
    expect(fetchFn.mock.calls[0]![1]).toMatchObject({ method: 'HEAD' })
  })

  it('returns null (→ read) when HEAD is blocked or the request throws', async () => {
    // A proxy answering 405 to HEAD, and an outright network failure, must both degrade to
    // "cannot tell" — throwing here would kill the polling loop instead of costing bandwidth.
    const blocked = vi.fn(async () => new Response(null, { status: 405 }))
    expect(await probeValidator('http://x/a.h5', blocked as unknown as typeof fetch)).toBeNull()
    const failing = vi.fn(async () => {
      throw new Error('network down')
    })
    expect(await probeValidator('http://x/a.h5', failing as unknown as typeof fetch)).toBeNull()
  })
})

describe('CoverageRefreshScheduler — supersession + validator memory', () => {
  it('epochs are per-source, so one source cannot supersede another', () => {
    const s = new CoverageRefreshScheduler()
    const a = s.nextEpoch('bathy')
    const b = s.nextEpoch('currents')
    expect(s.isCurrent('bathy', a)).toBe(true)
    expect(s.isCurrent('currents', b)).toBe(true)
    s.nextEpoch('currents')
    expect(s.isCurrent('currents', b)).toBe(false)
    expect(s.isCurrent('bathy', a)).toBe(true) // untouched by the sibling's step
  })

  it('a null probe FORGETS the stored validator', () => {
    // Otherwise a later probe failure would be compared against a validator no longer
    // known to describe the resident data, and could wrongly report "unchanged".
    const s = new CoverageRefreshScheduler()
    s.rememberValidator('bathy', etag('"v1"'))
    expect(s.validator('bathy')).toEqual(etag('"v1"'))
    s.rememberValidator('bathy', null)
    expect(s.validator('bathy')).toBeUndefined()
    expect(decideRefresh(s.validator('bathy'), etag('"v1"'))).toMatchObject({ read: true })
  })
})

describe('CoverageRefreshScheduler — the poll loop', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('polls on the interval and stops on demand', async () => {
    const s = new CoverageRefreshScheduler()
    const tick = vi.fn(async () => {})
    s.start('bathy', 1000, tick)
    expect(s.isRunning('bathy')).toBe(true)
    await vi.advanceTimersByTimeAsync(3100)
    expect(tick).toHaveBeenCalledTimes(3)
    s.stop('bathy')
    await vi.advanceTimersByTimeAsync(5000)
    expect(tick).toHaveBeenCalledTimes(3) // no tick after stop
    expect(s.isRunning('bathy')).toBe(false)
  })

  it('clamps a sub-second interval to 1 s', async () => {
    const s = new CoverageRefreshScheduler()
    const tick = vi.fn(async () => {})
    s.start('bathy', 10, tick)
    await vi.advanceTimersByTimeAsync(900)
    expect(tick).not.toHaveBeenCalled() // 10ms was clamped, not honoured
    await vi.advanceTimersByTimeAsync(200)
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('does not stack ticks when a read is slower than the interval', async () => {
    const s = new CoverageRefreshScheduler()
    let running = 0
    let maxConcurrent = 0
    const tick = vi.fn(async () => {
      maxConcurrent = Math.max(maxConcurrent, ++running)
      await new Promise((r) => setTimeout(r, 5000)) // a read 5× the interval
      running--
    })
    s.start('bathy', 1000, tick)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(maxConcurrent).toBe(1) // re-arms only after the previous tick settles
  })

  it('keeps polling after a failed tick, surfacing the error', async () => {
    // A poll of a live network is allowed to blip; a loop that dies on the first flaky
    // response is not a refresh policy. (This is the deliberate divergence from
    // CoverageTimePlayer, which DOES stop — there a failure means a real bug.)
    const s = new CoverageRefreshScheduler()
    const onError = vi.fn()
    let calls = 0
    const tick = vi.fn(async () => {
      if (++calls === 1) throw new Error('502 from the proxy')
    })
    s.start('bathy', 1000, tick, onError)
    await vi.advanceTimersByTimeAsync(3100)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(tick).toHaveBeenCalledTimes(3) // the loop survived the failure
  })

  // #1573 — the case above uses a benign `vi.fn()` handler, so it never reached the one
  // path that COULD stop this loop. `onError?.(err)` ran unguarded INSIDE the catch, so a
  // host handler that itself throws propagated out, rejected the async `run()` — invoked as
  // `void run()`, so the rejection was discarded — and skipped the conditional re-arm.
  // Polling of a live safety-relevant chart then stopped forever while the `timers` entry
  // left behind kept `isRunning()` answering true: bookkeeping alive, loop dead.
  it('survives an onError handler that itself throws', async () => {
    const s = new CoverageRefreshScheduler()
    const onError = vi.fn(() => {
      throw new Error('the host error handler is buggy')
    })
    let calls = 0
    const tick = vi.fn(async () => {
      if (++calls === 1) throw new Error('502 from the proxy')
    })
    s.start('bathy', 1000, tick, onError)
    await vi.advanceTimersByTimeAsync(3100)
    // Before the fix: tick ran exactly ONCE and no timer was pending, with isRunning true.
    expect(tick).toHaveBeenCalledTimes(3)
    expect(s.isRunning('bathy'), 'and the bookkeeping still matches reality').toBe(true)
  })

  it('a restart is not doubled by the tick that was in flight', async () => {
    // start() during an in-flight tick must leave exactly ONE loop running: the old tick
    // re-arming on top of the new loop would silently double the poll rate.
    const s = new CoverageRefreshScheduler()
    const slow = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 3000))
    })
    s.start('bathy', 1000, slow)
    await vi.advanceTimersByTimeAsync(1500) // first tick is mid-flight
    const fresh = vi.fn(async () => {})
    s.start('bathy', 1000, fresh) // restart while it runs
    await vi.advanceTimersByTimeAsync(5000)
    expect(slow).toHaveBeenCalledTimes(1) // the superseded loop never ran again
    // The new loop ticks on ITS schedule only — 5 s at a 1 s interval, not doubled.
    expect(fresh.mock.calls.length).toBeLessThanOrEqual(5)
    expect(fresh.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('stopAll ends every source loop (the destroy() path)', async () => {
    const s = new CoverageRefreshScheduler()
    const a = vi.fn(async () => {})
    const b = vi.fn(async () => {})
    s.start('bathy', 1000, a)
    s.start('currents', 1000, b)
    await vi.advanceTimersByTimeAsync(1100)
    s.stopAll()
    await vi.advanceTimersByTimeAsync(9000)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(s.isRunning('bathy')).toBe(false)
    expect(s.isRunning('currents')).toBe(false)
  })
})
