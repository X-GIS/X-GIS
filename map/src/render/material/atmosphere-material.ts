// ═══ Atmosphere limb-glow adapter over the generic Material (#1258) ═══
//
// A fullscreen triangle, ONE uniform buffer (the camera ray field + the two style
// colours — atmosphere.ts's own header explains the shape), alpha-blended onto the
// colour target the background pass just cleared. No depth-stencil (a screen-space
// effect ahead of any depth-tested geometry) — the same "no depthCompare, no
// depth-stencil is synthesized" shape `scene-upscale-material.ts` uses for its own
// depthless fullscreen pass (CLAUDE.md §12's "pipeline that was right somewhere
// else": depth state is derived from THIS pass's target, never copied from another).

import type { RhiBuffer, RhiDevice, RhiRenderPass } from '@xgis/engine'
import { Material, executeItems } from '@xgis/engine'
import { emitAtmosphereWgsl, emitAtmosphereGlslStages } from '../../shaders/dsl/atmosphere'
import { wgslFor, glslStagesFor } from './wgsl-for'

export class AtmosphereDraper {
  private _material?: Material

  constructor(
    private readonly rhi: RhiDevice,
    private readonly format: string,
    private readonly sampleCount: number,
  ) {}

  /** Lazy — built on the first frame the atmosphere actually draws. group 0 = the one
   *  per-frame uniform buffer (no baked id — #1258 is off by default and decorative;
   *  see registry-emitter-coverage.test.ts's ALLOWLIST for the reason this family is
   *  not in the closed set). */
  private mat(): Material {
    return (this._material ??= new Material(this.rhi, {
      shader: wgslFor(this.rhi, emitAtmosphereWgsl),
      vsEntry: 'vs_atmosphere',
      fsEntry: 'fs_atmosphere',
      ...glslStagesFor(this.rhi, emitAtmosphereGlslStages),
      format: this.format as 'bgra8unorm',
      sampleCount: this.sampleCount,
      groups: [[{ binding: 0, kind: 'uniform', name: 'atm' }]],
      colorTargets: [{ format: this.format as 'bgra8unorm', blend: 'alpha' }],
      variants: [{ label: 'atmosphere' }], // no depth-stencil (fullscreen glow, ahead of geometry)
    }))
  }

  /** Draw the limb glow into the bound colour pass. `uniformBuf` already carries this
   *  frame's camera-ray field + colours (atmosphere-uniform.ts). The bind group is
   *  rebuilt per call — cheap (one uniform binding) and the camera changes every frame
   *  anyway. */
  draw(pass: RhiRenderPass, uniformBuf: RhiBuffer): void {
    const m = this.mat()
    const bg = this.rhi.createBindGroup(m.layout(0), [
      { binding: 0, resource: { buffer: uniformBuf } },
    ])
    executeItems(m, pass, [{ variant: 0, bindGroups: [bg], count: 3, indexed: false }])
  }
}
