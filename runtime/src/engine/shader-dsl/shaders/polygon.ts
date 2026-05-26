// ═══ Shader DSL — polygon shader (Phase 2.5 US-007b) ═══
//
// Re-authors render/renderer-shaders.ts POLYGON_SHADER_SOURCE (826 LOC).
// The polygon shader is the variant-codegen-heavy fill / stroke / extrude
// pipeline: 1 Uniforms struct (192 bytes; reused by stroke + extrude paths
// via field aliasing), 3 fixed bindings (u, sprite_atlas, sprite_samp),
// 3 vertex entries (vs_main / vs_main_quantized / vs_main_quantized_extruded)
// and 6 fragment entries (fs_fill / fs_fill_pattern / fs_oit_translucent /
// fs_fill_extrude / fs_stroke / fs_overdraw).
//
// Pattern (line.ts sibling): emitPolygonWgsl(variant, pickEnabled) PREPENDS
// the shared DSL-emitted strings (WGSL_PROJECTION_CONSTS + WGSL_LOG_DEPTH_FNS
// + WGSL_PROJECTION_FNS), then composes the polygon ModuleDecl with the
// variant's preamble + fill/stroke exprs. fs_fill / fs_stroke contain
// placeholder Stmts (tags 'fill-return' / 'stroke-return') that the composer
// swaps with `[...preamble, return expr]` when the variant injects custom
// fill/stroke logic; bare placeholders survive as `// __placeholder: ...`
// comments per US-007a's defensive design.
//
// `pickEnabled` toggles the pick attachment field + writes (replaces the
// old __PICK_FIELD__ / __PICK_WRITE__ regex markers in POLYGON_SHADER_SOURCE).

import {
  entryFn, fn, module, bindingRef, constRef, callFn,
  f32, u32, vec2, vec2u, vec3, vec4, toF32, toU32, transformMat4, clamp, select,
  abs, fract, max, min, mix, pow, sqrt, dot, textureSample,
  f32T, u32T, vec2fT, vec3fT, vec4fT, vec2uT, mat4x4fT, texture2dfT, samplerT,
  structT,
  Node, Builder, arrayT,
  type StructDecl, type StructField, type ModuleDecl, type Stmt, type BindingDecl,
} from '../core/ir'
import { emitModule } from '../core/backends/wgsl'
import { PROJECTION_WGSL_CONSTS, PROJECTION_WGSL_FNS } from './projections'
import { LOG_DEPTH_WGSL_FNS } from './log-depth'

// ── Struct declarations ──
//
// Field order + names match POLYGON_SHADER_SOURCE byte-for-byte; the 192-byte
// uniform layout is consumed by every polygon variant + by every per-tile
// uniform writeBuffer caller in renderer.ts / vector-tile-renderer.ts, so any
// reordering would silently mis-bind the GPU read.

const Uniforms: StructDecl = {
  name: 'Uniforms',
  fields: [
    { name: 'mvp', type: mat4x4fT },
    { name: 'fill_color', type: vec4fT },
    { name: 'stroke_color', type: vec4fT },
    { name: 'proj_params', type: vec4fT },
    { name: 'cam_h', type: vec2fT },
    { name: 'cam_l', type: vec2fT },
    { name: 'tile_origin_merc', type: vec2fT },
    { name: 'opacity', type: f32T },
    { name: 'log_depth_fc', type: f32T },
    { name: 'pick_id', type: u32T },
    { name: 'layer_depth_offset', type: f32T },
    { name: 'tile_extent_m', type: f32T },
    { name: 'extrude_height_m', type: f32T },
    { name: 'clip_bounds', type: vec4fT },
    { name: 'zoom', type: f32T },
    { name: 'extrude_base_m', type: f32T },
    { name: 'fill_translate_x', type: f32T },
    { name: 'fill_translate_y', type: f32T },
  ],
}

const VertexOutput: StructDecl = {
  name: 'VertexOutput',
  fields: [
    { name: 'position', type: vec4fT, attr: '@builtin(position)' },
    { name: 'cos_c', type: f32T, attr: '@location(0)' },
    { name: 'feat_id', type: u32T, attr: '@location(1) @interpolate(flat)' },
    { name: 'abs_lat', type: f32T, attr: '@location(2)' },
    { name: 'view_w', type: f32T, attr: '@location(3)' },
    { name: 'wall_blend', type: f32T, attr: '@location(4)' },
    { name: 'abs_merc_x', type: f32T, attr: '@location(5)' },
    { name: 'abs_merc_y', type: f32T, attr: '@location(6)' },
    { name: 'world_z', type: f32T, attr: '@location(7)' },
    { name: 'v_color', type: vec4fT, attr: '@location(8)' },
  ],
}

const OitFragmentOutput: StructDecl = {
  name: 'OitFragmentOutput',
  fields: [
    { name: 'accum', type: vec4fT, attr: '@location(0)' },
    { name: 'revealage', type: f32T, attr: '@location(1)' },
  ],
}

/** FragmentOutput's `pick` field is conditional on the polygon pipeline carrying
 *  a pick attachment — same plumbing as line.ts's lineFragmentOutput. */
const polygonFragmentOutput = (pickEnabled: boolean): StructDecl => {
  const fields: StructField[] = [{ name: 'color', type: vec4fT, attr: '@location(0)' }]
  if (pickEnabled) fields.push({ name: 'pick', type: vec2uT, attr: '@location(1) @interpolate(flat)' })
  fields.push({ name: 'depth', type: f32T, attr: '@builtin(frag_depth)' })
  return { name: 'FragmentOutput', fields }
}

// ── Binding refs ──
//
// Polygon fixed bindings (matching renderer-shaders.ts 124-132):
//   @group(0) @binding(0) var<uniform> u: Uniforms;
//   @group(0) @binding(5) var sprite_atlas: texture_2d<f32>;
//   @group(0) @binding(6) var sprite_samp: sampler;
// Variant bindings (palette atlas at binding 1-4, scalar atlas at binding 2-3,
// compute output buffers via @group(2), feat_data via @group(1) @binding(0))
// land via the variant's `preamble.bindings` array.

const u = bindingRef('u', structT('Uniforms'))
const spriteAtlas = bindingRef('sprite_atlas', texture2dfT)
const spriteSamp = bindingRef('sprite_samp', samplerT)

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
  (b, p) => {
    const deg2rad = constRef('DEG2RAD')
    const earthR = constRef('EARTH_R')
    const absLon = b.let('abs_lon', p.abs_merc_x.div(deg2rad.mul(earthR)))
    const latRad = b.let('lat_rad', callFn('inv_merc_lat_rad', f32T, p.abs_merc_y))
    const absLat = b.let('abs_lat', latRad.div(deg2rad))
    b.ret(callFn('needs_backface_cull', f32T, absLon, absLat, u.field('proj_params', vec4fT)))
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
  (b, p) => {
    const deg2rad = constRef('DEG2RAD')
    const earthR = constRef('EARTH_R')
    const absLon = b.let('abs_lon', p.abs_merc_x.div(deg2rad.mul(earthR)))
    const latRad = b.let('lat_rad', callFn('inv_merc_lat_rad', f32T, p.abs_merc_y))
    const absLat = b.let('abs_lat', latRad.div(deg2rad))
    b.ret(callFn('rim_alpha', f32T, absLon, absLat, u.field('proj_params', vec4fT)))
  },
)

// ── Vertex entries ──
//
// vs_main — the f32-precision (DSFUN-split) polygon vertex entry. Reads two
// vec2<f32> attributes (pos_h + pos_l = high/low halves of the tile-local
// Mercator position) + a per-vertex feature_id. Path-by-path:
//   1. DSFUN Mercator subtraction → camera-relative tile-local meters
//      (cancels the large tile-origin magnitude before the low halves are
//      added, preserving f64-equivalent precision at any camera zoom).
//   2. Reconstruct absolute Mercator meters → abs_lon / abs_lat for the
//      fragment shader's hemisphere-cull recompute.
//   3. Mercator → projection-specific xy via project_geom (or rel for the
//      Mercator short-circuit). Globe path uses proj_globe RTC against the
//      orbit-camera MVP.
//   4. MVP transform → log-depth rewrite → fill-translate viewport offset
//      → per-layer NDC-z bias.
//   5. Forward varyings to the fragment shader.

const vsMain = entryFn(
  'vs_main', 'vertex',
  [
    { name: 'pos_h', type: vec2fT, location: 0 },
    { name: 'pos_l', type: vec2fT, location: 1 },
    { name: 'feature_id', type: f32T, location: 2 },
  ],
  structT('VertexOutput'),
  (b, p) => {
    const camH = u.field('cam_h', vec2fT)
    const camL = u.field('cam_l', vec2fT)
    const tileOrigin = u.field('tile_origin_merc', vec2fT)
    const tileExtent = u.field('tile_extent_m', f32T)
    const projParams = u.field('proj_params', vec4fT)
    const mvp = u.field('mvp', mat4x4fT)
    const logDepthFc = u.field('log_depth_fc', f32T)
    const layerDepthOff = u.field('layer_depth_offset', f32T)
    const fillTx = u.field('fill_translate_x', f32T)
    const fillTy = u.field('fill_translate_y', f32T)
    const deg2rad = constRef('DEG2RAD')
    const earthR = constRef('EARTH_R')
    const mercLatLim = constRef('MERCATOR_LAT_LIMIT')

    // DSFUN Mercator subtraction — camera-relative tile-local meters.
    const rel = b.let('rel', p.pos_h.sub(camH).add(p.pos_l.sub(camL)))
    // Reconstruct absolute Mercator meters for non-Mercator reprojection
    // + fragment-shader hemisphere cull recompute.
    const absMercX = b.let('abs_merc_x', p.pos_h.x.add(p.pos_l.x).add(tileOrigin.x))
    const absMercY = b.let('abs_merc_y', p.pos_h.y.add(p.pos_l.y).add(tileOrigin.y))
    const absLon = b.let('abs_lon', absMercX.div(deg2rad.mul(earthR)))
    const latRad = b.let('lat_rad', callFn('inv_merc_lat_rad', f32T, absMercY))
    const absLat = b.let('abs_lat', latRad.div(deg2rad))
    const absLatClamped = b.let('abs_lat_clamped', clamp(absLat, mercLatLim.neg(), mercLatLim))

    const t = b.let('t', projParams.x)
    const rtc = b.var('rtc', vec2fT)
    b.if(t.lt(0.5), (c) => {
      // Pure Mercator: rel is already camera-relative meters.
      c.assign(rtc, rel)
    }).else((c) => {
      // All other projections: run project_geom on the reconstructed
      // absolute lon/lat, then subtract the projected camera center. f32
      // reconstruction precision is fine at low/global zoom — the only
      // place these projections are exposed.
      const tileRefLon = c.let('tile_ref_lon',
        tileOrigin.x.add(f32(0.5).mul(tileExtent)).div(deg2rad.mul(earthR)),
      )
      const projXy = c.let('proj_xy', callFn('project_geom', vec2fT, absLon, absLat, projParams, tileRefLon))
      const centerXy = c.let('center_xy', callFn('project', vec2fT, projParams.y, projParams.z, projParams))
      c.assign(rtc, projXy.sub(centerXy))
    })

    // True 3D globe (projType 7): RTC against the focus point ON THE
    // sphere, then the orbit-camera MVP.
    const globeRtc = b.let('globe_rtc',
      callFn('proj_globe', vec3fT, absLon, absLat).sub(callFn('proj_globe', vec3fT, projParams.y, projParams.z)),
    )

    const out = b.var('out', structT('VertexOutput'))
    const clip = b.var('clip', vec4fT, select(
      t.gt(6.5),
      transformMat4(mvp, vec4(globeRtc, f32(1))),
      transformMat4(mvp, vec4(rtc, f32(0), f32(1))),
    ))
    // Mapbox fill-translate viewport-anchor — runtime pre-bakes
    // (px*2/canvasDim) so the shader just multiplies by clip.w.
    b.assign(clip.x, clip.x.add(fillTx.mul(clip.w)))
    b.assign(clip.y, clip.y.sub(fillTy.mul(clip.w)))
    // Log-depth rewrite + per-layer NDC-z bias.
    b.assign(out.field('position', vec4fT), callFn('apply_log_depth', vec4fT, clip, logDepthFc))
    b.assign(out.field('position', vec4fT).z, out.field('position', vec4fT).z.sub(layerDepthOff.mul(out.field('position', vec4fT).w)))
    b.assign(out.field('view_w', f32T), clip.w)
    // cos_c placeholder — fragments recompute per-pixel.
    b.assign(out.field('cos_c', f32T), f32(0))
    b.assign(out.field('feat_id', u32T), toU32(p.feature_id))
    b.assign(out.field('abs_lat', f32T), absLatClamped)
    // DSFUN line/fill path is not extruded; full brightness.
    b.assign(out.field('wall_blend', f32T), f32(1))
    b.assign(out.field('abs_merc_x', f32T), absMercX)
    b.assign(out.field('abs_merc_y', f32T), absMercY)
    b.assign(out.field('world_z', f32T), f32(0))
    // iter-194 — only the extrude path emits.
    b.assign(out.field('v_color', vec4fT), vec4(f32(0), f32(0), f32(0), f32(0)))
    b.ret(out)
  },
)

// vs_main_quantized — Phase B unorm16 packed-vertex entry. pos_raw is one
// vec2<u32>: x carries 15-bit position + 1-bit is_top extrusion flag in
// bit 15; y is the full 16-bit y quanta. Same projection chain as vs_main
// after the unpack, plus z_world picking between extrude_base_m / height_m
// per the is_top bit and a wall_blend signal driven by the same flag.

const vsMainQuantized = entryFn(
  'vs_main_quantized', 'vertex',
  [
    { name: 'pos_raw', type: vec2uT, location: 0 },
    { name: 'feature_id', type: f32T, location: 2 },
  ],
  structT('VertexOutput'),
  (b, p) => {
    const camH = u.field('cam_h', vec2fT)
    const camL = u.field('cam_l', vec2fT)
    const tileOrigin = u.field('tile_origin_merc', vec2fT)
    const tileExtent = u.field('tile_extent_m', f32T)
    const projParams = u.field('proj_params', vec4fT)
    const mvp = u.field('mvp', mat4x4fT)
    const logDepthFc = u.field('log_depth_fc', f32T)
    const layerDepthOff = u.field('layer_depth_offset', f32T)
    const fillTx = u.field('fill_translate_x', f32T)
    const fillTy = u.field('fill_translate_y', f32T)
    const extrudeBaseM = u.field('extrude_base_m', f32T)
    const extrudeHeightM = u.field('extrude_height_m', f32T)
    const deg2rad = constRef('DEG2RAD')
    const earthR = constRef('EARTH_R')
    const mercLatLim = constRef('MERCATOR_LAT_LIMIT')

    // Unpack: bit 15 of x = is_top flag, bits 0-14 of x + all 16 of y =
    // unsigned position quanta in [0, 32767] and [0, 65535] respectively.
    const isTop = b.let('is_top', p.pos_raw.x.bitAnd(u32(0x8000)).ne(u32(0)))
    const mxQ = b.let('mx_q', toF32(p.pos_raw.x.bitAnd(u32(0x7FFF))))
    const myQ = b.let('my_q', toF32(p.pos_raw.y))
    const local = b.let('local', vec2(mxQ, myQ).div(f32(32767)).mul(tileExtent))
    // Tile-local subtraction — at this scale f32 suffices for the sum of
    // cam_h + cam_l.
    const camLocal = b.let('cam_local', camH.add(camL))
    const rel = b.let('rel', local.sub(camLocal))

    const absMercX = b.let('abs_merc_x', local.x.add(tileOrigin.x))
    const absMercY = b.let('abs_merc_y', local.y.add(tileOrigin.y))
    const absLon = b.let('abs_lon', absMercX.div(deg2rad.mul(earthR)))
    const latRad = b.let('lat_rad', callFn('inv_merc_lat_rad', f32T, absMercY))
    const absLat = b.let('abs_lat', latRad.div(deg2rad))
    const absLatClamped = b.let('abs_lat_clamped', clamp(absLat, mercLatLim.neg(), mercLatLim))

    const t = b.let('t', projParams.x)
    const rtc = b.var('rtc', vec2fT)
    b.if(t.lt(0.5), (c) => {
      c.assign(rtc, rel)
    }).else((c) => {
      const tileRefLon = c.let('tile_ref_lon',
        tileOrigin.x.add(f32(0.5).mul(tileExtent)).div(deg2rad.mul(earthR)),
      )
      const projXy = c.let('proj_xy', callFn('project_geom', vec2fT, absLon, absLat, projParams, tileRefLon))
      const centerXy = c.let('center_xy', callFn('project', vec2fT, projParams.y, projParams.z, projParams))
      c.assign(rtc, projXy.sub(centerXy))
    })
    const globeRtc = b.let('globe_rtc',
      callFn('proj_globe', vec3fT, absLon, absLat).sub(callFn('proj_globe', vec3fT, projParams.y, projParams.z)),
    )

    const out = b.var('out', structT('VertexOutput'))
    // 3D extrusion: top vertex lifts to extrude_height_m, bottom stays at
    // extrude_base_m. Non-extrude layers keep both at 0 → flat path.
    const zWorld = b.let('z_world', select(isTop, extrudeHeightM, extrudeBaseM))
    const clip = b.var('clip', vec4fT, select(
      t.gt(6.5),
      transformMat4(mvp, vec4(globeRtc, f32(1))),
      transformMat4(mvp, vec4(rtc, zWorld, f32(1))),
    ))
    b.assign(clip.x, clip.x.add(fillTx.mul(clip.w)))
    b.assign(clip.y, clip.y.sub(fillTy.mul(clip.w)))
    b.assign(out.field('position', vec4fT), callFn('apply_log_depth', vec4fT, clip, logDepthFc))
    b.assign(out.field('position', vec4fT).z, out.field('position', vec4fT).z.sub(layerDepthOff.mul(out.field('position', vec4fT).w)))
    b.assign(out.field('view_w', f32T), clip.w)
    b.assign(out.field('cos_c', f32T), f32(0))
    b.assign(out.field('feat_id', u32T), toU32(p.feature_id))
    b.assign(out.field('abs_lat', f32T), absLatClamped)
    // wall_blend nested-select: extrude OFF → full brightness; extrude ON →
    // is_top:1 → 1.0 (roof), is_top:0 → 0.0 (wall bottom).
    b.assign(out.field('wall_blend', f32T),
      select(extrudeHeightM.gt(f32(0)), select(isTop, f32(1), f32(0)), f32(1)),
    )
    b.assign(out.field('abs_merc_x', f32T), absMercX)
    b.assign(out.field('abs_merc_y', f32T), absMercY)
    b.assign(out.field('world_z', f32T), zWorld)
    b.assign(out.field('v_color', vec4fT), vec4(f32(0), f32(0), f32(0), f32(0)))
    b.ret(out)
  },
)

// vs_main_quantized_extruded — iter-194 MapLibre-equivalent fill-extrusion
// vertex with per-vertex face-normal directional lighting + vertical
// gradient. The mesh-gen upload pipes per-vertex (z, normal.xyz) as a
// vec4 attribute (location 3); the entry unpacks it, runs the same
// projection chain as vs_main_quantized, then emits a PRE-SHADED color
// into v_color. The non-premultiplied output flows through X-GIS's
// BLEND_ALPHA which composites identically to MapLibre's pre-multiplied
// BLEND_ALPHA_PREMULT path (proof: final = src.rgb*src.a + dst*(1-src.a)
// reduces to the same expression both ways).

const vsMainQuantizedExtruded = entryFn(
  'vs_main_quantized_extruded', 'vertex',
  [
    { name: 'pos_raw', type: vec2uT, location: 0 },
    { name: 'feature_id', type: f32T, location: 2 },
    // iter-194 — .x = z (extrude height in metres), .yzw = outward unit normal.
    { name: 'z_attr', type: vec4fT, location: 3 },
  ],
  structT('VertexOutput'),
  (b, p) => {
    const camH = u.field('cam_h', vec2fT)
    const camL = u.field('cam_l', vec2fT)
    const tileOrigin = u.field('tile_origin_merc', vec2fT)
    const tileExtent = u.field('tile_extent_m', f32T)
    const projParams = u.field('proj_params', vec4fT)
    const mvp = u.field('mvp', mat4x4fT)
    const logDepthFc = u.field('log_depth_fc', f32T)
    const layerDepthOff = u.field('layer_depth_offset', f32T)
    const fillTx = u.field('fill_translate_x', f32T)
    const fillTy = u.field('fill_translate_y', f32T)
    const fillColor = u.field('fill_color', vec4fT)
    const deg2rad = constRef('DEG2RAD')
    const earthR = constRef('EARTH_R')
    const mercLatLim = constRef('MERCATOR_LAT_LIMIT')

    // Unpack quantized position (no is_top in this path — the z source is
    // the per-feature z_attr.x).
    const mxQ = b.let('mx_q', toF32(p.pos_raw.x.bitAnd(u32(0x7FFF))))
    const myQ = b.let('my_q', toF32(p.pos_raw.y))
    const local = b.let('local', vec2(mxQ, myQ).div(f32(32767)).mul(tileExtent))
    const camLocal = b.let('cam_local', camH.add(camL))
    const rel = b.let('rel', local.sub(camLocal))

    const absMercX = b.let('abs_merc_x', local.x.add(tileOrigin.x))
    const absMercY = b.let('abs_merc_y', local.y.add(tileOrigin.y))
    const absLon = b.let('abs_lon', absMercX.div(deg2rad.mul(earthR)))
    const latRad = b.let('lat_rad', callFn('inv_merc_lat_rad', f32T, absMercY))
    const absLat = b.let('abs_lat', latRad.div(deg2rad))
    const absLatClamped = b.let('abs_lat_clamped', clamp(absLat, mercLatLim.neg(), mercLatLim))

    const t = b.let('t', projParams.x)
    const rtc = b.var('rtc', vec2fT)
    b.if(t.lt(0.5), (c) => {
      c.assign(rtc, rel)
    }).else((c) => {
      const tileRefLon = c.let('tile_ref_lon',
        tileOrigin.x.add(f32(0.5).mul(tileExtent)).div(deg2rad.mul(earthR)),
      )
      const projXy = c.let('proj_xy', callFn('project_geom', vec2fT, absLon, absLat, projParams, tileRefLon))
      const centerXy = c.let('center_xy', callFn('project', vec2fT, projParams.y, projParams.z, projParams))
      c.assign(rtc, projXy.sub(centerXy))
    })
    const globeRtc = b.let('globe_rtc',
      callFn('proj_globe', vec3fT, absLon, absLat).sub(callFn('proj_globe', vec3fT, projParams.y, projParams.z)),
    )

    // iter-194 — unpack z + normal from the vec4 attribute.
    const zWorld = b.let('z_world', p.z_attr.x)
    const normal = b.let('normal', p.z_attr.swizzle('yzw') as Node<'vec3<f32>'>)

    const out = b.var('out', structT('VertexOutput'))
    const clip = b.var('clip', vec4fT, select(
      t.gt(6.5),
      transformMat4(mvp, vec4(globeRtc, f32(1))),
      transformMat4(mvp, vec4(rtc, zWorld, f32(1))),
    ))
    b.assign(clip.x, clip.x.add(fillTx.mul(clip.w)))
    b.assign(clip.y, clip.y.sub(fillTy.mul(clip.w)))
    b.assign(out.field('position', vec4fT), callFn('apply_log_depth', vec4fT, clip, logDepthFc))
    b.assign(out.field('position', vec4fT).z, out.field('position', vec4fT).z.sub(layerDepthOff.mul(out.field('position', vec4fT).w)))
    b.assign(out.field('view_w', f32T), clip.w)
    b.assign(out.field('cos_c', f32T), f32(0))
    b.assign(out.field('feat_id', u32T), toU32(p.feature_id))
    b.assign(out.field('abs_lat', f32T), absLatClamped)
    b.assign(out.field('wall_blend', f32T), select(zWorld.gt(f32(0)), f32(1), f32(0)))
    b.assign(out.field('abs_merc_x', f32T), absMercX)
    b.assign(out.field('abs_merc_y', f32T), absMercY)
    b.assign(out.field('world_z', f32T), zWorld)

    // iter-194 — MapLibre-equivalent face-normal directional lighting.
    // Direct port of fill_extrusion.vertex.glsl, with the default light
    // style: position [1.15, 210°, 30°] → cartesian (0.288, -0.498, 0.996);
    // intensity 0.5; color (1,1,1); vertical-gradient = 1.0.
    const colorRgb = b.let('color_rgb', fillColor.rgb)
    const opacity = b.let('opacity', fillColor.a)
    // Luminance weights (Rec. 709). Per-component access is cleaner than a
    // dot(rgb, vec3(0.2126,0.7152,0.0722)) because the literal then needs a
    // vec3 construct; the explicit chain matches MapLibre's source.
    const colorValue = b.let('colorvalue',
      colorRgb.r.mul(0.2126).add(colorRgb.g.mul(0.7152)).add(colorRgb.b.mul(0.0722)),
    )
    const ambient = b.let('ambient', vec3(f32(0.03)))
    const litColorRgb = b.let('lit_color_rgb', colorRgb.add(ambient))
    const lightPos = b.let('LIGHT_POS', vec3(f32(0.288), f32(-0.498), f32(0.996)))
    const lightIntensity = b.let('LIGHT_INTENSITY', f32(0.5))
    const lightColor = b.let('LIGHT_COLOR', vec3(f32(1)))
    const directional = b.var('directional', f32T, clamp(dot(normal, lightPos), f32(0), f32(1)))
    b.assign(directional, mix(
      f32(1).sub(lightIntensity),
      max(f32(1).sub(colorValue).add(lightIntensity), f32(1)),
      directional,
    ))
    // Vertical gradient — walls only (|nz| < 0.5). t = is-top boolean.
    const isWall = b.let('is_wall', abs(normal.z).lt(0.5))
    const tTop = b.let('t_top', select(zWorld.gt(f32(0)), f32(1), f32(0)))
    b.if(isWall, (c) => {
      // (t_top + base) * sqrt(height/150). For the bottom vertex we
      // approximate height by max(z_world, 1) so the gradient still
      // computes a sensible value for the bottom lip.
      const hForGrad = c.let('h_for_grad', max(zWorld, f32(1)))
      const vgrad = c.let('vgrad', clamp(
        tTop.mul(sqrt(hForGrad.div(f32(150)))),
        mix(f32(0.7), f32(0.98), f32(1).sub(lightIntensity)),
        f32(1),
      ))
      c.assign(directional, directional.mul(vgrad))
    })
    const shadedRgb = b.let('shaded_rgb',
      clamp(litColorRgb.mul(directional).mul(lightColor), vec3(f32(0)), vec3(f32(1))),
    )
    // Non-premultiplied output — see entry header for the X-GIS BLEND_ALPHA
    // vs MapLibre BLEND_ALPHA_PREMULT equivalence proof.
    b.assign(out.field('v_color', vec4fT), vec4(shadedRgb, opacity))
    b.ret(out)
  },
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

const emitPolygonFragmentDiscards = (b: Builder, input: Node): void => {
  const cosC = callFn('polygon_cos_c_fragment', f32T, input.field('abs_merc_x', f32T), input.field('abs_merc_y', f32T))
  b.if(cosC.lt(f32(0)), (c) => { c.discard() })
  b.if(abs(input.field('abs_lat', f32T)).gt(constRef('MERCATOR_LAT_LIMIT')), (c) => { c.discard() })
  const clipBounds = u.field('clip_bounds', vec4fT)
  const clipValid = b.let('_clip_valid',
    clipBounds.x.gt(f32(-1e29))
      .and(clipBounds.z.gt(clipBounds.x))
      .and(clipBounds.w.gt(clipBounds.y)),
  )
  b.if(clipValid, (c) => {
    c.if(input.field('abs_merc_x', f32T).lt(clipBounds.x), (d) => { d.discard() })
    c.if(input.field('abs_merc_x', f32T).gt(clipBounds.z), (d) => { d.discard() })
    c.if(input.field('abs_merc_y', f32T).lt(clipBounds.y), (d) => { d.discard() })
    c.if(input.field('abs_merc_y', f32T).gt(clipBounds.w), (d) => { d.discard() })
  })
}

// Per-feature deterministic depth jitter — breaks coplanar z-fights at
// shared building walls. xor-shift mix on the low 16 bits of feat_id keeps
// the math strictly in u32-wrap-on-overflow (avoids Apple Metal's multiply-
// overflow validation reject). Range ≈ ±1.5e-5 NDC z (sub-pixel at any
// reasonable depth precision). Synthetic background features (feat_id==0)
// keep the canonical un-jittered depth.

const emitLogDepthJitter = (b: Builder, input: Node, out: Node): void => {
  const baseDepth = b.let('base_depth',
    callFn('compute_log_frag_depth', f32T, input.field('view_w', f32T), u.field('log_depth_fc', f32T)),
  )
  const idLo = b.let('id_lo', input.field('feat_id', u32T).bitAnd(u32(0xFFFF)))
  const mixed = b.let('mixed',
    idLo.bitXor(idLo.shr(u32(7))).bitXor(idLo.shl(u32(3))).bitAnd(u32(0x3FF)),
  )
  const jitter = b.let('jitter', select(
    input.field('feat_id', u32T).ne(u32(0)),
    toF32(mixed).sub(f32(512)).mul(f32(1.5e-8)),
    f32(0),
  ))
  b.assign(out.field('depth', f32T), baseDepth.add(jitter))
}

// Pick attachment write — only emits when pickEnabled. low16 = u.pick_id;
// high16 reserved (always 0 in current renderer; WORLD_COPIES will populate).

const emitPickWrite = (b: Builder, out: Node, pickEnabled: boolean): void => {
  if (!pickEnabled) return
  b.assign(out.field('pick', vec2uT), vec2u(u.field('pick_id', u32T), u32(0)))
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
  entryFn(
    'fs_fill', 'fragment',
    [{ name: 'input', type: structT('VertexOutput') }],
    structT('FragmentOutput'),
    (b, p) => {
      const input = p.input
      emitPolygonFragmentDiscards(b, input)
      const out = b.var('out', structT('FragmentOutput'))
      // Fill-extrusion shading via wall_blend varying. Iter 129 final after
      // the derivative-normal experiment was reverted — see fs_fill comment
      // in POLYGON_SHADER_SOURCE for the rationale.
      const wallBlend = input.field('wall_blend', f32T)
      const vShade = b.let('v_shade', f32(0.6).add(f32(0.4).mul(wallBlend)))
      const roofBonus = b.let('roof_bonus', select(wallBlend.ge(f32(0.999)), f32(0.05), f32(0)))
      const wallShade = b.let('wall_shade', min(f32(1), vShade.add(roofBonus)))
      // wall_shade reference kept live for the composer's default-path
      // assign emit (the variant-injected path uses its own preamble + expr
      // and ignores wall_shade unless the variant authored it back in).
      void wallShade
      // ▼ Composer-swap point — variant.fillExpr replaces this OR the
      //   composer inserts the base default-uniform path:
      //     out.color = vec4<f32>(u.fill_color.rgb * wall_shade, u.fill_color.a);
      b.placeholder('fill-return')
      // Rim alpha fade — applied AFTER the marker so variant pipelines
      // inherit it without per-variant codegen plumbing.
      const rimA = callFn('polygon_rim_alpha', f32T, input.field('abs_merc_x', f32T), input.field('abs_merc_y', f32T))
      b.assign(out.field('color', vec4fT).a, out.field('color', vec4fT).a.mul(rimA))
      emitPickWrite(b, out, pickEnabled)
      emitLogDepthJitter(b, input, out)
      b.ret(out)
    },
  )

// fs_fill_pattern — iter-181/182 fill-pattern Stage 2 fragment. World-anchored
// repeating-tile UV via abs_merc / repeat_m; the local UV is then remapped
// into the sprite atlas-UV bbox stored in u.fill_color (rgba = u0/v0/u1/v1).
// fill-translate slots are reused as the repeat metres (Stage 2 trade-off:
// pattern-fill layers can't also use a solid colour or a translate offset).

const buildFsFillPattern = (pickEnabled: boolean) =>
  entryFn(
    'fs_fill_pattern', 'fragment',
    [{ name: 'input', type: structT('VertexOutput') }],
    structT('FragmentOutput'),
    (b, p) => {
      const input = p.input
      emitPolygonFragmentDiscards(b, input)
      const out = b.var('out', structT('FragmentOutput'))
      const repeatX = b.let('repeat_x', max(u.field('fill_translate_x', f32T), f32(1)))
      const repeatY = b.let('repeat_y', max(u.field('fill_translate_y', f32T), f32(1)))
      const uvLocal = b.let('uv_local', vec2(
        fract(input.field('abs_merc_x', f32T).div(repeatX)),
        fract(input.field('abs_merc_y', f32T).div(repeatY)),
      ))
      const fillColor = u.field('fill_color', vec4fT)
      const u0 = b.let('u0', fillColor.r)
      const v0 = b.let('v0', fillColor.g)
      const u1 = b.let('u1', fillColor.b)
      const v1 = b.let('v1', fillColor.a)
      const atlasUv = b.let('atlas_uv', vec2(
        u0.add(uvLocal.x.mul(u1.sub(u0))),
        v0.add(uvLocal.y.mul(v1.sub(v0))),
      ))
      const sampled = b.let('sampled', textureSample(spriteAtlas, spriteSamp, atlasUv))
      // Layer opacity multiplies sprite alpha so fill-opacity still works.
      b.assign(out.field('color', vec4fT), vec4(sampled.rgb, sampled.a.mul(u.field('opacity', f32T))))
      const rimA = callFn('polygon_rim_alpha', f32T, input.field('abs_merc_x', f32T), input.field('abs_merc_y', f32T))
      b.assign(out.field('color', vec4fT).a, out.field('color', vec4fT).a.mul(rimA))
      emitPickWrite(b, out, pickEnabled)
      emitLogDepthJitter(b, input, out)
      b.ret(out)
    },
  )

// fs_oit_translucent — Weighted Blended OIT (McGuire-Bavoil 2013) output.
// Writes the dual MRT: @location(0) accum = (rgb·a·w, a·w) [BLEND_ADD]
// + @location(1) revealage = a [BLEND mul-by-1-src]. Compose pass divides
// accum.rgb by accum.a to recover the weighted-average colour, then uses
// (1 - product_of_(1-a)) as the over-blend alpha onto the opaque
// framebuffer. The McGuire-Bavoil 7.4 weight biases small-z fragments to
// dominate (matching painter's order for clear front-most geometry);
// clamps prevent fp16 running-sum overflow.

const fsOitTranslucent = entryFn(
  'fs_oit_translucent', 'fragment',
  [{ name: 'input', type: structT('VertexOutput') }],
  structT('OitFragmentOutput'),
  (b, p) => {
    const input = p.input
    emitPolygonFragmentDiscards(b, input)
    // Same fill-extrusion shading as fs_fill.
    const wallBlend = input.field('wall_blend', f32T)
    const vShade = b.let('v_shade', f32(0.6).add(f32(0.4).mul(wallBlend)))
    const roofBonus = b.let('roof_bonus', select(wallBlend.ge(f32(0.999)), f32(0.05), f32(0)))
    const wallShade = b.let('wall_shade', min(f32(1), vShade.add(roofBonus)))
    const fillColor = u.field('fill_color', vec4fT)
    const rgb = b.let('rgb', fillColor.rgb.mul(wallShade))
    // Rim alpha fade (multiplies into alpha so OIT accumulation respects it).
    const rimA = callFn('polygon_rim_alpha', f32T, input.field('abs_merc_x', f32T), input.field('abs_merc_y', f32T))
    const a = b.let('a', fillColor.a.mul(rimA))
    b.if(a.le(f32(0.001)), (c) => { c.discard() })
    // McGuire-Bavoil weight: large for closer + smaller alpha contributions,
    // capped to avoid fp16 overflow. iter-192 set weight=1; reverted in
    // iter-193 alongside the depth-write change.
    const z = b.let('z', max(input.field('view_w', f32T), f32(1e-3)))
    const w = b.let('w', clamp(
      f32(0.03).div(f32(1e-5).add(pow(z.div(f32(200)), f32(4)))),
      f32(1e-2),
      f32(3.0e3),
    ))
    const out = b.var('out', structT('OitFragmentOutput'))
    b.assign(out.field('accum', vec4fT), vec4(rgb.mul(a), a).mul(w))
    b.assign(out.field('revealage', f32T), a)
    b.ret(out)
  },
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
  entryFn(
    'fs_fill_extrude', 'fragment',
    [{ name: 'input', type: structT('VertexOutput') }],
    structT('FragmentOutput'),
    (b, p) => {
      const input = p.input
      emitPolygonFragmentDiscards(b, input)
      const out = b.var('out', structT('FragmentOutput'))
      // Rim alpha — operates on the premultiplied colour: scales both rgb
      // and alpha by the rim factor so the building still fades at sphere
      // edges on globe / azimuthal projections.
      const rim = b.let('rim', callFn('polygon_rim_alpha', f32T, input.field('abs_merc_x', f32T), input.field('abs_merc_y', f32T)))
      b.assign(out.field('color', vec4fT), input.field('v_color', vec4fT).mul(rim))
      emitPickWrite(b, out, pickEnabled)
      emitLogDepthJitter(b, input, out)
      b.ret(out)
    },
  )

// fs_stroke — main polygon stroke fragment. Same 3 discards as fs_fill,
// then a minor/major alpha-scale gated on feat_id > 0 (major grid line vs
// minor — the synthetic-feat encoding upstream), then the composer-swap
// placeholder Stmt 'stroke-return' (composer swaps with variant.strokeExpr
// OR the default `u.stroke_color.rgb * alpha_scale` assign), then rim_alpha
// multiply + pick write (conditional) + log-depth (NO jitter — strokes
// are thin enough that the coplanar fight class doesn't apply).

const buildFsStroke = (pickEnabled: boolean) =>
  entryFn(
    'fs_stroke', 'fragment',
    [{ name: 'input', type: structT('VertexOutput') }],
    structT('FragmentOutput'),
    (b, p) => {
      const input = p.input
      emitPolygonFragmentDiscards(b, input)
      // feat_id > 0 = major grid line (brighter); 0 = minor (dimmer).
      const alphaScale = b.let('alpha_scale', select(input.field('feat_id', u32T).gt(u32(0)), f32(1), f32(0.4)))
      void alphaScale
      const out = b.var('out', structT('FragmentOutput'))
      // ▼ Composer-swap point — variant.strokeExpr replaces this OR the
      //   composer inserts the base default-uniform path:
      //     out.color = vec4<f32>(u.stroke_color.rgb, u.stroke_color.a * alpha_scale);
      b.placeholder('stroke-return')
      const rimA = callFn('polygon_rim_alpha', f32T, input.field('abs_merc_x', f32T), input.field('abs_merc_y', f32T))
      b.assign(out.field('color', vec4fT).a, out.field('color', vec4fT).a.mul(rimA))
      emitPickWrite(b, out, pickEnabled)
      // Stroke depth: bare log-depth, no per-feature jitter.
      b.assign(out.field('depth', f32T), callFn('compute_log_frag_depth', f32T, input.field('view_w', f32T), u.field('log_depth_fc', f32T)))
      b.ret(out)
    },
  )

// fs_overdraw — debug=overdraw single constant-output entry shared by every
// debug-variant pipeline. Vertex shaders still project correctly so the
// rasterizer produces the SAME fragments as the normal path; FS work
// collapses to one write that an additive blend sums into the r16float
// accumulator. NO @builtin(frag_depth) write — debug overdraw doesn't
// participate in the variant marker substitution.

const fsOverdraw = entryFn(
  'fs_overdraw', 'fragment', [], vec4fT,
  (b) => {
    b.ret(vec4(f32(1), f32(0), f32(0), f32(0)))
  },
  '@location(0)',
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
  const out = new Node({ op: 'varref', type: structT('FragmentOutput'), name: 'out' })
  const wallShade = new Node<'f32'>({ op: 'varref', type: f32T, name: 'wall_shade' })
  const fillColor = u.field('fill_color', vec4fT)
  b.assign(out.field('color', vec4fT), vec4(fillColor.rgb.mul(wallShade), fillColor.a))
  return b.stmts
}

const defaultStrokeReturnStmts = (): readonly Stmt[] => {
  const b = new Builder()
  const out = new Node({ op: 'varref', type: structT('FragmentOutput'), name: 'out' })
  const alphaScale = new Node<'f32'>({ op: 'varref', type: f32T, name: 'alpha_scale' })
  const strokeColor = u.field('stroke_color', vec4fT)
  b.assign(out.field('color', vec4fT), vec4(strokeColor.rgb, strokeColor.a.mul(alphaScale)))
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
  const out = new Node({ op: 'varref', type: structT('FragmentOutput'), name: 'out' })
  b.assign(out.field('color', vec4fT), expr)
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
// 3 vertex entries (vs_main / vs_main_quantized / vs_main_quantized_extruded)
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
    structs: [Uniforms, VertexOutput, OitFragmentOutput, polygonFragmentOutput(pickEnabled)],
    bindings: [
      { group: 0, binding: 0, name: 'u', space: 'uniform', type: structT('Uniforms') },
      { group: 0, binding: 5, name: 'sprite_atlas', space: 'uniform', type: texture2dfT },
      { group: 0, binding: 6, name: 'sprite_samp', space: 'uniform', type: samplerT },
    ],
    funcs: [
      polygonCosCFragment,
      polygonRimAlpha,
      vsMain,
      vsMainQuantized,
      vsMainQuantizedExtruded,
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

  return module({
    consts: [...base.consts, ...(variant?.preamble?.consts ?? [])],
    structs: base.structs,
    bindings: [...base.bindings, ...extraBindings, ...(variant?.preamble?.bindings ?? [])],
    funcs: [...composedFuncs, ...(variant?.preamble?.funcs ?? [])],
  })
}

/** Polygon shader emit entry point.
 *
 *  Phase 2.5 US-007b SKELETON — emits the prepended projection consts +
 *  log-depth fns + projection fns, then the polygon base module (structs +
 *  fixed bindings + helpers + fs_overdraw). The 3 vertex + 5 main fragment
 *  entries + the placeholder Stmt swap + the pick attachment conditional
 *  land in subsequent iters.
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
): string => [
  PROJECTION_WGSL_CONSTS,
  LOG_DEPTH_WGSL_FNS,
  PROJECTION_WGSL_FNS,
  emitModule(buildPolygonModule(variant, pickEnabled)),
].join('\n')
