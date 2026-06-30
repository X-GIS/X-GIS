// ═══ Icon adapter over the generic Material ═══
//
// The simplest primitive: 1 bind group (uniform + atlas texture + sampler), a
// vertex buffer, NO depth (pure 2D overlay), one non-instanced draw. Reuses the
// icon renderer's bind-group layout so its pipeline is layout-compatible.

import type { RhiDevice, RhiRenderPass } from '../rhi/rhi'
import { wrapWebGpuBindGroup, wrapWebGpuBindGroupLayout, wrapWebGpuBuffer } from '../rhi/rhi-webgpu'
import { Material, executeItems } from './material'
import { emitIconWgsl } from '../../shaders/dsl'

type VertexBuffers = ReadonlyArray<{ stride: number; attributes: ReadonlyArray<{ location: number; offset: number; format: string }> }>

/** P1 — the sprite-icon draw routes through the RHI Material seam (IconDraper) by DEFAULT;
 *  `__xgisIconViaRhi === false` is the kill-switch back to the raw `pass.setPipeline`+`pass.draw`
 *  path. (The raw else-branch in IconRenderer.draw + the native icon pipeline survive as that
 *  fallback until the §4 seam deletes them.) Mirrors textViaRhiEnabled(). */
export function iconViaRhiEnabled(): boolean {
  return (globalThis as { __xgisIconViaRhi?: boolean }).__xgisIconViaRhi !== false
}

export interface IconBatch { bindGroup: GPUBindGroup; vertexBuf: GPUBuffer; vertexCount: number }

export class IconDraper {
  private readonly material: Material

  constructor(rhi: RhiDevice, format: string, sampleCount: number, bgLayout: GPUBindGroupLayout, vertexBuffers: VertexBuffers) {
    this.material = new Material(rhi, {
      shader: emitIconWgsl(), vsEntry: 'vs', fsEntry: 'fs',
      format: format as 'bgra8unorm', sampleCount,
      groups: [wrapWebGpuBindGroupLayout(bgLayout)],
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'alpha' }],
      vertexBuffers,
      variants: [{ label: 'icon-pipeline-rhi' }], // no depth-stencil
    })
  }

  draw(pass: RhiRenderPass, b: IconBatch): void {
    executeItems(this.material, pass, [{
      variant: 0,
      bindGroups: [wrapWebGpuBindGroup(b.bindGroup)],
      vertex: wrapWebGpuBuffer(b.vertexBuf),
      count: b.vertexCount,
      indexed: false,
    }])
  }
}
