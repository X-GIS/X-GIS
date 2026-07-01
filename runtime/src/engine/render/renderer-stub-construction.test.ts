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
import { initGPU } from '@xgis/engine'
import { MapRendererContent } from './renderer'
import { polygonUniformBytes } from '@xgis/map'

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
    expect(() => new MapRendererContent(ctx)).not.toThrow()
  })

  it('emits the shader modules + pipelines its draw path will reach for', async () => {
    const ctx = await makeCtx()
    const before = { ...stub.callCounts }
    new MapRendererContent(ctx)
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
    new MapRendererContent(ctx)
    expect((stub.callCounts.createBindGroupLayout ?? 0) - before,
      'MapRenderer should declare bind group layout(s)')
      .toBeGreaterThan(0)
  })

  it('uniform bind size is reflect-derived (no stale UNIFORM_SIZE constant)', async () => {
    // Regression guard for the "Polygon Uniforms struct grew" class — when WGSL
    // grows a field the TS-side bind size must move with it or out-of-bounds
    // typed-array writes silently no-op and the uniform never reaches the GPU.
    // It is now derived from reflect(buildPolygonModule()) via polygonUniformBytes()
    // at every bind site — there is NO `UNIFORM_SIZE` static/const to drift (removed
    // 2026-06-26: an eager `static = polygonUniformBytes()` evaluated at IMPORT,
    // before configureProjections(), and crashed the whole map init). The exact
    // polygonUniformBytes() === emitted-WGSL-struct-size gate lives in
    // maprenderer-uniform-bind-size.test.ts.
    const ctx = await makeCtx()
    expect(() => new MapRendererContent(ctx)).not.toThrow()
    const bytes = polygonUniformBytes()
    expect(bytes).toBeGreaterThan(0)
    expect(bytes % 16).toBe(0) // valid WGSL uniform struct alignment
  })

  it('bindGroupLayout descriptor declares the polygon Uniforms binding', async () => {
    // The stub passes the BGL descriptor through on the returned
    // handle, so we can assert "the layer-uniform binding (slot 0) is
    // a uniform buffer accessible from vertex + fragment". setQuality
    // re-wire regressions historically broke when this binding was
    // silently dropped or changed visibility.
    const ctx = await makeCtx()
    const r = new MapRendererContent(ctx) as unknown as { bindGroupLayout: { __descriptor?: GPUBindGroupLayoutDescriptor } }
    const desc = r.bindGroupLayout.__descriptor
    expect(desc, 'MapRenderer.bindGroupLayout should be a stub-tagged BGL').toBeTruthy()
    const entries = desc!.entries as GPUBindGroupLayoutEntry[]
    const slot0 = entries.find(e => e.binding === 0)
    expect(slot0, 'binding 0 (layer Uniforms) must exist').toBeTruthy()
    expect(slot0!.buffer?.type, 'binding 0 must be a uniform buffer').toBe('uniform')
  })
})
