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
  fn, module, transformMat4, arrayLit,
  f32, u32, toU32, vec2, vec3, vec4, exp, max,
  Let, condExpr,
  f32T, u32T, vec2fT, vec4fT, mat4x4fT,
  type ModuleDecl,
} from '../core/ir'
import { ioStruct, builtin, location, uniformStruct, storageBuffer } from '../core/sot'
import { emitModule } from '../core/backends/wgsl'
import { flat_rel, PROJECTION_CONSTS, getGpuProjectionFuncs } from './projections'

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

const featDataB = storageBuffer('feat_data', f32T, { group: 0, binding: 1, access: 'read' })
const featData = featDataB.node

// Per-feature stride — matches the point renderer's pack so HeatmapRenderer
// can reuse the same ECEF / Mercator DSFUN expansion.
const STRIDE = u32(24)

const vs = fn('vs_heatmap', {
  center: location(0, vec2fT),
  quad_id: location(1, u32T),
  feat_id: location(2, f32T),
}, HeatOut.type, (p, _b) => {
  const offsets = arrayLit(vec2fT,
    vec2(f32(-1), f32(-1)),
    vec2(f32(1), f32(-1)),
    vec2(f32(1), f32(1)),
    vec2(f32(-1), f32(1)),
  )
  const fid = toU32(p.feat_id)
  const radiusPx = max(featData.at(fid.mul(STRIDE).add(u32(0)), f32T), f32(1))
  const weight = featData.at(fid.mul(STRIDE).add(u32(1)), f32T)
  const viewport = U.field.viewport
  const mvp = U.field.mvp

  // Per-feature ECEF DSFUN centre (slots 11..16) + abs lon/lat (17/18).
  const ecefH = vec3(
    featData.at(fid.mul(STRIDE).add(u32(11)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(12)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(13)), f32T),
  )
  const ecefL = vec3(
    featData.at(fid.mul(STRIDE).add(u32(14)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(15)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(16)), f32T),
  )
  const camH = U.field.cam_ecef_h.swizzle<'vec3<f32>'>('xyz')
  const camL = U.field.cam_ecef_l.swizzle<'vec3<f32>'>('xyz')
  const ecefRtc = ecefH.sub(camH).add(ecefL.sub(camL))
  const absLon = featData.at(fid.mul(STRIDE).add(u32(17)), f32T)
  const absLat = featData.at(fid.mul(STRIDE).add(u32(18)), f32T)

  // Three-way projType branch — faithful clone of the point VS.
  const centerClip = condExpr('center_clip', vec4fT, [
    [U.field.proj_params.x.lt(0.5), () => {
      // Flat Mercator: precise absolute-Mercator DSFUN tail (slots 20..23),
      // camera-recentered in DSFUN space.
      const mxH = featData.at(fid.mul(STRIDE).add(u32(20)), f32T)
      const mxL = featData.at(fid.mul(STRIDE).add(u32(21)), f32T)
      const myH = featData.at(fid.mul(STRIDE).add(u32(22)), f32T)
      const myL = featData.at(fid.mul(STRIDE).add(u32(23)), f32T)
      const camMercH = U.field.cam_ecef_h.swizzle<'vec2<f32>'>('xy')
      const camMercL = U.field.cam_ecef_l.swizzle<'vec2<f32>'>('xy')
      const relX = mxH.sub(camMercH.x).add(mxL.sub(camMercL.x))
      const relY = myH.sub(camMercH.y).add(myL.sub(camMercL.y))
      return transformMat4(mvp, vec4(relX, relY, f32(0), f32(1)))
    }],
    [U.field.proj_params.x.lt(6.5), () => {
      // Flat non-Mercator (1..6): shared flat_rel (self-ref lon for nearest copy).
      const pp = U.field.proj_params
      const relG = flat_rel(absLon, absLat, pp, absLon)
      return transformMat4(mvp, vec4(relG.x, relG.y, f32(0), f32(1)))
    }],
  ], () => transformMat4(mvp, vec4(ecefRtc, f32(1))))

  // Expand a screen-space billboard quad of `radius_px` (NDC-corrected by
  // clip.w). uv runs −1..1 across the quad; the FS Gaussian is radial in uv.
  const offXY = offsets.at(p.quad_id, vec2fT)
  const pxToNdc = vec2(f32(2).div(viewport.x), f32(2).div(viewport.y))
  const offsetPx = vec2(offXY.x.mul(radiusPx), offXY.y.mul(radiusPx))
  const offsetNdc = offsetPx.mul(pxToNdc)
  const quadClip = Let('quad_clip', centerClip.add(vec4(offsetNdc.mul(centerClip.w), f32(0), f32(0))))

  return HeatOut.construct({ position: quadClip, uv: offXY, weight })
}, { stage: 'vertex' })

// Fragment: radial Gaussian falloff × weight → R channel. The accum pipeline
// uses additive blend so the writes sum across overlapping splats.
//
// Mapbox's heatmap kernel (GL-JS heatmap.fragment.glsl): density
// contribution = weight · (exp(GAUSS_COEF · d²) − ZERO) over the unit disc
// d=|uv|, with GAUSS_COEF = −1.5 and ZERO = exp(GAUSS_COEF) so the edge of
// the disc contributes ~0 (continuous falloff to the quad boundary).
const fs = fn('fs_heatmap', { in: HeatOut.type }, vec4fT, (p, _b) => {
  const pin = HeatOut.of(p.in)
  const uv = pin.uv
  const d2 = uv.x.mul(uv.x).add(uv.y.mul(uv.y))
  const ZERO = f32(0.22313016) // exp(-1.5)
  const gauss = max(exp(d2.mul(-1.5)).sub(ZERO), f32(0))
  const density = gauss.mul(pin.weight)
  // R16Float target — only .r carries density; gba unused.
  return vec4(density, f32(0), f32(0), f32(1))
}, { stage: 'fragment', retAttr: '@location(0)' })

// A build-fn (not a top-level const) so the injection-deferred getGpuProjectionFuncs() is
// gathered at emit time, post-configureProjections().
const buildHeatmapAccumModule = (): ModuleDecl => module({
  // Shared projection constants merged in (was the getProjectionWgslConsts() string prepend).
  consts: [...PROJECTION_CONSTS],
  structs: [U.struct, HeatOut.decl],
  bindings: [
    U.binding,
    featDataB.binding,
  ],
  // Projection fn decls lead (was the getProjectionWgslFns() prepend), then the accum funcs.
  funcs: [...getGpuProjectionFuncs(), vs, fs],
})

/** Full heatmap accumulation shader: one module — shared projection consts + fns merged
 *  ahead of the accum module (Uniforms + feat_data storage + vs_heatmap/fs_heatmap). */
export const emitHeatmapAccumWgsl = (): string => emitModule(buildHeatmapAccumModule())
