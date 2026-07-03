// ═══ Shader DSL — retained geo-anchored ICON shader (#797 Phase 1) ═══
//
// The GPU half of the host DRAWING API's retained icon batch. Unlike the
// screen-px icon shader (dsl/icon.ts, which the label pass feeds CPU-projected
// screen pixels every frame), this shader PROJECTS the geo anchor ON THE GPU, so
// a camera move rewrites only the ~160 B frame uniform — the per-instance buffer
// is packed ONCE at add()/update() and never touched per frame (N-independent).
//
// It is a COMPOSITION of three proven shaders, not a new renderer:
//   • dsl/point.ts vs_point — the geo→clip ladder (flat-Merc DSFUN / flat-non-
//     Mercator flat_rel / ECEF-globe) reused VERBATIM in spirit, via the SAME
//     injected getGpuProjectionFuncs() + the SAME `pointU` frame uniform. The
//     only projection add is `+ world_offset` on the flat-Mercator relX (the
//     per-copy fan-out done as an O(COPIES) uniform, never an O(N) repack).
//   • dsl/line.ts vs_line — the instanced procedural quad (instance_index picks
//     the per-instance record, vertex_index picks the corner; draw(6, N), no
//     vertex/index buffers).
//   • dsl/icon.ts fs — the atlas textureSample, here MODULATED by a per-instance
//     tint rgba (default white = identity) so getColor tints RASTER host icons
//     too (the deck.gl getColor convention; the screen-px fs leaves raster
//     untinted per the Mapbox icon-color spec — a deliberate divergence).
//
// world_offset rides `pointU.circle_params.x` (dead for icons — the point path
// uses it for circle-translate), so `writePointFrameUniform` is reused verbatim
// and the caller pokes only that one slot per world copy.

import {
  fn,
  module,
  transformMat4,
  f32,
  u32,
  toU32,
  vec2,
  vec3,
  vec4,
  cos,
  sin,
  mix,
  textureSample,
  when,
  Switch,
  Discard,
  If,
  f32T,
  u32T,
  vec2fT,
  vec4fT,
  texture2dfT,
  samplerT,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import { ioStruct, builtin, location, storageBuffer, resource } from '@xgis/shader-dsl'
import { emitModule } from '@xgis/shader-dsl'
import {
  flat_rel,
  needs_backface_cull,
  PROJECTION_CONSTS,
  getGpuProjectionFuncs,
} from './projections'
import { pointU } from './point'
import { ICON_RETAINED_FEAT } from './icon-retained-feat-layout'

const STRIDE = u32(ICON_RETAINED_FEAT.stride)
const F = ICON_RETAINED_FEAT.slot

// Per-instance geometry record (position DSFUN + quad geometry) and the SEPARATE
// tint buffer (rgba, its own binding so a recolor re-uploads only it).
const featB = storageBuffer('feat_data', f32T, { group: 1, binding: 0, access: 'read' })
const tintB = storageBuffer('tint_data', vec4fT, { group: 1, binding: 1, access: 'read' })
const atlasTex = resource('atlas_tex', texture2dfT, { group: 1, binding: 2 })
const atlasSmp = resource('atlas_smp', samplerT, { group: 1, binding: 3 })
const featData = featB.node

const IconOut = ioStruct('IconRetainedOut', {
  position: builtin('position', vec4fT),
  uv: location(0, vec2fT),
  tint: location(1, vec4fT),
  // +1 for flat projections; the globe eye-horizon sign for ECEF. FS discards <0.
  cos_c: location(2, f32T, 'flat'),
})

const vs = fn(
  'vs_icon_retained',
  {
    inst: builtin('instance_index', u32T),
    vi: builtin('vertex_index', u32T),
  },
  (p) => {
    // Per-instance slot read (rebuilds the index each call, like point.ts — no
    // shared node aliasing).
    const rd = (slot: number) => featData.at(p.inst.mul(STRIDE).add(slot), f32T)

    // ── geo → clip, mirroring point.ts vs_point (slots have icon-local offsets
    // but identical SEMANTICS, so the same injected projection fns apply). ──
    const ecefH = vec3(rd(F.ecef_x_h), rd(F.ecef_y_h), rd(F.ecef_z_h))
    const ecefL = vec3(rd(F.ecef_x_l), rd(F.ecef_y_l), rd(F.ecef_z_l))
    const absLon = rd(F.abs_lon)
    const absLat = rd(F.abs_lat)
    const camH = pointU.field.cam_ecef_h.swizzle('xyz')
    const camL = pointU.field.cam_ecef_l.swizzle('xyz')
    const ecefRtc = ecefH.sub(camH).add(ecefL.sub(camL))
    const mvp = pointU.field.mvp
    // #797 P1 — world-copy fan-out as an O(COPIES) uniform, NOT a per-frame O(N)
    // repack. circle_params.x is dead for icons (circle-translate on points), so
    // the caller pokes the per-copy Mercator offset here and writePointFrameUniform
    // stays verbatim. Only flat Mercator wraps; flat-non-Merc + ECEF collapse to
    // copy [0] (offset 0), matching the point path.
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
            // FLAT non-Mercator (1-6): reproject the marker's own lon/lat via the
            // shared flat_rel (ref_lon = self so it lands in its nearest copy).
            const relG = flat_rel(absLon, absLat, pointU.field.proj_params, absLon)
            return transformMat4(mvp, vec4(relG.x, relG.y, 0, 1))
          },
        ],
      ],
      () => transformMat4(mvp, vec4(ecefRtc, 1)),
    )

    // ── instanced quad corner from vertex_index (6 verts = 2 tris), mirroring
    // line.ts vs_line. c* is the centred corner in [-0.5,+0.5] (screen +y DOWN,
    // so -0.5 = TOP); u* is the UV-rect corner in {0,1}. ──
    const cx = f32(0)
    const cy = f32(0)
    const ux = f32(0)
    const uy = f32(0)
    Switch(p.vi)
      .case(0, () => {
        cx.assign(f32(-0.5))
        cy.assign(f32(-0.5))
        ux.assign(f32(0))
        uy.assign(f32(0))
      })
      .case(1, () => {
        cx.assign(f32(-0.5))
        cy.assign(f32(0.5))
        ux.assign(f32(0))
        uy.assign(f32(1))
      })
      .case(2, () => {
        cx.assign(f32(0.5))
        cy.assign(f32(0.5))
        ux.assign(f32(1))
        uy.assign(f32(1))
      })
      .case(3, () => {
        cx.assign(f32(-0.5))
        cy.assign(f32(-0.5))
        ux.assign(f32(0))
        uy.assign(f32(0))
      })
      .case(4, () => {
        cx.assign(f32(0.5))
        cy.assign(f32(0.5))
        ux.assign(f32(1))
        uy.assign(f32(1))
      })
      .case(5, () => {
        cx.assign(f32(0.5))
        cy.assign(f32(-0.5))
        ux.assign(f32(1))
        uy.assign(f32(0))
      })
      .default(() => {
        /* default: empty (vi ∈ 0..5) */
      })

    const sizeW = rd(F.size_w)
    const sizeH = rd(F.size_h)

    // Anchor: the CENTRE's screen-px offset from the geo anchor point (screen +y
    // DOWN). center → (0,0); the quad rotates around its own centre, so the anchor
    // offset is applied AFTER rotation (mirrors icon-renderer.ts rotate-around-centre).
    const anchor = toU32(rd(F.anchor_mode))
    const acx = f32(0)
    const acy = f32(0)
    Switch(anchor)
      .case(1, () => {
        acy.assign(sizeH.mul(0.5))
      }) // top → centre is h/2 below
      .case(2, () => {
        acy.assign(sizeH.mul(-0.5))
      }) // bottom
      .case(3, () => {
        acx.assign(sizeW.mul(0.5))
      }) // left
      .case(4, () => {
        acx.assign(sizeW.mul(-0.5))
      }) // right
      .case(5, () => {
        acx.assign(sizeW.mul(0.5))
        acy.assign(sizeH.mul(0.5))
      }) // top-left
      .case(6, () => {
        acx.assign(sizeW.mul(-0.5))
        acy.assign(sizeH.mul(0.5))
      }) // top-right
      .case(7, () => {
        acx.assign(sizeW.mul(0.5))
        acy.assign(sizeH.mul(-0.5))
      }) // bottom-left
      .case(8, () => {
        acx.assign(sizeW.mul(-0.5))
        acy.assign(sizeH.mul(-0.5))
      }) // bottom-right
      .default(() => {
        /* default: 0 center → (0,0) */
      })

    // Local px corner: rotate the size-scaled corner around the quad centre
    // (screen-space, +y down clockwise — same convention as icon-renderer.ts:282),
    // then add the unrotated anchor centre offset.
    const lx = cx.mul(sizeW)
    const ly = cy.mul(sizeH)
    const rot = rd(F.rot_rad)
    const cc = cos(rot)
    const ss = sin(rot)
    const rx = lx.mul(cc).sub(ly.mul(ss)).add(acx)
    const ry = lx.mul(ss).add(ly.mul(cc)).add(acy)

    // px → NDC, perspective-correct (× clip.w). y flips: screen +y down → NDC -y.
    const vp = pointU.field.viewport
    const offNdc = vec2(rx.mul(f32(2).div(vp.x)), ry.neg().mul(f32(2).div(vp.y)))
    const clip = centerClip.add(vec4(offNdc.mul(centerClip.w), 0, 0))

    const o = IconOut.var()
    o.position.assign(clip)
    o.uv.assign(vec2(mix(rd(F.u0), rd(F.u1), ux), mix(rd(F.v0), rd(F.v1), uy)))
    o.tint.assign(tintB.node.at(p.inst, vec4fT))
    // Globe eye-horizon cull (flat projections return +1). Reuses the SAME
    // injected fn point.ts uses, so far-side globe icons are culled identically.
    o.cos_c.assign(
      needs_backface_cull(absLon, absLat, pointU.field.proj_params, pointU.field.globe_eye),
    )
    return o.$
  },
  { stage: 'vertex' },
)

const fs = fn(
  'fs_icon_retained',
  { in: IconOut },
  (p) => {
    const pin = p.in
    // Globe far-side cull (no-op on flat: cos_c = +1).
    If(pin.cos_c.lt(0), () => {
      Discard()
    })
    // Straight atlas sample MODULATED by the per-instance tint (default white =
    // identity → raster icon byte-unchanged; tint.a fades the whole sprite).
    const c = textureSample(atlasTex.node, atlasSmp.node, pin.uv)
    const t = pin.tint
    const out = vec4(c.rgb.mul(t.rgb), c.a.mul(t.a))
    // Drop fully-transparent fragments (below 8-bit alpha) so they don't write
    // the blend/needlessly cost — mirrors point.ts's a<0.005 discard.
    If(out.a.lt(f32(0.004)), () => {
      Discard()
    })
    return out
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

/** A build-fn (not a top-level const) so the injection-deferred
 *  getGpuProjectionFuncs() is gathered at emit time, post-configureProjections()
 *  — same reason buildPointModule / buildLineModule are fns. */
export const buildIconRetainedModule = (): ModuleDecl =>
  module({
    consts: [...PROJECTION_CONSTS],
    structs: [pointU.struct, IconOut.decl],
    bindings: [pointU.binding, featB.binding, tintB.binding, atlasTex.binding, atlasSmp.binding],
    funcs: [
      // Injection seam ONLY (#740 R1): the projection fns are extern-called, so
      // module() cannot auto-collect them. flat_rel / needs_backface_cull are
      // reached through these.
      ...getGpuProjectionFuncs(),
      vs,
      fs,
    ],
  })

/** Full retained-icon shader: one module — shared projection consts + injected
 *  projection fns + the instanced geo-anchored quad VS + atlas-tint FS. */
export const emitIconRetainedWgsl = (): string => emitModule(buildIconRetainedModule())
