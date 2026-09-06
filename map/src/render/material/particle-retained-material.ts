// ═══ Retained-particle-flow adapter over the generic Material (the wind-map aesthetic) ═══
//
// GPU adapter for the host DRAWING API's retained geo-anchored PARTICLE-FLOW batch (#826). The
// shared half — pooled per-copy pointU frame uniform at group 0, alpha overlay target,
// dual-source emit, feat + tint group 1, per-world-copy draw — is `RetainedFeatTintDraper`
// (retained-overlay-material.ts). This file is the particle's own:
//   • the `feat_data` record is origin + tip DSFUN + drift params
//     (`shaders/dsl/particle-retained` is the layout's authority).
//   • the 6-vertex quad is a BOUNDING SQUARE — the disc AND the closed-form drift are
//     analytic in the shader, not a sprite, so there is no atlas in group 1.
//   • the per-frame animation clock rides the frame uniform's free lane (design §3.0), never
//     the per-instance buffers — which is what keeps a camera move rewriting only the frame
//     uniform, exactly as for the still primitives, and keeps the draw-call count independent
//     of the particle count (a 4k-particle batch and a 16k-particle batch issue the identical
//     count at a fixed view).
//
// Candidate (b) is a pure dual-source DSL pipeline, so the GLSL twin is FREE — no new backend
// branch to diverge (design §3.2).

import type { RhiDevice } from '@xgis/engine'
import {
  emitParticleRetainedWgsl,
  emitParticleRetainedGlslStages,
} from '../../shaders/dsl/particle-retained'
import { RetainedFeatTintDraper } from './retained-overlay-material'

export class RetainedParticleDraper extends RetainedFeatTintDraper {
  constructor(rhi: RhiDevice, format: string, sampleCount: number, uniformSlotSize: number) {
    super(rhi, format, sampleCount, uniformSlotSize, {
      family: 'particle-retained',
      wgsl: emitParticleRetainedWgsl,
      glslStages: emitParticleRetainedGlslStages,
      vsEntry: 'vs_particle_retained',
      fsEntry: 'fs_particle_retained',
    })
  }
}
