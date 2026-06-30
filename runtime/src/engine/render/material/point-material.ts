// ═══ Point adapter over the generic Material ═══
//
// Builds the generic Material from the point descriptor (1 group with 3 storage
// buffers, vertex+index geometry, 2 depth variants with polygon-offset bias) and
// wraps the point renderer's native buffers into one generic DrawItem. The
// pipeline/layout build + draw loop are the shared generic core (material.ts).

import type { RhiBuffer, RhiDevice, RhiRenderPass } from '../rhi/rhi'
import { Material, executeItems } from './material'
import { emitPointWgsl } from '../../shaders/dsl'

type VertexBuffers = ReadonlyArray<{ stride: number; attributes: ReadonlyArray<{ location: number; offset: number; format: string }> }>

/** The buffers + draw params for one tile-point batch. All handles are RHI
 *  buffers (§4 batch-seam migration): the renderer builds its own uniform/feat/
 *  vertex/index via the RHI seam, and the shared ShapeRegistry shape/seg buffers
 *  (still raw GPUBuffer until step 3c) are wrapped at the renderer call site so
 *  they arrive here as RhiBuffer too. Passed straight through — NO re-wrapping (a
 *  wrap of an already-RHI handle would double-wrap → unwrap yields a Native
 *  wrapper, not a GPUBuffer → empty draw). */
export interface PointBatch {
  uniform: RhiBuffer
  feat: RhiBuffer
  shape: RhiBuffer
  seg: RhiBuffer
  vertex: RhiBuffer
  index: RhiBuffer
  indexCount: number
  /** Pipeline variant: 0 = opaque (depth write + bias), 1 = translucent (no write + bias),
   *  2 = flat (no write, NO bias — flat ground-plane circles). */
  variant: number
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
        // flat: depth-read, NO write, NO bias — flat ground-plane circles (painter's order).
        { depthWrite: false, depthCompare: 'less-equal', label: 'sdf-point-pipeline-flat-rhi' },
      ],
    })
  }

  draw(pass: RhiRenderPass, b: PointBatch): void {
    const bg = this.material.rhi.createBindGroup(this.material.layout(0), [
      { binding: 0, resource: { buffer: b.uniform } },
      { binding: 1, resource: { buffer: b.feat } },
      { binding: 2, resource: { buffer: b.shape } },
      { binding: 3, resource: { buffer: b.seg } },
    ])
    executeItems(this.material, pass, [{
      variant: b.variant,
      bindGroups: [bg],
      vertex: b.vertex,
      index: { buffer: b.index, format: 'uint32' },
      count: b.indexCount,
      indexed: true,
    }])
  }
}
