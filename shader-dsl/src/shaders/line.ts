// ═══ Shader DSL — SDF line shader (Phase 2) ═══
//
// Re-authors render/line-renderer-shaders.ts LINE_SHADER_SOURCE + COMPOSITE_SHADER.
// The line shader is the biggest hand-written stroke renderer in the codebase
// (1314 LOC straight WGSL): per-segment quad expansion + miter/round/bevel join
// + dash + 3-slot pattern stack + line-pattern atlas sample + 3 fragment entry
// points sharing one compute_line_color helper. No runtime variant codegen —
// the only build-time variant is the pick attachment (replacing the old
// __PICK_FIELD__ / __PICK_WRITE__ string markers).
//
// Pattern (raster sibling): emitLineWgsl(pickEnabled) PREPENDS the shared
// DSL-emitted strings (PROJECTION_WGSL_CONSTS / FNS + LOG_DEPTH_WGSL_FNS +
// the SDF dist/winding helper WGSL) so vs/fs callFn proj_globe / project /
// project_geom / inv_merc_lat_rad / needs_backface_cull / rim_alpha /
// apply_log_depth / compute_log_frag_depth / dist_to_segment / dist_to_quadratic
// / dist_to_cubic / winding_line by name + constRef PI / DEG2RAD / EARTH_R.
//
// Bitwise IR ops (& | ^ << >>, added with the point shader) drive cap / join /
// flag / dash / anchor unpacking. The compositor shader (fullscreen-triangle
// sampling the offscreen RT) is emitted alongside via emitCompositeWgsl().

import {
  entryFn, fn, module, bindingRef, constRef, callFn, transformMat4,
  f32, i32, u32, toF32, vec2, vec3, vec4, vec2u, clamp, fract, sign,
  length, dot, min, max, smoothstep, abs, floor, select, textureSample,
  bitcastU32, unpack4x8unorm,
  atan, exp,
  If, Loop, Let, Var, Continue, Discard, assign, assignOp, madd, outsideRange,
  ReturnIf, Switch,
  structT, f32T, u32T, i32T, vec2fT, vec3fT, vec4fT, vec2uT, mat4x4fT, texture2dfT, samplerT,
  arrayT,
  type Node,
  type StructDecl, type StructField, type ModuleDecl,
} from '../core/ir'
import { ioStruct, builtin, location } from '../core/sot'
import { emitModule } from '../core/backends/wgsl'
import { getProjectionWgslConsts, getProjectionWgslFns } from './projections'
import { ECEF_WGSL_CONSTS, ECEF_WGSL_FNS } from './ecef'
import { LOG_DEPTH_WGSL_FNS } from './log-depth'
import {
  SDF_WGSL_DIST_TO_SEGMENT,
  SDF_WGSL_DIST_TO_QUADRATIC,
  SDF_WGSL_DIST_TO_CUBIC,
  SDF_WGSL_WINDING_LINE,
} from './sdf'

// Round-join acute-fold threshold on |prevTan + dir| (unit vectors → length is
// 2·sin(interiorAngle/2)). 0.6 ⇒ interior angle ≲ 35°, well clear of normal road
// bends (60° corner = 1.0, right angle = 1.41, straight = 2.0); see #413.
const JOIN_ACUTE_BIS = 0.6

// ── Struct declarations ──

const TileUniforms: StructDecl = {
  name: 'TileUniforms',
  fields: [
    // Phase 2 PR 2d.5 closeout: `mvp` holds the ECEF-MVP from
    // Camera.getECEFFrameView() — the legacy Mercator-RTC `mvp` slot was
    // retired and the dual-slot layout collapsed (struct shrunk 256 → 192
    // bytes). The line shader's hybrid VS still emits `world_local` as
    // tile-local Mercator metres for the FS distance/clip math; only the
    // clip transform changed: `u.mvp * vec4(ecef_corner, 1)`.
    //
    // Slot mirrors the polygon Uniforms layout byte-for-byte (the line
    // shader shares group(0) with VTR's polygon bind group, so the line
    // TileUniforms struct must match polygon Uniforms field offsets up
    // through `clip_bounds`).
    { name: 'mvp', type: mat4x4fT },
    { name: 'fill_color', type: vec4fT },
    { name: 'stroke_color', type: vec4fT },
    { name: 'proj_params', type: vec4fT },
    // DSFUN camera offset in tile-local Mercator meters, split high/low.
    { name: 'cam_h', type: vec2fT },
    { name: 'cam_l', type: vec2fT },
    { name: 'tile_origin_merc', type: vec2fT },
    { name: 'opacity', type: f32T },
    // Log-depth factor: 1.0 / log2(cam_far + 1.0). Reuses the old DSFUN _pad0.
    { name: 'log_depth_fc', type: f32T },
    // Trailing pads mirror the polygon Uniforms tail. The line shader only
    // reads outline_z_lift_m — the others are padding so the WGSL struct
    // lines up with the shared 192-byte uniform block.
    { name: '_pad_pick', type: u32T },
    { name: '_pad_layer_offset', type: f32T },
    { name: 'tile_extent_m', type: f32T },
    { name: 'outline_z_lift_m', type: f32T },
    // Per-tile clip mask in absolute Mercator meters (west, south, east, north).
    { name: 'clip_bounds', type: vec4fT },
    // Pad to mirror polygon Uniforms offsets 44..51 (zoom / extrude_base /
    // fill_translate xy / tile_dequant scale+half) so the shared VTR uniform
    // slot's cam_ecef_off lands at the SAME byte offset (f32 52/56) for both
    // the line and polygon shaders. The line VS doesn't read these pads.
    { name: '_pad_tail0', type: vec4fT },
    { name: '_pad_tail1', type: vec4fT },
    // Camera-relative RTC (ECEF): tileEcefCenter(WGS84 ellipsoid) −
    // cameraCenter(sphere), DSFUN hi/lo. VTR writes this per tile at f32
    // 52-54 / 56-58 (recordTileFill). The line VS adds it to ecef_rtc so
    // strokes project vertex−cameraCenter through the camera-at-ENU-origin
    // MVP — the same fix as polygon's cam_ecef_off (fixes the line↔fill
    // position mismatch, since line was projecting vertex−tileEcefCenter).
    { name: 'cam_ecef_off_h', type: vec4fT },
    { name: 'cam_ecef_off_l', type: vec4fT },
  ],
}

const PatternSlot: StructDecl = {
  name: 'PatternSlot',
  fields: [
    { name: 'id', type: u32T },
    { name: 'flags', type: u32T },
    { name: 'spacing', type: f32T },
    { name: 'size', type: f32T },
    { name: 'offset', type: f32T },
    { name: 'start_offset', type: f32T },
    { name: '_pad0', type: f32T },
    { name: '_pad1', type: f32T },
  ],
}

const LineLayer: StructDecl = {
  name: 'LineLayer',
  fields: [
    { name: 'color', type: vec4fT },
    { name: 'width_px', type: f32T },
    { name: 'aa_width_px', type: f32T },
    { name: 'mpp', type: f32T },
    { name: 'miter_limit', type: f32T },
    // cap(0-1) | join(2-3) | dash_enable(4) | has_pattern(6) | has_offset(7)
    { name: 'flags', type: u32T },
    { name: 'dash_count', type: u32T },
    { name: 'dash_cycle_m', type: f32T },
    { name: 'dash_offset_m', type: f32T },
    { name: 'dash_array', type: arrayT(vec4fT, 2) },
    { name: 'patterns', type: arrayT(structT('PatternSlot'), 3) },
    { name: 'offset_m', type: f32T },
    { name: 'viewport_height', type: f32T },
    // Device-pixel ratio. The screen-width clamp (vs_line) divides the
    // pixel target by viewport_height (DEVICE px) but the width target is
    // in CSS px, so it must be scaled by dpr to land on the right NDC span.
    { name: 'dpr', type: f32T },
    // Mapbox line-translate viewport offset — NDC-per-pixel, pre-baked
    // by the runtime baker (px * 2 / canvasDim). Applied post-MVP in
    // vs_line: clip.x += layer.line_translate_x * clip.w (mirrors
    // fill-translate's per-tile uniform path). Default 0 = no-op.
    { name: 'line_translate_x', type: f32T },
    { name: 'line_translate_y', type: f32T },
    // Mapbox line-round-limit (0 = use the historical JOIN_ACUTE_BIS fold
    // constant, byte-identical default; >0 scales the fold threshold).
    { name: 'round_limit', type: f32T },
    { name: '_pad_e', type: f32T },
  ],
}

const LineSegment: StructDecl = {
  name: 'LineSegment',
  fields: [
    // DSFUN endpoint pairs in tile-local Mercator meters.
    { name: 'p0_h', type: vec2fT },
    { name: 'p1_h', type: vec2fT },
    { name: 'p0_l', type: vec2fT },
    { name: 'p1_l', type: vec2fT },
    { name: 'prev_tangent', type: vec2fT },
    { name: 'next_tangent', type: vec2fT },
    { name: 'arc_start', type: f32T },
    { name: 'line_length', type: f32T },
    // Per-endpoint quad pad ratios (multiples of half_w).
    { name: 'pad_ratio_p0', type: f32T },
    { name: 'pad_ratio_p1', type: f32T },
    // Per-segment 3D extrude height in metres.
    { name: 'z_lift_m', type: f32T },
    // Per-segment stroke width override (px). 0 = use layer.width_px.
    { name: 'width_px_override', type: f32T },
    // Per-segment stroke colour override (RGBA8 packed in an f32 slot;
    // shader bit-casts to u32 + unpack4x8unorm). Alpha=0 → use layer.color.
    { name: 'color_packed', type: f32T },
    { name: '_pad19', type: f32T },
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

const ShapeSegment: StructDecl = {
  name: 'ShapeSegment',
  fields: [
    { name: 'kind', type: u32T },
    { name: 'color_idx', type: u32T },
    { name: 'flags', type: u32T },
    { name: '_pad', type: u32T },
    { name: 'p0', type: vec2fT },
    { name: 'p1', type: vec2fT },
    { name: 'p2', type: vec2fT },
    { name: 'p3', type: vec2fT },
  ],
}

const LineOut: StructDecl = ioStruct('LineOut', {
  position: builtin('position', vec4fT),
  world_local: location(0, vec2fT),
  seg_id: location(1, u32T, 'flat'),
  view_w: location(2, f32T),
  cos_c: location(3, f32T),
}).decl

const lineFragmentOutput = (pickEnabled: boolean): StructDecl => {
  const fields: StructField[] = [{ name: 'color', type: vec4fT, attr: '@location(0)' }]
  if (pickEnabled) fields.push({ name: 'pick', type: vec2uT, attr: '@location(1) @interpolate(flat)' })
  fields.push({ name: 'depth', type: f32T, attr: '@builtin(frag_depth)' })
  return { name: 'LineFragmentOutput', fields }
}

// ── Binding refs ──

const tile = bindingRef('tile', structT('TileUniforms'))
const layer = bindingRef('layer', structT('LineLayer'))
const segments = bindingRef('segments', arrayT(structT('LineSegment')))
const shapes = bindingRef('shapes', arrayT(structT('ShapeDesc')))
const shape_segments = bindingRef('shape_segments', arrayT(structT('ShapeSegment')))
const sprite_atlas = bindingRef('sprite_atlas', texture2dfT)
const sprite_samp = bindingRef('sprite_samp', samplerT)

// ── Helper fns ──

const lineEndpoint = fn('line_endpoint', { p_h: vec2fT, p_l: vec2fT }, vec2fT, (p, _b) => {
  const projParams = tile.field('proj_params', vec4fT)
  // single-exit: Mercator (proj<0.5) subtracts the camera; else hi+lo. select() is
  // branchless — both arms are pure reads, computing both is free of side effects.
  const mercRel = p.p_h.sub(tile.field('cam_h', vec2fT)).add(p.p_l.sub(tile.field('cam_l', vec2fT)))
  return select(projParams.x.lt(0.5), mercRel, p.p_h.add(p.p_l))
})

// finalize_corner — flat-projection reprojection (projection-display-layer-
// restore Phase 2). Restored from the pre-ECEF path for the flat display
// branch only; globe + 3D still use the ECEF-MVP, so finalize_corner_globe
// stays retired. Mercator (proj<0.5): cornerLocal is already camera-relative
// Mercator metres (line_endpoint subtracted the camera), so pass it through.
// Non-Mercator (1-6): reconstruct abs lon/lat from the tile-local Mercator
// corner, reproject via project_geom (world-copy aware; tileRefLon = tile-
// centre lon), and subtract the camera's projected centre (in-shader from
// proj_params.y/z). Output feeds the flat 2D-plane MVP.
const finalizeCorner = fn('finalize_corner', { corner: vec2fT }, vec2fT, (p, _b) => {
  const projParams = tile.field('proj_params', vec4fT)
  const tileOrigin = tile.field('tile_origin_merc', vec2fT)
  const absMerc = Let('abs_merc', p.corner.add(tileOrigin))
  const absLon = Let('abs_lon', absMerc.x.div(constRef('DEG2RAD').mul(constRef('EARTH_R'))))
  const latRad = Let('lat_rad', callFn('inv_merc_lat_rad', f32T, absMerc.y))
  const absLat = Let('abs_lat', latRad.div(constRef('DEG2RAD')))
  const tileRefLon = Let('tile_ref_lon',
    tileOrigin.x.add(f32(0.5).mul(tile.field('tile_extent_m', f32T)))
      .div(constRef('DEG2RAD').mul(constRef('EARTH_R'))),
  )
  // single-exit: Mercator (proj<0.5) passes the corner through; else the reprojected
  // flat_rel. flat_rel is pure, so computing it on the Mercator path (selected away) is harmless.
  const flatRel = callFn('flat_rel', vec2fT, absLon, absLat, projParams, tileRefLon)
  return select(projParams.x.lt(0.5), p.corner, flatRel)
})

const endpointCosC = fn('endpoint_cos_c', { p_h: vec2fT, p_l: vec2fT }, f32T, (p, _b) => {
  const tileOrigin = tile.field('tile_origin_merc', vec2fT)
  const absMercX = Let('abs_merc_x', p.p_h.x.add(p.p_l.x).add(tileOrigin.x))
  const absMercY = Let('abs_merc_y', p.p_h.y.add(p.p_l.y).add(tileOrigin.y))
  const absLon = Let('abs_lon', absMercX.div(constRef('DEG2RAD').mul(constRef('EARTH_R'))))
  const latRad = Let('lat_rad', callFn('inv_merc_lat_rad', f32T, absMercY))
  const absLat = Let('abs_lat', latRad.div(constRef('DEG2RAD')))
  return callFn('needs_backface_cull', f32T, absLon, absLat, tile.field('proj_params', vec4fT))
})

const patternUnitToM = fn('pattern_unit_to_m', { v: f32T, unit: u32T, mpp: f32T }, f32T, (p, _b) => {
  // single-exit, 0=m 1=px 2=km 3=nm — nested select from the default (nm) up.
  const km = select(p.unit.eq(u32(2)), p.v.mul(1000), p.v.mul(1852))
  const px = select(p.unit.eq(u32(1)), p.v.mul(p.mpp), km)
  return select(p.unit.eq(u32(0)), p.v, px)
})

// Inlined SDF shape sampler — uses our `shape_segments` (binding 3) instead
// of the shared SDF module's `segments` name (which would collide with the
// line segment storage buffer on binding 1).
const sdfShape = fn('sdf_shape', { uv_in: vec2fT, shape_id: u32T }, f32T, (p, _b) => {
  const uv = Let('uv', vec2(p.uv_in.x, p.uv_in.y.neg()))
  const s = Let('s', shapes.at(p.shape_id, structT('ShapeDesc')))
  const bMinX = s.field('bbox_min_x', f32T)
  const bMinY = s.field('bbox_min_y', f32T)
  const bMaxX = s.field('bbox_max_x', f32T)
  const bMaxY = s.field('bbox_max_y', f32T)
  ReturnIf(
    uv.x.lt(bMinX).or(uv.x.gt(bMaxX)).or(uv.y.lt(bMinY)).or(uv.y.gt(bMaxY)),
    f32(2),
  )
  const minDist = Var('min_dist', f32T, f32(1e10))
  const winding = Var('winding', i32T, i32(0))
  const segStart = s.field('seg_start', u32T)
  const segCount = s.field('seg_count', u32T)
  const end = Let('end', min(segStart.add(segCount), segStart.add(u32(32))))
  Loop('i', segStart, (i) => i.lt(end), (i) => {
    const seg = Let('seg', shape_segments.at(i, structT('ShapeSegment')))
    const p0 = seg.field('p0', vec2fT)
    const p1 = seg.field('p1', vec2fT)
    const p2 = seg.field('p2', vec2fT)
    const p3 = seg.field('p3', vec2fT)
    Switch(seg.field('kind', u32T), [
      [0, () => {
        assign(minDist, min(minDist, callFn('dist_to_segment', f32T, uv, p0, p1)))
        assignOp(winding, '+', callFn('winding_line', i32T, uv, p0, p1))
      }],
      [1, () => {
        assign(minDist, min(minDist, callFn('dist_to_quadratic', f32T, uv, p0, p1, p2)))
        assignOp(winding, '+', callFn('winding_line', i32T, uv, p0, p2))
      }],
      [2, () => {
        assign(minDist, min(minDist, callFn('dist_to_cubic', f32T, uv, p0, p1, p2, p3)))
        assignOp(winding, '+', callFn('winding_line', i32T, uv, p0, p3))
      }],
    ], () => { /* default: empty */ })
  })
  ReturnIf(winding.ne(i32(0)), f32(1).sub(minDist))
  return f32(1).add(minDist)
}, { allowEarlyReturn: true }) // MISRA single-exit DEVIATION — the out-of-bbox guard skips a 32-iter segment loop (perf)

// ── compute_line_color: shared body for fs_line / fs_line_max / fs_line_pattern ──
//
// Backface cull → clip-bounds → segment-frame distance → bisector clip → bevel
// edge → endpoint cap/join → dash → 3-slot pattern stack → alpha + per-segment
// colour override. Faithful port of the WGSL helper (renderer-shaders.ts L661-1234).
const computeLineColor = fn('compute_line_color', { input: structT('LineOut') }, vec4fT, (p, b) => {
  const projParams = tile.field('proj_params', vec4fT)
  const tileOrigin = tile.field('tile_origin_merc', vec2fT)
  const clipBounds = tile.field('clip_bounds', vec4fT)

  // Backface cull on non-Mercator (helper short-circuits to +1 for flat).
  b.if(projParams.x.ge(0.5), (c) => {
    const absMerc = c.let('abs_merc', p.input.field('world_local', vec2fT).add(tileOrigin))
    const absLon = c.let('abs_lon', absMerc.x.div(constRef('DEG2RAD').mul(constRef('EARTH_R'))))
    const latRad = c.let('lat_rad', callFn('inv_merc_lat_rad', f32T, absMerc.y))
    const absLat = c.let('abs_lat', latRad.div(constRef('DEG2RAD')))
    c.if(callFn('needs_backface_cull', f32T, absLon, absLat, projParams).lt(0), (d) => { d.discard() })
  })

  // Per-tile clip mask (sentinel -1e30 skips). Reconstruct absolute Mercator
  // depending on projection — Mercator branch is cam-relative, non-Merc is
  // tile-local source Mercator.
  const clipValid = b.let('_clip_valid',
    clipBounds.x.gt(-1e29)
      .and(clipBounds.z.gt(clipBounds.x))
      .and(clipBounds.w.gt(clipBounds.y)),
  )
  b.if(clipValid, (c) => {
    const camOffset = c.let('cam_offset',
      select(
        projParams.x.lt(0.5),
        tile.field('cam_h', vec2fT).add(tile.field('cam_l', vec2fT)),
        vec2(f32(0), f32(0)),
      ),
    )
    const absMercClip = c.let('abs_merc_clip',
      p.input.field('world_local', vec2fT).add(camOffset).add(tileOrigin),
    )
    c.if(absMercClip.x.lt(clipBounds.x), (d) => { d.discard() })
    c.if(absMercClip.x.gt(clipBounds.z), (d) => { d.discard() })
    c.if(absMercClip.y.lt(clipBounds.y), (d) => { d.discard() })
    c.if(absMercClip.y.gt(clipBounds.w), (d) => { d.discard() })
  })

  const seg = b.let('seg', segments.at(p.input.field('seg_id', u32T), structT('LineSegment')))
  const segP = b.let('p', p.input.field('world_local', vec2fT))
  const p0 = b.let('p0', lineEndpoint(seg.field('p0_h', vec2fT), seg.field('p0_l', vec2fT)))
  const p1 = b.let('p1', lineEndpoint(seg.field('p1_h', vec2fT), seg.field('p1_l', vec2fT)))

  // Segment direction / normal in tile-local meters.
  const segVec = b.let('seg_vec', p1.sub(p0))
  const segLen = b.let('seg_len', length(segVec))
  const dir = b.var('dir', vec2fT)
  b.if(segLen.lt(1e-6), (c) => { c.assign(dir, vec2(f32(1), f32(0))) })
    .else((c) => { c.assign(dir, segVec.div(segLen)) })

  // Per-segment width override falls through to layer.width_px when 0.
  const layerWidthPx = layer.field('width_px', f32T)
  const layerMpp = layer.field('mpp', f32T)
  const layerOffsetM = layer.field('offset_m', f32T)
  const layerFlags = layer.field('flags', u32T)
  const segWidthOv = seg.field('width_px_override', f32T)
  const effectiveWidthPx = b.let('effective_width_px',
    select(segWidthOv.gt(0), segWidthOv, layerWidthPx),
  )
  const halfWm = b.let('half_w_m', effectiveWidthPx.mul(0.5).mul(layerMpp))

  // 1. Main body distance.
  const nrmLine = b.let('nrm_line', vec2(dir.y.neg(), dir.x))
  const signedPerp = b.let('signed_perp', dot(segP.sub(p0), nrmLine))
  const perpM = b.let('perp_m', abs(signedPerp.sub(layerOffsetM)))
  const bodyD = b.let('body_d', perpM.sub(halfWm))

  // Offset-shifted endpoint cap centres + miter-shifted join centres.
  const p0CapCenter = b.let('p0_cap_center', p0.add(nrmLine.mul(layerOffsetM)))
  const p1CapCenter = b.let('p1_cap_center', p1.add(nrmLine.mul(layerOffsetM)))

  const prevTan = seg.field('prev_tangent', vec2fT)
  const nextTan = seg.field('next_tangent', vec2fT)

  const nrmPrevOff = b.let('nrm_prev_off', vec2(prevTan.y.neg(), prevTan.x))
  const miterVecP0 = b.let('miter_vec_p0', nrmLine.add(nrmPrevOff))
  const projP0 = b.let('proj_p0', dot(miterVecP0, nrmLine))
  const p0JoinCenter = b.let('p0_join_center',
    p0.add(miterVecP0.mul(layerOffsetM.div(max(projP0, f32(1e-4))))),
  )

  const nrmNextOff = b.let('nrm_next_off', vec2(nextTan.y.neg(), nextTan.x))
  const miterVecP1 = b.let('miter_vec_p1', nrmLine.add(nrmNextOff))
  const projP1 = b.let('proj_p1', dot(miterVecP1, nrmLine))
  const p1JoinCenter = b.let('p1_join_center',
    p1.add(miterVecP1.mul(layerOffsetM.div(max(projP1, f32(1e-4))))),
  )

  // Endpoint along-axis distances (negative on the segment interior).
  const distP0Vs = b.let('dist_p0_vs', dot(segP.sub(p0), dir).neg())
  const distP1Vs = b.let('dist_p1_vs', dot(segP.sub(p1), dir))

  // Early-discard guard: outside the body AND inside segment range.
  const patExtentFs = b.var('pat_extent_fs', f32T, f32(0))
  b.if(layerFlags.bitAnd(u32(64)).ne(u32(0)), (c) => {
    c.forRange('pk_fs', u32(0), (pk) => pk.lt(u32(3)), (cb, pk) => {
      const patFs = cb.let('pat_fs', layer.field('patterns', arrayT(structT('PatternSlot'), 3)).at(pk, structT('PatternSlot')))
      cb.if(patFs.field('id', u32T).eq(u32(0)), (d) => { d.continue() })
      const szUnit = cb.let('sz_unit_fs', patFs.field('flags', u32T).shr(u32(2)).bitAnd(u32(3)))
      const ofUnit = cb.let('off_unit_fs', patFs.field('flags', u32T).shr(u32(4)).bitAnd(u32(3)))
      const sizeM = cb.let('size_m_fs', patternUnitToM(patFs.field('size', f32T), szUnit, layerMpp))
      const offM = cb.let('off_m_fs', abs(patternUnitToM(patFs.field('offset', f32T), ofUnit, layerMpp)))
      cb.assign(patExtentFs, max(patExtentFs, sizeM.mul(0.5).add(offM)))
    })
  })
  const aaMarginM = b.let('aa_margin_m', f32(2).mul(layer.field('aa_width_px', f32T)).mul(layerMpp))
  const earlyPerpThresh = b.let('early_perp_thresh', max(halfWm, patExtentFs).add(aaMarginM))
  b.if(perpM.gt(earlyPerpThresh).and(distP0Vs.lt(0)).and(distP1Vs.lt(0)), (c) => { c.discard() })

  // 2. Cap/join feasibility flags + cap-type extraction.
  const hasPrev = b.let('has_prev', length(prevTan).gt(0.001))
  const hasNext = b.let('has_next', length(nextTan).gt(0.001))
  const capType = b.let('cap_type', layerFlags.bitAnd(u32(7)))
  const arrowL = b.let('arrow_L', halfWm.mul(4))

  // Aliases (the original WGSL re-binds these via `let dist_p0 = dist_p0_vs;`).
  const distP0 = distP0Vs
  const distP1 = distP1Vs

  const dM = b.var('d_m', f32T, bodyD)

  const joinFlags = b.let('join_flags', layerFlags.shr(u32(3)).bitAnd(u32(3)))
  const layerMiterLimit = layer.field('miter_limit', f32T)
  // Mapbox line-round-limit → per-layer round-join fold threshold. The
  // uniform carries the raw limit (default 1.05); 0 means "no override"
  // and the shader keeps its historical JOIN_ACUTE_BIS constant exactly,
  // so a layer that doesn't author line-round-limit is byte-identical.
  // A positive value scales the fold threshold by round_limit / 1.05,
  // so the spec default 1.05 also reproduces JOIN_ACUTE_BIS (1.05/1.05=1).
  const layerRoundLimit = layer.field('round_limit', f32T)
  const acuteFoldBis = b.let('acute_fold_bis',
    select(layerRoundLimit.gt(f32(0)),
      f32(JOIN_ACUTE_BIS).mul(layerRoundLimit.div(f32(1.05))),
      f32(JOIN_ACUTE_BIS)))

  // ── Bisector clip + bevel-edge clip at p0 ──
  b.if(hasPrev, (c) => {
    const bisP0 = c.let('bis_p0', prevTan.add(dir))
    const bisLenP0 = c.let('bis_len_p0', length(bisP0))
    c.if(bisLenP0.gt(1e-6), (d) => {
      const bisUnitP0 = d.let('bis_unit_p0', bisP0.div(bisLenP0))
      const alongP0 = d.let('along_p0', dot(segP.sub(p0JoinCenter), bisUnitP0))
      d.if(alongP0.lt(0), (e) => {
        e.assign(dM, max(dM, alongP0.neg().add(layerMpp)))
      })
    })
    // BEVEL / over-limit MITER edge clip at p0. Bevel when miter ratio
    // 1/cos(θ/2) > limit ⇒ bisMag = 2cos(θ/2) < 2/limit (#432; was sin, wrong).
    const bisMagP0 = c.let('bis_mag_p0', length(prevTan.add(dir)))
    const miterOverP0 = c.let('miter_over_p0', bisMagP0.lt(f32(2).div(max(layerMiterLimit, f32(1e-4)))))
    const applyBevelP0 = c.let('apply_bevel_p0',
      joinFlags.eq(u32(2)).or(joinFlags.eq(u32(0)).and(miterOverP0)),
    )
    c.if(applyBevelP0, (d) => {
      const prevNrm = d.let('prev_nrm', vec2(prevTan.y.neg(), prevTan.x))
      const crossP0 = d.let('cross_p0', prevTan.x.mul(dir.y).sub(prevTan.y.mul(dir.x)))
      d.if(abs(crossP0).gt(1e-6), (e) => {
        const s0 = e.let('s0', sign(crossP0).neg())
        const oc0 = e.let('oc0', p0.add(prevNrm.mul(layerOffsetM.add(halfWm.mul(s0)))))
        const on0 = e.let('on0', p0.add(nrmLine.mul(layerOffsetM.add(halfWm.mul(s0)))))
        const be0 = e.let('be0', on0.sub(oc0))
        const bl0 = e.let('bl0', length(be0))
        e.if(bl0.gt(1e-6), (f) => {
          const bd0 = f.let('bd0', be0.div(bl0))
          const bo0 = f.let('bo0', vec2(bd0.y.neg(), bd0.x).mul(s0))
          const bclip0 = f.let('bclip0', dot(segP.sub(oc0), bo0))
          f.if(bclip0.gt(0), (g) => { g.assign(dM, max(dM, bclip0)) })
        })
      })
    })
  })

  // ── Bisector clip + bevel-edge clip at p1 ──
  b.if(hasNext, (c) => {
    const bisP1 = c.let('bis_p1', dir.add(nextTan))
    const bisLenP1 = c.let('bis_len_p1', length(bisP1))
    c.if(bisLenP1.gt(1e-6), (d) => {
      const bisUnitP1 = d.let('bis_unit_p1', bisP1.div(bisLenP1))
      const alongP1 = d.let('along_p1', dot(segP.sub(p1JoinCenter), bisUnitP1))
      d.if(alongP1.gt(0), (e) => {
        e.assign(dM, max(dM, alongP1.add(layerMpp)))
      })
    })
    // Bevel when miter ratio 1/cos(θ/2) > limit ⇒ bisMag < 2/limit (#432).
    const bisMagP1 = c.let('bis_mag_p1', length(dir.add(nextTan)))
    const miterOverP1 = c.let('miter_over_p1', bisMagP1.lt(f32(2).div(max(layerMiterLimit, f32(1e-4)))))
    const applyBevelP1 = c.let('apply_bevel_p1',
      joinFlags.eq(u32(2)).or(joinFlags.eq(u32(0)).and(miterOverP1)),
    )
    c.if(applyBevelP1, (d) => {
      const nextNrmBv = d.let('next_nrm_bv', vec2(nextTan.y.neg(), nextTan.x))
      const crossP1 = d.let('cross_p1', dir.x.mul(nextTan.y).sub(dir.y.mul(nextTan.x)))
      d.if(abs(crossP1).gt(1e-6), (e) => {
        const s1 = e.let('s1', sign(crossP1).neg())
        const oc1 = e.let('oc1', p1.add(nrmLine.mul(layerOffsetM.add(halfWm.mul(s1)))))
        const on1 = e.let('on1', p1.add(nextNrmBv.mul(layerOffsetM.add(halfWm.mul(s1)))))
        const be1 = e.let('be1', on1.sub(oc1))
        const bl1 = e.let('bl1', length(be1))
        e.if(bl1.gt(1e-6), (f) => {
          const bd1 = f.let('bd1', be1.div(bl1))
          const bo1 = f.let('bo1', vec2(bd1.y.neg(), bd1.x).mul(s1))
          const bclip1 = f.let('bclip1', dot(segP.sub(oc1), bo1))
          f.if(bclip1.gt(0), (g) => { g.assign(dM, max(dM, bclip1)) })
        })
      })
    })
  })

  // ── Handle p0 end (cap or join) ──
  // The DSL bool API has no `.not`, so the original `!has_prev` / `!has_next`
  // gates are recomputed positively as `length(tangent) <= eps`.
  const noPrev = b.let('no_prev', length(prevTan).le(0.001))
  const noNext = b.let('no_next', length(nextTan).le(0.001))

  b.if(noPrev, (c) => {
    // CAP_BUTT
    c.if(capType.eq(u32(0)), (d) => { d.assign(dM, max(dM, distP0)) })
      .elif(capType.eq(u32(2)), (d) => { d.assign(dM, max(dM, distP0.sub(halfWm))) })
      .elif(capType.eq(u32(3)), (d) => {
        // CAP_ARROW: analytical tapered half-width.
        d.if(distP0.gt(0), (e) => {
          const t = e.let('t', clamp(distP0.div(arrowL), 0, 1))
          const newW = e.let('new_w', halfWm.mul(f32(1).sub(t)))
          e.assign(dM, max(perpM.sub(newW), distP0.sub(arrowL)))
        })
      })
      .else((d) => {
        // CAP_ROUND
        const circleD = d.let('circle_d', length(segP.sub(p0CapCenter)).sub(halfWm))
        d.assign(dM, select(distP0.gt(0), circleD, dM))
      })
  }).else((c) => {
    // JOIN at p0 — round-join overlay; gated by forward bisector.
    const joinType = c.let('join_type', layerFlags.shr(u32(3)).bitAnd(u32(3)))
    c.if(joinType.eq(u32(1)).and(distP0.gt(0)), (d) => {
      const bisP0j = d.let('bis_p0_j', prevTan.add(dir))
      const bisLenJ = d.let('bis_len_j', length(bisP0j))
      // Acute fold → full round point (ML parity); moderate bends keep the
      // half-plane. #413; see JOIN_ACUTE_BIS + the select() combine below.
      const acuteFoldP0 = d.let('acute_fold_p0', bisLenJ.le(acuteFoldBis))
      const bisUnitJ = d.let('bis_unit_j', bisP0j.div(max(bisLenJ, f32(1e-6))))
      const alongJ = d.let('along_j', dot(segP.sub(p0JoinCenter), bisUnitJ))
      d.if(acuteFoldP0.or(alongJ.ge(0)), (f) => {
        const circleD = f.let('circle_d', length(segP.sub(p0JoinCenter)).sub(halfWm))
        const alongExtendP0 = f.let('along_extend_p0', abs(layerOffsetM).mul(seg.field('pad_ratio_p0', f32T)))
        const currentD = f.var('current_d', f32T, dM)
        f.if(distP0.gt(alongExtendP0), (g) => {
          g.assign(currentD, max(dM, distP0.sub(alongExtendP0)))
        })
        const prevNrm = f.let('prev_nrm', vec2(prevTan.y.neg(), prevTan.x))
        const prevSignedPerp = f.let('prev_signed_perp', dot(segP.sub(p0), prevNrm))
        const prevPerpM = f.let('prev_perp_m', abs(prevSignedPerp.sub(layerOffsetM)))
        const neighborD = f.var('neighbor_d', f32T, prevPerpM.sub(halfWm))
        const alongPastPrevEnd = f.let('along_past_prev_end', dot(segP.sub(p0), prevTan))
        f.if(alongPastPrevEnd.gt(alongExtendP0), (g) => {
          g.assign(neighborD, max(neighborD, alongPastPrevEnd.sub(alongExtendP0)))
        })
        // Acute fold → pure round-point union (no carve); else original combine.
        f.assign(dM, min(circleD, select(acuteFoldP0, dM, min(currentD, neighborD))))
      })
    })
  })

  // ── Handle p1 end (cap or join) — symmetric ──
  b.if(noNext, (c) => {
    c.if(capType.eq(u32(0)), (d) => { d.assign(dM, max(dM, distP1)) })
      .elif(capType.eq(u32(2)), (d) => { d.assign(dM, max(dM, distP1.sub(halfWm))) })
      .elif(capType.eq(u32(3)), (d) => {
        d.if(distP1.gt(0), (e) => {
          const t = e.let('t', clamp(distP1.div(arrowL), 0, 1))
          const newW = e.let('new_w', halfWm.mul(f32(1).sub(t)))
          e.assign(dM, max(perpM.sub(newW), distP1.sub(arrowL)))
        })
      })
      .else((d) => {
        const circleD = d.let('circle_d', length(segP.sub(p1CapCenter)).sub(halfWm))
        d.assign(dM, select(distP1.gt(0), circleD, dM))
      })
  }).else((c) => {
    const joinTypeP1 = c.let('join_type_p1', layerFlags.shr(u32(3)).bitAnd(u32(3)))
    c.if(joinTypeP1.eq(u32(1)).and(distP1.gt(0)), (d) => {
      const bisP1j = d.let('bis_p1_j', dir.add(nextTan))
      const bisLenJ = d.let('bis_len_j', length(bisP1j))
      const acuteFoldP1 = d.let('acute_fold_p1', bisLenJ.le(acuteFoldBis)) // #413, mirrors p0; threshold scaled by line-round-limit
      const bisUnitJ = d.let('bis_unit_j', bisP1j.div(max(bisLenJ, f32(1e-6))))
      const alongJ = d.let('along_j', dot(segP.sub(p1JoinCenter), bisUnitJ))
      d.if(acuteFoldP1.or(alongJ.le(0)), (f) => {
        const circleD = f.let('circle_d', length(segP.sub(p1JoinCenter)).sub(halfWm))
        const alongExtendP1 = f.let('along_extend_p1', abs(layerOffsetM).mul(seg.field('pad_ratio_p1', f32T)))
        const currentD = f.var('current_d', f32T, dM)
        f.if(distP1.gt(alongExtendP1), (g) => {
          g.assign(currentD, max(dM, distP1.sub(alongExtendP1)))
        })
        const nextNrm = f.let('next_nrm', vec2(nextTan.y.neg(), nextTan.x))
        const nextSignedPerp = f.let('next_signed_perp', dot(segP.sub(p1), nextNrm))
        const nextPerpM = f.let('next_perp_m', abs(nextSignedPerp.sub(layerOffsetM)))
        const neighborD = f.var('neighbor_d', f32T, nextPerpM.sub(halfWm))
        const alongIntoNext = f.let('along_into_next', dot(segP.sub(p1), nextTan))
        f.if(alongIntoNext.lt(alongExtendP1.neg()), (g) => {
          g.assign(neighborD, max(neighborD, alongIntoNext.neg().sub(alongExtendP1)))
        })
        f.assign(dM, min(circleD, select(acuteFoldP1, dM, min(currentD, neighborD))))
      })
    })
  })

  // Project fragment along segment axis (shared by dash + patterns).
  const tAlongUnclamped = b.let('t_along_unclamped', dot(segP.sub(p0), dir))
  const tAlong = b.let('t_along', clamp(tAlongUnclamped, 0, segLen))
  const arcPos = b.let('arc_pos', seg.field('arc_start', f32T).add(tAlong))
  const nrmFs = b.let('nrm_fs', vec2(dir.y.neg(), dir.x))

  // ── Dash array ──
  // notInCap = !(noPrev && distP0>0 || noNext && distP1>0)
  //         =  (hasPrev || distP0<=0) && (hasNext || distP1<=0)
  // — boolean DSL has no `.not`, so the original `!in_cap_region` gate is
  // emitted as the De Morgan-converted positive form.
  const notInCap = b.let('not_in_cap',
    hasPrev.or(distP0.le(0)).and(hasNext.or(distP1.le(0))),
  )
  const dashCount = layer.field('dash_count', u32T)
  const dashCycleM = layer.field('dash_cycle_m', f32T)
  const dashOffsetM = layer.field('dash_offset_m', f32T)
  const dashEnabled = b.let('dash_enabled',
    layerFlags.shr(u32(5)).bitAnd(u32(1)).eq(u32(1))
      .and(dashCount.gt(u32(0)))
      .and(dashCycleM.gt(1e-6))
      .and(notInCap),
  )
  b.if(dashEnabled, (c) => {
    const phase0 = c.let('phase0', arcPos.add(dashOffsetM).div(dashCycleM))
    const phase = c.var('phase', f32T, phase0.sub(floor(phase0)).mul(dashCycleM))
    const acc = c.var('acc', f32T, f32(0))
    const visible = c.var('visible', f32T, f32(0)) // 0=hidden, 1=visible — bool via f32
    c.forRange('i', u32(0), (i) => i.lt(dashCount), (cb, i) => {
      const idx = cb.let('idx', i.div(u32(4)))
      const sub = cb.let('sub', i.mod(u32(4)))
      const segV = cb.let('seg_v', layer.field('dash_array', arrayT(vec4fT, 2)).at(idx, vec4fT))
      const lenV = cb.var('len', f32T, f32(0))
      cb.if(sub.eq(u32(0)), (d) => { d.assign(lenV, segV.x) })
        .elif(sub.eq(u32(1)), (d) => { d.assign(lenV, segV.y) })
        .elif(sub.eq(u32(2)), (d) => { d.assign(lenV, segV.z) })
        .else((d) => { d.assign(lenV, segV.w) })
      cb.if(phase.ge(acc).and(phase.lt(acc.add(lenV))), (d) => {
        d.assign(visible, select(i.bitAnd(u32(1)).eq(u32(0)), f32(1), f32(0)))
        d.break()
      })
      cb.assign(acc, acc.add(lenV))
    })
    c.if(visible.lt(0.5), (d) => { d.discard() })
  })

  // ── Pattern stack ──
  const patDm = b.var('pat_d_m', f32T, f32(1e10))
  b.if(layerFlags.bitAnd(u32(64)).ne(u32(0)), (c) => {
    c.forRange('k', u32(0), (k) => k.lt(u32(3)), (cb, k) => {
      const pat = cb.let('pat', layer.field('patterns', arrayT(structT('PatternSlot'), 3)).at(k, structT('PatternSlot')))
      cb.if(pat.field('id', u32T).eq(u32(0)), (d) => { d.continue() })

      const patF = pat.field('flags', u32T)
      const spUnit = cb.let('sp_unit', patF.bitAnd(u32(3)))
      const szUnit = cb.let('sz_unit', patF.shr(u32(2)).bitAnd(u32(3)))
      const ofUnit = cb.let('of_unit', patF.shr(u32(4)).bitAnd(u32(3)))
      const anchor = cb.let('anchor', patF.shr(u32(6)).bitAnd(u32(3)))
      const spacingM = cb.let('spacing_m', max(patternUnitToM(pat.field('spacing', f32T), spUnit, layerMpp), f32(1e-3)))
      const sizeM = cb.let('size_m', max(patternUnitToM(pat.field('size', f32T), szUnit, layerMpp), f32(1e-3)))
      const offM = cb.let('off_m', patternUnitToM(pat.field('offset', f32T), ofUnit, layerMpp))
      const startM = cb.let('start_m', pat.field('start_offset', f32T))
      const halfS = cb.let('half_s', sizeM.mul(0.5))

      // CANARY (C2 readability): the ambient free-function surface — If/Loop/Let/
      // Continue/assign route to the innermost scope, so no cb/d/cb2/e param
      // threading; the composite helpers (madd / outsideRange) name the arithmetic.
      // Emits byte-identically to the old passed-builder form (verified).
      If(anchor.eq(u32(0)), () => {
        // PAT_ANCHOR_REPEAT — sample nearest instance + both neighbours.
        const kCenter = Let('k_center', floor(arcPos.sub(startM).div(spacingM).add(0.5)))
        Loop('dk', i32(-1), (idk) => idk.le(i32(1)), (dk) => {
          const centerArcK = Let('center_arc_k', madd(kCenter.add(toF32(dk)), spacingM, startM))
          const arcOnSegK = Let('arc_on_seg_k', centerArcK.sub(seg.field('arc_start', f32T)))
          If(outsideRange(arcOnSegK, halfS.mul(-2), segLen.add(halfS.mul(2))), () => Continue())
          const centerWorldK = Let('center_world_k', p0.add(dir.mul(arcOnSegK)))
          const localK = Let('local_k', vec2(
            dot(segP.sub(centerWorldK), dir).div(halfS),
            dot(segP.sub(centerWorldK), nrmFs).sub(offM).div(halfS),
          ))
          If(abs(localK.x).gt(1.2).or(abs(localK.y).gt(1.2)), () => Continue())
          const shapeVK = Let('shape_v_k', sdfShape(localK, pat.field('id', u32T).sub(u32(1))))
          const pdK = Let('pd_k', shapeVK.sub(1).mul(halfS))
          assign(patDm, min(patDm, pdK))
        })
        // PAT_ANCHOR_REPEAT is fully handled by the k-loop; skip the single-instance
        // block. Continue() targets the enclosing segment loop — the old cb/d/cb2/e
        // wrong-builder footgun (which once silently dropped ALL line patterns) is now
        // unrepresentable: there is no second builder to address.
        Continue()
      })

      // START / END / CENTER — single instance.
      const lineLength = seg.field('line_length', f32T)
      const centerArc = Var('center_arc', f32T)
      If(anchor.eq(u32(1)), () => { assign(centerArc, startM) })
        .elif(anchor.eq(u32(2)), () => { assign(centerArc, lineLength.sub(startM)) })
        .else(() => { assign(centerArc, lineLength.mul(0.5)) })

      const arcOnSeg = Let('arc_on_seg', centerArc.sub(seg.field('arc_start', f32T)))
      If(outsideRange(arcOnSeg, halfS.mul(-2), segLen.add(halfS.mul(2))), () => Continue())
      const centerWorld = Let('center_world', p0.add(dir.mul(arcOnSeg)))
      const localUv = Let('local', vec2(
        dot(segP.sub(centerWorld), dir).div(halfS),
        dot(segP.sub(centerWorld), nrmFs).sub(offM).div(halfS),
      ))
      If(abs(localUv.x).gt(1.2).or(abs(localUv.y).gt(1.2)), () => Continue())

      const shapeV = Let('shape_v', sdfShape(localUv, pat.field('id', u32T).sub(u32(1))))
      const pd = Let('pd', shapeV.sub(1).mul(halfS))
      assign(patDm, min(patDm, pd))
    })
  })
  If(patDm.lt(1e9), () => { assign(dM, min(dM, patDm)) })

  // Convert to pixels + line-blur AA.
  const dPx = Let('d_px', dM.div(layerMpp))
  const blurPx = Let('blur_px', max(f32(0), layer.field('aa_width_px', f32T).sub(1)))
  const aa = Let('aa', f32(0.5).add(blurPx))
  const alpha = Let('alpha', f32(1).sub(smoothstep(aa.neg(), aa, dPx)))
  If(alpha.lt(0.005), () => Discard())

  // Per-segment stroke colour override.
  const segPacked = Let('seg_packed', bitcastU32(seg.field('color_packed', f32T)))
  const segColor = Let('seg_color', unpack4x8unorm(segPacked))
  const baseColor = Let('base_color', select(segColor.a.gt(0), segColor, layer.field('color', vec4fT)))
  return vec4(baseColor.rgb, baseColor.a.mul(alpha))
})

// ── line_rim_alpha ──
const lineRimAlpha = fn('line_rim_alpha', { input: structT('LineOut') }, f32T, (p, _b) => {
  const tileOrigin = tile.field('tile_origin_merc', vec2fT)
  const absMerc = Let('abs_merc', p.input.field('world_local', vec2fT).add(tileOrigin))
  const absLon = Let('abs_lon', absMerc.x.div(constRef('DEG2RAD').mul(constRef('EARTH_R'))))
  const latRad = Let('lat_rad', callFn('inv_merc_lat_rad', f32T, absMerc.y))
  const absLat = Let('abs_lat', latRad.div(constRef('DEG2RAD')))
  return callFn('rim_alpha', f32T, absLon, absLat, tile.field('proj_params', vec4fT))
})

// ── vs_line ──

const vsLine = entryFn('vs_line', 'vertex', [
  { name: 'seg_id', type: u32T, builtin: 'instance_index' },
  { name: 'vi', type: u32T, builtin: 'vertex_index' },
], structT('LineOut'), (p, b) => {
  const seg = b.let('seg', segments.at(p.seg_id, structT('LineSegment')))
  const p0 = b.let('p0', lineEndpoint(seg.field('p0_h', vec2fT), seg.field('p0_l', vec2fT)))
  const p1 = b.let('p1', lineEndpoint(seg.field('p1_h', vec2fT), seg.field('p1_l', vec2fT)))

  const segVec = b.let('seg_vec', p1.sub(p0))
  const segLen = b.let('seg_len', length(segVec))
  const dir = b.var('dir', vec2fT)
  b.if(segLen.lt(1e-6), (c) => { c.assign(dir, vec2(f32(1), f32(0))) })
    .else((c) => { c.assign(dir, segVec.div(segLen)) })
  const nrm = b.let('nrm', vec2(dir.y.neg(), dir.x))

  const layerWidthPx = layer.field('width_px', f32T)
  const layerMpp = layer.field('mpp', f32T)
  const layerAaPx = layer.field('aa_width_px', f32T)
  const layerOffsetM = layer.field('offset_m', f32T)
  const layerFlags = layer.field('flags', u32T)
  const layerVpH = layer.field('viewport_height', f32T)
  const layerDpr = layer.field('dpr', f32T)

  const segWidthOv = seg.field('width_px_override', f32T)
  const effectiveWidthPx = b.let('effective_width_px',
    select(segWidthOv.gt(0), segWidthOv, layerWidthPx),
  )
  const halfWm = b.let('half_w_m', effectiveWidthPx.mul(0.5).add(layerAaPx).mul(layerMpp))

  // Per-endpoint pad ratios (precomputed CPU side).
  const padP0m = b.var('pad_p0_m', f32T, seg.field('pad_ratio_p0', f32T).mul(halfWm))
  const padP1m = b.var('pad_p1_m', f32T, seg.field('pad_ratio_p1', f32T).mul(halfWm))

  // Pattern extent scan.
  const patExtentM = b.var('pat_extent_m', f32T, f32(0))
  b.if(layerFlags.bitAnd(u32(64)).ne(u32(0)), (c) => {
    c.forRange('pk', u32(0), (pk) => pk.lt(u32(3)), (cb, pk) => {
      const pat = cb.let('pat', layer.field('patterns', arrayT(structT('PatternSlot'), 3)).at(pk, structT('PatternSlot')))
      cb.if(pat.field('id', u32T).eq(u32(0)), (d) => { d.continue() })
      const szUnit = cb.let('sz_unit', pat.field('flags', u32T).shr(u32(2)).bitAnd(u32(3)))
      const offUnit = cb.let('off_unit', pat.field('flags', u32T).shr(u32(4)).bitAnd(u32(3)))
      const sizeM = cb.let('size_m', patternUnitToM(pat.field('size', f32T), szUnit, layerMpp))
      const offM = cb.let('off_m', abs(patternUnitToM(pat.field('offset', f32T), offUnit, layerMpp)))
      cb.assign(patExtentM, max(patExtentM, sizeM.mul(0.5).add(offM)))
    })
  })

  // Arrow cap pad.
  const capTypeVs = b.let('cap_type_vs', layerFlags.bitAnd(u32(7)))
  const arrowLen = b.let('arrow_len', halfWm.mul(4))
  const acrossM = b.var('across_m', f32T, max(halfWm, patExtentM))
  b.assign(padP0m, max(padP0m, patExtentM))
  b.assign(padP1m, max(padP1m, patExtentM))
  b.if(capTypeVs.eq(u32(3)), (c) => {
    c.if(length(seg.field('prev_tangent', vec2fT)).lt(0.001), (d) => {
      d.assign(padP0m, max(padP0m, arrowLen))
    })
    c.if(length(seg.field('next_tangent', vec2fT)).lt(0.001), (d) => {
      d.assign(padP1m, max(padP1m, arrowLen))
    })
  })

  // 6-vert quad → along/across.
  const along = b.var('along', f32T, f32(0))
  const across = b.var('across', f32T, f32(0))
  b.switch(p.vi, [
    [0, (c) => { c.assign(along, f32(-1)); c.assign(across, f32(-1)) }],
    [1, (c) => { c.assign(along, f32(1));  c.assign(across, f32(-1)) }],
    [2, (c) => { c.assign(along, f32(1));  c.assign(across, f32(1)) }],
    [3, (c) => { c.assign(along, f32(-1)); c.assign(across, f32(-1)) }],
    [4, (c) => { c.assign(along, f32(1));  c.assign(across, f32(1)) }],
    [5, (c) => { c.assign(along, f32(-1)); c.assign(across, f32(1)) }],
  ], () => { /* default: empty */ })

  const isStart = b.let('is_start', along.lt(0))
  const base = b.let('base', select(isStart, p0, p1))
  const perpCur = b.let('perp_cur', nrm.mul(across))

  const prevTan = seg.field('prev_tangent', vec2fT)
  const nextTan = seg.field('next_tangent', vec2fT)
  const hasPrev = b.let('has_prev', length(prevTan).gt(0.001))
  const hasNext = b.let('has_next', length(nextTan).gt(0.001))
  const hasNeighbor = b.let('has_neighbor', select(isStart, hasPrev, hasNext))

  // Pattern across scale.
  const acrossScale = b.let('across_scale', max(f32(1), acrossM.div(max(halfWm, f32(1e-6)))))

  // Lateral parallel offset.
  const halfWside = b.let('half_w_side', halfWm.add(layerOffsetM.mul(across)))

  const offset = b.var('offset', vec2fT, perpCur.mul(halfWside).mul(acrossScale))
  b.if(hasNeighbor, (c) => {
    const padRatio = c.let('pad_ratio', select(isStart, seg.field('pad_ratio_p0', f32T), seg.field('pad_ratio_p1', f32T)))
    const basePad = c.let('base_pad', select(isStart, padP0m, padP1m))
    const offsetExtentM = c.let('offset_extent_m', halfWm.add(abs(layerOffsetM)))
    const endpointPad = c.let('endpoint_pad', max(basePad, padRatio.mul(offsetExtentM)))
    const joinTypeVs = c.let('join_type_vs', layerFlags.shr(u32(3)).bitAnd(u32(3)))
    const joinPad = c.var('join_pad', f32T, halfWm.add(abs(layerOffsetM).mul(padRatio)))
    c.if(joinTypeVs.eq(u32(0)), (d) => { d.assign(joinPad, endpointPad) })
    c.assign(joinPad, joinPad.add(f32(0.5).mul(layerMpp)))
    const alongPad = c.let('along_pad', max(halfWside, joinPad))
    c.assign(offset, offset.add(dir.mul(along).mul(alongPad).mul(acrossScale)))
  }).else((c) => {
    const endpointPad = c.let('endpoint_pad', select(isStart, padP0m, padP1m))
    c.assign(offset, offset.add(dir.mul(along).mul(endpointPad)))
  })

  const cornerLocal = b.var('corner_local', vec2fT, base.add(offset))

  // ── ECEF-RTC corner reconstruction (Phase 2 PR 2d.1C) ────────────────
  //
  // Hybrid VS: emit clip via `u.mvp * vec4(ecef_rtc, 1)` while still
  // emitting `world_local` as tile-local Mercator metres for the FS
  // distance / clip / backface / pattern math (`compute_line_color` reads
  // `world_local` at 6 sites — backface cull, clip-bounds, segment dist,
  // bevel/cap geometry, rim alpha, pattern repeat). The Mercator path is
  // unchanged; only the clip transform swaps from
  // `u.mvp * project_geom(corner)` to `u.mvp * ecef_rtc(corner)`.
  //
  // Math chain:
  //   1. corner abs Mercator = cornerLocal + tile_origin_merc
  //   2. inverse Mercator     → (abs_lon_rad, abs_lat_rad)
  //   3. WGS84 forward ECEF   → ecef_corner
  //   4. tile ECEF center same chain on tile_origin_merc
  //   5. ecef_rtc             = ecef_corner - tile_ecef_center
  //   6. clip                 = u.mvp * vec4(ecef_rtc, 1)
  //
  // Mirrors the polygon ECEF VS (vs_main_ecef) contract: the runtime
  // builds `u.mvp` (ECEF-MVP) once per frame and the per-tile vertices are
  // RTC-relative to the tile ECEF center. The WGS84 forward is the shared
  // `lonlat_to_ecef` primitive (ecef.ts) — the same one the raster VS calls —
  // so the constants (WGS84_A / WGS84_E2) live in one place. NB: the shared
  // WGS84_E2 (0.0066943799901975955) is f32-equal to the former inline literal
  // (0.006694379990197561) — both truncate to the same f32, so this is not a
  // precision regression despite the differing source digits. Per-vertex cost:
  // 2 sin + 2 cos + 1 sqrt (inside lonlat_to_ecef) + 1 tan + 1 exp — modest on
  // modern GPUs and isolated to the line VS.

  const earthR = constRef('EARTH_R')
  const pi = constRef('PI')

  // Helper: build local ECEF for an absolute Mercator (x_m, y_m) input via the
  // shared `lonlat_to_ecef(lon, lat, height)` (same as the raster VS path).
  // `height` lifts along the GEODETIC NORMAL — the frame the CPU lonLatToECEF
  // uses for the extruded roof ring (polygon-mesh.ts). The previous form added
  // z_lift to ECEF Z AFTER conversion (polar axis), displacing extruded
  // outlines h·cos(lat) north + h·(1−sin lat) below the roof (~37 px at z16).
  type FNode = Node<'f32'>
  const ecefFromMerc = (
    builder: typeof b,
    name: string,
    absMercX: FNode,
    absMercY: FNode,
    height: FNode = f32(0),
  ): Node<'vec3<f32>'> => {
    const lonRad = builder.let(`${name}_lon_rad`, toF32(absMercX.div(earthR)))
    const latRad = builder.let(`${name}_lat_rad`,
      toF32(f32(2).mul(atan(exp(absMercY.div(earthR)))).sub(pi.div(f32(2)))),
    )
    return builder.let(`${name}_ecef`,
      callFn('lonlat_to_ecef', vec3fT, lonRad, latRad, height),
    ) as Node<'vec3<f32>'>
  }

  // Camera-relative RTC offset (tileEcefCenter − cameraCenter), DSFUN hi+lo,
  // written by VTR per tile at f32 52/56. addCamOff converts a tile-relative
  // ECEF into vertex−cameraCenter for the camera-at-ENU-origin MVP — the same
  // two-add form as polygon vs_main_ecef. Applied to BOTH the width-clamp
  // draft (so its on-screen distance estimate uses the true position) and the
  // final clip, keeping them consistent.
  const camOffH = tile.field('cam_ecef_off_h', vec4fT)
  const camOffL = tile.field('cam_ecef_off_l', vec4fT)
  const addCamOff = (v: Node<'vec3<f32>'>): Node<'vec3<f32>'> => v
    .add(vec3(camOffH.x, camOffH.y, camOffH.z))
    .add(vec3(camOffL.x, camOffL.y, camOffL.z)) as Node<'vec3<f32>'>

  // Screen-pixel-width stroke geometry clamp. Pre-clamp draft via ECEF
  // round-trip on the candidate corner (matches polygon convention).
  b.if(layerVpH.gt(0), (c) => {
    const zLift = seg.field('z_lift_m', f32T)
    const mvp = tile.field('mvp', mat4x4fT)
    const projParamsW = tile.field('proj_params', vec4fT)
    // Same MVP transform for center (base) + candidate (cornerLocal) so the
    // screen-space width estimate matches the final clip exactly.
    const centerClip = c.var('center_clip', vec4fT)
    const cornerClip = c.var('corner_clip', vec4fT)
    c.if(projParamsW.x.lt(6.5), (d) => {
      // FLAT (projType 0-6): finalize_corner passes Mercator through (already
      // camera-relative) and reprojects the other flat forms (project_geom −
      // projected camera centre). Same flat 2D-plane MVP for center +
      // candidate so the screen-space width estimate matches the final clip.
      const baseFc = d.let('base_fc', finalizeCorner(base))
      const cornerFc = d.let('corner_fc', finalizeCorner(cornerLocal))
      d.assign(centerClip, transformMat4(mvp, vec4(baseFc.x, baseFc.y, zLift, f32(1))))
      d.assign(cornerClip, transformMat4(mvp, vec4(cornerFc.x, cornerFc.y, zLift, f32(1))))
    }).else((d) => {
      // 3D ECEF round-trip on the candidate corner (matches polygon convention).
      const tileOrigin = tile.field('tile_origin_merc', vec2fT)
      const tileAbsX = d.let('tile_abs_x', toF32(tileOrigin.x))
      const tileAbsY = d.let('tile_abs_y', toF32(tileOrigin.y))
      const tileEcef = ecefFromMerc(d, 'clamp_tile', tileAbsX, tileAbsY)
      const baseAbsX = d.let('base_abs_x', toF32(base.x.add(tileOrigin.x)))
      const baseAbsY = d.let('base_abs_y', toF32(base.y.add(tileOrigin.y)))
      // z_lift rides INTO lonlat_to_ecef as geodetic height (tileEcef anchor
      // stays height-0 = the polygon tile_ecef_center RTC frame).
      const baseEcef = ecefFromMerc(d, 'clamp_base', baseAbsX, baseAbsY, zLift)
      const baseRtc = d.let('base_rtc', baseEcef.sub(tileEcef))
      d.assign(centerClip, transformMat4(mvp, vec4(addCamOff(baseRtc as Node<'vec3<f32>'>), f32(1))))
      const cornerAbsX = d.let('corner_abs_x', toF32(cornerLocal.x.add(tileOrigin.x)))
      const cornerAbsY = d.let('corner_abs_y', toF32(cornerLocal.y.add(tileOrigin.y)))
      const cornerEcef = ecefFromMerc(d, 'clamp_corner', cornerAbsX, cornerAbsY, zLift)
      const cornerRtc = d.let('corner_rtc', cornerEcef.sub(tileEcef))
      d.assign(cornerClip, transformMat4(mvp, vec4(addCamOff(cornerRtc as Node<'vec3<f32>'>), f32(1))))
    })
    const centerXY = c.let('center_xy', vec2(centerClip.x, centerClip.y))
    const cornerXY = c.let('corner_xy', vec2(cornerClip.x, cornerClip.y))
    const centerNdc = c.let('center_ndc', centerXY.div(max(abs(centerClip.w), f32(1e-6))).mul(sign(centerClip.w)))
    const cornerNdc = c.let('corner_ndc', cornerXY.div(max(abs(cornerClip.w), f32(1e-6))).mul(sign(cornerClip.w)))
    const screenDist = c.let('screen_dist', length(cornerNdc.sub(centerNdc)))
    // width target is CSS px; viewport_height is DEVICE px → scale by dpr.
    const targetNdc = c.let('target_ndc', effectiveWidthPx.add(f32(2).mul(layerAaPx)).mul(layerDpr).div(layerVpH))
    // The screen-width clamp may only GROW the quad to counter projection
    // foreshortening — never SHRINK it below the base quad. The base offset is
    // (w/2+aa)·mpp tile-local metres, which the FS distance field (world_local
    // / mpp) renders at exactly the intended CSS-px width; a quad smaller than
    // that clips the fragment coverage and the stroke renders far too thin.
    // (targetNdc is miscalibrated against the perspective viewport scale — it
    // under-targets ~4×, so the raw scale was shrinking every flat stroke to a
    // fraction of its width. Capping at 1 restores the correct base width and
    // keeps the legitimate grow-for-foreshortening path.)
    c.if(screenDist.gt(1e-8), (d) => {
      const scale = d.let('scale', max(targetNdc.div(screenDist), f32(1)))
      d.assign(cornerLocal, base.add(offset.mul(scale)))
    })
  })

  // Final corner → clip. Flat Mercator (proj_params.x < 0.5) feeds the flat
  // 2D-plane MVP directly — cornerLocal is ALREADY camera-relative Mercator
  // metres (line_endpoint subtracted the camera for proj<0.5), so no ECEF
  // round-trip / addCamOff. 3D / globe keeps the WGS84-ECEF chain (cornerLocal
  // is tile-local there). u.mvp is the matching matrix (getViewForProjection);
  // zLift is the outline/extrude lift. world_local stays cornerLocal so the
  // FS distance / clip-bounds math is unchanged.
  const out = b.var('out', structT('LineOut'))
  const tileOrigin2 = tile.field('tile_origin_merc', vec2fT)
  const mvp = tile.field('mvp', mat4x4fT)
  const zLift = seg.field('z_lift_m', f32T)
  const projParamsF = tile.field('proj_params', vec4fT)

  const clip = b.var('clip', vec4fT)
  b.if(projParamsF.x.lt(6.5), (c) => {
    // FLAT (0-6): finalize_corner (Mercator pass-through + non-Mercator
    // project_geom reproject − projected camera centre) → flat 2D-plane MVP.
    const cornerFc = c.let('corner_fc_final', finalizeCorner(cornerLocal))
    c.assign(clip, transformMat4(mvp, vec4(cornerFc.x, cornerFc.y, zLift, f32(1))))
  }).else((c) => {
    const tileAbsX = c.let('tile_abs_x_f', toF32(tileOrigin2.x))
    const tileAbsY = c.let('tile_abs_y_f', toF32(tileOrigin2.y))
    const tileEcef = ecefFromMerc(c, 'final_tile', tileAbsX, tileAbsY)
    const cornerAbsX = c.let('corner_abs_x_f', toF32(cornerLocal.x.add(tileOrigin2.x)))
    const cornerAbsY = c.let('corner_abs_y_f', toF32(cornerLocal.y.add(tileOrigin2.y)))
    // z_lift = geodetic height inside lonlat_to_ecef (matches the CPU
    // lonLatToECEF roof-ring lift); the tile anchor stays height-0.
    const cornerEcef = ecefFromMerc(c, 'final_corner', cornerAbsX, cornerAbsY, zLift)
    const ecefRtc = c.let('ecef_rtc', cornerEcef.sub(tileEcef))
    // Camera-relative RTC — without addCamOff, line projects vertex−
    // tileEcefCenter and collapses toward each tile's origin.
    const ecefCam = c.let('ecef_cam', addCamOff(ecefRtc as Node<'vec3<f32>'>))
    c.assign(clip, transformMat4(mvp, vec4(ecefCam, f32(1))))
  })
  // Mapbox fill-translate for POLYGON OUTLINES: a fill's outline draws through
  // the line pipeline sharing the fill's per-tile slot, so slots 46/47
  // (`_pad_tail0.zw`) already carry its NDC translate. Apply the SAME viewport
  // offset the polygon VS does (polygon.ts:345) so an outline stays glued to a
  // translated fill (OFM building-top roof) — MapLibre parity. Standalone lines
  // write 0 → no-op; the <0.25 guard skips the pattern-repeat-metres overload.
  const fillT = b.let('fill_translate_ndc', tile.field('_pad_tail0', vec4fT))
  b.if(fillT.z.mul(fillT.z).add(fillT.w.mul(fillT.w)).lt(f32(0.25)), (c) => {
    c.assign(clip.x, clip.x.add(fillT.z.mul(clip.w)))
    c.assign(clip.y, clip.y.sub(fillT.w.mul(clip.w)))
  })
  // Mapbox line-translate viewport offset — applied post-MVP so the pixel
  // shift stays constant regardless of depth (mirrors fill-translate logic).
  // Default 0 → no-op; non-zero shifts the entire line layer in screen space.
  const ltx = b.let('line_translate_x', layer.field('line_translate_x', f32T))
  const lty = b.let('line_translate_y', layer.field('line_translate_y', f32T))
  b.if(ltx.mul(ltx).add(lty.mul(lty)).gt(f32(0)), (c) => {
    c.assign(clip.x, clip.x.add(ltx.mul(clip.w)))
    c.assign(clip.y, clip.y.sub(lty.mul(clip.w)))
  })
  b.assign(out.field('position', vec4fT), callFn('apply_log_depth', vec4fT, clip, tile.field('log_depth_fc', f32T)))
  b.assign(out.field('view_w', f32T), clip.w)
  b.assign(out.field('world_local', vec2fT), cornerLocal)
  b.assign(out.field('seg_id', u32T), p.seg_id)
  const cosCp0 = b.let('cos_c_p0', endpointCosC(seg.field('p0_h', vec2fT), seg.field('p0_l', vec2fT)))
  const cosCp1 = b.let('cos_c_p1', endpointCosC(seg.field('p1_h', vec2fT), seg.field('p1_l', vec2fT)))
  b.assign(out.field('cos_c', f32T), select(isStart, cosCp0, cosCp1))
  b.ret(out)
})

// ── Fragment entries (3 variants share compute_line_color) ──

const buildFsLine = (pickEnabled: boolean) =>
  entryFn('fs_line', 'fragment', [{ name: 'input', type: structT('LineOut') }], structT('LineFragmentOutput'), (p, _b) => {
    const out = Var('out', structT('LineFragmentOutput'))
    const color = Let('color', computeLineColor(p.input))
    const rim = Let('rim', lineRimAlpha(p.input))
    assign(out.field('color', vec4fT), vec4(color.rgb, color.a.mul(rim)))
    if (pickEnabled) assign(out.field('pick', vec2uT), vec2u(u32(0), u32(0)))
    assign(out.field('depth', f32T), callFn('compute_log_frag_depth', f32T, p.input.field('view_w', f32T), tile.field('log_depth_fc', f32T)))
    return out
  })

const buildFsLinePattern = (pickEnabled: boolean) =>
  entryFn('fs_line_pattern', 'fragment', [{ name: 'input', type: structT('LineOut') }], structT('LineFragmentOutput'), (p, _b) => {
    const base = Let('base', computeLineColor(p.input))
    const tileOrigin = tile.field('tile_origin_merc', vec2fT)
    const absMerc = Let('abs_merc', p.input.field('world_local', vec2fT).add(tileOrigin))
    const repeatX = Let('repeat_x', max(layer.field('color', vec4fT).r, f32(1)))
    const repeatY = Let('repeat_y', max(layer.field('color', vec4fT).a, f32(1)))
    const uvLocal = Let('uv_local', vec2(
      fract(absMerc.x.div(repeatX)),
      fract(absMerc.y.div(repeatY)),
    ))
    const sc = tile.field('stroke_color', vec4fT)
    const u0 = Let('u0', sc.r)
    const v0 = Let('v0', sc.g)
    const u1 = Let('u1', sc.b)
    const v1 = Let('v1', sc.a)
    const atlasUv = Let('atlas_uv', vec2(
      u0.add(uvLocal.x.mul(u1.sub(u0))),
      v0.add(uvLocal.y.mul(v1.sub(v0))),
    ))
    const sampled = Let('sampled', textureSample(sprite_atlas, sprite_samp, atlasUv))
    const rim = Let('rim', lineRimAlpha(p.input))
    const out = Var('out', structT('LineFragmentOutput'))
    assign(out.field('color', vec4fT), vec4(sampled.rgb, sampled.a.mul(base.a).mul(rim)))
    if (pickEnabled) assign(out.field('pick', vec2uT), vec2u(u32(0), u32(0)))
    assign(out.field('depth', f32T), callFn('compute_log_frag_depth', f32T, p.input.field('view_w', f32T), tile.field('log_depth_fc', f32T)))
    return out
  })

// Max-blend offscreen path: bare @location(0) vec4 return, no log-depth (the
// offscreen RT has no depth attachment).
const fsLineMax = entryFn(
  'fs_line_max', 'fragment',
  [{ name: 'input', type: structT('LineOut') }],
  vec4fT,
  (p, _b) => {
    const c = Var('c', vec4fT, computeLineColor(p.input))
    const rim = Let('rim', lineRimAlpha(p.input))
    assign(c.field('a', f32T), c.field('a', f32T).mul(rim))
    return c
  },
  '@location(0)',
)

// ── Module assembly ──

export const buildLineModule = (pickEnabled: boolean): ModuleDecl => module({
  structs: [
    TileUniforms, PatternSlot, LineLayer, LineSegment,
    ShapeDesc, ShapeSegment, LineOut, lineFragmentOutput(pickEnabled),
  ],
  bindings: [
    { group: 0, binding: 0, name: 'tile', space: 'uniform', type: structT('TileUniforms') },
    { group: 0, binding: 5, name: 'sprite_atlas', space: 'uniform', type: texture2dfT },
    { group: 0, binding: 6, name: 'sprite_samp', space: 'uniform', type: samplerT },
    { group: 1, binding: 0, name: 'layer', space: 'uniform', type: structT('LineLayer') },
    { group: 1, binding: 1, name: 'segments', space: 'storage', access: 'read', type: arrayT(structT('LineSegment')) },
    { group: 1, binding: 2, name: 'shapes', space: 'storage', access: 'read', type: arrayT(structT('ShapeDesc')) },
    { group: 1, binding: 3, name: 'shape_segments', space: 'storage', access: 'read', type: arrayT(structT('ShapeSegment')) },
  ],
  funcs: [
    lineEndpoint, finalizeCorner, endpointCosC, patternUnitToM, sdfShape,
    computeLineColor, lineRimAlpha, vsLine,
    buildFsLine(pickEnabled), buildFsLinePattern(pickEnabled), fsLineMax,
  ],
})

/** Full line shader: shared DSL-emitted projection consts + log-depth fns +
 *  projection fns + SDF distance/winding helpers, then the line module.
 *  `pickEnabled` toggles the pick attachment field + writes (replaces the old
 *  __PICK_FIELD__ / __PICK_WRITE__ regex markers). */
export const emitLineWgsl = (pickEnabled: boolean): string => [
  getProjectionWgslConsts(),
  LOG_DEPTH_WGSL_FNS,
  getProjectionWgslFns(),
  ECEF_WGSL_CONSTS,
  ECEF_WGSL_FNS,
  SDF_WGSL_DIST_TO_SEGMENT,
  SDF_WGSL_DIST_TO_QUADRATIC,
  SDF_WGSL_DIST_TO_CUBIC,
  SDF_WGSL_WINDING_LINE,
  emitModule(buildLineModule(pickEnabled)),
].join('\n')

// ── Compositor (fullscreen-triangle sampling the translucent offscreen RT) ──
//
// Standalone — different bind group + a single uniform (opacity). Pairs with
// pipelineMax in line-renderer.ts.

const CompUniform: StructDecl = {
  name: 'CompUniform',
  fields: [
    { name: 'opacity', type: f32T },
    { name: '_pad', type: vec3fT },
  ],
}

const VsFullOut: StructDecl = ioStruct('VsFullOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
}).decl

const compSamp = bindingRef('samp', samplerT)
const compSrc = bindingRef('src', texture2dfT)
const compCu = bindingRef('cu', structT('CompUniform'))

const vsFull = entryFn('vs_full', 'vertex',
  [{ name: 'vi', type: u32T, builtin: 'vertex_index' }],
  structT('VsFullOut'),
  (p, _b) => {
    const pos = Var('p', vec2fT, vec2(f32(-1), f32(-1)))
    const uv = Var('uv', vec2fT, vec2(f32(0), f32(1)))
    If(p.vi.eq(u32(1)), () => {
      assign(pos, vec2(f32(3), f32(-1)))
      assign(uv, vec2(f32(2), f32(1)))
    })
    If(p.vi.eq(u32(2)), () => {
      assign(pos, vec2(f32(-1), f32(3)))
      assign(uv, vec2(f32(0), f32(-1)))
    })
    const out = Var('out', structT('VsFullOut'))
    assign(out.field('pos', vec4fT), vec4(pos, f32(0), f32(1)))
    assign(out.field('uv', vec2fT), uv)
    return out
  },
)

const fsFull = entryFn('fs_full', 'fragment',
  [{ name: 'input', type: structT('VsFullOut') }],
  vec4fT,
  (p, _b) => {
    const c = Let('c', textureSample(compSrc, compSamp, p.input.field('uv', vec2fT)))
    const op = Let('op', compCu.field('opacity', f32T))
    // MAX-blend offscreen stores non-premultiplied (rgb, a_aa); premultiply here.
    return vec4(c.rgb.mul(c.a).mul(op), c.a.mul(op))
  },
  '@location(0)',
)

const compositeModule: ModuleDecl = module({
  structs: [CompUniform, VsFullOut],
  bindings: [
    { group: 0, binding: 0, name: 'samp', space: 'uniform', type: samplerT },
    { group: 0, binding: 1, name: 'src', space: 'uniform', type: texture2dfT },
    { group: 0, binding: 2, name: 'cu', space: 'uniform', type: structT('CompUniform') },
  ],
  funcs: [vsFull, fsFull],
})

/** Translucent-line compositor: fullscreen triangle that samples the max-blend
 *  offscreen RT and composites onto the main framebuffer with per-layer
 *  opacity. Pairs with pipelineMax in line-renderer.ts. */
export const emitCompositeWgsl = (): string => emitModule(compositeModule)
