// ═══ Heatmap-accum adapter over the generic Material ═══
//
// The accum pass of the 3-pass heatmap (accum → blur → compose). One primitive
// draw: 1 bind group {uniform + read-only-storage feat}, a per-point quad vertex
// buffer + index buffer, drawIndexed, into the OFFSCREEN r16float density target
// with ADDITIVE blend (splats sum), no depth, single-sample. The blur/compose
// orchestration stays legacy (render-graph). Reuses the accum bind-group layout.

import type { RhiDevice, RhiRenderPass } from '../rhi/rhi'
import { wrapWebGpuBindGroup, wrapWebGpuBindGroupLayout, wrapWebGpuBuffer } from '../rhi/rhi-webgpu'
import { Material, executeItems } from './material'
import { emitHeatmapAccumWgsl } from '../../shaders/dsl'

export interface HeatmapBatch { bindGroup: GPUBindGroup; vertBuf: GPUBuffer; idxBuf: GPUBuffer; indexCount: number }

export class HeatmapDraper {
  private readonly material: Material

  constructor(rhi: RhiDevice, bgLayout: GPUBindGroupLayout) {
    this.material = new Material(rhi, {
      shader: emitHeatmapAccumWgsl(), vsEntry: 'vs_heatmap', fsEntry: 'fs_heatmap',
      format: 'r16float', sampleCount: 1,
      groups: [wrapWebGpuBindGroupLayout(bgLayout)],
      colorTargets: [{ format: 'r16float', blend: 'additive' }],
      // Per-point quad: center(vec2) + quad_id(u32) + feat_id(f32) = 16 B.
      vertexBuffers: [{ stride: 16, attributes: [
        { location: 0, offset: 0, format: 'float32x2' },
        { location: 1, offset: 8, format: 'uint32' },
        { location: 2, offset: 12, format: 'float32' },
      ] }],
      variants: [{ label: 'heatmap-accum-rhi' }], // no depth-stencil
    })
  }

  draw(pass: RhiRenderPass, b: HeatmapBatch): void {
    executeItems(this.material, pass, [{
      variant: 0,
      bindGroups: [wrapWebGpuBindGroup(b.bindGroup)],
      vertex: wrapWebGpuBuffer(b.vertBuf),
      index: { buffer: wrapWebGpuBuffer(b.idxBuf), format: 'uint32' },
      count: b.indexCount,
      indexed: true,
    }])
  }
}
