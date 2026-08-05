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

  // ═══ #1572 C — a BUFFERED job must be settled, not just discarded ═══
  //
  // The D1 fix above cleared `resolveQueue`, which is necessary and not sufficient: a
  // 'compile-done' DELETES its job from `pending` (mvt-worker-pool.ts:199) and parks it
  // here, so the rejection loop in dispose() — which iterates `pending` only — never sees
  // it. The job was therefore in NEITHER settle path, its awaiter never settled, and the
  // catalog loading slot it owns (released only by `compile().finally`) wedged for good.
  //
  // The D1 test could not observe this: it buffers a no-op `{resolve(){}, reject(){}}` and
  // asserts only on `resolveQueue.length`. This one awaits a REAL promise.
  it('rejects a job already buffered for drain instead of dropping it', async () => {
    const pool = new MvtWorkerPool()
    const inner = internals(pool)

    let settled: 'resolved' | 'rejected' | 'never' = 'never'
    const buffered = new Promise<void>((resolve, reject) => {
      inner.resolveQueue.push({
        job: { resolve: () => resolve(), reject: (e: Error) => reject(e), workerIndex: 0 },
        slices: [],
      })
    })
    const tracked = buffered.then(
      () => {
        settled = 'resolved'
      },
      () => {
        settled = 'rejected'
      },
    )
    inner.scheduleResolveDrain()

    pool.dispose()
    // Raced against a macrotask rather than awaited outright: without the fix the promise
    // never settles, and a bare `await` would report that as a 5 s suite TIMEOUT instead
    // of the assertion below naming what went wrong.
    await Promise.race([tracked, new Promise((r) => setTimeout(r, 0))])

    // Before the fix this stayed 'never' across every subsequent macrotask — the promise
    // simply had no path to settlement left. Rejection (not resolution) is the contract:
    // the pool is gone, so resolving would push slices into a torn-down sink.
    expect(settled, 'a buffered job must settle when the pool is disposed').toBe('rejected')
    expect(inner.resolveQueue.length).toBe(0)
  })
})
