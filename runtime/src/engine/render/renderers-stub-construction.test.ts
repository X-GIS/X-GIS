// Stub-based smoke for the remaining renderers: VTR / LineRenderer /
// RasterRenderer / PointRenderer. Mirrors the MapRenderer test in
// `renderer-stub-construction.test.ts` — catches "throws at
// construction under a real adapter" regressions in ms, without
// needing SwiftShader-WebGPU.
//
// Phase 2 PR 2c.3 retired BackgroundRenderer; the synthetic earth-
// surface ShowCommand now dispatches background fill through the
// standard polygon ECEF pipeline (no dedicated renderer to smoke).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU } from '@xgis/rhi-webgpu'
import { MapRendererContent } from '@xgis/map'
import { VectorTileRenderer } from '@xgis/map'
import { LineRenderer } from '@xgis/map'
import { RasterRenderer } from '@xgis/map'
import { PointRenderer } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'

let stub: StubInstallation

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800
      height = 600
      getContext(_t: string): unknown {
        return null
      }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => {
  stub.uninstall()
})

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
    const mr = new MapRendererContent(ctx)
    expect(() => new LineRenderer(ctx, mr.bindGroupLayout)).not.toThrow()
    // LineRenderer compiles its own SDF + dash variants — at least one
    // shader module + one pipeline should be emitted by the
    // constructor.
    expect(
      stub.callCounts.createShaderModule ?? 0,
      'LineRenderer ctor should compile shader modules',
    ).toBeGreaterThan(0)
  })

  it('RasterRenderer constructs without throwing', async () => {
    const ctx = await makeCtx()
    expect(() => new RasterRenderer(ctx)).not.toThrow()
  })

  it('PointRenderer constructs without throwing', async () => {
    const ctx = await makeCtx()
    expect(
      () =>
        new PointRenderer({
          device: ctx.device,
          format: ctx.format,
          rhi: new WebGpuDevice(ctx.device),
        }),
    ).not.toThrow()
  })

  it('all renderers construct in the same order map.ts uses', async () => {
    // map.ts wires them in this order: MapRenderer first (its BGL is
    // a dep for VTR + LineRenderer), then VTR, PointRenderer,
    // LineRenderer, RasterRenderer. Catches "extracting renderer X
    // broke renderer Y's construction" regression class. Phase 2 PR
    // 2c.3 retired BackgroundRenderer — the synthetic earth-surface
    // ShowCommand dispatches through the standard VT path.
    const ctx = await makeCtx()
    const mr = new MapRendererContent(ctx)
    const vtr = new VectorTileRenderer(ctx)
    vtr.setBindGroupLayout(mr.bindGroupLayout)
    const pr = new PointRenderer({
      device: ctx.device,
      format: ctx.format,
      rhi: new WebGpuDevice(ctx.device),
    })
    const lr = new LineRenderer(ctx, mr.bindGroupLayout)
    const rr = new RasterRenderer(ctx)
    expect([mr, vtr, pr, lr, rr].every(Boolean)).toBe(true)
  })
})
