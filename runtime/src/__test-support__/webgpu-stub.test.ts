// POC for the WebGPU stub. Demonstrates that initGPU + a renderer
// constructor can run under vitest without a real adapter, opening the
// door to logic-only renderer tests (BGL contracts, pipeline-config
// invariants) at ms speed instead of multi-second Playwright cells.
//
// Scope: thin smoke. Adding fuller coverage (e.g. asserting which
// bindings MapRenderer's BGL declares) is the natural follow-up
// once we decide which surfaces are most regression-prone.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from './webgpu-stub'

let stub: StubInstallation

beforeEach(() => {
  // happy-dom doesn't ship Image / Canvas APIs by default; ensure a
  // minimal HTMLCanvasElement exists for getContext stubbing.
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class { width = 800; height = 600; getContext(_t: string): unknown { return null } } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => { stub.uninstall() })

describe('webgpu-stub', () => {
  it('navigator.gpu.requestAdapter returns a stub adapter', async () => {
    const adapter = await navigator.gpu!.requestAdapter()
    expect(adapter).toBeTruthy()
    expect(adapter!.info?.description).toBe('webgpu-stub')
  })

  it('adapter.requestDevice + queue ops are callable', async () => {
    const adapter = (await navigator.gpu!.requestAdapter())!
    const device = await adapter.requestDevice()
    expect(device).toBeTruthy()
    const buf = device.createBuffer({ size: 64, usage: 0 })
    device.queue.writeBuffer(buf, 0, new Uint8Array(64))
    device.queue.submit([device.createCommandEncoder().finish()])
    expect(stub.callCounts['queue.submit']).toBeGreaterThanOrEqual(1)
    expect(stub.callCounts['queue.writeBuffer']).toBeGreaterThanOrEqual(1)
  })

  it('initGPU resolves end-to-end against the stub', async () => {
    const { initGPU } = await import('../engine/gpu/gpu')
    const canvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement
    Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
    const ctx = await initGPU(canvas)
    expect(ctx.device).toBeTruthy()
    expect(ctx.context).toBeTruthy()
    expect(ctx.format).toBe('bgra8unorm')
    // initGPU should have configured the swap-chain.
    expect(stub.callCounts['context.configure']).toBeGreaterThanOrEqual(1)
  })

  it('createBindGroupLayout descriptor is preserved on the returned handle', async () => {
    const adapter = (await navigator.gpu!.requestAdapter())!
    const device = await adapter.requestDevice()
    const desc: GPUBindGroupLayoutDescriptor = {
      entries: [
        { binding: 0, visibility: 1, buffer: { type: 'uniform' } },
        { binding: 1, visibility: 3, buffer: { type: 'storage' } },
      ],
    }
    const bgl = device.createBindGroupLayout(desc) as unknown as { __descriptor: GPUBindGroupLayoutDescriptor }
    // The descriptor passthrough lets future tests assert that a
    // renderer declared the bindings it should have.
    expect(bgl.__descriptor).toBe(desc)
    expect(bgl.__descriptor.entries).toHaveLength(2)
  })
})
