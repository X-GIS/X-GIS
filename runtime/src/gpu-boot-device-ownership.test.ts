// ═══ #1153 P1 (#5) — createWebGpuContext reclaims the device on a boot failure ═══
//
// requestDevice() mints a device that is UNOWNED until the GPUContext bundle wraps
// it. Any failure between (getContext null, configure throw, the rhi-webgpu
// chunk-load reject, the WebGpuDevice ctor) used to leak that device for the page
// lifetime. The fix (gpu.ts A9) wraps the span in a try/catch that destroys the
// device and rethrows the original error. Here the stub forces getContext('webgpu')
// to return null AFTER requestDevice, and asserts the orphan is destroyed.
//
// FAIL-BEFORE: without the try/catch, createdDevices[0].destroyed === false.

import { describe, it, expect, afterEach } from 'vitest'
import { createWebGpuContext } from '@xgis/rhi-webgpu'
import { installWebGPUStub, type StubInstallation } from './__test-support__/webgpu-stub'

function ensureCanvasCtor(): void {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 256
      height = 256
      getContext(_t: string): unknown {
        return null
      }
    } as never
  }
}

function stubCanvas(): HTMLCanvasElement {
  const c = { width: 256, height: 256 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(c, HTMLCanvasElement.prototype)
  return c
}

let active: StubInstallation | null = null
afterEach(() => {
  active?.uninstall()
  active = null
})

describe('#1153 P1 (#5) — boot-failure device ownership', () => {
  it('T6 — getContext-null after requestDevice destroys the orphan device and rethrows', async () => {
    ensureCanvasCtor()
    const stub = installWebGPUStub({ freshDevices: true, webgpuContextNull: true })
    active = stub
    await expect(createWebGpuContext(stubCanvas(), { sampleCount: 1 })).rejects.toThrow(
      'Failed to get WebGPU context',
    )
    expect(stub.createdDevices).toHaveLength(1) // requestDevice DID mint a device
    expect(stub.createdDevices[0]!.destroyed).toBe(true) // …and the boot-failure path reclaimed it
  })

  it('the success path is unchanged — a normal boot builds a live, undestroyed device', async () => {
    ensureCanvasCtor()
    const stub = installWebGPUStub({ freshDevices: true })
    active = stub
    const ctx = await createWebGpuContext(stubCanvas(), { sampleCount: 1 })
    expect(ctx.rhi).toBeTruthy()
    expect(stub.createdDevices).toHaveLength(1)
    expect(stub.createdDevices[0]!.destroyed).toBe(false)
  })
})
