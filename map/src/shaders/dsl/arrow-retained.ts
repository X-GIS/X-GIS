// ═══ Shader DSL — retained geo-anchored ARROW shader (movement vector field) ═══
//
// The GPU half of the host DRAWING API's retained ARROW batch — the sibling of
// dsl/icon-retained.ts. It PROJECTS the geo anchor ON THE GPU (a camera move rewrites
// only the ~160 B pointU frame uniform; the per-instance buffer is packed once), reusing
// icon-retained's geo→clip ladder VERBATIM (the same injected getGpuProjectionFuncs() +
// the same `pointU` frame uniform + the same per-copy world_offset in circle_params.x).
//
// The ONLY differences from the icon shader:
//   • the procedural mesh is a 9-vertex ARROW (shaft quad 6 + head triangle 3) built from
//     vertex_index, tail at the geo anchor, pointing +x before the per-instance rotation —
//     instead of a 6-vertex textured quad;
//   • the fragment is a SOLID per-instance tint (no atlas sample) — the silhouette is the
//     mesh, so a vector field of oriented arrows stays crisp at any zoom/scale.

import {
  fn,
  module,
  transformMat4,
  f32,
  u32,
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

const ArrowOut = ioStruct('ArrowRetainedOut', {
  position: builtin('position', vec4fT),
  tint: location(0, vec4fT),
  // +1 for flat projections; the globe eye-horizon sign for ECEF. FS discards < 0.
  cos_c: location(1, f32T, 'flat'),
})

// Unit arrow silhouette (tail at origin, tip at +x = 1). Shaft spans x∈[0, HB], the head
// triangle x∈[HB, 1]. Half-widths in the same unit-length metric.
const SH = 0.09 // shaft half-width
const HH = 0.24 // head half-width
const HB = 0.6 // head base x (shaft→head junction)

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

    // ── procedural arrow corner from vertex_index (tail at origin, tip at +x). ──
    // Shaft quad: 0,1,2 / 3,4,5. Head triangle: 6,7,8. ay = across (screen +y down).
    const ax = f32(0)
    const ay = f32(0)
    Switch(p.vi)
      .case(0, () => {
        ax.assign(f32(0))
        ay.assign(f32(-SH))
      })
      .case(1, () => {
        ax.assign(f32(0))
        ay.assign(f32(SH))
      })
      .case(2, () => {
        ax.assign(f32(HB))
        ay.assign(f32(SH))
      })
      .case(3, () => {
        ax.assign(f32(0))
        ay.assign(f32(-SH))
      })
      .case(4, () => {
        ax.assign(f32(HB))
        ay.assign(f32(SH))
      })
      .case(5, () => {
        ax.assign(f32(HB))
        ay.assign(f32(-SH))
      })
      .case(6, () => {
        ax.assign(f32(HB))
        ay.assign(f32(-HH))
      })
      .case(7, () => {
        ax.assign(f32(1))
        ay.assign(f32(0))
      })
      .case(8, () => {
        ax.assign(f32(HB))
        ay.assign(f32(HH))
      })
      .default(() => {
        /* vi ∈ 0..8 */
      })

    // Scale by the per-instance length (px), rotate around the tail (the geo anchor) by
    // the screen-space rotation (+y down clockwise — same convention as icon-retained).
    const size = rd(F.size)
    const lx = ax.mul(size)
    const ly = ay.mul(size)
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
    const out = pin.tint
    If(out.a.lt(f32(0.004)), () => {
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
 *  instanced geo-anchored arrow VS + solid-tint FS. */
export const emitArrowRetainedWgsl = (): string => emitModule(buildArrowRetainedModule())
