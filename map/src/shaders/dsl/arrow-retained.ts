// ═══ Shader DSL — retained geo-anchored ARROW shader (movement vector field) ═══
//
// The GPU half of the host DRAWING API's retained ARROW batch — the sibling of
// dsl/icon-retained.ts. It PROJECTS the geo anchor ON THE GPU (a camera move rewrites
// only the ~160 B pointU frame uniform; the per-instance buffer is packed once), reusing
// icon-retained's geo→clip ladder VERBATIM (the same injected getGpuProjectionFuncs() +
// the same `pointU` frame uniform + the same per-copy world_offset in circle_params.x).
//
// The arrow silhouette is an analytic SDF over a BOUNDING QUAD (#824): the vertex emits a
// 6-vertex quad sized (length × width) around the arrow, and the fragment evaluates a
// tapered-half-width arrow profile with fwidth-based coverage — resolution-independent,
// crisp AA at the graphics pass's single-sample (no MSAA needed). The fill is a solid
// per-instance tint.

import {
  fn,
  module,
  transformMat4,
  f32,
  u32,
  abs,
  max,
  clamp,
  select,
  fwidth,
  vec2,
  vec3,
  vec4,
  cos,
  sin,
  when,
  Switch,
  Discard,
  If,
  f32T,
  u32T,
  vec2fT,
  vec4fT,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import { ioStruct, builtin, location, storageBuffer } from '@xgis/shader-dsl'
import { emitModule } from '@xgis/shader-dsl'
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

// Unit arrow profile (tail at origin, tip at +x = 1; coords in units of LENGTH). The shaft
// spans x∈[0,HB] at half-width SH; the head x∈[HB,1] tapers linearly from HH to 0 at the tip.
// HH is also the bounding quad's half-height (the quad's local y ∈ [-HH, +HH]).
const SH = 0.09 // shaft half-width
const HH = 0.26 // head half-width = quad half-height
const HB = 0.6 // head base x (shaft→head junction)
const HEAD_SLOPE = HH / (1 - HB) // half-width per unit x along the head taper

const ArrowOut = ioStruct('ArrowRetainedOut', {
  position: builtin('position', vec4fT),
  // Arrow-local coordinate (x∈[0,1] along, y∈[-HH,HH] across) for the fragment SDF.
  loc: location(0, vec2fT),
  tint: location(1, vec4fT),
  // +1 for flat projections; the globe eye-horizon sign for ECEF. FS discards < 0.
  cos_c: location(2, f32T, 'flat'),
})

const vs = fn(
  'vs_arrow_retained',
  {
    inst: builtin('instance_index', u32T),
    vi: builtin('vertex_index', u32T),
  },
  (p) => {
    const rd = (slot: number) => featData.at(p.inst.mul(STRIDE).add(slot), f32T)

    // ── geo → clip, reused VERBATIM from icon-retained/point vs_point. ──
    const ecefH = vec3(rd(F.ecef_x_h), rd(F.ecef_y_h), rd(F.ecef_z_h))
    const ecefL = vec3(rd(F.ecef_x_l), rd(F.ecef_y_l), rd(F.ecef_z_l))
    const absLon = rd(F.abs_lon)
    const absLat = rd(F.abs_lat)
    const camH = pointU.field.cam_ecef_h.swizzle('xyz')
    const camL = pointU.field.cam_ecef_l.swizzle('xyz')
    const ecefRtc = ecefH.sub(camH).add(ecefL.sub(camL))
    const mvp = pointU.field.mvp
    const worldOffset = pointU.field.circle_params.x

    const centerClip = when(
      [
        [
          pointU.field.proj_params.x.lt(0.5),
          () => {
            const mxH = rd(F.merc_x_h)
            const mxL = rd(F.merc_x_l)
            const myH = rd(F.merc_y_h)
            const myL = rd(F.merc_y_l)
            const camMercH = pointU.field.cam_ecef_h.swizzle('xy')
            const camMercL = pointU.field.cam_ecef_l.swizzle('xy')
            const relX = mxH.sub(camMercH.x).add(mxL.sub(camMercL.x)).add(worldOffset)
            const relY = myH.sub(camMercH.y).add(myL.sub(camMercL.y))
            return transformMat4(mvp, vec4(relX, relY, 0, 1))
          },
        ],
        [
          pointU.field.proj_params.x.lt(6.5),
          () => {
            const relG = flat_rel(absLon, absLat, pointU.field.proj_params, absLon)
            return transformMat4(mvp, vec4(relG.x, relG.y, 0, 1))
          },
        ],
      ],
      () => transformMat4(mvp, vec4(ecefRtc, 1)),
    )

    // ── bounding quad (6 verts) in unit-arrow space: qx∈{0,1} along, qy∈{-HH,HH} across. ──
    const qx = f32(0)
    const qy = f32(0)
    Switch(p.vi)
      .case(0, () => {
        qx.assign(f32(0))
        qy.assign(f32(-HH))
      })
      .case(1, () => {
        qx.assign(f32(0))
        qy.assign(f32(HH))
      })
      .case(2, () => {
        qx.assign(f32(1))
        qy.assign(f32(HH))
      })
      .case(3, () => {
        qx.assign(f32(0))
        qy.assign(f32(-HH))
      })
      .case(4, () => {
        qx.assign(f32(1))
        qy.assign(f32(HH))
      })
      .case(5, () => {
        qx.assign(f32(1))
        qy.assign(f32(-HH))
      })
      .default(() => {
        /* vi ∈ 0..5 */
      })

    // Scale by the per-instance length (px), rotate around the tail (the geo anchor) by the
    // screen-space rotation (+y down clockwise — same convention as icon-retained).
    const size = rd(F.size)
    const lx = qx.mul(size)
    const ly = qy.mul(size)
    const rot = rd(F.rot_rad)
    const cc = cos(rot)
    const ss = sin(rot)
    const rx = lx.mul(cc).sub(ly.mul(ss))
    const ry = lx.mul(ss).add(ly.mul(cc))

    // px → NDC, perspective-correct (× clip.w). y flips: screen +y down → NDC -y.
    const vp = pointU.field.viewport
    const offNdc = vec2(rx.mul(f32(2).div(vp.x)), ry.neg().mul(f32(2).div(vp.y)))
    const clip = centerClip.add(vec4(offNdc.mul(centerClip.w), 0, 0))

    const o = ArrowOut.var()
    o.position.assign(clip)
    o.loc.assign(vec2(qx, qy))
    o.tint.assign(tintB.node.at(p.inst, vec4fT))
    o.cos_c.assign(
      needs_backface_cull(absLon, absLat, pointU.field.proj_params, pointU.field.globe_eye),
    )
    return o.$
  },
  { stage: 'vertex' },
)

const fs = fn(
  'fs_arrow_retained',
  { in: ArrowOut },
  (p) => {
    const pin = p.in
    // Globe far-side cull (no-op on flat: cos_c = +1).
    If(pin.cos_c.lt(0), () => {
      Discard()
    })
    // Arrow profile: half-width is SH along the shaft, then a linear taper to 0 at the tip.
    const ax = pin.loc.x
    const ay = abs(pin.loc.y)
    const hwHead = max(f32(1).sub(ax), 0).mul(HEAD_SLOPE)
    const hw = select(ax.lt(HB), f32(SH), hwHead)
    // Outside-distance in unit space: width edge, tail base (x≥0), tip (x≤1).
    const d = max(ay.sub(hw), max(ax.neg(), ax.sub(1)))
    // fwidth gives the on-screen pixel size in unit space → resolution-independent AA.
    const aa = fwidth(pin.loc.x).add(fwidth(pin.loc.y)).mul(0.7).add(f32(1e-5))
    const cov = clamp(f32(0.5).sub(d.div(aa)), 0, 1)
    const out = vec4(pin.tint.swizzle('xyz'), pin.tint.w.mul(cov))
    If(out.w.lt(f32(0.004)), () => {
      Discard()
    })
    return out
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

/** A build-fn (not a top-level const) so the injection-deferred getGpuProjectionFuncs()
 *  is gathered at emit time, post-configureProjections() — same as buildIconRetainedModule. */
export const buildArrowRetainedModule = (): ModuleDecl =>
  module({
    consts: [...PROJECTION_CONSTS],
    structs: [pointU.struct, ArrowOut.decl],
    bindings: [pointU.binding, featB.binding, tintB.binding],
    funcs: [...getGpuProjectionFuncs(), vs, fs],
  })

/** Full retained-arrow shader: shared projection consts + injected projection fns + the
 *  instanced geo-anchored arrow quad VS + analytic-SDF anti-aliased solid-tint FS. */
export const emitArrowRetainedWgsl = (): string => emitModule(buildArrowRetainedModule())
