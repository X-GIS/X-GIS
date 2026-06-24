// ═══ Line adapter over the generic Material ═══
//
// The main (non-translucent) line draw through the generic core. Line is the most
// structurally distinct primitive so far: 2 bind groups BOTH with per-draw dynamic
// offsets (tile + layer ring), an INSTANCED draw (6 verts × segmentCount), 2
// fragment variants (fs_line / fs_line_pattern), and it REUSES the VTR tile bind-
// group layout (so its pipeline is layout-compatible with VTR-built tile groups).
// The translucent MAX-blend / composite pass is a render-graph concern, separate.

import type { RhiDevice, RhiRenderPass } from '../rhi/rhi'
import { wrapWebGpuBindGroup, wrapWebGpuBindGroupLayout } from '../rhi/rhi-webgpu'
import { Material, executeItems } from './material'
import { emitLineWgsl } from '../../shaders/dsl'

/** One line-segment batch: the (externally-built) tile + layer bind groups, their
 *  ring offsets, the pattern flag, and the instance (segment) count. */
export interface LineBatch {
  tileBG: GPUBindGroup
  layerBG: GPUBindGroup
  tileOffset: number
  layerOffset: number
  pattern: boolean
  segmentCount: number
}

export class LineDraper {
  private readonly material: Material

  constructor(rhi: RhiDevice, format: string, sampleCount: number, tileLayout: GPUBindGroupLayout, layerLayout: GPUBindGroupLayout) {
    this.material = new Material(rhi, {
      shader: emitLineWgsl(false), vsEntry: 'vs_line', fsEntry: 'fs_line',
      format: format as 'bgra8unorm', sampleCount,
      groups: [wrapWebGpuBindGroupLayout(tileLayout), wrapWebGpuBindGroupLayout(layerLayout)],
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'alpha' }],
      variants: [
        { depthWrite: false, depthCompare: 'less-equal', label: 'line-pipeline-rhi' },
        { depthWrite: false, depthCompare: 'less-equal', fsEntry: 'fs_line_pattern', label: 'line-pipeline-pattern-rhi' },
      ],
    })
  }

  draw(pass: RhiRenderPass, b: LineBatch): void {
    executeItems(this.material, pass, [{
      variant: b.pattern ? 1 : 0,
      bindGroups: [wrapWebGpuBindGroup(b.tileBG), wrapWebGpuBindGroup(b.layerBG)],
      dynamicOffsets: [[b.tileOffset], [b.layerOffset]],
      count: 6,
      indexed: false,
      instanceCount: b.segmentCount,
    }])
  }
}
