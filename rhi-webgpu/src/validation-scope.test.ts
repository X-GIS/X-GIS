// ═══ RhiDevice validation scopes — the adapter mappings (#1046 F4 Inc-A) ═══
//
// The loop side (map/src/render/validation-scope-seam.test.ts) pins that the
// render loop speaks only `pushValidationScope`/`popValidationScope`; this file
// pins what each backend DOES with the call:
//   • WebGPU maps to the native error-scope stack, resolves the error MESSAGE
//     (null = clean), and passes a rejected pop through UNTOUCHED — the
//     Audit-⑧-B2 rejected-pop arm in `reportErrorScope` depends on the
//     rejection surviving the adapter.
//   • WebGL2 no-ops: an immediate-mode context surfaces errors through the
//     frame encoder's `finish()` drain, so push is inert and pop resolves null.

import { describe, it, expect } from 'vitest'
import { WebGpuDevice } from './rhi-webgpu'
import { WebGl2Device } from '@xgis/rhi-webgl2'

function fakeGpuDevice(popResult: () => Promise<GPUError | null>) {
  const pushed: string[] = []
  const device = {
    features: { has: () => false },
    pushErrorScope: (filter: string) => void pushed.push(filter),
    popErrorScope: popResult,
  } as unknown as GPUDevice
  return { device, pushed }
}

function fakeGl(): WebGL2RenderingContext {
  return {
    SAMPLER_2D: 0x8b5e,
    SAMPLER_CUBE: 0x8b60,
    SAMPLER_3D: 0x8b5f,
    SAMPLER_2D_ARRAY: 0x8dc1,
    getSupportedExtensions: () => [],
    getExtension: () => null,
  } as unknown as WebGL2RenderingContext
}

describe('validation scopes — WebGpuDevice maps to the native stack', () => {
  it("push forwards a 'validation' scope; pop resolves the error MESSAGE", async () => {
    const { device, pushed } = fakeGpuDevice(() =>
      Promise.resolve({ message: 'bind group mismatch' } as GPUError),
    )
    const rhi = new WebGpuDevice(device)
    rhi.pushValidationScope()
    expect(pushed).toEqual(['validation'])
    await expect(rhi.popValidationScope()).resolves.toBe('bind group mismatch')
  })

  it('a clean scope resolves null', async () => {
    const { device } = fakeGpuDevice(() => Promise.resolve(null))
    await expect(new WebGpuDevice(device).popValidationScope()).resolves.toBeNull()
  })

  it('a REJECTED pop passes through untouched (Audit ⑧ B2)', async () => {
    const boom = new Error('scope stack unbalanced')
    const { device } = fakeGpuDevice(() => Promise.reject(boom))
    await expect(new WebGpuDevice(device).popValidationScope()).rejects.toBe(boom)
  })
})

describe('validation scopes — WebGl2Device is inert by design', () => {
  it('push no-ops and pop resolves null (finish() drains errors instead)', async () => {
    const rhi = new WebGl2Device(fakeGl())
    expect(() => rhi.pushValidationScope()).not.toThrow()
    await expect(rhi.popValidationScope()).resolves.toBeNull()
  })
})
