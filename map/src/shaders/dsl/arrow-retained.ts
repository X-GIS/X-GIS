// ═══ Shader DSL — retained geo-anchored ARROW shader (movement vector field) ═══
//
// The GPU half of the host DRAWING API's retained ARROW batch — the sibling of
// dsl/icon-retained.ts. It PROJECTS the geo anchor ON THE GPU (a camera move rewrites only the
// ~160 B pointU frame uniform; the per-instance buffer is packed once), reusing icon-retained's
// geo→clip ladder (the same injected getGpuProjectionFuncs() + the same `pointU` frame uniform +
// the same per-copy world_offset in circle_params.x) via the `project_geo` helper.
//
// DIRECTION is GEOGRAPHIC (#825): the record carries the TAIL anchor and a TIP one bearing-step
// along the outflow direction. The VS projects BOTH and derives the screen-space orientation
// (cc, ss) from their clip-space delta, so the arrow stays correct under camera bearing / pitch /
// globe — not a baked screen angle frozen at add-time.
//
// SILHOUETTE is an analytic SDF over a BOUNDING QUAD (#824): the VS emits a 6-vertex quad sized
// (length × width) around the arrow; the FS evaluates a tapered-half-width arrow profile with
// fwidth-based coverage — resolution-independent, crisp AA at the graphics pass's single-sample.

import {
  fn,
  module,
  transformMat4,
  f32,
  u32,
  abs,
  max,
  saturate,
  select,
  fwidth,
  length,
  mix,
  vec2,
  vec3,
  vec4,
  when,
  Switch,
  Discard,
  If,
  f32T,
  u32T,
  vec2fT,
  vec3fT,
  vec4fT,
  type ModuleDecl,
  type ReadonlyNode,
} from '@xgis/shader-dsl'
import { ioStruct, builtin, location, storageBuffer } from '@xgis/shader-dsl'
import { emitModule, emitGlslModule, emitGlslStages, stageOf } from '@xgis/shader-dsl'
import {
  flat_rel,
  needs_backface_cull,
  PROJECTION_CONSTS,
  getGpuProjectionFuncs,
} from './projections'
import { pointU } from './point'
import { ARROW_RETAINED_FEAT } from './arrow-retained-feat-layout'

const STRIDE = u32(ARROW_RETAINED_FEAT.stride)
const F = ARROW_RETAINED_FEAT.slot

const featB = storageBuffer('feat_data', f32T, { group: 1, binding: 0, access: 'read' })
const tintB = storageBuffer('tint_data', vec4fT, { group: 1, binding: 1, access: 'read' })
const featData = featB.node

// Unit arrow profile (tail at origin, tip at +x = 1; coords in units of LENGTH). Shaft x∈[0,HB]
// at half-width SH; head x∈[HB,1] tapers linearly from HH to 0. HH = the bounding quad half-height.
const SH = 0.09
const HH = 0.26
const HB = 0.6
const HEAD_SLOPE = HH / (1 - HB)

// geo → clip, reused VERBATIM from icon-retained/point vs_point. Called TWICE (tail + tip) so the
// arrow orientation is a projected screen direction, correct under any camera.
const project_geo = fn(
  'project_geo',
  {
    ecefH: vec3fT,
    ecefL: vec3fT,
    absLon: f32T,
    absLat: f32T,
    mxH: f32T,
    mxL: f32T,
    myH: f32T,
    myL: f32T,
  },
  (a) => {
    const camH = pointU.field.cam_ecef_h.swizzle('xyz')
    const camL = pointU.field.cam_ecef_l.swizzle('xyz')
    const ecefRtc = a.ecefH.sub(camH).add(a.ecefL.sub(camL))
    const mvp = pointU.field.mvp
    const worldOffset = pointU.field.circle_params.x
    return when(
      [
        [
          pointU.field.proj_params.x.lt(0.5),
          () => {
            const camMercH = pointU.field.cam_ecef_h.swizzle('xy')
            const camMercL = pointU.field.cam_ecef_l.swizzle('xy')
            const relX = a.mxH.sub(camMercH.x).add(a.mxL.sub(camMercL.x)).add(worldOffset)
            const relY = a.myH.sub(camMercH.y).add(a.myL.sub(camMercL.y))
            return transformMat4(mvp, vec4(relX, relY, 0, 1))
          },
        ],
        [
          pointU.field.proj_params.x.lt(6.5),
          () => {
            const relG = flat_rel(a.absLon, a.absLat, pointU.field.proj_params, a.absLon)
            return transformMat4(mvp, vec4(relG.x, relG.y, 0, 1))
          },
        ],
      ],
      () => transformMat4(mvp, vec4(ecefRtc, 1)),
    )
  },
)

/** The bounding quad's 6 vertices in unit-arrow space: `qx ∈ {−margin, 1+margin}` along,
 *  `qy ∈ {−(HH+margin), HH+margin}` across.
 *
 *  `margin` is the per-instance outline stroke width (0 for every arrow that doesn't opt in — the
 *  quad is then IDENTICAL to the un-outlined bounds, `{0,1}×{−HH,HH}`, so an existing caller's
 *  rasterized area is byte-for-byte unchanged). A non-zero margin gives the FS room to shade the
 *  stroke band past the fill silhouette: a pixel outside the un-enlarged quad is never shaded at
 *  all — no fragment invocation happens there — so the stroke would clip off without it.
 *
 *  Shared by the static VS and the advected one. They differ in where the quad is PLACED, never in
 *  what it is, and the outline geometry is exactly the kind of detail that drifts when it is
 *  written twice. */
export const arrowQuadOffset = (
  vi: ReadonlyNode<'u32'>,
  margin: ReadonlyNode<'f32'>,
): { qx: ReturnType<typeof f32>; qy: ReturnType<typeof f32> } => {
  const qx = f32(0)
  const qy = f32(0)
  const lo = () => {
    qx.assign(f32(0).sub(margin))
    qy.assign(f32(-HH).sub(margin))
  }
  const hi = () => {
    qx.assign(f32(1).add(margin))
    qy.assign(f32(HH).add(margin))
  }
  Switch(vi)
    .case(0, lo)
    .case(1, () => {
      qx.assign(f32(0).sub(margin))
      qy.assign(f32(HH).add(margin))
    })
    .case(2, hi)
    .case(3, lo)
    .case(4, hi)
    .case(5, () => {
      qx.assign(f32(1).add(margin))
      qy.assign(f32(-HH).sub(margin))
    })
    .default(() => {
      /* vi ∈ 0..5 */
    })
  return { qx, qy }
}

/** Shared with the advected module — the same silhouette, the same interpolants, one FS. */
export const ArrowOut = ioStruct('ArrowRetainedOut', {
  position: builtin('position', vec4fT),
  loc: location(0, vec2fT),
  tint: location(1, vec4fT),
  cos_c: location(2, f32T, 'flat'),
  // Outline stroke width, in the SAME unit-space as loc (0 = no outline — every existing
  // caller that doesn't opt in). Per-instance constant across a quad's 6 vertices, like
  // cos_c, so 'flat' avoids pointless interpolation of an already-uniform value.
  stroke_units: location(3, f32T, 'flat'),
})

const vs = fn(
  'vs_arrow_retained',
  {
    inst: builtin('instance_index', u32T),
    vi: builtin('vertex_index', u32T),
  },
  (p) => {
    const rd = (slot: number) => featData.at(p.inst.mul(STRIDE).add(slot), f32T)

    const absLon = rd(F.abs_lon)
    const absLat = rd(F.abs_lat)
    const tailClip = project_geo({
      ecefH: vec3(rd(F.ecef_x_h), rd(F.ecef_y_h), rd(F.ecef_z_h)),
      ecefL: vec3(rd(F.ecef_x_l), rd(F.ecef_y_l), rd(F.ecef_z_l)),
      absLon,
      absLat,
      mxH: rd(F.merc_x_h),
      mxL: rd(F.merc_x_l),
      myH: rd(F.merc_y_h),
      myL: rd(F.merc_y_l),
    })
    const tipClip = project_geo({
      ecefH: vec3(rd(F.tip_ecef_x_h), rd(F.tip_ecef_y_h), rd(F.tip_ecef_z_h)),
      ecefL: vec3(rd(F.tip_ecef_x_l), rd(F.tip_ecef_y_l), rd(F.tip_ecef_z_l)),
      absLon: rd(F.tip_abs_lon),
      absLat: rd(F.tip_abs_lat),
      mxH: rd(F.tip_merc_x_h),
      mxL: rd(F.tip_merc_x_l),
      myH: rd(F.tip_merc_y_h),
      myL: rd(F.tip_merc_y_l),
    })
    const centerClip = tailClip

    // Screen-space orientation from the clip-space delta. NDC is per-axis normalized, so the raw
    // delta is aspect-skewed; scale each axis by the viewport extent to recover the true SCREEN-px
    // direction before normalizing (the ×2 NDC→px factor is common to both axes → cancels). +y
    // flips. Using the unit delta as (cos, sin) rotates the arrow's local +x onto the flow dir.
    const vp = pointU.field.viewport
    const ndcTail = tailClip.swizzle('xy').div(tailClip.w)
    const ndcTip = tipClip.swizzle('xy').div(tipClip.w)
    const dsx = ndcTip.x.sub(ndcTail.x).mul(vp.x)
    const dsy = ndcTip.y.sub(ndcTail.y).neg().mul(vp.y)
    const dlen = max(length(vec2(dsx, dsy)), f32(1e-6))
    const cc = dsx.div(dlen)
    const ss = dsy.div(dlen)

    const margin = rd(F.stroke_units)
    const { qx, qy } = arrowQuadOffset(p.vi, margin)

    // Scale by length (px), orient by (cc, ss) around the tail (the geo anchor).
    const size = rd(F.size)
    const lx = qx.mul(size)
    const ly = qy.mul(size)
    const rx = lx.mul(cc).sub(ly.mul(ss))
    const ry = lx.mul(ss).add(ly.mul(cc))

    // px → NDC, perspective-correct (× clip.w). y flips: screen +y down → NDC -y.
    const offNdc = vec2(rx.mul(f32(2).div(vp.x)), ry.neg().mul(f32(2).div(vp.y)))
    const clip = centerClip.add(vec4(offNdc.mul(centerClip.w), 0, 0))

    const o = ArrowOut.var()
    o.position.assign(clip)
    o.loc.assign(vec2(qx, qy))
    o.tint.assign(tintB.node.at(p.inst, vec4fT))
    o.cos_c.assign(
      needs_backface_cull(absLon, absLat, pointU.field.proj_params, pointU.field.globe_eye),
    )
    o.stroke_units.assign(margin)
    return o.$
  },
  { stage: 'vertex' },
)

export const fs = fn(
  'fs_arrow_retained',
  { in: ArrowOut },
  (p) => {
    const pin = p.in
    If(pin.cos_c.lt(0), () => {
      Discard()
    })
    const ax = pin.loc.x
    const ay = abs(pin.loc.y)
    const hwHead = max(f32(1).sub(ax), 0).mul(HEAD_SLOPE)
    const hw = select(ax.lt(HB), f32(SH), hwHead)
    const d = max(ay.sub(hw), max(ax.neg(), ax.sub(1)))
    const aa = fwidth(pin.loc.x).add(fwidth(pin.loc.y)).mul(0.7).add(f32(1e-5))
    // covFill = the ORIGINAL (pre-outline) coverage, UNCHANGED. covTotal = the same AA-edged
    // step, shifted outward by the per-instance stroke width `su` — the fill+stroke region.
    // strokeCov isolates JUST the stroke ring's own coverage: it is IDENTICALLY ZERO whenever
    // su=0 (covTotal collapses to covFill algebraically), which is the proof that an
    // un-outlined arrow's output is byte-for-byte unchanged — blending toward black by
    // covFill instead (the naive, REJECTED formula) would darken every existing arrow's AA
    // edge even with no outline requested (0.5 coverage there, not 0).
    const su = pin.stroke_units
    const covFill = saturate(f32(0.5).sub(d.div(aa)))
    const covTotal = saturate(f32(0.5).sub(d.sub(su).div(aa)))
    const strokeCov = max(covTotal.sub(covFill), 0)
    const rgb = mix(pin.tint.swizzle('xyz'), vec3(f32(0), f32(0), f32(0)), strokeCov)
    const out = vec4(rgb, pin.tint.w.mul(covTotal))
    If(out.w.lt(f32(0.004)), () => {
      Discard()
    })
    return out
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

export const buildArrowRetainedModule = (): ModuleDecl =>
  module({
    consts: [...PROJECTION_CONSTS],
    structs: [pointU.struct, ArrowOut.decl],
    bindings: [pointU.binding, featB.binding, tintB.binding],
    funcs: [...getGpuProjectionFuncs(), project_geo, vs, fs],
  })

/** Full retained-arrow shader: shared projection consts + injected projection fns + the two-point
 *  geo-directional arrow quad VS + analytic-SDF anti-aliased solid-tint FS. */
export const emitArrowRetainedWgsl = (): string => emitModule(buildArrowRetainedModule())

/** GLSL ES 3.00 twin for the WebGL2 backend (#823) — same module, split per stage (GLSL is
 *  single-main-per-unit; mirrors emitIconRetainedGlsl). The default storage lowering turns
 *  the feat (array<f32>) + tint (array<vec4f>) buffers into R32F data textures, matching
 *  WebGl2Device's storage-buffer emulation. Consumed by RetainedArrowDraper behind a live
 *  `rhi.backend === 'webgl2'` guard — the WebGPU boot never pays for this emit (#778 P6). */
export const emitArrowRetainedGlsl = (stage: 'vertex' | 'fragment'): string => {
  const m = buildArrowRetainedModule()
  const keep = stage === 'vertex' ? 'vs_arrow_retained' : 'fs_arrow_retained'
  return emitGlslModule(
    { ...m, funcs: m.funcs.filter((f) => stageOf(f) === undefined || f.name === keep) },
    stage,
  )
}

/** Both GLSL stages from ONE lowering (see emitGlslStages). The per-stage twin above
 *  prunes the module before each emit, so it lowers + runs the optimizer fixpoint twice;
 *  naming the entries instead shares it. Byte-identical to two calls of the per-stage
 *  form — pinned by map/src/render/material/glsl-stage-entry-parity.test.ts. */
export const emitArrowRetainedGlslStages = (): { vertex: string; fragment: string } =>
  emitGlslStages(buildArrowRetainedModule(), {
    vertexEntry: 'vs_arrow_retained',
    fragmentEntry: 'fs_arrow_retained',
  })
