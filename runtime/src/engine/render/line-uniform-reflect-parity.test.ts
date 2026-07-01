// Re-hardcode guard: the line uniform sizes the renderer USES AT RUNTIME must
// equal what reflect(buildLineModule()) reports — so nobody can re-introduce a
// hand literal that silently desyncs the CPU packer / ring stride from the GPU
// struct (the std140-drift class the polygon path retired; see
// polygon-uniform-offset-parity.test.ts + line-uniform-slots.ts).
//
// History: these sizes used to be eager literals (`LINE_UNIFORM_SIZE = 208`,
// `LineRenderer.LAYER_SLOT = 256`) and THIS guard asserted `literal ===
// reflected` — a fails-AFTER drift catch. They are now derived from reflect()
// LAZILY (line-pattern.ts's scratch + LineRenderer's ctor, both post-
// configureProjections — the no-eager-uniform-reflect.test.ts gate enforces the
// laziness). So the guard FLIPS: it asserts the actual RUNTIME values — the
// scratch the packer returns, the stride the renderer rings with — equal
// reflect, catching anyone who RE-hardcodes them to a literal.

import { describe, it, expect } from 'vitest'
import { reflect } from '@xgis/shader-dsl'
import { buildLineModule } from '@xgis/map'
import { uniformFieldSlots } from '@xgis/engine'
import { lineLayerUniformBytes, lineLayerUniformStride } from '@xgis/map'
import { polygonUniformBytes } from '@xgis/map'
import { LineRenderer, packLineLayerUniform } from '@xgis/map'
import { WebGpuDevice } from '@xgis/engine'
import type { GPUContext } from '@xgis/engine'

// WebGPU globals don't exist under happy-dom — stub the few the LineRenderer
// ctor touches (createBindGroupLayout's visibility flags + createBuffer's usage
// map). Mirrors line-renderer-layer-ring / line-translate-wiring tests.
;(globalThis as unknown as { GPUShaderStage: { VERTEX: number; FRAGMENT: number } }).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 }
;(globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = {
  UNIFORM: 1, COPY_DST: 2, STORAGE: 4, VERTEX: 8, INDEX: 16,
}

/** Minimal fake GPU context — the LineRenderer ctor only needs createBuffer /
 *  createBindGroupLayout (return opaque stubs) to construct its rings. */
function fakeContext(): GPUContext {
  const fakeDevice = {
    createBuffer: () => ({}) as GPUBuffer,
    createBindGroup: () => ({}) as GPUBindGroup,
    createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
    createTexture: () => ({ createView: () => ({}) }) as unknown as GPUTexture,
    queue: { writeBuffer: () => {} },
  }
  return {
    device: fakeDevice as unknown as GPUDevice,
    format: 'bgra8unorm',
    canvas: {} as HTMLCanvasElement,
    context: {} as GPUCanvasContext,
    rhi: new WebGpuDevice(fakeDevice as unknown as GPUDevice),
  } as unknown as GPUContext
}

describe('line uniform sizes — reflect parity (re-hardcode guard)', () => {
  it('packLineLayerUniform scratch is sized from reflect, not a literal', () => {
    // The packer's scratch buffer (line-pattern.ts) is now `new Float32Array(
    // lineLayerUniformBytes() / 4)`, allocated lazily on first draw. The buffer
    // it returns must therefore be exactly the reflected LineLayer byte size —
    // re-hardcoding the scratch to a stale literal would fail here.
    const buf = packLineLayerUniform([1, 0, 0, 1], 2, 1, 1000)
    expect(buf.byteLength).toBe(lineLayerUniformBytes())
  })

  it('LineRenderer.layerStride ring stride equals the reflected LineLayer stride', () => {
    // The ctor sets `this.layerStride = lineLayerUniformStride()` (no literal).
    // If LineLayer grows past 256 B the stride becomes 512 automatically; a
    // re-hardcoded `= 256` would silently truncate every layer slot — caught here.
    const lr = new LineRenderer(fakeContext(), {} as GPUBindGroupLayout)
    const layerStride = (lr as unknown as { layerStride: number }).layerStride
    expect(layerStride).toBe(lineLayerUniformStride())
  })

  it('line TileUniforms (group 0) byte-mirrors the polygon Uniforms struct', () => {
    // The line VS shares group(0) with VTR's polygon bind group, so line.ts's
    // TileUniforms MUST match polygon Uniforms field offsets / size exactly (see
    // the TileUniforms doc in line.ts). Lock the invariant to both reflect sources.
    const tileBytes = uniformFieldSlots(reflect(buildLineModule(false)), 'TileUniforms').slots * 4
    expect(tileBytes).toBe(polygonUniformBytes())
  })
})
