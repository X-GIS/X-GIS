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
  private readonly material: Material  // non-pick: single colour target, fs_line / fs_line_pattern
  // pick pass: colour + rg32uint pick MRT. The line pick fragment writes vec2u(0,0) — lines are
  // not pickable; the target exists only for opaque-pass MRT compatibility when picking is on (so
  // no per-target writeMask is needed, the shader masks itself). LAZY so the non-pick path never
  // builds the rg32uint MRT pipeline (which WebGl2Device fail-closes on).
  private _pickMaterial?: Material

  constructor(
    private readonly rhi: RhiDevice,
    private readonly format: string,
    private readonly sampleCount: number,
    private readonly tileLayout: GPUBindGroupLayout,
    private readonly layerLayout: GPUBindGroupLayout,
  ) {
    this.material = this.buildMaterial(false)
  }

  private buildMaterial(pick: boolean): Material {
    return new Material(this.rhi, {
      shader: emitLineWgsl(pick), vsEntry: 'vs_line', fsEntry: 'fs_line',
      format: this.format as 'bgra8unorm', sampleCount: this.sampleCount,
      groups: [wrapWebGpuBindGroupLayout(this.tileLayout), wrapWebGpuBindGroupLayout(this.layerLayout)],
      colorTargets: pick
        ? [{ format: this.format as 'bgra8unorm', blend: 'alpha' }, { format: 'rg32uint' }]
        : [{ format: this.format as 'bgra8unorm', blend: 'alpha' }],
      variants: [
        { depthWrite: false, depthCompare: 'less-equal', label: pick ? 'line-pipeline-pick-rhi' : 'line-pipeline-rhi' },
        { depthWrite: false, depthCompare: 'less-equal', fsEntry: 'fs_line_pattern', label: pick ? 'line-pipeline-pattern-pick-rhi' : 'line-pipeline-pattern-rhi' },
      ],
    })
  }

  draw(pass: RhiRenderPass, b: LineBatch, pick = false): void {
    const material = pick ? (this._pickMaterial ??= this.buildMaterial(true)) : this.material
    executeItems(material, pass, [{
      variant: b.pattern ? 1 : 0,
      bindGroups: [wrapWebGpuBindGroup(b.tileBG), wrapWebGpuBindGroup(b.layerBG)],
      dynamicOffsets: [[b.tileOffset], [b.layerOffset]],
      count: 6,
      indexed: false,
      instanceCount: b.segmentCount,
    }])
  }
}
