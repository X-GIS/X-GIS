// Regression test for the GeoJSON compile worker pool's 'error' handler.
//
// Bug: a genuine worker 'error' event (module-load failure, OOM/crash, or an
// error escaping the worker's synchronous try/catch) used to only
// `console.error` — it did NOT reject the in-flight jobs in `this.pending`.
// The Promise returned by `compile()` therefore never settled, the inline-
// GeoJSON source's tiles never applied (silent never-render), and the pending
// Map entry leaked forever. The sibling pools (mvt-worker-pool /
// geojson-tiling-pool) reject + clear on 'error'; this pool was the lone
// divergence. The fix mirrors mvt-worker-pool: reject every outstanding job
// and clear the pending Map.
//
// vitest runs in the node environment (no DOM globals), and the pool's
// top-level `import GeoJSONWorker from './geojson-compile-worker.ts?worker'`
// triggers Vite's worker-constructor transform that vitest can't resolve. So
// we mock that `?worker` import with a fake Worker that captures the registered
// listeners and lets the test dispatch a synthetic 'error' event.

import { describe, expect, it, vi, beforeEach } from 'vitest'

// `vi.mock` factories are hoisted to the top of the file, so the fake Worker
// class has to be defined inside a `vi.hoisted` block (which runs before the
// mock factory) rather than as a normal top-level declaration.
const { FakeWorker } = vi.hoisted(() => {
  type Listener = (e: unknown) => void
  /** Fake Worker that records its event listeners so the test can fire a
   *  synthetic 'error' (or 'message') event at will. Never posts anything back
   *  on its own — postMessage is a no-op, so a compile() Promise stays pending
   *  until the test settles it. */
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
    /** Dispatch a synthetic event to every registered listener of `type`. */
    emit(type: string, event: unknown): void {
      for (const fn of this.listeners[type] ?? []) fn(event)
    }
  }
  return { FakeWorker }
})

// Mock the `?worker` default import with the fake constructor. The real
// `runCompile` named export (imported by the pool from the same base module
// without the `?worker` suffix) is left untouched — but we never reach it
// here because ensureWorkers() succeeds with the fake.
vi.mock('./geojson-compile-worker.ts?worker', () => ({ default: FakeWorker }))

import { GeoJSONCompilePool } from './geojson-compile-pool'
import type { GeoJSONFeatureCollection } from '@xgis/data'

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
 *  runtime; the test reads it to prove the leak is cleared. */
function pendingSize(pool: GeoJSONCompilePool): number {
  return (pool as unknown as { pending: Map<number, unknown> }).pending.size
}

describe('GeoJSONCompilePool — worker error handling', () => {
  beforeEach(() => {
    FakeWorker.instances = []
  })

  it('rejects the in-flight compile() and clears pending when the worker errors', async () => {
    const pool = new GeoJSONCompilePool()

    // Start a compile — the fake worker never posts a result back, so this
    // Promise is outstanding (pending) until the error handler settles it.
    const p = pool.compile(makeFC(), 0, 0, 'index')

    expect(FakeWorker.instances.length).toBeGreaterThan(0)
    expect(pendingSize(pool)).toBe(1)

    // The job was dispatched to one of the round-robin workers.
    const target = FakeWorker.instances.find(w => w.postedMessages.length > 0)
    expect(target).toBeDefined()

    // Fire a synthetic worker 'error' event (e.g. worker module-load failure
    // or a crash). Before the fix this only console.error'd and the Promise
    // hung forever; after the fix it rejects every outstanding job.
    target!.emit('error', { message: 'simulated worker crash' })

    // The compile() Promise must REJECT (not hang) with the worker message.
    await expect(p).rejects.toThrow('simulated worker crash')

    // And the pending Map must be cleared — no leaked resolve/reject closures
    // (and no retained FeatureCollection).
    expect(pendingSize(pool)).toBe(0)
  })

  it('rejects every outstanding compile() when the worker errors', async () => {
    const pool = new GeoJSONCompilePool()

    const a = pool.compile(makeFC(), 0, 0, 'index')
    const b = pool.compile(makeFC(), 0, 0, 'index')
    const c = pool.compile(makeFC(), 0, 0, 'index')
    expect(pendingSize(pool)).toBe(3)

    // Fire 'error' on every spawned worker so the round-robin-distributed
    // jobs are all caught regardless of which worker holds which job.
    for (const w of FakeWorker.instances) w.emit('error', { message: 'boom' })

    await expect(a).rejects.toThrow('boom')
    await expect(b).rejects.toThrow('boom')
    await expect(c).rejects.toThrow('boom')
    expect(pendingSize(pool)).toBe(0)
  })

  it('uses a default message when the error event carries none', async () => {
    const pool = new GeoJSONCompilePool()
    const p = pool.compile(makeFC(), 0, 0, 'index')
    for (const w of FakeWorker.instances) w.emit('error', { message: '' })
    await expect(p).rejects.toThrow('geojson compile worker error')
    expect(pendingSize(pool)).toBe(0)
  })
})
