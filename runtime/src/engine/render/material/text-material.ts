// ═══ Text adapter over the generic Material ═══
//
// SDF glyph labels: 1 bind group {dynamic-offset uniform, atlas-page texture,
// sampler}, a shared vertex buffer, and N per-SLICE draws — each a draw(count, 1,
// firstVertex, 0) with the slice's dynamic offset + its page's (cached) bind
// group. Premultiplied-alpha blend (the shader emits rgb*a, a), no depth. Reuses
// the text renderer's bind-group layout.

import type { RhiDevice, RhiRenderPass } from '../rhi/rhi'
import { wrapWebGpuBindGroup, wrapWebGpuBindGroupLayout, wrapWebGpuBuffer } from '../rhi/rhi-webgpu'
import { Material, executeItems } from './material'
import { emitTextWgsl } from '../../shaders/dsl'

type VertexBuffers = ReadonlyArray<{ stride: number; attributes: ReadonlyArray<{ location: number; offset: number; format: string }> }>

/** P1 — the SDF text/label draw routes through the RHI Material seam (TextDraper) by DEFAULT;
 *  `__xgisTextViaRhi === false` is the kill-switch back to the raw `pass.setPipeline`+`pass.draw`
 *  path. (The raw else-branch in TextRenderer.draw + the native text pipeline survive as that
 *  fallback until the §4 seam deletes them.) Mirrors fillViaRhiEnabled(). */
export function textViaRhiEnabled(): boolean {
  return (globalThis as { __xgisTextViaRhi?: boolean }).__xgisTextViaRhi !== false
}

/** One glyph-run slice: its page's bind group + dynamic offset + vertex range. */
export interface TextSlice { bg: GPUBindGroup; dynamicOffset: number; count: number; first: number }

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

  draw(pass: RhiRenderPass, vertexBuf: GPUBuffer, slices: ReadonlyArray<TextSlice>): void {
    const vb = wrapWebGpuBuffer(vertexBuf)
    executeItems(this.material, pass, slices.map((s) => ({
      variant: 0,
      bindGroups: [wrapWebGpuBindGroup(s.bg)],
      dynamicOffsets: [[s.dynamicOffset]],
      vertex: vb,
      count: s.count,
      firstVertex: s.first,
      indexed: false,
    })))
  }
}
