// Stub-based smoke for the remaining renderers: VTR / LineRenderer /
// RasterRenderer / PointRenderer / BackgroundRenderer. Mirrors the
// MapRenderer test in `renderer-stub-construction.test.ts` — catches
// "throws at construction under a real adapter" regressions in ms,
// without needing SwiftShader-WebGPU.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU } from '../gpu/gpu'
import { MapRenderer } from './renderer'
import { VectorTileRenderer } from './vector-tile-renderer'
import { LineRenderer } from './line-renderer'
import { RasterRenderer } from './raster-renderer'
import { PointRenderer } from './point-renderer'
import { BackgroundRenderer } from './background-renderer'

let stub: StubInstallation

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800; height = 600
      getContext(_t: string): unknown { return null }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => { stub.uninstall() })

async function makeCtx(): Promise<Awaited<ReturnType<typeof initGPU>>> {
  const canvas = { width: 1024, height: 720 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas)
}

describe('renderer construction smoke (stub)', () => {
  it('VectorTileRenderer constructs without throwing', async () => {
    const ctx = await makeCtx()
    expect(() => new VectorTileRenderer(ctx)).not.toThrow()
  })

  it('LineRenderer constructs against MapRenderer.bindGroupLayout', async () => {
    const ctx = await makeCtx()
    const mr = new MapRenderer(ctx)
    expect(() => new LineRenderer(ctx, mr.bindGroupLayout)).not.toThrow()
    // LineRenderer compiles its own SDF + dash variants — at least one
    // shader module + one pipeline should be emitted by the
    // constructor.
    expect(stub.callCounts.createShaderModule ?? 0,
      'LineRenderer ctor should compile shader modules')
      .toBeGreaterThan(0)
  })

  it('RasterRenderer constructs without throwing', async () => {
    const ctx = await makeCtx()
    expect(() => new RasterRenderer(ctx)).not.toThrow()
  })

  it('PointRenderer constructs without throwing', async () => {
    const ctx = await makeCtx()
    expect(() => new PointRenderer({ device: ctx.device, format: ctx.format })).not.toThrow()
  })

  it('BackgroundRenderer constructs without throwing', async () => {
    const ctx = await makeCtx()
    expect(() => new BackgroundRenderer(ctx)).not.toThrow()
  })

  it('BackgroundRenderer.render fires exactly one draw(6) per pass', async () => {
    // Draw-call surface check: with a colour set, BackgroundRenderer
    // emits a fullscreen-quad pass (6 vertices). The stub tracks
    // pass.draw call counts, so we can verify the renderer actually
    // dispatches without needing pixel output. Catches "render() bailed
    // silently because uniform upload moved" regressions.
    const ctx = await makeCtx()
    const bg = new BackgroundRenderer(ctx)
    bg.setFill([0.1, 0.2, 0.3, 1])
    const enc = ctx.device.createCommandEncoder()
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: ctx.context.getCurrentTexture().createView(),
        loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    })
    const drawsBefore = stub.callCounts['pass.draw'] ?? 0
    bg.render(pass)
    pass.end()
    const drawsAfter = stub.callCounts['pass.draw'] ?? 0
    expect(drawsAfter - drawsBefore,
      'BackgroundRenderer.render should emit exactly one fullscreen-quad draw')
      .toBe(1)
  })

  it('all 5 renderers construct in the same order map.ts uses', async () => {
    // map.ts wires them in this order: MapRenderer first (its BGL is
    // a dep for VTR + LineRenderer), then VTR, then BackgroundRenderer,
    // PointRenderer, LineRenderer, RasterRenderer. Catches "extracting
    // renderer X broke renderer Y's construction" regression class.
    const ctx = await makeCtx()
    const mr = new MapRenderer(ctx)
    const vtr = new VectorTileRenderer(ctx)
    vtr.setBindGroupLayout(mr.bindGroupLayout)
    const bg = new BackgroundRenderer(ctx)
    const pr = new PointRenderer({ device: ctx.device, format: ctx.format })
    const lr = new LineRenderer(ctx, mr.bindGroupLayout)
    const rr = new RasterRenderer(ctx)
    expect([mr, vtr, bg, pr, lr, rr].every(Boolean)).toBe(true)
  })
})
