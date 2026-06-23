// ═══ Shader DSL — polygon shader (Phase 2.5 US-007b) ═══
//
// Re-authors render/renderer-shaders.ts POLYGON_SHADER_SOURCE (826 LOC).
// The polygon shader is the variant-codegen-heavy fill / stroke / extrude
// pipeline: 1 Uniforms struct (256 bytes; reused by stroke + extrude paths
// via field aliasing), 3 fixed bindings (u, sprite_atlas, sprite_samp),
// 3 vertex entries (vs_main / vs_main_ecef / vs_main_ecef_extruded)
// and 6 fragment entries (fs_fill / fs_fill_pattern / fs_oit_translucent /
// fs_fill_extrude / fs_stroke / fs_overdraw).
//
// Pattern: emitPolygonWgsl(variant, pickEnabled) MERGES the shared projection +
// log-depth dependency decls (PROJECTION_CONSTS + getGpuProjectionFuncs() +
// apply_log_depth/compute_log_frag_depth) into the polygon ModuleDecl and emits it as
// ONE module — no string prepend (the old WGSL_PROJECTION_CONSTS/FNS + LOG_DEPTH string
// concat). The variant's preamble + fill/stroke exprs compose on top. fs_fill / fs_stroke contain
// placeholder Stmts (tags 'fill-return' / 'stroke-return') that the composer
// swaps with `[...preamble, return expr]` when the variant injects custom
// fill/stroke logic; bare placeholders survive as `// __placeholder: ...`
// comments per US-007a's defensive design.
//
// `pickEnabled` toggles the pick attachment field + writes (replaces the
// old __PICK_FIELD__ / __PICK_WRITE__ regex markers in POLYGON_SHADER_SOURCE).

import {
  fn, module, constRef, callFn,
  Let, Var, If, Return, Discard,
  f32, u32, vec2, vec2u, vec3, vec4, toF32, toU32, transformMat4, clamp, select,
  abs, fract, max, min, mix, pow, sqrt, dot, log, tan, floor, textureSample, unpack4x8unorm,
  f32T, u32T, vec2fT, vec3fT, vec4fT, vec2uT, vec4uT, mat4x4fT, texture2dfT, samplerT,
  Node, Builder, arrayT,
  type ModuleDecl, type Stmt, type BindingDecl,
} from '../core/ir'
import { ioStruct, builtin, location, uniformStruct, resource } from '../core/sot'
import { emitModule, emitFunc } from '../core/backends/wgsl'
import { project, flat_rel, needs_backface_cull, rim_alpha, inv_merc_lat_rad, PROJECTION_CONSTS, getGpuProjectionFuncs } from './projections'
import { apply_log_depth, compute_log_frag_depth } from './log-depth'

// ── Struct declarations ──
//
// Field order + names match POLYGON_SHADER_SOURCE byte-for-byte; the 256-byte
// uniform layout (UNIFORM_SIZE in vector-tile-renderer.ts) is consumed by every
// polygon variant + by every per-tile
// uniform writeBuffer caller in renderer.ts / vector-tile-renderer.ts, so any
// reordering would silently mis-bind the GPU read.

const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'u' }, {
  // Phase 2 PR 2d.5 closeout: legacy Mercator-RTC `mvp` retired — `mvp`
  // now holds the ECEF-MVP from Camera.getECEFFrameView() (was previously
  // the second slot `mvp_ecef`). Every polygon VS consumes ECEF; the dual
  // slot is gone (that removal shrank the struct; later fields re-grew it to
  // its current 256 bytes — UNIFORM_SIZE in vector-tile-renderer.ts).
  mvp: mat4x4fT,
  fill_color: vec4fT,
  stroke_color: vec4fT,
  proj_params: vec4fT,
  cam_h: vec2fT,
  cam_l: vec2fT,
  tile_origin_merc: vec2fT,
  opacity: f32T,
  log_depth_fc: f32T,
  pick_id: u32T,
  layer_depth_offset: f32T,
  tile_extent_m: f32T,
  extrude_height_m: f32T,
  clip_bounds: vec4fT,
  zoom: f32T,
  extrude_base_m: f32T,
  fill_translate_x: f32T,
  fill_translate_y: f32T,
  // Phase 2 PR 2f — per-tile quantized-position dequant. The VS decodes
  // ecef_rtc per axis as `q = f32(hi)*65536 + f32(lo);
  // axis = q*tile_dequant_scale - tile_dequant_half`. Written per tile
  // alongside cam_h/tile_origin_merc in vector-tile-renderer.
  tile_dequant_scale: f32T,
  tile_dequant_half: f32T,
  // WS-9 — fill-extrusion light colour packed RGBA8 (offset 200, slot 50).
  // These two u32 lanes exactly fill the 8-byte pad WGSL otherwise inserts
  // here to 16-align the cam_ecef_off_h vec4 below, so the struct size —
  // and thus UNIFORM_SIZE / UNIFORM_SLOT — stay 256 (no buffer growth).
  // The extrude VS unpacks light_color_packed + reads intensity from
  // light_dir_ecef.w; every other polygon variant ignores both fields.
  light_color_packed: u32T,
  _pad_light_align: u32T,
  // Camera-relative RTC re-centering (ECEF), DSFUN hi/lo. dequant yields
  // ecef_rtc = vertex − tileEcefCenter, but getECEFFrameView's MVP is
  // camera-at-ENU-origin (no cameraCenter translate), so the VS must feed
  // vertex − cameraCenter. off = tileEcefCenter − cameraCenter, split hi/lo;
  // ecef_rtc + off = vertex − cameraCenter. Without it every tile collapses
  // to the camera origin (verified by _ecef-render-position). The ECEF
  // analogue of line.ts's cam_h/cam_l.
  cam_ecef_off_h: vec4fT,
  cam_ecef_off_l: vec4fT,
  // #420 — fill-extrusion directional light in ECEF (.xyz; .w spare). The
  // extrude VS dots it against the per-vertex ECEF face_normal, so it must
  // share that frame. The raw MapLibre light (0.288,-0.498,0.996) is a
  // tile/viewport-frame constant; dotting it against an ECEF normal gave
  // arbitrary per-face brightness. The CPU packs it as (East,North,Up)
  // rotated by the camera-anchor ENU→ECEF basis (vector-tile-renderer),
  // matching polygon-mesh.ts's normal basis.
  light_dir_ecef: vec4fT,
})
const Uniforms = U.struct

const VertexOutputIO = ioStruct('VertexOutput', {
  position: builtin('position', vec4fT),
  cos_c: location(0, f32T),
  feat_id: location(1, u32T, 'flat'),
  abs_lat: location(2, f32T),
  view_w: location(3, f32T),
  wall_blend: location(4, f32T),
  abs_merc_x: location(5, f32T),
  abs_merc_y: location(6, f32T),
  world_z: location(7, f32T),
  v_color: location(8, vec4fT),
})
const VertexOutput = VertexOutputIO.decl

const OitFragmentOutput = ioStruct('OitFragmentOutput', {
  accum: location(0, vec4fT),
  revealage: location(1, f32T),
})

/** FragmentOutput's `pick` field is conditional on the polygon pipeline carrying
 *  a pick attachment — same plumbing as line.ts's lineFragmentOutput. */
const polygonFragmentOutput = (pickEnabled: boolean) => ioStruct('FragmentOutput', {
  color: location(0, vec4fT),
  ...(pickEnabled ? { pick: location(1, vec2uT, 'flat') } : {}),
  depth: builtin('frag_depth', f32T),
})

// ── Binding refs ──
//
// Polygon fixed bindings (matching renderer-shaders.ts 124-132):
//   @group(0) @binding(0) var<uniform> u: Uniforms;
//   @group(0) @binding(5) var sprite_atlas: texture_2d<f32>;
//   @group(0) @binding(6) var sprite_samp: sampler;
// Variant bindings (palette atlas at binding 1-4, scalar atlas at binding 2-3,
// compute output buffers via @group(2), feat_data via @group(1) @binding(0))
// land via the variant's `preamble.bindings` array.

const spriteAtlasRes = resource('sprite_atlas', texture2dfT, { group: 0, binding: 5 })
const spriteSampRes = resource('sprite_samp', samplerT, { group: 0, binding: 6 })
const spriteAtlas = spriteAtlasRes.node
const spriteSamp = spriteSampRes.node

// ── Helper fns ──
//
// Per-fragment recompute of the hemisphere-cull signal. The vertex shader
// emits cos_c as a varying but linear interpolation across a triangle
// spanning the visibility boundary diverges — recompute from the absolute-
// Mercator varyings (which telescope exactly under linear interpolation)
// and call the shared needs_backface_cull entry that the vertex path uses.
//
// Cost: 1 atan + 1 exp + a few muls per fragment in the cull path.
// Flat projections (proj_params.x < 2.5) short-circuit inside
// needs_backface_cull to +1 so the per-pixel cost stays at ~0 for the
// common Mercator / equirect / natural-earth cases.
//
// Pattern mirrors line-renderer.ts:779 and point-renderer.ts:340.

const polygonCosCFragment = fn(
  'polygon_cos_c_fragment',
  { abs_merc_x: f32T, abs_merc_y: f32T },
  f32T,
  (p) => {
    const deg2rad = constRef('DEG2RAD')
    const earthR = constRef('EARTH_R')
    const absLon = p.abs_merc_x.div(deg2rad.mul(earthR))
    const latRad = inv_merc_lat_rad(p.abs_merc_y)
    const absLat = latRad.div(deg2rad)
    return needs_backface_cull(absLon, absLat, U.field.proj_params)
  },
)

// Companion to polygon_cos_c_fragment: continuous-alpha rim fade across the
// sphere visibility boundary. Fragment shaders multiply this into output
// alpha so geometry on the sphere rim fades smoothly instead of popping at
// the cos_c=0 boundary. Returns 1.0 on flat / cylindrical projections.

const polygonRimAlpha = fn(
  'polygon_rim_alpha',
  { abs_merc_x: f32T, abs_merc_y: f32T },
  f32T,
  (p) => {
    const deg2rad = constRef('DEG2RAD')
    const earthR = constRef('EARTH_R')
    const absLon = p.abs_merc_x.div(deg2rad.mul(earthR))
    const latRad = inv_merc_lat_rad(p.abs_merc_y)
    const absLat = latRad.div(deg2rad)
    return rim_alpha(absLon, absLat, U.field.proj_params)
  },
)

// ── Vertex entries ──
//
// vs_main — Phase 2 PR 2d.1D ECEF line-entry migration.
//
// Replaces the per-projection ladder (Mercator-DSFUN rel + project_geom +
// proj_globe RTC) with a single linear MVP transform against true ECEF
// metres — identical body to vs_main_ecef. The runtime now ships line
// vertices in ECEF-DSFUN stride-9 (pos_h.vec3 + pos_l.vec3 + featId +
// abs_lon + abs_lat); the projection-specific 3D→clip pipeline is fully
// baked into u.mvp by Camera.getECEFFrameView() on the CPU.
//
// Producer migration in PR 2d.1D: graticule (the sole consumer of this VS
// after PR 2d.1C moved vs_line off vs_main). MapRenderer.addLayer's
// GeoJSON line path is unconsumed in the current runtime; if it returns,
// it MUST ship ECEF stride-9 vertices the same way the graticule does.
//
// Tile-line + polygon-stroke outlines route through vs_line (line.ts) —
// unaffected by this change.

// ── Shared projType ladder (PR-3 dedup) ──
//
// The flat/3D "ladder" (proj_params.x < 0.5 flat Mercator / < 6.5 flat
// non-Mercator / else 3D ECEF-RTC) was hand-pasted byte-for-byte across all
// three polygon vertex entries (vs_main / vs_main_ecef / vs_main_ecef_extruded).
// This builder is the single source for that branch so the three VS entries
// CALL it instead of copying it. It pushes the exact same Stmt tree into the
// caller's Builder, so the emitted WGSL is byte-identical to the prior inline
// copies (gated by polygon-variant-diff's __polygon-variant-snapshots__).
//
// The fill (vs_main / vs_main_ecef) and extruded (vs_main_ecef_extruded) paths
// share one branch shape and diverge in exactly ONE way, captured by the
// single `extruded` flag: the FLAT arms' plane-z (fill passes z = 0.0;
// extruded inserts an extra `let z_plane[_geom] = wall_height * is_top`).
//
// The 3D (else) arm is now IDENTICAL for fill and extruded: both recentre
// `ecef_cam = ecef_rtc + cam_ecef_off_h + cam_ecef_off_l` then transform. The
// wall-mesh (generateWallMeshExtrudedECEF) emits its residuals in the same
// tileEcefCenter frame as the flat fill, so the recentre is correct for both;
// the prior extruded-only bare-`ecef_rtc` path collapsed every extruded tile
// to the camera-origin tile on projType 7 globe pitch>0 (gated by G7
// extruded-globe-recenter; was un-gated when the asymmetry was introduced).
//
// All FLAT-arm math (project/flat_rel calls, the tile_origin_merc − cam_h −
// cam_l recentre, the tile_ref_lon expression, the if-conditions, the projParamsV
// reference) is byte-identical across all three VS entries, so it lives inline
// here with no parameterization. The per-VS inputs that genuinely differ
// (ecef_rtc produced via pos_h+pos_l vs dequant_ecef; the abs_lon/abs_lat param
// nodes; clip var) are passed in as already-bound Nodes.
const emitPolygonProjectionLadder = (
  args: {
    projParamsV: Node<'vec4<f32>'>
    mvp: Node<'mat4x4<f32>'>
    absLon: Node<'f32'>
    absLat: Node<'f32'>
    ecefRtc: Node<'vec3<f32>'>
    clip: Node<'vec4<f32>'>
    extruded: boolean
    isTop?: Node<'f32'>
    wallHeight?: Node<'f32'>
    // When provided (quantized fill VS), the flat-Mercator arm positions from
    // this PRECISE tile-local Mercator vec2 (vertex_merc − tile_origin_merc)
    // instead of re-projecting the lossy f32 abs_lon/abs_lat degrees.
    localMerc?: Node<'vec2<f32>'>
    // #398: TRUE unclamped lat the disc (flat_rel) arm projects from instead of
    // the Merc-clamped absLat — so the ±90 caps reach the pole, not the 85.05
    // ring. ONLY flat_rel reads it; other arms byte-identical. Absent → absLat.
    discLat?: Node<'f32'>
  },
): void => {
  const { projParamsV, mvp, absLon, absLat, ecefRtc, clip, extruded, isTop, wallHeight, localMerc, discLat } = args
  const deg2rad = constRef('DEG2RAD')
  const earthR = constRef('EARTH_R')
  const pi = constRef('PI')
  If(projParamsV.x.lt(0.5), () => {
    const zPlane = extruded ? wallHeight!.mul(isTop!) : f32(0)
    if (localMerc) {
      // PRECISE tile-local Mercator (quantized fill): rel = local_merc − cam_h
      // − cam_l. cam_h/cam_l already carry camMerc − tile_origin_merc(+worldOff)
      // (renderer DSFUN split), so the world-copy offset is IMPLICIT — no
      // project()/worldOff re-add needed. This mirrors the line/outline VS, so
      // the fill coincides with its outline by construction. local_merc is a
      // single f32 but sub-mm at every zoom (magnitude ≤ tile extent), unlike
      // the absolute-degree project() path below (~1.35 m at |lon|≈127° → the
      // ~10 px fill/outline split at deep over-zoom this fixes).
      const relLocal = localMerc.sub(U.field.cam_h).sub(U.field.cam_l)
      clip.assign(transformMat4(mvp, vec4(relLocal.x, relLocal.y, zPlane, f32(1))))
      return
    }
    const p2d = project(absLon, absLat, projParamsV)
    const rel2d =
      p2d.sub(U.field.tile_origin_merc).sub(U.field.cam_h).sub(U.field.cam_l)
    // World-copy offset (world-copy fill-gap fix): project() returns the
    // PRIMARY-world absolute X (abs_lon ∈ [−180,180], worldOff-blind), and
    // tile_origin_merc carries (tileWest+worldOff)·DEG2RAD·R while cam_h+cam_l
    // = camMercX − tileMercX, so the (tileWest+worldOff) terms CANCEL in rel2d
    // — every world copy collapses onto the primary world (left-half wo≠-1
    // fills/bg vanish). Re-add the per-copy shift the non-Mercator sibling
    // already applies (flat_rel → project_geom world_off_m): recover the
    // tile's true copy index from its displayed centre lon and add
    // wo·2π·EARTH_R. Camera-independent (the worldOff baked into
    // tile_origin_merc is an exact 360° multiple, so floor((ref+180)/360) is
    // the true copy index for any clon incl. the ±180 antimeridian) and
    // wo=0 ⇒ +0 for single-copy city views (byte-identical fill).
    const tileRefLon =
      U.field.tile_origin_merc.x
        .add(f32(0.5).mul(U.field.tile_extent_m))
        .div(deg2rad.mul(earthR))
    const wo = floor(tileRefLon.add(180).div(360))
    const worldOffM = wo.mul(2).mul(pi).mul(earthR)
    clip.assign(transformMat4(mvp, vec4(rel2d.x.add(worldOffM), rel2d.y, zPlane, f32(1))))
  }).elif(projParamsV.x.lt(6.5), () => {
    const tileRefLon =
      U.field.tile_origin_merc.x
        .add(f32(0.5).mul(U.field.tile_extent_m))
        .div(deg2rad.mul(earthR))
    // #398: project from discLat (TRUE lat) when supplied; absLat would pin the
    // polar caps to the 85.05 ring. Extruded VS → absLat (discLat undefined).
    const relG = flat_rel(absLon, discLat ?? absLat, projParamsV, tileRefLon)
    const zG = extruded ? wallHeight!.mul(isTop!) : f32(0)
    clip.assign(transformMat4(mvp, vec4(relG.x, relG.y, zG, f32(1))))
  }).else(() => {
    // 3D ECEF: recentre ecef_rtc (= vertex − tileEcefCenter) by
    // (tileEcefCenter − cameraCenter), hi + lo, so the camera-at-ENU-origin
    // MVP transforms vertex − cameraCenter. Identical for fill AND extruded:
    // the wall-mesh emits residuals in the SAME tileEcefCenter frame as the
    // flat fill (generateWallMeshExtrudedECEF: ecef − tileEcefCenter), so the
    // recentre applies unchanged — the z-lift is baked into ecef_rtc and a
    // translation commutes with it. Without it every extruded tile collapses
    // to the camera-origin tile on projType 7 globe pitch>0.
    const camOffH = U.field.cam_ecef_off_h
    const camOffL = U.field.cam_ecef_off_l
    const ecefCam =
      ecefRtc.add(vec3(camOffH.x, camOffH.y, camOffH.z)).add(vec3(camOffL.x, camOffL.y, camOffL.z))
    clip.assign(transformMat4(mvp, vec4(ecefCam, f32(1))))
  })
}

const vsMain = fn(
  'vs_main',
  {
    pos_h: location(0, vec3fT),
    pos_l: location(1, vec3fT),
    feature_id: location(2, f32T),
    abs_lon: location(3, f32T),
    abs_lat: location(4, f32T),
  },
  VertexOutputIO.type,
  (p) => {
    const mvp = U.field.mvp
    const logDepthFc = U.field.log_depth_fc
    const layerDepthOff = U.field.layer_depth_offset
    const fillTx = U.field.fill_translate_x
    const fillTy = U.field.fill_translate_y
    const deg2rad = constRef('DEG2RAD')
    const earthR = constRef('EARTH_R')
    const pi = constRef('PI')
    const mercLatLim = constRef('MERCATOR_LAT_LIMIT')

    // DSFUN reconstruction in true ECEF metres (camera-relative tile-local).
    const ecefRtc = p.pos_h.add(p.pos_l)
    // Reconstruct Mercator absolute coords for the fragment-side
    // hemisphere-cull recompute (polygon_cos_c_fragment + polygon_rim_alpha
    // consume abs_merc_x + abs_merc_y).
    const absMercX = p.abs_lon.mul(deg2rad).mul(earthR)
    const absLatClamped = clamp(p.abs_lat, mercLatLim.neg(), mercLatLim)
    const absMercY =
      log(tan(pi.div(4).add(absLatClamped.mul(deg2rad).div(2)))).mul(earthR)

    // Display projection (projection-display-layer-restore): flat Mercator
    // (proj_params.x < 0.5) reprojects each vertex onto the 2D plane and
    // feeds the flat Mercator-metre MVP; 3D / globe keeps the ECEF-RTC path.
    // The renderer writes the matching u.mvp (Camera.getViewForProjection),
    // so only the live branch's matrix is consumed.
    const projParamsV = U.field.proj_params
    const clip = vec4(f32(0), f32(0), f32(0), f32(0))
    // FLAT Mercator (proj_params.x < 0.5): rel = project(abs_lon, abs_lat) −
    // cam_merc, with cam_merc = tile_origin_merc + (cam_h + cam_l); z = 0
    // (flat fill has no height). FLAT non-Mercator (< 6.5): project_geom-style
    // flat_rel reproject (world-copy-aware) on the in-shader projected centre.
    // ELSE: 3D ECEF-RTC re-centred by (tileEcefCenter − cameraCenter), hi + lo.
    // See emitPolygonProjectionLadder for the full per-arm rationale.
    emitPolygonProjectionLadder({ projParamsV, mvp, absLon: p.abs_lon, absLat: p.abs_lat, ecefRtc, clip, extruded: false })
    // Mapbox fill-translate viewport-anchor — runtime pre-bakes
    // (px*2/canvasDim) so the shader just multiplies by clip.w.
    clip.x.assign(clip.x.add(fillTx.mul(clip.w)))
    clip.y.assign(clip.y.sub(fillTy.mul(clip.w)))
    // Log-depth rewrite + per-layer NDC-z bias (z = z − offset·w, computed inline).
    const pos0 = apply_log_depth(clip, logDepthFc)
    return VertexOutputIO.construct({
      position: vec4(pos0.x, pos0.y, pos0.z.sub(layerDepthOff.mul(pos0.w)), pos0.w),
      view_w: clip.w,
      cos_c: f32(0), // placeholder — fragments recompute per-pixel
      feat_id: toU32(p.feature_id),
      abs_lat: absLatClamped,
      wall_blend: f32(1), // line path is not extruded; full brightness
      abs_merc_x: absMercX,
      abs_merc_y: absMercY,
      world_z: f32(0),
      v_color: vec4(f32(0), f32(0), f32(0), f32(0)), // only the extrude path emits non-zero
    })
  },
  { stage: 'vertex' },
)

// vs_main_ecef — Phase 2 PR 2c.2 polygon flat-fill ECEF vertex entry.
// Replaces vs_main_quantized's per-projection ladder with a single linear
// MVP transform against true ECEF metres. The runtime decodes tile vertices
// once on the CPU to DSFUN-split tile-local ECEF (pos_h + pos_l) + writes
// the absolute lon/lat alongside each vertex (abs_lon, abs_lat) so the
// fragment-side hemisphere-cull recompute (polygonCosCFragment) can keep
// reading abs_merc_x + abs_merc_y as varyings — reconstructed in the VS
// from abs_lon/abs_lat via Mercator forward.
//
// VS work collapses to: ecef_rtc = pos_h + pos_l; clip = u.mvp * vec4(ecef_rtc, 1).
// The per-projection branch + project_geom + proj_globe calls are gone:
// the projection-specific 3D→clip pipeline is fully baked into u.mvp
// by the CPU camera (Camera.getECEFFrameView).

// Shared quantized-ECEF dequant — the SINGLE source for the q→ecef_rtc decode.
// Called by vs_main_ecef + vs_main_ecef_extruded (so they can't drift), AND
// run standalone in the compute parity harness so the real GPU f32 result is
// checked against the CPU fround mirror (dequantVertexF32). The whole point of
// extracting it: the verification kernel executes the EXACT shader logic, not
// a hand-retyped copy. q = f32(hi)*65536 + f32(lo); axis = q*scale - half.
const dequantEcefFn = fn(
  'dequant_ecef',
  { q_xy: vec4uT, q_z: vec2uT, scale: f32T, half: f32T },
  vec3fT,
  ({ q_xy, q_z, scale, half }) => {
    const qx = toF32(q_xy.x).mul(65536).add(toF32(q_xy.y))
    const qy = toF32(q_xy.z).mul(65536).add(toF32(q_xy.w))
    const qz = toF32(q_z.x).mul(65536).add(toF32(q_z.y))
    return vec3(
      qx.mul(scale).sub(half),
      qy.mul(scale).sub(half),
      qz.mul(scale).sub(half),
    )
  },
)

// Standalone WGSL for the shared dequant fn — spliced into the compute parity
// harness (_dequant-parity.spec.ts) so the kernel runs the EXACT shader dequant
// and its f32 output is checked against the CPU fround mirror (dequantVertexF32).
export const DEQUANT_ECEF_WGSL = emitFunc(dequantEcefFn)

const vsMainEcef = fn(
  'vs_main_ecef',
  {
    // PR 2f quantized position: uint16x4 (qx_hi,qx_lo,qy_hi,qy_lo) at loc 0,
    // uint16x2 (qz_hi,qz_lo) at loc 1. WebGPU widens uint16 → u32 lanes.
    q_xy: location(0, vec4uT),
    q_z: location(1, vec2uT),
    feature_id: location(2, f32T),
    abs_lon: location(3, f32T),
    abs_lat: location(4, f32T),
    // #398: TRUE unclamped lat (deg) — disc arm projects the ±90 caps from this.
    true_lat: location(5, f32T),
  },
  VertexOutputIO.type,
  (p) => {
    const mvp = U.field.mvp
    const logDepthFc = U.field.log_depth_fc
    const layerDepthOff = U.field.layer_depth_offset
    const fillTx = U.field.fill_translate_x
    const fillTy = U.field.fill_translate_y
    const dqScale = U.field.tile_dequant_scale
    const dqHalf = U.field.tile_dequant_half
    const deg2rad = constRef('DEG2RAD')
    const earthR = constRef('EARTH_R')
    const mercLatLim = constRef('MERCATOR_LAT_LIMIT')

    // PR 2f dequant via the shared dequant_ecef fn (single source; also run
    // standalone in the compute parity harness vs the CPU fround mirror).
    const ecefRtc = callFn('dequant_ecef', vec3fT, p.q_xy, p.q_z, dqScale, dqHalf)
    // The f32 tail slots (abs_lon/abs_lat) now carry TILE-LOCAL Mercator
    // (local_merc = vertex_merc − tile_origin_merc), NOT degrees. Reconstruct
    // ABSOLUTE Mercator (+ tile_origin_merc) for the fragment hemisphere-cull
    // varyings — f32 (~1 m), which polygonCosCFragment + polygonRimAlpha
    // tolerate. The precise position uses local_merc directly in the ladder.
    const tileOriginM = U.field.tile_origin_merc
    const absMercX = p.abs_lon.add(tileOriginM.x)
    const absMercY = p.abs_lat.add(tileOriginM.y)
    const absLatClamped =
      clamp(inv_merc_lat_rad(absMercY).div(deg2rad), mercLatLim.neg(), mercLatLim)

    // Display projection (projection-display-layer-restore): flat Mercator
    // (proj_params.x < 0.5) reprojects each vertex onto the 2D plane and
    // feeds the flat Mercator-metre MVP; 3D / globe keeps the ECEF-RTC path.
    // The renderer writes the matching u.mvp (Camera.getViewForProjection),
    // so only the live branch's matrix is consumed.
    const projParamsV = U.field.proj_params
    const clip = vec4(f32(0), f32(0), f32(0), f32(0))
    // Same flat/3D ladder as vs_main (see emitPolygonProjectionLadder): flat
    // Mercator reproject + recentre / flat non-Mercator flat_rel / 3D ECEF-RTC
    // re-centred by (tileEcefCenter − cameraCenter). Only ecef_rtc is sourced
    // differently (dequant_ecef vs pos_h+pos_l) — passed in as a Node.
    emitPolygonProjectionLadder({
      projParamsV, mvp,
      // local_merc (f32 tail) drives the PRECISE flat-Mercator position;
      // absLon/absLat feed only flat_rel; discLat (#398) gives it the TRUE lat.
      absLon: absMercX.div(deg2rad.mul(earthR)),
      absLat: absLatClamped,
      discLat: p.true_lat,
      localMerc: vec2(p.abs_lon, p.abs_lat),
      ecefRtc, clip, extruded: false,
    })
    // Mapbox fill-translate viewport-anchor — runtime pre-bakes
    // (px*2/canvasDim) so the shader just multiplies by clip.w.
    clip.x.assign(clip.x.add(fillTx.mul(clip.w)))
    clip.y.assign(clip.y.sub(fillTy.mul(clip.w)))
    // Log-depth rewrite + per-layer NDC-z bias (z = z − offset·w, computed inline).
    const pos0 = apply_log_depth(clip, logDepthFc)
    return VertexOutputIO.construct({
      position: vec4(pos0.x, pos0.y, pos0.z.sub(layerDepthOff.mul(pos0.w)), pos0.w),
      view_w: clip.w,
      cos_c: f32(0), // placeholder — fragments recompute per-pixel
      feat_id: toU32(p.feature_id),
      abs_lat: absLatClamped,
      wall_blend: f32(1), // flat-fill = full brightness (no wall shading)
      abs_merc_x: absMercX,
      abs_merc_y: absMercY,
      world_z: f32(0),
      v_color: vec4(f32(0), f32(0), f32(0), f32(0)), // per-feature variants override via composer
    })
  },
  { stage: 'vertex' },
)

// vs_main_ecef_extruded — Phase 2 PR 2c.2 polygon extruded ECEF vertex.
// Replaces vs_main_quantized_extruded. The runtime wall-mesh pre-lifts
// top-ring vertices in ECEF metres (along the local +Up direction), so
// the VS just runs the same linear `u.mvp * (pos_h + pos_l)` transform
// — no per-vertex z lift in the shader. is_top discriminates wall-bottom
// (0.0) vs wall-top + roof (1.0), driving MapLibre lighting + wall_blend
// + world_z. wall_height feeds the vertical-gradient ramp.
//
// MapLibre lighting (Rec.709 luminance + face-normal directional + |nz|<0.5
// vertical gradient) is preserved verbatim from vs_main_quantized_extruded;
// only the position math changes.

const vsMainEcefExtruded = fn(
  'vs_main_ecef_extruded',
  {
    // PR 2f quantized position (same split as vs_main_ecef): uint16x4 +
    // uint16x2. The f32 tail (fid/abs_lon/abs_lat/face_normal/wall_height/
    // is_top) shifts down accordingly in @location.
    q_xy: location(0, vec4uT),
    q_z: location(1, vec2uT),
    feature_id: location(2, f32T),
    abs_lon: location(3, f32T),
    abs_lat: location(4, f32T),
    face_normal: location(5, vec3fT),
    wall_height: location(6, f32T),
    is_top: location(7, f32T),
  },
  VertexOutputIO.type,
  (p) => {
    const mvp = U.field.mvp
    const logDepthFc = U.field.log_depth_fc
    const layerDepthOff = U.field.layer_depth_offset
    const fillTx = U.field.fill_translate_x
    const fillTy = U.field.fill_translate_y
    const fillColor = U.field.fill_color
    const dqScale = U.field.tile_dequant_scale
    const dqHalf = U.field.tile_dequant_half
    const deg2rad = constRef('DEG2RAD')
    const earthR = constRef('EARTH_R')
    const pi = constRef('PI')
    const mercLatLim = constRef('MERCATOR_LAT_LIMIT')

    // PR 2f dequant via the shared dequant_ecef fn (same single source as
    // vs_main_ecef). Both wall-bottom + wall-top + roof vertices are
    // pre-positioned + quantized in ECEF metres by the runtime wall-mesh
    // (half-range computed post-lift), so the VS just decodes + transforms.
    const ecefRtc = callFn('dequant_ecef', vec3fT, p.q_xy, p.q_z, dqScale, dqHalf)
    const absMercX = p.abs_lon.mul(deg2rad).mul(earthR)
    const absLatClamped = clamp(p.abs_lat, mercLatLim.neg(), mercLatLim)
    const absMercY =
      log(tan(pi.div(4).add(absLatClamped.mul(deg2rad).div(2)))).mul(earthR)

    // Display projection (see vs_main_ecef): flat Mercator reprojects onto
    // the 2D plane with the extrude lift applied as plane-z; 3D keeps the
    // pre-lifted ECEF-RTC. world_z = wall_height × is_top is the per-vertex
    // lift the runtime wall-mesh baked into ECEF z. The lift is real metres
    // while x/y are projection-plane metres, so it is unscaled relative to the
    // plane: for Mercator that is the cos(lat) shrink (worse at high latitude);
    // for the other flat projTypes the plane↔height metric differs again.
    // Known approximation under f32 P1 — revisit with a per-projection vertical
    // scale if extruded walls look wrong away from the equator.
    const projParamsV = U.field.proj_params
    const clip = vec4(f32(0), f32(0), f32(0), f32(0))
    // Same flat/3D ladder as vs_main_ecef but extruded: the FLAT arms add a
    // `z_plane[_geom] = wall_height * is_top` plane-lift; the 3D (else) arm is
    // identical to the flat-fill path (pre-lifted ecef_rtc + cam_ecef_off
    // recentre — the wall-mesh shares the flat fill's tileEcefCenter frame;
    // see emitPolygonProjectionLadder). The single `extruded` flag selects the
    // plane-z divergence.
    emitPolygonProjectionLadder({
      projParamsV, mvp, absLon: p.abs_lon, absLat: p.abs_lat, ecefRtc, clip,
      extruded: true, isTop: p.is_top, wallHeight: p.wall_height,
    })
    clip.x.assign(clip.x.add(fillTx.mul(clip.w)))
    clip.y.assign(clip.y.sub(fillTy.mul(clip.w)))
    // Log-depth rewrite + per-layer NDC-z bias (z = z − offset·w, computed inline).
    const pos0 = apply_log_depth(clip, logDepthFc)

    // MapLibre-equivalent face-normal directional lighting (preserved
    // verbatim from vs_main_quantized_extruded). Default light style:
    // position [1.15, 210°, 30°] → cartesian (0.288, -0.498, 0.996);
    // intensity 0.5; color (1,1,1); vertical-gradient = 1.0.
    const colorRgb = fillColor.rgb
    const opacity = fillColor.a
    const colorValue =
      colorRgb.r.mul(0.2126).add(colorRgb.g.mul(0.7152)).add(colorRgb.b.mul(0.0722))
    const ambient = vec3(f32(0.03))
    const litColorRgb = colorRgb.add(ambient)
    // #420 — ECEF-frame light dir (raw 0.288,-0.498,0.996 rotated by the
    // camera-anchor ENU→ECEF basis on the CPU). Same frame as face_normal →
    // fixes the dark side/back walls.
    const lightPos = U.field.light_dir_ecef.swizzle<'vec3<f32>'>('xyz')
    // WS-9 — intensity + colour are uniforms now (were baked consts). The CPU
    // packs the MapLibre default (intensity 0.5, white) when no custom `light`
    // is authored, so the default render stays byte-identical. Intensity rides
    // light_dir_ecef.w; colour is RGBA8 in light_color_packed (8-bit per
    // channel — ample for a light tint).
    const lightIntensity = U.field.light_dir_ecef.w
    const lightColor = unpack4x8unorm(U.field.light_color_packed).swizzle<'vec3<f32>'>('xyz')
    const directional = clamp(dot(p.face_normal, lightPos), f32(0), f32(1))
    directional.assign(mix(
      f32(1).sub(lightIntensity),
      max(f32(1).sub(colorValue).add(lightIntensity), f32(1)),
      directional,
    ))
    // Vertical gradient — walls only (|nz| < 0.5). Mapbox
    // fill-extrusion-vertical-gradient opt-out: the flag rides the spare
    // cam_ecef_off_l.w uniform lane (1 = default = ramp on, 0 = off). AND
    // it into the wall test so `false` skips the ramp (flat wall shading);
    // at the default the branch is taken exactly as before (no-op gate).
    const vgGradOn = U.field.cam_ecef_off_l.w.ne(0)
    const isWall = abs(p.face_normal.z).lt(0.5).and(vgGradOn)
    const tTop = p.is_top
    If(isWall, () => {
      // (t_top + base) * sqrt(height/150). h_for_grad = max(wall_height, 1)
      // so the bottom lip still computes a sensible gradient value.
      const hForGrad = max(p.wall_height, f32(1))
      const vgrad = clamp(
        tTop.mul(sqrt(hForGrad.div(150))),
        mix(f32(0.7), f32(0.98), f32(1).sub(lightIntensity)),
        f32(1),
      )
      directional.assign(directional.mul(vgrad))
    })
    const shadedRgb = Let(
      clamp(litColorRgb.mul(directional).mul(lightColor), vec3(f32(0)), vec3(f32(1))),
    )
    // Non-premultiplied output — see vs_main_quantized_extruded's removed
    // header for the BLEND_ALPHA vs BLEND_ALPHA_PREMULT equivalence proof.
    return VertexOutputIO.construct({
      position: vec4(pos0.x, pos0.y, pos0.z.sub(layerDepthOff.mul(pos0.w)), pos0.w),
      view_w: clip.w,
      cos_c: f32(0),
      feat_id: toU32(p.feature_id),
      abs_lat: absLatClamped,
      wall_blend: p.is_top, // is_top doubles as wall_blend (1.0 roof, 0.0 wall bottom)
      abs_merc_x: absMercX,
      abs_merc_y: absMercY,
      world_z: p.wall_height.mul(p.is_top), // world-z carries wall_height for the wall-blend discriminator
      v_color: vec4(shadedRgb, opacity),
    })
  },
  { stage: 'vertex' },
)

// ── Fragment-entry shared sub-builders ──
//
// Five polygon fragment entries (fs_fill / fs_fill_pattern / fs_oit_translucent
// / fs_fill_extrude / fs_stroke) all open with the same three discards:
//   1. polygon_cos_c_fragment hemisphere cull (sphere visibility).
//   2. MERCATOR_LAT_LIMIT abs-lat clamp.
//   3. clip_bounds parent-fallback mask (sentinel + bbox valid).
// Inlined into each entry via this builder helper to keep the WGSL emit
// shape byte-identical to POLYGON_SHADER_SOURCE.

const emitPolygonFragmentDiscards = (input: Node): void => {
  const i = VertexOutputIO.of(input)
  const cosC = callFn('polygon_cos_c_fragment', f32T, i.abs_merc_x, i.abs_merc_y)
  If(cosC.lt(0), () => { Discard() })
  // #399 +0.5° margin: cap abs_lat is VS-clamped to exactly ±LIMIT, so a bare `>LIMIT` flips per MSAA sample at the pole fan (speckle); loosen-only ⇒ #360-hole-safe.
  If(abs(i.abs_lat).gt(constRef('MERCATOR_LAT_LIMIT').add(0.5)), () => { Discard() })
  const clipBounds = U.field.clip_bounds
  const clipValid =
    clipBounds.x.gt(-1e29)
      .and(clipBounds.z.gt(clipBounds.x))
      .and(clipBounds.w.gt(clipBounds.y))
  If(clipValid, () => {
    If(i.abs_merc_x.lt(clipBounds.x), () => { Discard() })
    If(i.abs_merc_x.gt(clipBounds.z), () => { Discard() })
    If(i.abs_merc_y.lt(clipBounds.y), () => { Discard() })
    If(i.abs_merc_y.gt(clipBounds.w), () => { Discard() })
  })
}

// Per-feature deterministic depth jitter — breaks coplanar z-fights at
// shared building walls. xor-shift mix on the low 16 bits of feat_id keeps
// the math strictly in u32-wrap-on-overflow (avoids Apple Metal's multiply-
// overflow validation reject). Range ≈ ±1.5e-5 NDC z (sub-pixel at any
// reasonable depth precision). Synthetic background features (feat_id==0)
// keep the canonical un-jittered depth.

const emitLogDepthJitter = (input: Node, out: Node): void => {
  const i = VertexOutputIO.of(input)
  const baseDepth =
    compute_log_frag_depth(i.view_w, U.field.log_depth_fc)
  const idLo = i.feat_id.bitAnd(u32(0xFFFF))
  const mixed =
    idLo.bitXor(idLo.shr(u32(7))).bitXor(idLo.shl(u32(3))).bitAnd(u32(0x3FF))
  const jitter = select(
    i.feat_id.ne(0),
    toF32(mixed).sub(512).mul(1.5e-8),
    f32(0),
  )
  polygonFragmentOutput(false).of(out).depth.assign(baseDepth.add(jitter))
}

// Pick attachment write (RG32Uint) — only emits when pickEnabled. The readback
// decoder (interaction-controller) expects R = feat_id (the per-feature id) and
// G = pick_id (the packed (instanceId<<16)|layerId), and drops the sample as a
// miss when either is 0. Writing pick_id into R / 0 into G (the pre-fix DSL port
// of #152) left layerId === 0 for every pixel, so pickAt returned null for all
// polygon fills. Keep R = feat_id, G = pick_id.

const emitPickWrite = (input: Node, out: Node, pickEnabled: boolean): void => {
  if (!pickEnabled) return
  const i = VertexOutputIO.of(input)
  polygonFragmentOutput(pickEnabled).of(out).pick.assign(vec2u(i.feat_id, U.field.pick_id))
}

// ── Fragment entries ──
//
// fs_fill — main polygon fill fragment. Three opening discards (cull / lat /
// clip), then wall_shade for fill-extrusion shading, then the placeholder
// Stmt 'fill-return' (composer swaps with variant.fillExpr OR the default
// `u.fill_color.rgb * wall_shade` assign), then rim_alpha multiply, pick
// write (conditional), and log-depth jitter. The 'fill-return' placeholder
// is the seam US-007's emitPolygonWgsl composer rewrites.

const buildFsFill = (pickEnabled: boolean) =>
  fn(
    'fs_fill',
    { input: VertexOutputIO.type },
    polygonFragmentOutput(pickEnabled).type,
    (p, b) => {
      const input = p.input
      const i = VertexOutputIO.of(input)
      emitPolygonFragmentDiscards(input)
      const out = Var('out', polygonFragmentOutput(pickEnabled).type)
      // Fill-extrusion shading via wall_blend varying. Iter 129 final after
      // the derivative-normal experiment was reverted — see fs_fill comment
      // in POLYGON_SHADER_SOURCE for the rationale.
      const wallBlend = i.wall_blend
      const vShade = f32(0.6).add(f32(0.4).mul(wallBlend))
      const roofBonus = select(wallBlend.ge(0.999), f32(0.05), f32(0))
      const wallShade = Let('wall_shade', min(f32(1), vShade.add(roofBonus))) // named: the composer default-fill return Stmt references `wall_shade` by literal varref
      // wall_shade reference kept live for the composer's default-path
      // assign emit (defaultFillReturnStmts constructs a `{op:'varref',
      // name:'wall_shade'}` Expr that resolves to the let-bound name at
      // emit time). The variant-injected path uses its own preamble +
      // expr and ignores wall_shade unless the variant authored it back
      // in. `void` keeps tsc-noUnusedLocals satisfied without dropping
      // the b.let() Stmt push.
      void wallShade
      // ▼ Composer-swap point — variant.fillExpr replaces this OR the
      //   composer inserts the base default-uniform path:
      //     out.color = vec4<f32>(u.fill_color.rgb * wall_shade, u.fill_color.a);
      b.placeholder('fill-return')
      // Rim alpha fade — applied AFTER the marker so variant pipelines
      // inherit it without per-variant codegen plumbing. Mapbox
      // fill-antialias opt-out: the only fragment smoothstep that touches
      // fill alpha is rim_alpha (the sphere-rim hemisphere fade), so
      // `fill-antialias: false` gates it off → hard edges. The flag rides
      // the spare cam_ecef_off_h.w uniform lane (1 = default, 0 = off);
      // at the default the multiply runs exactly as before (no-op gate).
      If(U.field.cam_ecef_off_h.w.ne(0), () => {
        const rimA = callFn('polygon_rim_alpha', f32T, i.abs_merc_x, i.abs_merc_y)
        const o = polygonFragmentOutput(pickEnabled).of(out)
        o.color.a.assign(o.color.a.mul(rimA))
      })
      emitPickWrite(input, out, pickEnabled)
      emitLogDepthJitter(input, out)
      Return(out)
    },
    { stage: 'fragment' },
  )

// fs_fill_pattern — iter-181/182 fill-pattern Stage 2 fragment. World-anchored
// repeating-tile UV via abs_merc / repeat_m; the local UV is then remapped
// into the sprite atlas-UV bbox stored in u.fill_color (rgba = u0/v0/u1/v1).
// fill-translate slots are reused as the repeat metres (Stage 2 trade-off:
// pattern-fill layers can't also use a solid colour or a translate offset).

const buildFsFillPattern = (pickEnabled: boolean) =>
  fn(
    'fs_fill_pattern',
    { input: VertexOutputIO.type },
    polygonFragmentOutput(pickEnabled).type,
    (p) => {
      const input = p.input
      const i = VertexOutputIO.of(input)
      emitPolygonFragmentDiscards(input)
      const out = Var('out', polygonFragmentOutput(pickEnabled).type)
      const repeatX = max(U.field.fill_translate_x, f32(1))
      const repeatY = max(U.field.fill_translate_y, f32(1))
      const uvLocal = vec2(
        fract(i.abs_merc_x.div(repeatX)),
        fract(i.abs_merc_y.div(repeatY)),
      )
      const fillColor = U.field.fill_color
      const u0 = fillColor.r
      const v0 = fillColor.g
      const u1 = fillColor.b
      const v1 = fillColor.a
      const atlasUv = vec2(
        u0.add(uvLocal.x.mul(u1.sub(u0))),
        v0.add(uvLocal.y.mul(v1.sub(v0))),
      )
      const sampled = textureSample(spriteAtlas, spriteSamp, atlasUv)
      // Layer opacity multiplies sprite alpha so fill-opacity still works.
      const o = polygonFragmentOutput(pickEnabled).of(out)
      o.color.assign(vec4(sampled.rgb, sampled.a.mul(U.field.opacity)))
      const rimA = callFn('polygon_rim_alpha', f32T, i.abs_merc_x, i.abs_merc_y)
      o.color.a.assign(o.color.a.mul(rimA))
      emitPickWrite(input, out, pickEnabled)
      emitLogDepthJitter(input, out)
      Return(out)
    },
    { stage: 'fragment' },
  )

// fs_oit_translucent — Weighted Blended OIT (McGuire-Bavoil 2013) output.
// Writes the dual MRT: @location(0) accum = (rgb·a·w, a·w) [BLEND_ADD]
// + @location(1) revealage = a [BLEND mul-by-1-src]. Compose pass divides
// accum.rgb by accum.a to recover the weighted-average colour, then uses
// (1 - product_of_(1-a)) as the over-blend alpha onto the opaque
// framebuffer. The McGuire-Bavoil 7.4 weight biases small-z fragments to
// dominate (matching painter's order for clear front-most geometry);
// clamps prevent fp16 running-sum overflow.

const fsOitTranslucent = fn(
  'fs_oit_translucent',
  { input: VertexOutputIO.type },
  OitFragmentOutput.type,
  (p) => {
    const input = p.input
    const i = VertexOutputIO.of(input)
    emitPolygonFragmentDiscards(input)
    // Same fill-extrusion shading as fs_fill.
    const wallBlend = i.wall_blend
    const vShade = f32(0.6).add(f32(0.4).mul(wallBlend))
    const roofBonus = select(wallBlend.ge(0.999), f32(0.05), f32(0))
    const wallShade = min(f32(1), vShade.add(roofBonus))
    const fillColor = U.field.fill_color
    const rgb = fillColor.rgb.mul(wallShade)
    // Rim alpha fade (multiplies into alpha so OIT accumulation respects it).
    const rimA = callFn('polygon_rim_alpha', f32T, i.abs_merc_x, i.abs_merc_y)
    const a = fillColor.a.mul(rimA)
    If(a.le(0.001), () => { Discard() })
    // McGuire-Bavoil weight: large for closer + smaller alpha contributions,
    // capped to avoid fp16 overflow. iter-192 set weight=1; reverted in
    // iter-193 alongside the depth-write change.
    const z = max(i.view_w, f32(1e-3))
    const w = clamp(
      f32(0.03).div(f32(1e-5).add(pow(z.div(200), f32(4)))),
      f32(1e-2),
      f32(3.0e3),
    )
    return OitFragmentOutput.construct({
      accum: vec4(rgb.mul(a), a).mul(w),
      revealage: a,
    })
  },
  { stage: 'fragment' },
)

// fs_fill_extrude — iter-194 MapLibre-equivalent fill-extrusion fragment.
// All lighting was computed per-vertex in vs_main_quantized_extruded and
// interpolated as v_color; this fragment just passes it through (after the
// same per-fragment cull + clip discards as fs_fill so hemisphere
// boundaries + parent-tile clip masks stay correct). v_color is
// PREMULTIPLIED (rgb*alpha, alpha); the pipeline uses BLEND_ALPHA_PREMULT
// so the result composites the same way MapLibre's translucent extrude
// path does.

const buildFsFillExtrude = (pickEnabled: boolean) =>
  fn(
    'fs_fill_extrude',
    { input: VertexOutputIO.type },
    polygonFragmentOutput(pickEnabled).type,
    (p) => {
      const input = p.input
      const i = VertexOutputIO.of(input)
      emitPolygonFragmentDiscards(input)
      const out = Var('out', polygonFragmentOutput(pickEnabled).type)
      // Rim alpha — operates on the premultiplied colour: scales both rgb
      // and alpha by the rim factor so the building still fades at sphere
      // edges on globe / azimuthal projections.
      const rim = callFn('polygon_rim_alpha', f32T, i.abs_merc_x, i.abs_merc_y)
      polygonFragmentOutput(pickEnabled).of(out).color.assign(i.v_color.mul(rim))
      emitPickWrite(input, out, pickEnabled)
      emitLogDepthJitter(input, out)
      Return(out)
    },
    { stage: 'fragment' },
  )

// fs_stroke — main polygon stroke fragment. Same 3 discards as fs_fill,
// then a minor/major alpha-scale gated on feat_id > 0 (major grid line vs
// minor — the synthetic-feat encoding upstream), then the composer-swap
// placeholder Stmt 'stroke-return' (composer swaps with variant.strokeExpr
// OR the default `u.stroke_color.rgb * alpha_scale` assign), then rim_alpha
// multiply + pick write (conditional) + log-depth (NO jitter — strokes
// are thin enough that the coplanar fight class doesn't apply).

const buildFsStroke = (pickEnabled: boolean) =>
  fn(
    'fs_stroke',
    { input: VertexOutputIO.type },
    polygonFragmentOutput(pickEnabled).type,
    (p, b) => {
      const input = p.input
      const i = VertexOutputIO.of(input)
      emitPolygonFragmentDiscards(input)
      // feat_id > 0 = major grid line (brighter); 0 = minor (dimmer).
      // `void` keeps tsc satisfied — defaultStrokeReturnStmts builds a
      // `{op:'varref', name:'alpha_scale'}` Expr that resolves to this
      // let-bound name at emit time (composer's default-path assign).
      const alphaScale = Let('alpha_scale', select(i.feat_id.gt(0), f32(1), f32(0.4))) // named: the composer default-stroke return Stmt references `alpha_scale` by literal varref
      void alphaScale
      const out = Var('out', polygonFragmentOutput(pickEnabled).type)
      // ▼ Composer-swap point — variant.strokeExpr replaces this OR the
      //   composer inserts the base default-uniform path:
      //     out.color = vec4<f32>(u.stroke_color.rgb, u.stroke_color.a * alpha_scale);
      b.placeholder('stroke-return')
      const rimA = callFn('polygon_rim_alpha', f32T, i.abs_merc_x, i.abs_merc_y)
      const o = polygonFragmentOutput(pickEnabled).of(out)
      o.color.a.assign(o.color.a.mul(rimA))
      emitPickWrite(input, out, pickEnabled)
      // Stroke depth: bare log-depth, no per-feature jitter.
      o.depth.assign(compute_log_frag_depth(i.view_w, U.field.log_depth_fc))
      Return(out)
    },
    { stage: 'fragment' },
  )

// fs_overdraw — debug=overdraw single constant-output entry shared by every
// debug-variant pipeline. Vertex shaders still project correctly so the
// rasterizer produces the SAME fragments as the normal path; FS work
// collapses to one write that an additive blend sums into the r16float
// accumulator. NO @builtin(frag_depth) write — debug overdraw doesn't
// participate in the variant marker substitution.

const fsOverdraw = fn(
  'fs_overdraw', {}, vec4fT,
  (_p) => {
    return vec4(f32(1), f32(0), f32(0), f32(0))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// ── ShaderVariantInfo ──
//
// Phase 2.5 US-007b — the composer-side variant shape. ShaderVariantInfo is
// a subset of @xgis/compiler's ShaderVariant carrying ONLY what
// emitPolygonWgsl needs (the fields the polygon module composes into its
// base ModuleDecl). renderer-side buildShader() converts the legacy
// ShaderVariant into a ShaderVariantInfo at the call seam (US-008).
//
// All fields nullable. A null variant emits the base polygon shader (the
// default-uniform path); a variant with fillExpr / strokeExpr injects the
// per-feature / per-zoom / per-palette path.

export interface ShaderVariantInfo {
  /** Module-shape fragment merged into the polygon base module. consts +
   *  bindings + funcs are appended; the polygon base's structs + entry
   *  fns are never touched by preamble. */
  readonly preamble: Partial<Pick<ModuleDecl, 'consts' | 'bindings' | 'funcs'>> | null
  /** Fill-color expression replacing the placeholder Stmt 'fill-return' in
   *  fs_fill. Null → keep the base default-uniform `u.fill_color` path. */
  readonly fillExpr: Node<'vec4<f32>'> | null
  /** Stroke-color expression replacing the placeholder Stmt 'stroke-return'
   *  in fs_stroke. Null → keep the base `u.stroke_color` path. */
  readonly strokeExpr: Node<'vec4<f32>'> | null
  /** Stmt list emitted BEFORE the fill-return placeholder is replaced (e.g.
   *  `var _mcSS = ...; if (...) { _mcSS = ...; }`). Null → no preamble. */
  readonly fillPreamble: readonly Stmt[] | null
  /** Stmt list emitted BEFORE the stroke-return placeholder. Null → none. */
  readonly strokePreamble: readonly Stmt[] | null
  /** When true, the composer appends a storage binding for feat_data at
   *  @group(1) @binding(0). Per-feature data driven variants set this. */
  readonly needsFeatureBuffer: boolean
  /** P4-5 compute-routed variant bindings. When present, the composer
   *  appends each entry as a storage binding feeding fillExpr / strokeExpr
   *  via `compute_out_<N>[fid]` reads. */
  readonly computeBindings?: readonly {
    readonly bindGroup: number
    readonly binding: number
    readonly bufferName: string
    readonly paintAxis: 'fill' | 'stroke'
  }[]
}

// ── Composer ──
//
// The composer walks the polygon base module and replaces each placeholder
// Stmt (tags 'fill-return' / 'stroke-return') with either the variant-
// injected return path or the default-uniform path. Default paths reference
// the same `out` + `wall_shade` / `alpha_scale` let-bindings that fs_fill /
// fs_stroke author above the placeholder.

const defaultFillReturnStmts = (): readonly Stmt[] => {
  const b = new Builder()
  const out = new Node({ op: 'varref', type: polygonFragmentOutput(false).type, name: 'out' })
  const wallShade = new Node<'f32'>({ op: 'varref', type: f32T, name: 'wall_shade' })
  const fillColor = U.field.fill_color
  b.assign(polygonFragmentOutput(false).of(out).color, vec4(fillColor.rgb.mul(wallShade), fillColor.a))
  return b.stmts
}

const defaultStrokeReturnStmts = (): readonly Stmt[] => {
  const b = new Builder()
  const out = new Node({ op: 'varref', type: polygonFragmentOutput(false).type, name: 'out' })
  const alphaScale = new Node<'f32'>({ op: 'varref', type: f32T, name: 'alpha_scale' })
  const strokeColor = U.field.stroke_color
  b.assign(polygonFragmentOutput(false).of(out).color, vec4(strokeColor.rgb, strokeColor.a.mul(alphaScale)))
  return b.stmts
}

// Variant fill / stroke return → fillPreamble Stmts (e.g. match if-else
// chain authoring `_mcSS` var) followed by the assign of out.color to the
// variant-provided Expr.

const variantReturnStmts = (
  axis: 'fill' | 'stroke',
  variant: ShaderVariantInfo,
): readonly Stmt[] => {
  const expr = axis === 'fill' ? variant.fillExpr : variant.strokeExpr
  const preamble = axis === 'fill' ? variant.fillPreamble : variant.strokePreamble
  if (!expr) {
    // No expr → keep default path (preamble alone is a no-op per AC3 #9).
    return axis === 'fill' ? defaultFillReturnStmts() : defaultStrokeReturnStmts()
  }
  const b = new Builder()
  const out = new Node({ op: 'varref', type: polygonFragmentOutput(false).type, name: 'out' })
  b.assign(polygonFragmentOutput(false).of(out).color, expr)
  return [...(preamble ?? []), ...b.stmts]
}

// Recursive placeholder-Stmt walker. The polygon base module only places
// placeholders at top-level in fs_fill / fs_stroke bodies (no current
// nesting), but the walker descends into if / for / switch bodies anyway
// so future polygon-DSL additions can place placeholders in nested scopes
// without re-plumbing the composer.

const swapPlaceholders = (
  stmts: readonly Stmt[],
  swaps: Record<string, readonly Stmt[]>,
): Stmt[] => {
  const out: Stmt[] = []
  for (const s of stmts) {
    if (s.s === 'placeholder') {
      const replacement = swaps[s.tag]
      if (replacement) out.push(...replacement)
      else out.push(s) // bare survival → wgsl emits `// __placeholder: <tag>`
      continue
    }
    if (s.s === 'if') {
      out.push({
        s: 'if',
        arms: s.arms.map((arm) => ({
          cond: arm.cond,
          body: swapPlaceholders(arm.body, swaps),
        })),
        elseBody: s.elseBody ? swapPlaceholders(s.elseBody, swaps) : undefined,
      })
      continue
    }
    if (s.s === 'for') {
      out.push({ ...s, body: swapPlaceholders(s.body, swaps) })
      continue
    }
    if (s.s === 'switch') {
      out.push({
        s: 'switch',
        scrut: s.scrut,
        cases: s.cases.map((c) => ({ value: c.value, body: swapPlaceholders(c.body, swaps) })),
        defaultBody: s.defaultBody ? swapPlaceholders(s.defaultBody, swaps) : undefined,
      })
      continue
    }
    out.push(s)
  }
  return out
}

// ── Module assembly ──
//
// PARTIAL — the initial US-007b skeleton lands structs + fixed bindings +
// helper fns + the trivial fs_overdraw entry. Subsequent commits add the
// 3 vertex entries (vs_main / vs_main_ecef / vs_main_ecef_extruded)
// and the 5 main fragment entries (fs_fill with placeholder Stmt at fill-
// return; fs_fill_pattern; fs_oit_translucent; fs_fill_extrude; fs_stroke
// with placeholder Stmt at stroke-return).
//
// The composer's preamble.{consts,bindings,funcs} merge logic + placeholder
// Stmt swap + pick attachment conditional lands in the iter alongside
// the polygon-dsl.test.ts (US-007c) 14 AC3 combination tests.

const buildPolygonModule = (
  variant: ShaderVariantInfo | null,
  pickEnabled: boolean,
): ModuleDecl => {
  const base = module({
    structs: [Uniforms, VertexOutput, OitFragmentOutput.decl, polygonFragmentOutput(pickEnabled).decl],
    bindings: [
      U.binding,
      spriteAtlasRes.binding,
      spriteSampRes.binding,
    ],
    funcs: [
      dequantEcefFn,
      polygonCosCFragment,
      polygonRimAlpha,
      vsMain,
      vsMainEcef,
      vsMainEcefExtruded,
      buildFsFill(pickEnabled),
      buildFsFillPattern(pickEnabled),
      fsOitTranslucent,
      buildFsFillExtrude(pickEnabled),
      buildFsStroke(pickEnabled),
      fsOverdraw,
    ],
  })

  // Placeholder Stmt swaps — fill / stroke return paths. Even for the
  // null-variant case the default Stmts substitute the placeholder so the
  // emitted WGSL is valid renderable output (a bare placeholder would
  // survive as `// __placeholder: <tag>` and leave out.color unassigned).
  const swaps: Record<string, readonly Stmt[]> = variant
    ? {
        'fill-return': variantReturnStmts('fill', variant),
        'stroke-return': variantReturnStmts('stroke', variant),
      }
    : {
        'fill-return': defaultFillReturnStmts(),
        'stroke-return': defaultStrokeReturnStmts(),
      }
  const composedFuncs = base.funcs.map((f) => ({ ...f, body: swapPlaceholders(f.body, swaps) }))

  // Variant-driven binding extensions.
  // - needsFeatureBuffer → feat_data storage binding at @group(1) @binding(0).
  // - computeBindings → per-axis storage bindings (compute kernel output
  //   buffers feeding the fillExpr / strokeExpr unpack4x8unorm reads).
  const extraBindings: BindingDecl[] = []
  if (variant?.needsFeatureBuffer) {
    // Matches the renderer's bind-group convention from
    // renderer-shaders.ts: feat_data is the @group(0) @binding(1)
    // storage entry alongside the @group(0) @binding(0) Uniforms +
    // @group(0) @binding(5/6) sprite_atlas/sprite_samp. Group 1 is
    // reserved for variant-specific palette / scalar atlas + samplers
    // (per generatePaletteWGSL); group 2 carries compute output buffers.
    extraBindings.push({
      group: 0, binding: 1, name: 'feat_data',
      space: 'storage', access: 'read', type: arrayT(f32T),
    })
  }
  if (variant?.computeBindings) {
    for (const cb of variant.computeBindings) {
      extraBindings.push({
        group: cb.bindGroup, binding: cb.binding, name: cb.bufferName,
        space: 'storage', access: 'read', type: arrayT(u32T),
      })
    }
  }

  // Shared projection + log-depth dependencies are MERGED into this module (was: the three
  // getProjectionWgslConsts() / LOG_DEPTH_WGSL_FNS / getProjectionWgslFns() strings that
  // emitPolygonWgsl used to prepend). emitModule emits funcs in array order, callees before
  // callers, so the shared fns lead: log-depth → projection → polygon's own. PROJECTION_CONSTS
  // join the const block, which emitModule hoists ABOVE all funcs — that hoist is the only
  // reorder vs the old prepend (same consts, same fns, same fn order), so the emit is
  // semantically identical but NOT byte-identical (the polygon-variant snapshots are rebaked).
  return module({
    consts: [...PROJECTION_CONSTS, ...base.consts, ...(variant?.preamble?.consts ?? [])],
    structs: base.structs,
    bindings: [...base.bindings, ...extraBindings, ...(variant?.preamble?.bindings ?? [])],
    funcs: [apply_log_depth, compute_log_frag_depth, ...getGpuProjectionFuncs(), ...composedFuncs, ...(variant?.preamble?.funcs ?? [])],
  })
}

/** Polygon shader emit entry point.
 *
 *  Emits ONE module: the shared projection consts + log-depth fns + projection
 *  fns are merged into buildPolygonModule's consts/funcs (callees first), then
 *  the polygon structs + bindings + helpers + entries + fs_overdraw. No string
 *  prepend — emitModule lays the whole graph down in dependency order.
 *
 *  `pickEnabled` toggles the pick attachment field + writes in the
 *  fragment output struct (replaces the old __PICK_FIELD__ / __PICK_WRITE__
 *  regex markers in POLYGON_SHADER_SOURCE).
 *
 *  `variant` is null for the base polygon shader (default-uniform fill /
 *  stroke); a populated ShaderVariantInfo composes per-feature / per-zoom /
 *  per-palette expressions into the fill / stroke entries via placeholder
 *  Stmt swap.
 */
export const emitPolygonWgsl = (
  variant: ShaderVariantInfo | null,
  pickEnabled: boolean,
): string => emitModule(buildPolygonModule(variant, pickEnabled))
