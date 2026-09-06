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
import { simpleGlslId, simpleWgslId } from '../../shaders/baked/ids'
import { glslStagesFor, wgslFor } from './wgsl-for'

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
    // #2499 — `scene-upscale` is a boot key now. Its emit used to land at the exact moment
    // a weak device was downgrading quality; the store answers instead, and the seam is what
    // decides which language this device reads.
    return (this._material ??= new Material(this.rhi, {
      shader: wgslFor(this.rhi, emitSceneUpscaleWgsl, simpleWgslId('scene-upscale')),
      vsEntry: 'vs_upscale',
      fsEntry: 'fs_upscale',
      ...glslStagesFor(
        this.rhi,
        () => ({
          vertex: emitSceneUpscaleGlsl('vertex'),
          fragment: emitSceneUpscaleGlsl('fragment'),
        }),
        {
          vertex: simpleGlslId('scene-upscale', 'vertex'),
          fragment: simpleGlslId('scene-upscale', 'fragment'),
        },
      ),
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

  /** Release the Material AND the filtering sampler this draper owns. Called by the pass
   *  when it replaces this entry on a format / sampleCount change — the Material bakes both,
   *  so an adaptive-ladder notch or a `setQuality({msaa})` flip while the scene is scaled
   *  builds a fresh draper and the old pipelines + sampler are otherwise dropped
   *  unreferenced (#2337). Mirrors `ExtrudeShellComposeDraper.destroy`, the sibling
   *  sampler-owning draper. */
  destroy(): void {
    this._material?.destroy()
    this._material = undefined
    this.rhi.destroySampler(this.sampler.sampler)
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
