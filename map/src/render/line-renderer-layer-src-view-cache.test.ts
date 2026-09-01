// ═══ #1582 site 4 sibling — LineRenderer.writeLayerSlot minted a fresh view per call ═══
//
// `writeLayerSlot` wrapped `packLineLayerUniform`'s result in a new
// `Uint8Array` every call, even though that function always returns the
// SAME shared scratch buffer (its own docstring: "Returns a SHARED scratch
// buffer"). Cached on that buffer's identity, mirroring UniformRing's fix
// (uniform-ring-view-cache.test.ts) for the same defect class.

import { describe, expect, it } from 'vitest'
;(
  globalThis as unknown as { GPUShaderStage: { VERTEX: number; FRAGMENT: number } }
).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 }
;(globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = {
  UNIFORM: 1,
  COPY_DST: 2,
  STORAGE: 4,
  VERTEX: 8,
  INDEX: 16,
}
import { LineRenderer } from './line-renderer'
import { lineLayerUniformStride } from './line-uniform-slots'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import type { GPUContext } from '@xgis/rhi-webgpu'

function makeLineRenderer(writes: { offset: number; byteLen: number }[] = []): {
  lr: LineRenderer
  writes: typeof writes
} {
  const fakeBuffer = {} as GPUBuffer
  const fakeDevice = {
    createBuffer: () => fakeBuffer,
    createBindGroup: () => ({}) as GPUBindGroup,
    createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
    createPipelineLayout: () => ({}) as GPUPipelineLayout,
    createRenderPipeline: () => ({}) as GPURenderPipeline,
    createShaderModule: () => ({}) as GPUShaderModule,
    createSampler: () => ({}) as GPUSampler,
    createTexture: () => ({ createView: () => ({}) }) as unknown as GPUTexture,
    queue: {
      writeBuffer: (
        _buf: GPUBuffer,
        offset: number,
        data: ArrayBufferView | ArrayBuffer,
        _dataOffset?: number,
        size?: number,
      ) => {
        const byteLen =
          size ?? ('byteLength' in (data as object) ? (data as ArrayBuffer).byteLength : 0)
        writes.push({ offset, byteLen })
      },
    },
  }
  const lr = new LineRenderer(
    {
      device: fakeDevice as unknown as GPUDevice,
      format: 'bgra8unorm',
      canvas: {} as HTMLCanvasElement,
      context: {} as GPUCanvasContext,
      rhi: new WebGpuDevice(fakeDevice as unknown as GPUDevice),
    } as unknown as GPUContext,
    {} as GPUBindGroupLayout,
  )
  return { lr, writes }
}

interface RendererPrivates {
  _layerSrcViewBuffer?: ArrayBuffer
  _layerSrcView?: Uint8Array
}
const privatesOf = (r: LineRenderer): RendererPrivates => r as unknown as RendererPrivates

describe('#1582 site 4 sibling — LineRenderer caches the layer-slot source view', () => {
  it('repeated writeLayerSlot calls reuse the SAME cached view instance', () => {
    const { lr } = makeLineRenderer()
    const priv = privatesOf(lr)

    lr.writeLayerSlot([1, 0, 0, 1], 2, 1, 1)
    const viewAfterFirst = priv._layerSrcView
    const bufferAfterFirst = priv._layerSrcViewBuffer
    expect(viewAfterFirst, 'premise: the view is cached at all').toBeDefined()

    lr.writeLayerSlot([0, 1, 0, 1], 3, 1, 1)
    expect(
      priv._layerSrcViewBuffer,
      "packLineLayerUniform's scratch buffer identity is stable across calls",
    ).toBe(bufferAfterFirst)
    expect(priv._layerSrcView, 'the second call must reuse the SAME cached view object').toBe(
      viewAfterFirst,
    )
  })

  it('distinct layers still stage distinct, correct bytes through the shared cached view', () => {
    const { lr, writes } = makeLineRenderer()

    lr.writeLayerSlot([1, 0, 0, 1], 2, 1, 1)
    lr.writeLayerSlot([0, 1, 0, 1], 3, 1, 1)
    lr.endFrame()

    // One contiguous flush covering both slots — unchanged ring behaviour,
    // proving the view cache didn't disturb the staging/flush contract.
    expect(writes).toHaveLength(1)
    expect(writes[0]!.offset).toBe(0)
    // Stride from the SoT (`lineLayerUniformStride()`), not a literal: it rounds the
    // reflected LineLayer size up to the 256 B dynamic-offset alignment and moved to
    // 512 when #2117 grew the struct. The claim here is "one contiguous flush covering
    // both slots", which is stride-independent.
    expect(writes[0]!.byteLen).toBe(2 * lineLayerUniformStride())
  })
})
