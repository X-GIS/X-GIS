// ═══ Retained-arrow adapter over the generic Material (movement vector field) ═══
//
// GPU adapter for the host DRAWING API's retained geo-anchored ARROW batch — the sibling
// of RetainedIconDraper (icon-retained-material.ts). Same structure and the SAME per-copy
// pointU frame-uniform pool (group 0), so it shares the icon path's N-independence: the
// per-instance feat/tint buffers are packed once, a camera move rewrites only the frame
// uniform. The ONLY differences from the icon draper:
//   • group 1 is TWO storage buffers (feat + tint) — no atlas texture/sampler (the arrow
//     silhouette is procedural in the shader, not a sprite).
//   • draw = draw(6, count): a 6-vertex bounding quad from vertex_index (the arrow silhouette
//     is an analytic SDF in the fragment), one instanced draw per world copy.

import type { RhiBindGroup, RhiBuffer, RhiDevice, RhiRenderPass } from '@xgis/engine'
import { Material, executeItems, type DrawItem } from './material'
import { emitArrowRetainedWgsl, emitArrowRetainedGlsl } from '@xgis/map'

export class RetainedArrowDraper {
  private readonly material: Material

  constructor(rhi: RhiDevice, format: string, sampleCount: number, uniformSlotSize: number) {
    // #823 — GLSL ES 3.00 twins for the WebGL2 backend, emitted behind a LIVE backend guard
    // so the WebGPU boot never pays the double emit (#778 P6). WebGl2Device.createPipeline
    // requires the split sources; WebGPU ignores them. Mirrors RetainedIconDraper.
    const glsl =
      rhi.backend === 'webgl2'
        ? { vsCode: emitArrowRetainedGlsl('vertex'), fsCode: emitArrowRetainedGlsl('fragment') }
        : {}
    this.material = new Material(rhi, {
      shader: emitArrowRetainedWgsl(),
      ...glsl,
      vsEntry: 'vs_arrow_retained',
      fsEntry: 'fs_arrow_retained',
      format: format as 'bgra8unorm',
      sampleCount,
      // Entry `name`s = the DSL binding names — the WebGL2 backend reflects the linked program
      // BY NAME with them (multi-resource group 1 binds correctly regardless of declaration
      // order); WebGPU ignores them.
      groups: [
        // group 0 — the per-copy frame uniform (pooled), shared with the icon path.
        [{ binding: 0, kind: 'uniform', name: 'Uniforms' }],
        // group 1 — per-batch resources: feat + tint storage (NO atlas).
        [
          { binding: 0, kind: 'storage', name: 'feat_data' }, // position DSFUN + size + geo dir
          { binding: 1, kind: 'storage', name: 'tint_data' }, // rgba
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
   *  `count` is the instance count. One instanced draw(6, count) per copy. Returns the
   *  draw calls issued (= copies, NOT the instance count) — the N-independence invariant. */
  draw(
    pass: RhiRenderPass,
    batchBindGroup: RhiBindGroup,
    perCopyUniformBytes: ReadonlyArray<BufferSource>,
    count: number,
  ): number {
    if (count === 0 || perCopyUniformBytes.length === 0) return 0
    const items: DrawItem[] = perCopyUniformBytes.map((bytes) => ({
      variant: 0,
      bindGroups: [null, batchBindGroup],
      poolBytes: bytes,
      count: 6, // 6-vertex bounding quad (the arrow shape is an analytic SDF in the fragment)
      indexed: false,
      instanceCount: count,
    }))
    return executeItems(this.material, pass, items)
  }
}
