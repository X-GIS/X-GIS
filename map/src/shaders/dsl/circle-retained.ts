// ═══ Shader DSL — retained geo-anchored CIRCLE shader (disc primitive) ═══
//
// The GPU half of the host DRAWING API's retained CIRCLE batch — the sibling of
// dsl/arrow-retained.ts. It PROJECTS the geo anchor ON THE GPU (a camera move rewrites only the
// ~160 B pointU frame uniform; the per-instance buffer is packed once), reusing the SAME geo→clip
// ladder (`project_geo`) + `pointU` frame uniform + per-copy world_offset as icon/arrow.
//
// SILHOUETTE is an analytic disc SDF over a screen-space BOUNDING QUAD: the VS emits a 6-vertex
// square sized to the radius (+ AA margin) around the projected anchor and passes uv normalised so
// |uv| = 1 at the radius edge; the FS evaluates the EXACT fill + inset-stroke coverage the point
// renderer's fs_point uses (radius = fill edge, stroke inset by stroke_width, fwidth AA), so a
// retained circle is pixel-identical to a tile/inline point of the same style. Overlay pass: no
// depth (globe far-side handled by the shared cos_c cull), single-sample (fwidth AA).

import {
  fn,
  module,
  transformMat4,
  f32,
  u32,
  max,
  length,
  fwidth,
  smoothstep,
  mix,
  vec2,
  vec3,
  vec4,
  when,
  Switch,
  Discard,
  If,
  Let,
  f32T,
  u32T,
  vec2fT,
  vec3fT,
  vec4fT,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import { ioStruct, builtin, location, storageBuffer } from '@xgis/shader-dsl'
import { emitModule, emitGlslModule, stageOf } from '@xgis/shader-dsl'
import {
  flat_rel,
  needs_backface_cull,
  PROJECTION_CONSTS,
  getGpuProjectionFuncs,
} from './projections'
import { pointU } from './point'
import { CIRCLE_RETAINED_FEAT } from './circle-retained-feat-layout'

const STRIDE = u32(CIRCLE_RETAINED_FEAT.stride)
const F = CIRCLE_RETAINED_FEAT.slot

const featB = storageBuffer('feat_data', f32T, { group: 1, binding: 0, access: 'read' })
const tintB = storageBuffer('tint_data', vec4fT, { group: 1, binding: 1, access: 'read' })
const featData = featB.node

// geo → clip, reused VERBATIM from icon-retained/arrow-retained/point vs_point.
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

const CircleOut = ioStruct('CircleRetainedOut', {
  position: builtin('position', vec4fT),
  loc: location(0, vec2fT),
  fill: location(1, vec4fT, 'flat'),
  stroke: location(2, vec4fT, 'flat'),
  strokeW: location(3, f32T, 'flat'),
  cos_c: location(4, f32T, 'flat'),
})

const vs = fn(
  'vs_circle_retained',
  {
    inst: builtin('instance_index', u32T),
    vi: builtin('vertex_index', u32T),
  },
  (p) => {
    const rd = (slot: number) => featData.at(p.inst.mul(STRIDE).add(slot), f32T)

    const absLon = rd(F.abs_lon)
    const absLat = rd(F.abs_lat)
    const centerClip = project_geo({
      ecefH: vec3(rd(F.ecef_x_h), rd(F.ecef_y_h), rd(F.ecef_z_h)),
      ecefL: vec3(rd(F.ecef_x_l), rd(F.ecef_y_l), rd(F.ecef_z_l)),
      absLon,
      absLat,
      mxH: rd(F.merc_x_h),
      mxL: rd(F.merc_x_l),
      myH: rd(F.merc_y_h),
      myL: rd(F.merc_y_l),
    })

    const radius = rd(F.radius_px)
    const strokeWpx = rd(F.stroke_width_px)

    // ── bounding square (6 verts): qx, qy ∈ {-1, +1} corners. ──
    const qx = f32(0)
    const qy = f32(0)
    Switch(p.vi)
      .case(0, () => {
        qx.assign(f32(-1))
        qy.assign(f32(-1))
      })
      .case(1, () => {
        qx.assign(f32(-1))
        qy.assign(f32(1))
      })
      .case(2, () => {
        qx.assign(f32(1))
        qy.assign(f32(1))
      })
      .case(3, () => {
        qx.assign(f32(-1))
        qy.assign(f32(-1))
      })
      .case(4, () => {
        qx.assign(f32(1))
        qy.assign(f32(1))
      })
      .case(5, () => {
        qx.assign(f32(1))
        qy.assign(f32(-1))
      })
      .default(() => {
        /* vi ∈ 0..5 */
      })

    // Half-extent in px: radius + 2 px AA headroom. Stroke is INSET (inner = 1 − strokeW),
    // so the disc never extends past the radius; the +2 px only guards the fill/AA edge.
    const half = radius.add(f32(2))
    const offXpx = qx.mul(half)
    const offYpx = qy.mul(half)

    // px → NDC, perspective-correct (× clip.w). Screen +y down → NDC −y.
    const vp = pointU.field.viewport
    const offNdc = vec2(offXpx.mul(f32(2).div(vp.x)), offYpx.neg().mul(f32(2).div(vp.y)))
    const clip = centerClip.add(vec4(offNdc.mul(centerClip.w), 0, 0))

    const o = CircleOut.var()
    o.position.assign(clip)
    // uv normalised so |uv| = 1 at the radius edge — the point-renderer convention.
    o.loc.assign(vec2(offXpx, offYpx).div(max(radius, f32(1))))
    o.fill.assign(tintB.node.at(p.inst, vec4fT))
    o.stroke.assign(vec4(rd(F.stroke_r), rd(F.stroke_g), rd(F.stroke_b), rd(F.stroke_a)))
    o.strokeW.assign(strokeWpx.div(max(radius, f32(1))))
    o.cos_c.assign(
      needs_backface_cull(absLon, absLat, pointU.field.proj_params, pointU.field.globe_eye),
    )
    return o.$
  },
  { stage: 'vertex' },
)

const fs = fn(
  'fs_circle_retained',
  { in: CircleOut },
  (p) => {
    const pin = p.in
    If(pin.cos_c.lt(0), () => {
      Discard()
    })
    const dist = length(pin.loc)
    // fwidth is a derivative — MUST be a Let in uniform control flow (mirrors fs_point).
    const aa = Let(fwidth(length(pin.loc)).mul(1.5))
    // Fill: disc coverage — 1 inside the radius, smooth AA band at the edge (dist = 1).
    const fillAlpha = Let(f32(1).sub(smoothstep(f32(1).sub(aa), f32(1).add(aa), dist)))
    const filled = vec4(pin.fill.swizzle('xyz'), pin.fill.w.mul(fillAlpha))
    // Stroke: an inset ring [1 − strokeW, 1] in uv (exactly fs_point's inset stroke).
    const inner = f32(1).sub(pin.strokeW)
    const strokeAlpha = Let(
      smoothstep(inner.sub(aa), inner.add(aa), dist).mul(
        f32(1).sub(smoothstep(f32(1).sub(aa), f32(1).add(aa), dist)),
      ),
    )
    const out = mix(filled, vec4(pin.stroke.swizzle('xyz'), pin.stroke.w), strokeAlpha)
    If(out.w.lt(f32(0.004)), () => {
      Discard()
    })
    return out
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

export const buildCircleRetainedModule = (): ModuleDecl =>
  module({
    consts: [...PROJECTION_CONSTS],
    structs: [pointU.struct, CircleOut.decl],
    bindings: [pointU.binding, featB.binding, tintB.binding],
    funcs: [...getGpuProjectionFuncs(), project_geo, vs, fs],
  })

/** Full retained-circle shader: shared projection consts + injected projection fns + the disc
 *  bounding-quad VS + analytic disc-SDF (fill + inset stroke, fwidth AA) FS. */
export const emitCircleRetainedWgsl = (): string => emitModule(buildCircleRetainedModule())

/** GLSL ES 3.00 twin for the WebGL2 backend (#823) — same module, split per stage. `emulateStorage`
 *  lowers the feat (array<f32>) + tint (array<vec4f>) storage buffers to R32F data textures,
 *  matching WebGl2Device's storage-buffer emulation. Consumed by RetainedCircleDraper behind a live
 *  `rhi.backend === 'webgl2'` guard — the WebGPU boot never pays for this emit (#778 P6). */
export const emitCircleRetainedGlsl = (stage: 'vertex' | 'fragment'): string => {
  const m = buildCircleRetainedModule()
  const keep = stage === 'vertex' ? 'vs_circle_retained' : 'fs_circle_retained'
  return emitGlslModule(
    { ...m, funcs: m.funcs.filter((f) => stageOf(f) === undefined || f.name === keep) },
    stage,
    { emulateStorage: true },
  )
}
