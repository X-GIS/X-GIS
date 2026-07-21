// ═══ Backend observability — getBackend() + 'backendresolved' event (#1153 M4) ═══
//
// A silent WebGPU→WebGL2 auto-fallback was previously observable only by poking
// map internals (demo-runner read ctx.rhi.backend). M4 exposes a public
// getBackend() and fires a 'backendresolved' map event once per successful boot.
//
// Fail-before (by construction): neither getBackend() nor the 'backendresolved'
// event type existed at HEAD — getBackend() would be `undefined`/throw and a
// listener for 'backendresolved' would never receive an event.

import { describe, it, expect } from 'vitest'
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

function setCtxBackend(map: XGISMap, backend: 'webgpu' | 'webgl2'): void {
  // `destroy()` on the rhi is needed because map.destroy() → _releaseGpuResources()
  // routes the whole-device teardown through ctx.rhi.destroy() (#1153 A).
  ;(map as unknown as { ctx: unknown }).ctx = { rhi: { backend, destroy() {} } }
}

describe('#1153 M4 — getBackend() lifecycle', () => {
  it('returns null before the first successful boot', () => {
    const map = new XGISMap(stubCanvas())
    expect(map.getBackend()).toBeNull()
    map.destroy()
  })

  it('returns ctx.rhi.backend once a ctx is resolved', () => {
    const map = new XGISMap(stubCanvas())
    setCtxBackend(map, 'webgl2')
    expect(map.getBackend()).toBe('webgl2')
    map.destroy()
  })

  it('returns null after destroy() even with a ctx still set', () => {
    const map = new XGISMap(stubCanvas())
    setCtxBackend(map, 'webgpu')
    map.destroy()
    expect(map.getBackend()).toBeNull()
  })
})

describe("#1153 M4 — 'backendresolved' event", () => {
  it('carries the resolved backend and its payload equals getBackend()', () => {
    const map = new XGISMap(stubCanvas())
    setCtxBackend(map, 'webgl2')
    const events: Array<{ type: string; backend?: string }> = []
    map.on('backendresolved', (e) => events.push(e))
    ;(
      map as unknown as {
        _eventBus: { fireBackendResolvedEvent: (b: 'webgpu' | 'webgl2') => void }
      }
    )._eventBus.fireBackendResolvedEvent('webgl2')
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('backendresolved')
    expect(events[0]!.backend).toBe('webgl2')
    expect(events[0]!.backend).toBe(map.getBackend()) // payload === getBackend()
    map.destroy()
  })

  it('is STATELESS — firing twice re-dispatches (recovery re-boot re-fires, unlike load)', () => {
    const map = new XGISMap(stubCanvas())
    setCtxBackend(map, 'webgpu')
    let count = 0
    map.on('backendresolved', () => count++)
    const bus = (
      map as unknown as {
        _eventBus: { fireBackendResolvedEvent: (b: 'webgpu' | 'webgl2') => void }
      }
    )._eventBus
    bus.fireBackendResolvedEvent('webgpu')
    bus.fireBackendResolvedEvent('webgl2') // a flipped-backend recovery re-boot
    expect(count).toBe(2)
    map.destroy()
  })
})
