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
// Pattern (raster sibling): emitLineWgsl(pickEnabled) MERGES the shared dependency
// decls (PROJECTION_CONSTS + ECEF_CONSTS + getGpuProjectionFuncs() + ECEF_FUNCS +
// log-depth + SDF dist/winding handles) into buildLineModule and emits ONE module —
// no WGSL-string prepend. vs/fs reach proj_globe / project / project_geom /
// inv_merc_lat_rad / needs_backface_cull / rim_alpha / apply_log_depth /
// compute_log_frag_depth / dist_to_segment / … by name; consts PI / DEG2RAD / EARTH_R.
//
// Bitwise IR ops (& | ^ << >>, added with the point shader) drive cap / join /
// flag / dash / anchor unpacking. The compositor shader (fullscreen-triangle
// sampling the offscreen RT) is emitted alongside via emitCompositeWgsl().

import {
  entryFn, fn, module, constRef, transformMat4,
  f32, i32, u32, toF32, vec2, vec3, vec4, vec2u, clamp, fract, sign,
  length, dot, min, max, smoothstep, abs, floor, select, textureSample,
  bitcastU32, unpack4x8unorm,
  atan, exp,
  If, ifExpr, Loop, Let, Var, Continue, Break, Discard, assign, assignOp, madd, outsideRange,
  Return, ReturnIf, Switch,
  f32T, u32T, i32T, vec2fT, vec3fT, vec4fT, vec2uT, mat4x4fT, texture2dfT, samplerT,
  arrayT,
  type Node,
  type ModuleDecl,
} from '../core/ir'
import { ioStruct, builtin, location, uniformStruct, structDecl, storageBuffer, resource } from '../core/sot'
import { emitModule } from '../core/backends/wgsl'
import { inv_merc_lat_rad, flat_rel, needs_backface_cull, rim_alpha, PROJECTION_CONSTS, getGpuProjectionFuncs } from './projections'
import { ECEF_CONSTS, ECEF_FUNCS, lonlatToEcef } from './ecef'
import { apply_log_depth, compute_log_frag_depth } from './log-depth'
import {
  dist_to_segment,
  dist_to_quadratic,
  dist_to_cubic,
  winding_line,
} from './sdf'

// Round-join acute-fold threshold on |prevTan + dir| (unit vectors → length is
// 2·sin(interiorAngle/2)). 0.6 ⇒ interior angle ≲ 35°, well clear of normal road
// bends (60° corner = 1.0, right angle = 1.41, straight = 2.0); see #413.
const JOIN_ACUTE_BIS = 0.6

// ── Struct declarations ──

const TILE = uniformStruct('TileUniforms', { group: 0, binding: 0, as: 'tile' }, {
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
  mvp: mat4x4fT,
  fill_color: vec4fT,
  stroke_color: vec4fT,
  proj_params: vec4fT,
  // DSFUN camera offset in tile-local Mercator meters, split high/low.
  cam_h: vec2fT,
  cam_l: vec2fT,
  tile_origin_merc: vec2fT,
  opacity: f32T,
  // Log-depth factor: 1.0 / log2(cam_far + 1.0). Reuses the old DSFUN _pad0.
  log_depth_fc: f32T,
  // Trailing pads mirror the polygon Uniforms tail. The line shader only
  // reads outline_z_lift_m — the others are padding so the WGSL struct
  // lines up with the shared 192-byte uniform block.
  _pad_pick: u32T,
  _pad_layer_offset: f32T,
  tile_extent_m: f32T,
  outline_z_lift_m: f32T,
  // Per-tile clip mask in absolute Mercator meters (west, south, east, north).
  clip_bounds: vec4fT,
  // Pad to mirror polygon Uniforms offsets 44..51 (zoom / extrude_base /
  // fill_translate xy / tile_dequant scale+half) so the shared VTR uniform
  // slot's cam_ecef_off lands at the SAME byte offset (f32 52/56) for both
  // the line and polygon shaders. The line VS doesn't read these pads.
  _pad_tail0: vec4fT,
  _pad_tail1: vec4fT,
  // Camera-relative RTC (ECEF): tileEcefCenter(WGS84 ellipsoid) −
  // cameraCenter(sphere), DSFUN hi/lo. VTR writes this per tile at f32
  // 52-54 / 56-58 (recordTileFill). The line VS adds it to ecef_rtc so
  // strokes project vertex−cameraCenter through the camera-at-ENU-origin
  // MVP — the same fix as polygon's cam_ecef_off (fixes the line↔fill
  // position mismatch, since line was projecting vertex−tileEcefCenter).
  cam_ecef_off_h: vec4fT,
  cam_ecef_off_l: vec4fT,
})

const PatternSlot = structDecl('PatternSlot', {
  id: u32T,
  flags: u32T,
  spacing: f32T,
  size: f32T,
  offset: f32T,
  start_offset: f32T,
  _pad0: f32T,
  _pad1: f32T,
})

const LAYER = uniformStruct('LineLayer', { group: 1, binding: 0, as: 'layer' }, {
  color: vec4fT,
  width_px: f32T,
  aa_width_px: f32T,
  mpp: f32T,
  miter_limit: f32T,
  // cap(0-1) | join(2-3) | dash_enable(4) | has_pattern(6) | has_offset(7)
  flags: u32T,
  dash_count: u32T,
  dash_cycle_m: f32T,
  dash_offset_m: f32T,
  dash_array: arrayT(vec4fT, 2),
  patterns: arrayT(PatternSlot.type, 3),
  offset_m: f32T,
  viewport_height: f32T,
  // Device-pixel ratio. The screen-width clamp (vs_line) divides the
  // pixel target by viewport_height (DEVICE px) but the width target is
  // in CSS px, so it must be scaled by dpr to land on the right NDC span.
  dpr: f32T,
  // Mapbox line-translate viewport offset — NDC-per-pixel, pre-baked
  // by the runtime baker (px * 2 / canvasDim). Applied post-MVP in
  // vs_line: clip.x += layer.line_translate_x * clip.w (mirrors
  // fill-translate's per-tile uniform path). Default 0 = no-op.
  line_translate_x: f32T,
  line_translate_y: f32T,
  // Mapbox line-round-limit (0 = use the historical JOIN_ACUTE_BIS fold
  // constant, byte-identical default; >0 scales the fold threshold).
  round_limit: f32T,
  _pad_e: f32T,
})

const LineSegment = structDecl('LineSegment', {
  // DSFUN endpoint pairs in tile-local Mercator meters.
  p0_h: vec2fT,
  p1_h: vec2fT,
  p0_l: vec2fT,
  p1_l: vec2fT,
  prev_tangent: vec2fT,
  next_tangent: vec2fT,
  arc_start: f32T,
  line_length: f32T,
  // Per-endpoint quad pad ratios (multiples of half_w).
  pad_ratio_p0: f32T,
  pad_ratio_p1: f32T,
  // Per-segment 3D extrude height in metres.
  z_lift_m: f32T,
  // Per-segment stroke width override (px). 0 = use layer.width_px.
  width_px_override: f32T,
  // Per-segment stroke colour override (RGBA8 packed in an f32 slot;
  // shader bit-casts to u32 + unpack4x8unorm). Alpha=0 → use layer.color.
  color_packed: f32T,
  _pad19: f32T,
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

const ShapeSegment = structDecl('ShapeSegment', {
  kind: u32T,
  color_idx: u32T,
  flags: u32T,
  _pad: u32T,
  p0: vec2fT,
  p1: vec2fT,
  p2: vec2fT,
  p3: vec2fT,
})

const LineOut = ioStruct('LineOut', {
  position: builtin('position', vec4fT),
  world_local: location(0, vec2fT),
  seg_id: location(1, u32T, 'flat'),
  view_w: location(2, f32T),
  cos_c: location(3, f32T),
})

const lineFragmentOutput = (pickEnabled: boolean) => ioStruct('LineFragmentOutput', {
  color: location(0, vec4fT),
  ...(pickEnabled ? { pick: location(1, vec2uT, 'flat') } : {}),
  depth: builtin('frag_depth', f32T),
})

// ── Binding refs ──

const segmentsB = storageBuffer('segments', arrayT(LineSegment.type), { group: 1, binding: 1, access: 'read' })
const segments = segmentsB.node
const shapesB = storageBuffer('shapes', arrayT(ShapeDesc.type), { group: 1, binding: 2, access: 'read' })
const shapes = shapesB.node
const shapeSegmentsB = storageBuffer('shape_segments', arrayT(ShapeSegment.type), { group: 1, binding: 3, access: 'read' })
const shape_segments = shapeSegmentsB.node
const spriteAtlasB = resource('sprite_atlas', texture2dfT, { group: 0, binding: 5 })
const sprite_atlas = spriteAtlasB.node
const spriteSampB = resource('sprite_samp', samplerT, { group: 0, binding: 6 })
const sprite_samp = spriteSampB.node

// ── Helper fns ──

const lineEndpoint = fn('line_endpoint', { p_h: vec2fT, p_l: vec2fT }, vec2fT, (p) => {
  const projParams = TILE.field.proj_params
  // single-exit: Mercator (proj<0.5) subtracts the camera; else hi+lo. select() is
  // branchless — both arms are pure reads, computing both is free of side effects.
  const mercRel = p.p_h.sub(TILE.field.cam_h).add(p.p_l.sub(TILE.field.cam_l))
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
const finalizeCorner = fn('finalize_corner', { corner: vec2fT }, vec2fT, (p) => {
  const projParams = TILE.field.proj_params
  const tileOrigin = TILE.field.tile_origin_merc
  const absMerc = p.corner.add(tileOrigin)
  const absLon = absMerc.x.div(constRef('DEG2RAD').mul(constRef('EARTH_R')))
  const latRad = inv_merc_lat_rad(absMerc.y)
  const absLat = latRad.div(constRef('DEG2RAD'))
  const tileRefLon = tileOrigin.x.add(f32(0.5).mul(TILE.field.tile_extent_m))
      .div(constRef('DEG2RAD').mul(constRef('EARTH_R')))
  // single-exit: Mercator (proj<0.5) passes the corner through; else the reprojected
  // flat_rel. flat_rel is pure, so computing it on the Mercator path (selected away) is harmless.
  const flatRel = flat_rel(absLon, absLat, projParams, tileRefLon)
  return select(projParams.x.lt(0.5), p.corner, flatRel)
})

const endpointCosC = fn('endpoint_cos_c', { p_h: vec2fT, p_l: vec2fT }, f32T, (p) => {
  const tileOrigin = TILE.field.tile_origin_merc
  const absMercX = p.p_h.x.add(p.p_l.x).add(tileOrigin.x)
  const absMercY = p.p_h.y.add(p.p_l.y).add(tileOrigin.y)
  const absLon = absMercX.div(constRef('DEG2RAD').mul(constRef('EARTH_R')))
  const latRad = inv_merc_lat_rad(absMercY)
  const absLat = latRad.div(constRef('DEG2RAD'))
  return needs_backface_cull(absLon, absLat, TILE.field.proj_params)
})

const patternUnitToM = fn('pattern_unit_to_m', { v: f32T, unit: u32T, mpp: f32T }, f32T, (p) => {
  // single-exit, 0=m 1=px 2=km 3=nm — nested select from the default (nm) up.
  const km = select(p.unit.eq(u32(2)), p.v.mul(1000), p.v.mul(1852))
  const px = select(p.unit.eq(u32(1)), p.v.mul(p.mpp), km)
  return select(p.unit.eq(u32(0)), p.v, px)
})

// Inlined SDF shape sampler — uses our `shape_segments` (binding 3) instead
// of the shared SDF module's `segments` name (which would collide with the
// line segment storage buffer on binding 1).
const sdfShape = fn('sdf_shape', { uv_in: vec2fT, shape_id: u32T }, f32T, (p) => {
  const uv = vec2(p.uv_in.x, p.uv_in.y.neg())
  const s = shapes.at(p.shape_id, ShapeDesc.type)
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
  const end = min(segStart.add(segCount), segStart.add(u32(32)))
  Loop('i', segStart, (i) => i.lt(end), (i) => {
    const seg = shape_segments.at(i, ShapeSegment.type)
    const p0 = seg.field('p0', vec2fT)
    const p1 = seg.field('p1', vec2fT)
    const p2 = seg.field('p2', vec2fT)
    const p3 = seg.field('p3', vec2fT)
    Switch(seg.field('kind', u32T), [
      [0, () => {
        assign(minDist, min(minDist, dist_to_segment(uv, p0, p1)))
        assignOp(winding, '+', winding_line(uv, p0, p1))
      }],
      [1, () => {
        assign(minDist, min(minDist, dist_to_quadratic(uv, p0, p1, p2)))
        assignOp(winding, '+', winding_line(uv, p0, p2))
      }],
      [2, () => {
        assign(minDist, min(minDist, dist_to_cubic(uv, p0, p1, p2, p3)))
        assignOp(winding, '+', winding_line(uv, p0, p3))
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
const computeLineColor = fn('compute_line_color', { input: LineOut.type }, vec4fT, (p) => {
  const projParams = TILE.field.proj_params
  const tileOrigin = TILE.field.tile_origin_merc
  const clipBounds = TILE.field.clip_bounds

  // Backface cull on non-Mercator (helper short-circuits to +1 for flat).
  If(projParams.x.ge(0.5), () => {
    const absMerc = p.input.field('world_local', vec2fT).add(tileOrigin)
    const absLon = absMerc.x.div(constRef('DEG2RAD').mul(constRef('EARTH_R')))
    const latRad = inv_merc_lat_rad(absMerc.y)
    const absLat = latRad.div(constRef('DEG2RAD'))
    If(needs_backface_cull(absLon, absLat, projParams).lt(0), () => { Discard() })
  })

  // Per-tile clip mask (sentinel -1e30 skips). Reconstruct absolute Mercator
  // depending on projection — Mercator branch is cam-relative, non-Merc is
  // tile-local source Mercator.
  const clipValid = clipBounds.x.gt(-1e29)
      .and(clipBounds.z.gt(clipBounds.x))
      .and(clipBounds.w.gt(clipBounds.y))
  If(clipValid, () => {
    const camOffset = select(
        projParams.x.lt(0.5),
        TILE.field.cam_h.add(TILE.field.cam_l),
        vec2(f32(0), f32(0)),
      )
    const absMercClip = p.input.field('world_local', vec2fT).add(camOffset).add(tileOrigin)
    If(absMercClip.x.lt(clipBounds.x), () => { Discard() })
    If(absMercClip.x.gt(clipBounds.z), () => { Discard() })
    If(absMercClip.y.lt(clipBounds.y), () => { Discard() })
    If(absMercClip.y.gt(clipBounds.w), () => { Discard() })
  })

  const seg = segments.at(p.input.field('seg_id', u32T), LineSegment.type)
  const segP = p.input.field('world_local', vec2fT)
  const p0 = lineEndpoint(seg.field('p0_h', vec2fT), seg.field('p0_l', vec2fT))
  const p1 = lineEndpoint(seg.field('p1_h', vec2fT), seg.field('p1_l', vec2fT))

  // Segment direction / normal in tile-local meters.
  const segVec = p1.sub(p0)
  const segLen = length(segVec)
  const dir = ifExpr('dir', vec2fT, segLen.lt(1e-6), () => vec2(f32(1), f32(0)), () => segVec.div(segLen))

  // Per-segment width override falls through to layer.width_px when 0.
  const layerWidthPx = LAYER.field.width_px
  const layerMpp = LAYER.field.mpp
  const layerOffsetM = LAYER.field.offset_m
  const layerFlags = LAYER.field.flags
  const segWidthOv = seg.field('width_px_override', f32T)
  const effectiveWidthPx = select(segWidthOv.gt(0), segWidthOv, layerWidthPx)
  const halfWm = effectiveWidthPx.mul(0.5).mul(layerMpp)

  // 1. Main body distance.
  const nrmLine = Let('nrm_line', vec2(dir.y.neg(), dir.x))
  const signedPerp = dot(segP.sub(p0), nrmLine)
  const perpM = abs(signedPerp.sub(layerOffsetM))
  const bodyD = perpM.sub(halfWm)

  // Offset-shifted endpoint cap centres + miter-shifted join centres.
  const p0CapCenter = p0.add(nrmLine.mul(layerOffsetM))
  const p1CapCenter = p1.add(nrmLine.mul(layerOffsetM))

  const prevTan = seg.field('prev_tangent', vec2fT)
  const nextTan = seg.field('next_tangent', vec2fT)

  const nrmPrevOff = vec2(prevTan.y.neg(), prevTan.x)
  const miterVecP0 = nrmLine.add(nrmPrevOff)
  const projP0 = dot(miterVecP0, nrmLine)
  const p0JoinCenter = p0.add(miterVecP0.mul(layerOffsetM.div(max(projP0, f32(1e-4)))))

  const nrmNextOff = vec2(nextTan.y.neg(), nextTan.x)
  const miterVecP1 = nrmLine.add(nrmNextOff)
  const projP1 = dot(miterVecP1, nrmLine)
  const p1JoinCenter = p1.add(miterVecP1.mul(layerOffsetM.div(max(projP1, f32(1e-4)))))

  // Endpoint along-axis distances (negative on the segment interior).
  const distP0Vs = Let('dist_p0_vs', dot(segP.sub(p0), dir).neg())
  const distP1Vs = Let('dist_p1_vs', dot(segP.sub(p1), dir))

  // Early-discard guard: outside the body AND inside segment range.
  const patExtentFs = Var('pat_extent_fs', f32T, f32(0))
  If(layerFlags.bitAnd(u32(64)).ne(u32(0)), () => {
    Loop('pk_fs', u32(0), (pk) => pk.lt(u32(3)), (pk) => {
      const patFs = LAYER.field.patterns.at(pk, PatternSlot.type)
      If(patFs.field('id', u32T).eq(u32(0)), () => { Continue() })
      const szUnit = patFs.field('flags', u32T).shr(u32(2)).bitAnd(u32(3))
      const ofUnit = patFs.field('flags', u32T).shr(u32(4)).bitAnd(u32(3))
      const sizeM = patternUnitToM(patFs.field('size', f32T), szUnit, layerMpp)
      const offM = abs(patternUnitToM(patFs.field('offset', f32T), ofUnit, layerMpp))
      assign(patExtentFs, max(patExtentFs, sizeM.mul(0.5).add(offM)))
    })
  })
  const aaMarginM = f32(2).mul(LAYER.field.aa_width_px).mul(layerMpp)
  const earlyPerpThresh = Let('early_perp_thresh', max(halfWm, patExtentFs).add(aaMarginM))
  If(perpM.gt(earlyPerpThresh).and(distP0Vs.lt(0)).and(distP1Vs.lt(0)), () => { Discard() })

  // 2. Cap/join feasibility flags + cap-type extraction.
  const hasPrev = length(prevTan).gt(0.001)
  const hasNext = length(nextTan).gt(0.001)
  const capType = layerFlags.bitAnd(u32(7))
  const arrowL = halfWm.mul(4)

  // Aliases (the original WGSL re-binds these via `let dist_p0 = dist_p0_vs;`).
  const distP0 = distP0Vs
  const distP1 = distP1Vs

  const dM = Var('d_m', f32T, bodyD)

  const joinFlags = layerFlags.shr(u32(3)).bitAnd(u32(3))
  const layerMiterLimit = LAYER.field.miter_limit
  // Mapbox line-round-limit → per-layer round-join fold threshold. The
  // uniform carries the raw limit (default 1.05); 0 means "no override"
  // and the shader keeps its historical JOIN_ACUTE_BIS constant exactly,
  // so a layer that doesn't author line-round-limit is byte-identical.
  // A positive value scales the fold threshold by round_limit / 1.05,
  // so the spec default 1.05 also reproduces JOIN_ACUTE_BIS (1.05/1.05=1).
  const layerRoundLimit = LAYER.field.round_limit
  const acuteFoldBis = select(layerRoundLimit.gt(f32(0)),
      f32(JOIN_ACUTE_BIS).mul(layerRoundLimit.div(f32(1.05))),
      f32(JOIN_ACUTE_BIS))

  // ── Bisector clip + bevel-edge clip at p0 ──
  If(hasPrev, () => {
    const bisP0 = Let('bis_p0', prevTan.add(dir))
    const bisLenP0 = length(bisP0)
    If(bisLenP0.gt(1e-6), () => {
      const bisUnitP0 = bisP0.div(bisLenP0)
      const alongP0 = dot(segP.sub(p0JoinCenter), bisUnitP0)
      If(alongP0.lt(0), () => {
        assign(dM, max(dM, alongP0.neg().add(layerMpp)))
      })
    })
    // BEVEL / over-limit MITER edge clip at p0. Bevel when miter ratio
    // 1/cos(θ/2) > limit ⇒ bisMag = 2cos(θ/2) < 2/limit (#432; was sin, wrong).
    const bisMagP0 = Let('bis_mag_p0', length(prevTan.add(dir)))
    const miterOverP0 = bisMagP0.lt(f32(2).div(max(layerMiterLimit, f32(1e-4))))
    const applyBevelP0 = joinFlags.eq(u32(2)).or(joinFlags.eq(u32(0)).and(miterOverP0))
    If(applyBevelP0, () => {
      const prevNrm = vec2(prevTan.y.neg(), prevTan.x)
      const crossP0 = Let('cross_p0', prevTan.x.mul(dir.y).sub(prevTan.y.mul(dir.x)))
      If(abs(crossP0).gt(1e-6), () => {
        const s0 = sign(crossP0).neg()
        const oc0 = p0.add(prevNrm.mul(layerOffsetM.add(halfWm.mul(s0))))
        const on0 = p0.add(nrmLine.mul(layerOffsetM.add(halfWm.mul(s0))))
        const be0 = on0.sub(oc0)
        const bl0 = length(be0)
        If(bl0.gt(1e-6), () => {
          const bd0 = be0.div(bl0)
          const bo0 = vec2(bd0.y.neg(), bd0.x).mul(s0)
          const bclip0 = dot(segP.sub(oc0), bo0)
          If(bclip0.gt(0), () => { assign(dM, max(dM, bclip0)) })
        })
      })
    })
  })

  // ── Bisector clip + bevel-edge clip at p1 ──
  If(hasNext, () => {
    const bisP1 = Let('bis_p1', dir.add(nextTan))
    const bisLenP1 = length(bisP1)
    If(bisLenP1.gt(1e-6), () => {
      const bisUnitP1 = bisP1.div(bisLenP1)
      const alongP1 = dot(segP.sub(p1JoinCenter), bisUnitP1)
      If(alongP1.gt(0), () => {
        assign(dM, max(dM, alongP1.add(layerMpp)))
      })
    })
    // Bevel when miter ratio 1/cos(θ/2) > limit ⇒ bisMag < 2/limit (#432).
    const bisMagP1 = Let('bis_mag_p1', length(dir.add(nextTan)))
    const miterOverP1 = bisMagP1.lt(f32(2).div(max(layerMiterLimit, f32(1e-4))))
    const applyBevelP1 = joinFlags.eq(u32(2)).or(joinFlags.eq(u32(0)).and(miterOverP1))
    If(applyBevelP1, () => {
      const nextNrmBv = vec2(nextTan.y.neg(), nextTan.x)
      const crossP1 = Let('cross_p1', dir.x.mul(nextTan.y).sub(dir.y.mul(nextTan.x)))
      If(abs(crossP1).gt(1e-6), () => {
        const s1 = sign(crossP1).neg()
        const oc1 = p1.add(nrmLine.mul(layerOffsetM.add(halfWm.mul(s1))))
        const on1 = p1.add(nextNrmBv.mul(layerOffsetM.add(halfWm.mul(s1))))
        const be1 = on1.sub(oc1)
        const bl1 = length(be1)
        If(bl1.gt(1e-6), () => {
          const bd1 = be1.div(bl1)
          const bo1 = vec2(bd1.y.neg(), bd1.x).mul(s1)
          const bclip1 = dot(segP.sub(oc1), bo1)
          If(bclip1.gt(0), () => { assign(dM, max(dM, bclip1)) })
        })
      })
    })
  })

  // ── Handle p0 end (cap or join) ──
  // The DSL bool API has no `.not`, so the original `!has_prev` / `!has_next`
  // gates are recomputed positively as `length(tangent) <= eps`.
  const noPrev = length(prevTan).le(0.001)
  const noNext = length(nextTan).le(0.001)

  If(noPrev, () => {
    // CAP_BUTT
    If(capType.eq(u32(0)), () => { assign(dM, max(dM, distP0)) })
      .elif(capType.eq(u32(2)), () => { assign(dM, max(dM, distP0.sub(halfWm))) })
      .elif(capType.eq(u32(3)), () => {
        // CAP_ARROW: analytical tapered half-width.
        If(distP0.gt(0), () => {
          const t = clamp(distP0.div(arrowL), 0, 1)
          const newW = halfWm.mul(f32(1).sub(t))
          assign(dM, max(perpM.sub(newW), distP0.sub(arrowL)))
        })
      })
      .else(() => {
        // CAP_ROUND
        const circleD = length(segP.sub(p0CapCenter)).sub(halfWm)
        assign(dM, select(distP0.gt(0), circleD, dM))
      })
  }).else(() => {
    // JOIN at p0 — round-join overlay; gated by forward bisector.
    const joinType = layerFlags.shr(u32(3)).bitAnd(u32(3))
    If(joinType.eq(u32(1)).and(distP0.gt(0)), () => {
      const bisP0j = Let('bis_p0_j', prevTan.add(dir))
      const bisLenJ = length(bisP0j)
      // Acute fold → full round point (ML parity); moderate bends keep the
      // half-plane. #413; see JOIN_ACUTE_BIS + the select() combine below.
      const acuteFoldP0 = bisLenJ.le(acuteFoldBis)
      const bisUnitJ = bisP0j.div(max(bisLenJ, f32(1e-6)))
      const alongJ = dot(segP.sub(p0JoinCenter), bisUnitJ)
      If(acuteFoldP0.or(alongJ.ge(0)), () => {
        const circleD = length(segP.sub(p0JoinCenter)).sub(halfWm)
        const alongExtendP0 = abs(layerOffsetM).mul(seg.field('pad_ratio_p0', f32T))
        const currentD = Var('current_d', f32T, dM)
        If(distP0.gt(alongExtendP0), () => {
          assign(currentD, max(dM, distP0.sub(alongExtendP0)))
        })
        const prevNrm = vec2(prevTan.y.neg(), prevTan.x)
        const prevSignedPerp = dot(segP.sub(p0), prevNrm)
        const prevPerpM = abs(prevSignedPerp.sub(layerOffsetM))
        const neighborD = Var('neighbor_d', f32T, prevPerpM.sub(halfWm))
        const alongPastPrevEnd = dot(segP.sub(p0), prevTan)
        If(alongPastPrevEnd.gt(alongExtendP0), () => {
          assign(neighborD, max(neighborD, alongPastPrevEnd.sub(alongExtendP0)))
        })
        // Acute fold → pure round-point union (no carve); else original combine.
        assign(dM, min(circleD, select(acuteFoldP0, dM, min(currentD, neighborD))))
      })
    })
  })

  // ── Handle p1 end (cap or join) — symmetric ──
  If(noNext, () => {
    If(capType.eq(u32(0)), () => { assign(dM, max(dM, distP1)) })
      .elif(capType.eq(u32(2)), () => { assign(dM, max(dM, distP1.sub(halfWm))) })
      .elif(capType.eq(u32(3)), () => {
        If(distP1.gt(0), () => {
          const t = clamp(distP1.div(arrowL), 0, 1)
          const newW = halfWm.mul(f32(1).sub(t))
          assign(dM, max(perpM.sub(newW), distP1.sub(arrowL)))
        })
      })
      .else(() => {
        const circleD = length(segP.sub(p1CapCenter)).sub(halfWm)
        assign(dM, select(distP1.gt(0), circleD, dM))
      })
  }).else(() => {
    const joinTypeP1 = layerFlags.shr(u32(3)).bitAnd(u32(3))
    If(joinTypeP1.eq(u32(1)).and(distP1.gt(0)), () => {
      const bisP1j = Let('bis_p1_j', dir.add(nextTan))
      const bisLenJ = length(bisP1j)
      const acuteFoldP1 = bisLenJ.le(acuteFoldBis) // #413, mirrors p0; threshold scaled by line-round-limit
      const bisUnitJ = bisP1j.div(max(bisLenJ, f32(1e-6)))
      const alongJ = dot(segP.sub(p1JoinCenter), bisUnitJ)
      If(acuteFoldP1.or(alongJ.le(0)), () => {
        const circleD = length(segP.sub(p1JoinCenter)).sub(halfWm)
        const alongExtendP1 = abs(layerOffsetM).mul(seg.field('pad_ratio_p1', f32T))
        const currentD = Var('current_d', f32T, dM)
        If(distP1.gt(alongExtendP1), () => {
          assign(currentD, max(dM, distP1.sub(alongExtendP1)))
        })
        const nextNrm = vec2(nextTan.y.neg(), nextTan.x)
        const nextSignedPerp = dot(segP.sub(p1), nextNrm)
        const nextPerpM = abs(nextSignedPerp.sub(layerOffsetM))
        const neighborD = Var('neighbor_d', f32T, nextPerpM.sub(halfWm))
        const alongIntoNext = dot(segP.sub(p1), nextTan)
        If(alongIntoNext.lt(alongExtendP1.neg()), () => {
          assign(neighborD, max(neighborD, alongIntoNext.neg().sub(alongExtendP1)))
        })
        assign(dM, min(circleD, select(acuteFoldP1, dM, min(currentD, neighborD))))
      })
    })
  })

  // Project fragment along segment axis (shared by dash + patterns).
  const tAlongUnclamped = Let('t_along_unclamped', dot(segP.sub(p0), dir))
  const tAlong = clamp(tAlongUnclamped, 0, segLen)
  const arcPos = seg.field('arc_start', f32T).add(tAlong)
  const nrmFs = Let('nrm_fs', vec2(dir.y.neg(), dir.x))

  // ── Dash array ──
  // notInCap = !(noPrev && distP0>0 || noNext && distP1>0)
  //         =  (hasPrev || distP0<=0) && (hasNext || distP1<=0)
  // — boolean DSL has no `.not`, so the original `!in_cap_region` gate is
  // emitted as the De Morgan-converted positive form.
  const notInCap = hasPrev.or(distP0.le(0)).and(hasNext.or(distP1.le(0)))
  const dashCount = LAYER.field.dash_count
  const dashCycleM = LAYER.field.dash_cycle_m
  const dashOffsetM = LAYER.field.dash_offset_m
  const dashEnabled = layerFlags.shr(u32(5)).bitAnd(u32(1)).eq(u32(1))
      .and(dashCount.gt(u32(0)))
      .and(dashCycleM.gt(1e-6))
      .and(notInCap)
  If(dashEnabled, () => {
    const phase0 = arcPos.add(dashOffsetM).div(dashCycleM)
    const phase = Var('phase', f32T, phase0.sub(floor(phase0)).mul(dashCycleM))
    const acc = Var('acc', f32T, f32(0))
    const visible = Var('visible', f32T, f32(0)) // 0=hidden, 1=visible — bool via f32
    Loop('i', u32(0), (i) => i.lt(dashCount), (i) => {
      const idx = i.div(u32(4))
      const sub = i.mod(u32(4))
      const segV = LAYER.field.dash_array.at(idx, vec4fT)
      const lenV = Var('len', f32T, f32(0))
      If(sub.eq(u32(0)), () => { assign(lenV, segV.x) })
        .elif(sub.eq(u32(1)), () => { assign(lenV, segV.y) })
        .elif(sub.eq(u32(2)), () => { assign(lenV, segV.z) })
        .else(() => { assign(lenV, segV.w) })
      If(phase.ge(acc).and(phase.lt(acc.add(lenV))), () => {
        assign(visible, select(i.bitAnd(u32(1)).eq(u32(0)), f32(1), f32(0)))
        Break()
      })
      assign(acc, acc.add(lenV))
    })
    If(visible.lt(0.5), () => { Discard() })
  })

  // ── Pattern stack ──
  const patDm = Var('pat_d_m', f32T, f32(1e10))
  If(layerFlags.bitAnd(u32(64)).ne(u32(0)), () => {
    Loop('k', u32(0), (k) => k.lt(u32(3)), (k) => {
      const pat = LAYER.field.patterns.at(k, PatternSlot.type)
      If(pat.field('id', u32T).eq(u32(0)), () => { Continue() })

      const patF = pat.field('flags', u32T)
      const spUnit = patF.bitAnd(u32(3))
      const szUnit = patF.shr(u32(2)).bitAnd(u32(3))
      const ofUnit = patF.shr(u32(4)).bitAnd(u32(3))
      const anchor = patF.shr(u32(6)).bitAnd(u32(3))
      const spacingM = max(patternUnitToM(pat.field('spacing', f32T), spUnit, layerMpp), f32(1e-3))
      const sizeM = max(patternUnitToM(pat.field('size', f32T), szUnit, layerMpp), f32(1e-3))
      const offM = patternUnitToM(pat.field('offset', f32T), ofUnit, layerMpp)
      const startM = pat.field('start_offset', f32T)
      const halfS = sizeM.mul(0.5)

      // CANARY (C2 readability): the ambient free-function surface — If/Loop/Let/
      // Continue/assign route to the innermost scope, so no cb/d/cb2/e param
      // threading; the composite helpers (madd / outsideRange) name the arithmetic.
      // Emits byte-identically to the old passed-builder form (verified).
      If(anchor.eq(u32(0)), () => {
        // PAT_ANCHOR_REPEAT — sample nearest instance + both neighbours.
        const kCenter = floor(arcPos.sub(startM).div(spacingM).add(0.5))
        Loop('dk', i32(-1), (idk) => idk.le(i32(1)), (dk) => {
          const centerArcK = madd(kCenter.add(toF32(dk)), spacingM, startM)
          const arcOnSegK = centerArcK.sub(seg.field('arc_start', f32T))
          If(outsideRange(arcOnSegK, halfS.mul(-2), segLen.add(halfS.mul(2))), () => Continue())
          const centerWorldK = Let('center_world_k', p0.add(dir.mul(arcOnSegK)))
          const localK = Let('local_k', vec2(
            dot(segP.sub(centerWorldK), dir).div(halfS),
            dot(segP.sub(centerWorldK), nrmFs).sub(offM).div(halfS),
          ))
          If(abs(localK.x).gt(1.2).or(abs(localK.y).gt(1.2)), () => Continue())
          const shapeVK = sdfShape(localK, pat.field('id', u32T).sub(u32(1)))
          const pdK = shapeVK.sub(1).mul(halfS)
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

      const shapeV = sdfShape(localUv, pat.field('id', u32T).sub(u32(1)))
      const pd = shapeV.sub(1).mul(halfS)
      assign(patDm, min(patDm, pd))
    })
  })
  If(patDm.lt(1e9), () => { assign(dM, min(dM, patDm)) })

  // Convert to pixels + line-blur AA.
  const dPx = Let('d_px', dM.div(layerMpp))
  const blurPx = max(f32(0), LAYER.field.aa_width_px.sub(1))
  const aa = f32(0.5).add(blurPx)
  const alpha = f32(1).sub(smoothstep(aa.neg(), aa, dPx))
  If(alpha.lt(0.005), () => Discard())

  // Per-segment stroke colour override.
  const segPacked = bitcastU32(seg.field('color_packed', f32T))
  const segColor = unpack4x8unorm(segPacked)
  const baseColor = select(segColor.a.gt(0), segColor, LAYER.field.color)
  return vec4(baseColor.rgb, baseColor.a.mul(alpha))
})

// ── line_rim_alpha ──
const lineRimAlpha = fn('line_rim_alpha', { input: LineOut.type }, f32T, (p) => {
  const tileOrigin = TILE.field.tile_origin_merc
  const absMerc = p.input.field('world_local', vec2fT).add(tileOrigin)
  const absLon = absMerc.x.div(constRef('DEG2RAD').mul(constRef('EARTH_R')))
  const latRad = inv_merc_lat_rad(absMerc.y)
  const absLat = latRad.div(constRef('DEG2RAD'))
  return rim_alpha(absLon, absLat, TILE.field.proj_params)
})

// ── vs_line ──

const vsLine = entryFn('vs_line', 'vertex', [
  { name: 'seg_id', type: u32T, builtin: 'instance_index' },
  { name: 'vi', type: u32T, builtin: 'vertex_index' },
], LineOut.type, (p) => {
  const seg = segments.at(p.seg_id, LineSegment.type)
  const p0 = lineEndpoint(seg.field('p0_h', vec2fT), seg.field('p0_l', vec2fT))
  const p1 = lineEndpoint(seg.field('p1_h', vec2fT), seg.field('p1_l', vec2fT))

  const segVec = p1.sub(p0)
  const segLen = length(segVec)
  const dir = ifExpr('dir', vec2fT, segLen.lt(1e-6), () => vec2(f32(1), f32(0)), () => segVec.div(segLen))
  const nrm = Let('nrm', vec2(dir.y.neg(), dir.x))

  const layerWidthPx = LAYER.field.width_px
  const layerMpp = LAYER.field.mpp
  const layerAaPx = LAYER.field.aa_width_px
  const layerOffsetM = LAYER.field.offset_m
  const layerFlags = LAYER.field.flags
  const layerVpH = LAYER.field.viewport_height
  const layerDpr = LAYER.field.dpr

  const segWidthOv = seg.field('width_px_override', f32T)
  const effectiveWidthPx = select(segWidthOv.gt(0), segWidthOv, layerWidthPx)
  const halfWm = effectiveWidthPx.mul(0.5).add(layerAaPx).mul(layerMpp)

  // Per-endpoint pad ratios (precomputed CPU side).
  const padP0m = Var('pad_p0_m', f32T, seg.field('pad_ratio_p0', f32T).mul(halfWm))
  const padP1m = Var('pad_p1_m', f32T, seg.field('pad_ratio_p1', f32T).mul(halfWm))

  // Pattern extent scan.
  const patExtentM = Var('pat_extent_m', f32T, f32(0))
  If(layerFlags.bitAnd(u32(64)).ne(u32(0)), () => {
    Loop('pk', u32(0), (pk) => pk.lt(u32(3)), (pk) => {
      const pat = LAYER.field.patterns.at(pk, PatternSlot.type)
      If(pat.field('id', u32T).eq(u32(0)), () => { Continue() })
      const szUnit = pat.field('flags', u32T).shr(u32(2)).bitAnd(u32(3))
      const offUnit = pat.field('flags', u32T).shr(u32(4)).bitAnd(u32(3))
      const sizeM = patternUnitToM(pat.field('size', f32T), szUnit, layerMpp)
      const offM = abs(patternUnitToM(pat.field('offset', f32T), offUnit, layerMpp))
      assign(patExtentM, max(patExtentM, sizeM.mul(0.5).add(offM)))
    })
  })

  // Arrow cap pad.
  const capTypeVs = layerFlags.bitAnd(u32(7))
  const arrowLen = halfWm.mul(4)
  const acrossM = Var('across_m', f32T, max(halfWm, patExtentM))
  assign(padP0m, max(padP0m, patExtentM))
  assign(padP1m, max(padP1m, patExtentM))
  If(capTypeVs.eq(u32(3)), () => {
    If(length(seg.field('prev_tangent', vec2fT)).lt(0.001), () => {
      assign(padP0m, max(padP0m, arrowLen))
    })
    If(length(seg.field('next_tangent', vec2fT)).lt(0.001), () => {
      assign(padP1m, max(padP1m, arrowLen))
    })
  })

  // 6-vert quad → along/across.
  const along = Var('along', f32T, f32(0))
  const across = Var('across', f32T, f32(0))
  Switch(p.vi, [
    [0, () => { assign(along, f32(-1)); assign(across, f32(-1)) }],
    [1, () => { assign(along, f32(1));  assign(across, f32(-1)) }],
    [2, () => { assign(along, f32(1));  assign(across, f32(1)) }],
    [3, () => { assign(along, f32(-1)); assign(across, f32(-1)) }],
    [4, () => { assign(along, f32(1));  assign(across, f32(1)) }],
    [5, () => { assign(along, f32(-1)); assign(across, f32(1)) }],
  ], () => { /* default: empty */ })

  const isStart = Let('is_start', along.lt(0))
  const base = select(isStart, p0, p1)
  const perpCur = Let('perp_cur', nrm.mul(across))

  const prevTan = seg.field('prev_tangent', vec2fT)
  const nextTan = seg.field('next_tangent', vec2fT)
  const hasPrev = length(prevTan).gt(0.001)
  const hasNext = length(nextTan).gt(0.001)
  const hasNeighbor = select(isStart, hasPrev, hasNext)

  // Pattern across scale.
  const acrossScale = Let('across_scale', max(f32(1), acrossM.div(max(halfWm, f32(1e-6)))))

  // Lateral parallel offset.
  const halfWside = Let('half_w_side', halfWm.add(layerOffsetM.mul(across)))

  const offset = Var('offset', vec2fT, perpCur.mul(halfWside).mul(acrossScale))
  If(hasNeighbor, () => {
    const padRatio = select(isStart, seg.field('pad_ratio_p0', f32T), seg.field('pad_ratio_p1', f32T))
    const basePad = Let('base_pad', select(isStart, padP0m, padP1m))
    const offsetExtentM = halfWm.add(abs(layerOffsetM))
    const endpointPad = max(basePad, padRatio.mul(offsetExtentM))
    const joinTypeVs = layerFlags.shr(u32(3)).bitAnd(u32(3))
    const joinPad = Var('join_pad', f32T, halfWm.add(abs(layerOffsetM).mul(padRatio)))
    If(joinTypeVs.eq(u32(0)), () => { assign(joinPad, endpointPad) })
    assign(joinPad, joinPad.add(f32(0.5).mul(layerMpp)))
    const alongPad = Let('along_pad', max(halfWside, joinPad))
    assign(offset, offset.add(dir.mul(along).mul(alongPad).mul(acrossScale)))
  }).else(() => {
    const endpointPad = Let('endpoint_pad', select(isStart, padP0m, padP1m))
    assign(offset, offset.add(dir.mul(along).mul(endpointPad)))
  })

  const cornerLocal = Var('corner_local', vec2fT, base.add(offset))

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
    _builder: unknown,
    _name: string,
    absMercX: FNode,
    absMercY: FNode,
    height: FNode = f32(0),
  ): Node<'vec3<f32>'> => {
    const lonRad = toF32(absMercX.div(earthR))
    const latRad = toF32(f32(2).mul(atan(exp(absMercY.div(earthR)))).sub(pi.div(f32(2))))
    return lonlatToEcef(lonRad, latRad, height) as Node<'vec3<f32>'>
  }

  // Camera-relative RTC offset (tileEcefCenter − cameraCenter), DSFUN hi+lo,
  // written by VTR per tile at f32 52/56. addCamOff converts a tile-relative
  // ECEF into vertex−cameraCenter for the camera-at-ENU-origin MVP — the same
  // two-add form as polygon vs_main_ecef. Applied to BOTH the width-clamp
  // draft (so its on-screen distance estimate uses the true position) and the
  // final clip, keeping them consistent.
  const camOffH = TILE.field.cam_ecef_off_h
  const camOffL = TILE.field.cam_ecef_off_l
  const addCamOff = (v: Node<'vec3<f32>'>): Node<'vec3<f32>'> => v
    .add(vec3(camOffH.x, camOffH.y, camOffH.z))
    .add(vec3(camOffL.x, camOffL.y, camOffL.z)) as Node<'vec3<f32>'>

  // Screen-pixel-width stroke geometry clamp. Pre-clamp draft via ECEF
  // round-trip on the candidate corner (matches polygon convention).
  If(layerVpH.gt(0), () => {
    const zLift = seg.field('z_lift_m', f32T)
    const mvp = TILE.field.mvp
    const projParamsW = TILE.field.proj_params
    // Same MVP transform for center (base) + candidate (cornerLocal) so the
    // screen-space width estimate matches the final clip exactly.
    const centerClip = Var('center_clip', vec4fT)
    const cornerClip = Var('corner_clip', vec4fT)
    If(projParamsW.x.lt(6.5), () => {
      // FLAT (projType 0-6): finalize_corner passes Mercator through (already
      // camera-relative) and reprojects the other flat forms (project_geom −
      // projected camera centre). Same flat 2D-plane MVP for center +
      // candidate so the screen-space width estimate matches the final clip.
      const baseFc = finalizeCorner(base)
      const cornerFc = Let('corner_fc', finalizeCorner(cornerLocal))
      assign(centerClip, transformMat4(mvp, vec4(baseFc.x, baseFc.y, zLift, f32(1))))
      assign(cornerClip, transformMat4(mvp, vec4(cornerFc.x, cornerFc.y, zLift, f32(1))))
    }).else(() => {
      // 3D ECEF round-trip on the candidate corner (matches polygon convention).
      const tileOrigin = TILE.field.tile_origin_merc
      const tileAbsX = toF32(tileOrigin.x)
      const tileAbsY = toF32(tileOrigin.y)
      const tileEcef = ecefFromMerc(null, 'clamp_tile', tileAbsX, tileAbsY)
      const baseAbsX = toF32(base.x.add(tileOrigin.x))
      const baseAbsY = toF32(base.y.add(tileOrigin.y))
      // z_lift rides INTO lonlat_to_ecef as geodetic height (tileEcef anchor
      // stays height-0 = the polygon tile_ecef_center RTC frame).
      const baseEcef = ecefFromMerc(null, 'clamp_base', baseAbsX, baseAbsY, zLift)
      const baseRtc = baseEcef.sub(tileEcef)
      assign(centerClip, transformMat4(mvp, vec4(addCamOff(baseRtc as Node<'vec3<f32>'>), f32(1))))
      const cornerAbsX = Let('corner_abs_x', toF32(cornerLocal.x.add(tileOrigin.x)))
      const cornerAbsY = Let('corner_abs_y', toF32(cornerLocal.y.add(tileOrigin.y)))
      const cornerEcef = ecefFromMerc(null, 'clamp_corner', cornerAbsX, cornerAbsY, zLift)
      const cornerRtc = cornerEcef.sub(tileEcef)
      assign(cornerClip, transformMat4(mvp, vec4(addCamOff(cornerRtc as Node<'vec3<f32>'>), f32(1))))
    })
    const centerXY = Let('center_xy', vec2(centerClip.x, centerClip.y))
    const cornerXY = Let('corner_xy', vec2(cornerClip.x, cornerClip.y))
    const centerNdc = Let('center_ndc', centerXY.div(max(abs(centerClip.w), f32(1e-6))).mul(sign(centerClip.w)))
    const cornerNdc = Let('corner_ndc', cornerXY.div(max(abs(cornerClip.w), f32(1e-6))).mul(sign(cornerClip.w)))
    const screenDist = length(cornerNdc.sub(centerNdc))
    // width target is CSS px; viewport_height is DEVICE px → scale by dpr.
    const targetNdc = effectiveWidthPx.add(f32(2).mul(layerAaPx)).mul(layerDpr).div(layerVpH)
    // The screen-width clamp may only GROW the quad to counter projection
    // foreshortening — never SHRINK it below the base quad. The base offset is
    // (w/2+aa)·mpp tile-local metres, which the FS distance field (world_local
    // / mpp) renders at exactly the intended CSS-px width; a quad smaller than
    // that clips the fragment coverage and the stroke renders far too thin.
    // (targetNdc is miscalibrated against the perspective viewport scale — it
    // under-targets ~4×, so the raw scale was shrinking every flat stroke to a
    // fraction of its width. Capping at 1 restores the correct base width and
    // keeps the legitimate grow-for-foreshortening path.)
    If(screenDist.gt(1e-8), () => {
      const scale = max(targetNdc.div(screenDist), f32(1))
      assign(cornerLocal, base.add(offset.mul(scale)))
    })
  })

  // Final corner → clip. Flat Mercator (proj_params.x < 0.5) feeds the flat
  // 2D-plane MVP directly — cornerLocal is ALREADY camera-relative Mercator
  // metres (line_endpoint subtracted the camera for proj<0.5), so no ECEF
  // round-trip / addCamOff. 3D / globe keeps the WGS84-ECEF chain (cornerLocal
  // is tile-local there). u.mvp is the matching matrix (getViewForProjection);
  // zLift is the outline/extrude lift. world_local stays cornerLocal so the
  // FS distance / clip-bounds math is unchanged.
  const out = Var('out', LineOut.type)
  const tileOrigin2 = TILE.field.tile_origin_merc
  const mvp = TILE.field.mvp
  const zLift = seg.field('z_lift_m', f32T)
  const projParamsF = TILE.field.proj_params

  const clip = Var('clip', vec4fT)
  If(projParamsF.x.lt(6.5), () => {
    // FLAT (0-6): finalize_corner (Mercator pass-through + non-Mercator
    // project_geom reproject − projected camera centre) → flat 2D-plane MVP.
    const cornerFc = Let('corner_fc_final', finalizeCorner(cornerLocal))
    assign(clip, transformMat4(mvp, vec4(cornerFc.x, cornerFc.y, zLift, f32(1))))
  }).else(() => {
    const tileAbsX = toF32(tileOrigin2.x)
    const tileAbsY = toF32(tileOrigin2.y)
    const tileEcef = ecefFromMerc(null, 'final_tile', tileAbsX, tileAbsY)
    const cornerAbsX = Let('corner_abs_x_f', toF32(cornerLocal.x.add(tileOrigin2.x)))
    const cornerAbsY = Let('corner_abs_y_f', toF32(cornerLocal.y.add(tileOrigin2.y)))
    // z_lift = geodetic height inside lonlat_to_ecef (matches the CPU
    // lonLatToECEF roof-ring lift); the tile anchor stays height-0.
    const cornerEcef = ecefFromMerc(null, 'final_corner', cornerAbsX, cornerAbsY, zLift)
    const ecefRtc = cornerEcef.sub(tileEcef)
    // Camera-relative RTC — without addCamOff, line projects vertex−
    // tileEcefCenter and collapses toward each tile's origin.
    const ecefCam = addCamOff(ecefRtc as Node<'vec3<f32>'>)
    assign(clip, transformMat4(mvp, vec4(ecefCam, f32(1))))
  })
  // Mapbox fill-translate for POLYGON OUTLINES: a fill's outline draws through
  // the line pipeline sharing the fill's per-tile slot, so slots 46/47
  // (`_pad_tail0.zw`) already carry its NDC translate. Apply the SAME viewport
  // offset the polygon VS does (polygon.ts:345) so an outline stays glued to a
  // translated fill (OFM building-top roof) — MapLibre parity. Standalone lines
  // write 0 → no-op; the <0.25 guard skips the pattern-repeat-metres overload.
  const fillT = TILE.field._pad_tail0
  If(fillT.z.mul(fillT.z).add(fillT.w.mul(fillT.w)).lt(f32(0.25)), () => {
    assign(clip.x, clip.x.add(fillT.z.mul(clip.w)))
    assign(clip.y, clip.y.sub(fillT.w.mul(clip.w)))
  })
  // Mapbox line-translate viewport offset — applied post-MVP so the pixel
  // shift stays constant regardless of depth (mirrors fill-translate logic).
  // Default 0 → no-op; non-zero shifts the entire line layer in screen space.
  const ltx = LAYER.field.line_translate_x
  const lty = LAYER.field.line_translate_y
  If(ltx.mul(ltx).add(lty.mul(lty)).gt(f32(0)), () => {
    assign(clip.x, clip.x.add(ltx.mul(clip.w)))
    assign(clip.y, clip.y.sub(lty.mul(clip.w)))
  })
  assign(out.field('position', vec4fT), apply_log_depth(clip, TILE.field.log_depth_fc))
  assign(out.field('view_w', f32T), clip.w)
  assign(out.field('world_local', vec2fT), cornerLocal)
  assign(out.field('seg_id', u32T), p.seg_id)
  const cosCp0 = endpointCosC(seg.field('p0_h', vec2fT), seg.field('p0_l', vec2fT))
  const cosCp1 = endpointCosC(seg.field('p1_h', vec2fT), seg.field('p1_l', vec2fT))
  assign(out.field('cos_c', f32T), select(isStart, cosCp0, cosCp1))
  Return(out)
})

// ── Fragment entries (3 variants share compute_line_color) ──

const buildFsLine = (pickEnabled: boolean) =>
  entryFn('fs_line', 'fragment', [{ name: 'input', type: LineOut.type }], lineFragmentOutput(pickEnabled).type, (p) => {
    const out = Var('out', lineFragmentOutput(pickEnabled).type)
    const color = computeLineColor(p.input)
    const rim = lineRimAlpha(p.input)
    assign(out.field('color', vec4fT), vec4(color.rgb, color.a.mul(rim)))
    if (pickEnabled) assign(out.field('pick', vec2uT), vec2u(u32(0), u32(0)))
    assign(out.field('depth', f32T), compute_log_frag_depth(p.input.field('view_w', f32T), TILE.field.log_depth_fc))
    return out
  })

const buildFsLinePattern = (pickEnabled: boolean) =>
  entryFn('fs_line_pattern', 'fragment', [{ name: 'input', type: LineOut.type }], lineFragmentOutput(pickEnabled).type, (p) => {
    const base = computeLineColor(p.input)
    const tileOrigin = TILE.field.tile_origin_merc
    const absMerc = p.input.field('world_local', vec2fT).add(tileOrigin)
    const repeatX = max(LAYER.field.color.r, f32(1))
    const repeatY = max(LAYER.field.color.a, f32(1))
    const uvLocal = vec2(
      fract(absMerc.x.div(repeatX)),
      fract(absMerc.y.div(repeatY)),
    )
    const sc = TILE.field.stroke_color
    const u0 = sc.r
    const v0 = sc.g
    const u1 = sc.b
    const v1 = sc.a
    const atlasUv = vec2(
      u0.add(uvLocal.x.mul(u1.sub(u0))),
      v0.add(uvLocal.y.mul(v1.sub(v0))),
    )
    const sampled = textureSample(sprite_atlas, sprite_samp, atlasUv)
    const rim = lineRimAlpha(p.input)
    const out = Var('out', lineFragmentOutput(pickEnabled).type)
    assign(out.field('color', vec4fT), vec4(sampled.rgb, sampled.a.mul(base.a).mul(rim)))
    if (pickEnabled) assign(out.field('pick', vec2uT), vec2u(u32(0), u32(0)))
    assign(out.field('depth', f32T), compute_log_frag_depth(p.input.field('view_w', f32T), TILE.field.log_depth_fc))
    return out
  })

// Max-blend offscreen path: bare @location(0) vec4 return, no log-depth (the
// offscreen RT has no depth attachment).
const fsLineMax = entryFn(
  'fs_line_max', 'fragment',
  [{ name: 'input', type: LineOut.type }],
  vec4fT,
  (p) => {
    const c = Var('c', vec4fT, computeLineColor(p.input))
    const rim = lineRimAlpha(p.input)
    assign(c.field('a', f32T), c.field('a', f32T).mul(rim))
    return c
  },
  '@location(0)',
)

// ── Module assembly ──

export const buildLineModule = (pickEnabled: boolean): ModuleDecl => module({
  // Shared projection + ecef constants merged in (was the getProjectionWgslConsts() /
  // ECEF_WGSL_CONSTS string prepend in emitLineWgsl). emitModule hoists them above all funcs.
  consts: [...PROJECTION_CONSTS, ...ECEF_CONSTS],
  structs: [
    TILE.struct, PatternSlot.decl, LAYER.struct, LineSegment.decl,
    ShapeDesc.decl, ShapeSegment.decl, LineOut.decl, lineFragmentOutput(pickEnabled).decl,
  ],
  bindings: [
    TILE.binding,
    spriteAtlasB.binding,
    spriteSampB.binding,
    LAYER.binding,
    segmentsB.binding,
    shapesB.binding,
    shapeSegmentsB.binding,
  ],
  funcs: [
    // Shared dependency decls, callees first (was the LOG_DEPTH / projection / ECEF / SDF
    // WGSL-string prepend): log-depth → projection → ecef → sdf, then line's own funcs.
    apply_log_depth, compute_log_frag_depth,
    ...getGpuProjectionFuncs(),
    ...ECEF_FUNCS,
    dist_to_segment, dist_to_quadratic, dist_to_cubic, winding_line,
    lineEndpoint, finalizeCorner, endpointCosC, patternUnitToM, sdfShape,
    computeLineColor, lineRimAlpha, vsLine,
    buildFsLine(pickEnabled), buildFsLinePattern(pickEnabled), fsLineMax,
  ],
})

/** Full line shader: shared DSL-emitted projection consts + log-depth fns +
 *  projection fns + SDF distance/winding helpers, then the line module.
 *  `pickEnabled` toggles the pick attachment field + writes (replaces the old
 *  __PICK_FIELD__ / __PICK_WRITE__ regex markers). */
export const emitLineWgsl = (pickEnabled: boolean): string => emitModule(buildLineModule(pickEnabled))

// ── Compositor (fullscreen-triangle sampling the translucent offscreen RT) ──
//
// Standalone — different bind group + a single uniform (opacity). Pairs with
// pipelineMax in line-renderer.ts.

const CompUniform = uniformStruct('CompUniform', { group: 0, binding: 2, as: 'cu' }, {
  opacity: f32T,
  _pad: vec3fT,
})

const VsFullOut = ioStruct('VsFullOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

const compSampB = resource('samp', samplerT, { group: 0, binding: 0 })
const compSamp = compSampB.node
const compSrcB = resource('src', texture2dfT, { group: 0, binding: 1 })
const compSrc = compSrcB.node

const vsFull = entryFn('vs_full', 'vertex',
  [{ name: 'vi', type: u32T, builtin: 'vertex_index' }],
  VsFullOut.type,
  (p) => {
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
    const out = Var('out', VsFullOut.type)
    assign(out.field('pos', vec4fT), vec4(pos, f32(0), f32(1)))
    assign(out.field('uv', vec2fT), uv)
    return out
  },
)

const fsFull = entryFn('fs_full', 'fragment',
  [{ name: 'input', type: VsFullOut.type }],
  vec4fT,
  (p) => {
    const c = textureSample(compSrc, compSamp, p.input.field('uv', vec2fT))
    const op = CompUniform.field.opacity
    // MAX-blend offscreen stores non-premultiplied (rgb, a_aa); premultiply here.
    return vec4(c.rgb.mul(c.a).mul(op), c.a.mul(op))
  },
  '@location(0)',
)

const compositeModule: ModuleDecl = module({
  structs: [CompUniform.struct, VsFullOut.decl],
  bindings: [
    compSampB.binding,
    compSrcB.binding,
    CompUniform.binding,
  ],
  funcs: [vsFull, fsFull],
})

/** Translucent-line compositor: fullscreen triangle that samples the max-blend
 *  offscreen RT and composites onto the main framebuffer with per-layer
 *  opacity. Pairs with pipelineMax in line-renderer.ts. */
export const emitCompositeWgsl = (): string => emitModule(compositeModule)
