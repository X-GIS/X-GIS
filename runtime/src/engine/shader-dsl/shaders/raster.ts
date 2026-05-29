// ═══ Shader DSL — raster tile shader (Phase 2 PR 2d.3 — ECEF VS) ═══
//
// Re-authors render/raster-renderer.ts RASTER_SHADER_SOURCE. The vertex stage
// generates a procedural N×N grid (vertex_index, no vertex buffer), recovers
// lon/lat from the tile's Mercator-Y span, and projects via a single ECEF
// path: lon/lat → lonlat_to_ecef() → subtract tile_ecef_center (RTC) →
// MVP transform. This replaces the previous 4-branch projection dispatch
// (globe / mercator / equirect / other+cull). The fragment samples the tile
// texture, applies raster-opacity + a rim-alpha fade, and writes log-depth.
//
// The shared ECEF consts + fns (lonlat_to_ecef / ECEF WGS84 consts) are
// prepended by emitRasterWgsl alongside the log-depth helpers. The projection
// WGSL block is no longer emitted — only ECEF_WGSL_CONSTS/FNS + LOG_DEPTH.
//
// Pick variant: the pick attachment field + write are conditionally emitted;
// raster always writes (0,0) since a basemap tile carries no feature id.

import {
  entryFn, module, bindingRef, constRef, callFn, transformMat4, arrayLit,
  f32, u32, toF32, vec2, vec3, vec4, vec2u, mix, atan, exp, smoothstep, textureSample,
  structT, f32T, u32T, vec2fT, vec3fT, vec4fT, vec2uT, mat4x4fT, texture2dfT, samplerT,
  type StructDecl, type StructField, type ModuleDecl,
} from '../core/ir'
import { emitModule } from '../core/backends/wgsl'
import { ECEF_WGSL_CONSTS, ECEF_WGSL_FNS } from './ecef'
import { LOG_DEPTH_WGSL_FNS } from './log-depth'
import { PROJECTION_WGSL_CONSTS, PROJECTION_WGSL_FNS } from './projections'

const Uniforms: StructDecl = {
  name: 'Uniforms',
  fields: [
    { name: 'mvp', type: mat4x4fT },
    // proj_params: x=type, y=centerLon, z=centerLat, w=log_depth_fc
    { name: 'proj_params', type: vec4fT },
    // raster_params: x=opacity (0..1), yzw reserved (gamma/brightness/contrast)
    { name: 'raster_params', type: vec4fT },
    // Camera-relative RTC (same fix as polygon's cam_ecef_off): the vertex ecef
    // is absolute, so subtract cameraCenter to feed the camera-at-ENU-origin
    // MVP. xyz = getECEFCenter (sphere); w unused. Raster is texture-grade, so
    // plain f32 (no DSFUN) is sufficient.
    { name: 'cam_ecef_center', type: vec4fT },
  ],
}
const TileUniforms: StructDecl = {
  name: 'TileUniforms',
  fields: [
    { name: 'bounds', type: vec4fT },          // west, south, east, north (degrees); x/z shifted per world-copy
    { name: 'tile_ecef_center', type: vec4fT }, // xyz = ECEF of tile SW corner (world-copy unshifted); w = 0
    { name: 'merc_y', type: vec2fT },           // x = merc_south (abs), y = merc_diff (north - south)
    { name: '_pad', type: vec2fT },
  ],
}
const VsOut: StructDecl = {
  name: 'VsOut',
  fields: [
    { name: 'pos', type: vec4fT, attr: '@builtin(position)' },
    { name: 'uv', type: vec2fT, attr: '@location(0)' },
    { name: 'vis', type: f32T, attr: '@location(1)' },
    { name: 'view_w', type: f32T, attr: '@location(2)' },
  ],
}
const rasterFragmentOutput = (pickEnabled: boolean): StructDecl => {
  const fields: StructField[] = [{ name: 'color', type: vec4fT, attr: '@location(0)' }]
  if (pickEnabled) fields.push({ name: 'pick', type: vec2uT, attr: '@location(1) @interpolate(flat)' })
  fields.push({ name: 'depth', type: f32T, attr: '@builtin(frag_depth)' })
  return { name: 'RasterFragmentOutput', fields }
}

const u = bindingRef('u', structT('Uniforms'))
const tex = bindingRef('tex', texture2dfT)
const texSampler = bindingRef('tex_sampler', samplerT)
const tile = bindingRef('tile', structT('TileUniforms'))

// GRID_N = 8 (an 8×8 subdivided grid, 6 verts/cell = 384; the draw count lives
// in the renderer). Inlined where used.
const vs = entryFn('vs_tile', 'vertex', [{ name: 'vid', type: u32T, builtin: 'vertex_index' }], structT('VsOut'), (b, p) => {
  const cell = b.let('cell', p.vid.div(u32(6)))
  const tri = b.let('tri', p.vid.mod(u32(6)))
  const cx = b.let('cx', cell.mod(u32(8)))
  const cy = b.let('cy', cell.div(u32(8)))

  const duArr = b.let('du_arr', arrayLit(u32T, u32(0), u32(1), u32(0), u32(1), u32(1), u32(0)))
  const dvArr = b.let('dv_arr', arrayLit(u32T, u32(0), u32(0), u32(1), u32(0), u32(1), u32(1)))
  const gx = b.let('gx', cx.add(duArr.at(tri, u32T)))
  const gy = b.let('gy', cy.add(dvArr.at(tri, u32T)))

  const uu = b.let('uu', toF32(gx).div(8))
  const vv = b.let('vv', toF32(gy).div(8))

  const mercY = tile.field('merc_y', vec2fT)
  const bounds = tile.field('bounds', vec4fT)
  const camEcef = u.field('cam_ecef_center', vec4fT)
  const projParams = u.field('proj_params', vec4fT)

  // vv=0 → north (offset=diff), vv=1 → south (offset=0). Local offset from tileSouth.
  const mercYOffset = b.let('merc_y_offset', f32(1).sub(vv).mul(mercY.y))
  const mercYAbs = b.let('merc_y_abs', mercY.x.add(mercYOffset))

  // bounds.x/z are world-copy-shifted (west+wo*360, east+wo*360) so lon
  // naturally lands in the correct world copy. merc_y is copy-independent.
  const lon = b.let('lon', mix(bounds.x, bounds.z, uu))
  const latRad = b.let('lat_rad', f32(2).mul(atan(exp(mercYAbs))).sub(constRef('PI').div(2)))

  // ECEF path: lon/lat → WGS84 ECEF → subtract tile SW-corner anchor (RTC).
  // Works for every projection because the MVP is always the ECEF frame view
  // (Camera.getECEFFrameView). No per-projection branches needed.
  const lonRad = b.let('lon_rad', lon.mul(constRef('DEG2RAD')))
  const ecef = b.let('ecef', callFn('lonlat_to_ecef', vec3fT, lonRad, latRad, f32(0)))
  // Camera-relative: ecef − cameraCenter (the MVP is camera-at-ENU-origin).
  const camEcefVec = b.let('cam_ecef_vec', vec3(camEcef.x, camEcef.y, camEcef.z))
  const ecefRtc = b.let('ecef_rtc', ecef.sub(camEcefVec))

  const out = b.var('out', structT('VsOut'))
  // Display projection (projection-display-layer-restore): flat Mercator
  // (proj_params.x < 0.5) reprojects the reconstructed lon/lat onto the 2D
  // plane and feeds the flat Mercator-metre MVP; 3D / globe keeps the ECEF
  // path. For the flat path the renderer writes the 2D camera centre
  // (Mercator metres) into cam_ecef_center.xy — those ECEF lanes are dead
  // there. u.mvp is the matching matrix (Camera.getViewForProjection). f32
  // reprojection ≈ 1 m at extreme zoom (P1), sub-pixel for texture-grade
  // raster.
  const clip = b.var('clip', vec4fT)
  b.if(projParams.x.lt(0.5), (c) => {
    const latDeg = c.let('lat_deg', latRad.div(constRef('DEG2RAD')))
    const p2d = c.let('p2d', callFn('project', vec2fT, lon, latDeg, projParams))
    const rel2d = c.let('rel2d', p2d.sub(vec2(camEcef.x, camEcef.y)))
    c.assign(clip, transformMat4(u.field('mvp', mat4x4fT), vec4(rel2d.x, rel2d.y, f32(0), f32(1))))
  }).else((c) => {
    c.assign(clip, transformMat4(u.field('mvp', mat4x4fT), vec4(ecefRtc, f32(1))))
  })
  b.assign(out.field('pos', vec4fT), callFn('apply_log_depth', vec4fT, clip, projParams.w))
  b.assign(out.field('view_w', f32T), clip.w)
  b.assign(out.field('uv', vec2fT), vec2(uu, vv))
  b.assign(out.field('vis', f32T), f32(1))
  b.ret(out)
})

const buildFs = (pickEnabled: boolean) =>
  entryFn('fs_tile', 'fragment', [{ name: 'input', type: structT('VsOut') }], structT('RasterFragmentOutput'), (b, p) => {
    b.if(p.input.field('vis', f32T).lt(0), (c) => { c.discard() })
    const out = b.var('out', structT('RasterFragmentOutput'))
    const c = b.let('c', textureSample(tex, texSampler, p.input.field('uv', vec2fT)))
    // Rim alpha fade — input.vis carries (cos_c - threshold); Mercator writes
    // vis=1 so smoothstep is a no-op on flat/cylindrical projections.
    const rim = b.let('rim', smoothstep(0, 0.02, p.input.field('vis', f32T)))
    // raster-opacity multiplies alpha only (premultiplied blend keeps RGB at
    // texel value, so a half-opacity raster fades rather than darkens).
    b.assign(out.field('color', vec4fT), vec4(c.rgb, c.a.mul(u.field('raster_params', vec4fT).x).mul(rim)))
    // Basemap tile carries no feature id → always (0,0).
    if (pickEnabled) b.assign(out.field('pick', vec2uT), vec2u(u32(0), u32(0)))
    b.assign(out.field('depth', f32T), callFn('compute_log_frag_depth', f32T, p.input.field('view_w', f32T), u.field('proj_params', vec4fT).w))
    b.ret(out)
  })

const buildRasterModule = (pickEnabled: boolean): ModuleDecl => module({
  structs: [Uniforms, TileUniforms, VsOut, rasterFragmentOutput(pickEnabled)],
  bindings: [
    { group: 0, binding: 0, name: 'u', space: 'uniform', type: structT('Uniforms') },
    { group: 0, binding: 1, name: 'tex', space: 'uniform', type: texture2dfT },
    { group: 0, binding: 2, name: 'tex_sampler', space: 'uniform', type: samplerT },
    { group: 1, binding: 0, name: 'tile', space: 'uniform', type: structT('TileUniforms') },
  ],
  funcs: [vs, buildFs(pickEnabled)],
})

/** Full raster shader: ECEF consts + lonlat_to_ecef fn + log-depth fns, then
 *  the raster module (structs + bindings + vs_tile + fs_tile).
 *  `pickEnabled` toggles the pick attachment field + write. */
export const emitRasterWgsl = (pickEnabled: boolean): string => [
  PROJECTION_WGSL_CONSTS,
  PROJECTION_WGSL_FNS,
  ECEF_WGSL_CONSTS,
  ECEF_WGSL_FNS,
  LOG_DEPTH_WGSL_FNS,
  emitModule(buildRasterModule(pickEnabled)),
].join('\n')
