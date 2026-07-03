// ═══ Heatmap-accum adapter over the generic Material ═══
//
// The accum pass of the 3-pass heatmap (accum → blur → compose). One primitive
// draw: 1 bind group {uniform + read-only-storage feat}, a per-point quad vertex
// buffer + index buffer, drawIndexed, into the OFFSCREEN r16float density target
// with ADDITIVE blend (splats sum), no depth, single-sample. The blur/compose
// orchestration stays legacy (render-graph). Reuses the accum bind-group layout.

import type { RhiBindGroup, RhiBuffer, RhiDevice, RhiRenderPass } from '@xgis/engine'
import { wrapWebGpuBindGroupLayout } from '@xgis/engine'
import { Material, executeItems } from './material'
import { emitHeatmapAccumWgsl } from '@xgis/map'

// The accum batch now carries RHI handles directly — the renderer builds the buffers +
// bind group via the RHI seam (§4 batch-seam migration), so NO re-wrapping here (a wrap
// of an already-RHI handle would double-wrap → unwrap yields a Native wrapper, not a
// GPUBuffer → empty draw).
export interface HeatmapBatch {
  bindGroup: RhiBindGroup
  vertBuf: RhiBuffer
  idxBuf: RhiBuffer
  indexCount: number
}

export class HeatmapDraper {
  private readonly material: Material

  constructor(rhi: RhiDevice, bgLayout: GPUBindGroupLayout) {
    this.material = new Material(rhi, {
      shader: emitHeatmapAccumWgsl(),
      vsEntry: 'vs_heatmap',
      fsEntry: 'fs_heatmap',
      format: 'r16float',
      sampleCount: 1,
      groups: [wrapWebGpuBindGroupLayout(bgLayout)],
      colorTargets: [{ format: 'r16float', blend: 'additive' }],
      // Per-point quad: center(vec2) + quad_id(u32) + feat_id(f32) = 16 B.
      vertexBuffers: [
        {
          stride: 16,
          attributes: [
            { location: 0, offset: 0, format: 'float32x2' },
            { location: 1, offset: 8, format: 'uint32' },
            { location: 2, offset: 12, format: 'float32' },
          ],
        },
      ],
      variants: [{ label: 'heatmap-accum-rhi' }], // no depth-stencil
    })
  }

  draw(pass: RhiRenderPass, b: HeatmapBatch): void {
    executeItems(this.material, pass, [
      {
        variant: 0,
        bindGroups: [b.bindGroup],
        vertex: b.vertBuf,
        index: { buffer: b.idxBuf, format: 'uint32' },
        count: b.indexCount,
        indexed: true,
      },
    ])
  }
}
