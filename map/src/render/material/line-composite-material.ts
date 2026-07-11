// ═══ Line translucent-composite adapter over the generic Material ═══
//
// The second half of the translucent-line path: after the MAX-blend offscreen accumulation
// (LineDraper 'max' mode), a fullscreen pass samples that offscreen RT and composites it onto
// the main target with the per-layer opacity (a dynamic-offset ring slot), premultiplied-alpha
// blended. On webgl2 the Material carries the GLSL twins + by-name entry groups and the
// offscreen view arrives as an RHI handle via drawRhi (#834 M5); the WebGPU path keeps its
// raw-GPUTextureView draw() verbatim.

import type { RhiBuffer, RhiDevice, RhiRenderPass, RhiTextureView } from '@xgis/engine'
import { wrapWebGpuTextureView } from '@xgis/rhi-webgpu'
import { Material, executeItems } from '@xgis/engine'
import { emitCompositeWgsl } from '@xgis/map'
import { emitCompositeGlsl } from '../../shaders/dsl/line-glsl'

/** Composite uniform ring slot size (matches LineRenderer.COMPOSITE_SLOT). */
const COMPOSITE_SLOT = 256

export class LineCompositeDraper {
  private _material?: Material
  private readonly sampler

  constructor(
    private readonly rhi: RhiDevice,
    private readonly format: string,
    private readonly sampleCount: number,
  ) {
    this.sampler = { sampler: rhi.createSampler({ mag: 'linear', min: 'linear' }) }
  }

  /** Lazy — built on the first composite. group 0 = sampler + offscreen texture +
   *  a dynamic-offset opacity uniform; fs_full emits PREMULTIPLIED rgb so the target blends
   *  'premult'. Entry names come from the DSL bindings (samp/src/CompUniform) so the webgl2
   *  by-name reflection wires them regardless of declaration order. */
  private mat(): Material {
    const gl2 = this.rhi.backend === 'webgl2'
    return (this._material ??= new Material(this.rhi, {
      shader: emitCompositeWgsl(),
      vsEntry: 'vs_full',
      fsEntry: 'fs_full',
      vsCode: gl2 ? emitCompositeGlsl('vertex') : undefined,
      fsCode: gl2 ? emitCompositeGlsl('fragment') : undefined,
      format: this.format as 'bgra8unorm',
      sampleCount: this.sampleCount,
      groups: [
        [
          { binding: 0, kind: 'sampler', name: 'samp' },
          { binding: 1, kind: 'texture', name: 'src' },
          { binding: 2, kind: 'uniform', dynamic: true, name: 'CompUniform' },
        ],
      ],
      colorTargets: [{ format: this.format as 'bgra8unorm', blend: 'premult' }],
      variants: [{ label: 'line-composite-rhi' }], // no depth-stencil (fullscreen composite)
    }))
  }

  /** Composite the offscreen RT onto the bound (main) pass. `ring`/`offset` are the per-layer
   *  opacity ring + its dynamic offset (the renderer wrote the opacity before calling). */
  draw(pass: RhiRenderPass, offscreenView: GPUTextureView, ring: RhiBuffer, offset: number): void {
    // `ring` is line's PRIVATE composite-opacity ring (RhiBuffer, §4 seam) → passed
    // straight through; the offscreen view stays a raw GPUTextureView (the offscreen
    // RT/pass origination is deferred to P2) → adopted via wrapWebGpuTextureView.
    this.drawRhi(pass, wrapWebGpuTextureView(offscreenView), ring, offset)
  }

  /** Backend-blind sibling: the offscreen view arrives as an RHI handle (the
   *  forced-WebGL2 frame's offscreen RT — #834 M5). */
  drawRhi(
    pass: RhiRenderPass,
    offscreenView: RhiTextureView,
    ring: RhiBuffer,
    offset: number,
  ): void {
    const m = this.mat()
    const bg = this.rhi.createBindGroup(m.layout(0), [
      { binding: 0, resource: this.sampler },
      { binding: 1, resource: { view: offscreenView } },
      { binding: 2, resource: { buffer: ring, size: COMPOSITE_SLOT } },
    ])
    executeItems(m, pass, [
      { variant: 0, bindGroups: [bg], dynamicOffsets: [[offset]], count: 3, indexed: false },
    ])
  }
}
