// ═══ #1572 A — every worker failure path settles the promise it owns ═══
//
// The pool stored a bare `resolve` per task. An `{kind:'error'}` reply deleted the entry
// and logged, so the promise NEVER settled: `inFlight` kept the key forever, and
// `shaderEmitPending()` — which `hillshade-renderer.ts:375` ORs into `hasFadingTiles()`,
// which both `map.ts` and `render-loop.ts` read as "keep rendering" — was true for the
// page lifetime. Relief stayed blank with no retry possible (`requestShaderSources`
// returns the same dead promise per key) and both backends were pinned hot.
//
// The second half was structural: there was no worker `'error'` listener at all, only
// `'message'`. The `try/catch` around construction covers the SYNCHRONOUS throw, so an
// async worker-load failure (404'd module chunk on a deploy rollover, a CSP block) left
// `_worker` non-null and every later request posted into a dead worker and hung. The three
// sibling pools all register one.
//
// Both are settled through the SAME synchronous `emitFor` a worker-less host uses — the
// pool's own documented degradation — because there is a real answer available and the
// sole production caller fires this as `void requestShaderSources(...)` every frame, where
// a rejection would be an unhandled rejection per frame.
//
// The rest of the suite (shader-emit-pool.test.ts) runs the no-Worker path, which is why
// none of this was reachable there: these tests stub a global `Worker` so the pool takes
// its worker branch, and import the module fresh so its module-level state starts clean.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { configureProjections } from '../dsl/projections'
import { PROJECTIONS } from '@xgis/geo'
import type { ShaderEmitRequest } from './shader-emit-request'

configureProjections(PROJECTIONS)

type Listener = (e: unknown) => void

/** A Worker that answers nothing on its own — the test drives every reply, so each case
 *  states exactly which failure it is reproducing. */
class FakeWorker {
  static instances: FakeWorker[] = []
  listeners: Record<string, Listener[]> = {}
  posted: Array<{ taskId: number }> = []

  constructor(_url?: unknown, _opts?: unknown) {
    FakeWorker.instances.push(this)
  }
  addEventListener(type: string, fn: Listener): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  postMessage(msg: { taskId: number }): void {
    this.posted.push(msg)
  }
  terminate(): void {}
  emit(type: string, event: unknown): void {
    for (const fn of this.listeners[type] ?? []) fn(event)
  }
}

async function freshPool(): Promise<typeof import('./shader-emit-pool')> {
  vi.resetModules()
  const mod = await import('./shader-emit-pool')
  // The fresh module instance re-imports `projections`, whose configuration is
  // module-scoped — without this the emitters throw before reaching anything under test.
  const { configureProjections: cp } = await import('../dsl/projections')
  cp(PROJECTIONS)
  return mod
}

const REQ: ShaderEmitRequest = { family: 'hillshade', pick: false, methodFlag: 0 }

beforeEach(() => {
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/** Let microtasks and one macrotask run. Every assertion below is written against this
 *  rather than awaiting the promise directly: unsettled is the PRE-FIX state, and a bare
 *  `await` would report it as a suite timeout instead of naming what failed. */
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe("#1572 A — an 'error' reply settles through the main-thread emit", () => {
  it('resolves the request and clears the pending flag', async () => {
    const pool = await freshPool()

    let settled = false
    void pool.requestShaderSources(REQ, false).then(() => {
      settled = true
    })
    const w = FakeWorker.instances[0]
    expect(w, 'the pool took its worker branch').toBeDefined()
    expect(pool.shaderEmitPending(), 'in flight while the worker holds it').toBe(true)

    // The worker's own catch posts this ("Reported, never swallowed").
    w.emit('message', {
      data: { kind: 'error', taskId: w.posted[0].taskId, message: 'emit blew up' },
    })
    await tick()

    expect(settled, 'the promise must settle — before the fix it never did').toBe(true)
    expect(pool.shaderEmitPending(), 'and the keep-rendering flag must drop').toBe(false)
    // Settled with a REAL answer, so the layer draws instead of staying blank.
    expect(pool.peekShaderSources(REQ)?.vertex.length).toBeGreaterThan(0)
  })

  it('CONTROL — a healthy reply still serves the WORKER-s bytes, not a local re-emit', async () => {
    const pool = await freshPool()

    void pool.requestShaderSources(REQ, false)
    const w = FakeWorker.instances[0]
    const sources = { vertex: 'FROM_WORKER', fragment: 'f', wgsl: '' }
    w.emit('message', { data: { kind: 'sources', taskId: w.posted[0].taskId, sources } })
    await tick()

    // Without this arm, a pool that answered EVERY reply from the main thread would pass
    // the case above while quietly discarding all off-thread work.
    expect(pool.peekShaderSources(REQ)?.vertex).toBe('FROM_WORKER')
  })
})

describe("#1572 A — a worker 'error' event retires the worker", () => {
  it('settles the orphans it was holding', async () => {
    const pool = await freshPool()

    let settled = false
    void pool.requestShaderSources(REQ, false).then(() => {
      settled = true
    })
    const w = FakeWorker.instances[0]

    // The async load failure the pool had no listener for at all.
    w.emit('error', { message: 'chunk 404' })
    await tick()

    expect(settled, 'a request in flight at the failure must not hang').toBe(true)
    expect(pool.shaderEmitPending()).toBe(false)
  })

  it('routes every LATER request straight to the main thread', async () => {
    const pool = await freshPool()

    void pool.requestShaderSources(REQ, false)
    const w = FakeWorker.instances[0]
    w.emit('error', { message: 'chunk 404' })
    await tick()

    const other: ShaderEmitRequest = { family: 'hillshade', pick: false, methodFlag: 2 }
    let settled = false
    void pool.requestShaderSources(other, false).then(() => {
      settled = true
    })
    await tick()

    // Before the fix `_worker` stayed non-null after an async load failure, so this
    // posted into a dead worker and hung forever.
    expect(FakeWorker.instances.length, 'no replacement worker is spawned').toBe(1)
    expect(w.posted.length, 'and nothing more is posted to the dead one').toBe(1)
    expect(settled, 'the request is answered on the main thread instead').toBe(true)
    expect(pool.peekShaderSources(other)?.vertex.length).toBeGreaterThan(0)
  })
})
