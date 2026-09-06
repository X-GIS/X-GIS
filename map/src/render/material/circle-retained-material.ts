// ═══ Retained-circle adapter over the generic Material (disc primitive) ═══
//
// GPU adapter for the host DRAWING API's retained geo-anchored CIRCLE batch. The shared half —
// pooled per-copy pointU frame uniform at group 0, alpha overlay target, dual-source emit,
// feat + tint group 1, per-world-copy draw — is `RetainedFeatTintDraper`
// (retained-overlay-material.ts). This file is the circle's own:
//   • the `feat_data` record is position DSFUN + radius + stroke
//     (`shaders/dsl/circle-retained` is the layout's authority).
//   • the 6-vertex quad is a BOUNDING SQUARE — the disc is an analytic SDF in the fragment,
//     not a sprite, so there is no atlas in group 1.

import type { RhiDevice } from '@xgis/engine'
import {
  emitCircleRetainedWgsl,
  emitCircleRetainedGlslStages,
} from '../../shaders/dsl/circle-retained'
import { RetainedFeatTintDraper } from './retained-overlay-material'

export class RetainedCircleDraper extends RetainedFeatTintDraper {
  constructor(rhi: RhiDevice, format: string, sampleCount: number, uniformSlotSize: number) {
    super(rhi, format, sampleCount, uniformSlotSize, {
      family: 'circle-retained',
      wgsl: emitCircleRetainedWgsl,
      glslStages: emitCircleRetainedGlslStages,
      vsEntry: 'vs_circle_retained',
      fsEntry: 'fs_circle_retained',
    })
  }
}
