// Stub-based unit test for MapRenderer construction. Exercises the
// shader-module / bind-group-layout / pipeline-creation path that
// historically blew up at runtime (BGL contract mismatch, missing
// binding, incompatible uniform-buffer struct size) — without needing
// a real GPU.
//
// Aligns with the stated testing direction: ms-fast unit tests over
// shader-compile + draw-call surface, no actual pixel verification.
// CI no longer needs to load SwiftShader-WebGPU just to catch
// "MapRenderer threw at construction" class of regression.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'
import { initGPU } from '../gpu/gpu'
import { MapRenderer } from './renderer'

let stub: StubInstallation

beforeEach(() => {
  // HTMLCanvasElement is provided by happy-dom / jsdom in vitest's
  // browser-environment runs; bare-Node vitest may need this guard.
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

describe('MapRenderer construction (stub)', () => {
  it('constructs without throwing', async () => {
    const ctx = await makeCtx()
    expect(() => new MapRenderer(ctx)).not.toThrow()
  })

  it('emits the shader modules + pipelines its draw path will reach for', async () => {
    const ctx = await makeCtx()
    const before = { ...stub.callCounts }
    new MapRenderer(ctx)
    // Shader modules: vertex + fragment WGSL pairs across the polygon /
    // extruded / OIT / ground variants. Minimum bar — actual count
    // matters less than "did we compile anything at all".
    expect(stub.callCounts.createShaderModule ?? 0,
      'MapRenderer should compile at least one shader module')
      .toBeGreaterThan((before.createShaderModule ?? 0))
    // Render pipelines (sync + async). MapRenderer creates several at
    // construction time (fill, fillGround, fillExtruded, OIT, …); the
    // exact count is implementation detail but should be non-zero.
    const syncP = stub.callCounts.createRenderPipeline ?? 0
    const asyncP = stub.callCounts.createRenderPipelineAsync ?? 0
    expect(syncP + asyncP, 'MapRenderer should create render pipelines')
      .toBeGreaterThan(0)
  })

  it('declares at least one bind group layout', async () => {
    const ctx = await makeCtx()
    const before = stub.callCounts.createBindGroupLayout ?? 0
    new MapRenderer(ctx)
    expect((stub.callCounts.createBindGroupLayout ?? 0) - before,
      'MapRenderer should declare bind group layout(s)')
      .toBeGreaterThan(0)
  })
})
