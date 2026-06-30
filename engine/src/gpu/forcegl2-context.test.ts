import { describe, it, expect } from 'vitest'
import { initGPUForcedWebGL2, resizeCanvas } from './gpu'
import { WebGl2Device } from '../render/rhi/rhi-webgl2'

// US-001 (WebGL2 live-render milestone, Story 1): the forced-WebGL2 boot
// (`?forcegl2=1`) builds a WebGL2-backed GPUContext. These are the GPU-free
// context-shape + backend-marker ACs (the real-GPU render is the Story-4 e2e
// gate). WebGl2Device's constructor only stores the gl handle, so a non-null
// stub gl is enough to exercise the bootstrap shape.

function fakeCanvas(gl: unknown): HTMLCanvasElement {
  return {
    width: 8, height: 8, clientWidth: 8, clientHeight: 8,
    getContext(type: string): unknown { return type === 'webgl2' ? gl : null },
  } as unknown as HTMLCanvasElement
}

describe('initGPUForcedWebGL2 — forced-WebGL2 boot context (US-001)', () => {
  it('populates host.ctx.rhi with a WebGl2Device whose backend is "webgl2"', () => {
    const ctx = initGPUForcedWebGL2(fakeCanvas({} as WebGL2RenderingContext), (gl) => new WebGl2Device(gl))
    expect(ctx.rhi).toBeInstanceOf(WebGl2Device)
    expect(ctx.rhi?.backend).toBe('webgl2')
  })

  it('runs the slice-1 isolated single-sample topology (sampleCount === 1)', () => {
    const ctx = initGPUForcedWebGL2(fakeCanvas({} as WebGL2RenderingContext), (gl) => new WebGl2Device(gl))
    expect(ctx.sampleCount).toBe(1)
  })

  it('stubs the WebGPU device/context as a no-op proxy (renderer constructors must not crash)', () => {
    const ctx = initGPUForcedWebGL2(fakeCanvas({} as WebGL2RenderingContext), (gl) => new WebGl2Device(gl))
    // device/context are a recursive no-op proxy (not undefined) so the WebGPU renderer
    // constructors can build their dummy resources at map-init without crashing; the forced
    // frame routes through ctx.rhi and never uses them. Any access/call no-ops.
    expect(() => ctx.device.createShaderModule({ code: '' })).not.toThrow()
    expect(() => ctx.device.queue.writeBuffer({} as GPUBuffer, 0, new Uint8Array())).not.toThrow()
    expect(() => ctx.context.configure({ device: ctx.device, format: ctx.format })).not.toThrow()
    expect(ctx.deviceLost).toBe(false)
    expect(ctx._validationErrors).toEqual([])
  })

  it('throws WebGPUUnavailableError when the canvas cannot make a webgl2 context', () => {
    const canvas = { getContext(): unknown { return null } } as unknown as HTMLCanvasElement
    expect(() => initGPUForcedWebGL2(canvas, (gl) => new WebGl2Device(gl))).toThrow(/forcegl2/)
  })

  it('resizeCanvas skips context.configure on the forced-WebGL2 path (no throw)', () => {
    // device/context are stubbed-undefined; the resize guard must return before the
    // WebGPU `context.configure(...)` call, or this would throw a TypeError (R5).
    const ctx = initGPUForcedWebGL2(fakeCanvas({} as WebGL2RenderingContext), (gl) => new WebGl2Device(gl))
    ctx.canvas.width = 1 // force a size mismatch so the resize body runs
    expect(() => resizeCanvas(ctx)).not.toThrow()
  })
})
