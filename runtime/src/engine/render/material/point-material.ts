// ═══ Point adapter over the generic Material ═══
//
// Builds the generic Material from the point descriptor (1 group with 3 storage
// buffers, vertex+index geometry, 2 depth variants with polygon-offset bias) and
// wraps the point renderer's native buffers into one generic DrawItem. The
// pipeline/layout build + draw loop are the shared generic core (material.ts).

import type { RhiDevice, RhiRenderPass } from '../rhi/rhi'
import { wrapWebGpuBuffer } from '../rhi/rhi-webgpu'
import { Material, executeItems } from './material'
import { emitPointWgsl } from '../../shaders/dsl'

type VertexBuffers = ReadonlyArray<{ stride: number; attributes: ReadonlyArray<{ location: number; offset: number; format: string }> }>

/** The native buffers + draw params for one tile-point batch. */
export interface PointBatch {
  uniform: GPUBuffer
  feat: GPUBuffer
  shape: GPUBuffer
  seg: GPUBuffer
  vertex: GPUBuffer
  index: GPUBuffer
  indexCount: number
  translucent: boolean
}

export class PointDraper {
  private readonly material: Material

  constructor(rhi: RhiDevice, format: string, sampleCount: number, vertexBuffers: VertexBuffers) {
    const bias = { constant: -10, slopeScale: -1, clamp: 0 }
    this.material = new Material(rhi, {
      shader: emitPointWgsl(), vsEntry: 'vs_point', fsEntry: 'fs_point',
      format: format as 'bgra8unorm', sampleCount,
      groups: [[
        { binding: 0, kind: 'uniform' }, { binding: 1, kind: 'storage' },
        { binding: 2, kind: 'storage' }, { binding: 3, kind: 'storage' },
      ]],
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'alpha' }],
      vertexBuffers,
      variants: [
        { depthWrite: true, depthCompare: 'less-equal', depthBias: bias, label: 'sdf-point-pipeline-rhi' },
        { depthWrite: false, depthCompare: 'less-equal', depthBias: bias, label: 'sdf-point-pipeline-translucent-rhi' },
      ],
    })
  }

  draw(pass: RhiRenderPass, b: PointBatch): void {
    const bg = this.material.rhi.createBindGroup(this.material.layout(0), [
      { binding: 0, resource: { buffer: wrapWebGpuBuffer(b.uniform) } },
      { binding: 1, resource: { buffer: wrapWebGpuBuffer(b.feat) } },
      { binding: 2, resource: { buffer: wrapWebGpuBuffer(b.shape) } },
      { binding: 3, resource: { buffer: wrapWebGpuBuffer(b.seg) } },
    ])
    executeItems(this.material, pass, [{
      variant: b.translucent ? 1 : 0,
      bindGroups: [bg],
      vertex: wrapWebGpuBuffer(b.vertex),
      index: { buffer: wrapWebGpuBuffer(b.index), format: 'uint32' },
      count: b.indexCount,
      indexed: true,
    }])
  }
}
