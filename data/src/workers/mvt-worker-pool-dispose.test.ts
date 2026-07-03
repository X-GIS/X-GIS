// dispose() must cancel a scheduled resolve-drain (D1).
//
// Bug: scheduleResolveDrain() called requestAnimationFrame(() =>
// this.drainResolveQueue()) and DISCARDED the handle. dispose() terminated the
// workers + rejected pending but never cancelled that pending rAF, so a drain
// scheduled just before teardown would fire AFTER dispose and resolve jobs
// against an already-disposed pool (and the buffered resolveQueue was left
// intact). Latent today (no prod disposer yet) but on the roadmap; cheap fix.
//
// Fix: retain the handle (this._rafHandle = requestAnimationFrame(...)); in
// dispose() cancelAnimationFrame(this._rafHandle), null it, reset
// resolveScheduled, and clear resolveQueue.
//
// vitest runs in node and the pool's top-level `import MvtWorker from
// './mvt-worker.ts?worker'` triggers Vite's worker-constructor transform vitest
// can't resolve, so we mock that `?worker` import with a no-op fake Worker.
// requestAnimationFrame / cancelAnimationFrame are stubbed as globals so the
// scheduled callback is CAPTURED (not run) and cancellation is recorded.

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

/** Private-field accessors — present at runtime, private in TS. */
type PoolInternals = {
  resolveQueue: unknown[]
  resolveScheduled: boolean
  _rafHandle: number | null
  scheduleResolveDrain(): void
}
function internals(pool: MvtWorkerPool): PoolInternals {
  return pool as unknown as PoolInternals
}

describe('MvtWorkerPool — dispose() cancels a scheduled resolve-drain (D1)', () => {
  const RAF_HANDLE = 4242
  let capturedRafCb: (() => void) | null
  let cancelledHandles: number[]

  beforeEach(() => {
    FakeWorker.instances = []
    capturedRafCb = null
    cancelledHandles = []
    // Capture (do NOT run) the rAF callback; return a known handle.
    vi.stubGlobal('requestAnimationFrame', (cb: () => void): number => {
      capturedRafCb = cb
      return RAF_HANDLE
    })
    vi.stubGlobal('cancelAnimationFrame', (h: number): void => {
      cancelledHandles.push(h)
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('cancels the pending rAF, clears the resolve queue, and resets the scheduled flag', () => {
    const pool = new MvtWorkerPool()
    const inner = internals(pool)

    // Enqueue a buffered resolve + schedule a drain (what a just-arrived
    // 'compile-done' does) WITHOUT running the drain — the stubbed rAF only
    // captures the callback.
    inner.resolveQueue.push({ job: { resolve() {}, reject() {}, workerIndex: 0 }, slices: [] })
    inner.scheduleResolveDrain()

    // Pre-conditions: a drain is scheduled and its handle was retained.
    expect(inner.resolveScheduled).toBe(true)
    expect(inner._rafHandle).toBe(RAF_HANDLE)
    expect(capturedRafCb).toBeTypeOf('function')
    expect(inner.resolveQueue.length).toBe(1)

    pool.dispose()

    // PRE-FIX assertions (these all FAIL before the fix):
    //   - cancelAnimationFrame was never called (handle was discarded)
    //   - resolveQueue still held the buffered item
    //   - resolveScheduled stayed true
    expect(cancelledHandles).toContain(RAF_HANDLE)
    expect(inner._rafHandle).toBeNull()
    expect(inner.resolveScheduled).toBe(false)
    expect(inner.resolveQueue.length).toBe(0)
  })
})
