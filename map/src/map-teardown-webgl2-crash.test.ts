// ═══ webgl2 teardown routes through ctx.rhi, never the fail-loud ctx.device (#1153 A) ═══
//
// A map booted on the WebGL2 backend (the iOS 'auto' fallback) has a FAIL-LOUD
// `ctx.device` proxy that throws on EVERY property access. The lifecycle teardown
// keystones used to call `ctx.device.destroy()` — a deterministic synchronous
// throw ("ctx.device.destroy accessed on the webgl2 backend"): map.destroy() blew
// up (React cleanup → whole-tree unmount = site down) and a re-run() rejected.
//
// The fix routes every teardown keystone through `ctx.rhi.destroy()` (never
// touches the proxy). These gates inject the REAL forced-WebGL2 fail-loud context
// (initGPUForcedWebGL2 builds the production proxy) and prove destroy() +
// _teardownForReinit() no longer throw and DO reach the RHI teardown.
//
// Fail-before: revert the keystone to `this.ctx?.device?.destroy()` and both
// map.destroy() / _teardownForReinit() throw the proxy error (not.toThrow() red).

import { describe, it, expect, vi } from 'vitest'
import { XGISMap } from './map'
import { initGPUForcedWebGL2 } from '@xgis/rhi-webgpu'
import { WebGl2Device } from '@xgis/rhi-webgl2'

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

function fakeGl(): WebGL2RenderingContext {
  return {
    getSupportedExtensions: () => [],
    getExtension: (name: string) =>
      name === 'WEBGL_lose_context' ? { loseContext: () => undefined } : null,
    SAMPLER_2D: 0x8b5e,
    SAMPLER_CUBE: 0x8b60,
    SAMPLER_3D: 0x8b5f,
    SAMPLER_2D_ARRAY: 0x8dc1,
  } as unknown as WebGL2RenderingContext
}

/** Build the REAL forced-WebGL2 fail-loud context (production proxy `ctx.device`)
 *  with a spied rhi.destroy so we can assert teardown routes through the RHI. */
async function failLoudWebgl2Ctx(): Promise<{
  ctx: Awaited<ReturnType<typeof initGPUForcedWebGL2>>
  rhiDestroy: ReturnType<typeof vi.fn>
}> {
  const glCanvas = {
    width: 8,
    height: 8,
    clientWidth: 8,
    clientHeight: 8,
    getContext: (type: string): unknown => (type === 'webgl2' ? fakeGl() : null),
  } as unknown as HTMLCanvasElement
  const rhiDestroy = vi.fn()
  const ctx = await initGPUForcedWebGL2(glCanvas, (gl) => {
    const dev = new WebGl2Device(gl)
    const orig = dev.destroy.bind(dev)
    dev.destroy = () => {
      rhiDestroy()
      orig()
    }
    return dev
  })
  return { ctx, rhiDestroy }
}

describe('webgl2 teardown crash boundary (#1153 A)', () => {
  it('map.destroy() on a webgl2-backed map does not throw + routes through ctx.rhi.destroy()', async () => {
    const { ctx, rhiDestroy } = await failLoudWebgl2Ctx()
    const map = new XGISMap(stubCanvas())
    ;(map as unknown as { ctx: unknown }).ctx = ctx
    ;(map as unknown as { _loaded: boolean })._loaded = true
    expect(() => map.destroy()).not.toThrow()
    expect(rhiDestroy).toHaveBeenCalledTimes(1)
  })

  it('_teardownForReinit() (the re-run keystone) does not throw + routes through the RHI', async () => {
    const { ctx, rhiDestroy } = await failLoudWebgl2Ctx()
    const map = new XGISMap(stubCanvas())
    ;(map as unknown as { ctx: unknown }).ctx = ctx
    ;(map as unknown as { _loaded: boolean })._loaded = true
    expect(() =>
      (map as unknown as { _teardownForReinit: () => void })._teardownForReinit(),
    ).not.toThrow()
    expect(rhiDestroy).toHaveBeenCalledTimes(1)
    // LEG C: a re-init must also clear loaded() so a failed swap can't report a
    // live map on a blank corpse.
    expect(map.loaded()).toBe(false)
    map.destroy()
  })
})
