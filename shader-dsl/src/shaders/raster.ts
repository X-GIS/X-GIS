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
  entryFn, module, constRef, callFn, transformMat4, arrayLit,
  f32, u32, toF32, vec2, vec3, vec4, vec2u, mix, atan, exp, smoothstep, textureSample,
  structT, f32T, u32T, vec2fT, vec3fT, vec4fT, vec2uT, mat4x4fT, texture2dfT, samplerT,
  Let, Var, assign, If, Discard,
  type StructDecl, type StructField, type ModuleDecl,
} from '../core/ir'
import { ioStruct, builtin, location, uniformStruct, resource } from '../core/sot'
import { emitModule } from '../core/backends/wgsl'
import { ECEF_WGSL_CONSTS, ECEF_WGSL_FNS } from './ecef'
import { RASTER_COLOR_WGSL_FNS } from './raster-color'
import { LOG_DEPTH_WGSL_FNS } from './log-depth'
import { getProjectionWgslConsts, getProjectionWgslFns } from './projections'

const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'u' }, {
  mvp: mat4x4fT,
  // proj_params: x=type, y=centerLon, z=centerLat, w=log_depth_fc
  proj_params: vec4fT,
  // raster_params: x=opacity (0..1), yzw reserved
  raster_params: vec4fT,
  // raster-* colour adjustments (Mapbox paint). raster_color0 =
  // (hueRotateDeg, brightnessMin, brightnessMax, saturation);
  // raster_color1.x = contrast. ALL defaults (0,0,1,0)/(0,…) are a hard
  // no-op so an un-authored raster show samples the texel unchanged.
  raster_color0: vec4fT,
  raster_color1: vec4fT,
  // Camera-relative RTC (same fix as polygon's cam_ecef_off): the vertex ecef
  // is absolute, so subtract cameraCenter to feed the camera-at-ENU-origin
  // MVP. xyz = getECEFCenter (sphere); w unused. Raster is texture-grade, so
  // plain f32 (no DSFUN) is sufficient.
  cam_ecef_center: vec4fT,
})
const Tile = uniformStruct('TileUniforms', { group: 1, binding: 0, as: 'tile' }, {
  bounds: vec4fT,          // west, south, east, north (degrees); x/z shifted per world-copy
  tile_ecef_center: vec4fT, // xyz = ECEF of tile SW corner (world-copy unshifted); w = 0
  merc_y: vec2fT,           // x = merc_south (abs), y = merc_diff (north - south)
  _pad: vec2fT,
})
const VsOut = ioStruct('VsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
  vis: location(1, f32T),
  view_w: location(2, f32T),
})
const rasterFragmentOutput = (pickEnabled: boolean): StructDecl => {
  const fields: StructField[] = [{ name: 'color', type: vec4fT, attr: '@location(0)' }]
  if (pickEnabled) fields.push({ name: 'pick', type: vec2uT, attr: '@location(1) @interpolate(flat)' })
  fields.push({ name: 'depth', type: f32T, attr: '@builtin(frag_depth)' })
  return { name: 'RasterFragmentOutput', fields }
}

const tex = resource('tex', texture2dfT, { group: 0, binding: 1 })
const texSampler = resource('tex_sampler', samplerT, { group: 0, binding: 2 })

// GRID_N = 8 (an 8×8 subdivided grid, 6 verts/cell = 384; the draw count lives
// in the renderer). Inlined where used.
const vs = entryFn('vs_tile', 'vertex', [{ name: 'vid', type: u32T, builtin: 'vertex_index' }], VsOut.type, (p, _b) => {
  const cell = Let('cell', p.vid.div(u32(6)))
  const tri = Let('tri', p.vid.mod(u32(6)))
  const cx = Let('cx', cell.mod(u32(8)))
  const cy = Let('cy', cell.div(u32(8)))

  const duArr = Let('du_arr', arrayLit(u32T, u32(0), u32(1), u32(0), u32(1), u32(1), u32(0)))
  const dvArr = Let('dv_arr', arrayLit(u32T, u32(0), u32(0), u32(1), u32(0), u32(1), u32(1)))
  const gx = Let('gx', cx.add(duArr.at(tri, u32T)))
  const gy = Let('gy', cy.add(dvArr.at(tri, u32T)))

  const uu = Let('uu', toF32(gx).div(8))
  const vv = Let('vv', toF32(gy).div(8))

  const mercY = Tile.field.merc_y
  const bounds = Tile.field.bounds
  const camEcef = U.field.cam_ecef_center
  const projParams = U.field.proj_params

  // vv=0 → north (offset=diff), vv=1 → south (offset=0). Local offset from tileSouth.
  const mercYOffset = Let('merc_y_offset', f32(1).sub(vv).mul(mercY.y))
  const mercYAbs = Let('merc_y_abs', mercY.x.add(mercYOffset))

  // bounds.x/z are world-copy-shifted (west+wo*360, east+wo*360) so lon
  // naturally lands in the correct world copy. merc_y is copy-independent.
  const lon = Let('lon', mix(bounds.x, bounds.z, uu))
  const latRad = Let('lat_rad', f32(2).mul(atan(exp(mercYAbs))).sub(constRef('PI').div(2)))

  // ECEF path: lon/lat → WGS84 ECEF → subtract tile SW-corner anchor (RTC).
  // Works for every projection because the MVP is always the ECEF frame view
  // (Camera.getECEFFrameView). No per-projection branches needed.
  const lonRad = Let('lon_rad', lon.mul(constRef('DEG2RAD')))
  const ecef = Let('ecef', callFn('lonlat_to_ecef', vec3fT, lonRad, latRad, f32(0)))
  // Camera-relative: ecef − cameraCenter (the MVP is camera-at-ENU-origin).
  const camEcefVec = Let('cam_ecef_vec', vec3(camEcef.x, camEcef.y, camEcef.z))
  const ecefRtc = Let('ecef_rtc', ecef.sub(camEcefVec))

  const out = Var('out', VsOut.type)
  const o = VsOut.of(out)
  // Display projection (projection-display-layer-restore): flat Mercator
  // (proj_params.x < 0.5) reprojects the reconstructed lon/lat onto the 2D
  // plane and feeds the flat Mercator-metre MVP; 3D / globe keeps the ECEF
  // path. For the flat path the renderer writes the 2D camera centre
  // (Mercator metres) into cam_ecef_center.xy — those ECEF lanes are dead
  // there. u.mvp is the matching matrix (Camera.getViewForProjection). f32
  // reprojection ≈ 1 m at extreme zoom (P1), sub-pixel for texture-grade
  // raster.
  const clip = Var('clip', vec4fT)
  If(projParams.x.lt(0.5), () => {
    const latDeg = Let('lat_deg', latRad.div(constRef('DEG2RAD')))
    const p2d = Let('p2d', callFn('project', vec2fT, lon, latDeg, projParams))
    const rel2d = Let('rel2d', p2d.sub(vec2(camEcef.x, camEcef.y)))
    assign(clip, transformMat4(U.field.mvp, vec4(rel2d.x, rel2d.y, f32(0), f32(1))))
  }).elif(projParams.x.lt(6.5), () => {
    // FLAT non-Mercator (1-6): reproject the reconstructed lon/lat via
    // project_geom (world-copy aware; tileRefLon = tile-centre lon from the
    // tile bounds) minus the camera's projected centre (in-shader from
    // proj_params.y/z = clon/clat). Same flat MVP; cam_ecef_center unused here.
    const latDeg = Let('lat_deg_g', latRad.div(constRef('DEG2RAD')))
    const tileRefLon = Let('tile_ref_lon', bounds.x.add(bounds.z).mul(0.5))
    const relG = Let('rel2d_geom', callFn('flat_rel', vec2fT, lon, latDeg, projParams, tileRefLon))
    assign(clip, transformMat4(U.field.mvp, vec4(relG.x, relG.y, f32(0), f32(1))))
  }).else(() => {
    assign(clip, transformMat4(U.field.mvp, vec4(ecefRtc, f32(1))))
  })
  assign(o.pos, callFn('apply_log_depth', vec4fT, clip, projParams.w))
  assign(o.view_w, clip.w)
  assign(o.uv, vec2(uu, vv))
  assign(o.vis, f32(1))
  return out
})

const buildFs = (pickEnabled: boolean) =>
  entryFn('fs_tile', 'fragment', [{ name: 'input', type: VsOut.type }], structT('RasterFragmentOutput'), (p, _b) => {
    const pin = VsOut.of(p.input)
    If(pin.vis.lt(0), () => { Discard() })
    const out = Var('out', structT('RasterFragmentOutput'))
    const c = Let('c', textureSample(tex.node, texSampler.node, pin.uv))
    // Rim alpha fade — input.vis carries (cos_c - threshold); Mercator writes
    // vis=1 so smoothstep is a no-op on flat/cylindrical projections.
    const rim = Let('rim', smoothstep(0, 0.02, pin.vis))
    // raster-* colour adjustments (hue-rotate / brightness / saturation /
    // contrast). Defaults are a hard no-op so an un-authored show is
    // byte-identical to the raw texel rgb.
    const adjRgb = Let('adj_rgb', callFn('raster_color_adjust', vec3fT,
      c.rgb, U.field.raster_color0, U.field.raster_color1))
    // raster-opacity multiplies alpha only (premultiplied blend keeps RGB at
    // texel value, so a half-opacity raster fades rather than darkens).
    assign(out.field('color', vec4fT), vec4(adjRgb, c.a.mul(U.field.raster_params.x).mul(rim)))
    // Basemap tile carries no feature id → always (0,0).
    if (pickEnabled) assign(out.field('pick', vec2uT), vec2u(u32(0), u32(0)))
    assign(out.field('depth', f32T), callFn('compute_log_frag_depth', f32T, pin.view_w, U.field.proj_params.w))
    return out
  })

export const buildRasterModule = (pickEnabled: boolean): ModuleDecl => module({
  structs: [U.struct, Tile.struct, VsOut.decl, rasterFragmentOutput(pickEnabled)],
  bindings: [U.binding, tex.binding, texSampler.binding, Tile.binding],
  funcs: [vs, buildFs(pickEnabled)],
})

/** Full raster shader: ECEF consts + lonlat_to_ecef fn + log-depth fns, then
 *  the raster module (structs + bindings + vs_tile + fs_tile).
 *  `pickEnabled` toggles the pick attachment field + write. */
export const emitRasterWgsl = (pickEnabled: boolean): string => [
  getProjectionWgslConsts(),
  getProjectionWgslFns(),
  ECEF_WGSL_CONSTS,
  ECEF_WGSL_FNS,
  // After ECEF_WGSL_CONSTS — raster_color_adjust reads DEG2RAD_F from it.
  RASTER_COLOR_WGSL_FNS,
  LOG_DEPTH_WGSL_FNS,
  emitModule(buildRasterModule(pickEnabled)),
].join('\n')
