// ═══ RhiDevice.destroy() — whole-device teardown authority (#1153 A) ═══
//
// The map's lifecycle teardown used to call the RAW native GPUDevice.destroy()
// (`ctx.device.destroy()`). On the forced-WebGL2 backend `ctx.device` is a
// FAIL-LOUD proxy that throws on EVERY property access (gpu.ts) — so that raw
// call detonated (deterministic site-down). The fix routes teardown through the
// RHI (`ctx.rhi.destroy()`), a backend-neutral whole-device teardown. These gates
// prove each backend's destroy() releases the device AND that the forced-WebGL2
// context tears down through the RHI without ever touching the proxy `ctx.device`.

import { describe, it, expect, vi } from 'vitest'
import { WebGpuDevice, initGPUForcedWebGL2 } from './index'
import { WebGl2Device } from '@xgis/rhi-webgl2'

// A minimal fake WebGL2 context: enough for the WebGl2Device constructor
// (getSupportedExtensions + the SAMPLER_* enums it may collect once) and the
// destroy() path (getExtension('WEBGL_lose_context').loseContext()).
function fakeGl(loseContext: () => void): WebGL2RenderingContext {
  return {
    getSupportedExtensions: () => [],
    getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null),
    SAMPLER_2D: 0x8b5e,
    SAMPLER_CUBE: 0x8b60,
    SAMPLER_3D: 0x8b5f,
    SAMPLER_2D_ARRAY: 0x8dc1,
  } as unknown as WebGL2RenderingContext
}

function fakeCanvas(gl: WebGL2RenderingContext): HTMLCanvasElement {
  return {
    width: 8,
    height: 8,
    clientWidth: 8,
    clientHeight: 8,
    getContext: (type: string): unknown => (type === 'webgl2' ? gl : null),
  } as unknown as HTMLCanvasElement
}

describe('RhiDevice.destroy() — backend teardown authority (#1153 A)', () => {
  it('WebGpuDevice.destroy() calls the native GPUDevice.destroy()', () => {
    const destroy = vi.fn()
    const dev = new WebGpuDevice({
      features: { has: () => false },
      destroy,
    } as unknown as GPUDevice)
    dev.destroy()
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('WebGl2Device.destroy() releases the context via WEBGL_lose_context.loseContext()', () => {
    const loseContext = vi.fn()
    const dev = new WebGl2Device(fakeGl(loseContext))
    dev.destroy()
    expect(loseContext).toHaveBeenCalledTimes(1)
  })

  it('forced-WebGL2 ctx tears down through ctx.rhi.destroy() — never the fail-loud ctx.device', async () => {
    const loseContext = vi.fn()
    const ctx = await initGPUForcedWebGL2(
      fakeCanvas(fakeGl(loseContext)),
      (gl) => new WebGl2Device(gl),
    )
    // The HAZARD the fix removes: any property access on ctx.device throws.
    expect(() => (ctx.device as unknown as { destroy: () => void }).destroy()).toThrow(/webgl2/)
    // The FIX: teardown routes through the RHI — no proxy touch, releases the GL context.
    expect(() => ctx.rhi.destroy()).not.toThrow()
    expect(loseContext).toHaveBeenCalledTimes(1)
  })
})
