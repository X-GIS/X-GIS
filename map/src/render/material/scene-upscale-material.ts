// ═══ Scene→screen upscale adapter over the generic Material — #1429 INC-2 ═══
//
// The seam's draw half: a fullscreen triangle that samples the RESOLVED scene
// colour (single-sample, scene-sized) through a FILTERING sampler and writes
// the screen attachment — a ladder-scaled scene reads as a resolution scale,
// not a mosaic. RHI-native from birth (flow-renderer's F3/P5 discipline): no
// device.createRenderPipeline, no ratchet baseline entry. The Material is
// built for the SCREEN attachment's sample count — every existing pipeline
// keeps its own sample state (design §4 Finding 2), and only this one new
// pipeline appears.

import type { RhiDevice, RhiRenderPass, RhiTextureView } from '@xgis/engine'
import { Material, executeItems } from '@xgis/engine'
import { emitSceneUpscaleWgsl, emitSceneUpscaleGlsl } from '../../shaders/dsl/scene-upscale'
import { wgslFor } from './wgsl-for'

export class SceneUpscaleDraper {
  private _material?: Material
  private readonly sampler

  constructor(
    private readonly rhi: RhiDevice,
    private readonly format: string,
    private readonly sampleCount: number,
  ) {
    // FILTERING sampler — the whole point of the seam (design §6 piece 1):
    // linear min/mag makes the upscale a resolution scale, not a mosaic.
    this.sampler = { sampler: rhi.createSampler({ mag: 'linear', min: 'linear' }) }
  }

  /** Lazy — built on the first scaled frame. group 0 = sampler + scene colour.
   *  Opaque write (no blend): the seam replaces every screen pixel. */
  private mat(): Material {
    const gl2 = this.rhi.backend === 'webgl2'
    return (this._material ??= new Material(this.rhi, {
      shader: wgslFor(this.rhi, emitSceneUpscaleWgsl),
      vsEntry: 'vs_upscale',
      fsEntry: 'fs_upscale',
      vsCode: gl2 ? emitSceneUpscaleGlsl('vertex') : undefined,
      fsCode: gl2 ? emitSceneUpscaleGlsl('fragment') : undefined,
      format: this.format as 'bgra8unorm',
      sampleCount: this.sampleCount,
      groups: [
        [
          { binding: 0, kind: 'sampler', name: 'samp' },
          { binding: 1, kind: 'texture', name: 'src' },
        ],
      ],
      colorTargets: [{ format: this.format as 'bgra8unorm' }],
      variants: [{ label: 'scene-upscale' }], // no depth-stencil (fullscreen seam)
    }))
  }

  /** Draw the resolved scene colour into the bound SCREEN pass. The bind group
   *  is rebuilt per call — the scene view changes with every ladder notch and
   *  resize, and the seam draws at most once per frame. */
  draw(pass: RhiRenderPass, sceneColorView: RhiTextureView): void {
    const m = this.mat()
    const bg = this.rhi.createBindGroup(m.layout(0), [
      { binding: 0, resource: this.sampler },
      { binding: 1, resource: { view: sceneColorView } },
    ])
    executeItems(m, pass, [{ variant: 0, bindGroups: [bg], count: 3, indexed: false }])
  }
}
