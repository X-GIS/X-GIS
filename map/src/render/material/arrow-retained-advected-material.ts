// ═══ Advected-arrow adapter over the generic Material (#1419) ═══
//
// The draw half of "the catalogue glyph IS the particle". Same 6-vertex procedural quad and the
// same pooled per-copy pointU frame uniform as RetainedArrowDraper — the differences are all in
// group 1, and all of them exist so the VS can re-symbolize each arrow from the data under its
// CURRENT position:
//
//   1 band_data    the catalogue rule as a table, in the shader's own units
//   2 flow_u_tex   east component                   3 flow_v_tex  north component
//   4 arrow_view   the per-frame camera + grid description the screen lattice is built from
//
// BINDING 0 IS DELIBERATELY EMPTY. It held `feat_data`, the per-instance anchors of a field
// generated from the GRID; #1520 step 2 replaced that generator with a lattice on the SCREEN, so
// there is nothing per instance left to read — an instance is `(seed, glyph)` and everything else
// comes from binding 4 and the velocity pair. The slot is left as a gap rather than renumbered
// because the numbers are stated in the DSL module's own binding decls, and shifting them for a
// deletion is a diff across two files for no gain.
//
// TWO THINGS ARE LOAD-BEARING HERE.
//
// `vertexVisible` on all four textures. Its absence is not a validation error at pipeline
// creation on WebGPU — it is a bind-group layout whose texture entries are FRAGMENT-only, so the
// vertex stage's `textureLoad` fails validation at draw time and the layer never renders. The
// flag is opt-in (rhi.ts) precisely because WebGPU counts sampled textures per stage, so a
// material that does not need it must not pay for it.
//
// NO tint buffer and NO samplers. The colour is the band the arrow is standing in, so a tint
// buffer would be a launch colour with nothing to say; and every texture is read with
// `textureLoad`, so the WebGL2 sampler-follows-its-texture ordering rule has nothing to bind in
// this stage at all.

import type {
  RhiBindGroup,
  RhiBuffer,
  RhiDevice,
  RhiRenderPass,
  RhiTextureView,
} from '@xgis/engine'
import { Material, executeItems, type DrawItem } from '@xgis/engine'
import {
  emitArrowRetainedAdvectedWgsl,
  emitArrowRetainedAdvectedGlsl,
} from '../../shaders/dsl/arrow-advected'

/** Group-1 entries, exported so a test can assert them against the EMITTED shader rather than
 *  against a second copy of the list (the same discipline ARROW_ADVECT_BINDINGS follows). */
export const ARROW_ADVECTED_BINDINGS = [
  { binding: 1, kind: 'storage', name: 'band_data' },
  { binding: 2, kind: 'texture', name: 'flow_u_tex', vertexVisible: true },
  { binding: 3, kind: 'texture', name: 'flow_v_tex', vertexVisible: true },
  { binding: 4, kind: 'uniform', name: 'arrow_view' },
] as const

export class RetainedArrowAdvectedDraper {
  private readonly material: Material

  constructor(rhi: RhiDevice, format: string, sampleCount: number, uniformSlotSize: number) {
    const glsl =
      rhi.backend === 'webgl2'
        ? {
            vsCode: emitArrowRetainedAdvectedGlsl('vertex'),
            fsCode: emitArrowRetainedAdvectedGlsl('fragment'),
          }
        : {}
    this.material = new Material(rhi, {
      shader: emitArrowRetainedAdvectedWgsl(),
      ...glsl,
      vsEntry: 'vs_arrow_retained_advected',
      fsEntry: 'fs_arrow_retained',
      format: format as 'bgra8unorm',
      sampleCount,
      groups: [[{ binding: 0, kind: 'uniform', name: 'Uniforms' }], [...ARROW_ADVECTED_BINDINGS]],
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'alpha' }],
      variants: [{ label: 'arrow-retained-advected-pipeline-rhi' }],
      pool: { group: 0, slotSize: uniformSlotSize },
    })
  }

  /** Build a group-1 bind group — cacheable for the batch's life now (#1520).
   *
   *  It used to carry a ping-pong STATE side that swapped every advection step, so the caller had
   *  to keep one bind group per side and alternate; binding the side being written is undefined
   *  behaviour on both backends. There is no state to swap any more — the arrow's position is a
   *  function of its origin and the frame clock — so the only reason to rebuild this is the
   *  region handing over a different velocity pair. */
  makeBatchBindGroup(
    band: RhiBuffer,
    flowU: RhiTextureView,
    flowV: RhiTextureView,
    view: RhiBuffer,
  ): RhiBindGroup {
    return this.material.rhi.createBindGroup(this.material.layout(1), [
      { binding: 1, resource: { buffer: band } },
      { binding: 2, resource: { view: flowU } },
      { binding: 3, resource: { view: flowV } },
      { binding: 4, resource: { buffer: view } },
    ])
  }

  /** ONE instanced draw(6, count) — not one per world copy, unlike every sibling draper.
   *
   *  A world copy exists so a flat-Mercator batch anchored in absolute Mercator metres can be
   *  drawn again `WORLD_WIDTH` to the side. This field has no absolute anchor to shift: its
   *  instances are lattice nodes of the CURRENT viewport, and the viewport is drawn once. Passing
   *  the copies through would redraw the identical lattice N times, which at low zoom is a field
   *  up to 5× too dense — and every glyph exactly on top of another, so it would read as a
   *  darker, faster current rather than as an obvious duplicate.
   *
   *  The first copy's uniform bytes are the ones used; `world_offset` (circle_params.x) is not
   *  read by this VS at all. */
  draw(
    pass: RhiRenderPass,
    batchBindGroup: RhiBindGroup,
    perCopyUniformBytes: ReadonlyArray<BufferSource>,
    count: number,
  ): number {
    if (count === 0 || perCopyUniformBytes.length === 0) return 0
    const items: DrawItem[] = [
      {
        variant: 0,
        bindGroups: [null, batchBindGroup],
        poolBytes: perCopyUniformBytes[0]!,
        count: 6,
        indexed: false,
        instanceCount: count,
      },
    ]
    return executeItems(this.material, pass, items)
  }
}
