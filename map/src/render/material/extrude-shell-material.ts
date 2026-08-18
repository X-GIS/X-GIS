// ═══ Translucent-extrude shell compositor over the generic Material — #1253 ═══
//
// The draw half of the layer-wide front shell's composite step. RHI-native from
// birth (the flow-renderer / scene-upscale discipline): no
// `device.createRenderPipeline`, no ratchet baseline entry. The Material is
// built for the SCENE colour attachment's format + sample count — it draws into
// the same attachment the opaque bucket wrote, so its multisample state is
// derived from THAT pass, never copied from the shell pass it samples (the
// #1715 lesson: a pipeline that is right somewhere else is a validation error
// here).
//
// WGSL-only, deliberately — and gated so that is never a gap. The whole extrude
// path is absent on the GLSL backend: `PipelineFactory.build()` returns early
// there, so the extrude Material twins are never built, and
// `VectorTileRenderer.renderFillsRhi` skips every `cached.extruded` tile. Such a
// device renders NO extrusions at all, so the bucket that feeds this compositor
// is empty there by construction — `ClassifierInput.extrudeShell` asks
// `readsWgsl`, the CAPABILITY (doc §2), never a backend's name. A GLSL twin
// would therefore be a shader nothing can reach; `wgslFor` hands a
// GLSL-consuming device `''`, so one that somehow arrived here fails loud at
// Material construction rather than drawing the wrong thing.

import type { RhiDevice, RhiRenderPass, RhiTextureView } from '@xgis/engine'
import { Material, executeItems } from '@xgis/engine'
import { emitExtrudeShellComposeWgsl } from '../../shaders/dsl/extrude-shell-compose'
import { wgslFor } from './wgsl-for'

/** Pooled uniform slot size — one `alpha` f32 padded to the minimum uniform
 *  binding stride, matching the line compositor's ring slot. */
const SHELL_SLOT = 256

export class ExtrudeShellComposeDraper {
  private _material?: Material
  private readonly sampler
  private readonly scratch = new Float32Array(4)

  constructor(
    private readonly rhi: RhiDevice,
    private readonly format: string,
    private readonly sampleCount: number,
  ) {
    this.sampler = { sampler: rhi.createSampler({ mag: 'linear', min: 'linear' }) }
  }

  /** Release what the constructor + `mat()` created. Called when the pass drops
   *  this draper after a `setQuality` sample-count change (the #1578 class: a
   *  quality flip is live-session churn, and nothing else would reclaim these). */
  destroy(): void {
    this._material?.destroy()
    this._material = undefined
    this.rhi.destroySampler(this.sampler.sampler)
  }

  /** Lazy — built on the first frame a translucent extrusion is visible. group 0
   *  = sampler + the resolved shell target; group 1 = the per-layer alpha, served
   *  from the Material's per-item pool so two layers in one frame cannot read one
   *  another's value. 'premult' because `fs_shell` emits premultiplied rgb. */
  private mat(): Material {
    return (this._material ??= new Material(this.rhi, {
      shader: wgslFor(this.rhi, emitExtrudeShellComposeWgsl),
      vsEntry: 'vs_shell',
      fsEntry: 'fs_shell',
      format: this.format as 'bgra8unorm',
      sampleCount: this.sampleCount,
      groups: [
        [
          { binding: 0, kind: 'sampler', name: 'samp' },
          { binding: 1, kind: 'texture', name: 'src' },
        ],
        [{ binding: 0, kind: 'uniform', name: 'ShellUniform' }],
      ],
      colorTargets: [{ format: this.format as 'bgra8unorm', blend: 'premult' }],
      // No depth-stencil: a fullscreen composite, exactly like the line
      // compositor and the upscale seam. The DEPTH decision was already made
      // — in the shell pass, against the opaque pass's own depth attachment.
      variants: [{ label: 'extrude-shell-compose' }],
      pool: { group: 1, slotSize: SHELL_SLOT },
    }))
  }

  /** Composite one layer's resolved shell target onto the bound scene pass.
   *  `alpha` is that layer's resolved fill alpha; `slot` is its index in the
   *  frame's shell bucket, which advances the pool base so each layer's draw
   *  binds its own uniform buffer. The bind group is rebuilt per call — the
   *  shell view changes with every resize and ladder notch, and this draws at
   *  most once per layer per frame. */
  draw(pass: RhiRenderPass, shellView: RhiTextureView, alpha: number, slot: number): void {
    const m = this.mat()
    const bg = this.rhi.createBindGroup(m.layout(0), [
      { binding: 0, resource: this.sampler },
      { binding: 1, resource: { view: shellView } },
    ])
    this.scratch[0] = alpha
    executeItems(
      m,
      pass,
      [{ variant: 0, bindGroups: [bg, null], poolBytes: this.scratch, count: 3, indexed: false }],
      slot,
    )
  }
}
