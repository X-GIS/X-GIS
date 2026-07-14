// scheduleResolveDrain() must make progress even when requestAnimationFrame is
// throttled (part 1 of #1088).
//
// Bug: scheduleResolveDrain() drained the resolveQueue via a bare
// requestAnimationFrame callback whenever rAF existed. Chrome throttles rAF to
// ~0-1 Hz for hidden/occluded pages (a headless probe measured 5 rAF ticks in
// 18 s), so decoded tiles buffered in resolveQueue sat undelivered for many
// seconds per batch — the catalog's loadingTiles stayed populated and the map
// converged 10-100x slower than the network delivered bytes.
//
// Fix: RACE the rAF against a coarse 250 ms setTimeout. Whichever fires first
// runs the drain and cancels the other, so a fully-throttled page still drains
// MAX_RESOLVES_PER_FRAME (4) every 250 ms while a healthy page keeps rAF pacing
// (burst smoothing). dispose() now cancels BOTH raced handles.
//
// vitest runs in node and the pool's top-level `import MvtWorker from
// './mvt-worker.ts?worker'` triggers Vite's worker-constructor transform vitest
// can't resolve, so we mock that `?worker` import with a no-op fake Worker.
// requestAnimationFrame / cancelAnimationFrame are stubbed as globals so the rAF
// callback is CAPTURED (fired only on demand) and cancellation is recorded;
// setTimeout runs on vi.useFakeTimers so the 250 ms floor is driven explicitly.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { FakeWorker } = vi.hoisted(() => {
  type Listener = (e: unknown) => void
  class FakeWorker {
    static instances: FakeWorker[] = []
    listeners: Record<string, Listener[]> = {}
    postedMessages: unknown[] = []
    terminated = false
    constructor(_opts?: unknown) {
      FakeWorker.instances.push(this)
    }
    addEventListener(type: string, fn: Listener): void {
      ;(this.listeners[type] ??= []).push(fn)
    }
    postMessage(msg: unknown): void {
      this.postedMessages.push(msg)
    }
    terminate(): void {
      this.terminated = true
    }
    emit(type: string, event: unknown): void {
      for (const fn of this.listeners[type] ?? []) fn(event)
    }
  }
  return { FakeWorker }
})

vi.mock('./mvt-worker.ts?worker', () => ({ default: FakeWorker }))

import { MvtWorkerPool } from './mvt-worker-pool'

/** Private-field accessors — present at runtime, private in TS. Mirrors the
 *  sibling mvt-worker-pool-dispose.test.ts harness. */
type PoolInternals = {
  resolveQueue: Array<{
    job: { resolve: (v: unknown) => void; reject: (e: Error) => void; workerIndex: number }
    slices: unknown[]
  }>
  resolveScheduled: boolean
  _rafHandle: number | null
  _timerHandle: ReturnType<typeof setTimeout> | null
  scheduleResolveDrain(): void
}
function internals(pool: MvtWorkerPool): PoolInternals {
  return pool as unknown as PoolInternals
}

describe('MvtWorkerPool — resolve-drain scheduling races rAF against a 250 ms timer (#1088)', () => {
  const RAF_HANDLE = 4242
  let capturedRafCb: (() => void) | null
  let rafCancelled: boolean
  let cancelledRafHandles: number[]

  beforeEach(() => {
    FakeWorker.instances = []
    capturedRafCb = null
    rafCancelled = false
    cancelledRafHandles = []
    vi.useFakeTimers()
    // Capture the rAF callback (do NOT run it) so each test decides whether rAF
    // "fires" — modelling a healthy frame vs. a throttled/occluded page. Return a
    // known handle so cancellation is observable.
    vi.stubGlobal('requestAnimationFrame', (cb: () => void): number => {
      capturedRafCb = cb
      rafCancelled = false
      return RAF_HANDLE
    })
    vi.stubGlobal('cancelAnimationFrame', (h: number): void => {
      cancelledRafHandles.push(h)
      if (h === RAF_HANDLE) rafCancelled = true
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  /** Buffer one decode result into the queue exactly as the worker
   *  'compile-done' handler does, tracking whether its job was resolved. */
  function enqueue(pool: MvtWorkerPool): { resolved: boolean } {
    const flag = { resolved: false }
    internals(pool).resolveQueue.push({
      job: {
        resolve() {
          flag.resolved = true
        },
        reject() {},
        workerIndex: 0,
      },
      slices: [],
    })
    return flag
  }

  /** A real browser runs a captured rAF callback only if it wasn't cancelled. */
  function fireRaf(): void {
    if (capturedRafCb && !rafCancelled) capturedRafCb()
  }

  it('delivers a queued result via the 250 ms timer when rAF is throttled and never fires', () => {
    const pool = new MvtWorkerPool()
    const inner = internals(pool)
    const flag = enqueue(pool)
    inner.scheduleResolveDrain()

    // Both raced handles were armed; nothing has drained yet.
    expect(inner.resolveScheduled).toBe(true)
    expect(inner._rafHandle).toBe(RAF_HANDLE)
    expect(inner._timerHandle).not.toBeNull()
    expect(pool.totalResolved).toBe(0)
    expect(inner.resolveQueue.length).toBe(1)

    // rAF stays throttled — it never fires (fireRaf is deliberately NOT called).
    // Only the coarse timer can make progress. PRE-FIX this drains nothing (the
    // drain waited on rAF forever) so totalResolved stays 0 / the item stays
    // queued and the assertions below fail.
    vi.advanceTimersByTime(250)

    expect(flag.resolved).toBe(true)
    expect(pool.totalResolved).toBe(1)
    expect(pool.totalDrains).toBe(1)
    expect(inner.resolveQueue.length).toBe(0)
    // The timer callback cancelled the still-pending rAF and cleared both handles.
    expect(cancelledRafHandles).toContain(RAF_HANDLE)
    expect(inner._rafHandle).toBeNull()
    expect(inner._timerHandle).toBeNull()
  })

  it('cancels the 250 ms timer when rAF wins the race — exactly one drain', () => {
    const pool = new MvtWorkerPool()
    const inner = internals(pool)
    const flag = enqueue(pool)
    inner.scheduleResolveDrain()
    expect(inner._timerHandle).not.toBeNull()

    // rAF fires on its frame (before the 250 ms timer) and drains.
    fireRaf()

    expect(flag.resolved).toBe(true)
    expect(pool.totalResolved).toBe(1)
    expect(pool.totalDrains).toBe(1)
    // rAF's callback cleared both handles — the coarse timer was cancelled.
    expect(inner._rafHandle).toBeNull()
    expect(inner._timerHandle).toBeNull()

    // Advancing past the timer window must NOT run a second drain.
    vi.advanceTimersByTime(500)
    expect(pool.totalDrains).toBe(1)
    expect(pool.totalResolved).toBe(1)
  })

  it('dispose() cancels BOTH raced handles — no post-dispose drain', () => {
    const pool = new MvtWorkerPool()
    const inner = internals(pool)
    enqueue(pool)
    inner.scheduleResolveDrain()
    expect(inner._rafHandle).toBe(RAF_HANDLE)
    expect(inner._timerHandle).not.toBeNull()

    expect(() => pool.dispose()).not.toThrow()

    // Both handles cancelled + nulled, queue dropped, scheduler flag reset.
    expect(cancelledRafHandles).toContain(RAF_HANDLE)
    expect(inner._rafHandle).toBeNull()
    expect(inner._timerHandle).toBeNull()
    expect(inner.resolveScheduled).toBe(false)
    expect(inner.resolveQueue.length).toBe(0)

    // Firing whatever was scheduled must not resurrect the drain: the rAF was
    // cancelled (fireRaf is a no-op) and the timer was cleared (advance is inert).
    expect(() => {
      fireRaf()
      vi.advanceTimersByTime(500)
    }).not.toThrow()
    expect(pool.totalDrains).toBe(0)
    expect(pool.totalResolved).toBe(0)
  })
})
