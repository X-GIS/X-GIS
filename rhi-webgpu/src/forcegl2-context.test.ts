import { describe, it, expect, vi } from 'vitest'
import { initGPUForcedWebGL2, resizeCanvas } from './gpu'
import { backendProviderChain } from './backend-providers'
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

// #1153 M2: capture the attribute object passed to getContext('webgl2') so the
// tests can pin the mobile-cheap default (preserveDrawingBuffer off — present-neutral)
// AND that antialias is left UNSPECIFIED (WebGL default true), since this backend
// rasterizes to FBO 0 and forcing antialias off would alias the presented edges.
function fakeCanvasCapturing(): {
  canvas: HTMLCanvasElement
  attrs: () => WebGLContextAttributes | undefined
} {
  let captured: WebGLContextAttributes | undefined
  const canvas = {
    width: 8,
    height: 8,
    clientWidth: 8,
    clientHeight: 8,
    getContext(type: string, a?: WebGLContextAttributes): unknown {
      if (type !== 'webgl2') return null
      captured = a
      return {} as WebGL2RenderingContext
    },
  } as unknown as HTMLCanvasElement
  return { canvas, attrs: () => captured }
}

describe('initGPUForcedWebGL2 — mobile context-attr defaults (#1153 M2)', () => {
  it('defaults preserveDrawingBuffer:false, leaves antialias unspecified; alpha/premultipliedAlpha/stencil unchanged', async () => {
    const { canvas, attrs } = fakeCanvasCapturing()
    await initGPUForcedWebGL2(canvas, (gl) => new WebGl2Device(gl))
    const a = attrs()!
    // The mobile fix: the permanent 2×-fullres PRESERVED buffer is dropped on the
    // production fallback path (present-neutral; only e2e capture opts back in).
    expect(a.preserveDrawingBuffer).toBe(false)
    // antialias is NOT set — the WebGL default (true) keeps the FBO-0 edge AA, so the
    // fallback path's rendered output is unchanged (brief: "must not change output").
    expect(a.antialias).toBeUndefined()
    // Byte-identical to the pre-fix attrs for these three.
    expect(a.alpha).toBe(true)
    expect(a.premultipliedAlpha).toBe(true)
    expect(a.stencil).toBe(true)
  })

  it('opt-in webgl2Attrs flips ONLY preserveDrawingBuffer (antialias stays unspecified)', async () => {
    const { canvas, attrs } = fakeCanvasCapturing()
    await initGPUForcedWebGL2(canvas, (gl) => new WebGl2Device(gl), 'forced', {
      preserveDrawingBuffer: true,
    })
    const a = attrs()!
    expect(a.preserveDrawingBuffer).toBe(true)
    expect(a.antialias).toBeUndefined()
  })

  it('backendProviderChain threads webgl2Attrs through makeWebGl2BackendProvider to getContext', async () => {
    const { canvas, attrs } = fakeCanvasCapturing()
    const chain = backendProviderChain('webgl2', { sampleCount: 1 }, (gl) => new WebGl2Device(gl), {
      preserveDrawingBuffer: true,
    })
    const webgl2Provider = chain.find((p) => p.id === 'webgl2')!
    await webgl2Provider.create(canvas)
    expect(attrs()!.preserveDrawingBuffer).toBe(true)
  })
})

describe('initGPUForcedWebGL2 — boot-warning attribution (#1153 M4)', () => {
  const g = globalThis as unknown as { window?: unknown }
  const HAD_WINDOW = 'window' in globalThis

  // The warning (and the __xgisActiveBackend marker) are gated on `typeof window
  // !== 'undefined'`, so a real warning only fires with window present.
  async function captureWarn(mode?: 'forced' | 'pinned' | 'fallback'): Promise<string> {
    g.window = {}
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const makeRhi = (gl: WebGL2RenderingContext): WebGl2Device => new WebGl2Device(gl)
    const canvas = fakeCanvas({} as WebGL2RenderingContext)
    if (mode) await initGPUForcedWebGL2(canvas, makeRhi, mode)
    else await initGPUForcedWebGL2(canvas, makeRhi)
    const msg = warn.mock.calls.map((c) => String(c[0])).join('\n')
    warn.mockRestore()
    if (!HAD_WINDOW) delete g.window
    return msg
  }

  it("default (direct call) keeps the 'forced' string byte-identical (guards the e2e console expectations)", async () => {
    const msg = await captureWarn()
    expect(msg).toBe(
      '[X-GIS] forced WebGL2 backend active (?forcegl2=1) — single-sample isolated raster slice',
    )
  })

  it("auto-fallback warning contains NO 'forcegl2' substring and names the fallback", async () => {
    const msg = await captureWarn('fallback')
    expect(msg).not.toContain('forcegl2')
    expect(msg).toContain('auto-fallback')
  })

  it('pinned warning names the code pin, not ?forcegl2', async () => {
    const msg = await captureWarn('pinned')
    expect(msg).toContain('pinned in code')
    expect(msg).not.toContain('forcegl2')
  })
})

describe('initGPUForcedWebGL2 — forced-WebGL2 boot context (US-001)', () => {
  it('populates host.ctx.rhi with a WebGl2Device whose backend is "webgl2"', async () => {
    const ctx = await initGPUForcedWebGL2(
      fakeCanvas({} as WebGL2RenderingContext),
      (gl) => new WebGl2Device(gl),
    )
    expect(ctx.rhi).toBeInstanceOf(WebGl2Device)
    expect(ctx.rhi?.backend).toBe('webgl2')
  })

  it('runs the slice-1 isolated single-sample topology (sampleCount === 1)', async () => {
    const ctx = await initGPUForcedWebGL2(
      fakeCanvas({} as WebGL2RenderingContext),
      (gl) => new WebGl2Device(gl),
    )
    expect(ctx.sampleCount).toBe(1)
  })

  it('stubs the WebGPU device/context FAIL-LOUD (#834 S6 — any property access throws)', async () => {
    const ctx = await initGPUForcedWebGL2(
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

  it('rejects with WebGPUUnavailableError when the canvas cannot make a webgl2 context', async () => {
    const canvas = {
      getContext(): unknown {
        return null
      },
    } as unknown as HTMLCanvasElement
    await expect(initGPUForcedWebGL2(canvas, (gl) => new WebGl2Device(gl))).rejects.toThrow(
      /forcegl2/,
    )
  })

  it('resizeCanvas skips context.configure on the forced-WebGL2 path (no throw)', async () => {
    // device/context are stubbed-undefined; the resize guard must return before the
    // WebGPU `context.configure(...)` call, or this would throw a TypeError (R5).
    const ctx = await initGPUForcedWebGL2(
      fakeCanvas({} as WebGL2RenderingContext),
      (gl) => new WebGl2Device(gl),
    )
    ctx.canvas.width = 1 // force a size mismatch so the resize body runs
    expect(() => resizeCanvas(ctx, 1)).not.toThrow()
  })
})
