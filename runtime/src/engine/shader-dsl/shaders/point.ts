// ═══ Shader DSL — point (SDF marker) shader (Phase 2) ═══
//
// Re-authors render/point-renderer-shaders.ts POINT_SHADER. Per-feature data
// lives in storage<read> buffers (feat_data, shapes, segments); the vertex
// stage expands a per-instance quad around the point centre in either flat
// (world-space) or billboard (screen-space) mode, and the fragment rasterises
// the SDF shape (analytic circle for shape_id=0, otherwise from the storage
// segments). Bitwise unpacking of per-feature flags / size mode / anchor mode
// exercises the IR's bitwise op extension (& | ^ << >>).
//
// emitPointWgsl prepends the shared DSL strings (PROJECTION_WGSL_CONSTS +
// LOG_DEPTH_WGSL_FNS + PROJECTION_WGSL_FNS) so vs/fs callFn project /
// inv_merc_lat_rad / needs_backface_cull / rim_alpha / proj_globe /
// apply_log_depth / compute_log_frag_depth by name and constRef PI /
// DEG2RAD / EARTH_R / MERCATOR_LAT_LIMIT.
//
// No pick variant — the point fragment carries no pick channel (matches the
// hand shader exactly).

import {
  entryFn, fn, module, bindingRef, callFn, transformMat4, arrayLit,
  f32, u32, i32, toF32, toU32, vec2, vec3, vec4, mix, exp, clamp,
  length, dot, min, max, smoothstep, fwidth,
  structT, f32T, u32T, i32T, vec2fT, vec4fT, mat4x4fT, arrayT,
  type StructDecl, type ModuleDecl,
} from '../core/ir'
import { emitModule } from '../core/backends/wgsl'
import { PROJECTION_WGSL_CONSTS, PROJECTION_WGSL_FNS } from './projections'
import { LOG_DEPTH_WGSL_FNS } from './log-depth'

const Uniforms: StructDecl = {
  name: 'Uniforms',
  fields: [
    // Phase 2 PR 2d.2 — POINT VS ECEF migration. `mvp` holds the ECEF-MVP
    // (Camera.getECEFFrameView), not the legacy Mercator-RTC MVP. Post
    // PR 2d.5 closeout, all polygon/line/raster/point shaders use the
    // single `mvp` slot for the ECEF-MVP — the dual-slot Mercator+ECEF
    // layout was retired (polygon Uniforms shrunk 256 → 192 bytes).
    { name: 'mvp', type: mat4x4fT },
    // proj_params: x=projType, y=centerLon, z=centerLat. Retained for the
    // fragment-side hemisphere-cull (needs_backface_cull + rim_alpha)
    // which still branches on projType to short-circuit flat projections.
    { name: 'proj_params', type: vec4fT },
    // tile_rtc deleted (Phase 2 PR 2d.2) — the camera-relative anchor used
    // to live here for the Mercator-DSFUN VS; ECEF VS computes the clip
    // position directly from per-feature ECEF DSFUN, no per-tile offset.
    { name: 'viewport', type: vec4fT },      // xy = w/h, z = meters/px, w = log_depth_fc
    // Camera-relative RTC fix: the per-feature ECEF DSFUN is now ABSOLUTE, but
    // the MVP (Camera.getECEFFrameView) is camera-at-ENU-origin. Subtract the
    // camera anchor (getECEFCenter, sphere) — split DSFUN hi/lo to preserve
    // sub-mm precision: ecef_rtc = (ecefH − camH) + (ecefL − camL). xyz used,
    // w unused.
    { name: 'cam_ecef_h', type: vec4fT },
    { name: 'cam_ecef_l', type: vec4fT },
  ],
}
const ShapeDesc: StructDecl = {
  name: 'ShapeDesc',
  fields: [
    { name: 'seg_start', type: u32T },
    { name: 'seg_count', type: u32T },
    { name: 'bbox_min_x', type: f32T },
    { name: 'bbox_min_y', type: f32T },
    { name: 'bbox_max_x', type: f32T },
    { name: 'bbox_max_y', type: f32T },
    { name: '_pad0', type: f32T },
    { name: '_pad1', type: f32T },
  ],
}
const Segment: StructDecl = {
  name: 'Segment',
  fields: [
    { name: 'kind', type: u32T },          // 0=line 1=quad 2=cubic
    { name: 'color_idx', type: u32T },
    { name: 'flags', type: u32T },
    { name: '_pad', type: u32T },
    { name: 'p0', type: vec2fT },
    { name: 'p1', type: vec2fT },
    { name: 'p2', type: vec2fT },
    { name: 'p3', type: vec2fT },
  ],
}
const PointOut: StructDecl = {
  name: 'PointOut',
  fields: [
    { name: 'position', type: vec4fT, attr: '@builtin(position)' },
    { name: 'uv', type: vec2fT, attr: '@location(0)' },
    { name: 'feat_id', type: u32T, attr: '@location(1) @interpolate(flat)' },
    { name: 'radius_px', type: f32T, attr: '@location(2) @interpolate(flat)' },
    { name: 'view_w', type: f32T, attr: '@location(3)' },
    { name: 'cos_c', type: f32T, attr: '@location(4) @interpolate(flat)' },
    { name: 'rim_a', type: f32T, attr: '@location(5) @interpolate(flat)' },
  ],
}
const PointFragmentOutput: StructDecl = {
  name: 'PointFragmentOutput',
  fields: [
    { name: 'color', type: vec4fT, attr: '@location(0)' },
    { name: 'depth', type: f32T, attr: '@builtin(frag_depth)' },
  ],
}

const u = bindingRef('u', structT('Uniforms'))
const featData = bindingRef('feat_data', arrayT(f32T))
const shapes = bindingRef('shapes', arrayT(structT('ShapeDesc')))
const segments = bindingRef('segments', arrayT(structT('Segment')))

// STRIDE — per-feature feat_data stride (matches the renderer's f32 pack order).
// Phase 2 PR 2d.2 — bumped 14 → 20 to carry per-feature ECEF DSFUN center
// (6 floats: pos_h.xyz + pos_l.xyz at slots 11..16) and absolute lon/lat
// (2 floats at slots 17..18). Slot 19 holds shape_id (was slot 13 in the
// pre-PR-2d.2 stride-14 layout). Memory delta: +24 B per feature.
// Bumped 20 → 24 for the absolute Mercator DSFUN tail (slots 20-23 =
// mx_h, mx_l, my_h, my_l) — precise flat-Mercator position so the flat-Merc
// branch no longer reprojects the lossy f32 abs_lon/abs_lat (~5.7 px @ z20).
const STRIDE = u32(24)

// ── Helper fns ──
// Phase 2 PR 2d.2 — POINT VS ECEF migration. `point_abs_lonlat`,
// `reproject_point`, `reproject_point_globe` deleted: per-feature abs_lon/
// abs_lat now arrive baked into featData (slots 17/18), and the position
// transform collapses to a single `u.mvp * vec4(ecef_rtc, 1)` against
// ECEF-DSFUN vertices (no per-projection ladder, no rtc_merc).
//
// `point_cos_c` + `point_rim_alpha` kept (signature changed to
// `(abs_lon, abs_lat)`): the fragment-side hemisphere cull + rim fade still
// branches on projType via proj_params to short-circuit flat projections,
// mirroring polygon_cos_c_fragment + polygon_rim_alpha in polygon.ts.

const pointCosC = fn('point_cos_c', { abs_lon: f32T, abs_lat: f32T }, f32T, (b, p) => {
  b.ret(callFn('needs_backface_cull', f32T, p.abs_lon, p.abs_lat, u.field('proj_params', vec4fT)))
})

const pointRimAlpha = fn('point_rim_alpha', { abs_lon: f32T, abs_lat: f32T }, f32T, (b, p) => {
  b.ret(callFn('rim_alpha', f32T, p.abs_lon, p.abs_lat, u.field('proj_params', vec4fT)))
})

const distToLine = fn('dist_to_line', { p: vec2fT, a: vec2fT, b: vec2fT }, f32T, (bld, pp) => {
  const ab = bld.let('ab', pp.b.sub(pp.a))
  const len2 = bld.let('len2', dot(ab, ab))
  bld.if(len2.lt(1e-10), (c) => { c.ret(length(pp.p.sub(pp.a))) })
  const t = bld.let('t', clamp(dot(pp.p.sub(pp.a), ab).div(len2), 0, 1))
  bld.ret(length(pp.p.sub(pp.a).sub(ab.mul(t))))
})

const distToQuadratic = fn('dist_to_quadratic', { p: vec2fT, a: vec2fT, b: vec2fT, c: vec2fT }, f32T, (bld, pp) => {
  const bestD = bld.var('best_d', f32T, f32(1e10))
  bld.forRange('i', u32(0), (i) => i.le(u32(16)), (cb, i) => {
    const t = cb.let('t', toF32(i).div(16))
    const ab = cb.let('ab', mix(pp.a, pp.b, t))
    const bc = cb.let('bc', mix(pp.b, pp.c, t))
    const q = cb.let('q', mix(ab, bc, t))
    cb.assign(bestD, min(bestD, length(pp.p.sub(q))))
  })
  bld.ret(bestD)
})

const distToCubic = fn('dist_to_cubic', { p: vec2fT, a: vec2fT, b: vec2fT, c: vec2fT, d: vec2fT }, f32T, (bld, pp) => {
  const bestD = bld.var('best_d', f32T, f32(1e10))
  bld.forRange('i', u32(0), (i) => i.le(u32(24)), (cb, i) => {
    const t = cb.let('t', toF32(i).div(24))
    const ab = cb.let('ab', mix(pp.a, pp.b, t))
    const bc = cb.let('bc', mix(pp.b, pp.c, t))
    const cd = cb.let('cd', mix(pp.c, pp.d, t))
    const abc = cb.let('abc', mix(ab, bc, t))
    const bcd = cb.let('bcd', mix(bc, cd, t))
    const q = cb.let('q', mix(abc, bcd, t))
    cb.assign(bestD, min(bestD, length(pp.p.sub(q))))
  })
  bld.ret(bestD)
})

const windingLine = fn('winding_line', { p: vec2fT, a: vec2fT, b: vec2fT }, i32T, (bld, pp) => {
  bld.if(pp.a.y.le(pp.p.y), (c) => {
    c.if(pp.b.y.gt(pp.p.y), (d) => {
      const crossVal = d.let('cross_val', pp.b.x.sub(pp.a.x).mul(pp.p.y.sub(pp.a.y)).sub(pp.p.x.sub(pp.a.x).mul(pp.b.y.sub(pp.a.y))))
      d.if(crossVal.gt(0), (e) => { e.ret(i32(1)) })
    })
  }).else((c) => {
    c.if(pp.b.y.le(pp.p.y), (d) => {
      const crossVal = d.let('cross_val', pp.b.x.sub(pp.a.x).mul(pp.p.y.sub(pp.a.y)).sub(pp.p.x.sub(pp.a.x).mul(pp.b.y.sub(pp.a.y))))
      d.if(crossVal.lt(0), (e) => { e.ret(i32(-1)) })
    })
  })
  bld.ret(i32(0))
})

const sdfShape = fn('sdf_shape', { uv_in: vec2fT, shape_id: u32T }, f32T, (bld, pp) => {
  // Flip Y: NDC Y-up → SVG/path Y-down convention.
  const uv = bld.let('uv', vec2(pp.uv_in.x, pp.uv_in.y.neg()))
  const s = bld.let('s', shapes.at(pp.shape_id, structT('ShapeDesc')))
  const bMinX = s.field('bbox_min_x', f32T)
  const bMinY = s.field('bbox_min_y', f32T)
  const bMaxX = s.field('bbox_max_x', f32T)
  const bMaxY = s.field('bbox_max_y', f32T)
  // AABB early-out.
  bld.if(
    uv.x.lt(bMinX).or(uv.x.gt(bMaxX)).or(uv.y.lt(bMinY)).or(uv.y.gt(bMaxY)),
    (c) => { c.ret(f32(2)) },
  )
  const minDist = bld.var('min_dist', f32T, f32(1e10))
  const winding = bld.var('winding', i32T, i32(0))
  const segStart = s.field('seg_start', u32T)
  const segCount = s.field('seg_count', u32T)
  // Hard-cap at 32 segments per shape (paste from original).
  const end = bld.let('end', min(segStart.add(segCount), segStart.add(u32(32))))
  bld.forRange('i', segStart, (i) => i.lt(end), (cb, i) => {
    const seg = cb.let('seg', segments.at(i, structT('Segment')))
    const p0 = seg.field('p0', vec2fT)
    const p1 = seg.field('p1', vec2fT)
    const p2 = seg.field('p2', vec2fT)
    const p3 = seg.field('p3', vec2fT)
    cb.switch(seg.field('kind', u32T), [
      [0, (d) => {
        d.assign(minDist, min(minDist, callFn('dist_to_line', f32T, uv, p0, p1)))
        d.assignOp(winding, '+', callFn('winding_line', i32T, uv, p0, p1))
      }],
      [1, (d) => {
        d.assign(minDist, min(minDist, callFn('dist_to_quadratic', f32T, uv, p0, p1, p2)))
        // Approximate winding with chord.
        d.assignOp(winding, '+', callFn('winding_line', i32T, uv, p0, p2))
      }],
      [2, (d) => {
        d.assign(minDist, min(minDist, callFn('dist_to_cubic', f32T, uv, p0, p1, p2, p3)))
        // Approximate winding with chord.
        d.assignOp(winding, '+', callFn('winding_line', i32T, uv, p0, p3))
      }],
    ], () => { /* default: empty */ })
  })
  // Inside (winding != 0): dist=1 at boundary; outside: dist=1+min_dist.
  bld.if(winding.ne(i32(0)), (c) => { c.ret(f32(1).sub(minDist)) })
    .else((c) => { c.ret(f32(1).add(minDist)) })
})

// ── Entry points ──

const vs = entryFn('vs_point', 'vertex', [
  { name: 'center', type: vec2fT, location: 0 },
  { name: 'quad_id', type: u32T, location: 1 },
  { name: 'feat_id', type: f32T, location: 2 },
], structT('PointOut'), (b, p) => {
  const offsets = b.let('offsets', arrayLit(vec2fT,
    vec2(f32(-1), f32(-1)),
    vec2(f32(1), f32(-1)),
    vec2(f32(1), f32(1)),
    vec2(f32(-1), f32(1)),
  ))
  const fid = b.let('fid', toU32(p.feat_id))
  const rawRadius = b.let('raw_radius', featData.at(fid.mul(STRIDE).add(u32(0)), f32T))
  // Pack-byte at offset 10: bit 0..3 reserved, bits 4..7 = size_mode,
  // bit 3 = is_flat, bits 8..9 = anchor_mode.
  const packed10 = b.let('packed10', toU32(featData.at(fid.mul(STRIDE).add(u32(10)), f32T)))
  const sizeMode = b.let('size_mode', packed10.shr(u32(4)).bitAnd(u32(0xF)))
  // Size mode: 0=px, 1=m, 2=km, 3=deg (equator approx), 4=nm.
  const radiusPx = b.var('radius_px', f32T)
  const viewport = u.field('viewport', vec4fT)
  b.if(sizeMode.eq(u32(1)), (c) => { c.assign(radiusPx, rawRadius.div(viewport.z)) })
    .elif(sizeMode.eq(u32(2)), (c) => { c.assign(radiusPx, rawRadius.mul(1000).div(viewport.z)) })
    .elif(sizeMode.eq(u32(3)), (c) => { c.assign(radiusPx, rawRadius.mul(111320).div(viewport.z)) })
    .elif(sizeMode.eq(u32(4)), (c) => { c.assign(radiusPx, rawRadius.mul(1852).div(viewport.z)) })
    .else((c) => { c.assign(radiusPx, rawRadius) })

  // Phase 2 PR 2d.2 — ECEF DSFUN per-feature centre.
  // featData slots 11..16 carry the tile-anchored ECEF DSFUN split
  // (pos_h.xyz + pos_l.xyz) for the point's centre; slots 17..18 carry
  // the absolute lon/lat in degrees for the fragment-side hemisphere
  // cull. The single `u.mvp` slot is the ECEF-MVP (post PR 2d.5).
  const ecefH = b.let('ecef_h', vec3(
    featData.at(fid.mul(STRIDE).add(u32(11)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(12)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(13)), f32T),
  ))
  const ecefL = b.let('ecef_l', vec3(
    featData.at(fid.mul(STRIDE).add(u32(14)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(15)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(16)), f32T),
  ))
  // Camera-relative RTC: subtract the camera anchor in DSFUN space so the
  // big absolute ECEF magnitude cancels before the residual reaches f32 math.
  const camH = b.let('cam_h', u.field('cam_ecef_h', vec4fT).swizzle<'vec3<f32>'>('xyz'))
  const camL = b.let('cam_l', u.field('cam_ecef_l', vec4fT).swizzle<'vec3<f32>'>('xyz'))
  const ecefRtc = b.let('ecef_rtc', ecefH.sub(camH).add(ecefL.sub(camL)))
  const absLon = b.let('abs_lon', featData.at(fid.mul(STRIDE).add(u32(17)), f32T))
  const absLat = b.let('abs_lat', featData.at(fid.mul(STRIDE).add(u32(18)), f32T))
  const mvp = u.field('mvp', mat4x4fT)
  // Display projection (projection-display-layer-restore): flat Mercator
  // (proj_params.x < 0.5) reprojects the absolute lon/lat onto the 2D plane
  // and feeds the flat Mercator-metre MVP; 3D / globe keeps the ECEF-RTC
  // anchor. For the flat path the renderer writes the 2D camera centre
  // (Mercator metres, DSFUN hi/lo) into cam_ecef_h.xy / cam_ecef_l.xy — those
  // ECEF lanes are dead on the flat path. u.mvp is the matching matrix
  // (Camera.getViewForProjection). Quad expansion below consumes centerClip
  // identically for both paths.
  const centerClip = b.var('center_clip', vec4fT)
  b.if(u.field('proj_params', vec4fT).x.lt(0.5), (c) => {
    // Precise absolute Mercator DSFUN (slots 20-23), camera-recentered in DSFUN
    // space — `(mx_h−camH)+(mx_l−camL)` — exactly like ecef_rtc. The old path
    // reprojected the lossy f32 abs_lon/abs_lat (~1.35 m → ~5.7 px @ z20).
    const mxH = c.let('mx_h', featData.at(fid.mul(STRIDE).add(u32(20)), f32T))
    const mxL = c.let('mx_l', featData.at(fid.mul(STRIDE).add(u32(21)), f32T))
    const myH = c.let('my_h', featData.at(fid.mul(STRIDE).add(u32(22)), f32T))
    const myL = c.let('my_l', featData.at(fid.mul(STRIDE).add(u32(23)), f32T))
    const camMercH = c.let('cam_merc_h', u.field('cam_ecef_h', vec4fT).swizzle<'vec2<f32>'>('xy'))
    const camMercL = c.let('cam_merc_l', u.field('cam_ecef_l', vec4fT).swizzle<'vec2<f32>'>('xy'))
    const relX = c.let('rel_x', mxH.sub(camMercH.x).add(mxL.sub(camMercL.x)))
    const relY = c.let('rel_y', myH.sub(camMercH.y).add(myL.sub(camMercL.y)))
    c.assign(centerClip, transformMat4(mvp, vec4(relX, relY, f32(0), f32(1))))
  }).elif(u.field('proj_params', vec4fT).x.lt(6.5), (c) => {
    // FLAT non-Mercator (1-6): the shared flat_rel — reproject the marker's
    // lon/lat minus the in-shader projected camera centre. ref_lon = the
    // marker's own lon (self) so it lands in its nearest world copy; for an
    // individual marker project_geom collapses to plain project. Same flat MVP.
    const pp = c.let('pp', u.field('proj_params', vec4fT))
    const relG = c.let('rel2d_geom', callFn('flat_rel', vec2fT, absLon, absLat, pp, absLon))
    c.assign(centerClip, transformMat4(mvp, vec4(relG.x, relG.y, f32(0), f32(1))))
  }).else((c) => {
    c.assign(centerClip, transformMat4(mvp, vec4(ecefRtc, f32(1))))
  })

  // bit 3 of packed10 = flat-quad mode.
  const isFlat = b.let('is_flat', packed10.bitAnd(u32(8)).ne(u32(0)))
  b.assign(radiusPx, max(radiusPx, f32(1)))
  const expand = b.let('expand', radiusPx.add(2))

  const out = b.var('out', structT('PointOut'))
  // All four corners share the centre's view_w (point markers occupy a
  // near-zero depth range; per-corner depth divergence would over-strict
  // the log-depth interpolation).
  const fc = b.let('fc', viewport.w)
  b.assign(out.field('view_w', f32T), centerClip.w)

  b.if(isFlat, (c) => {
    // FLAT: expand in screen-space NDC (perspective-corrected via
    // centerClip.w). Pre-PR-2d.2 the flat branch expanded in world-space
    // Mercator metres then re-transformed; under ECEF the world-space
    // expansion would need a true-metre-to-clip jacobian per vertex.
    // Since the visual contract is "stay coplanar with the ground at the
    // marker's centre", a screen-space NDC offset around centerClip is
    // visually equivalent and metric-correct under the ECEF MVP.
    // Anchor (bits 8..9): 0=center, 1=bottom, 2=top.
    const anchorMode = c.let('anchor_mode', packed10.shr(u32(8)).bitAnd(u32(3)))
    const yShiftPx = c.var('y_shift_px', f32T, f32(0))
    c.if(anchorMode.eq(u32(1)), (d) => { d.assign(yShiftPx, expand) })
      .elif(anchorMode.eq(u32(2)), (d) => { d.assign(yShiftPx, expand.neg()) })
    const pxToNdc = c.let('px_to_ndc', vec2(f32(2).div(viewport.x), f32(2).div(viewport.y)))
    const offXY = offsets.at(p.quad_id, vec2fT)
    const offsetPx = c.let('offset_px', vec2(offXY.x.mul(expand), offXY.y.mul(expand).add(yShiftPx)))
    const offsetNdc = c.let('offset_ndc', offsetPx.mul(pxToNdc))
    const flatClip = c.let('flat_clip', centerClip.add(vec4(offsetNdc.mul(centerClip.w), f32(0), f32(0))))
    c.assign(out.field('position', vec4fT), callFn('apply_log_depth', vec4fT, flatClip, fc))
    c.assign(out.field('uv', vec2fT), offXY)
  }).else((c) => {
    // BILLBOARD: expand in screen-space (NDC), perspective-corrected. Anchor
    // (bits 8..9): 0=center, 1=bottom (lifts up by one extent so the bottom
    // edge sits on the projected ground point), 2=top.
    const anchorMode = c.let('anchor_mode', packed10.shr(u32(8)).bitAnd(u32(3)))
    const yShiftPx = c.var('y_shift_px', f32T, f32(0))
    c.if(anchorMode.eq(u32(1)), (d) => { d.assign(yShiftPx, expand) })
      .elif(anchorMode.eq(u32(2)), (d) => { d.assign(yShiftPx, expand.neg()) })
    const pxToNdc = c.let('px_to_ndc', vec2(f32(2).div(viewport.x), f32(2).div(viewport.y)))
    const offXY = offsets.at(p.quad_id, vec2fT)
    const offsetPx = c.let('offset_px', vec2(offXY.x.mul(expand), offXY.y.mul(expand).add(yShiftPx)))
    const offsetNdc = c.let('offset_ndc', offsetPx.mul(pxToNdc))
    const billboardClip = c.let('billboard_clip', centerClip.add(vec4(offsetNdc.mul(centerClip.w), f32(0), f32(0))))
    c.assign(out.field('position', vec4fT), callFn('apply_log_depth', vec4fT, billboardClip, fc))
    // UV stays centered so the SDF shape renders unchanged; only the on-
    // screen placement is shifted.
    c.assign(out.field('uv', vec2fT), offXY.mul(expand).div(max(radiusPx, f32(1))))
  })
  b.assign(out.field('feat_id', u32T), fid)
  b.assign(out.field('radius_px', f32T), radiusPx)
  b.assign(out.field('cos_c', f32T), callFn('point_cos_c', f32T, absLon, absLat))
  b.assign(out.field('rim_a', f32T), callFn('point_rim_alpha', f32T, absLon, absLat))
  b.ret(out)
})

const fs = entryFn('fs_point', 'fragment', [{ name: 'in', type: structT('PointOut') }], structT('PointFragmentOutput'), (b, p) => {
  // Backface cull for globe projections — cos_c is +1 for flat projections.
  b.if(p.in.field('cos_c', f32T).lt(0), (c) => { c.discard() })
  const fid = b.let('fid', p.in.field('feat_id', u32T))
  // shape_id moved to slot 19 in PR 2d.2's stride-20 layout (was slot 13).
  const shapeId = b.let('shape_id', toU32(featData.at(fid.mul(STRIDE).add(u32(19)), f32T)))

  // AA from UV (always smooth) — not from SDF dist (AABB discontinuities).
  const aa = b.let('aa', fwidth(length(p.in.field('uv', vec2fT))).mul(1.5))

  const dist = b.var('dist', f32T)
  b.if(shapeId.eq(u32(0)), (c) => {
    c.assign(dist, length(p.in.field('uv', vec2fT)))   // analytical circle (fast path)
  }).else((c) => {
    c.assign(dist, callFn('sdf_shape', f32T, p.in.field('uv', vec2fT), shapeId.sub(u32(1))))
  })

  // Per-feature style.
  const fillColor = b.let('fill_color', vec4(
    featData.at(fid.mul(STRIDE).add(u32(1)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(2)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(3)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(4)), f32T),
  ))
  const strokeColor = b.let('stroke_color', vec4(
    featData.at(fid.mul(STRIDE).add(u32(5)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(6)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(7)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(8)), f32T),
  ))
  const strokeWPx = b.let('stroke_w_px', featData.at(fid.mul(STRIDE).add(u32(9)), f32T))
  const flags = b.let('flags', toU32(featData.at(fid.mul(STRIDE).add(u32(10)), f32T)))

  // stroke_w in UV space using the actual rendered radius.
  const strokeW = b.let('stroke_w', strokeWPx.div(max(p.in.field('radius_px', f32T), f32(1))))

  const color = b.var('color', vec4fT, vec4(f32(0), f32(0), f32(0), f32(0)))

  // Fill (bit 0).
  b.if(flags.bitAnd(u32(1)).ne(u32(0)), (c) => {
    const fillAlpha = c.let('fill_alpha', f32(1).sub(smoothstep(f32(1).sub(aa), f32(1).add(aa), dist)))
    c.assign(color, vec4(fillColor.rgb, fillColor.a.mul(fillAlpha)))
  })

  // Stroke (bit 1).
  b.if(flags.bitAnd(u32(2)).ne(u32(0)), (c) => {
    const inner = c.let('inner', f32(1).sub(strokeW))
    const strokeAlpha = c.let('stroke_alpha',
      smoothstep(inner.sub(aa), inner.add(aa), dist)
        .mul(f32(1).sub(smoothstep(f32(1).sub(aa), f32(1).add(aa), dist))),
    )
    c.assign(color, mix(color, vec4(strokeColor.rgb, strokeColor.a), strokeAlpha))
  })

  // Glow (bit 2).
  b.if(flags.bitAnd(u32(4)).ne(u32(0)), (c) => {
    const glow = c.let('glow', exp(dist.mul(dist).mul(-2)).mul(0.4))
    c.assignOp(color, '+', vec4(fillColor.rgb.mul(glow), glow))
  })

  // Rim fade — flat / cylindrical projections receive rim_a=1.0.
  b.assignOp(color.field('a', f32T), '*', p.in.field('rim_a', f32T))
  b.if(color.field('a', f32T).lt(0.005), (c) => { c.discard() })
  const out = b.var('out', structT('PointFragmentOutput'))
  b.assign(out.field('color', vec4fT), color)
  b.assign(out.field('depth', f32T), callFn('compute_log_frag_depth', f32T, p.in.field('view_w', f32T), u.field('viewport', vec4fT).w))
  b.ret(out)
})

export const POINT_MODULE: ModuleDecl = module({
  structs: [Uniforms, ShapeDesc, Segment, PointOut, PointFragmentOutput],
  bindings: [
    { group: 0, binding: 0, name: 'u', space: 'uniform', type: structT('Uniforms') },
    { group: 0, binding: 1, name: 'feat_data', space: 'storage', access: 'read', type: arrayT(f32T) },
    { group: 0, binding: 2, name: 'shapes', space: 'storage', access: 'read', type: arrayT(structT('ShapeDesc')) },
    { group: 0, binding: 3, name: 'segments', space: 'storage', access: 'read', type: arrayT(structT('Segment')) },
  ],
  funcs: [
    pointCosC, pointRimAlpha,
    distToLine, distToQuadratic, distToCubic, windingLine, sdfShape,
    vs, fs,
  ],
})

/** Full point shader: shared DSL-emitted projection consts + log-depth fns +
 *  projection fns, then the point module. No pick variant. */
export const emitPointWgsl = (): string => [
  PROJECTION_WGSL_CONSTS,
  LOG_DEPTH_WGSL_FNS,
  PROJECTION_WGSL_FNS,
  emitModule(POINT_MODULE),
].join('\n')
