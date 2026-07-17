// R3 (#1153 P2) — WebGL2 context loss is handled (was completely unwired).
//
// Before this, a WebGL2-backed map ignored 'webglcontextlost'/'restored', so the
// render loop's `deviceLost` guard was structurally unreachable on the fallback
// fleet → silent blank + zombie loop. The fix: WebGl2Device owns the canvas
// listeners (preventDefault + fan-out), initGPUForcedWebGL2 translates a loss into
// the SAME ctx.deviceLost + onDeviceLost(Internal) chain the WebGPU path fires, and
// an ensure-restored preamble un-sticks a canvas whose prior rhi.destroy() left the
// context lost (else a remount boots a zombie context).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initGPUForcedWebGL2, WebGPUUnavailableError } from './gpu'
import { WebGl2Device } from '@xgis/rhi-webgl2'

interface FakeCanvas extends HTMLCanvasElement {
  _dispatch: (type: string, event?: Partial<Event>) => void
  _listeners: Map<string, Set<EventListener>>
}

function makeFakeCanvas(): FakeCanvas {
  const listeners = new Map<string, Set<EventListener>>()
  const canvas = {
    width: 8,
    height: 8,
    clientWidth: 8,
    clientHeight: 8,
    addEventListener(type: string, cb: EventListener): void {
      let s = listeners.get(type)
      if (!s) {
        s = new Set()
        listeners.set(type, s)
      }
      s.add(cb)
    },
    removeEventListener(type: string, cb: EventListener): void {
      listeners.get(type)?.delete(cb)
    },
    getContext(): unknown {
      return null
    },
    _listeners: listeners,
    _dispatch(type: string, event?: Partial<Event>): void {
      const evt = { type, preventDefault() {}, ...event } as unknown as Event
      for (const cb of [...(listeners.get(type) ?? [])]) cb(evt)
    },
  }
  return canvas as unknown as FakeCanvas
}

function makeFakeGl(
  canvas: FakeCanvas,
  opts: { isContextLost?: boolean; loseContext?: () => void; restoreContext?: () => void } = {},
): WebGL2RenderingContext {
  return {
    canvas,
    getSupportedExtensions: () => [],
    isContextLost: () => opts.isContextLost ?? false,
    getExtension: (name: string) =>
      name === 'WEBGL_lose_context'
        ? {
            loseContext: opts.loseContext ?? (() => {}),
            restoreContext: opts.restoreContext ?? (() => {}),
          }
        : null,
    SAMPLER_2D: 0x8b5e,
    SAMPLER_CUBE: 0x8b60,
    SAMPLER_3D: 0x8b5f,
    SAMPLER_2D_ARRAY: 0x8dc1,
  } as unknown as WebGL2RenderingContext
}

beforeEach(() => {
  // The device-lost chain console.error's the loss — silence it for clean output.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('WebGL2 context loss → ctx device-lost chain (#1153 P2 R3)', () => {
  it('a webglcontextlost event calls preventDefault, sets ctx.deviceLost, and fires the internal hook once', async () => {
    const canvas = makeFakeCanvas()
    const gl = makeFakeGl(canvas)
    canvas.getContext = (() => gl) as never
    const ctx = await initGPUForcedWebGL2(canvas, (g) => new WebGl2Device(g))

    let internalFired = 0
    ctx.onDeviceLostInternal = () => {
      internalFired++
    }
    expect(ctx.deviceLost).toBe(false)

    const preventDefault = vi.fn()
    canvas._dispatch('webglcontextlost', { preventDefault } as Partial<Event>)

    // preventDefault is the restorability contract; the loss flows into the same
    // chain the WebGPU device.lost path fires. Fail-before: base has NO listener,
    // so preventDefault is never called and ctx.deviceLost stays false forever.
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(ctx.deviceLost).toBe(true)
    expect(internalFired).toBe(1) // once per loss
  })

  it('intentional rhi.destroy() drops recovery fan-out but keeps the queued lost event restorable (preventDefault)', async () => {
    const canvas = makeFakeCanvas()
    const order: string[] = []
    const gl = makeFakeGl(canvas, { loseContext: () => order.push('loseContext') })
    canvas.getContext = (() => gl) as never
    // Record removeEventListener order relative to loseContext.
    const origRemove = canvas.removeEventListener.bind(canvas)
    canvas.removeEventListener = ((type: string, cb: EventListener) => {
      order.push(`removeEventListener:${type}`)
      origRemove(type, cb)
    }) as never

    const ctx = await initGPUForcedWebGL2(canvas, (g) => new WebGl2Device(g))
    let internalFired = 0
    ctx.onDeviceLostInternal = () => {
      internalFired++
    }

    ctx.rhi.destroy()
    // loseContext() dispatches 'webglcontextlost' as a deferred task — simulate that
    // firing AFTER destroy(). The FAN-OUT listeners are gone (no recovery), but the
    // one-shot preventDefault listener destroy() left MUST still cancel the event, or
    // the browser latches restore_allowed_=false and a remount can never restore this
    // context (the ensure-restored preamble would stall then fail).
    const preventDefault = vi.fn()
    canvas._dispatch('webglcontextlost', { preventDefault } as Partial<Event>)

    // Fail-before (removal-first with NO restorability listener): preventDefault is
    // never called on the deferred loss, so the remount-into-zombie fix is undelivered.
    expect(preventDefault).toHaveBeenCalledTimes(1) // restorability preserved through teardown
    expect(internalFired).toBe(0) // intentional teardown must NOT fire recovery
    expect(ctx.deviceLost).toBe(false)
    // Fan-out listeners removed BEFORE loseContext (the 'destroyed'-reason analog); the
    // added one-shot preventDefault listener is neither a removeEventListener nor
    // loseContext, so it does not appear in `order`.
    expect(order).toEqual([
      'removeEventListener:webglcontextlost',
      'removeEventListener:webglcontextrestored',
      'loseContext',
    ])
  })

  it('ensure-restored preamble: a canvas-sticky lost context is restored, then boots', async () => {
    const canvas = makeFakeCanvas()
    // restoreContext() synchronously dispatches the restore event the preamble awaits.
    const restoreContext = vi.fn(() => canvas._dispatch('webglcontextrestored'))
    const gl = makeFakeGl(canvas, { isContextLost: true, restoreContext })
    canvas.getContext = (() => gl) as never

    const ctx = await initGPUForcedWebGL2(canvas, (g) => new WebGl2Device(g))

    expect(restoreContext).toHaveBeenCalledTimes(1)
    expect(ctx.rhi.backend).toBe('webgl2') // booted on a LIVE context
  })

  it('ensure-restored preamble: no restore within the timeout rejects with WebGPUUnavailableError', async () => {
    vi.useFakeTimers()
    try {
      const canvas = makeFakeCanvas()
      const gl = makeFakeGl(canvas, {
        isContextLost: true,
        restoreContext: vi.fn() /* never dispatches */,
      })
      canvas.getContext = (() => gl) as never

      const bootP = initGPUForcedWebGL2(canvas, (g) => new WebGl2Device(g))
      // Attach the rejection handler BEFORE advancing timers so the reject fired
      // inside the timer callback never surfaces as an unhandled rejection.
      const assertion = expect(bootP).rejects.toBeInstanceOf(WebGPUUnavailableError)
      // Fail-before: base has no preamble, so a lost context silently boots a
      // zombie. Now it waits, then degrades to the graceful-path error type.
      await vi.advanceTimersByTimeAsync(3000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('same-task destroy→remount: preamble preventDefaults the pending loss and re-invokes restore (restore_allowed_ contract)', async () => {
    // Models the Chromium contract the plain restore fake elides: restoreContext()
    // restores ONLY if the webglcontextlost event was preventDefault'd. In a same-task
    // `oldMap.destroy(); await initGPU(canvas)` the preamble's immediate restoreContext()
    // runs BEFORE loseContext()'s lost event dispatches (restore_allowed_ still false →
    // it no-ops), so the preamble must catch that pending loss, preventDefault it, and
    // re-invoke restore once it lands.
    const canvas = makeFakeCanvas()
    let lost = true // canvas-sticky lost left by the prior destroy()
    let restoreAllowed = false
    const restoreContext = vi.fn(() => {
      if (lost && restoreAllowed) {
        lost = false
        canvas._dispatch('webglcontextrestored')
      }
    })
    const gl = makeFakeGl(canvas, { restoreContext })
    ;(gl as unknown as { isContextLost: () => boolean }).isContextLost = () => lost
    canvas.getContext = (() => gl) as never

    const bootP = initGPUForcedWebGL2(canvas, (g) => new WebGl2Device(g))
    // The preamble has attached its listeners and fired the immediate (no-op) restore.
    await Promise.resolve()
    expect(restoreContext).toHaveBeenCalled()
    expect(lost).toBe(true) // NOT restored yet — restore_allowed_ was false

    // The deferred webglcontextlost now dispatches. The preamble's listener must
    // preventDefault it (→ restore_allowed_) so its microtask re-invoke can restore.
    let prevented = false
    canvas._dispatch('webglcontextlost', {
      preventDefault() {
        prevented = true
      },
    } as Partial<Event>)
    restoreAllowed = prevented
    // Fail-before: the preamble has no webglcontextlost listener, so `prevented` stays
    // false, the re-invoke never fires, and the boot stalls to the 3s timeout.
    expect(prevented).toBe(true)

    const ctx = await bootP
    expect(ctx.rhi.backend).toBe('webgl2') // re-invoked restore succeeded → live boot
    expect(lost).toBe(false)
  })

  it('regression fence: a fake gl WITHOUT canvas / isContextLost still boots (existing forcegl2 fakes)', async () => {
    // Mirrors the rhi-device-destroy / forcegl2-context fakes: no canvas, no
    // isContextLost — every R3 code path must be optional-guarded off the fast path.
    const bareCanvas = {
      width: 8,
      height: 8,
      clientWidth: 8,
      clientHeight: 8,
      getContext: (type: string): unknown =>
        type === 'webgl2'
          ? ({
              getSupportedExtensions: () => [],
              getExtension: () => ({ loseContext: () => {} }),
            } as unknown as WebGL2RenderingContext)
          : null,
    } as unknown as HTMLCanvasElement
    const ctx = await initGPUForcedWebGL2(bareCanvas, (g) => new WebGl2Device(g))
    expect(ctx.rhi.backend).toBe('webgl2')
    expect(ctx.deviceLost).toBe(false)
  })
})
