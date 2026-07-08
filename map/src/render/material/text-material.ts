// ═══ Text adapter over the generic Material ═══
//
// SDF glyph labels: 1 bind group {dynamic-offset uniform, atlas-page texture,
// sampler}, a shared vertex buffer, and N per-SLICE draws — each a draw(count, 1,
// firstVertex, 0) with the slice's dynamic offset + its page's (cached) bind
// group. Premultiplied-alpha blend (the shader emits rgb*a, a), no depth. Reuses
// the text renderer's bind-group layout.

import type {
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBindLayoutEntry,
  RhiBuffer,
  RhiDevice,
  RhiRenderPass,
} from '@xgis/engine'
import { wrapWebGpuBindGroupLayout } from '@xgis/rhi-webgpu'
import { Material, executeItems } from './material'
import { emitTextWgsl } from '@xgis/map'
import { emitTextGlsl } from '../../shaders/dsl/text'

// WebGL2 by-name entries — the RHI-native twin of the raw text bind-group
// layout (#834 M5 slice 3). Names from the DSL: UBO tag = struct name;
// texture name = binding name (sampler fuses into the combined sampler2D).
const TEXT_ENTRIES: RhiBindLayoutEntry[] = [
  { binding: 0, kind: 'uniform', dynamic: true, name: 'Uniforms' },
  { binding: 1, kind: 'texture', name: 'atlas_tex' },
  { binding: 2, kind: 'sampler', name: 'atlas_smp' },
]

type VertexBuffers = ReadonlyArray<{
  stride: number
  attributes: ReadonlyArray<{ location: number; offset: number; format: string }>
}>

/** One glyph-run slice: its page's bind group + dynamic offset + vertex range. The
 *  bind group + vertex buffer are RHI handles (the renderer builds them via the RHI
 *  seam, §4 batch-seam migration) — passed straight through, NO re-wrapping here (a
 *  wrap of an already-RHI handle would double-wrap → unwrap yields a Native wrapper,
 *  not a GPUBindGroup/GPUBuffer → empty draw). */
export interface TextSlice {
  bg: RhiBindGroup
  dynamicOffset: number
  count: number
  first: number
}

export class TextDraper {
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
      shader: emitTextWgsl(),
      vsEntry: 'vs',
      fsEntry: 'fs',
      vsCode: gl2 ? emitTextGlsl('vertex') : undefined,
      fsCode: gl2 ? emitTextGlsl('fragment') : undefined,
      format: format as 'bgra8unorm',
      sampleCount,
      groups: [gl2 ? TEXT_ENTRIES : wrapWebGpuBindGroupLayout(bgLayout)],
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'premult' }],
      vertexBuffers,
      variants: [{ label: 'text-pipeline-rhi' }], // no depth-stencil
    })
  }

  /** Group-0 layout — the renderer builds its per-page bind groups against it
   *  (on WebGPU this IS the wrapped raw layout passed at construction). */
  layoutRhi(): RhiBindGroupLayout {
    return this.material.layout(0)
  }

  draw(pass: RhiRenderPass, vertexBuf: RhiBuffer, slices: ReadonlyArray<TextSlice>): void {
    executeItems(
      this.material,
      pass,
      slices.map((s) => ({
        variant: 0,
        bindGroups: [s.bg],
        dynamicOffsets: [[s.dynamicOffset]],
        vertex: vertexBuf,
        count: s.count,
        firstVertex: s.first,
        indexed: false,
      })),
    )
  }
}
