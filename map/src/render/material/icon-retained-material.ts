// ═══ Retained-icon adapter over the generic Material (#797 Phase 1) ═══
//
// The GPU adapter for the host DRAWING API's retained geo-anchored icon batch. Modeled on
// IconDraper (a thin adapter over the generic Material, NOT a new renderer); everything it
// shares with the other four retained overlays lives in `retained-overlay-material.ts`,
// including the two structural choices the #797 P1 N-independence gate needs:
//
//   • The ~160 B frame uniform (pointU) is group 0 in the Material POOL — one pool slot PER
//     world copy per draw, so a flat-Mercator batch can fan out across visible world copies
//     (each with its own `world_offset` in circle_params.x) WITHOUT re-baking the
//     per-instance buffer. queue.writeBuffer can't feed two draws in one pass different
//     values from one buffer; the pool gives each copy its own. COPIES is O(1..~5), so this
//     stays N-independent.
//   • draw = draw(6, count) instanced, one call per world copy (`drawPerWorldCopy`).
//
// THE ICON'S OWN HALF is group 1: unlike arrow / circle / particle it is a SPRITE, so the
// atlas texture and its sampler join feat + tint. The bind group is built ONCE per batch and
// cached by the caller (like IconDraper's pre-built bind group, NOT PointDraper's per-draw
// createBindGroup) — stable because Phase 0 guarantees a never-recreated atlas texture
// identity and the batch's feat/tint buffers are packed once.

import type {
  Material,
  RhiBindGroup,
  RhiBuffer,
  RhiDevice,
  RhiRenderPass,
  RhiSampler,
  RhiTextureView,
} from '@xgis/engine'
import { emitIconRetainedWgsl, emitIconRetainedGlslStages } from '../../shaders/dsl/icon-retained'
import {
  batchBindGroup,
  drawPerWorldCopy,
  retainedOverlayMaterial,
} from './retained-overlay-material'

export class RetainedIconDraper {
  private readonly material: Material

  constructor(rhi: RhiDevice, format: string, sampleCount: number, uniformSlotSize: number) {
    this.material = retainedOverlayMaterial(rhi, format, sampleCount, uniformSlotSize, {
      family: 'icon-retained',
      wgsl: emitIconRetainedWgsl,
      glslStages: emitIconRetainedGlslStages,
      vsEntry: 'vs_icon_retained',
      fsEntry: 'fs_icon_retained',
      group1: [
        { binding: 0, kind: 'storage', name: 'feat_data' }, // position DSFUN + quad geometry
        { binding: 1, kind: 'storage', name: 'tint_data' }, // rgba, its own buffer
        { binding: 2, kind: 'texture', name: 'atlas_tex' }, // atlas
        { binding: 3, kind: 'sampler', name: 'atlas_smp' },
      ],
    })
  }

  /** Build the per-batch group-1 bind group ONCE (feat + tint storage + atlas view/sampler).
   *  Cached by the caller for the batch's life — the atlas view is Phase-0 stable-identity,
   *  and feat/tint are packed once, so it never needs rebuilding on a camera-only frame. */
  makeBatchBindGroup(
    feat: RhiBuffer,
    tint: RhiBuffer,
    atlasView: RhiTextureView,
    atlasSampler: RhiSampler,
  ): RhiBindGroup {
    return batchBindGroup(this.material, [
      { binding: 0, resource: { buffer: feat } },
      { binding: 1, resource: { buffer: tint } },
      { binding: 2, resource: { view: atlasView } },
      { binding: 3, resource: { sampler: atlasSampler } },
    ])
  }

  draw(
    pass: RhiRenderPass,
    batchBindGroup: RhiBindGroup,
    perCopyUniformBytes: ReadonlyArray<BufferSource>,
    count: number,
  ): number {
    return drawPerWorldCopy(this.material, pass, batchBindGroup, perCopyUniformBytes, count)
  }
}
