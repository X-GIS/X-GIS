// ═══ Polygon mesh utilities ══════════════════════════════════════
//
// Default lift (metres) for features in an extruded layer that don't
// have their own height tag. The line-segment build path uses this
// constant for the outline `z_lift_m` so a feature missing a height
// tag still gets its outline placed on the wall top (not at z=0 where
// the wall would occlude it).
export const EXTRUDE_FALLBACK_HEIGHT_M = 50

//
// Pure functions extracted from vector-tile-renderer's upload path.
// Pulled out so the math is unit-testable independent of GPU state:
//
//   * `generateWallMeshExtrudedECEF` — given polygon rings (compiler
//     output in tile-local Mercator metres) emit wall + roof vertices
//     in ECEF-RTC coordinates. Stride-14 interleaved Float32Array (see
//     the block-comment below for the per-vertex layout).
//
// Both functions live in the runtime side because the compiler's
// PMTiles archives are pre-built — runtime decides at upload time
// whether to extrude based on per-show style (currently hardcoded
// for the 'buildings' MVT slice; a follow-up phase wires this to a
// `extrude:` keyword in .xgis).

import earcut from 'earcut'
import type { RingPolygon } from '@xgis/compiler'
import { POLYGON_EXTRUDED_FORMAT, vertexField } from '@xgis/compiler'
import { lonLatToECEF } from '@xgis/engine'
import { mercatorYToLatRad } from '@xgis/engine'
import { EARTH } from '@xgis/shared'

// ─────────────────────────────────────────────────────────────────
// ECEF wall + roof mesh — Phase 2 PR 2c.2 sub-task C.
//
// `generateWallMeshExtrudedECEF` replaces the (Mercator + stride-8 +
// parallel-z) wall mesh with a single interleaved stride-14 Float32Array
// in ECEF-RTC (Earth-Centered Earth-Fixed, relative to a per-tile centre)
// coordinates. The runtime VS becomes a linear
// `u.mvp * vec4(pos_h + pos_l, 1)` (ECEF-MVP — see PR 2d.5 closeout)
// — `project_geom`'s non-linear dispatch disappears at PR 2c.2's flip.
//
// Per-vertex layout — Phase 2 PR 2f quantized ECEF (11 f32 = 44 bytes):
//   loc 0  position_hi  uint16×4 — qx_hi, qx_lo, qy_hi, qy_lo (bytes  0..7)
//   loc 1  position_lo  uint16×2 — qz_hi, qz_lo              (bytes  8..11)
//   loc 2  feat_id      picking key          f32             (byte  12)
//   loc 3  abs_lon_deg  absolute longitude   f32             (byte  16)
//   loc 4  abs_lat_deg  absolute latitude    f32             (byte  20)
//   loc 5  face_normal  ECEF unit vector     f32×3 (bytes 24..35) — outward
//                       horizontal for walls, radial-up for roof
//   loc 6  wall_height  feature height (m)   f32             (byte  36)
//   loc 7  is_top       0 = wall-bottom, 1 = wall-top + roof f32 (byte 40)
//
// Position is the ECEF RTC residual quantized to 32-bit fixed point per
// axis over the per-mesh symmetric range [-dequantHalf, +dequantHalf]
// (computed AFTER the wall-lift so top-ring residuals don't overflow).
// The GPU VS reconstructs: q = f32(hi)*65536 + f32(lo); axis = q*scale - half.
//
// The `is_top` discriminator (M-2 fix) preserves `wall_blend`
// (`polygon.ts:444`) and `tTop` (`polygon.ts:474`) semantics after the
// CPU-side lift removes the implicit `zWorld > 0` discriminator that the
// pre-PR 2c.2 shader used.
// ─────────────────────────────────────────────────────────────────

/** Result of the ECEF extruded wall + roof mesh generator: single
 *  interleaved stride-44-byte buffer (quantized position + f32 tail) plus
 *  indices and the per-mesh dequant uniform companion. Roof + walls share
 *  the same buffer — caller binds vertices+indices directly. */
export interface WallMeshExtrudedECEF {
  /** Interleaved per-vertex bytes; stride 44 = 11 floats. uint16×6 position
   *  in the first 12 bytes, f32 tail (fid/abs_lon/abs_lat/face_normal×3/
   *  wall_height/is_top) at float slots 3..10. */
  vertices: Float32Array
  /** Triangle indices into `vertices` (3 per triangle, length divisible
   *  by 3). LOCAL to this mesh; caller treats the whole buffer as a
   *  single draw. */
  indices: Uint32Array
  /** Per-mesh dequant step (metres) = `2*dequantHalf/0xFFFFFFFF`. */
  dequantScale: number
  /** Per-mesh symmetric residual half-range (metres), computed post-lift. */
  dequantHalf: number
}

// Float-slot indices derived from the single-source POLYGON_EXTRUDED_FORMAT
// spec (@xgis/compiler), so the bytes this writer produces cannot drift from
// the renderer's extrudedVertexBufferLayout (also derived from the spec) or
// the vs_main_ecef_extruded @location attributes (cross-checked in
// vertex-layout-consistency.test.ts). All offsets are 4-byte aligned, so
// byte offset / 4 == f32 slot index.
const STRIDE_FLOATS = POLYGON_EXTRUDED_FORMAT.stride / 4 // 11
const EXT_FID_FLOAT = vertexField(POLYGON_EXTRUDED_FORMAT, 'feature_id').offset / 4 // 3
const EXT_LON_FLOAT = vertexField(POLYGON_EXTRUDED_FORMAT, 'abs_lon').offset / 4 // 4
const EXT_LAT_FLOAT = vertexField(POLYGON_EXTRUDED_FORMAT, 'abs_lat').offset / 4 // 5
const EXT_FNORMAL_FLOAT = vertexField(POLYGON_EXTRUDED_FORMAT, 'face_normal').offset / 4 // 6 (x,y,z = 6,7,8)
const EXT_WALLH_FLOAT = vertexField(POLYGON_EXTRUDED_FORMAT, 'wall_height').offset / 4 // 9
const EXT_ISTOP_FLOAT = vertexField(POLYGON_EXTRUDED_FORMAT, 'is_top').offset / 4 // 10
const RAD2DEG_LOCAL = 180 / Math.PI
const EARTH_RADIUS_LOCAL = EARTH.sphereR // WGS84 semi-major axis; used ONLY for the
// Mercator longitude inverse (mx/A, basis-
// independent). The ECEF POSITION is ellipsoid
// via lonLatToECEF.

/** Build the ECEF extruded wall + roof mesh for a set of polygon
 *  features. Each feature emits:
 *
 *  - One side-wall quad per non-synthetic ring edge (4 verts + 2 tris).
 *    Synthetic tile-rect edges (clipper artefacts) are skipped via the
 *    same predicate as `generateWallMeshExtruded`.
 *  - One roof triangle fan per outer-ring + holes set, tessellated
 *    with earcut at the top height. All roof vertices carry
 *    `is_top = 1` and `face_normal = normalize(ecef_position)` (radial
 *    "up" from the Earth centre).
 *
 *  All vertices are converted to ECEF on the WGS84 ellipsoid
 *  (`N = A/sqrt(1 - E2*sin²lat)`, `ez = N*(1-E2)*sinLat`, via
 *  `lonLatToECEF`) — the SAME geoid the tiler's
 *  `packECEFPolygonVertices` uses for ground polygons, so wall/roof
 *  vertices share one geoid with the surrounding flat fill. Each ECEF
 *  vertex is then DSFUN-split relative to `tileEcefCenter` (also
 *  ellipsoid) so the GPU reconstructs sub-mm precision via
 *  `pos_h + pos_l`.
 *
 *  Wall outward normal: at each edge midpoint the lat/lon ENU basis is
 *  used to rotate `(north_component, -east_component, 0)` — a right-
 *  hand turn of the edge tangent in the local horizontal plane — into
 *  ECEF. Outer rings (CCW) and holes (CW) are handled identically
 *  because the ring orientation is normalised first (see `ccw` flag in
 *  `generateWallMeshExtruded`).
 *
 *  Heights / bases: per-feature `heights.get(fid)` and `bases.get(fid)`
 *  with **0 default** for missing entries. A feature with no height
 *  entry and no base entry still emits its roof (at h=0) and four
 *  degenerate-but-present wall quads (h=0, b=0). Callers that want a
 *  layer-level fallback height must pre-populate the heights map.
 *
 *  @param polygons        compiler-emitted ring polygons (tile-local
 *                         Mercator metres; ring[i] = [mx, my])
 *  @param heights         featId → top height in metres
 *  @param bases           featId → wall-base height in metres (Mapbox
 *                         `fill-extrusion-base`); pass `undefined` for
 *                         all-zero bases
 *  @param tileMx          tile origin Mercator x (metres) — added to
 *                         ring coords to get absolute Mercator x
 *  @param tileMy          tile origin Mercator y (metres)
 *  @param tileEcefCenter  ECEF RTC anchor (see `tileEcefCenterFromMerc`)
 */
export function generateWallMeshExtrudedECEF(
  polygons: RingPolygon[],
  heights: ReadonlyMap<number, number>,
  bases: ReadonlyMap<number, number> | undefined,
  _tileMx: number,
  _tileMy: number,
  tileEcefCenter: readonly [number, number, number],
): WallMeshExtrudedECEF {
  // NOTE: synthetic tile-rect edge detection (cf. `generateWallMeshExtruded`)
  // is intentionally OMITTED here. The signature locked by Phase 2 plan v4
  // does not carry `tileExtentM`, and inferring the tile extent from the
  // polygon-coordinate bbox would misclassify a building's outer ring as
  // "synthetic" whenever its bbox happens to touch the tile rect (as
  // observed in the unit test failures). The integration site (`vector-
  // tile-renderer.ts`) is responsible for handling tile-seam walls when it
  // swaps to this function in PR 2c.2; until then the function emits a
  // wall per EVERY ring edge, matching the Mercator path's pre-iter-448
  // behaviour.

  // ── Pass 1: size buffers ──
  let edgeCount = 0
  let roofTriCount = 0
  // Stash per-poly tessellation results so pass 2 doesn't redo earcut.
  const roofIndicesPerPoly: Uint32Array[] = []
  // Per-poly outer-ring + hole flat coordinate arrays in tile-local
  // Mercator (mx, my). We tessellate in this plane because at single-
  // tile scale the Mercator-vs-ECEF projective distortion is sub-pixel
  // even at z=0; the alternative (great-circle tessellation in lon/lat
  // with subdivision) is overkill for the current consumer.
  for (const poly of polygons) {
    // Edges (walls).
    for (const ring of poly.rings) {
      const len = ring.length
      if (len < 2) continue
      const closed = ring[0][0] === ring[len - 1][0] && ring[0][1] === ring[len - 1][1]
      const lastEdgeI = closed ? len - 1 : len
      edgeCount += lastEdgeI
    }
    // Roof tessellation: earcut over outer ring + holes.
    const rings = poly.rings
    if (rings.length === 0 || rings[0].length < 3) {
      roofIndicesPerPoly.push(new Uint32Array(0))
      continue
    }
    const flat: number[] = []
    const holeIdx: number[] = []
    const outer = rings[0]
    const outerLen = outer.length
    // Strip the closing duplicate if present (earcut handles either, but
    // strips give cleaner triangulation in pathological cases).
    const outerEnd =
      outerLen >= 2 &&
      outer[0][0] === outer[outerLen - 1][0] &&
      outer[0][1] === outer[outerLen - 1][1]
        ? outerLen - 1
        : outerLen
    for (let i = 0; i < outerEnd; i++) flat.push(outer[i][0], outer[i][1])
    for (let r = 1; r < rings.length; r++) {
      const hole = rings[r]
      const holeLen = hole.length
      if (holeLen < 3) continue
      holeIdx.push(flat.length / 2)
      const holeEnd =
        holeLen >= 2 && hole[0][0] === hole[holeLen - 1][0] && hole[0][1] === hole[holeLen - 1][1]
          ? holeLen - 1
          : holeLen
      for (let i = 0; i < holeEnd; i++) flat.push(hole[i][0], hole[i][1])
    }
    const tris = earcut(flat, holeIdx.length > 0 ? holeIdx : undefined)
    roofIndicesPerPoly.push(new Uint32Array(tris))
    roofTriCount += tris.length / 3
  }

  // Each wall = 4 verts + 6 indices. Each roof tri = 3 indices, with
  // its own dedicated vertex per polygon (roof verts are NOT shared
  // with walls because they carry a different face_normal).
  const wallVertCount = edgeCount * 4
  let roofVertCount = 0
  for (let p = 0; p < polygons.length; p++) {
    const rings = polygons[p].rings
    if (rings.length === 0 || rings[0].length < 3) continue
    // Count unique roof vertices (outer + holes, no closing duplicate).
    const outer = rings[0]
    const outerLen = outer.length
    const outerEnd =
      outerLen >= 2 &&
      outer[0][0] === outer[outerLen - 1][0] &&
      outer[0][1] === outer[outerLen - 1][1]
        ? outerLen - 1
        : outerLen
    roofVertCount += outerEnd
    for (let r = 1; r < rings.length; r++) {
      const hole = rings[r]
      const holeLen = hole.length
      if (holeLen < 3) continue
      const holeEnd =
        holeLen >= 2 && hole[0][0] === hole[holeLen - 1][0] && hole[0][1] === hole[holeLen - 1][1]
          ? holeLen - 1
          : holeLen
      roofVertCount += holeEnd
    }
  }
  const totalVerts = wallVertCount + roofVertCount
  const vertices = new Float32Array(totalVerts * STRIDE_FLOATS)
  const indices = new Uint32Array(edgeCount * 6 + roofTriCount * 3)

  // Per-vertex ECEF RTC residual (f64), stashed during emit so the per-mesh
  // quantization half-range can be computed AFTER the wall-lift (top-ring
  // residuals are larger than the flat footprint — see R2). Quantized into
  // the buffer's u16 lanes in a final pass once maxAbs is known.
  const resid = new Float64Array(totalVerts * 3)
  let maxAbs = 0

  // Write helper — stamps one vertex into `vertices` at slot vIdx.
  // mx, my are ABSOLUTE Mercator metres (same convention as
  // `generateWallMeshExtruded`, where ring coords are already absolute
  // and the function does `mx - tileMx` to derive tile-local). The
  // `tileMx`/`tileMy` parameters are unused for absolute→lon/lat
  // conversion but retained in the signature for symmetry with the
  // Mercator path and forward compatibility with synthetic-edge
  // detection that may need them.
  const writeVertex = (
    vIdx: number,
    mx: number,
    my: number,
    height: number,
    fid: number,
    fnX: number,
    fnY: number,
    fnZ: number,
    wallHeight: number,
    isTop: number,
  ): void => {
    const lonDeg = (mx / EARTH_RADIUS_LOCAL) * RAD2DEG_LOCAL
    const latRad = mercatorYToLatRad(my)
    const latDeg = latRad * RAD2DEG_LOCAL
    const ecef = lonLatToECEF(lonDeg, latDeg, height)
    // ECEF RTC residual (f64) — quantized in the final pass.
    const ax = ecef[0] - tileEcefCenter[0]
    const ay = ecef[1] - tileEcefCenter[1]
    const az = ecef[2] - tileEcefCenter[2]
    const r = vIdx * 3
    resid[r] = ax
    resid[r + 1] = ay
    resid[r + 2] = az
    const m = Math.max(Math.abs(ax), Math.abs(ay), Math.abs(az))
    if (m > maxAbs) maxAbs = m
    // f32 tail (position u16 lanes are written in the quantize pass below).
    const o = vIdx * STRIDE_FLOATS
    vertices[o + EXT_FID_FLOAT] = fid
    vertices[o + EXT_LON_FLOAT] = lonDeg
    vertices[o + EXT_LAT_FLOAT] = latDeg
    vertices[o + EXT_FNORMAL_FLOAT] = fnX
    vertices[o + EXT_FNORMAL_FLOAT + 1] = fnY
    vertices[o + EXT_FNORMAL_FLOAT + 2] = fnZ
    vertices[o + EXT_WALLH_FLOAT] = wallHeight
    vertices[o + EXT_ISTOP_FLOAT] = isTop
  }

  let vIdx = 0
  let idxOut = 0

  // ── Pass 2a: walls ──
  for (const poly of polygons) {
    const fid = poly.featId
    const h = heights.get(fid) ?? 0
    const b = bases?.get(fid) ?? 0
    for (let r = 0; r < poly.rings.length; r++) {
      const ring = poly.rings[r]
      const len = ring.length
      if (len < 2) continue
      const closed = ring[0][0] === ring[len - 1][0] && ring[0][1] === ring[len - 1][1]
      const lastEdgeI = closed ? len - 1 : len

      // Determine ring winding so outward-facing walls have consistent
      // front-face orientation (same as `generateWallMeshExtruded`).
      let signed2 = 0
      for (let i = 0; i < lastEdgeI; i++) {
        const j = (i + 1) % len
        signed2 += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1]
      }
      const ccw = signed2 > 0

      for (let i = 0; i < lastEdgeI; i++) {
        const j = (i + 1) % len
        const aIdx = ccw ? i : j
        const bIdx = ccw ? j : i
        const ax = ring[aIdx][0],
          ay = ring[aIdx][1]
        const bx = ring[bIdx][0],
          by = ring[bIdx][1]

        // Outward ECEF face_normal: rotate the edge tangent by -90° in
        // the local ENU East-North plane at the edge midpoint, then
        // map the ENU vector (east, north, 0) to ECEF via the ENU
        // basis vectors at that midpoint.
        //
        // Edge tangent in Mercator (mx, my) ≈ ENU (east, north) at
        // small extent (sphere-Mercator is conformal at the equator;
        // away from the equator the y axis stretches by 1/cos(lat) but
        // the DIRECTION of "north" in the (mx, my) plane is preserved
        // because Mercator's parametric curves are meridians and
        // parallels). So tx/ty in Mercator metres → east/north
        // direction (sign + ratio) is sufficient. We rotate (tx, ty)
        // by -90° to get the outward normal in the ENU horizontal
        // plane: (ty, -tx). Then re-express that ENU vector in ECEF
        // via the basis vectors at the midpoint lon/lat.
        const tx = bx - ax
        const ty = by - ay
        const tlen = Math.hypot(tx, ty)
        // Degenerate edge: skip (no triangle area).
        if (tlen === 0) continue
        // ENU outward in horizontal plane (right-hand turn of tangent).
        const enuE = ty / tlen
        const enuN = -tx / tlen

        // Midpoint lon/lat for the ENU basis (ring coords are
        // absolute Mercator, so no tile offset needed here).
        const midMx = 0.5 * (ax + bx)
        const midMy = 0.5 * (ay + by)
        const midLonRad = midMx / EARTH_RADIUS_LOCAL
        const midLatRad = mercatorYToLatRad(midMy)
        const sLon = Math.sin(midLonRad)
        const cLon = Math.cos(midLonRad)
        const sLat = Math.sin(midLatRad)
        const cLat = Math.cos(midLatRad)
        // ENU → ECEF: v_ecef = e * East + n * North + u * Up,
        // with basis vectors (see `ecefToENURotation` comment).
        // u_component is 0 (purely horizontal outward normal).
        const fnX = enuE * -sLon + enuN * (-sLat * cLon)
        const fnY = enuE * cLon + enuN * (-sLat * sLon)
        const fnZ = /* enuE * 0 */ enuN * cLat

        const baseV = vIdx
        // a_bot (is_top = 0, height = base b)
        writeVertex(vIdx++, ax, ay, b, fid, fnX, fnY, fnZ, h, 0)
        // b_bot
        writeVertex(vIdx++, bx, by, b, fid, fnX, fnY, fnZ, h, 0)
        // a_top (is_top = 1, height = base + feature height)
        writeVertex(vIdx++, ax, ay, b + h, fid, fnX, fnY, fnZ, h, 1)
        // b_top
        writeVertex(vIdx++, bx, by, b + h, fid, fnX, fnY, fnZ, h, 1)

        indices[idxOut++] = baseV + 0
        indices[idxOut++] = baseV + 1
        indices[idxOut++] = baseV + 2
        indices[idxOut++] = baseV + 1
        indices[idxOut++] = baseV + 3
        indices[idxOut++] = baseV + 2
      }
    }
  }

  // After pass 2a, `vIdx` is the actual wall vertex count (may be less
  // than the pre-counted `wallVertCount` if any zero-length edges were
  // skipped). Roof verts follow immediately at this offset.

  // ── Pass 2b: roof ──
  for (let p = 0; p < polygons.length; p++) {
    const poly = polygons[p]
    const rings = poly.rings
    if (rings.length === 0 || rings[0].length < 3) continue
    const fid = poly.featId
    const h = heights.get(fid) ?? 0
    const b = bases?.get(fid) ?? 0
    const topH = b + h
    const roofBaseV = vIdx
    const outer = rings[0]
    const outerLen = outer.length
    const outerEnd =
      outerLen >= 2 &&
      outer[0][0] === outer[outerLen - 1][0] &&
      outer[0][1] === outer[outerLen - 1][1]
        ? outerLen - 1
        : outerLen
    const writeRoofVert = (mx: number, my: number): void => {
      // Roof face_normal = SPHERE-radial up at (lon, lat): an intentional
      // LIGHTING approximation that ignores the ellipsoid's normal deflection
      // (≤ ~0.19° vs the true geodetic vertical) — visually indistinguishable
      // for roof shading. This is DISTINCT from the POSITION path, which now
      // uses the WGS84 ELLIPSOID (lonLatToECEF) so roof verts share one geoid
      // with the ground fill; only the lighting normal stays sphere-radial.
      // mx/my are ABSOLUTE Mercator.
      const lonRad = mx / EARTH_RADIUS_LOCAL
      const latRad = mercatorYToLatRad(my)
      const cLat = Math.cos(latRad)
      const sLat = Math.sin(latRad)
      const upX = cLat * Math.cos(lonRad)
      const upY = cLat * Math.sin(lonRad)
      const upZ = sLat
      writeVertex(vIdx++, mx, my, topH, fid, upX, upY, upZ, h, 1)
    }
    for (let i = 0; i < outerEnd; i++) writeRoofVert(outer[i][0], outer[i][1])
    for (let r = 1; r < rings.length; r++) {
      const hole = rings[r]
      const holeLen = hole.length
      if (holeLen < 3) continue
      const holeEnd =
        holeLen >= 2 && hole[0][0] === hole[holeLen - 1][0] && hole[0][1] === hole[holeLen - 1][1]
          ? holeLen - 1
          : holeLen
      for (let i = 0; i < holeEnd; i++) writeRoofVert(hole[i][0], hole[i][1])
    }
    // Append roof triangle indices, offset by roofBaseV.
    const roofTris = roofIndicesPerPoly[p]
    for (let t = 0; t < roofTris.length; t++) {
      indices[idxOut++] = roofBaseV + roofTris[t]
    }
  }

  // Shrink buffers to the actually-used range. The count pass and emit
  // pass for ROOF verts mirror each other exactly, so the only source
  // of over-allocation is zero-length WALL edges that pass 2a's
  // `if (tlen === 0) continue` dropped.
  const finalVertCount = vIdx
  const finalIdxCount = idxOut

  // ── Final pass: quantize position into the u16 lanes ──
  // Per-mesh symmetric half-range = exact max-abs residual (post-lift) +
  // epsilon (R1/R2). Encode each axis to 32-bit fixed point, split hi/lo.
  const dequantHalf = maxAbs + 1e-6
  const span = 2 * dequantHalf
  const dequantScale = span / 0xffffffff
  const invSpan = 0xffffffff / span
  const u16 = new Uint16Array(vertices.buffer)
  for (let v = 0; v < finalVertCount; v++) {
    const r = v * 3
    const lane = v * STRIDE_FLOATS * 2 // 2 u16 per f32 slot; pos = first 6 lanes
    for (let axis = 0; axis < 3; axis++) {
      let q = Math.round((resid[r + axis]! + dequantHalf) * invSpan)
      if (q < 0) q = 0
      else if (q > 0xffffffff) q = 0xffffffff
      u16[lane + axis * 2] = (q >>> 16) & 0xffff
      u16[lane + axis * 2 + 1] = q & 0xffff
    }
  }

  if (finalVertCount === totalVerts && finalIdxCount === indices.length) {
    return { vertices, indices, dequantScale, dequantHalf }
  }
  return {
    vertices: vertices.subarray(0, finalVertCount * STRIDE_FLOATS),
    indices: indices.subarray(0, finalIdxCount),
    dequantScale,
    dequantHalf,
  }
}
