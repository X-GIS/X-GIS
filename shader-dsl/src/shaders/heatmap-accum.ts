// ═══ Shader DSL — heatmap accumulation pass (Phase R) ═══
//
// Pass 1 of the 3-pass heatmap pipeline (accum → blur → compose). Each
// heatmap point is expanded into a screen-space quad of `heatmap-radius`
// pixels and rasterised with a radial Gaussian falloff, ADDITIVELY blended
// into an offscreen R16Float density texture. The compose pass later maps
// the (blurred) density through the colour ramp.
//
// The vertex stage is a faithful clone of the SDF-point VS projection path
// (shaders/point.ts) — same per-feature ECEF DSFUN centre (slots 11..18) +
// precise absolute-Mercator DSFUN tail (slots 20..23) + the three-way
// projType branch (flat-Mercator < 0.5 / flat-other < 6.5 / ECEF-globe).
// Reusing the proven projection keeps the splat centred on exactly the same
// pixel the SDF point / circle renderer would place the feature, so a
// heatmap and a circle layer over the same source line up.
//
// Per-feature feat_data layout (stride 24 f32) is IDENTICAL to the point
// renderer's pack (so HeatmapRenderer reuses the same expansion code):
//   slot 0      = radius_px (heatmap-radius, CSS px)
//   slot 1      = weight    (heatmap-weight × global, per-feature)
//   slots 11-16 = ECEF DSFUN centre (pos_h.xyz, pos_l.xyz)
//   slots 17-18 = abs_lon, abs_lat (degrees)
//   slots 20-23 = absolute-Mercator DSFUN tail (mx_h, mx_l, my_h, my_l)
//
// The fragment writes ONLY the red channel (R16Float target). The pipeline
// uses an additive blend (ONE,ONE) so overlapping splats sum — that summed
// density is the heatmap signal.

import {
  entryFn, module, callFn, transformMat4, arrayLit,
  f32, u32, toU32, vec2, vec3, vec4, exp, max,
  Let, Var, assign, If,
  f32T, u32T, vec2fT, vec4fT, mat4x4fT, arrayT,
  type ModuleDecl,
} from '../core/ir'
import { ioStruct, builtin, location, uniformStruct, storageBuffer } from '../core/sot'
import { emitModule } from '../core/backends/wgsl'
import { getProjectionWgslConsts, getProjectionWgslFns } from './projections'

const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'u' }, {
  // ECEF-MVP (Camera.getECEFFrameView) for globe / 3D; the matching
  // flat-Mercator MVP (Camera.getViewForProjection) on the flat path.
  mvp: mat4x4fT,
  // proj_params: x=projType, y=centerLon, z=centerLat, w=unused.
  proj_params: vec4fT,
  // viewport: x=width px, y=height px, z=meters/px, w=unused.
  viewport: vec4fT,
  // Camera anchor (DSFUN hi/lo) — ECEF (getECEFCenter) on globe; the 2D
  // Mercator centre in .xy on the flat path. Mirrors the point uniform.
  cam_ecef_h: vec4fT,
  cam_ecef_l: vec4fT,
})

const HeatOut = ioStruct('HeatOut', {
  position: builtin('position', vec4fT),
  uv: location(0, vec2fT),
  weight: location(1, f32T, 'flat'),
})

const featDataB = storageBuffer('feat_data', arrayT(f32T), { group: 0, binding: 1, access: 'read' })
const featData = featDataB.node

// Per-feature stride — matches the point renderer's pack so HeatmapRenderer
// can reuse the same ECEF / Mercator DSFUN expansion.
const STRIDE = u32(24)

const vs = entryFn('vs_heatmap', 'vertex', [
  { name: 'center', type: vec2fT, location: 0 },
  { name: 'quad_id', type: u32T, location: 1 },
  { name: 'feat_id', type: f32T, location: 2 },
], HeatOut.type, (_b, p) => {
  const offsets = Let('offsets', arrayLit(vec2fT,
    vec2(f32(-1), f32(-1)),
    vec2(f32(1), f32(-1)),
    vec2(f32(1), f32(1)),
    vec2(f32(-1), f32(1)),
  ))
  const fid = Let('fid', toU32(p.feat_id))
  const radiusPx = Let('radius_px', max(featData.at(fid.mul(STRIDE).add(u32(0)), f32T), f32(1)))
  const weight = Let('weight', featData.at(fid.mul(STRIDE).add(u32(1)), f32T))
  const viewport = U.field.viewport
  const mvp = U.field.mvp

  // Per-feature ECEF DSFUN centre (slots 11..16) + abs lon/lat (17/18).
  const ecefH = Let('ecef_h', vec3(
    featData.at(fid.mul(STRIDE).add(u32(11)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(12)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(13)), f32T),
  ))
  const ecefL = Let('ecef_l', vec3(
    featData.at(fid.mul(STRIDE).add(u32(14)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(15)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(16)), f32T),
  ))
  const camH = Let('cam_h', U.field.cam_ecef_h.swizzle<'vec3<f32>'>('xyz'))
  const camL = Let('cam_l', U.field.cam_ecef_l.swizzle<'vec3<f32>'>('xyz'))
  const ecefRtc = Let('ecef_rtc', ecefH.sub(camH).add(ecefL.sub(camL)))
  const absLon = Let('abs_lon', featData.at(fid.mul(STRIDE).add(u32(17)), f32T))
  const absLat = Let('abs_lat', featData.at(fid.mul(STRIDE).add(u32(18)), f32T))

  // Three-way projType branch — faithful clone of the point VS.
  const centerClip = Var('center_clip', vec4fT)
  If(U.field.proj_params.x.lt(0.5), () => {
    // Flat Mercator: precise absolute-Mercator DSFUN tail (slots 20..23),
    // camera-recentered in DSFUN space.
    const mxH = Let('mx_h', featData.at(fid.mul(STRIDE).add(u32(20)), f32T))
    const mxL = Let('mx_l', featData.at(fid.mul(STRIDE).add(u32(21)), f32T))
    const myH = Let('my_h', featData.at(fid.mul(STRIDE).add(u32(22)), f32T))
    const myL = Let('my_l', featData.at(fid.mul(STRIDE).add(u32(23)), f32T))
    const camMercH = Let('cam_merc_h', U.field.cam_ecef_h.swizzle<'vec2<f32>'>('xy'))
    const camMercL = Let('cam_merc_l', U.field.cam_ecef_l.swizzle<'vec2<f32>'>('xy'))
    const relX = Let('rel_x', mxH.sub(camMercH.x).add(mxL.sub(camMercL.x)))
    const relY = Let('rel_y', myH.sub(camMercH.y).add(myL.sub(camMercL.y)))
    assign(centerClip, transformMat4(mvp, vec4(relX, relY, f32(0), f32(1))))
  }).elif(U.field.proj_params.x.lt(6.5), () => {
    // Flat non-Mercator (1..6): shared flat_rel (self-ref lon for nearest copy).
    const pp = Let('pp', U.field.proj_params)
    const relG = Let('rel2d_geom', callFn('flat_rel', vec2fT, absLon, absLat, pp, absLon))
    assign(centerClip, transformMat4(mvp, vec4(relG.x, relG.y, f32(0), f32(1))))
  }).else(() => {
    assign(centerClip, transformMat4(mvp, vec4(ecefRtc, f32(1))))
  })

  // Expand a screen-space billboard quad of `radius_px` (NDC-corrected by
  // clip.w). uv runs −1..1 across the quad; the FS Gaussian is radial in uv.
  const offXY = Let('off_xy', offsets.at(p.quad_id, vec2fT))
  const pxToNdc = Let('px_to_ndc', vec2(f32(2).div(viewport.x), f32(2).div(viewport.y)))
  const offsetPx = Let('offset_px', vec2(offXY.x.mul(radiusPx), offXY.y.mul(radiusPx)))
  const offsetNdc = Let('offset_ndc', offsetPx.mul(pxToNdc))
  const quadClip = Let('quad_clip', centerClip.add(vec4(offsetNdc.mul(centerClip.w), f32(0), f32(0))))

  const out = Var('out', HeatOut.type)
  const o = HeatOut.of(out)
  assign(o.position, quadClip)
  assign(o.uv, offXY)
  assign(o.weight, weight)
  return out
})

// Fragment: radial Gaussian falloff × weight → R channel. The accum pipeline
// uses additive blend so the writes sum across overlapping splats.
//
// Mapbox's heatmap kernel (GL-JS heatmap.fragment.glsl): density
// contribution = weight · (exp(GAUSS_COEF · d²) − ZERO) over the unit disc
// d=|uv|, with GAUSS_COEF = −1.5 and ZERO = exp(GAUSS_COEF) so the edge of
// the disc contributes ~0 (continuous falloff to the quad boundary).
const fs = entryFn('fs_heatmap', 'fragment', [{ name: 'in', type: HeatOut.type }], vec4fT, (_b, p) => {
  const pin = HeatOut.of(p.in)
  const uv = Let('uv', pin.uv)
  const d2 = Let('d2', uv.x.mul(uv.x).add(uv.y.mul(uv.y)))
  const ZERO = f32(0.22313016) // exp(-1.5)
  const gauss = Let('gauss', max(exp(d2.mul(-1.5)).sub(ZERO), f32(0)))
  const density = Let('density', gauss.mul(pin.weight))
  // R16Float target — only .r carries density; gba unused.
  return vec4(density, f32(0), f32(0), f32(1))
}, '@location(0)')

const HEATMAP_ACCUM_MODULE: ModuleDecl = module({
  structs: [U.struct, HeatOut.decl],
  bindings: [
    U.binding,
    featDataB.binding,
  ],
  funcs: [vs, fs],
})

/** Full heatmap accumulation shader: shared projection consts + fns, then
 *  the accum module (Uniforms + feat_data storage + vs_heatmap/fs_heatmap). */
export const emitHeatmapAccumWgsl = (): string => [
  getProjectionWgslConsts(),
  getProjectionWgslFns(),
  emitModule(HEATMAP_ACCUM_MODULE),
].join('\n')
