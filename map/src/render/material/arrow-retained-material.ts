// ═══ Retained-arrow adapter over the generic Material (movement vector field) ═══
//
// GPU adapter for the host DRAWING API's retained geo-anchored ARROW batch — the sibling
// of RetainedIconDraper (icon-retained-material.ts). Same structure and the SAME per-copy
// pointU frame-uniform pool (group 0), so it shares the icon path's N-independence: the
// per-instance feat/tint buffers are packed once, a camera move rewrites only the frame
// uniform. The ONLY differences from the icon draper:
//   • group 1 is TWO storage buffers (feat + tint) — no atlas texture/sampler (the arrow
//     silhouette is procedural in the shader, not a sprite).
//   • draw = draw(9, count): a 9-vertex procedural arrow (shaft quad + head triangle) from
//     vertex_index, one instanced draw per world copy.

import type { RhiBindGroup, RhiBuffer, RhiDevice, RhiRenderPass } from '@xgis/engine'
import { Material, executeItems, type DrawItem } from './material'
import { emitArrowRetainedWgsl } from '@xgis/map'

export class RetainedArrowDraper {
  private readonly material: Material

  constructor(rhi: RhiDevice, format: string, sampleCount: number, uniformSlotSize: number) {
    this.material = new Material(rhi, {
      shader: emitArrowRetainedWgsl(),
      vsEntry: 'vs_arrow_retained',
      fsEntry: 'fs_arrow_retained',
      format: format as 'bgra8unorm',
      sampleCount,
      groups: [
        // group 0 — the per-copy frame uniform (pooled), shared with the icon path.
        [{ binding: 0, kind: 'uniform' }],
        // group 1 — per-batch resources: feat + tint storage (NO atlas).
        [
          { binding: 0, kind: 'storage' }, // feat_data (position DSFUN + size + rotation)
          { binding: 1, kind: 'storage' }, // tint_data (rgba)
        ],
      ],
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'alpha' }],
      // No depth-stencil — pure overlay (globe far-side handled by the shader's cos_c cull).
      variants: [{ label: 'arrow-retained-pipeline-rhi' }],
      pool: { group: 0, slotSize: uniformSlotSize },
    })
  }

  /** Build the per-batch group-1 bind group ONCE (feat + tint storage). Cached by the
   *  caller for the batch's life — feat/tint are packed once, so it never rebuilds on a
   *  camera-only frame. */
  makeBatchBindGroup(feat: RhiBuffer, tint: RhiBuffer): RhiBindGroup {
    return this.material.rhi.createBindGroup(this.material.layout(1), [
      { binding: 0, resource: { buffer: feat } },
      { binding: 1, resource: { buffer: tint } },
    ])
  }

  /** Draw one batch across its visible world copies. `perCopyUniformBytes` holds one
   *  frame-uniform snapshot per copy (each with its own world_offset in circle_params.x);
   *  `count` is the instance count. One instanced draw(9, count) per copy. */
  draw(
    pass: RhiRenderPass,
    batchBindGroup: RhiBindGroup,
    perCopyUniformBytes: ReadonlyArray<BufferSource>,
    count: number,
  ): void {
    if (count === 0 || perCopyUniformBytes.length === 0) return
    const items: DrawItem[] = perCopyUniformBytes.map((bytes) => ({
      variant: 0,
      bindGroups: [null, batchBindGroup],
      poolBytes: bytes,
      count: 9, // 9-vertex procedural arrow (shaft quad 6 + head triangle 3)
      indexed: false,
      instanceCount: count,
    }))
    executeItems(this.material, pass, items)
  }
}
