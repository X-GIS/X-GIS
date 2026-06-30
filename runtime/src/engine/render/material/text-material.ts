// ═══ Text adapter over the generic Material ═══
//
// SDF glyph labels: 1 bind group {dynamic-offset uniform, atlas-page texture,
// sampler}, a shared vertex buffer, and N per-SLICE draws — each a draw(count, 1,
// firstVertex, 0) with the slice's dynamic offset + its page's (cached) bind
// group. Premultiplied-alpha blend (the shader emits rgb*a, a), no depth. Reuses
// the text renderer's bind-group layout.

import type { RhiBindGroup, RhiBuffer, RhiDevice, RhiRenderPass } from '@xgis/engine'
import { wrapWebGpuBindGroupLayout } from '@xgis/engine'
import { Material, executeItems } from './material'
import { emitTextWgsl } from '../../shaders/dsl'

type VertexBuffers = ReadonlyArray<{ stride: number; attributes: ReadonlyArray<{ location: number; offset: number; format: string }> }>

/** One glyph-run slice: its page's bind group + dynamic offset + vertex range. The
 *  bind group + vertex buffer are RHI handles (the renderer builds them via the RHI
 *  seam, §4 batch-seam migration) — passed straight through, NO re-wrapping here (a
 *  wrap of an already-RHI handle would double-wrap → unwrap yields a Native wrapper,
 *  not a GPUBindGroup/GPUBuffer → empty draw). */
export interface TextSlice { bg: RhiBindGroup; dynamicOffset: number; count: number; first: number }

export class TextDraper {
  private readonly material: Material

  constructor(rhi: RhiDevice, format: string, sampleCount: number, bgLayout: GPUBindGroupLayout, vertexBuffers: VertexBuffers) {
    this.material = new Material(rhi, {
      shader: emitTextWgsl(), vsEntry: 'vs', fsEntry: 'fs',
      format: format as 'bgra8unorm', sampleCount,
      groups: [wrapWebGpuBindGroupLayout(bgLayout)],
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'premult' }],
      vertexBuffers,
      variants: [{ label: 'text-pipeline-rhi' }], // no depth-stencil
    })
  }

  draw(pass: RhiRenderPass, vertexBuf: RhiBuffer, slices: ReadonlyArray<TextSlice>): void {
    executeItems(this.material, pass, slices.map((s) => ({
      variant: 0,
      bindGroups: [s.bg],
      dynamicOffsets: [[s.dynamicOffset]],
      vertex: vertexBuf,
      count: s.count,
      firstVertex: s.first,
      indexed: false,
    })))
  }
}
