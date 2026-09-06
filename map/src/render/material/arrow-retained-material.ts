// ═══ Retained-arrow adapter over the generic Material (movement vector field) ═══
//
// GPU adapter for the host DRAWING API's retained geo-anchored ARROW batch. Everything it
// shares with the other retained overlays — the pooled per-copy pointU frame uniform at
// group 0, the alpha overlay target, the dual-source emit, the feat + tint group 1 and the
// per-world-copy draw — is `RetainedFeatTintDraper` (retained-overlay-material.ts). This file
// is the arrow's own half of that:
//   • the `feat_data` record is position DSFUN + size + geo direction
//     (`shaders/dsl/arrow-retained` is the layout's authority).
//   • the 6-vertex quad is a BOUNDING QUAD — the arrow silhouette is an analytic SDF in the
//     fragment, not a sprite, so there is no atlas in group 1.

import type { RhiDevice } from '@xgis/engine'
import {
  emitArrowRetainedWgsl,
  emitArrowRetainedGlslStages,
} from '../../shaders/dsl/arrow-retained'
import { RetainedFeatTintDraper } from './retained-overlay-material'

export class RetainedArrowDraper extends RetainedFeatTintDraper {
  constructor(rhi: RhiDevice, format: string, sampleCount: number, uniformSlotSize: number) {
    super(rhi, format, sampleCount, uniformSlotSize, {
      family: 'arrow-retained',
      wgsl: emitArrowRetainedWgsl,
      glslStages: emitArrowRetainedGlslStages,
      vsEntry: 'vs_arrow_retained',
      fsEntry: 'fs_arrow_retained',
    })
  }
}
