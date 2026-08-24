// ═══ Line VS corner helpers — extracted from line.ts (#1003 LOC ceiling) ═══
//
// finalize_corner and pattern_unit_to_m, verbatim from line.ts but with the
// TILE uniform fields passed as PARAMETERS (the uniform struct is line.ts
// module state; taking the lanes as args keeps this module cycle-free and the
// functions pure). line.ts wraps finalize_corner in a one-line adapter that
// feeds its own TILE fields, so every call site reads as before.

import { fn, vec4, select, degrees, type Node, type ReadonlyNode } from '@xgis/shader-dsl'
import { f32, vec2fT, vec4fT, f32T, u32T } from '@xgis/shader-dsl'
import { inv_merc_lat_rad, flat_rel } from './projections'
import { EARTH_R, DEG2RAD } from './consts'

// finalize_corner — flat-projection reprojection (projection-display-layer- restore Phase 2).
// Restored from the pre-ECEF path for the flat display branch only; globe + 3D still use the ECEF-
// MVP, so finalize_corner_globe stays retired. Mercator (proj<0.5): cornerLocal is already camera-
// relative Mercator metres (line_endpoint subtracted the camera), so pass it through. Non-Mercator
// (1-6): reproject via project_geom (world-copy aware) minus the projected camera centre, both
// recentred onto clon = 0. Output feeds the flat 2D-plane MVP.
//
// #598 — the longitude fed to the projection is the PRECISE camera-relative delta, not the lossy
// absolute degree. `corner − (cam_h + cam_l)` is the DSFUN camera-relative tile-local Mercator X
// (the ~1.4e7 m tile-origin magnitude cancels BEFORE it reaches f32 — the renderer sets cam_h+cam_l
// = camMercX − tileMercX, camMercX = clon·DEG2RAD·R), so d_lon = that ÷ (DEG2RAD·R) = abs_lon −
// clon to sub-metre precision. project_geom / project depend ONLY on (lon − clon) and (ref_lon −
// clon), so recentring onto clon = 0 (proj_params.y → 0, ref_lon → tile_ref_lon − clon) is EXACT in
// real arithmetic — byte- identical to the old abs-degree path everywhere a within-tile vertex can
// sit (|lon_primary − ref_primary| = |abs_lon − tile_ref_lon| ≤ tile extent, never near the ±180
// seam-keep tie) — and it deletes the radians(abs_lon) − radians(clon) f32 cancellation that shook
// non-Mercator strokes at high zoom. Latitude keeps the abs-degree path: it has no linear camera-
// relative form and its Mercator magnitude is far smaller, so its residual is already sub-metre.
export const finalizeCornerWith = fn(
  'finalize_corner',
  {
    corner: vec2fT,
    proj_params: vec4fT,
    tile_origin: vec2fT,
    cam_h: vec2fT,
    cam_l: vec2fT,
    tile_extent_m: f32T,
  },
  (p) => {
    const absMerc = p.corner.add(p.tile_origin)
    const latRad = inv_merc_lat_rad(absMerc.y)
    const absLat = degrees(latRad)
    const clon = p.proj_params.y
    const relMercX = p.corner.x.sub(p.cam_h.x).sub(p.cam_l.x)
    const dLon = relMercX.div(DEG2RAD.mul(EARTH_R))
    const projParamsRel = vec4(p.proj_params.x, f32(0), p.proj_params.z, p.proj_params.w)
    const tileRefLonRel = p.tile_origin.x
      .add(f32(0.5).mul(p.tile_extent_m))
      .div(DEG2RAD.mul(EARTH_R))
      .sub(clon)
    // single-exit: Mercator (proj<0.5) passes the corner through; else the reprojected
    // flat_rel. flat_rel is pure, so computing it on the Mercator path (selected away) is harmless.
    const flatRel = flat_rel(dLon, absLat, projParamsRel, tileRefLonRel)
    return select(p.proj_params.x.lt(0.5), p.corner, flatRel)
  },
)

export const patternUnitToM = fn('pattern_unit_to_m', { v: f32T, unit: u32T, mpp: f32T }, (p) => {
  // single-exit, 0=m 1=px 2=km 3=nm — nested select from the default (nm) up.
  const km = select(p.unit.eq(2), p.v.mul(1000), p.v.mul(1852))
  const px = select(p.unit.eq(1), p.v.mul(p.mpp), km)
  return select(p.unit.eq(0), p.v, px)
})

export type FinalizeCornerAdapter = (a: { corner: ReadonlyNode<'vec2<f32>'> }) => Node<'vec2<f32>'>
