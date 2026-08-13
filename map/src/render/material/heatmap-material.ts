// ═══ Heatmap RHI drapers — accum / blur / compose over the generic Material ═══
//
// The 3-pass heatmap's draw machinery (accum splat → separable Gaussian blur →
// ramp compose), one Material per stage, driven by HeatmapRenderer.renderChainRhi
// (#1046 F3b Inc-2c; a forced-WebGL2 twin frame used to drive the same drapers
// through a second entry point, renderRhi, until #1046 Inc-F3b deleted it). The
// shader is single-authority (one DSL module → WGSL for WebGPU, GLSL ES 3.00
// for WebGL2).
//
// #1473 residue — all three drapers below emitted BOTH languages unconditionally and
// lowered the GLSL module ONCE PER STAGE. "No backend-identity read is needed to select
// it" (what this header used to say) was true and beside the point: `wgsl-for.ts` asks
// the CAPABILITY, not the backend, and a language the device will never read is dead
// weight however cheaply it is selected. Each pass emits one language and lowers it once
// now; the bytes are unchanged, because each family's `…GlslStages` emitter is
// byte-identical to two per-stage calls (`glsl-stage-entry-parity.test.ts`). Every
// variant omits depthCompare — NO depth-stencil is synthesized (material.ts),
// which is exactly the chain's depthless offscreen/compose pass shape.
// (The former native-bridging HeatmapDraper — a wrapped GPUBindGroupLayout +
// native pipeline-factory blur/compose — retired with the native pass body.)

import type {
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBuffer,
  RhiDevice,
  RhiRenderPass,
  RhiSampler,
  RhiTextureView,
} from '@xgis/engine'
import { Material, executeItems } from '@xgis/engine'
import { emitHeatmapAccumWgsl } from '../../shaders/dsl/heatmap-accum'
import { emitHeatmapAccumGlslStages } from '../../shaders/dsl/heatmap-accum'
import { emitHeatmapBlurWgsl, emitHeatmapBlurGlslStages } from '../../shaders/dsl/heatmap-blur'
import {
  emitHeatmapComposeWgsl,
  emitHeatmapComposeGlslStages,
} from '../../shaders/dsl/heatmap-compose'
import { simpleGlslId, simpleWgslId } from '../../shaders/baked/ids'
import { glslStagesFor, wgslFor } from './wgsl-for'

// The accum batch carries RHI handles directly — the renderer builds the buffers +
// bind group via the RHI seam (§4 batch-seam migration), so NO re-wrapping here (a wrap
// of an already-RHI handle would double-wrap → unwrap yields a Native wrapper, not a
// GPUBuffer → empty draw).
export interface HeatmapBatch {
  bindGroup: RhiBindGroup
  vertBuf: RhiBuffer
  idxBuf: RhiBuffer
  indexCount: number
}

/** Accum draw: additive r16float single-draw. The bind layout is RHI-native
 *  (uniform + storage, the storage lowering to a data texture on WebGL2) so
 *  the renderer builds the per-layer bind group against `layout()` without
 *  touching a native device. */
export class HeatmapAccumTwinDraper {
  private readonly material: Material

  constructor(rhi: RhiDevice) {
    this.material = new Material(rhi, {
      shader: wgslFor(rhi, emitHeatmapAccumWgsl, simpleWgslId('heatmap-accum')),
      vsEntry: 'vs_heatmap',
      fsEntry: 'fs_heatmap',
      ...glslStagesFor(rhi, emitHeatmapAccumGlslStages, {
        vertex: simpleGlslId('heatmap-accum', 'vertex'),
        fragment: simpleGlslId('heatmap-accum', 'fragment'),
      }),
      format: 'r16float',
      sampleCount: 1,
      groups: [
        [
          // RHI kind entries lower to VERTEX|FRAGMENT visibility — a strict
          // superset of the retired native bgl's VERTEX-only; same buffer types.
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

/** Separable Gaussian blur draw: fullscreen triangle, reads the r16float density
 *  (textureLoad → texelFetch; the RHI binds the target's NEAREST params so the
 *  unfilterable-float read is complete) + a direction uniform, writes the 9-tap
 *  Gaussian to the r16float ping-pong target (no blend — a clean overwrite). */
export class HeatmapBlurDraper {
  private readonly material: Material

  constructor(private readonly rhi: RhiDevice) {
    this.material = new Material(rhi, {
      shader: wgslFor(rhi, emitHeatmapBlurWgsl, simpleWgslId('heatmap-blur')),
      vsEntry: 'vs_full',
      fsEntry: 'fs_blur',
      ...glslStagesFor(rhi, emitHeatmapBlurGlslStages, {
        vertex: simpleGlslId('heatmap-blur', 'vertex'),
        fragment: simpleGlslId('heatmap-blur', 'fragment'),
      }),
      format: 'r16float',
      sampleCount: 1,
      groups: [
        [
          // kind 'texture' lowers to sampleType 'float' (filterable). Valid for
          // r16float; if the density target ever becomes r32float this needs the
          // float32-filterable feature or an unfilterable-float entry.
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

/** Compose draw: fullscreen triangle samples the blurred density
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
      shader: wgslFor(rhi, emitHeatmapComposeWgsl, simpleWgslId('heatmap-compose')),
      vsEntry: 'vs_full',
      fsEntry: 'fs_compose',
      ...glslStagesFor(rhi, emitHeatmapComposeGlslStages, {
        vertex: simpleGlslId('heatmap-compose', 'vertex'),
        fragment: simpleGlslId('heatmap-compose', 'fragment'),
      }),
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
