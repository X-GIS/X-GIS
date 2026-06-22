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
// emitPointWgsl MERGES the shared dependency decls (PROJECTION_CONSTS +
// log-depth + getGpuProjectionFuncs()) into buildPointModule and emits ONE
// module — no WGSL-string prepend. vs/fs reach project / inv_merc_lat_rad /
// needs_backface_cull / rim_alpha / proj_globe / apply_log_depth /
// compute_log_frag_depth by name and constRef PI / DEG2RAD / EARTH_R / MERCATOR_LAT_LIMIT.
//
// No pick variant — the point fragment carries no pick channel (matches the
// hand shader exactly).

import {
  entryFn, fn, module, transformMat4, arrayLit,
  f32, u32, i32, toF32, toU32, vec2, vec3, vec4, mix, exp, clamp,
  length, dot, min, max, smoothstep, fwidth, select,
  f32T, u32T, i32T, vec2fT, vec4fT, mat4x4fT, arrayT,
  Let, Var, assign, assignOp, If, Loop, reduce, ifExpr, condExpr, Switch, Return, Discard,
  type ModuleDecl,
} from '../core/ir'
import { ioStruct, builtin, location, uniformStruct, structDecl, storageBuffer } from '../core/sot'
import { emitModule } from '../core/backends/wgsl'
import { needs_backface_cull, rim_alpha, flat_rel, PROJECTION_CONSTS, getGpuProjectionFuncs } from './projections'
import { apply_log_depth, compute_log_frag_depth } from './log-depth'

const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'u' }, {
  // Phase 2 PR 2d.2 — POINT VS ECEF migration. `mvp` holds the ECEF-MVP
  // (Camera.getECEFFrameView), not the legacy Mercator-RTC MVP. Post
  // PR 2d.5 closeout, all polygon/line/raster/point shaders use the
  // single `mvp` slot for the ECEF-MVP — the dual-slot Mercator+ECEF
  // layout was retired (polygon Uniforms shrunk 256 → 192 bytes).
  mvp: mat4x4fT,
  // proj_params: x=projType, y=centerLon, z=centerLat. Retained for the
  // fragment-side hemisphere-cull (needs_backface_cull + rim_alpha)
  // which still branches on projType to short-circuit flat projections.
  proj_params: vec4fT,
  // tile_rtc deleted (Phase 2 PR 2d.2) — the camera-relative anchor used
  // to live here for the Mercator-DSFUN VS; ECEF VS computes the clip
  // position directly from per-feature ECEF DSFUN, no per-tile offset.
  viewport: vec4fT,      // xy = w/h, z = meters/px, w = log_depth_fc
  // Camera-relative RTC fix: the per-feature ECEF DSFUN is now ABSOLUTE, but
  // the MVP (Camera.getECEFFrameView) is camera-at-ENU-origin. Subtract the
  // camera anchor (getECEFCenter, sphere) — split DSFUN hi/lo to preserve
  // sub-mm precision: ecef_rtc = (ecefH − camH) + (ecefL − camL). xyz used,
  // w unused.
  cam_ecef_h: vec4fT,
  cam_ecef_l: vec4fT,
  // circle_params: x=translate_x_ndc, y=translate_y_ndc, z=blur_px, w=unused.
  // translate_x/y are pre-baked to NDC-per-pixel (px * 2 / w/h) by the
  // renderer — same convention as fill_translate_x/y in polygon.ts.
  // Default [0,0,0,0] → no-op (existing rendering byte-identical).
  circle_params: vec4fT,
})
const ShapeDesc = structDecl('ShapeDesc', {
  seg_start: u32T,
  seg_count: u32T,
  bbox_min_x: f32T,
  bbox_min_y: f32T,
  bbox_max_x: f32T,
  bbox_max_y: f32T,
  _pad0: f32T,
  _pad1: f32T,
})
const Segment = structDecl('Segment', {
  kind: u32T,          // 0=line 1=quad 2=cubic
  color_idx: u32T,
  flags: u32T,
  _pad: u32T,
  p0: vec2fT,
  p1: vec2fT,
  p2: vec2fT,
  p3: vec2fT,
})
const PointOut = ioStruct('PointOut', {
  position: builtin('position', vec4fT),
  uv: location(0, vec2fT),
  feat_id: location(1, u32T, 'flat'),
  radius_px: location(2, f32T, 'flat'),
  view_w: location(3, f32T),
  cos_c: location(4, f32T, 'flat'),
  rim_a: location(5, f32T, 'flat'),
})
const PointFragmentOutput = ioStruct('PointFragmentOutput', {
  color: location(0, vec4fT),
  depth: builtin('frag_depth', f32T),
})

const featDataB = storageBuffer('feat_data', arrayT(f32T), { group: 0, binding: 1, access: 'read' })
const shapesB = storageBuffer('shapes', arrayT(ShapeDesc.type), { group: 0, binding: 2, access: 'read' })
const segmentsB = storageBuffer('segments', arrayT(Segment.type), { group: 0, binding: 3, access: 'read' })
const featData = featDataB.node
const shapes = shapesB.node
const segments = segmentsB.node

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

const pointCosC = fn('point_cos_c', { abs_lon: f32T, abs_lat: f32T }, f32T, (p) => {
  return needs_backface_cull(p.abs_lon, p.abs_lat, U.field.proj_params)
})

const pointRimAlpha = fn('point_rim_alpha', { abs_lon: f32T, abs_lat: f32T }, f32T, (p) => {
  return rim_alpha(p.abs_lon, p.abs_lat, U.field.proj_params)
})

const distToLine = fn('dist_to_line', { p: vec2fT, a: vec2fT, b: vec2fT }, f32T, (pp) => {
  const ab = pp.b.sub(pp.a)
  const len2 = dot(ab, ab)
  // single-exit: max() guards the degenerate (len2≈0) divide; select picks the point dist.
  const t = clamp(dot(pp.p.sub(pp.a), ab).div(max(len2, 1e-10)), 0, 1)
  const segDist = length(pp.p.sub(pp.a).sub(ab.mul(t)))
  return select(len2.lt(1e-10), length(pp.p.sub(pp.a)), segDist)
})

const distToQuadratic = fn('dist_to_quadratic', { p: vec2fT, a: vec2fT, b: vec2fT, c: vec2fT }, f32T, (pp) =>
  reduce('best_d', f32(1e10), 'i', u32(0), (i) => i.le(u32(16)), (best, i) => {
    const t = toF32(i).div(16)
    const ab = mix(pp.a, pp.b, t)
    const bc = mix(pp.b, pp.c, t)
    const q = mix(ab, bc, t)
    return min(best, length(pp.p.sub(q)))
  }),
)

const distToCubic = fn('dist_to_cubic', { p: vec2fT, a: vec2fT, b: vec2fT, c: vec2fT, d: vec2fT }, f32T, (pp) =>
  reduce('best_d', f32(1e10), 'i', u32(0), (i) => i.le(u32(24)), (best, i) => {
    const t = toF32(i).div(24)
    const ab = mix(pp.a, pp.b, t)
    const bc = mix(pp.b, pp.c, t)
    const cd = mix(pp.c, pp.d, t)
    const abc = mix(ab, bc, t)
    const bcd = mix(bc, cd, t)
    const q = mix(abc, bcd, t)
    return min(best, length(pp.p.sub(q)))
  }),
)

const windingLine = fn('winding_line', { p: vec2fT, a: vec2fT, b: vec2fT }, i32T, (pp) => {
  // single-exit: signed winding contribution of edge a→b across the +y ray from p.
  const cross = pp.b.x.sub(pp.a.x).mul(pp.p.y.sub(pp.a.y)).sub(pp.p.x.sub(pp.a.x).mul(pp.b.y.sub(pp.a.y)))
  const up = pp.a.y.le(pp.p.y).and(pp.b.y.gt(pp.p.y)).and(cross.gt(0))
  const down = pp.a.y.gt(pp.p.y).and(pp.b.y.le(pp.p.y)).and(cross.lt(0))
  return select(up, i32(1), select(down, i32(-1), i32(0)))
})

const sdfShape = fn('sdf_shape', { uv_in: vec2fT, shape_id: u32T }, f32T, (pp) => {
  // Flip Y: NDC Y-up → SVG/path Y-down convention.
  const uv = vec2(pp.uv_in.x, pp.uv_in.y.neg())
  const s = shapes.at(pp.shape_id, ShapeDesc.type)
  const bMinX = s.field('bbox_min_x', f32T)
  const bMinY = s.field('bbox_min_y', f32T)
  const bMaxX = s.field('bbox_max_x', f32T)
  const bMaxY = s.field('bbox_max_y', f32T)
  // AABB early-out.
  If(
    uv.x.lt(bMinX).or(uv.x.gt(bMaxX)).or(uv.y.lt(bMinY)).or(uv.y.gt(bMaxY)),
    () => { Return(f32(2)) },
  )
  const minDist = Var('min_dist', f32T, f32(1e10))
  const winding = Var('winding', i32T, i32(0))
  const segStart = s.field('seg_start', u32T)
  const segCount = s.field('seg_count', u32T)
  // Hard-cap at 32 segments per shape (paste from original).
  const end = min(segStart.add(segCount), segStart.add(u32(32)))
  Loop('i', segStart, (i) => i.lt(end), (i) => {
    const seg = segments.at(i, Segment.type)
    const p0 = seg.field('p0', vec2fT)
    const p1 = seg.field('p1', vec2fT)
    const p2 = seg.field('p2', vec2fT)
    const p3 = seg.field('p3', vec2fT)
    Switch(seg.field('kind', u32T), [
      [0, () => {
        assign(minDist, min(minDist, distToLine(uv, p0, p1)))
        assignOp(winding, '+', windingLine(uv, p0, p1))
      }],
      [1, () => {
        assign(minDist, min(minDist, distToQuadratic(uv, p0, p1, p2)))
        // Approximate winding with chord.
        assignOp(winding, '+', windingLine(uv, p0, p2))
      }],
      [2, () => {
        assign(minDist, min(minDist, distToCubic(uv, p0, p1, p2, p3)))
        // Approximate winding with chord.
        assignOp(winding, '+', windingLine(uv, p0, p3))
      }],
    ], () => { /* default: empty */ })
  })
  // Inside (winding != 0): dist=1 at boundary; outside: dist=1+min_dist.
  If(winding.ne(i32(0)), () => { Return(f32(1).sub(minDist)) })
    .else(() => { Return(f32(1).add(minDist)) })
}, { allowEarlyReturn: true }) // MISRA single-exit DEVIATION — the AABB early-out skips a 32-segment loop (perf)

// ── Entry points ──

const vs = entryFn('vs_point', 'vertex', [
  { name: 'center', type: vec2fT, location: 0 },
  { name: 'quad_id', type: u32T, location: 1 },
  { name: 'feat_id', type: f32T, location: 2 },
], PointOut.type, (p) => {
  const offsets = arrayLit(vec2fT,
    vec2(f32(-1), f32(-1)),
    vec2(f32(1), f32(-1)),
    vec2(f32(1), f32(1)),
    vec2(f32(-1), f32(1)),
  )
  const fid = toU32(p.feat_id)
  const rawRadius = featData.at(fid.mul(STRIDE).add(u32(0)), f32T)
  // Pack-byte at offset 10: bit 0..3 reserved, bits 4..7 = size_mode,
  // bit 3 = is_flat, bits 8..9 = anchor_mode.
  const packed10 = toU32(featData.at(fid.mul(STRIDE).add(u32(10)), f32T))
  const sizeMode = packed10.shr(u32(4)).bitAnd(u32(0xF))
  // Size mode: 0=px, 1=m, 2=km, 3=deg (equator approx), 4=nm.
  const radiusPx = Var('radius_px', f32T)
  const viewport = U.field.viewport
  If(sizeMode.eq(u32(1)), () => { assign(radiusPx, rawRadius.div(viewport.z)) })
    .elif(sizeMode.eq(u32(2)), () => { assign(radiusPx, rawRadius.mul(1000).div(viewport.z)) })
    .elif(sizeMode.eq(u32(3)), () => { assign(radiusPx, rawRadius.mul(111320).div(viewport.z)) })
    .elif(sizeMode.eq(u32(4)), () => { assign(radiusPx, rawRadius.mul(1852).div(viewport.z)) })
    .else(() => { assign(radiusPx, rawRadius) })

  // Phase 2 PR 2d.2 — ECEF DSFUN per-feature centre.
  // featData slots 11..16 carry the tile-anchored ECEF DSFUN split
  // (pos_h.xyz + pos_l.xyz) for the point's centre; slots 17..18 carry
  // the absolute lon/lat in degrees for the fragment-side hemisphere
  // cull. The single `u.mvp` slot is the ECEF-MVP (post PR 2d.5).
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
  // Camera-relative RTC: subtract the camera anchor in DSFUN space so the
  // big absolute ECEF magnitude cancels before the residual reaches f32 math.
  const camH = U.field.cam_ecef_h.swizzle<'vec3<f32>'>('xyz')
  const camL = U.field.cam_ecef_l.swizzle<'vec3<f32>'>('xyz')
  const ecefRtc = ecefH.sub(camH).add(ecefL.sub(camL))
  const absLon = featData.at(fid.mul(STRIDE).add(u32(17)), f32T)
  const absLat = featData.at(fid.mul(STRIDE).add(u32(18)), f32T)
  const mvp = U.field.mvp
  // Display projection (projection-display-layer-restore): flat Mercator
  // (proj_params.x < 0.5) reprojects the absolute lon/lat onto the 2D plane
  // and feeds the flat Mercator-metre MVP; 3D / globe keeps the ECEF-RTC
  // anchor. For the flat path the renderer writes the 2D camera centre
  // (Mercator metres, DSFUN hi/lo) into cam_ecef_h.xy / cam_ecef_l.xy — those
  // ECEF lanes are dead on the flat path. u.mvp is the matching matrix
  // (Camera.getViewForProjection). Quad expansion below consumes centerClip
  // identically for both paths.
  const centerClip = condExpr('center_clip', vec4fT, [
    [U.field.proj_params.x.lt(0.5), () => {
    // Precise absolute Mercator DSFUN (slots 20-23), camera-recentered in DSFUN
    // space — `(mx_h−camH)+(mx_l−camL)` — exactly like ecef_rtc. The old path
    // reprojected the lossy f32 abs_lon/abs_lat (~1.35 m → ~5.7 px @ z20).
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
    // FLAT non-Mercator (1-6): the shared flat_rel — reproject the marker's
    // lon/lat minus the in-shader projected camera centre. ref_lon = the
    // marker's own lon (self) so it lands in its nearest world copy; for an
    // individual marker project_geom collapses to plain project. Same flat MVP.
    const pp = U.field.proj_params
    const relG = flat_rel(absLon, absLat, pp, absLon)
    return transformMat4(mvp, vec4(relG.x, relG.y, f32(0), f32(1)))
  }],
  ], () => {
    return transformMat4(mvp, vec4(ecefRtc, f32(1)))
  })

  // circle-translate: apply viewport-space offset post-MVP.
  // translate_x/y are pre-baked to NDC-per-pixel by the renderer
  // (circle_params.xy). Multiply by clip.w to keep the shift pixel-
  // constant regardless of depth — same approach as polygon fill-translate.
  // Default [0,0] → no-op.
  const circleParams = U.field.circle_params
  assign(centerClip, centerClip.add(vec4(
    circleParams.x.mul(centerClip.w),
    circleParams.y.mul(centerClip.w),
    f32(0),
    f32(0),
  )))

  // circle-pitch-scale (Mapbox `paint.circle-pitch-scale`). circle_params.w
  // is the mode flag: 0 = viewport (spec default — radius constant in screen
  // px, byte-identical to the historical X-GIS path); 1 = map. In map mode
  // the radius scales with the map perspective so circles farther from the
  // camera / under pitch shrink. The scale factor is w_ref / clip.w where
  // w_ref = mvp[3][3] = the perspective w at the recentered camera anchor
  // (the camera-to-target eye distance in the MVP's vertex-space units; the
  // anchor is the RTC origin so mvp·(0,0,0,1) yields its w directly). This
  // mirrors MapLibre circle.vertex.glsl's `* (u_camera_to_center_distance /
  // gl_Position.w)` for pitch-alignment:viewport + pitch-scale:map. =1 at the
  // screen centre, <1 toward the horizon. Guard clip.w>0 to avoid div blow-up.
  If(U.field.circle_params.w.gt(f32(0.5)), () => {
    const wRef = mvp.at(u32(3), vec4fT).w
    const wPt = Let('w_pt', max(centerClip.w, f32(1e-4)))
    assign(radiusPx, radiusPx.mul(wRef.div(wPt)))
  })

  // bit 3 of packed10 = flat-quad mode.
  const isFlat = packed10.bitAnd(u32(8)).ne(u32(0))
  assign(radiusPx, max(radiusPx, f32(1)))
  const expand = Let('expand', radiusPx.add(2))

  const out = Var('out', PointOut.type)
  const o = PointOut.of(out)
  // All four corners share the centre's view_w (point markers occupy a
  // near-zero depth range; per-corner depth divergence would over-strict
  // the log-depth interpolation).
  const fc = viewport.w
  assign(o.view_w, centerClip.w)

  If(isFlat, () => {
    // FLAT: expand in screen-space NDC (perspective-corrected via
    // centerClip.w). Pre-PR-2d.2 the flat branch expanded in world-space
    // Mercator metres then re-transformed; under ECEF the world-space
    // expansion would need a true-metre-to-clip jacobian per vertex.
    // Since the visual contract is "stay coplanar with the ground at the
    // marker's centre", a screen-space NDC offset around centerClip is
    // visually equivalent and metric-correct under the ECEF MVP.
    // Anchor (bits 8..9): 0=center, 1=bottom, 2=top.
    const anchorMode = packed10.shr(u32(8)).bitAnd(u32(3))
    const yShiftPx = Var('y_shift_px', f32T, f32(0))
    If(anchorMode.eq(u32(1)), () => { assign(yShiftPx, expand) })
      .elif(anchorMode.eq(u32(2)), () => { assign(yShiftPx, expand.neg()) })
    const pxToNdc = vec2(f32(2).div(viewport.x), f32(2).div(viewport.y))
    const offXY = offsets.at(p.quad_id, vec2fT)
    const offsetPx = Let('offset_px', vec2(offXY.x.mul(expand), offXY.y.mul(expand).add(yShiftPx)))
    const offsetNdc = offsetPx.mul(pxToNdc)
    const flatClip = Let('flat_clip', centerClip.add(vec4(offsetNdc.mul(centerClip.w), f32(0), f32(0))))
    assign(o.position, apply_log_depth(flatClip, fc))
    assign(o.uv, offXY)
  }).else(() => {
    // BILLBOARD: expand in screen-space (NDC), perspective-corrected. Anchor
    // (bits 8..9): 0=center, 1=bottom (lifts up by one extent so the bottom
    // edge sits on the projected ground point), 2=top.
    const anchorMode = packed10.shr(u32(8)).bitAnd(u32(3))
    const yShiftPx = Var('y_shift_px', f32T, f32(0))
    If(anchorMode.eq(u32(1)), () => { assign(yShiftPx, expand) })
      .elif(anchorMode.eq(u32(2)), () => { assign(yShiftPx, expand.neg()) })
    const pxToNdc = vec2(f32(2).div(viewport.x), f32(2).div(viewport.y))
    const offXY = offsets.at(p.quad_id, vec2fT)
    const offsetPx = Let('offset_px', vec2(offXY.x.mul(expand), offXY.y.mul(expand).add(yShiftPx)))
    const offsetNdc = offsetPx.mul(pxToNdc)
    const billboardClip = Let('billboard_clip', centerClip.add(vec4(offsetNdc.mul(centerClip.w), f32(0), f32(0))))
    assign(o.position, apply_log_depth(billboardClip, fc))
    // UV stays centered so the SDF shape renders unchanged; only the on-
    // screen placement is shifted.
    assign(o.uv, offXY.mul(expand).div(max(radiusPx, f32(1))))
  })
  assign(o.feat_id, fid)
  assign(o.radius_px, radiusPx)
  assign(o.cos_c, pointCosC(absLon, absLat))
  assign(o.rim_a, pointRimAlpha(absLon, absLat))
  return out
})

const fs = entryFn('fs_point', 'fragment', [{ name: 'in', type: PointOut.type }], PointFragmentOutput.type, (p) => {
  const pin = PointOut.of(p.in)
  // Backface cull for globe projections — cos_c is +1 for flat projections.
  If(pin.cos_c.lt(0), () => { Discard() })
  const fid = pin.feat_id
  // shape_id moved to slot 19 in PR 2d.2's stride-20 layout (was slot 13).
  const shapeId = toU32(featData.at(fid.mul(STRIDE).add(u32(19)), f32T))

  // AA from UV (always smooth) — not from SDF dist (AABB discontinuities).
  // MUST stay an explicit Let: fwidth is a derivative and WGSL requires it be evaluated in
  // UNIFORM control flow. Inlining it would re-emit fwidth() inside the per-flag fill/stroke
  // `if` branches (non-uniform) → "fwidth must only be called from uniform control flow".
  const aa = Let('aa', fwidth(length(pin.uv)).mul(1.5))
  // circle-blur: widen the AA band by blur_px converted to UV units.
  // blur_uv = blur_px / radius_px. Default 0 → band unchanged (no-op).
  const blurPx = U.field.circle_params.z
  const blurUv = blurPx.div(max(pin.radius_px, f32(1)))
  const halfBand = aa.add(blurUv)

  const dist = ifExpr('dist', f32T, shapeId.eq(u32(0)),
    () => length(pin.uv),   // analytical circle (fast path)
    () => sdfShape(pin.uv, shapeId.sub(u32(1))),
  )

  // Per-feature style.
  const fillColor = vec4(
    featData.at(fid.mul(STRIDE).add(u32(1)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(2)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(3)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(4)), f32T),
  )
  const strokeColor = vec4(
    featData.at(fid.mul(STRIDE).add(u32(5)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(6)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(7)), f32T),
    featData.at(fid.mul(STRIDE).add(u32(8)), f32T),
  )
  const strokeWPx = featData.at(fid.mul(STRIDE).add(u32(9)), f32T)
  const flags = toU32(featData.at(fid.mul(STRIDE).add(u32(10)), f32T))

  // stroke_w in UV space using the actual rendered radius.
  const strokeW = strokeWPx.div(max(pin.radius_px, f32(1)))

  const color = Var('color', vec4fT, vec4(f32(0), f32(0), f32(0), f32(0)))

  // Fill (bit 0).
  If(flags.bitAnd(u32(1)).ne(u32(0)), () => {
    const fillAlpha = Let('fill_alpha', f32(1).sub(smoothstep(f32(1).sub(halfBand), f32(1).add(halfBand), dist)))
    assign(color, vec4(fillColor.rgb, fillColor.a.mul(fillAlpha)))
  })

  // Stroke (bit 1).
  If(flags.bitAnd(u32(2)).ne(u32(0)), () => {
    const inner = f32(1).sub(strokeW)
    const strokeAlpha = Let('stroke_alpha',
      smoothstep(inner.sub(aa), inner.add(aa), dist)
        .mul(f32(1).sub(smoothstep(f32(1).sub(halfBand), f32(1).add(halfBand), dist))),
    )
    assign(color, mix(color, vec4(strokeColor.rgb, strokeColor.a), strokeAlpha))
  })

  // Glow (bit 2).
  If(flags.bitAnd(u32(4)).ne(u32(0)), () => {
    const glow = Let('glow', exp(dist.mul(dist).mul(-2)).mul(0.4))
    assignOp(color, '+', vec4(fillColor.rgb.mul(glow), glow))
  })

  // Rim fade — flat / cylindrical projections receive rim_a=1.0.
  assignOp(color.field('a', f32T), '*', pin.rim_a)
  If(color.field('a', f32T).lt(0.005), () => { Discard() })
  const out = Var('out', PointFragmentOutput.type)
  const o = PointFragmentOutput.of(out)
  assign(o.color, color)
  assign(o.depth, compute_log_frag_depth(pin.view_w, U.field.viewport.w))
  return out
})

// A build-fn (not a top-level const) so the injection-deferred getGpuProjectionFuncs() is
// gathered at emit time, post-configureProjections() — same reason buildLineModule is a fn.
export const buildPointModule = (): ModuleDecl => module({
  // Shared projection constants merged in (was the getProjectionWgslConsts() string prepend).
  consts: [...PROJECTION_CONSTS],
  structs: [U.struct, ShapeDesc.decl, Segment.decl, PointOut.decl, PointFragmentOutput.decl],
  bindings: [
    U.binding,
    featDataB.binding,
    shapesB.binding,
    segmentsB.binding,
  ],
  funcs: [
    // Shared dependency decls, callees first (was the LOG_DEPTH / projection WGSL-string
    // prepend): log-depth → projection, then point's own funcs (its SDF helpers are local).
    apply_log_depth, compute_log_frag_depth,
    ...getGpuProjectionFuncs(),
    pointCosC, pointRimAlpha,
    distToLine, distToQuadratic, distToCubic, windingLine, sdfShape,
    vs, fs,
  ],
})

/** Full point shader: one module — shared projection consts + log-depth + projection fns
 *  merged ahead of the point structs / bindings / helpers. No pick variant. */
export const emitPointWgsl = (): string => emitModule(buildPointModule())
