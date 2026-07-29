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
  min,
  clamp,
  select,
  step,
  fwidth,
  length,
  ceil,
  log2,
  exp2,
  floor,
  fract,
  mix,
  vec2,
  vec2i,
  vec3,
  vec4,
  toF32,
  toI32,
  toU32,
  textureLoad,
  textureDimensions,
  when,
  Let,
  Var,
  Switch,
  Discard,
  If,
  f32T,
  u32T,
  vec2fT,
  vec3fT,
  vec4fT,
  texture2dfT,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import { ioStruct, builtin, location, storageBuffer, resource } from '@xgis/shader-dsl'
import { emitModule, emitGlslModule, emitGlslStages, stageOf } from '@xgis/shader-dsl'
import { ARROW_DRIFT_UV, decodeArrowPos } from './arrow-advect-step'
import {
  S111_BAND_COUNT,
  S111_BAND_PARAMS_ROW,
  S111_BAND_STRIDE,
  S111_PARAM_STATE_BASE,
  S111_PARAM_UV_ASPECT,
  S111_PARAM_STEPS_U,
  S111_PARAM_STEPS_V,
} from './s111-band-table-layout'
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

const ArrowOut = ioStruct('ArrowRetainedOut', {
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

    // ── bounding quad (6 verts) in unit-arrow space: qx∈{-margin,1+margin} along,
    // qy∈{-(HH+margin),HH+margin} across. `margin` is the per-instance outline stroke width
    // (0 for every arrow that doesn't opt in — the quad is then IDENTICAL to the un-outlined
    // bounds, {0,1}×{-HH,HH}, so an existing caller's rasterized area is byte-for-byte
    // unchanged). A non-zero margin gives the FS room to shade the stroke band past the fill
    // silhouette (a pixel outside the un-enlarged quad is never shaded at all — no fragment
    // invocation happens there — so the stroke would clip off without this). ──
    const margin = rd(F.stroke_units)
    const qx = f32(0)
    const qy = f32(0)
    Switch(p.vi)
      .case(0, () => {
        qx.assign(f32(0).sub(margin))
        qy.assign(f32(-HH).sub(margin))
      })
      .case(1, () => {
        qx.assign(f32(0).sub(margin))
        qy.assign(f32(HH).add(margin))
      })
      .case(2, () => {
        qx.assign(f32(1).add(margin))
        qy.assign(f32(HH).add(margin))
      })
      .case(3, () => {
        qx.assign(f32(0).sub(margin))
        qy.assign(f32(-HH).sub(margin))
      })
      .case(4, () => {
        qx.assign(f32(1).add(margin))
        qy.assign(f32(HH).add(margin))
      })
      .case(5, () => {
        qx.assign(f32(1).add(margin))
        qy.assign(f32(-HH).sub(margin))
      })
      .default(() => {
        /* vi ∈ 0..5 */
      })

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

const fs = fn(
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
    const covFill = clamp(f32(0.5).sub(d.div(aa)), 0, 1)
    const covTotal = clamp(f32(0.5).sub(d.sub(su).div(aa)), 0, 1)
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

// ═══ ADVECTED variant (#1419) — the catalogue glyph IS the particle ═══════════════════════
//
// A SECOND MODULE, not a second entry in the one above and not a runtime flag. `module()`
// declares bindings at MODULE level, so adding the state/velocity/band-table resources to the
// static module would change the static shader's emitted text even though its VS body is
// untouched — and "the `| arrow` path is byte-identical" would stop being assertable, which is
// the property that makes this split worth having. The function OBJECTS (`project_geo`, `fs`,
// `ArrowOut`, the projection ladder) are shared, so there is still exactly one definition of
// each; only the module assembly differs.
//
// What the advected VS does that the static one does not:
//   • reads WHERE this arrow is now (state_tex) and where it belongs (origin_tex), texel
//     `instance_index` in both — the 1:1 contract arrow-advect-state.ts owns;
//   • turns that displacement into a screen offset with TWO projected bases (the tip block is
//     the grid-u anchor, the north block the grid-v one) rather than one — a single basis moves
//     an arrow along a straight line, the closed-form drift #65 shipped and #70 reverted;
//   • re-symbolizes from the field UNDER ITS CURRENT POSITION: bearing from (u, v), and colour
//     + scale from the band table. An arrow that moves while keeping its launch colour is the
//     failure that still looks like a working animation, so the colour is NOT taken from the
//     tint buffer here — the advected module does not even bind one.
const bandB = storageBuffer('band_data', f32T, { group: 1, binding: 1, access: 'read' })
const stateTex = resource('state_tex', texture2dfT, { group: 1, binding: 2 })
const originTex = resource('origin_tex', texture2dfT, { group: 1, binding: 3 })
const flowUTex = resource('flow_u_tex', texture2dfT, { group: 1, binding: 4 })
const flowVTex = resource('flow_v_tex', texture2dfT, { group: 1, binding: 5 })

/** Fetch the cell OWNING a grid-uv position, with no sampler. A vertex stage cannot call
 *  `textureSample` (no implicit derivatives), and the velocity field wants a point fetch anyway:
 *  it is per-cell data whose band edges are the catalogue's own granularity, so a cell's value
 *  governs its whole footprint and blending two of them would invent a current between them —
 *  the one that reads a shore cell's neighbour as half a current. It also keeps every
 *  vertex-visible binding sampler-free, so the WebGL2 sampler-follows-its-texture ordering rule
 *  has nothing to trip over.
 *
 *  OWNER, not `floor(uv · n)`. Origins are written in the convention `u = col / (n − 1)`, so the
 *  texel containing a position is `round(u · (n − 1))` — nearest under point registration. The
 *  old form skewed by `u`, up to a whole cell: harmless at one arrow per cell, where the skew
 *  never reached 1 and the answer came out right by luck, and wrong for a sub-cell node (#1511),
 *  which reads a NEIGHBOUR's velocity. That neighbour is often land, whose packed `(0, 0)`
 *  collapses the size product — so the symptom is a hole in valid water, not a wrong colour.
 *
 *  It also fixes the last column and row, where the skew reached exactly `n` — out of range, so
 *  those arrows fetched zeros and were never drawn at all in advected mode.
 *
 *  `floor(x + 0.5)`, not `round`: WGSL rounds halves to even and GLSL's tie is
 *  implementation-defined, so a node landing exactly on a footprint boundary could resolve to
 *  different cells on the two backends — a parity bug that only shows on one of them. */
const loadAtUv = (tex: Parameters<typeof textureDimensions>[0], uv: ReturnType<typeof vec2>) => {
  const d = textureDimensions(tex)
  const owner = (t: ReturnType<typeof f32>, n: ReturnType<typeof toF32>) =>
    toI32(clamp(floor(t.mul(n.sub(1)).add(0.5)), f32(0), n.sub(1)))
  const c = vec2i(owner(uv.x, toF32(d.x)), owner(uv.y, toF32(d.y)))
  return textureLoad(tex, c, u32(0))
}

/** Read band row `b`'s slot from the uploaded catalogue table (s111-portrayal.ts). */
const bandAt = (row: ReturnType<typeof u32>, slot: number) =>
  bandB.node.at(row.mul(u32(S111_BAND_STRIDE)).add(slot), f32T)

const vsAdvected = fn(
  'vs_arrow_retained_advected',
  {
    inst: builtin('instance_index', u32T),
    vi: builtin('vertex_index', u32T),
  },
  (p) => {
    const rd = (slot: number) => featData.at(p.inst.mul(STRIDE).add(slot), f32T)

    const absLon = rd(F.abs_lon)
    const absLat = rd(F.abs_lat)
    // `Let`, not a bare expression: the origin's clip position is read three times (the two
    // bases and the final position), and the emitter does not CSE a function CALL — without
    // this the whole projection ladder runs three times per vertex.
    const originClip = Let(
      project_geo({
        ecefH: vec3(rd(F.ecef_x_h), rd(F.ecef_y_h), rd(F.ecef_z_h)),
        ecefL: vec3(rd(F.ecef_x_l), rd(F.ecef_y_l), rd(F.ecef_z_l)),
        absLon,
        absLat,
        mxH: rd(F.merc_x_h),
        mxL: rd(F.merc_x_l),
        myH: rd(F.merc_y_h),
        myL: rd(F.merc_y_l),
      }),
    )
    // The TIP block is the grid-u anchor here (arrow-retained-feat-layout.ts) — one leash
    // length east along the grid, not a baked bearing.
    const uStepClip = project_geo({
      ecefH: vec3(rd(F.tip_ecef_x_h), rd(F.tip_ecef_y_h), rd(F.tip_ecef_z_h)),
      ecefL: vec3(rd(F.tip_ecef_x_l), rd(F.tip_ecef_y_l), rd(F.tip_ecef_z_l)),
      absLon: rd(F.tip_abs_lon),
      absLat: rd(F.tip_abs_lat),
      mxH: rd(F.tip_merc_x_h),
      mxL: rd(F.tip_merc_x_l),
      myH: rd(F.tip_merc_y_h),
      myL: rd(F.tip_merc_y_l),
    })
    const vStepClip = project_geo({
      ecefH: vec3(rd(F.north_ecef_x_h), rd(F.north_ecef_y_h), rd(F.north_ecef_z_h)),
      ecefL: vec3(rd(F.north_ecef_x_l), rd(F.north_ecef_y_l), rd(F.north_ecef_z_l)),
      absLon: rd(F.north_abs_lon),
      absLat: rd(F.north_abs_lat),
      mxH: rd(F.north_merc_x_h),
      mxL: rd(F.north_merc_x_l),
      myH: rd(F.north_merc_y_h),
      myL: rd(F.north_merc_y_l),
    })

    // Clip → SCREEN px delta. Unlike the static VS — which needs only a DIRECTION, so its ×2
    // NDC→px factor cancels — these are magnitudes the offset is built from, so the factor is
    // spelled out: px = ndc · viewport / 2, with +y flipped (screen +y is down).
    const vp = pointU.field.viewport
    const ndcO = Let(originClip.swizzle('xy').div(originClip.w))
    const pxDelta = (clip: ReturnType<typeof project_geo>) => {
      const n = clip.swizzle('xy').div(clip.w)
      return vec2(n.x.sub(ndcO.x).mul(vp.x).mul(0.5), n.y.sub(ndcO.y).neg().mul(vp.y).mul(0.5))
    }
    const basisU = pxDelta(uStepClip)
    const basisV = pxDelta(vStepClip)

    // Where this arrow is, and where it belongs — texel `base + instance_index` in both.
    //
    // The BASE is what makes a MOSAIC work (#1458). One state texture serves every resident
    // region and each owns a contiguous range, so a batch's instance 0 is not texel 0. It was,
    // once: every region indexed from 0, the last one armed owned every texel, and its siblings'
    // arrows were leashed to origin cells belonging to another NOAA domain — reported as the
    // field breaking up as soon as a second HDF5 came on screen.
    const dim = textureDimensions(stateTex.node)
    const idx = p.inst.add(toU32(bandAt(u32(S111_BAND_PARAMS_ROW), S111_PARAM_STATE_BASE)))
    const texel = vec2i(toI32(idx.mod(dim.x)), toI32(idx.div(dim.x)))
    const pos = decodeArrowPos({ c: textureLoad(stateTex.node, texel, u32(0)) })
    const origin = decodeArrowPos({ c: textureLoad(originTex.node, texel, u32(0)) })
    // In units of the packed basis: the anchors are ARROW_DRIFT_UV away and the advect step
    // recycles past that, so this is bounded to [-1, 1] and the linearization never extrapolates.
    const kx = pos.x.sub(origin.x).div(f32(ARROW_DRIFT_UV))
    const ky = pos.y.sub(origin.y).div(f32(ARROW_DRIFT_UV))
    const driftPx = vec2(
      basisU.x.mul(kx).add(basisV.x.mul(ky)),
      basisU.y.mul(kx).add(basisV.y.mul(ky)),
    )

    // The field UNDER the arrow, normalized to [-1, 1] (flow-field-pack.ts). Direction comes
    // from the same two bases, so the glyph points along the current in SCREEN space under any
    // camera without a single trig call: +v is northward, and grid-v runs southward, so the v
    // basis carries −vv — the identical sign the advect step derives for its own step.
    //
    // `aspect` re-expresses the metric east/north components as UV RATES first. A uv unit is a
    // different true distance on each axis (cell aspect × cos lat), so feeding the components
    // to the bases raw would point the arrowhead at one angle while the advection moves the
    // arrow at another — the same shear flow-advect-params.ts folds into its own step pair.
    const vu = loadAtUv(flowUTex.node, pos).x
    const vv = loadAtUv(flowVTex.node, pos).x
    const aspect = bandAt(u32(S111_BAND_PARAMS_ROW), S111_PARAM_UV_ASPECT)
    const dirX = basisU.x.mul(vu).sub(basisV.x.mul(vv).mul(aspect))
    const dirY = basisU.y.mul(vu).sub(basisV.y.mul(vv).mul(aspect))
    const dlen = max(length(vec2(dirX, dirY)), f32(1e-6))
    const cc = dirX.div(dlen)
    const ss = dirY.div(dlen)

    // The catalogue rule, looked up rather than restated: the table's edges and its affine
    // scale pair are uploaded in these same normalized units (s111-portrayal.ts), so nothing
    // here knows a threshold, a colour or a knot.
    const speed = length(vec2(vu, vv))
    const band = Var(u32(0))
    for (let b = 0; b < S111_BAND_COUNT; b++) {
      band.assign(select(speed.lt(bandAt(u32(b), 0)), band, u32(b + 1)))
    }
    const row = min(band, u32(S111_BAND_COUNT - 1))
    const scale = bandAt(row, 1).add(bandAt(row, 2).mul(speed))
    const tint = vec4(bandAt(row, 4), bandAt(row, 5), bandAt(row, 6), bandAt(row, 7))

    // THE PERSPECTIVE GUARD. Both bases are perspective divides by a DIFFERENT anchor's w, and
    // those anchors sit one leash length away — most of a degree on a regional cell. Lower the
    // camera pitch and an anchor crosses behind the eye plane: w passes through zero, the divide
    // explodes, and the arrow is flung off screen (reported as "the particles fly off into
    // space"). The static path never sees this — it takes only a DIRECTION from its delta, and
    // its tip step is 0.02°. This VS is the only one that uses a projected delta as a MAGNITUDE.
    //
    // An arrow whose basis cannot be computed is NOT DRAWN. That is the honest outcome: its
    // position is unknown this frame, so no position is claimed for it. It returns as soon as
    // its anchors are in front of the camera again.
    const minW = min(originClip.w, min(uStepClip.w, vStepClip.w))

    // ── VIEW-DRIVEN DENSITY (#1450 B, #1511) ───────────────────────────────────────────────
    //
    // The stride the CPU applies is decided ONCE, at arm time, from the cell count alone
    // (`arrowStride`) — nothing in it looks at the camera. Zoomed out the arrows pile into a few
    // pixels; zoomed in the field stays as sparse as the arm decided. This thins the field HERE
    // instead, per instance and per frame.
    //
    // ONE RULE, RUNNING BOTH WAYS. The generator seeds a lattice finer than the grid wherever the
    // budget allows (`arrowLattice`), and this keeps every 2^L-th node of it. So `L` above the
    // subdivision level THINS, `L` at it draws exactly the cell centres — the static catalogue
    // placement, as a rung of this ladder — and `L` below it FILLS between the cells, which is
    // the half no arm-time stride could reach: the density had a hard ceiling at the grid's own
    // resolution, and a three-cell-wide channel drew three arrows at every zoom.
    //
    // WHY NOT RE-STRIDE ON THE CPU. The instance COUNT is part of the origin key
    // (`${region}|${nLon}x${nLat}|${count}`), so changing it re-seeds the state and every arrow
    // snaps back to its cell — a visible discontinuity every time the density moves. Culling
    // leaves the batch, the key and the texel range untouched; the advect step keeps stepping
    // every arrow and only the DRAW skips some, so density and animation stop interfering. It is
    // also what makes the filling half safe: seeding dense ONCE is a count that never moves.
    //
    // THE SPACING IS MEASURED, not assumed. `basisU`/`basisV` are already the screen-pixel
    // deltas of one leash (`ARROW_DRIFT_UV` of grid-uv) along each grid axis, so two adjacent
    // seeded positions are `|basis| / (ARROW_DRIFT_UV · steps)` pixels apart. That is a real
    // projected distance at THIS arrow's position, which is what makes the field thin correctly
    // under PITCH: the horizon decimates harder than the foreground inside one frame, where a
    // single camera-wide stride could only pick one answer for both.
    // PER AXIS, not one level for both. The two axes rarely land at the same on-screen spacing —
    // this fixture's cells are 2.8× further apart north-south than east-west — and a single level
    // taken from the TIGHTER axis over-thins the looser one by exactly that ratio. Measured: 36 px
    // between columns and 102 px between rows, for a field that wanted ~36 both ways. Levels stay
    // nested per axis, which is all the no-shimmer argument needs.
    const stepsU = bandAt(u32(S111_BAND_PARAMS_ROW), S111_PARAM_STEPS_U)
    const stepsV = bandAt(u32(S111_BAND_PARAMS_ROW), S111_PARAM_STEPS_V)
    const nodePxU = Let(
      max(length(basisU).div(max(f32(ARROW_DRIFT_UV).mul(stepsU), f32(1e-6))), f32(1e-6)),
    )
    const nodePxV = Let(
      max(length(basisV).div(max(f32(ARROW_DRIFT_UV).mul(stepsV), f32(1e-6))), f32(1e-6)),
    )
    // Keep every 2^L-th node on BOTH axes. Powers of two, so the kept sets are NESTED: an arrow
    // that survives at L survives at every smaller L too, and thinning only ever REMOVES arrows
    // rather than swapping which ones are drawn — the shimmer a non-power-of-two modulus
    // produces as the camera creeps. Nesting is also what puts the catalogue placement ON the
    // ladder instead of beside it: the lattice contains the cell centres, and they are exactly
    // the nodes that survive `keepEvery = sub`.
    //
    // THE TARGET IS THE LENGTH AN ARROW IS ACTUALLY DRAWN AT, which is not the base length.
    //
    // `F.size` carries the BASE (34 px) in advected mode; the drawn glyph is `base × scale`, and
    // `select_arrow.xsl` gives scale 0.40 for everything below 2 kn — which is most tidal water,
    // this fixture's whole range (0.037–1.904 kn) and most of CBOFS. So targeting the base spaced
    // 13.6 px glyphs 34 px apart: a field 2.5× emptier than the rule intended, and the reported
    // symptom ("zoomed out there are far too few arrows" — ~22 across the whole bay at z7).
    //
    // The FLOOR scale, not the arrow's own: it stays a batch constant, so the level does not
    // depend on the water an arrow is standing in and a drifting arrow cannot flicker in and out
    // as it crosses a band edge. That was the right instinct in the first version; reading the
    // base was the wrong way to act on it. Fast water (scale up to 2.6) then overlaps — which is
    // what a convergence zone should look like, and it already overlapped at the old spacing.
    //
    // Read out of the uploaded table's band-1 constant rather than restated here. That row IS
    // `S111_SCALE_FLOOR` by construction (band 1 is the constant 0.40 branch of
    // `select_arrow.xsl`, and the peak normalization leaves a constant term untouched), so the
    // catalogue keeps exactly one authority — and `s111-portrayal.ts` cannot be imported from
    // this file anyway, it imports the layout FROM here.
    const target = Let(rd(F.size).mul(bandAt(u32(0), 1)))
    const keepU = Let(exp2(max(ceil(log2(target.div(nodePxU))), f32(0))))
    const keepV = Let(exp2(max(ceil(log2(target.div(nodePxV))), f32(0))))
    // The arrow's own lattice index, recovered from the origin it was seeded at — a fixed
    // property of the instance, so the decision is stable frame to frame and across a forecast
    // step. `+0.5` then floor, because the index is what the origin was BUILT from: the uv
    // carries it back through a 16-bit encoding, so it arrives near the integer rather than on
    // it, and rounding is what recovers it exactly.
    const nodeU = floor(origin.x.mul(stepsU).add(0.5))
    const nodeV = floor(origin.y.mul(stepsV).add(0.5))
    // Exact: `keepEvery` is a power of two and both indices are exact non-negative integers in
    // f32, so each fraction is exactly 0 on a kept node and at least `1/keepEvery` otherwise.
    const off = fract(nodeU.div(keepU)).add(fract(nodeV.div(keepV)))
    // A batch that declared no lattice (steps = 0 — `s111BandTableNormalized` called without
    // them) draws its WHOLE field rather than thinning it to nothing: an absent number is not a
    // request for maximum decimation.
    const declared = step(f32(0.5), min(stepsU, stepsV))
    const keep = max(f32(1).sub(step(f32(1e-4), off)), f32(1).sub(declared))

    // main.xsl note (4): no symbol for speed 0 or noData — and a packed nodata cell is exactly
    // (0, 0). A zero length collapses the quad, so the arrow is not drawn at all rather than
    // drawn at some floor size in water that has no current. The density cull rides the SAME
    // mechanism: one more 0/1 factor, no second way for an arrow to not be drawn.
    const size = rd(F.size)
      .mul(scale)
      .mul(step(f32(1e-6), speed))
      .mul(step(f32(1e-6), minW))
      .mul(keep)

    const margin = rd(F.stroke_units)
    const qx = f32(0)
    const qy = f32(0)
    Switch(p.vi)
      .case(0, () => {
        qx.assign(f32(0).sub(margin))
        qy.assign(f32(-HH).sub(margin))
      })
      .case(1, () => {
        qx.assign(f32(0).sub(margin))
        qy.assign(f32(HH).add(margin))
      })
      .case(2, () => {
        qx.assign(f32(1).add(margin))
        qy.assign(f32(HH).add(margin))
      })
      .case(3, () => {
        qx.assign(f32(0).sub(margin))
        qy.assign(f32(-HH).sub(margin))
      })
      .case(4, () => {
        qx.assign(f32(1).add(margin))
        qy.assign(f32(HH).add(margin))
      })
      .case(5, () => {
        qx.assign(f32(1).add(margin))
        qy.assign(f32(-HH).sub(margin))
      })
      .default(() => {
        /* vi ∈ 0..5 */
      })

    const lx = qx.mul(size)
    const ly = qy.mul(size)
    // The drift is gated by the SAME guard: `size` collapses the quad, but the displacement is
    // added to the anchor independently, so an unguarded drift would still carry a zero-area
    // quad to a garbage position.
    const live = step(f32(1e-6), minW)
    const rx = lx.mul(cc).sub(ly.mul(ss)).add(driftPx.x.mul(live))
    const ry = lx.mul(ss).add(ly.mul(cc)).add(driftPx.y.mul(live))
    const offNdc = vec2(rx.mul(f32(2).div(vp.x)), ry.neg().mul(f32(2).div(vp.y)))
    const clip = originClip.add(vec4(offNdc.mul(originClip.w), 0, 0))

    const o = ArrowOut.var()
    o.position.assign(clip)
    o.loc.assign(vec2(qx, qy))
    o.tint.assign(tint)
    // Culled against the ORIGIN's normal, not the drifted position: the excursion is bounded to
    // a few percent of one coverage cell's footprint, far inside the horizon's own slack.
    o.cos_c.assign(
      needs_backface_cull(absLon, absLat, pointU.field.proj_params, pointU.field.globe_eye),
    )
    o.stroke_units.assign(margin)
    return o.$
  },
  { stage: 'vertex' },
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
 *  single-main-per-unit; mirrors emitIconRetainedGlsl). `emulateStorage` lowers the feat
 *  (array<f32>) + tint (array<vec4f>) storage buffers to R32F data textures, matching
 *  WebGl2Device's storage-buffer emulation. Consumed by RetainedArrowDraper behind a live
 *  `rhi.backend === 'webgl2'` guard — the WebGPU boot never pays for this emit (#778 P6). */
export const emitArrowRetainedGlsl = (stage: 'vertex' | 'fragment'): string => {
  const m = buildArrowRetainedModule()
  const keep = stage === 'vertex' ? 'vs_arrow_retained' : 'fs_arrow_retained'
  return emitGlslModule(
    { ...m, funcs: m.funcs.filter((f) => stageOf(f) === undefined || f.name === keep) },
    stage,
    { emulateStorage: true },
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
    emulateStorage: true,
  })

/** The ADVECTED module (#1419) — same projection ladder, same fragment stage, same output
 *  struct; a different VS and the resources it needs. No tint buffer: the colour is the band
 *  the arrow is standing in, not the one it launched with. */
export const buildArrowRetainedAdvectedModule = (): ModuleDecl =>
  module({
    consts: [...PROJECTION_CONSTS],
    structs: [pointU.struct, ArrowOut.decl],
    bindings: [
      pointU.binding,
      featB.binding,
      bandB.binding,
      stateTex.binding,
      originTex.binding,
      flowUTex.binding,
      flowVTex.binding,
    ],
    funcs: [...getGpuProjectionFuncs(), project_geo, decodeArrowPos, vsAdvected, fs],
  })

export const emitArrowRetainedAdvectedWgsl = (): string =>
  emitModule(buildArrowRetainedAdvectedModule())

/** GLSL ES 3.00 twin of the advected module. `emulateStorage` lowers feat + band table to R32F
 *  data textures exactly as the static path does; the state/origin/velocity textures are real
 *  textures on both arms and are read with `texelFetch`, which needs no sampler and so needs no
 *  vertex-visible sampler either. */
export const emitArrowRetainedAdvectedGlsl = (stage: 'vertex' | 'fragment'): string => {
  const m = buildArrowRetainedAdvectedModule()
  const keep = stage === 'vertex' ? 'vs_arrow_retained_advected' : 'fs_arrow_retained'
  return emitGlslModule(
    { ...m, funcs: m.funcs.filter((f) => stageOf(f) === undefined || f.name === keep) },
    stage,
    { emulateStorage: true },
  )
}

/** Both GLSL stages from ONE lowering (see emitGlslStages). The per-stage twin above
 *  prunes the module before each emit, so it lowers + runs the optimizer fixpoint twice;
 *  naming the entries instead shares it. Byte-identical to two calls of the per-stage
 *  form — pinned by map/src/render/material/glsl-stage-entry-parity.test.ts. */
export const emitArrowRetainedAdvectedGlslStages = (): { vertex: string; fragment: string } =>
  emitGlslStages(buildArrowRetainedAdvectedModule(), {
    vertexEntry: 'vs_arrow_retained_advected',
    fragmentEntry: 'fs_arrow_retained',
    emulateStorage: true,
  })
