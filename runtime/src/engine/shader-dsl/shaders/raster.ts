// ═══ Shader DSL — raster tile shader (Phase 2) ═══
//
// Re-authors render/raster-renderer.ts RASTER_SHADER_SOURCE. The vertex stage
// generates a procedural N×N grid (vertex_index, no vertex buffer), recovers
// lon/lat from the tile's Mercator-Y span, and projects per the active
// projection: a Mercator/equirect RTC fast path, a true-3D-globe branch, and a
// generic project_geom branch with per-projection backface cull. The fragment
// samples the tile texture, applies raster-opacity + a rim-alpha fade, and
// writes log-depth.
//
// The shared projection + log-depth math is NOT re-authored here — it is the
// same DSL-emitted WGSL the other renderers use (PROJECTION_WGSL_CONSTS/FNS,
// LOG_DEPTH_WGSL_FNS), prepended by emitRasterWgsl so this module's vs/fs can
// call proj_globe / project_geom / center_cos_c / apply_log_depth /
// compute_log_frag_depth and reference PI / DEG2RAD / EARTH_R.
//
// Pick variant: the pick attachment field + write are conditionally emitted
// (replacing the old __PICK_FIELD__ / __PICK_WRITE__ string markers); raster
// always writes (0,0) since a basemap tile carries no feature id.

import {
  entryFn, module, bindingRef, constRef, callFn, transformMat4, arrayLit,
  f32, u32, toF32, vec2, vec4, vec2u, mix, atan, exp, smoothstep, textureSample,
  structT, f32T, u32T, vec2fT, vec3fT, vec4fT, vec2uT, mat4x4fT, texture2dfT, samplerT,
  type StructDecl, type StructField, type ModuleDecl,
} from '../core/ir'
import { emitModule } from '../core/backends/wgsl'
import { PROJECTION_WGSL_CONSTS, PROJECTION_WGSL_FNS } from './projections'
import { LOG_DEPTH_WGSL_FNS } from './log-depth'

const Uniforms: StructDecl = {
  name: 'Uniforms',
  fields: [
    { name: 'mvp', type: mat4x4fT },
    // proj_params: x=type, y=centerLon, z=centerLat, w=log_depth_fc
    { name: 'proj_params', type: vec4fT },
    // raster_params: x=opacity (0..1), yzw reserved (gamma/brightness/contrast)
    { name: 'raster_params', type: vec4fT },
  ],
}
const TileUniforms: StructDecl = {
  name: 'TileUniforms',
  fields: [
    { name: 'bounds', type: vec4fT },     // west, south, east, north (degrees)
    { name: 'tile_rtc', type: vec4fT },   // xy = project(tileWest,tileSouth) - project(camera); z = tileWest; w = tileSouth
    { name: 'merc_y', type: vec2fT },     // x = merc_south (abs), y = merc_diff (north - south)
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
  const tileRtc = tile.field('tile_rtc', vec4fT)
  const projParams = u.field('proj_params', vec4fT)

  // vv=0 → north (offset=diff), vv=1 → south (offset=0). Local offset from tileSouth.
  const mercYOffset = b.let('merc_y_offset', f32(1).sub(vv).mul(mercY.y))
  const mercYAbs = b.let('merc_y_abs', mercY.x.add(mercYOffset))

  const lon = b.let('lon', mix(bounds.x, bounds.z, uu))
  const latRad = b.let('lat_rad', f32(2).mul(atan(exp(mercYAbs))).sub(constRef('PI').div(2)))
  const lat = b.let('lat', latRad.div(constRef('DEG2RAD')))

  const localLon = b.let('local_lon', lon.sub(tileRtc.z))
  const originLat = b.let('origin_lat', tileRtc.w)
  const localX = b.let('local_x', localLon.mul(constRef('DEG2RAD')).mul(constRef('EARTH_R')))

  const localY = b.var('local_y', f32T)
  const t = b.let('t', projParams.x)

  // True 3D globe (projType 7): sphere RTC against the focus point + orbit MVP.
  b.if(t.gt(6.5), (c) => {
    const g = c.let('g', callFn('proj_globe', vec3fT, lon, lat).sub(callFn('proj_globe', vec3fT, projParams.y, projParams.z)))
    const go = c.var('go', structT('VsOut'))
    const gclip = c.let('gclip', transformMat4(u.field('mvp', mat4x4fT), vec4(g, f32(1))))
    c.assign(go.field('pos', vec4fT), callFn('apply_log_depth', vec4fT, gclip, projParams.w))
    c.assign(go.field('view_w', f32T), gclip.w)
    c.assign(go.field('uv', vec2fT), vec2(uu, vv))
    c.assign(go.field('vis', f32T), callFn('center_cos_c', f32T, lon, lat, projParams.y, projParams.z))
    c.ret(go)
  })

  b.if(t.lt(0.5), (c) => {
    // Mercator: linear in Mercator Y — offset already relative to tileSouth.
    c.assign(localY, mercYOffset.mul(constRef('EARTH_R')))
  }).elif(t.lt(1.5), (c) => {
    // Equirectangular
    c.assign(localY, lat.sub(originLat).mul(constRef('DEG2RAD')).mul(constRef('EARTH_R')))
  }).else((c) => {
    // Other projections: project absolute then subtract origin, with the tile-
    // centre longitude as the unwrap reference so a clon±180 seam stays
    // contiguous. The CPU tile_rtc SW corner uses the matching reference, so
    // this telescopes exactly.
    const refLon = c.let('ref_lon', bounds.x.add(bounds.z).mul(0.5))
    const projected = c.let('projected', callFn('project_geom', vec2fT, lon, lat, projParams, refLon))
    const originProjected = c.let('origin_projected', callFn('project_geom', vec2fT, tileRtc.z, originLat, projParams, refLon))
    const rtcOther = c.let('rtc_other', projected.sub(originProjected).add(vec2(tileRtc.x, tileRtc.y)))
    const out = c.var('out', structT('VsOut'))
    const clipOther = c.let('clip_other', transformMat4(u.field('mvp', mat4x4fT), vec4(rtcOther, f32(0), f32(1))))
    c.assign(out.field('pos', vec4fT), callFn('apply_log_depth', vec4fT, clipOther, projParams.w))
    c.assign(out.field('view_w', f32T), clipOther.w)
    c.assign(out.field('uv', vec2fT), vec2(uu, vv))
    // Per-projection cull threshold, inlined (the WGSL compiler can't fold the
    // switch inside needs_backface_cull on a uniform read — measurable on
    // raster-heavy frames). ortho=0, azimuthal=-0.85, stereo=-0.8, oblique_merc
    // never culls (vis=+1).
    const threshold = c.var('threshold', f32T, f32(0))
    c.if(t.gt(3.5).and(t.lt(4.5)), (d) => { d.assign(threshold, f32(-0.85)) })
      .elif(t.gt(4.5).and(t.lt(5.5)), (d) => { d.assign(threshold, f32(-0.8)) })
      .elif(t.gt(5.5).and(t.lt(6.5)), (d) => {
        d.assign(out.field('vis', f32T), f32(1))
        d.ret(out)
      })
    c.assign(out.field('vis', f32T), callFn('center_cos_c', f32T, lon, lat, projParams.y, projParams.z).sub(threshold))
    c.ret(out)
  })

  // Mercator / equirect fall-through. tile_rtc.xy = project(tileW,tileS) - project(camera) (CPU f64).
  const rtc = b.let('rtc', vec2(localX.add(tileRtc.x), localY.add(tileRtc.y)))
  const out = b.var('out', structT('VsOut'))
  const clip = b.let('clip', transformMat4(u.field('mvp', mat4x4fT), vec4(rtc, f32(0), f32(1))))
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

/** Full raster shader: the shared DSL-emitted projection consts + log-depth fns
 *  + projection fns, then the raster module (structs + bindings + vs_tile +
 *  fs_tile). `pickEnabled` toggles the pick attachment field + write. */
export const emitRasterWgsl = (pickEnabled: boolean): string => [
  PROJECTION_WGSL_CONSTS,
  LOG_DEPTH_WGSL_FNS,
  PROJECTION_WGSL_FNS,
  emitModule(buildRasterModule(pickEnabled)),
].join('\n')
