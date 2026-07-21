// ═══ Heatmap-accum adapter over the generic Material ═══
//
// The accum pass of the 3-pass heatmap (accum → blur → compose). One primitive
// draw: 1 bind group {uniform + read-only-storage feat}, a per-point quad vertex
// buffer + index buffer, drawIndexed, into the OFFSCREEN r16float density target
// with ADDITIVE blend (splats sum), no depth, single-sample. The blur/compose
// orchestration stays legacy (render-graph). Reuses the accum bind-group layout.

import type {
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiDevice,
  RhiRenderPass,
  RhiSampler,
  RhiTextureView,
} from '@xgis/engine'
import { wrapWebGpuBindGroupLayout } from '@xgis/rhi-webgpu'
import { Material, executeItems } from '@xgis/engine'
import { emitHeatmapAccumWgsl } from '@xgis/map'
import { emitHeatmapAccumGlsl } from '../../shaders/dsl/heatmap-accum'
import { emitHeatmapBlurWgsl, emitHeatmapBlurGlsl } from '../../shaders/dsl/heatmap-blur'
import { emitHeatmapComposeWgsl, emitHeatmapComposeGlsl } from '../../shaders/dsl/heatmap-compose'

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

// ═══ Forced-WebGL2 twin drapers (#1060) ═══
//
// The WebGPU heatmap 3-pass pipeline (heatmap-pass.ts) runs its accum draw through
// the HeatmapDraper above (a native GPUBindGroupLayout wrapper) and its blur/compose
// draws through native pipeline-factory pipelines. On the forced-WebGL2 twin there is
// no native GPUDevice (the ctx.device is a no-op proxy, #834), so the whole pipeline
// re-originates through the RHI seam: RHI-native bind layouts (kind entries, not a
// wrapped native layout) + the same shader DSL authorities emitted as GLSL ES 3.00.
// The shader is single-authority (one DSL module → WGSL for WebGPU, GLSL here); only
// the pipeline DESCRIPTOR is expressed a second time (matching the graticule twin
// Material precedent). GLSL is emitted UNCONDITIONALLY — WebGPU's createPipeline
// ignores vsCode/fsCode, so no backend-identity read is needed to select it.

/** Accum draw for the twin: same additive r16float single-draw as HeatmapDraper,
 *  but the bind layout is RHI-native (uniform + storage, the storage lowering to a
 *  data texture on WebGL2) so the renderer can build the per-layer bind group
 *  against `layout()` without touching the proxy device. */
export class HeatmapAccumTwinDraper {
  private readonly material: Material

  constructor(rhi: RhiDevice) {
    this.material = new Material(rhi, {
      shader: emitHeatmapAccumWgsl(),
      vsEntry: 'vs_heatmap',
      fsEntry: 'fs_heatmap',
      vsCode: emitHeatmapAccumGlsl('vertex'),
      fsCode: emitHeatmapAccumGlsl('fragment'),
      format: 'r16float',
      sampleCount: 1,
      groups: [
        [
          { binding: 0, kind: 'uniform', name: 'Uniforms' },
          { binding: 1, kind: 'storage', name: 'feat_data' },
        ],
      ],
      colorTargets: [{ format: 'r16float', blend: 'additive' }],
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
      variants: [{ label: 'heatmap-accum-rhi-twin' }],
    })
  }

  /** The RHI accum bind-group layout (group 0: uniform + storage). */
  layout(): RhiBindGroupLayout {
    return this.material.layout(0)
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

/** Blur draw for the twin: fullscreen triangle, reads the r16float density
 *  (textureLoad → texelFetch; the RHI binds the target's NEAREST params so the
 *  unfilterable-float read is complete) + a direction uniform, writes the 9-tap
 *  Gaussian to the r16float ping-pong target (no blend — a clean overwrite). */
export class HeatmapBlurDraper {
  private readonly material: Material

  constructor(private readonly rhi: RhiDevice) {
    this.material = new Material(rhi, {
      shader: emitHeatmapBlurWgsl(),
      vsEntry: 'vs_full',
      fsEntry: 'fs_blur',
      vsCode: emitHeatmapBlurGlsl('vertex'),
      fsCode: emitHeatmapBlurGlsl('fragment'),
      format: 'r16float',
      sampleCount: 1,
      groups: [
        [
          { binding: 0, kind: 'texture', name: 'src_tex' },
          { binding: 1, kind: 'uniform', name: 'BlurParams' },
        ],
      ],
      colorTargets: [{ format: 'r16float', blend: 'none' }],
      variants: [{ label: 'heatmap-blur-rhi' }],
    })
  }

  draw(pass: RhiRenderPass, srcView: RhiTextureView, dirBuf: RhiBuffer): void {
    const bg = this.rhi.createBindGroup(this.material.layout(0), [
      { binding: 0, resource: { view: srcView } },
      { binding: 1, resource: { buffer: dirBuf } },
    ])
    executeItems(this.material, pass, [{ variant: 0, bindGroups: [bg], count: 3, indexed: false }])
  }
}

/** Compose draw for the twin: fullscreen triangle samples the blurred density
 *  (texelFetch), maps it through the ramp LUT (linear textureSample) × intensity
 *  × opacity, and alpha-blends onto the screen pass. `format` is the screen
 *  colour format (nominal on WebGL2's default framebuffer). */
export class HeatmapComposeDraper {
  private readonly material: Material

  constructor(
    private readonly rhi: RhiDevice,
    format: string,
  ) {
    this.material = new Material(rhi, {
      shader: emitHeatmapComposeWgsl(),
      vsEntry: 'vs_full',
      fsEntry: 'fs_compose',
      vsCode: emitHeatmapComposeGlsl('vertex'),
      fsCode: emitHeatmapComposeGlsl('fragment'),
      format: format as 'bgra8unorm',
      sampleCount: 1,
      groups: [
        [
          { binding: 0, kind: 'texture', name: 'density_tex' },
          { binding: 1, kind: 'texture', name: 'ramp_tex' },
          { binding: 2, kind: 'sampler', name: 'ramp_sampler' },
          { binding: 3, kind: 'uniform', name: 'ComposeParams' },
        ],
      ],
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'alpha' }],
      variants: [{ label: 'heatmap-compose-rhi' }],
    })
  }

  draw(
    pass: RhiRenderPass,
    densityView: RhiTextureView,
    rampView: RhiTextureView,
    sampler: RhiSampler,
    paramsBuf: RhiBuffer,
  ): void {
    const bg = this.rhi.createBindGroup(this.material.layout(0), [
      { binding: 0, resource: { view: densityView } },
      { binding: 1, resource: { view: rampView } },
      { binding: 2, resource: { sampler } },
      { binding: 3, resource: { buffer: paramsBuf } },
    ])
    executeItems(this.material, pass, [{ variant: 0, bindGroups: [bg], count: 3, indexed: false }])
  }
}
