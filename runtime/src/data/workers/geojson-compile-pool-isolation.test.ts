// Per-worker error isolation for the GeoJSON COMPILE pool.
//
// Bug (incomplete-fix regression of #323): #323 fixed the mvt-worker-pool's
// 'error' handler to reject only the crashed worker's jobs, but the sibling
// geojson-compile-pool was left rejecting EVERY in-flight job + clearing the
// whole pending Map on a single worker's 'error'. The pool dispatches compiles
// round-robin across up to 4 workers keyed by taskId only; when one worker
// crashed, the other N-1 workers were still alive and DID post their
// 'compile-done', but those messages now hit the `if (!job) return` early-out
// (the pending entry was already cleared) and the good results were silently
// dropped — one worker crashing spuriously failed every concurrent compile.
//
// Fix (mirrors mvt-worker-pool): record the dispatching worker's index in the
// PendingJob and on 'error' reject + delete ONLY that worker's jobs.
//
// vitest runs in the node environment and the pool's top-level
// `import GeoJSONWorker from './geojson-compile-worker.ts?worker'` triggers
// Vite's worker-constructor transform vitest can't resolve, so we mock that
// `?worker` import with a fake Worker that captures listeners + postMessage and
// lets the test fire synthetic 'error' / 'message' events. Mirrors the sibling
// mvt-worker-pool.error.test.ts harness.

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

vi.mock('./geojson-compile-worker.ts?worker', () => ({ default: FakeWorker }))

import { GeoJSONCompilePool } from './geojson-compile-pool'
import type { GeoJSONFeatureCollection } from '../../loader/geojson'

function makeFC(): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: {},
    }],
  }
}

/** Internal pending Map accessor — the field is private in TS but present at
 *  runtime; the test reads it to prove only the crashed worker's jobs clear. */
function pendingSize(pool: GeoJSONCompilePool): number {
  return (pool as unknown as { pending: Map<number, unknown> }).pending.size
}

/** A minimal `compile-done` payload that deserializeResponse accepts —
 *  empty levels deserialize cleanly and resolve the compile() Promise. */
function compileDone(taskId: number) {
  return {
    data: {
      kind: 'compile-done' as const,
      taskId,
      parts: [],
      levels: [],
      bounds: [0, 0, 0, 0] as [number, number, number, number],
      featureCount: 0,
      propertyTable: { keys: [], values: [] } as unknown,
    },
  }
}

describe('GeoJSONCompilePool — per-worker error isolation (#323 sibling)', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    // size = max(1, min(4, floor(hc / 2))). hc = 8 -> 4 distinct workers so
    // four compiles round-robin to workers 0..3 (one job each).
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('a single worker crash rejects ONLY its job; the other 3 stay in flight and still resolve', async () => {
    const pool = new GeoJSONCompilePool()

    // Four compiles, round-robin: job i -> worker i (i = 0..3).
    const jobs = [
      pool.compile(makeFC(), 0, 0, 'index'),
      pool.compile(makeFC(), 0, 0, 'index'),
      pool.compile(makeFC(), 0, 0, 'index'),
      pool.compile(makeFC(), 0, 0, 'index'),
    ]
    expect(FakeWorker.instances.length).toBe(4)
    expect(pendingSize(pool)).toBe(4)

    // Each worker received exactly one posted compile; map worker -> its taskId.
    for (const w of FakeWorker.instances) expect(w.postedMessages.length).toBe(1)
    const taskIdOf = FakeWorker.instances.map(w => w.postedMessages[0].taskId!)
    // All four taskIds distinct (no collision).
    expect(new Set(taskIdOf).size).toBe(4)

    // Track which survivor jobs reject (they must NOT when worker 0 crashes).
    const rejected = [false, false, false, false]
    jobs.forEach((p, i) => void p.then(() => {}, () => { rejected[i] = true }))

    // Crash ONLY worker 0.
    FakeWorker.instances[0].emit('error', { message: 'worker0 crashed' })

    // Job 0 (on worker 0) rejects with the crash message.
    await expect(jobs[0]).rejects.toThrow('worker0 crashed')

    // Jobs 1, 2, 3 (on the surviving workers) were NOT rejected by the crash —
    // still in flight. PRE-FIX: the handler cleared the whole pending Map, so
    // all four rejected and pendingSize dropped to 0.
    expect(rejected[1]).toBe(false)
    expect(rejected[2]).toBe(false)
    expect(rejected[3]).toBe(false)
    expect(pendingSize(pool)).toBe(3)

    // Worker 1 now posts its compile-done — job 1 must still resolve. PRE-FIX
    // this taskId had been cleared by worker 0's error handler, so the message
    // hit `if (!job) return` and the good result was silently dropped.
    FakeWorker.instances[1].emit('message', compileDone(taskIdOf[1]))
    await expect(jobs[1]).resolves.toMatchObject({ parts: [] })
    expect(pendingSize(pool)).toBe(2)
  })
})
