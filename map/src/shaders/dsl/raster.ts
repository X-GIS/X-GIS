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
  fn,
  module,
  transformMat4,
  arrayLit,
  f32,
  u32,
  toF32,
  toU32,
  vec2,
  vec3,
  vec4,
  vec2u,
  mix,
  select,
  abs,
  atan,
  exp,
  textureSample,
  radians,
  degrees,
  f32T,
  u32T,
  vec2fT,
  vec4fT,
  vec2uT,
  mat4x4fT,
  texture2dfT,
  samplerT,
  If,
  when,
  Discard,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import { ioStruct, builtin, location, uniformStruct, resource } from '@xgis/shader-dsl'
import { emitModule } from '@xgis/shader-dsl'
import { isGlobeProj } from '@xgis/geo'
import { ECEF_CONSTS, lonlatToEcef } from './ecef'
import { rasterColorAdjust } from './raster-color'
import { apply_log_depth, compute_log_frag_depth } from './log-depth'
import {
  project,
  flat_rel,
  needs_backface_cull,
  rim_alpha,
  PROJECTION_CONSTS,
  getGpuProjectionFuncs,
} from './projections'
import { PI } from './consts'

const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'u' },
  {
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
    // Camera-relative RTC anchor, DSFUN hi/lo (the raster analogue of polygon's
    // cam_ecef_off_h/l and line's cam_h/cam_l). cam_ecef_center is the HIGH f32
    // half, cam_ecef_center_l the LOW half, of the camera anchor the VS subtracts:
    //   • flat Mercator (projType 0): .xy = the 2D Mercator camera centre
    //     [centerX, centerY]; the flat arm forms rel = (p2d − hi.xy) − lo.xy.
    //   • globe / 3D (projType 7): .xyz = the WGS84 ELLIPSOID camera ECEF
    //     (rasterGlobeCamAnchor); the ECEF arm forms (ecef − hi) − lo.
    // The single f32 anchor this REPLACED quantised the camera to an ~0.76 m grid
    // (f32 ULP at |ECEF| ≈ 6.4e6 m); as the camera panned that rounding danced
    // frame-to-frame and the whole tile sheet SHOOK at z18+ over-zoom. Subtracting
    // the anchor in df64 (hi FIRST — Sterbenz-exact against the ~6.4e6 m vertex —
    // then lo) narrows the small camera-relative result AFTER the cancellation,
    // killing the jitter: the same subtract-then-narrow discipline as the
    // shader-dsl fp64-rtc example. Both lanes' .w are spare (0). Was: "raster is
    // texture-grade, so plain f32 is sufficient" — the shortcut that shook.
    cam_ecef_center: vec4fT,
    cam_ecef_center_l: vec4fT,
    // #600 — globe(7) eye-horizon cull. xyz = normalize(eye_ecef), w =
    // EARTH_R/|eye_ecef|. The per-fragment cull (#595) passes this to
    // needs_backface_cull / rim_alpha; the globe arm uses the eye-horizon cap
    // (not the pitch-invariant centre hemisphere) — at high pitch the centre cull
    // wrongly dropped eye-visible far-cap raster around the limb. Written by
    // raster-renderer; ALL-ZERO on flat / disc paths (those arms ignore it).
    globe_eye: vec4fT,
  },
)
const Tile = uniformStruct(
  'TileUniforms',
  { group: 1, binding: 0, as: 'tile' },
  {
    bounds: vec4fT, // west, south, east, north (degrees); x/z shifted per world-copy
    tile_ecef_center: vec4fT, // xyz = ECEF of tile SW corner (world-copy unshifted); w = 0
    merc_y: vec2fT, // x = merc_south (abs), y = merc_diff (north - south)
    // #1040 — x = raster grid subdivision N as f32 (exact for N ≤ 128), packed
    // by rasterGridN(projType, tileZoom); y reserved (kept 0). Was a dead `_pad`
    // vec2 — the vec2+vec2 byte layout is unchanged so the 48 B slot is stable.
    grid: vec2fT,
  },
)
// Exported (distinct barrel names — every dsl file calls its struct 'U'/'Tile'
// locally) for the renderer's UniformBlock (#733 P2): the CPU packers derive
// their typed write surfaces from the SAME declarations the WGSL is emitted from.
export { U as rasterU, Tile as rasterTileU }
const VsOut = ioStruct('VsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
  vis: location(1, f32T),
  view_w: location(2, f32T),
  abs_lon: location(3, f32T),
  abs_merc_y: location(4, f32T),
})
const rasterFragmentOutput = (pickEnabled: boolean) =>
  ioStruct('RasterFragmentOutput', {
    color: location(0, vec4fT),
    ...(pickEnabled ? { pick: location(1, vec2uT, 'flat') } : {}),
    depth: builtin('frag_depth', f32T),
  })

const tex = resource('tex', texture2dfT, { group: 0, binding: 1 })
const texSampler = resource('tex_sampler', samplerT, { group: 0, binding: 2 })

// ═══ #1040 — globe raster surface density ladder (userbug-09 sibling) ═══
//
// The raster surface is a procedural N×N grid (6 verts/cell, from vertex_index —
// no vertex buffer). N was a compile-time literal 8, so a z0 whole-world globe
// tile drew the SAME 8×8 as a z18 tile — the z0 sphere silhouette was a visible
// ~16-gon. This is the exact defect the synthetic earth-surface fill already
// fixed (data/src/sources/synthetic-earth-surface-backend.ts raised its lon/lat
// mesh 32×16 → 128×64 to de-facet the disc rim, userbug 09); it was never ported
// to the raster grid. On the GLOBE the per-tile N now HALVES per zoom
// (z0:128, z1:64, z2:32, z3:16, z4+:8) so each tile's angular span carries a
// roughly constant curvature error; 128 matches the proven earth-surface
// density. FLAT projections keep 8×8 (a plane needs no curvature subdivision) —
// surgical, no flat-path change. N is threaded to the shader per-tile via
// TileUniforms.grid.x (below), and the per-tile draw count = rasterGridVertexCount(N).
export function rasterGridN(projType: number, tileZoom: number): number {
  // isGlobeProj = the projections-table membership accessor (geo/src/projections-table.ts):
  // dispatch routes through the isGlobe row, never a raw `projType === 7` — the #996
  // projtype-confinement ratchet forbids the literal here. Every other projType is a flat
  // path and keeps the flat 8×8. `128 >> zoom` halves per level; the Math.max floors the
  // ladder at 8 (z4+), Math.min caps it at 128 (z0).
  return isGlobeProj(projType) ? Math.max(8, Math.min(128, 128 >> tileZoom)) : 8
}

/** Vertex count for an N×N raster surface grid: 2 triangles (6 verts) per cell. */
export function rasterGridVertexCount(n: number): number {
  return n * n * 6
}

// ═══ #1053 — globe raster pole cap ═══
//
// SINGLE AUTHORITY (DSL fn → CPU-evaluable) for the polar-cap geometry vs_tile
// generates when the renderer marks a tile a cap (TileUniforms.grid.y = ±1 for
// the topmost / bottommost GLOBE tile row). The cap reuses THIS tile's N×N grid
// draw — same material, same vertex count — but remaps the rows from the tile's
// ±85.0511° Web-Mercator band edge up to the geographic pole, closing the polar
// hole the Mercator surface structurally cannot reach. It mirrors the vector
// side (synthetic-earth-surface / GeoJSON polar-cap backends), which likewise
// fans converging pole vertices, and MapLibre's globe pole-gradient: texture V
// is clamped to the band edge (the topmost/bottommost Mercator texel row) while
// U still sweeps longitude, so the cap stretches that edge row to the pole.
//
// Returns vec3(cap_lat_rad, cap_v, edge_merc_y):
//   • cap_lat_rad — the vertex latitude (rad). Row vv increases SOUTHWARD, so
//     the north cap places the pole at vv=0 and the edge at vv=1, the south cap
//     the reverse — one winding, inherited byte-for-byte from the surface grid.
//   • cap_v       — texture V clamped to the band edge: 0 (north / top row) or
//     1 (south / bottom row); independent of vv (the "clamp" of the policy).
//   • edge_merc_y — the band-edge Mercator-Y (±… the tile's own north/south
//     edge). The pole is not Mercator-representable, so the fragment hemisphere
//     cull reads THIS (clamped) value, mirroring the vector caps.
export const rasterCapParams = fn(
  'raster_cap_params',
  { vv: f32T, merc_south: f32T, merc_diff: f32T, cap_sign: f32T },
  (p) => {
    // f = 1 for a NORTH cap (cap_sign +1), 0 for SOUTH (cap_sign −1).
    const f = p.cap_sign.add(1).mul(0.5)
    // Band-edge Mercator-Y: north clamps to the tile's NORTH edge (merc_south +
    // merc_diff), south to its SOUTH edge (merc_south). Reconstructing the edge
    // latitude from the SAME merc_y the ground tile carries makes the cap ring
    // coincide with the tile edge EXACTLY — crack-free, no MERC_LIMIT literal.
    const edgeMercY = p.merc_south.add(p.merc_diff.mul(f))
    const edgeLat = f32(2)
      .mul(atan(exp(edgeMercY)))
      .sub(PI.div(2))
    // Geographic pole: cap_sign · 90° (rad). lonlat_to_ecef(any lon, ±90°)
    // collapses to (0,0,±b) — the converging pole vertices.
    const poleLat = p.cap_sign.mul(PI.div(2))
    // t: 0 at the band edge → 1 at the pole. Row vv increases SOUTHWARD, so the
    // north cap fans from vv=1 (edge) to vv=0 (pole) [t = 1−vv] and the south
    // cap the reverse [t = vv] — one winding, inherited from the surface grid.
    const t = mix(p.vv, f32(1).sub(p.vv), f)
    const capLat = mix(edgeLat, poleLat, t)
    // Texture V clamped to the band edge: 0 (north/top row), 1 (south/bottom).
    const capV = f32(1).sub(f)
    return vec3(capLat, capV, edgeMercY)
  },
)

const vs = fn(
  'vs_tile',
  { vid: builtin('vertex_index', u32T) },
  (p) => {
    // Per-tile grid N (#1040): TileUniforms.grid.x carries N as f32 (exact ≤128).
    // The integer cell split needs a u32 N (cast once); the uv normalise divides
    // by the f32 N directly. globe z0 → 128×128; flat / high-z → 8×8.
    const gridNF = Tile.field.grid.x
    const gridNU = toU32(gridNF)
    const cell = p.vid.div(6)
    const tri = p.vid.mod(6)
    const cx = cell.mod(gridNU)
    const cy = cell.div(gridNU)

    const duArr = arrayLit(u32T, u32(0), u32(1), u32(0), u32(1), u32(1), u32(0))
    const dvArr = arrayLit(u32T, u32(0), u32(0), u32(1), u32(0), u32(1), u32(1))
    const gx = cx.add(duArr.at(tri, u32T))
    const gy = cy.add(dvArr.at(tri, u32T))

    const uu = toF32(gx).div(gridNF)
    const vv = toF32(gy).div(gridNF)

    const mercY = Tile.field.merc_y
    const bounds = Tile.field.bounds
    const camEcef = U.field.cam_ecef_center // DSFUN high half
    const camEcefL = U.field.cam_ecef_center_l // DSFUN low half
    const projParams = U.field.proj_params

    // vv=0 → north (offset=diff), vv=1 → south (offset=0). Local offset from tileSouth.
    const mercYOffset = f32(1).sub(vv).mul(mercY.y)
    const mercYAbs = mercY.x.add(mercYOffset)

    // bounds.x/z are world-copy-shifted (west+wo*360, east+wo*360) so lon
    // naturally lands in the correct world copy. merc_y is copy-independent.
    const lon = mix(bounds.x, bounds.z, uu)
    const normalLatRad = f32(2)
      .mul(atan(exp(mercYAbs)))
      .sub(PI.div(2))

    // #1053 — pole cap: a cap tile (grid.y = ±1, packed by the renderer for the
    // topmost/bottommost GLOBE tile row) fans the ±85.0511° Mercator band edge to
    // the geographic pole, reusing this grid draw. capSign 0 (every ground tile)
    // keeps select() on the byte-identical Mercator path — no globe/flat change.
    const capSign = Tile.field.grid.y
    // capSign is an exact 0 / ±1 lane; test "is a cap" with a THRESHOLD (mirrors
    // the proj_params.x .lt(0.5) float-flag idiom) — never float '==' (no-float-eq).
    const isCap = abs(capSign).gt(f32(0.5))
    const capP = rasterCapParams({
      vv,
      merc_south: mercY.x,
      merc_diff: mercY.y,
      cap_sign: capSign,
    })
    const latRad = select(isCap, capP.x, normalLatRad)
    const vTex = select(isCap, capP.y, vv)
    const absMercY = select(isCap, capP.z, mercYAbs)

    // ECEF path: lon/lat → WGS84 ECEF → subtract tile SW-corner anchor (RTC).
    // Works for every projection because the MVP is always the ECEF frame view
    // (Camera.getECEFFrameView). No per-projection branches needed.
    const lonRad = radians(lon)
    const ecef = lonlatToEcef({ lon_rad: lonRad, lat_rad: latRad, height: f32(0) })
    // Camera-relative: ecef − cameraCenter (the MVP is camera-at-ENU-origin).
    // DSFUN two-term subtract: (ecef − hi) is Sterbenz-exact (both ~6.4e6 m), then
    // − lo narrows the small result AFTER cancellation, so the camera's f32
    // rounding no longer dances as it pans — no z18+ shake. Was `ecef − hi` alone.
    const camEcefVec = vec3(camEcef.x, camEcef.y, camEcef.z)
    const camEcefLVec = vec3(camEcefL.x, camEcefL.y, camEcefL.z)
    const ecefRtc = ecef.sub(camEcefVec).sub(camEcefLVec)

    const latDeg = degrees(latRad)

    // Display projection (projection-display-layer-restore): flat Mercator
    // (proj_params.x < 0.5) reprojects the reconstructed lon/lat onto the 2D
    // plane and feeds the flat Mercator-metre MVP; 3D / globe keeps the ECEF
    // path. For the flat path the renderer writes the 2D camera centre
    // (Mercator metres) into cam_ecef_center.xy — those ECEF lanes are dead
    // there. u.mvp is the matching matrix (Camera.getViewForProjection). f32
    // reprojection ≈ 1 m at extreme zoom (P1), sub-pixel for texture-grade
    // raster.
    const clip = when(
      [
        [
          projParams.x.lt(0.5),
          () => {
            const p2d = project(lon, latDeg, projParams)
            // DSFUN two-term subtract of the 2D Mercator camera centre (hi .xy,
            // lo .xy): (p2d − hi) is Sterbenz-exact (both ~6.1e6 m), then − lo
            // narrows after cancellation, so the camera no longer snaps to the
            // f32 grid and jitters as it pans. Was `p2d − hi.xy` alone.
            const rel2d = p2d.sub(vec2(camEcef.x, camEcef.y)).sub(vec2(camEcefL.x, camEcefL.y))
            return transformMat4(U.field.mvp, vec4(rel2d.x, rel2d.y, 0, 1))
          },
        ],
        [
          projParams.x.lt(6.5),
          () => {
            // FLAT non-Mercator (1-6): reproject the reconstructed lon/lat via
            // project_geom (world-copy aware; tileRefLon = tile-centre lon from the
            // tile bounds) minus the camera's projected centre (in-shader from
            // proj_params.y/z = clon/clat). Same flat MVP; cam_ecef_center unused here.
            const tileRefLon = bounds.x.add(bounds.z).mul(0.5)
            const relG = flat_rel(lon, latDeg, projParams, tileRefLon)
            return transformMat4(U.field.mvp, vec4(relG.x, relG.y, 0, 1))
          },
        ],
      ],
      () => transformMat4(U.field.mvp, vec4(ecefRtc, 1)),
    )

    // Pass lon (degrees) + mercYAbs (radians) to the fragment stage so it can
    // recompute cos_c per-fragment (#595 fix). vis is a sentinel 1.0; the FS
    // recomputes the true per-fragment cull signal from abs_lon/abs_merc_y.
    return VsOut.construct({
      pos: apply_log_depth({ pos: clip, fc: projParams.w }),
      uv: vec2(uu, vTex),
      vis: f32(1),
      view_w: clip.w,
      abs_lon: lon,
      abs_merc_y: absMercY,
    })
  },
  { stage: 'vertex' },
)

const buildFs = (pickEnabled: boolean) => {
  const RasterFragmentOutput = rasterFragmentOutput(pickEnabled)
  return fn(
    'fs_tile',
    { input: VsOut },
    (p) => {
      const pin = p.input

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
      const latRad = f32(2)
        .mul(atan(exp(pin.abs_merc_y)))
        .sub(PI.div(2))
      const latDeg = degrees(latRad)
      const cosC = needs_backface_cull(pin.abs_lon, latDeg, U.field.proj_params, U.field.globe_eye)
      If(cosC.lt(0), () => {
        Discard()
      })

      const c = textureSample(tex.node, texSampler.node, pin.uv)
      // Rim alpha fade — use the per-fragment rim_alpha so the fade tracks the
      // true cos_c arc rather than the interpolated chord. Returns 1.0 on flat
      // projections (no regression).
      const rim = rim_alpha(pin.abs_lon, latDeg, U.field.proj_params, U.field.globe_eye)
      // raster-* colour adjustments (hue-rotate / brightness / saturation /
      // contrast). Defaults are a hard no-op so an un-authored show is
      // byte-identical to the raw texel rgb.
      const adjRgb = rasterColorAdjust({
        rgb_in: c.rgb,
        p0: U.field.raster_color0,
        p1: U.field.raster_color1,
      })
      // raster-opacity multiplies alpha only (premultiplied blend keeps RGB at
      // texel value, so a half-opacity raster fades rather than darkens).
      // Basemap tile carries no feature id → always (0,0).
      return RasterFragmentOutput.construct({
        color: vec4(adjRgb, c.a.mul(U.field.raster_params.x).mul(rim)),
        ...(pickEnabled ? { pick: vec2u(0, 0) } : {}),
        depth: compute_log_frag_depth({ view_w: pin.view_w, fc: U.field.proj_params.w }),
      })
    },
    { stage: 'fragment' },
  )
}

export const buildRasterModule = (pickEnabled: boolean): ModuleDecl =>
  module({
    // Shared projection + ecef constants merged in (was the getProjectionWgslConsts() /
    // ECEF_WGSL_CONSTS string prepend). emitModule hoists all consts above all funcs, so
    // raster_color_adjust still sees DEG2RAD_F (from ECEF_CONSTS) before its own body.
    consts: [...PROJECTION_CONSTS, ...ECEF_CONSTS],
    structs: [U.struct, Tile.struct, VsOut.decl, rasterFragmentOutput(pickEnabled).decl],
    bindings: [U.binding, tex.binding, texSampler.binding, Tile.binding],
    funcs: [
      // Injection seam ONLY (#740 R1): the projection fns are extern-called (no
      // declRef) so module() cannot auto-collect them. ECEF / raster-color /
      // log-depth are handle-called and collected callee-first automatically.
      ...getGpuProjectionFuncs(),
      vs,
      buildFs(pickEnabled),
    ],
  })

/** Full raster shader: one module — shared projection + ecef + raster-color + log-depth
 *  decls merged ahead of the raster structs / bindings / vs_tile / fs_tile.
 *  `pickEnabled` toggles the pick attachment field + write. */
export const emitRasterWgsl = (pickEnabled: boolean): string =>
  emitModule(buildRasterModule(pickEnabled))

// ═══ #777 Phase II — shared tile-grid vertex authority ═══
//
// vs_tile (the procedural N×N grid + per-projection dispatch + pole-cap fan) is
// the SINGLE authority for placing a tile surface in every projection. The
// hillshade shader (shaders/dsl/hillshade.ts) is structurally a raster tile draw
// with a different fragment (DEM decode → Sobel → shade), so it reuses THIS
// vertex + VsOut + the DEM texture/sampler bindings verbatim — a projection fix
// then lands once. Exported alongside rasterU / rasterTileU (the vertex uniform
// structs) so hillshade binds the same group-0/group-1 vertex layout and INC-3
// can reuse rasterUniformSlots()/rasterTileSlots() for the shared write surface.
export {
  vs as rasterVsTile,
  VsOut as rasterVsOut,
  tex as rasterTex,
  texSampler as rasterTexSampler,
}
