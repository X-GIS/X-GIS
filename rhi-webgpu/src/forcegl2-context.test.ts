import { describe, it, expect } from 'vitest'
import { initGPUForcedWebGL2, resizeCanvas } from './gpu'
import { WebGl2Device } from '@xgis/rhi-webgl2'

// US-001 (WebGL2 live-render milestone, Story 1): the forced-WebGL2 boot
// (`?forcegl2=1`) builds a WebGL2-backed GPUContext. These are the GPU-free
// context-shape + backend-marker ACs (the real-GPU render is the Story-4 e2e
// gate). WebGl2Device's constructor only stores the gl handle, so a non-null
// stub gl is enough to exercise the bootstrap shape.

function fakeCanvas(gl: unknown): HTMLCanvasElement {
  return {
    width: 8,
    height: 8,
    clientWidth: 8,
    clientHeight: 8,
    getContext(type: string): unknown {
      return type === 'webgl2' ? gl : null
    },
  } as unknown as HTMLCanvasElement
}

describe('initGPUForcedWebGL2 — forced-WebGL2 boot context (US-001)', () => {
  it('populates host.ctx.rhi with a WebGl2Device whose backend is "webgl2"', () => {
    const ctx = initGPUForcedWebGL2(
      fakeCanvas({} as WebGL2RenderingContext),
      (gl) => new WebGl2Device(gl),
    )
    expect(ctx.rhi).toBeInstanceOf(WebGl2Device)
    expect(ctx.rhi?.backend).toBe('webgl2')
  })

  it('runs the slice-1 isolated single-sample topology (sampleCount === 1)', () => {
    const ctx = initGPUForcedWebGL2(
      fakeCanvas({} as WebGL2RenderingContext),
      (gl) => new WebGl2Device(gl),
    )
    expect(ctx.sampleCount).toBe(1)
  })

  it('stubs the WebGPU device/context FAIL-LOUD (#834 S6 — any property access throws)', () => {
    const ctx = initGPUForcedWebGL2(
      fakeCanvas({} as WebGL2RenderingContext),
      (gl) => new WebGl2Device(gl),
    )
    // #834 device retirement S6: the recursive no-op proxy is gone. Every
    // map-init / scene-compile path is fenced off ctx.device on this backend,
    // so the stub may be STORED (reference passing stays safe) but any
    // property ACCESS is a missing fence and must throw actionably.
    expect(() => ctx.device.createShaderModule({ code: '' })).toThrow(/forcegl2|webgl2/)
    expect(() => ctx.device.queue).toThrow(/route through ctx\.rhi/)
    expect(() => ctx.context.configure({ device: ctx.device, format: ctx.format })).toThrow(
      /webgl2/,
    )
    // `then` stays undefined (benign thenable probe: `await ctx.device` must
    // not hang or throw) and symbol keys stay safe so console/inspect can
    // print the ctx during diagnostics.
    expect((ctx.device as unknown as { then?: unknown }).then).toBeUndefined()
    expect(() => JSON.stringify({ probe: (ctx.device as never)[Symbol.toStringTag] })).not.toThrow()
    expect(ctx.deviceLost).toBe(false)
    expect(ctx._validationErrors).toEqual([])
  })

  it('throws WebGPUUnavailableError when the canvas cannot make a webgl2 context', () => {
    const canvas = {
      getContext(): unknown {
        return null
      },
    } as unknown as HTMLCanvasElement
    expect(() => initGPUForcedWebGL2(canvas, (gl) => new WebGl2Device(gl))).toThrow(/forcegl2/)
  })

  it('resizeCanvas skips context.configure on the forced-WebGL2 path (no throw)', () => {
    // device/context are stubbed-undefined; the resize guard must return before the
    // WebGPU `context.configure(...)` call, or this would throw a TypeError (R5).
    const ctx = initGPUForcedWebGL2(
      fakeCanvas({} as WebGL2RenderingContext),
      (gl) => new WebGl2Device(gl),
    )
    ctx.canvas.width = 1 // force a size mismatch so the resize body runs
    expect(() => resizeCanvas(ctx)).not.toThrow()
  })
})
