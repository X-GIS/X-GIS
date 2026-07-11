// ═══ Retained-circle adapter over the generic Material (disc primitive) ═══
//
// GPU adapter for the host DRAWING API's retained geo-anchored CIRCLE batch — the sibling of
// RetainedArrowDraper (arrow-retained-material.ts). Same structure and the SAME per-copy pointU
// frame-uniform pool (group 0), so it shares the N-independence: the per-instance feat/tint buffers
// are packed once, a camera move rewrites only the frame uniform. Like the arrow:
//   • group 1 is TWO storage buffers (feat + tint) — no atlas texture/sampler (the disc is a
//     procedural SDF in the fragment, not a sprite).
//   • draw = draw(6, count): a 6-vertex bounding square from vertex_index (the disc is an analytic
//     SDF in the fragment), one instanced draw per world copy.

import type { RhiBindGroup, RhiBuffer, RhiDevice, RhiRenderPass } from '@xgis/engine'
import { Material, executeItems, type DrawItem } from '@xgis/engine'
import { emitCircleRetainedWgsl, emitCircleRetainedGlsl } from '@xgis/map'

export class RetainedCircleDraper {
  private readonly material: Material

  constructor(rhi: RhiDevice, format: string, sampleCount: number, uniformSlotSize: number) {
    // #823 — GLSL ES 3.00 twins for the WebGL2 backend, emitted behind a LIVE backend guard so
    // the WebGPU boot never pays the double emit (#778 P6). Mirrors RetainedArrowDraper.
    const glsl =
      rhi.backend === 'webgl2'
        ? { vsCode: emitCircleRetainedGlsl('vertex'), fsCode: emitCircleRetainedGlsl('fragment') }
        : {}
    this.material = new Material(rhi, {
      shader: emitCircleRetainedWgsl(),
      ...glsl,
      vsEntry: 'vs_circle_retained',
      fsEntry: 'fs_circle_retained',
      format: format as 'bgra8unorm',
      sampleCount,
      groups: [
        // group 0 — the per-copy frame uniform (pooled), shared with the icon/arrow path.
        [{ binding: 0, kind: 'uniform', name: 'Uniforms' }],
        // group 1 — per-batch resources: feat + tint storage (NO atlas).
        [
          { binding: 0, kind: 'storage', name: 'feat_data' }, // position DSFUN + radius + stroke
          { binding: 1, kind: 'storage', name: 'tint_data' }, // fill rgba
        ],
      ],
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'alpha' }],
      // No depth-stencil — pure overlay (globe far-side handled by the shader's cos_c cull).
      variants: [{ label: 'circle-retained-pipeline-rhi' }],
      pool: { group: 0, slotSize: uniformSlotSize },
    })
  }

  /** Build the per-batch group-1 bind group ONCE (feat + tint storage). Cached by the caller for
   *  the batch's life — feat/tint are packed once, so it never rebuilds on a camera-only frame. */
  makeBatchBindGroup(feat: RhiBuffer, tint: RhiBuffer): RhiBindGroup {
    return this.material.rhi.createBindGroup(this.material.layout(1), [
      { binding: 0, resource: { buffer: feat } },
      { binding: 1, resource: { buffer: tint } },
    ])
  }

  /** Draw one batch across its visible world copies. One instanced draw(6, count) per copy.
   *  Returns the draw calls issued (= copies, NOT the instance count) — the N-independence
   *  invariant. */
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
      count: 6, // 6-vertex bounding square (the disc is an analytic SDF in the fragment)
      indexed: false,
      instanceCount: count,
    }))
    return executeItems(this.material, pass, items)
  }
}
