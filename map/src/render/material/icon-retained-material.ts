// ═══ Retained-icon adapter over the generic Material (#797 Phase 1) ═══
//
// The GPU adapter for the host DRAWING API's retained geo-anchored icon batch.
// Modeled on IconDraper (a thin ~adapter over the generic Material, NOT a new
// renderer) — with two structural choices the #797 P1 N-independence gate needs:
//
//   • The batch resources (feat storage + tint storage + atlas texture/sampler)
//     are group 1, bound through a bind group the caller builds ONCE per batch and
//     caches (like IconDraper's pre-built bind group, NOT PointDraper's per-draw
//     createBindGroup). Stable because Phase 0 guarantees a never-recreated atlas
//     texture identity and the batch's feat/tint buffers are packed once.
//   • The ~160 B frame uniform (pointU) is group 0 in the Material POOL — one pool
//     slot PER world copy per draw, so a flat-Mercator batch can fan out across
//     visible world copies (each with its own `world_offset` in circle_params.x)
//     WITHOUT re-baking the per-instance buffer. queue.writeBuffer can't feed two
//     draws in one pass different values from one buffer; the pool gives each copy
//     its own buffer. COPIES is O(1..~5), so this stays N-independent.
//
// draw = draw(6, count) instanced — no vertex/index buffers (the quad is
// procedural from vertex_index; the per-instance record is read from the feat
// storage via instance_index). One draw call per world copy.

import type {
  RhiBindGroup,
  RhiBuffer,
  RhiDevice,
  RhiRenderPass,
  RhiSampler,
  RhiTextureView,
} from '@xgis/engine'
import { Material, executeItems, type DrawItem } from './material'
import { emitIconRetainedWgsl, emitIconRetainedGlsl } from '@xgis/map'

export class RetainedIconDraper {
  private readonly material: Material

  constructor(rhi: RhiDevice, format: string, sampleCount: number, uniformSlotSize: number) {
    // #823 — GLSL ES 3.00 twins for the WebGL2 backend, emitted behind a LIVE
    // backend guard so the WebGPU boot never pays the double emit (#778 P6).
    // WebGl2Device.createPipeline requires the split sources; WebGPU ignores them.
    const glsl =
      rhi.backend === 'webgl2'
        ? { vsCode: emitIconRetainedGlsl('vertex'), fsCode: emitIconRetainedGlsl('fragment') }
        : {}
    this.material = new Material(rhi, {
      shader: emitIconRetainedWgsl(),
      ...glsl,
      vsEntry: 'vs_icon_retained',
      fsEntry: 'fs_icon_retained',
      format: format as 'bgra8unorm',
      sampleCount,
      // Entry `name`s = the DSL binding names — the WebGL2 backend reflects the
      // linked program BY NAME with them (multi-resource group 1 binds correctly
      // regardless of declaration order); WebGPU ignores them.
      groups: [
        // group 0 — the per-copy frame uniform (pooled). GLSL UBO tag = struct name.
        [{ binding: 0, kind: 'uniform', name: 'Uniforms' }],
        // group 1 — the per-batch resources (built once, cached by the caller).
        [
          { binding: 0, kind: 'storage', name: 'feat_data' }, // position DSFUN + quad geometry
          { binding: 1, kind: 'storage', name: 'tint_data' }, // rgba, its own buffer
          { binding: 2, kind: 'texture', name: 'atlas_tex' }, // atlas
          { binding: 3, kind: 'sampler', name: 'atlas_smp' },
        ],
      ],
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'alpha' }],
      // No depth-stencil — pure overlay (globe far-side handled by the shader's
      // cos_c cull, not the depth buffer). Single variant.
      variants: [{ label: 'icon-retained-pipeline-rhi' }],
      // Frame uniform per world copy (raster's per-tile pool pattern).
      pool: { group: 0, slotSize: uniformSlotSize },
    })
  }

  /** Build the per-batch group-1 bind group ONCE (feat + tint storage + atlas
   *  view/sampler). Cached by the caller for the batch's life — the atlas view is
   *  Phase-0 stable-identity, and feat/tint are packed once, so the bind group
   *  never needs rebuilding on a camera-only frame. */
  makeBatchBindGroup(
    feat: RhiBuffer,
    tint: RhiBuffer,
    atlasView: RhiTextureView,
    atlasSampler: RhiSampler,
  ): RhiBindGroup {
    return this.material.rhi.createBindGroup(this.material.layout(1), [
      { binding: 0, resource: { buffer: feat } },
      { binding: 1, resource: { buffer: tint } },
      { binding: 2, resource: { view: atlasView } },
      { binding: 3, resource: { sampler: atlasSampler } },
    ])
  }

  /** Draw one batch across its visible world copies. `perCopyUniformBytes` holds
   *  one frame-uniform snapshot per copy (each with its own world_offset baked in
   *  circle_params.x); `count` is the instance count (icons in the batch). One
   *  instanced draw(6, count) per copy. */
  draw(
    pass: RhiRenderPass,
    batchBindGroup: RhiBindGroup,
    perCopyUniformBytes: ReadonlyArray<BufferSource>,
    count: number,
  ): void {
    if (count === 0 || perCopyUniformBytes.length === 0) return
    const items: DrawItem[] = perCopyUniformBytes.map((bytes) => ({
      variant: 0,
      // group 0 (null) is filled from the pool via poolBytes; group 1 is the
      // cached batch bind group.
      bindGroups: [null, batchBindGroup],
      poolBytes: bytes,
      count: 6,
      indexed: false,
      instanceCount: count,
    }))
    executeItems(this.material, pass, items)
  }
}
