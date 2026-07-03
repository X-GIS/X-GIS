// Regression test for the MVT compile worker pool's per-worker 'error' handler.
//
// Bug: the pool dispatches compiles round-robin across N workers, keyed by
// taskId only (no worker affinity). When ONE worker fired an 'error' event the
// handler rejected EVERY in-flight job across ALL workers
// (`for (const job of this.pending.values()) job.reject(err); this.pending.clear()`).
// The other N-1 workers are still alive and DO post their 'compile-done'
// messages, but those now hit the `if (!job) return` early-out (the pending
// entry was already cleared) and the good results are silently dropped. So one
// worker crashing turned into a burst of spuriously-failed tiles (blank /
// re-requested) plus discarded good decodes.
//
// Fix: record the dispatching worker's index in the PendingJob, and on 'error'
// reject + delete ONLY the entries whose workerIndex === the crashed worker's
// index. Jobs on the surviving workers stay in flight and still resolve.
//
// vitest runs in the node environment and the pool's top-level
// `import MvtWorker from './mvt-worker.ts?worker'` triggers Vite's
// worker-constructor transform that vitest can't resolve, so we mock that
// `?worker` import with a fake Worker that captures listeners + postMessage and
// lets the test fire synthetic 'error' / 'message' events. Mirrors the sibling
// geojson-compile-pool.error.test.ts harness.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { FakeWorker } = vi.hoisted(() => {
  type Listener = (e: unknown) => void
  /** Fake Worker recording its listeners + posted messages so the test can
   *  fire synthetic 'error' / 'message' events and inspect round-robin
   *  dispatch. postMessage never echoes anything back on its own. */
  class FakeWorker {
    static instances: FakeWorker[] = []
    listeners: Record<string, Listener[]> = {}
    postedMessages: Array<{ kind?: string; taskId?: number }> = []
    terminated = false

    constructor(_opts?: unknown) {
      FakeWorker.instances.push(this)
    }
    addEventListener(type: string, fn: Listener): void {
      ;(this.listeners[type] ??= []).push(fn)
    }
    postMessage(msg: { kind?: string; taskId?: number }): void {
      this.postedMessages.push(msg)
    }
    terminate(): void {
      this.terminated = true
    }
    /** Dispatch a synthetic event to every registered listener of `type`. */
    emit(type: string, event: unknown): void {
      for (const fn of this.listeners[type] ?? []) fn(event)
    }
  }
  return { FakeWorker }
})

vi.mock('./mvt-worker.ts?worker', () => ({ default: FakeWorker }))

import { MvtWorkerPool } from './mvt-worker-pool'

/** Internal pending Map accessor — private in TS, present at runtime. */
function pendingSize(pool: MvtWorkerPool): number {
  return (pool as unknown as { pending: Map<number, unknown> }).pending.size
}

/** Dispatch one compile; the bytes/geometry args are irrelevant to the
 *  dispatch + error-routing logic under test. */
function dispatch(pool: MvtWorkerPool): Promise<unknown> {
  return pool.compile(new ArrayBuffer(8), 0, 0, 0, 14, 1, 1)
}

describe('MvtWorkerPool — per-worker error isolation', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    // Force a deterministic pool size >= 2 so two compiles round-robin to
    // distinct workers. size = max(2, min(ceiling, hc - 1)); hc = 4 -> 3.
    vi.stubGlobal('navigator', { hardwareConcurrency: 4 })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("rejects ONLY the crashed worker's job and keeps the survivor in flight", async () => {
    const pool = new MvtWorkerPool()

    // Two compiles round-robin: job A -> worker0, job B -> worker1.
    const a = dispatch(pool)
    const b = dispatch(pool)
    expect(pendingSize(pool)).toBe(2)

    // Identify which fake worker received which job by the posted taskId.
    const worker0 = FakeWorker.instances.find((w) => w.postedMessages.length > 0)!
    const worker1 = FakeWorker.instances.find((w) => w.postedMessages.length > 0 && w !== worker0)!
    expect(worker0).toBeDefined()
    expect(worker1).toBeDefined()
    const taskIdA = worker0.postedMessages[0].taskId!
    const taskIdB = worker1.postedMessages[0].taskId!
    expect(taskIdA).not.toBe(taskIdB)

    // Surviving worker1's job must NOT reject when worker0 crashes — track it.
    let bRejected = false
    void b.then(
      () => {},
      () => {
        bRejected = true
      },
    )

    // Crash ONLY worker0.
    worker0.emit('error', { message: 'worker0 crashed' })

    // Job A (on worker0) rejects with the crash message.
    await expect(a).rejects.toThrow('worker0 crashed')

    // Job B (on worker1) was NOT rejected by the crash — still in flight.
    expect(bRejected).toBe(false)
    expect(pendingSize(pool)).toBe(1)

    // worker1 now posts its compile-done — job B must still resolve. Before the
    // fix this taskId had been cleared by worker0's error handler, so the
    // message hit `if (!job) return` and the good result was silently dropped.
    worker1.emit('message', {
      data: { kind: 'compile-done', taskId: taskIdB, slices: [] },
    })
    await expect(b).resolves.toEqual([])
    expect(pendingSize(pool)).toBe(0)
  })
})
