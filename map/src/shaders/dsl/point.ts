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
  fn,
  module,
  transformMat4,
  arrayLit,
  f32,
  u32,
  i32,
  toF32,
  toU32,
  vec2,
  vec3,
  vec4,
  mix,
  exp,
  clamp,
  length,
  dot,
  min,
  max,
  smoothstep,
  fwidth,
  select,
  f32T,
  u32T,
  vec2fT,
  vec4fT,
  mat4x4fT,
  Let,
  Var,
  If,
  Loop,
  reduce,
  when,
  Switch,
  Return,
  Discard,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import {
  ioStruct,
  builtin,
  location,
  uniformStruct,
  structDecl,
  storageBuffer,
} from '@xgis/shader-dsl'
import { emitModule } from '@xgis/shader-dsl'
import {
  needs_backface_cull,
  rim_alpha,
  flat_rel,
  PROJECTION_CONSTS,
  getGpuProjectionFuncs,
} from './projections'
import { POINT_FEAT } from './point-feat-layout'
import { apply_log_depth, compute_log_frag_depth } from './log-depth'

// Exported (as pointU below — every dsl file names its struct 'U' locally, so the
// barrel needs distinct names) for the renderer's UniformBlock (#733): the CPU
// packer derives its typed write surface from this SAME declaration the WGSL
// struct is emitted from.
const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'u' },
  {
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
    viewport: vec4fT, // xy = w/h, z = meters/px, w = log_depth_fc
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
    // #600 — globe(7) eye-horizon cull. xyz = normalize(eye_ecef), w =
    // EARTH_R/|eye_ecef| (= horizonCos). point_cos_c passes this to
    // needs_backface_cull (VS-side cull): globe arm keeps the vertex iff
    // dot(normalize(P_ecef), globe_eye.xyz) > globe_eye.w — the eye-horizon cap,
    // not the pitch-invariant centre hemisphere. Written by point-renderer's
    // writePointFrameUniform; ALL-ZERO on flat / disc paths (arms ignore it).
    globe_eye: vec4fT,
  },
)
export { U as pointU }
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
  kind: u32T, // 0=line 1=quad 2=cubic
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

const featDataB = storageBuffer('feat_data', f32T, { group: 0, binding: 1, access: 'read' })
const shapesB = storageBuffer('shapes', ShapeDesc, { group: 0, binding: 2, access: 'read' })
const segmentsB = storageBuffer('segments', Segment, { group: 0, binding: 3, access: 'read' })
const featData = featDataB.node

// STRIDE — per-feature feat_data stride (matches the renderer's f32 pack order).
// Phase 2 PR 2d.2 — bumped 14 → 20 to carry per-feature ECEF DSFUN center
// (6 floats: pos_h.xyz + pos_l.xyz at slots 11..16) and absolute lon/lat
// (2 floats at slots 17..18). Slot 19 holds shape_id (was slot 13 in the
// pre-PR-2d.2 stride-14 layout). Memory delta: +24 B per feature.
// Bumped 20 → 24 for the absolute Mercator DSFUN tail (slots 20-23 =
// mx_h, mx_l, my_h, my_l) — precise flat-Mercator position so the flat-Merc
// branch no longer reprojects the lossy f32 abs_lon/abs_lat (~5.7 px @ z20).
const STRIDE = u32(POINT_FEAT.stride)
const F = POINT_FEAT.slot

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

const pointCosC = fn('point_cos_c', { abs_lon: f32T, abs_lat: f32T }, (p) => {
  return needs_backface_cull(p.abs_lon, p.abs_lat, U.field.proj_params, U.field.globe_eye)
})

const pointRimAlpha = fn('point_rim_alpha', { abs_lon: f32T, abs_lat: f32T }, (p) => {
  return rim_alpha(p.abs_lon, p.abs_lat, U.field.proj_params, U.field.globe_eye)
})

const distToLine = fn('dist_to_line', { p: vec2fT, a: vec2fT, b: vec2fT }, (pp) => {
  const ab = pp.b.sub(pp.a)
  const len2 = dot(ab, ab)
  // single-exit: max() guards the degenerate (len2≈0) divide; select picks the point dist.
  const t = clamp(dot(pp.p.sub(pp.a), ab).div(max(len2, 1e-10)), 0, 1)
  const segDist = length(pp.p.sub(pp.a).sub(ab.mul(t)))
  return select(len2.lt(1e-10), length(pp.p.sub(pp.a)), segDist)
})

const distToQuadratic = fn(
  'dist_to_quadratic',
  { p: vec2fT, a: vec2fT, b: vec2fT, c: vec2fT },
  (pp) =>
    reduce(
      f32(1e10),
      u32(0),
      (i) => i.le(16),
      (best, i) => {
        const t = toF32(i).div(16)
        const ab = mix(pp.a, pp.b, t)
        const bc = mix(pp.b, pp.c, t)
        const q = mix(ab, bc, t)
        return min(best, length(pp.p.sub(q)))
      },
    ),
)

const distToCubic = fn(
  'dist_to_cubic',
  { p: vec2fT, a: vec2fT, b: vec2fT, c: vec2fT, d: vec2fT },
  (pp) =>
    reduce(
      f32(1e10),
      u32(0),
      (i) => i.le(24),
      (best, i) => {
        const t = toF32(i).div(24)
        const ab = mix(pp.a, pp.b, t)
        const bc = mix(pp.b, pp.c, t)
        const cd = mix(pp.c, pp.d, t)
        const abc = mix(ab, bc, t)
        const bcd = mix(bc, cd, t)
        const q = mix(abc, bcd, t)
        return min(best, length(pp.p.sub(q)))
      },
    ),
)

const windingLine = fn('winding_line', { p: vec2fT, a: vec2fT, b: vec2fT }, (pp) => {
  // single-exit: signed winding contribution of edge a→b across the +y ray from p.
  const cross = pp.b.x
    .sub(pp.a.x)
    .mul(pp.p.y.sub(pp.a.y))
    .sub(pp.p.x.sub(pp.a.x).mul(pp.b.y.sub(pp.a.y)))
  const up = pp.a.y.le(pp.p.y).and(pp.b.y.gt(pp.p.y)).and(cross.gt(0))
  const down = pp.a.y.gt(pp.p.y).and(pp.b.y.le(pp.p.y)).and(cross.lt(0))
  return select(up, i32(1), select(down, i32(-1), i32(0)))
})

const sdfShape = fn(
  'sdf_shape',
  { uv_in: vec2fT, shape_id: u32T },
  f32T,
  (pp) => {
    // Flip Y: NDC Y-up → SVG/path Y-down convention.
    const uv = vec2(pp.uv_in.x, pp.uv_in.y.neg())
    const sd = shapesB.at(pp.shape_id)
    const bMinX = sd.bbox_min_x
    const bMinY = sd.bbox_min_y
    const bMaxX = sd.bbox_max_x
    const bMaxY = sd.bbox_max_y
    // AABB early-out.
    If(uv.x.lt(bMinX).or(uv.x.gt(bMaxX)).or(uv.y.lt(bMinY)).or(uv.y.gt(bMaxY)), () => {
      Return(f32(2))
    })
    const minDist = f32(1e10)
    const winding = i32(0)
    const segStart = sd.seg_start
    const segCount = sd.seg_count
    // Hard-cap at 32 segments per shape (paste from original).
    const end = min(segStart.add(segCount), segStart.add(32))
    Loop(
      segStart,
      (i) => i.lt(end),
      (i) => {
        const sg = segmentsB.at(i)
        const p0 = sg.p0
        const p1 = sg.p1
        const p2 = sg.p2
        const p3 = sg.p3
        Switch(sg.kind)
          .case(0, () => {
            minDist.assign(min(minDist, distToLine({ p: uv, a: p0, b: p1 })))
            winding.assign(winding.add(windingLine({ p: uv, a: p0, b: p1 })))
          })
          .case(1, () => {
            minDist.assign(min(minDist, distToQuadratic({ p: uv, a: p0, b: p1, c: p2 })))
            // Approximate winding with chord.
            winding.assign(winding.add(windingLine({ p: uv, a: p0, b: p2 })))
          })
          .case(2, () => {
            minDist.assign(min(minDist, distToCubic({ p: uv, a: p0, b: p1, c: p2, d: p3 })))
            // Approximate winding with chord.
            winding.assign(winding.add(windingLine({ p: uv, a: p0, b: p3 })))
          })
          .default(() => {
            /* default: empty */
          })
      },
    )
    // Inside (winding != 0): dist=1 at boundary; outside: dist=1+min_dist.
    If(winding.ne(0), () => {
      Return(f32(1).sub(minDist))
    }).else(() => {
      Return(f32(1).add(minDist))
    })
  },
  { allowEarlyReturn: true },
) // MISRA single-exit DEVIATION — the AABB early-out skips a 32-segment loop (perf)

// ── Entry points ──

const vs = fn(
  'vs_point',
  {
    center: location(0, vec2fT),
    quad_id: location(1, u32T),
    feat_id: location(2, f32T),
  },
  (p) => {
    const offsets = arrayLit(vec2fT, vec2(-1, -1), vec2(1, -1), vec2(1, 1), vec2(-1, 1))
    const fid = toU32(p.feat_id)
    const rawRadius = featData.at(fid.mul(STRIDE).add(F.radius_px), f32T)
    // Pack-byte at offset 10: bit 0..3 reserved, bits 4..7 = size_mode,
    // bit 3 = is_flat, bits 8..9 = anchor_mode.
    const packed10 = toU32(featData.at(fid.mul(STRIDE).add(F.flags_packed), f32T))
    const sizeMode = packed10.shr(u32(4)).bitAnd(u32(0xf))
    // Size mode: 0=px, 1=m, 2=km, 3=deg (equator approx), 4=nm.
    const viewport = U.field.viewport
    const radiusPx = Var(rawRadius) // default; the size_mode switch overrides per case
    Switch(sizeMode)
      .case(1, () => radiusPx.assign(rawRadius.div(viewport.z)))
      .case(2, () => radiusPx.assign(rawRadius.mul(1000).div(viewport.z)))
      .case(3, () => radiusPx.assign(rawRadius.mul(111320).div(viewport.z)))
      .case(4, () => radiusPx.assign(rawRadius.mul(1852).div(viewport.z)))
      .default(() => {})

    // Phase 2 PR 2d.2 — ECEF DSFUN per-feature centre.
    // featData slots 11..16 carry the tile-anchored ECEF DSFUN split
    // (pos_h.xyz + pos_l.xyz) for the point's centre; slots 17..18 carry
    // the absolute lon/lat in degrees for the fragment-side hemisphere
    // cull. The single `u.mvp` slot is the ECEF-MVP (post PR 2d.5).
    const ecefH = vec3(
      featData.at(fid.mul(STRIDE).add(F.ecef_x_h), f32T),
      featData.at(fid.mul(STRIDE).add(F.ecef_y_h), f32T),
      featData.at(fid.mul(STRIDE).add(F.ecef_z_h), f32T),
    )
    const ecefL = vec3(
      featData.at(fid.mul(STRIDE).add(F.ecef_x_l), f32T),
      featData.at(fid.mul(STRIDE).add(F.ecef_y_l), f32T),
      featData.at(fid.mul(STRIDE).add(F.ecef_z_l), f32T),
    )
    // Camera-relative RTC: subtract the camera anchor in DSFUN space so the
    // big absolute ECEF magnitude cancels before the residual reaches f32 math.
    const camH = U.field.cam_ecef_h.swizzle('xyz')
    const camL = U.field.cam_ecef_l.swizzle('xyz')
    const ecefRtc = ecefH.sub(camH).add(ecefL.sub(camL))
    const absLon = featData.at(fid.mul(STRIDE).add(F.abs_lon), f32T)
    const absLat = featData.at(fid.mul(STRIDE).add(F.abs_lat), f32T)
    const mvp = U.field.mvp
    // Display projection (projection-display-layer-restore): flat Mercator
    // (proj_params.x < 0.5) reprojects the absolute lon/lat onto the 2D plane
    // and feeds the flat Mercator-metre MVP; 3D / globe keeps the ECEF-RTC
    // anchor. For the flat path the renderer writes the 2D camera centre
    // (Mercator metres, DSFUN hi/lo) into cam_ecef_h.xy / cam_ecef_l.xy — those
    // ECEF lanes are dead on the flat path. u.mvp is the matching matrix
    // (Camera.getViewForProjection). Quad expansion below consumes centerClip
    // identically for both paths.
    const centerClip = when(
      [
        [
          U.field.proj_params.x.lt(0.5),
          () => {
            // Precise absolute Mercator DSFUN (slots 20-23), camera-recentered in DSFUN
            // space — `(mx_h−camH)+(mx_l−camL)` — exactly like ecef_rtc. The old path
            // reprojected the lossy f32 abs_lon/abs_lat (~1.35 m → ~5.7 px @ z20).
            const mxH = featData.at(fid.mul(STRIDE).add(F.merc_x_h), f32T)
            const mxL = featData.at(fid.mul(STRIDE).add(F.merc_x_l), f32T)
            const myH = featData.at(fid.mul(STRIDE).add(F.merc_y_h), f32T)
            const myL = featData.at(fid.mul(STRIDE).add(F.merc_y_l), f32T)
            const camMercH = U.field.cam_ecef_h.swizzle('xy')
            const camMercL = U.field.cam_ecef_l.swizzle('xy')
            const relX = mxH.sub(camMercH.x).add(mxL.sub(camMercL.x))
            const relY = myH.sub(camMercH.y).add(myL.sub(camMercL.y))
            return transformMat4(mvp, vec4(relX, relY, 0, 1))
          },
        ],
        [
          U.field.proj_params.x.lt(6.5),
          () => {
            // FLAT non-Mercator (1-6): the shared flat_rel — reproject the marker's
            // lon/lat minus the in-shader projected camera centre. ref_lon = the
            // marker's own lon (self) so it lands in its nearest world copy; for an
            // individual marker project_geom collapses to plain project. Same flat MVP.
            const pp = U.field.proj_params
            const relG = flat_rel(absLon, absLat, pp, absLon)
            return transformMat4(mvp, vec4(relG.x, relG.y, 0, 1))
          },
        ],
      ],
      () => {
        return transformMat4(mvp, vec4(ecefRtc, 1))
      },
    )

    // circle-translate: apply viewport-space offset post-MVP.
    // translate_x/y are pre-baked to NDC-per-pixel by the renderer
    // (circle_params.xy). Multiply by clip.w to keep the shift pixel-
    // constant regardless of depth — same approach as polygon fill-translate.
    // Default [0,0] → no-op.
    const circleParams = U.field.circle_params
    centerClip.assign(
      centerClip.add(
        vec4(circleParams.x.mul(centerClip.w), circleParams.y.mul(centerClip.w), 0, 0),
      ),
    )

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
    If(U.field.circle_params.w.gt(0.5), () => {
      const wRef = mvp.at(u32(3), vec4fT).w
      const wPt = Let(max(centerClip.w, 1e-4))
      radiusPx.assign(radiusPx.mul(wRef.div(wPt)))
    })

    // bit 3 of packed10 = flat-quad mode.
    const isFlat = packed10.bitAnd(u32(8)).ne(0)
    radiusPx.assign(max(radiusPx, 1))
    const expand = Let(radiusPx.add(2))

    const o = PointOut.var()
    // All four corners share the centre's view_w (point markers occupy a
    // near-zero depth range; per-corner depth divergence would over-strict
    // the log-depth interpolation).
    const fc = viewport.w
    o.view_w.assign(centerClip.w)

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
      const yShiftPx = f32(0)
      If(anchorMode.eq(1), () => {
        yShiftPx.assign(expand)
      }).elif(anchorMode.eq(2), () => {
        yShiftPx.assign(expand.neg())
      })
      const pxToNdc = vec2(f32(2).div(viewport.x), f32(2).div(viewport.y))
      const offXY = offsets.at(p.quad_id, vec2fT)
      const offsetPx = Let(vec2(offXY.x.mul(expand), offXY.y.mul(expand).add(yShiftPx)))
      const offsetNdc = offsetPx.mul(pxToNdc)
      const flatClip = Let(centerClip.add(vec4(offsetNdc.mul(centerClip.w), 0, 0)))
      o.position.assign(apply_log_depth({ pos: flatClip, fc }))
      o.uv.assign(offXY.mul(expand).div(max(radiusPx, 1)))
    }).else(() => {
      // BILLBOARD: expand in screen-space (NDC), perspective-corrected. Anchor
      // (bits 8..9): 0=center, 1=bottom (lifts up by one extent so the bottom
      // edge sits on the projected ground point), 2=top.
      const anchorMode = packed10.shr(u32(8)).bitAnd(u32(3))
      const yShiftPx = f32(0)
      If(anchorMode.eq(1), () => {
        yShiftPx.assign(expand)
      }).elif(anchorMode.eq(2), () => {
        yShiftPx.assign(expand.neg())
      })
      const pxToNdc = vec2(f32(2).div(viewport.x), f32(2).div(viewport.y))
      const offXY = offsets.at(p.quad_id, vec2fT)
      const offsetPx = Let(vec2(offXY.x.mul(expand), offXY.y.mul(expand).add(yShiftPx)))
      const offsetNdc = offsetPx.mul(pxToNdc)
      const billboardClip = Let(centerClip.add(vec4(offsetNdc.mul(centerClip.w), 0, 0)))
      o.position.assign(apply_log_depth({ pos: billboardClip, fc }))
      // UV stays centered so the SDF shape renders unchanged; only the on-
      // screen placement is shifted.
      o.uv.assign(offXY.mul(expand).div(max(radiusPx, 1)))
    })
    o.feat_id.assign(fid)
    o.radius_px.assign(radiusPx)
    o.cos_c.assign(pointCosC({ abs_lon: absLon, abs_lat: absLat }))
    o.rim_a.assign(pointRimAlpha({ abs_lon: absLon, abs_lat: absLat }))
    return o.$
  },
  { stage: 'vertex' },
)

const fs = fn(
  'fs_point',
  { in: PointOut },
  (p) => {
    const pin = p.in
    // Backface cull for globe projections — cos_c is +1 for flat projections.
    If(pin.cos_c.lt(0), () => {
      Discard()
    })
    const fid = pin.feat_id
    // shape_id moved to slot 19 in PR 2d.2's stride-20 layout (was slot 13).
    const shapeId = toU32(featData.at(fid.mul(STRIDE).add(F.shape_id), f32T))

    // AA from UV (always smooth) — not from SDF dist (AABB discontinuities).
    // MUST stay an explicit Let: fwidth is a derivative and WGSL requires it be evaluated in
    // UNIFORM control flow. Inlining it would re-emit fwidth() inside the per-flag fill/stroke
    // `if` branches (non-uniform) → "fwidth must only be called from uniform control flow".
    const aa = Let(fwidth(length(pin.uv)).mul(1.5))
    // circle-blur: widen the AA band by blur_px converted to UV units.
    // blur_uv = blur_px / radius_px. Default 0 → band unchanged (no-op).
    const blurPx = U.field.circle_params.z
    const blurUv = blurPx.div(max(pin.radius_px, 1))
    const halfBand = aa.add(blurUv)

    const dist = when(
      shapeId.eq(0),
      () => length(pin.uv), // analytical circle (fast path)
      () => sdfShape({ uv_in: pin.uv, shape_id: shapeId.sub(1) }),
    )

    // Per-feature style.
    const fillColor = vec4(
      featData.at(fid.mul(STRIDE).add(F.fill_r), f32T),
      featData.at(fid.mul(STRIDE).add(F.fill_g), f32T),
      featData.at(fid.mul(STRIDE).add(F.fill_b), f32T),
      featData.at(fid.mul(STRIDE).add(F.fill_a), f32T),
    )
    const strokeColor = vec4(
      featData.at(fid.mul(STRIDE).add(F.stroke_r), f32T),
      featData.at(fid.mul(STRIDE).add(F.stroke_g), f32T),
      featData.at(fid.mul(STRIDE).add(F.stroke_b), f32T),
      featData.at(fid.mul(STRIDE).add(F.stroke_a), f32T),
    )
    const strokeWPx = featData.at(fid.mul(STRIDE).add(F.stroke_width_px), f32T)
    const flags = toU32(featData.at(fid.mul(STRIDE).add(F.flags_packed), f32T))

    // stroke_w in UV space using the actual rendered radius.
    const strokeW = strokeWPx.div(max(pin.radius_px, 1))

    const color = vec4(0, 0, 0, 0)

    // Fill (bit 0).
    If(flags.bitAnd(u32(1)).ne(0), () => {
      const fillAlpha = Let(
        f32(1).sub(smoothstep(f32(1).sub(halfBand), f32(1).add(halfBand), dist)),
      )
      color.assign(vec4(fillColor.rgb, fillColor.a.mul(fillAlpha)))
    })

    // Stroke (bit 1).
    If(flags.bitAnd(u32(2)).ne(0), () => {
      const inner = f32(1).sub(strokeW)
      const strokeAlpha = Let(
        smoothstep(inner.sub(aa), inner.add(aa), dist).mul(
          f32(1).sub(smoothstep(f32(1).sub(halfBand), f32(1).add(halfBand), dist)),
        ),
      )
      color.assign(mix(color, vec4(strokeColor.rgb, strokeColor.a), strokeAlpha))
    })

    // Glow (bit 2).
    If(flags.bitAnd(u32(4)).ne(0), () => {
      const glow = Let(exp(dist.mul(dist).mul(-2)).mul(0.4))
      color.assign(color.add(vec4(fillColor.rgb.mul(glow), glow)))
    })

    // Rim fade — flat / cylindrical projections receive rim_a=1.0.
    color.a.assign(color.a.mul(pin.rim_a))
    If(color.a.lt(0.005), () => {
      Discard()
    })
    return PointFragmentOutput.construct({
      color,
      depth: compute_log_frag_depth({ view_w: pin.view_w, fc: U.field.viewport.w }),
    })
  },
  { stage: 'fragment' },
)

// A build-fn (not a top-level const) so the injection-deferred getGpuProjectionFuncs() is
// gathered at emit time, post-configureProjections() — same reason buildLineModule is a fn.
export const buildPointModule = (): ModuleDecl =>
  module({
    // Shared projection constants merged in (was the getProjectionWgslConsts() string prepend).
    consts: [...PROJECTION_CONSTS],
    structs: [U.struct, ShapeDesc.decl, Segment.decl, PointOut.decl, PointFragmentOutput.decl],
    bindings: [U.binding, featDataB.binding, shapesB.binding, segmentsB.binding],
    funcs: [
      // Injection seam ONLY (#740 R1): the projection fns are extern-called (built
      // post-configureProjections — no declRef), so module() cannot auto-collect them.
      // Everything else — log-depth, cosC/rimAlpha, the SDF helpers — is reached
      // through handle calls and collected callee-first automatically.
      ...getGpuProjectionFuncs(),
      vs,
      fs,
    ],
  })

/** Full point shader: one module — shared projection consts + log-depth + projection fns
 *  merged ahead of the point structs / bindings / helpers. No pick variant. */
export const emitPointWgsl = (): string => emitModule(buildPointModule())
