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
    const ret = resumeDeviceLostRecovery({ deviceLost: true }, budget, { recover })
    expect(ret).toBe(false)
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
