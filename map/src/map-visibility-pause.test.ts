// ═══ Map visibility park/resume + single-rAF scheduling (#1153 M5) ═══
//
// The render loop reschedules through ONE authority, _scheduleFrame(), which
// parks while hidden and DEDUPES so at most one rAF is ever queued. Storing the
// handle lets _onDocHidden() cancel the pending tick, which is what prevents a
// resume from building a SECOND rAF chain (the regression the pre-M5 loop — which
// stored no handle — would have caused). A resume after an iOS hidden-tab GPU
// reclaim arms the deferred device-lost recovery instead of re-arming a dead loop.
//
// Fail-before (by construction): _scheduleFrame / _onDocHidden / _onDocVisible did
// not exist and NO rAF handle was stored anywhere, so hide could not cancel a
// pending tick and a naive resume produced two live chains.

import { describe, it, expect, vi } from 'vitest'
import { XGISMap } from './map'

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

/** Fake rAF that RECORDS live registrations and never invokes the callback (so
 *  `_rafId` stays set after a schedule — the dedupe/double-chain conditions). */
function installFakeRaf() {
  const gg = globalThis as unknown as {
    requestAnimationFrame?: unknown
    cancelAnimationFrame?: unknown
  }
  const prevR = gg.requestAnimationFrame
  const prevC = gg.cancelAnimationFrame
  let nextId = 1
  const live = new Set<number>()
  gg.requestAnimationFrame = (): number => {
    const id = nextId++
    live.add(id)
    return id
  }
  gg.cancelAnimationFrame = (id: number): void => {
    live.delete(id)
  }
  return {
    liveCount: () => live.size,
    totalScheduled: () => nextId - 1,
    restore: () => {
      gg.requestAnimationFrame = prevR
      gg.cancelAnimationFrame = prevC
    },
  }
}

type MapInternals = any

describe('#1153 M5 — _scheduleFrame single-rAF authority', () => {
  it('dedupes: two consecutive _scheduleFrame() register exactly ONE rAF', () => {
    const raf = installFakeRaf()
    const map = new XGISMap(stubCanvas())
    const m = map as MapInternals
    m._scheduleFrame()
    m._scheduleFrame()
    expect(raf.totalScheduled()).toBe(1)
    expect(raf.liveCount()).toBe(1)
    map.destroy()
    raf.restore()
  })

  it('parks while hidden: _scheduleFrame() schedules nothing when _docHidden', () => {
    const raf = installFakeRaf()
    const map = new XGISMap(stubCanvas())
    const m = map as MapInternals
    m._docHidden = true
    m._scheduleFrame()
    expect(raf.totalScheduled()).toBe(0)
    map.destroy()
    raf.restore()
  })

  it('_onDocHidden cancels the pending rAF and nulls the stored handle', () => {
    const raf = installFakeRaf()
    const map = new XGISMap(stubCanvas())
    const m = map as MapInternals
    m._scheduleFrame()
    expect(raf.liveCount()).toBe(1)
    m._onDocHidden()
    expect(raf.liveCount()).toBe(0)
    expect(m._rafId).toBeNull()
    map.destroy()
    raf.restore()
  })

  it('double-chain regression: hide (cancel) then resume leaves exactly ONE live rAF chain', () => {
    const raf = installFakeRaf()
    const map = new XGISMap(stubCanvas())
    const m = map as MapInternals
    m._scheduleFrame() // chain 1 armed
    expect(raf.liveCount()).toBe(1)
    m._onDocHidden() // cancels chain 1
    expect(raf.liveCount()).toBe(0)
    m._onDocVisible() // resume: invalidate + _scheduleFrame → chain 2
    expect(raf.liveCount()).toBe(1) // exactly ONE, not two
    map.destroy()
    raf.restore()
  })
})

describe('#1153 M5 — resume composes with device-lost recovery', () => {
  it('lost device on resume: arms deferred recovery ONCE (burns one budget unit), does NOT schedule the dead loop', async () => {
    const raf = installFakeRaf()
    const map = new XGISMap(stubCanvas())
    const m = map as MapInternals
    m.ctx = { rhi: { backend: 'webgpu', destroy() {} }, deviceLost: true }
    const recover = vi.fn()
    m._armDeviceLostRecovery(recover) // stashes _deviceLostRecover
    m._docHidden = true // we were hidden
    m._onDocVisible()
    await Promise.resolve() // flush the microtask
    expect(recover).toHaveBeenCalledTimes(1)
    expect(m._deviceLostBudget.recoveries).toBe(1)
    expect(raf.liveCount()).toBe(0) // the fresh run() restarts the loop, not us
    map.destroy()
    raf.restore()
  })

  it('duplicate visible signals arm recovery ONCE — no double budget burn / concurrent run() (#1153 M5c)', async () => {
    // Fail-before: _onDocVisible burned a budget unit + queued a run() on EVERY call
    // while ctx.deviceLost stayed true. The re-init is async, so the stale lost ctx
    // persists across the initGPU await — and a bfcache restore fires BOTH pageshow
    // AND visibilitychange → two calls → budget 0→2 (exhausted) + two racing run()s on
    // one canvas. The in-flight latch makes the second call a no-op.
    const raf = installFakeRaf()
    const map = new XGISMap(stubCanvas())
    const m = map as MapInternals
    m.ctx = { rhi: { backend: 'webgpu', destroy() {} }, deviceLost: true }
    const recover = vi.fn() // a real run() replaces ctx; this stub leaves deviceLost true
    m._armDeviceLostRecovery(recover)
    m._docHidden = true
    m._onDocVisible() // pageshow
    m._onDocVisible() // visibilitychange, ms later — ctx.deviceLost still true (re-init async)
    await Promise.resolve()
    expect(recover).toHaveBeenCalledTimes(1) // ONCE, not twice
    expect(m._deviceLostBudget.recoveries).toBe(1) // ONE unit burned, not 2 (max=2)
    map.destroy()
    raf.restore()
  })

  it('live device on resume: normal invalidate + schedule (no recovery)', () => {
    const raf = installFakeRaf()
    const map = new XGISMap(stubCanvas())
    const m = map as MapInternals
    m.ctx = { rhi: { backend: 'webgpu', destroy() {} }, deviceLost: false }
    const recover = vi.fn()
    m._armDeviceLostRecovery(recover)
    m._docHidden = true
    m._onDocVisible()
    expect(recover).not.toHaveBeenCalled()
    expect(raf.liveCount()).toBe(1) // resumed the loop
    map.destroy()
    raf.restore()
  })

  it('destroy() cancels a pending rAF and clears the visibility detach', () => {
    const raf = installFakeRaf()
    const map = new XGISMap(stubCanvas())
    const m = map as MapInternals
    m._scheduleFrame()
    expect(raf.liveCount()).toBe(1)
    map.destroy()
    expect(raf.liveCount()).toBe(0) // destroy cancelled the pending tick
    expect(m._rafId).toBeNull()
    expect(m._detachVisibilityPause).toBeNull()
    raf.restore()
  })
})
