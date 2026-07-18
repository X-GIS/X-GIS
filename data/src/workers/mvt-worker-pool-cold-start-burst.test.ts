// #1155 F3 — cold-start burst raises the per-frame resolve-drain cap from the
// steady 4 to 32 while a burst refcount is held. The pool is a module-level
// singleton shared across maps (getSharedMvtPool), so the burst state is a
// REFCOUNT (begin/end), NOT a boolean: two maps both cold-starting each raise
// it, and the cap drops back to 4 only when the LAST one ends. endColdStartBurst
// clamps at 0 so a double-end (an exit predicate that already fired, then a
// destroy) can never underflow the shared refcount and strand a sibling map's
// burst.
//
// The cap is read INSIDE drainResolveQueue at FIRE time (not captured when the
// drain was scheduled), so an already-armed rAF/250 ms drain picks up a burst
// that began between schedule and fire. These tests drive drainResolveQueue
// directly — no rAF needed — and mirror the drain-throttled sibling's
// FakeWorker + private-field seam.

import { afterEach, describe, expect, it, vi } from 'vitest'

const { FakeWorker } = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = []
    listeners: Record<string, unknown> = {}
    constructor(_opts?: unknown) {
      FakeWorker.instances.push(this)
    }
    addEventListener(): void {}
    postMessage(): void {}
    terminate(): void {}
  }
  return { FakeWorker }
})

vi.mock('./mvt-worker.ts?worker', () => ({ default: FakeWorker }))

import { MvtWorkerPool } from './mvt-worker-pool'

/** Private-field seam — present at runtime, private in TS. Mirrors the sibling
 *  mvt-worker-pool-drain-throttled.test.ts harness. */
type PoolInternals = {
  resolveQueue: Array<{
    job: { resolve: (v: unknown) => void; reject: (e: Error) => void; workerIndex: number }
    slices: unknown[]
  }>
  drainResolveQueue(): void
}
function internals(pool: MvtWorkerPool): PoolInternals {
  return pool as unknown as PoolInternals
}
/** Buffer N decode results directly into the queue the way the 'compile-done'
 *  handler does. */
function enqueueN(pool: MvtWorkerPool, n: number): void {
  const inner = internals(pool)
  for (let i = 0; i < n; i++) {
    inner.resolveQueue.push({
      job: { resolve() {}, reject() {}, workerIndex: 0 },
      slices: [],
    })
  }
}

describe('MvtWorkerPool — cold-start burst drain cap (#1155 F3)', () => {
  const pools: MvtWorkerPool[] = []
  function makePool(): MvtWorkerPool {
    const p = new MvtWorkerPool()
    pools.push(p)
    return p
  }
  afterEach(() => {
    // Each 40-item drain reschedules a follow-up (setTimeout(0) in node);
    // dispose() cancels it so no drain fires after the test.
    for (const p of pools.splice(0)) p.dispose()
  })

  it('steady state (no refcount) drains at most 4 per drain', () => {
    const pool = makePool()
    enqueueN(pool, 40)
    internals(pool).drainResolveQueue()
    expect(pool.maxDrainSize).toBe(4)
    expect(internals(pool).resolveQueue.length).toBe(36)
  })

  it('with a burst refcount held, one drain processes up to 32', () => {
    const pool = makePool()
    enqueueN(pool, 40)
    pool.beginColdStartBurst()
    expect(pool.coldStartBurstRefcount).toBe(1)
    internals(pool).drainResolveQueue()
    expect(pool.maxDrainSize).toBe(32)
    expect(internals(pool).resolveQueue.length).toBe(8)
  })

  it('after the refcount returns to 0 the cap returns to 4', () => {
    const pool = makePool()
    pool.beginColdStartBurst()
    pool.endColdStartBurst()
    expect(pool.coldStartBurstRefcount).toBe(0)
    enqueueN(pool, 40)
    internals(pool).drainResolveQueue()
    expect(pool.maxDrainSize).toBe(4)
  })

  it('begin x2 / end x1 keeps burst on (refcount 1) — the shared-pool contract', () => {
    const pool = makePool()
    pool.beginColdStartBurst()
    pool.beginColdStartBurst()
    pool.endColdStartBurst()
    expect(pool.coldStartBurstRefcount).toBe(1)
    enqueueN(pool, 40)
    internals(pool).drainResolveQueue()
    expect(pool.maxDrainSize).toBe(32)
  })

  it('endColdStartBurst clamps at 0 — a double-end never underflows', () => {
    const pool = makePool()
    pool.endColdStartBurst()
    pool.endColdStartBurst()
    expect(pool.coldStartBurstRefcount).toBe(0)
    // And the cap is still the steady 4 (underflow would have selected 32).
    enqueueN(pool, 40)
    internals(pool).drainResolveQueue()
    expect(pool.maxDrainSize).toBe(4)
  })

  it('a burst that begins after the queue filled is picked up at drain fire time', () => {
    const pool = makePool()
    enqueueN(pool, 40) // queued while steady
    pool.beginColdStartBurst() // burst begins BEFORE the drain fires
    internals(pool).drainResolveQueue()
    expect(pool.maxDrainSize).toBe(32)
  })
})
