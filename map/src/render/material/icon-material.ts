// ═══ Icon adapter over the generic Material ═══
//
// The simplest primitive: 1 bind group (uniform + atlas texture + sampler), a
// vertex buffer, NO depth (pure 2D overlay), one non-instanced draw. Reuses the
// icon renderer's bind-group layout so its pipeline is layout-compatible.

import type { RhiBindGroup, RhiBuffer, RhiDevice, RhiRenderPass } from '@xgis/engine'
import { wrapWebGpuBindGroupLayout } from '@xgis/engine'
import { Material, executeItems } from './material'
import { emitIconWgsl } from '@xgis/map'

type VertexBuffers = ReadonlyArray<{
  stride: number
  attributes: ReadonlyArray<{ location: number; offset: number; format: string }>
}>

/** One icon batch: its bind group + vertex buffer + vertex count. The bind group
 *  + vertex buffer are RHI handles (the renderer builds them via the RHI seam,
 *  §4 batch-seam migration) — passed straight through, NO re-wrapping here (a wrap
 *  of an already-RHI handle would double-wrap → unwrap yields a Native wrapper, not
 *  a GPUBindGroup/GPUBuffer → empty draw). */
export interface IconBatch {
  bindGroup: RhiBindGroup
  vertexBuf: RhiBuffer
  vertexCount: number
}

export class IconDraper {
  private readonly material: Material

  constructor(
    rhi: RhiDevice,
    format: string,
    sampleCount: number,
    bgLayout: GPUBindGroupLayout,
    vertexBuffers: VertexBuffers,
  ) {
    this.material = new Material(rhi, {
      shader: emitIconWgsl(),
      vsEntry: 'vs',
      fsEntry: 'fs',
      format: format as 'bgra8unorm',
      sampleCount,
      groups: [wrapWebGpuBindGroupLayout(bgLayout)],
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'alpha' }],
      vertexBuffers,
      variants: [{ label: 'icon-pipeline-rhi' }], // no depth-stencil
    })
  }

  draw(pass: RhiRenderPass, b: IconBatch): void {
    executeItems(this.material, pass, [
      {
        variant: 0,
        bindGroups: [b.bindGroup],
        vertex: b.vertexBuf,
        count: b.vertexCount,
        indexed: false,
      },
    ])
  }
}
