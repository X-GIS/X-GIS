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
  fn, module, transformMat4, arrayLit,
  f32, u32, toF32, vec2, vec3, vec4, vec2u, mix, atan, exp, textureSample, radians, degrees,
  f32T, u32T, vec2fT, vec4fT, vec2uT, mat4x4fT, texture2dfT, samplerT,
  If, when, Discard,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import { ioStruct, builtin, location, uniformStruct, resource } from '@xgis/shader-dsl'
import { emitModule } from '@xgis/shader-dsl'
import { ECEF_CONSTS, ECEF_FUNCS, lonlatToEcef } from './ecef'
import { RASTER_COLOR_FUNCS, rasterColorAdjust } from './raster-color'
import { apply_log_depth, compute_log_frag_depth } from './log-depth'
import { project, flat_rel, needs_backface_cull, rim_alpha, PROJECTION_CONSTS, getGpuProjectionFuncs } from './projections'
import { PI } from './consts'

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
  // #600 — globe(7) eye-horizon cull. xyz = normalize(eye_ecef), w =
  // EARTH_R/|eye_ecef|. The per-fragment cull (#595) passes this to
  // needs_backface_cull / rim_alpha; the globe arm uses the eye-horizon cap
  // (not the pitch-invariant centre hemisphere) — at high pitch the centre cull
  // wrongly dropped eye-visible far-cap raster around the limb. Written by
  // raster-renderer; ALL-ZERO on flat / disc paths (those arms ignore it).
  globe_eye: vec4fT,
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
  abs_lon: location(3, f32T),
  abs_merc_y: location(4, f32T),
})
const rasterFragmentOutput = (pickEnabled: boolean) => ioStruct('RasterFragmentOutput', {
  color: location(0, vec4fT),
  ...(pickEnabled ? { pick: location(1, vec2uT, 'flat') } : {}),
  depth: builtin('frag_depth', f32T),
})

const tex = resource('tex', texture2dfT, { group: 0, binding: 1 })
const texSampler = resource('tex_sampler', samplerT, { group: 0, binding: 2 })

// GRID_N = 8 (an 8×8 subdivided grid, 6 verts/cell = 384; the draw count lives
// in the renderer). Inlined where used.
const vs = fn('vs_tile', { vid: builtin('vertex_index', u32T) }, (p) => {
  const cell = p.vid.div(6)
  const tri = p.vid.mod(6)
  const cx = cell.mod(8)
  const cy = cell.div(8)

  const duArr = arrayLit(u32T, u32(0), u32(1), u32(0), u32(1), u32(1), u32(0))
  const dvArr = arrayLit(u32T, u32(0), u32(0), u32(1), u32(0), u32(1), u32(1))
  const gx = cx.add(duArr.at(tri, u32T))
  const gy = cy.add(dvArr.at(tri, u32T))

  const uu = toF32(gx).div(8)
  const vv = toF32(gy).div(8)

  const mercY = Tile.field.merc_y
  const bounds = Tile.field.bounds
  const camEcef = U.field.cam_ecef_center
  const projParams = U.field.proj_params

  // vv=0 → north (offset=diff), vv=1 → south (offset=0). Local offset from tileSouth.
  const mercYOffset = f32(1).sub(vv).mul(mercY.y)
  const mercYAbs = mercY.x.add(mercYOffset)

  // bounds.x/z are world-copy-shifted (west+wo*360, east+wo*360) so lon
  // naturally lands in the correct world copy. merc_y is copy-independent.
  const lon = mix(bounds.x, bounds.z, uu)
  const latRad = f32(2).mul(atan(exp(mercYAbs))).sub(PI.div(2))

  // ECEF path: lon/lat → WGS84 ECEF → subtract tile SW-corner anchor (RTC).
  // Works for every projection because the MVP is always the ECEF frame view
  // (Camera.getECEFFrameView). No per-projection branches needed.
  const lonRad = radians(lon)
  const ecef = lonlatToEcef(lonRad, latRad, f32(0))
  // Camera-relative: ecef − cameraCenter (the MVP is camera-at-ENU-origin).
  const camEcefVec = vec3(camEcef.x, camEcef.y, camEcef.z)
  const ecefRtc = ecef.sub(camEcefVec)

  const latDeg = degrees(latRad)

  // Display projection (projection-display-layer-restore): flat Mercator
  // (proj_params.x < 0.5) reprojects the reconstructed lon/lat onto the 2D
  // plane and feeds the flat Mercator-metre MVP; 3D / globe keeps the ECEF
  // path. For the flat path the renderer writes the 2D camera centre
  // (Mercator metres) into cam_ecef_center.xy — those ECEF lanes are dead
  // there. u.mvp is the matching matrix (Camera.getViewForProjection). f32
  // reprojection ≈ 1 m at extreme zoom (P1), sub-pixel for texture-grade
  // raster.
  const clip = when([
    [projParams.x.lt(0.5), () => {
      const p2d = project(lon, latDeg, projParams)
      const rel2d = p2d.sub(vec2(camEcef.x, camEcef.y))
      return transformMat4(U.field.mvp, vec4(rel2d.x, rel2d.y, 0, 1))
    }],
    [projParams.x.lt(6.5), () => {
      // FLAT non-Mercator (1-6): reproject the reconstructed lon/lat via
      // project_geom (world-copy aware; tileRefLon = tile-centre lon from the
      // tile bounds) minus the camera's projected centre (in-shader from
      // proj_params.y/z = clon/clat). Same flat MVP; cam_ecef_center unused here.
      const tileRefLon = bounds.x.add(bounds.z).mul(0.5)
      const relG = flat_rel(lon, latDeg, projParams, tileRefLon)
      return transformMat4(U.field.mvp, vec4(relG.x, relG.y, 0, 1))
    }],
  ], () => transformMat4(U.field.mvp, vec4(ecefRtc, 1)))

  // Pass lon (degrees) + mercYAbs (radians) to the fragment stage so it can
  // recompute cos_c per-fragment (#595 fix). vis is a sentinel 1.0; the FS
  // recomputes the true per-fragment cull signal from abs_lon/abs_merc_y.
  return VsOut.construct({
    pos: apply_log_depth(clip, projParams.w),
    uv: vec2(uu, vv),
    vis: f32(1),
    view_w: clip.w,
    abs_lon: lon,
    abs_merc_y: mercYAbs,
  })
}, { stage: 'vertex' })

const buildFs = (pickEnabled: boolean) => {
  const RasterFragmentOutput = rasterFragmentOutput(pickEnabled)
  return fn('fs_tile', { input: VsOut.type }, (p) => {
    const pin = VsOut.of(p.input)

    // Per-fragment hemisphere cull (#595): recompute cos_c from the abs_lon /
    // abs_merc_y varyings rather than relying on the linearly-interpolated vis.
    // cos_c is nonlinear (cosine of a great-circle arc), so bilinear
    // interpolation across a tile corner is a chord — at low zoom (z≤3 tiles
    // span up to 90° lon) the chord error is large enough to leak back-hemisphere
    // raster around the limb. Recomputing per-fragment eliminates that leak.
    // abs_merc_y is the Mercator Y in radians (log(tan(π/4 + lat/2))); the same
    // atan/exp formula the VS uses recovers the geodetic latitude exactly.
    //
    // Mirrors polygon_cos_c_fragment + point_cos_c + line fs_strip recompute.
    // Flat projections (proj_params.x < 2.5) short-circuit inside
    // needs_backface_cull to +1, so there is no per-pixel cost on Mercator /
    // equirect / natural-earth.
    const latRad = f32(2).mul(atan(exp(pin.abs_merc_y))).sub(PI.div(2))
    const latDeg = degrees(latRad)
    const cosC = needs_backface_cull(pin.abs_lon, latDeg, U.field.proj_params, U.field.globe_eye)
    If(cosC.lt(0), () => { Discard() })

    const c = textureSample(tex.node, texSampler.node, pin.uv)
    // Rim alpha fade — use the per-fragment rim_alpha so the fade tracks the
    // true cos_c arc rather than the interpolated chord. Returns 1.0 on flat
    // projections (no regression).
    const rim = rim_alpha(pin.abs_lon, latDeg, U.field.proj_params, U.field.globe_eye)
    // raster-* colour adjustments (hue-rotate / brightness / saturation /
    // contrast). Defaults are a hard no-op so an un-authored show is
    // byte-identical to the raw texel rgb.
    const adjRgb = rasterColorAdjust(c.rgb, U.field.raster_color0, U.field.raster_color1)
    // raster-opacity multiplies alpha only (premultiplied blend keeps RGB at
    // texel value, so a half-opacity raster fades rather than darkens).
    // Basemap tile carries no feature id → always (0,0).
    return RasterFragmentOutput.construct({
      color: vec4(adjRgb, c.a.mul(U.field.raster_params.x).mul(rim)),
      ...(pickEnabled ? { pick: vec2u(0, 0) } : {}),
      depth: compute_log_frag_depth(pin.view_w, U.field.proj_params.w),
    })
  }, { stage: 'fragment' })
}

export const buildRasterModule = (pickEnabled: boolean): ModuleDecl => module({
  // Shared projection + ecef constants merged in (was the getProjectionWgslConsts() /
  // ECEF_WGSL_CONSTS string prepend). emitModule hoists all consts above all funcs, so
  // raster_color_adjust still sees DEG2RAD_F (from ECEF_CONSTS) before its own body.
  consts: [...PROJECTION_CONSTS, ...ECEF_CONSTS],
  structs: [U.struct, Tile.struct, VsOut.decl, rasterFragmentOutput(pickEnabled).decl],
  bindings: [U.binding, tex.binding, texSampler.binding, Tile.binding],
  funcs: [
    // Shared dependency decls, callees first (was the projection / ECEF / raster-color /
    // log-depth WGSL-string prepend): projection → ecef → raster-color → log-depth, then raster.
    ...getGpuProjectionFuncs(),
    ...ECEF_FUNCS,
    ...RASTER_COLOR_FUNCS,
    apply_log_depth, compute_log_frag_depth,
    vs, buildFs(pickEnabled),
  ],
})

/** Full raster shader: one module — shared projection + ecef + raster-color + log-depth
 *  decls merged ahead of the raster structs / bindings / vs_tile / fs_tile.
 *  `pickEnabled` toggles the pick attachment field + write. */
export const emitRasterWgsl = (pickEnabled: boolean): string => emitModule(buildRasterModule(pickEnabled))
