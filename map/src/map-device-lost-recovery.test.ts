// ═══ device-lost bounded auto-recovery — policy + map wiring (#1153 B) ═══
//
// On device loss the engine calls ctx.onDeviceLostInternal (rhi-webgpu gpu.ts).
// The map wires that seam (via _armDeviceLostRecovery) to: fire a typed 'error'
// event AND, budget + page-visibility permitting, re-run the last source through
// a fresh initGPU (the verified recovery path — a permanent freeze becomes a
// self-heal). The budget persists across re-runs so a device stuck in a loss loop
// stops re-initialising.
//
// Fail-before: the recovery module + _armDeviceLostRecovery don't exist, so a
// simulated device loss fires no event and schedules no re-run.

import { describe, it, expect, vi } from 'vitest'
import { XGISMap } from './map'
import { wireDeviceLostRecovery, resumeDeviceLostRecovery } from './device-lost-recovery'

function stubCanvas(): HTMLCanvasElement {
  return {
    width: 256,
    height: 256,
    clientWidth: 256,
    clientHeight: 256,
    style: {} as CSSStyleDeclaration,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 256, bottom: 256, width: 256, height: 256 }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLCanvasElement
}

const flushMicrotasks = (): Promise<void> => Promise.resolve()
const LOST = { reason: 'unknown', message: 'gpu gone' }

describe('wireDeviceLostRecovery policy (#1153 B)', () => {
  it('on loss: fires the error payload AND schedules recovery within budget', async () => {
    const budget = { recoveries: 0, max: 2 }
    const fireError = vi.fn()
    const recover = vi.fn()
    const ctx: { onDeviceLostInternal?: (i: typeof LOST) => void } = {}
    wireDeviceLostRecovery(ctx, budget, { fireError, recover, isVisible: () => true })
    ctx.onDeviceLostInternal!(LOST)
    expect(fireError).toHaveBeenCalledWith({ phase: 'devicelost', fatal: false, error: LOST })
    await flushMicrotasks()
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('bounded: stops recovering after max, but still fires an error each time', async () => {
    const budget = { recoveries: 0, max: 2 }
    const fireError = vi.fn()
    const recover = vi.fn()
    const ctx: { onDeviceLostInternal?: (i: typeof LOST) => void } = {}
    wireDeviceLostRecovery(ctx, budget, { fireError, recover, isVisible: () => true })
    for (let i = 0; i < 4; i++) ctx.onDeviceLostInternal!(LOST)
    await flushMicrotasks()
    expect(fireError).toHaveBeenCalledTimes(4)
    expect(recover).toHaveBeenCalledTimes(2)

    // #1576 B — and the payload has to SAY which of those it was. The event used to fire
    // unconditionally with `fatal: false` before the budget was even evaluated, so the
    // moment the map became permanently unusable was reported identically to a fault the
    // engine went on to auto-recover from — and nothing anywhere fired `fatal: true`.
    const fatals = fireError.mock.calls.map((c) => (c[0] as { fatal: boolean }).fatal)
    expect(fatals, 'recovered, recovered, dead, dead').toEqual([false, false, true, true])
  })

  it('#1576 B — a HIDDEN loss is never fatal: it burned no budget and resume will take it', async () => {
    // The control for the case above. A hidden loss skips recovery on purpose, so
    // reporting it as fatal would be as wrong in the other direction — the map is very
    // much alive and `resumeDeviceLostRecovery` picks it up on return.
    const budget = { recoveries: 0, max: 2 }
    const fireError = vi.fn()
    const ctx: { onDeviceLostInternal?: (i: typeof LOST) => void } = {}
    wireDeviceLostRecovery(ctx, budget, { fireError, recover: vi.fn(), isVisible: () => false })
    for (let i = 0; i < 4; i++) ctx.onDeviceLostInternal!(LOST)
    const fatals = fireError.mock.calls.map((c) => (c[0] as { fatal: boolean }).fatal)
    expect(fatals).toEqual([false, false, false, false])
    expect(budget.recoveries, 'and no budget was spent').toBe(0)
  })

  it('does not recover while the page is hidden (still fires the error)', async () => {
    const budget = { recoveries: 0, max: 2 }
    const fireError = vi.fn()
    const recover = vi.fn()
    const ctx: { onDeviceLostInternal?: (i: typeof LOST) => void } = {}
    wireDeviceLostRecovery(ctx, budget, { fireError, recover, isVisible: () => false })
    ctx.onDeviceLostInternal!(LOST)
    await flushMicrotasks()
    expect(fireError).toHaveBeenCalledTimes(1)
    expect(recover).not.toHaveBeenCalled()
  })

  it('hidden losses do NOT burn the budget — a later visible loss still recovers', async () => {
    // iOS reclaims the device while backgrounded (routine). If those losses
    // consumed the budget, two background reclaims would exhaust it before the
    // user ever returned — the visible loss after must still get its re-init.
    const budget = { recoveries: 0, max: 2 }
    const fireError = vi.fn()
    const recover = vi.fn()
    let visible = false
    const ctx: { onDeviceLostInternal?: (i: typeof LOST) => void } = {}
    wireDeviceLostRecovery(ctx, budget, { fireError, recover, isVisible: () => visible })
    ctx.onDeviceLostInternal!(LOST) // hidden loss 1
    ctx.onDeviceLostInternal!(LOST) // hidden loss 2 — would exhaust max=2 if burned
    await flushMicrotasks()
    expect(recover).not.toHaveBeenCalled()
    expect(budget.recoveries).toBe(0) // budget untouched while hidden

    visible = true
    ctx.onDeviceLostInternal!(LOST) // visible loss — must still recover
    await flushMicrotasks()
    expect(recover).toHaveBeenCalledTimes(1)
    expect(budget.recoveries).toBe(1)
  })
})

describe('XGISMap wires device-lost recovery onto its ctx (#1153 B)', () => {
  it('_armDeviceLostRecovery → onDeviceLostInternal fires the error event + schedules re-run', async () => {
    const map = new XGISMap(stubCanvas())
    const ctx: { onDeviceLostInternal?: (i: typeof LOST) => void } = {}
    ;(map as unknown as { ctx: unknown }).ctx = ctx
    const errs: Array<{ type: string; phase?: string; fatal?: boolean; error?: unknown }> = []
    map.on('error', (e) => errs.push(e))
    const recover = vi.fn()
    ;(map as unknown as { _armDeviceLostRecovery: (r: () => void) => void })._armDeviceLostRecovery(
      recover,
    )
    expect(typeof ctx.onDeviceLostInternal).toBe('function')

    ctx.onDeviceLostInternal!(LOST)
    expect(errs).toHaveLength(1)
    expect(errs[0]!.type).toBe('error')
    expect(errs[0]!.phase).toBe('devicelost')
    expect(errs[0]!.fatal).toBe(false)
    expect(errs[0]!.error).toEqual(LOST)
    await flushMicrotasks()
    expect(recover).toHaveBeenCalledTimes(1)
    map.destroy()
  })
})

// ═══ #1576 A/C — a re-init that FAILS must not wedge the recovery ═══
//
// The success path was verified (#1153 built it, #1359 re-verified it). This is the
// failure path, and it is the likely one: a re-init attempted right after a loss runs
// while the GPU is mid-reset. Two wedges held together, and the map stayed dead with
// budget remaining — contradicting device-lost-recovery.ts's own documented "repeated
// hide/show cycles with a failing re-init exhaust budget.max":
//
//   1. `_deviceLostResumePending` was cleared only past ctx publication, so a re-run that
//      threw earlier left it true forever and every later resume returned at the latch.
//   2. the recover closure's captured epoch was invalidated by the failed attempt's OWN
//      entry bump, so even a cleared latch would no-op at `_epochStale`.
describe('#1576 A — a failed re-init does not wedge the deferred resume', () => {
  /** A recovery that fails the way a mid-GPU-reset re-init does: it claims the run epoch
   *  at entry (as `_runProgram` does) and then rejects, so it never reaches
   *  `_armDeviceLostRecovery` and never publishes a ctx. */
  function armFailingRecovery(map: XGISMap, calls: { n: number }) {
    const seam = map as unknown as {
      ctx: unknown
      _runEpoch: number
      _armDeviceLostRecovery: (r: () => void) => void
      _settleRecovery: (p: Promise<void>, from: { epoch: number }) => void
      _epochStale: (e: number) => boolean
      _docHidden: boolean
      _onDocVisible: () => void
      _deviceLostResumePending: boolean
      _deviceLostBudget: { recoveries: number; max: number }
    }
    seam.ctx = { deviceLost: true }
    const epoch = seam._runEpoch
    const recoverFrom = { epoch }
    seam._armDeviceLostRecovery(() => {
      if (seam._epochStale(recoverFrom.epoch)) return
      calls.n++
      seam._runEpoch++ // the entry bump every real run performs
      seam._settleRecovery(Promise.reject(new Error('initGPU failed: GPU mid-reset')), recoverFrom)
    })
    return seam
  }

  it('a second visible resume still runs, and the budget is what stops it', async () => {
    const map = new XGISMap(stubCanvas())
    const calls = { n: 0 }
    const seam = armFailingRecovery(map, calls)
    const errs: Array<{ phase?: string; fatal?: boolean }> = []
    map.on('error', (e) => errs.push(e))

    seam._docHidden = true
    seam._onDocVisible()
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.n, 'the first resume ran').toBe(1)
    // Before the fix this stayed TRUE — the latch was cleared only past ctx publication,
    // which a failed run never reaches.
    expect(seam._deviceLostResumePending, 'the latch is released on failure too').toBe(false)

    seam._docHidden = true
    seam._onDocVisible()
    await new Promise((r) => setTimeout(r, 0))
    // Before the fix: 1 — the latch blocked it, and had it not, the stale captured epoch
    // would have no-oped the closure. Both wedges had to go.
    expect(calls.n, 'the second hide/show cycle recovers too').toBe(2)
    expect(seam._deviceLostBudget.recoveries).toBe(2)

    // #1576 C — and the failed re-boots are reported, instead of being unhandled
    // rejections nobody sees.
    expect(errs.filter((e) => e.phase === 'devicelost' && e.fatal === true)).toHaveLength(2)
    map.destroy()
  })

  it('CONTROL — the budget still terminates it: a third cycle does NOT run', async () => {
    // Without this, "clear the latch always" would read as "recover forever", which is
    // the opposite failure and the one the bounded-recovery contract exists to prevent.
    const map = new XGISMap(stubCanvas())
    const calls = { n: 0 }
    const seam = armFailingRecovery(map, calls)
    for (let i = 0; i < 3; i++) {
      seam._docHidden = true
      seam._onDocVisible()
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(calls.n, 'max = 2 attempts, and no more').toBe(2)
    map.destroy()
  })
})

describe('resumeDeviceLostRecovery — deferred re-init companion (#1153 M5c)', () => {
  it('lost device within budget: schedules recover (microtask), burns one unit, returns true', async () => {
    const budget = { recoveries: 0, max: 2 }
    const recover = vi.fn()
    const ret = resumeDeviceLostRecovery({ deviceLost: true }, budget, { recover })
    expect(ret).toBe(true)
    expect(budget.recoveries).toBe(1)
    await flushMicrotasks()
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('budget exhausted: no recover, returns false (bounded — the map stays dead by design)', async () => {
    const budget = { recoveries: 2, max: 2 }
    const recover = vi.fn()
    const fireError = vi.fn()
    const ret = resumeDeviceLostRecovery({ deviceLost: true }, budget, { recover, fireError })
    expect(ret).toBe(false)
    // #1576 B — "dead by design" still has to be SAID. This is the second way the map
    // dies (the deferred path), and it reported nothing at all.
    expect(fireError).toHaveBeenCalledTimes(1)
    expect((fireError.mock.calls[0]![0] as { fatal: boolean }).fatal).toBe(true)
    await flushMicrotasks()
    expect(recover).not.toHaveBeenCalled()
  })

  it('device not lost: no recover, budget untouched, returns false (normal resume runs instead)', async () => {
    const budget = { recoveries: 0, max: 2 }
    const recover = vi.fn()
    const ret = resumeDeviceLostRecovery({ deviceLost: false }, budget, { recover })
    expect(ret).toBe(false)
    expect(budget.recoveries).toBe(0)
    await flushMicrotasks()
    expect(recover).not.toHaveBeenCalled()
  })
})
