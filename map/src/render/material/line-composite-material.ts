// ═══ Line translucent-composite adapter over the generic Material ═══
//
// The second half of the translucent-line path: after the MAX-blend offscreen accumulation
// (LineDraper 'max' mode), a fullscreen pass samples that offscreen RT and composites it onto
// the main target with the per-layer opacity (a dynamic-offset ring slot), premultiplied-alpha
// blended. The Material carries the GLSL twins +
// by-name entry groups; both frame shapes hand the offscreen view as an RHI
// handle via drawRhi (#834 M5, chain since Inc-2d).

import type { RhiBuffer, RhiDevice, RhiRenderPass, RhiTextureView } from '@xgis/engine'
import { Material, executeItems } from '@xgis/engine'
import { emitCompositeWgsl } from '../../shaders/dsl/line-composite'
import { emitCompositeGlsl } from '../../shaders/dsl/line-glsl'
import { simpleGlslId, simpleWgslId } from '../../shaders/baked/ids'
import { glslStagesFor, wgslFor } from './wgsl-for'

/** Composite uniform ring slot size (matches LineRenderer.COMPOSITE_SLOT). */
const COMPOSITE_SLOT = 256

export class LineCompositeDraper {
  /** Release the GPU objects this draper owns (#1578). Called by `rebuildForQuality()`
   *  before the reference is dropped — a quality flip is live-session churn, not teardown,
   *  so nothing else would ever reclaim these. */
  destroy(): void {
    this._material?.destroy()
    this._material = undefined
    this.rhi.destroySampler(this.sampler.sampler)
  }

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
    // #2499 — `line-composite` is a boot key now, so both languages come from the store
    // before either emitter runs. Any translucent stroke reaches this draper, and it is
    // built inside the draw path, which is why the family cannot be lazy.
    return (this._material ??= new Material(this.rhi, {
      shader: wgslFor(this.rhi, emitCompositeWgsl, simpleWgslId('line-composite')),
      vsEntry: 'vs_full',
      fsEntry: 'fs_full',
      ...glslStagesFor(
        this.rhi,
        () => ({ vertex: emitCompositeGlsl('vertex'), fragment: emitCompositeGlsl('fragment') }),
        {
          vertex: simpleGlslId('line-composite', 'vertex'),
          fragment: simpleGlslId('line-composite', 'fragment'),
        },
      ),
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

  /** Composite the offscreen RT (an RHI handle — the one offscreen set both
   *  frame shapes share) onto the bound main pass. `ring`/`offset` are the
   *  per-layer opacity ring + its dynamic offset (the renderer wrote the
   *  opacity before calling). */
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
