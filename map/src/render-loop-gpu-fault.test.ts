// #1599 — the per-frame GPU-fault drain: `ctx._validationErrors` → the typed map
// `'error'` event ({ phase: 'gpufault', fatal: false }).
//
// Before this, an ASYNC WebGPU validation / OOM fault reached `console.error`
// (rate-limited in rhi-webgpu/src/gpu.ts) and the capped context queue, and
// stopped there — it never throws out of `renderFrame`, so the 3-strike halt's
// try/catch, the only thing that fires a typed error event from the render path,
// could not see it. Every assertion below is on behaviour that did not exist:
// nothing fired a `'gpufault'` phase, and the phase was not in the union.
//
// The queue is fed through the REAL `pushValidationError` (the production writer,
// including its VALIDATION_ERROR_CAP splice-trim) rather than a hand-rolled array
// push, so the cap-saturation cases below are shaped the way production shapes
// them — the "every test passed offset zero" lesson applied to the ring.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pushValidationError, VALIDATION_ERROR_CAP } from '@xgis/rhi-webgpu'
import type { RenderContext } from '@xgis/engine'

import { GpuFaultDrain, type ErrorEventSink } from './render-loop-gpu-fault'
import type { XGISMapErrorInfo } from './layer'

const fakeCtx = (): RenderContext => ({ _validationErrors: [] }) as unknown as RenderContext

function recorder(): ErrorEventSink & { fired: XGISMapErrorInfo[] } {
  const fired: XGISMapErrorInfo[] = []
  return {
    fired,
    fireErrorEvent: (info) => {
      fired.push(info)
    },
  }
}

describe('GpuFaultDrain — validation queue → typed map error event (#1599)', () => {
  it('fires one non-fatal gpufault event per new entry, carrying its message', () => {
    const ctx = fakeCtx()
    const sink = recorder()
    const drain = new GpuFaultDrain()

    pushValidationError(ctx, 'bind group layout mismatch')
    pushValidationError(ctx, 'GL_INVALID_OPERATION')
    drain.drain(ctx, sink)

    expect(sink.fired).toEqual([
      { phase: 'gpufault', fatal: false, error: 'bind group layout mismatch' },
      { phase: 'gpufault', fatal: false, error: 'GL_INVALID_OPERATION' },
    ])
    expect(drain.faultCount).toBe(2)
  })

  it('fires NOTHING on a clean frame', () => {
    const ctx = fakeCtx()
    const sink = recorder()
    new GpuFaultDrain().drain(ctx, sink)
    expect(sink.fired).toEqual([])
  })

  it('re-draining without new entries fires nothing more', () => {
    const ctx = fakeCtx()
    const sink = recorder()
    const drain = new GpuFaultDrain()

    pushValidationError(ctx, 'a')
    drain.drain(ctx, sink)
    // Three more frames with a quiet queue — an implementation that re-walked the
    // whole queue every frame would dispatch 'a' four times into host code.
    drain.drain(ctx, sink)
    drain.drain(ctx, sink)
    drain.drain(ctx, sink)

    expect(sink.fired).toHaveLength(1)
    expect(drain.faultCount).toBe(1)
  })

  it('only the entries added SINCE the previous drain fire', () => {
    const ctx = fakeCtx()
    const sink = recorder()
    const drain = new GpuFaultDrain()

    pushValidationError(ctx, 'frame1-a')
    pushValidationError(ctx, 'frame1-b')
    drain.drain(ctx, sink)
    pushValidationError(ctx, 'frame2-a')
    drain.drain(ctx, sink)

    expect(sink.fired.map((e) => e.error)).toEqual(['frame1-a', 'frame1-b', 'frame2-a'])
  })

  it('rate policy mirrors the console sink: first 10, then every 100th', () => {
    const ctx = fakeCtx()
    const sink = recorder()
    const drain = new GpuFaultDrain()

    // 250 faults, one per frame — the sustained-defect shape (~60/s) the counter
    // exists for. gpu.ts logs at counts 0-9, 100, 200; the typed channel must agree.
    for (let i = 0; i < 250; i++) {
      pushValidationError(ctx, `err ${i}`)
      drain.drain(ctx, sink)
    }

    expect(sink.fired.map((e) => e.error)).toEqual([
      'err 0',
      'err 1',
      'err 2',
      'err 3',
      'err 4',
      'err 5',
      'err 6',
      'err 7',
      'err 8',
      'err 9',
      'err 100',
      'err 200',
    ])
    expect(sink.fired.every((e) => e.phase === 'gpufault' && e.fatal === false)).toBe(true)
  })

  it('keeps seeing faults after the queue SATURATES its cap (a length diff goes blind)', () => {
    const ctx = fakeCtx()
    const sink = recorder()
    const drain = new GpuFaultDrain()

    const n = VALIDATION_ERROR_CAP * 3 + 50
    for (let i = 0; i < n; i++) {
      pushValidationError(ctx, `err ${i}`)
      drain.drain(ctx, sink)
    }

    // The queue's LENGTH pins at the cap after the first 100 pushes and never moves
    // again — exactly while a sustained defect is firing. Tracking the last surfaced
    // entry by IDENTITY survives the front-trim, so every fault is still counted and
    // the policy still reaches its 300th tick. An implementation that diffed lengths
    // would stall at 100 observed faults and never emit 'err 200' or 'err 300'.
    expect(ctx._validationErrors).toHaveLength(VALIDATION_ERROR_CAP)
    expect(drain.faultCount).toBe(n)
    expect(sink.fired.at(-1)!.error).toBe('err 300')
  })

  it('a burst larger than the cap in ONE frame reports the entries the ring retained', () => {
    const ctx = fakeCtx()
    const sink = recorder()
    const drain = new GpuFaultDrain()

    // 250 faults between two drains: the ring keeps the LAST 100 (err 150..249),
    // so the first surfaced fault is 'err 150', not 'err 0'. Lossy by the cap's
    // design (rhi-webgpu bounds the heap) — pinned so it is a known property.
    for (let i = 0; i < 250; i++) pushValidationError(ctx, `err ${i}`)
    drain.drain(ctx, sink)

    expect(drain.faultCount).toBe(VALIDATION_ERROR_CAP)
    expect(sink.fired.map((e) => e.error)).toEqual([
      'err 150',
      'err 151',
      'err 152',
      'err 153',
      'err 154',
      'err 155',
      'err 156',
      'err 157',
      'err 158',
      'err 159',
    ])
  })

  it('survives the e2e helper clearing the queue in place', () => {
    const ctx = fakeCtx()
    const sink = recorder()
    const drain = new GpuFaultDrain()

    pushValidationError(ctx, 'a')
    pushValidationError(ctx, 'b')
    drain.drain(ctx, sink)
    // playground/e2e/helpers/validation.ts drains by setting `.length = 0`.
    ctx._validationErrors.length = 0
    drain.drain(ctx, sink)
    pushValidationError(ctx, 'c')
    drain.drain(ctx, sink)

    expect(sink.fired.map((e) => e.error)).toEqual(['a', 'b', 'c'])
    expect(drain.faultCount).toBe(3)
  })

  it('survives a host listener clearing the queue INSIDE fireErrorEvent', () => {
    const ctx = fakeCtx()
    const fired: XGISMapErrorInfo[] = []
    // The case above clears BETWEEN drains. A host `'error'` listener runs
    // SYNCHRONOUSLY inside `fireErrorEvent`, i.e. inside the drain's own walk, and
    // may clear the queue there (`.length = 0`, what the e2e helper does) — so the
    // array can empty mid-loop, under the index the walk is holding.
    const clearingSink: ErrorEventSink = {
      fireErrorEvent: (info) => {
        fired.push(info)
        ctx._validationErrors.length = 0
      },
    }
    const drain = new GpuFaultDrain()

    pushValidationError(ctx, 'a')
    pushValidationError(ctx, 'b')
    drain.drain(ctx, clearingSink)
    // 'a' fires; the listener destroys the rest of the queue with it, and the walk
    // stops at the NEW length instead of reading past the end.
    expect(fired.map((e) => e.error)).toEqual(['a'])

    // The next two frames must still be correct: no throw, no replay of 'a', and
    // entries pushed after the clear still fire.
    pushValidationError(ctx, 'c')
    drain.drain(ctx, clearingSink)
    pushValidationError(ctx, 'd')
    drain.drain(ctx, clearingSink)

    expect(fired.map((e) => e.error)).toEqual(['a', 'c', 'd'])
    expect(drain.faultCount).toBe(3)
  })

  it('does not store `undefined` as the last-seen entry after such a clear', () => {
    // `this._seen = q[q.length - 1]!` writes `q[-1]` — `undefined` — into a field
    // typed `ValidationEntry | null` on exactly the path above, and the `!` is what
    // hides that from tsc. The drain's only reader (`lastIndexOf`) happens to treat
    // `undefined` and `null` alike, so no black-box assertion can separate the two
    // states today; pin the coalesce at the source instead, so the lie cannot come
    // back and reach a future reader that DOES dereference the field.
    const drainSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'render-loop-gpu-fault.ts'),
      'utf8',
    )
    expect(drainSrc, 'the tail write asserts non-null again').not.toContain('q[q.length - 1]!')
    expect(drainSrc).toContain('this._seen = last ?? null')
  })
})

// The drain can be perfect and never run — "a diagnostic nothing can reach is not
// a diagnostic" (CLAUDE.md §12). The render loop's per-frame call needs a real GPU
// frame to exercise, which is the gate phase's e2e job; this pins the wire itself
// so deleting the call fails here and the message names the severed half.
describe('GpuFaultDrain is WIRED into the render loop (#1599)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'render-loop.ts'), 'utf8')

  it('RenderLoop owns a drain instance and drains it once per frame', () => {
    expect(src, 'render-loop.ts no longer imports GpuFaultDrain').toContain(
      "import { GpuFaultDrain } from './render-loop-gpu-fault'",
    )
    expect(src, 'RenderLoop no longer holds a GpuFaultDrain').toContain('new GpuFaultDrain()')
    expect(
      src,
      'the per-frame drain call is gone — GPU faults reach the console and stop there again',
    ).toContain('this._gpuFaults.drain(this.host.ctx, this.host._eventBus)')
  })

  it('both popped validation scopes route their message into the shared ctx queue', () => {
    // reportErrorScope's third argument is the INJECTED sink — it is what puts a
    // scope-resolved validation error into the SAME queue the drain reads
    // (render-loop-helpers.ts, #1599). Both call sites close over the real writer.
    expect(src).toContain(
      'reportErrorScope(rhiFrame.popValidationScope(), `pass:${label}`, (msg) =>',
    )
    expect(src).toContain(
      "reportErrorScope(rhiFrame.popValidationScope(), 'frame-validation', (msg) =>",
    )
    expect(src.match(/pushValidationError\(this\.host\.ctx, msg\)/g)).toHaveLength(2)
  })

  it('the popped-scope helper stays backend-NEUTRAL — the sink is injected (#991)', () => {
    // Writing the queue inside render-loop-helpers.ts needs a CONCRETE backend
    // adapter import there, and that file has no row in the #991 backend-adapter
    // ratchet's baseline (deleted at #1046 F4 Inc-A) — its STRICT per-file equality
    // turns any import into a red `vitest map/src`. Passing a `(msg: string) => void`
    // keeps the adapter import at this call site, where it is already baselined.
    const helpers = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'render-loop-helpers.ts'),
      'utf8',
    )
    expect(helpers, 'render-loop-helpers.ts took a backend-adapter import').not.toMatch(
      /from\s*['"]@xgis\/rhi-webg(?:pu|l2)['"]/,
    )
  })
})
