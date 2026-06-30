// ═══ Line translucent-composite adapter over the generic Material ═══
//
// The second half of the translucent-line path: after the MAX-blend offscreen accumulation
// (LineDraper 'max' mode), a fullscreen pass samples that offscreen RT and composites it onto
// the main target with the per-layer opacity (a dynamic-offset ring slot), premultiplied-alpha
// blended. WebGPU-ONLY by construction — the offscreen translucent pass fail-closes on WebGl2
// (createCommandEncoder), so this Material is lazy + WGSL-only (no GLSL emit needed).

import type { RhiBuffer, RhiDevice, RhiRenderPass } from '@xgis/engine'
import { wrapWebGpuTextureView } from '@xgis/engine'
import { Material, executeItems } from './material'
import { emitCompositeWgsl } from '../../shaders/dsl'

/** Composite uniform ring slot size (matches LineRenderer.COMPOSITE_SLOT). */
const COMPOSITE_SLOT = 256

export class LineCompositeDraper {
  private _material?: Material
  private readonly sampler

  constructor(private readonly rhi: RhiDevice, private readonly format: string, private readonly sampleCount: number) {
    this.sampler = { sampler: rhi.createSampler({ mag: 'linear', min: 'linear' }) }
  }

  /** Lazy — built on the first composite (WebGPU only). group 0 = sampler + offscreen texture +
   *  a dynamic-offset opacity uniform; fs_full emits PREMULTIPLIED rgb so the target blends 'premult'. */
  private mat(): Material {
    return (this._material ??= new Material(this.rhi, {
      shader: emitCompositeWgsl(), vsEntry: 'vs_full', fsEntry: 'fs_full',
      format: this.format as 'bgra8unorm', sampleCount: this.sampleCount,
      groups: [[
        { binding: 0, kind: 'sampler' },
        { binding: 1, kind: 'texture' },
        { binding: 2, kind: 'uniform', dynamic: true },
      ]],
      colorTargets: [{ format: this.format as 'bgra8unorm', blend: 'premult' }],
      variants: [{ label: 'line-composite-rhi' }], // no depth-stencil (fullscreen composite)
    }))
  }

  /** Composite the offscreen RT onto the bound (main) pass. `ring`/`offset` are the per-layer
   *  opacity ring + its dynamic offset (the renderer wrote the opacity before calling). */
  draw(pass: RhiRenderPass, offscreenView: GPUTextureView, ring: RhiBuffer, offset: number): void {
    const m = this.mat()
    // `ring` is line's PRIVATE composite-opacity ring (RhiBuffer, §4 seam) → passed
    // straight through; the offscreen view stays a raw GPUTextureView (the offscreen
    // RT/pass origination is deferred to P2) → adopted via wrapWebGpuTextureView.
    const bg = this.rhi.createBindGroup(m.layout(0), [
      { binding: 0, resource: this.sampler },
      { binding: 1, resource: { view: wrapWebGpuTextureView(offscreenView) } },
      { binding: 2, resource: { buffer: ring, size: COMPOSITE_SLOT } },
    ])
    executeItems(m, pass, [{ variant: 0, bindGroups: [bg], dynamicOffsets: [[offset]], count: 3, indexed: false }])
  }
}
