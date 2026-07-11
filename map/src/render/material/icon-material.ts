// ═══ Icon adapter over the generic Material ═══
//
// The simplest primitive: 1 bind group (uniform + atlas texture + sampler), a
// vertex buffer, NO depth (pure 2D overlay), one non-instanced draw. Reuses the
// icon renderer's bind-group layout so its pipeline is layout-compatible.

import type { RhiBindGroup, RhiBuffer, RhiDevice, RhiRenderPass } from '@xgis/engine'
import { wrapWebGpuBindGroupLayout } from '@xgis/rhi-webgpu'
import { emitIconGlsl } from '../../shaders/dsl/icon'

// WebGL2 by-name entries (#834 M5 slice 4) — same shape as the text draper's.
const ICON_ENTRIES: import('@xgis/engine').RhiBindLayoutEntry[] = [
  { binding: 0, kind: 'uniform', name: 'Uniforms' },
  { binding: 1, kind: 'texture', name: 'atlas_tex' },
  { binding: 2, kind: 'sampler', name: 'atlas_smp' },
]
import { Material, executeItems } from '@xgis/engine'
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
    const gl2 = rhi.backend === 'webgl2'
    this.material = new Material(rhi, {
      shader: emitIconWgsl(),
      vsEntry: 'vs',
      fsEntry: 'fs',
      vsCode: gl2 ? emitIconGlsl('vertex') : undefined,
      fsCode: gl2 ? emitIconGlsl('fragment') : undefined,
      format: format as 'bgra8unorm',
      sampleCount,
      groups: [gl2 ? ICON_ENTRIES : wrapWebGpuBindGroupLayout(bgLayout)],
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'alpha' }],
      vertexBuffers,
      variants: [{ label: 'icon-pipeline-rhi' }], // no depth-stencil
    })
  }

  /** Group-0 layout — the renderer builds its bind group against it (on
   *  WebGPU this IS the wrapped raw layout passed at construction). */
  layoutRhi(): import('@xgis/engine').RhiBindGroupLayout {
    return this.material.layout(0)
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
