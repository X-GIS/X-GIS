// ═══ Point feature packer (stateless) ═══
//
// Single authority for assembling the per-point stride-24 `feat_data` record,
// the world-copy fan-out, the per-instance quad verts/indices, and the
// translucent back-to-front depth sort. Shared by BOTH point paths:
//   • inline GeoJSON  (PointRenderer.uploadLayer) — `{ kind: 'lonlat' }`
//   • tile / PMTiles  (PointRenderer.flushTilePoints, #722 S1) — `{ kind: 'presplit' }`
// instead of two hand-mirrored copies. The ONLY per-path divergence is the
// per-point POSITION source (slots 11-18 ECEF+abs, 20-23 Mercator); it is
// branched ONCE outside the loop via the `PackPointPosition` discriminated
// union (never a per-point callback — the hot loop stays allocation-free of
// closures). Style slots (0-10) + shape_id (19), the quad verts/indices, the
// fan-out and the translucent sort are identical for both.
//
// STATELESS pure functions only — no module-level mutable state, no reflect(),
// no *-uniform-slots. The caller owns the arena allocation + GPU buffer
// create/write; the packer only FILLS the pre-allocated typed arrays. This keeps
// it clear of the #612 eager-reflect crash class (see point-renderer.ts header).

import { lonLatToECEF } from '@xgis/engine'

/** Per-feature `feat_data` stride in f32 slots. Mirrors point.ts STRIDE (24):
 *  slots 0-10 style, 11-16 ECEF DSFUN hi/lo, 17-18 abs lon/lat, 19 shape_id,
 *  20-23 absolute-Mercator DSFUN tail. */
import { POINT_FEAT, POINT_FEAT_STYLE_SLOTS } from '../shaders/dsl/point-feat-layout'
const F = POINT_FEAT.slot
/** Re-export of POINT_FEAT.stride — the layout authority is point-feat-layout.ts (#740 R8). */
export const POINT_FEAT_STRIDE = POINT_FEAT.stride

const DEG2RAD = Math.PI / 180
const R_MERC = 6378137 // web-Mercator sphere radius (matches the tiler packer)
/** One full Mercator world-width in metres (2π·R_MERC). This is EXACTLY the
 *  per-`wo` shift {@link worldCopyMercX} adds (its `wo * 360 * DEG2RAD * R_MERC`
 *  term), so the inline path (worldCopyMercX) and the tile path
 *  ({@link mercXForCopy}) place a given point in a given world copy at
 *  byte-identical Mercator-x. */
const WORLD_WIDTH = 360 * DEG2RAD * R_MERC

/**
 * Returns the Mercator x (in metres) for a point at `lon` (degrees) in
 * world-copy `wo`.  `wo = 0` is the primary world; `wo = ±1, ±2, …` shift
 * by one full world-width (360° × DEG2RAD × R_MERC) each.
 * The caller is responsible for splitting into hi/lo f32 DSFUN slots.
 */
export function worldCopyMercX(lon: number, wo: number): number {
  return lon * DEG2RAD * R_MERC + wo * 360 * DEG2RAD * R_MERC
}

/**
 * Shift a pre-split absolute-Mercator-x DSFUN pair into world-copy `wo`.
 * Reconstructs `mx = mxHi + mxLo`, adds `wo * WORLD_WIDTH`, and re-splits with
 * `Math.fround`. For the tile path (whose points arrive with the compiler's
 * pre-split Mercator DSFUN) this is the analogue of `worldCopyMercX` for the
 * inline path: `mercXForCopy(split(merc(lon)), wo)` reconstructs to
 * `worldCopyMercX(lon, wo)`. At `wo = 0` it round-trips the input pair
 * byte-identically over the Mercator-x domain, so the single-visible-copy
 * (high-zoom) tile path stays byte-identical to the legacy direct write.
 */
export function mercXForCopy(mxHi: number, mxLo: number, wo: number): [number, number] {
  const mx = mxHi + mxLo + wo * WORLD_WIDTH
  const hi = Math.fround(mx)
  return [hi, Math.fround(mx - hi)]
}

/**
 * A tile point carrying the compiler's pre-split DSFUN (structural subset of
 * `PointRenderer.tilePoints[i]`). ECEF (`exH…ezL`) and abs lon/lat are
 * world-copy-INDEPENDENT (absolute 3D position); only Mercator-x shifts per
 * copy. Passed through the packer unchanged except for the per-copy Mercator-x
 * re-split via {@link mercXForCopy}.
 */
export interface TilePointLike {
  readonly exH: number; readonly eyH: number; readonly ezH: number
  readonly exL: number; readonly eyL: number; readonly ezL: number
  readonly absLon: number; readonly absLat: number
  readonly mxH: number; readonly mxL: number
  readonly myH: number; readonly myL: number
}

/**
 * Per-point POSITION source — the SOLE inline/tile divergence. Branched once
 * outside the pack loop (never per point) so both paths share every other write.
 *  • `lonlat`   — inline GeoJSON: ECEF from lon/lat + per-copy `worldCopyMercX`.
 *  • `presplit` — tile: pass-through pre-split ECEF/abs + per-copy Mercator-x.
 */
export type PackPointPosition =
  | { readonly kind: 'lonlat'; readonly lons: ArrayLike<number>; readonly lats: ArrayLike<number> }
  | { readonly kind: 'presplit'; readonly points: readonly TilePointLike[] }

/** Immutable per-call inputs to {@link packPointInstances}. */
export interface PackPointInput {
  /** Number of source points in the layer. */
  readonly count: number
  /** World-copy offsets to fan out to (`[0]` = single primary world). */
  readonly copies: readonly number[]
  /** Translucent layers get the back-to-front depth sort + a `depths` buffer. */
  readonly isTranslucent: boolean
  /** View-forward ground-plane vector (from camera bearing/pitch) for the sort. */
  readonly fwdX: number
  readonly fwdY: number
  /** The layer's stride-24 `feat_data` (slots 0-10 style + slot 19 shape_id). */
  readonly srcFeatData: Float32Array
  /** Per-point position — `lonlat` (inline) or `presplit` (tile). */
  readonly position: PackPointPosition
}

/** Pre-allocated output buffers filled by {@link packPointInstances}. */
export interface PackPointOutput {
  /** Quad vertices, `totalPoints × 4 × 4` f32. */
  readonly verts: Float32Array
  /** Uint32 alias of `verts.buffer` (quad_id is written as a u32 element). */
  readonly u32: Uint32Array
  /** Quad indices, `totalPoints × 6` u32. */
  readonly idx: Uint32Array
  /** Per-instance `feat_data`, `totalPoints × POINT_FEAT_STRIDE` f32. */
  readonly feat: Float32Array
  /** Depth-sort keys, `totalPoints` f32 — non-null iff `isTranslucent`. */
  readonly depths: Float32Array | null
}

/**
 * Fills the pre-allocated `out` typed arrays with the stride-24 point records,
 * world-copy fan-out, per-instance quad verts/indices, and (for translucent
 * layers) the back-to-front depth-sorted index order. Returns `totalPoints`
 * (`count × copies.length`).
 *
 * Byte-identical to the legacy inline PointRenderer.uploadLayer packing — every
 * `Math.fround` / clamp / slot write is preserved exactly (a real-GPU DC=0 gate
 * follows). The caller owns the arena allocation + GPU buffer create/write.
 */
export function packPointInstances(input: PackPointInput, out: PackPointOutput): number {
  const { count: N, copies, isTranslucent, fwdX, fwdY, srcFeatData, position } = input
  const { verts, u32, idx, feat, depths } = out
  const S = POINT_FEAT_STRIDE
  const totalPoints = N * copies.length

  // Pre-compute each instance's view-forward depth so we can write the index
  // buffer in back-to-front order. Only translucent layers need this (opaque
  // depth-test handles occlusion); for opaque we keep feature-index order.
  const order = isTranslucent ? new Uint32Array(totalPoints) : null

  // ── Pass 0: SHARED style slots (0-10) + shape_id (19), copied from the caller's
  // per-point source BEFORE Pass 1 writes position. This ordering is LOAD-BEARING:
  // the caller's `srcFeatData` is PointRenderer's frame-arena-backed
  // `layer.featData`, which ALIASES `feat` (also a frame-arena allocation reused
  // each render() via beginFrame) — for one point, `layer.featData[0]` overlaps
  // `feat[22]` (the Mercator-y hi slot). Reading the style source BEFORE the Pass-1
  // Mercator write preserves the read-before-write ordering the legacy interleaved
  // loop relied on; the reverse (position-then-copy) order corrupted slot 0 (radius)
  // with the Mercator-y tail — the circle-radius-wiring.test.ts regression. ──
  for (let w = 0; w < copies.length; w++) {
    const basePoint = w * N
    for (let i = 0; i < N; i++) {
      const srcOff = i * S
      const dstOff = (basePoint + i) * S
      feat.set(srcFeatData.subarray(srcOff, srcOff + POINT_FEAT_STYLE_SLOTS), dstOff)
      feat[dstOff + F.shape_id] = srcFeatData[srcOff + F.shape_id]
    }
  }

  // ── Pass 1: POSITION slots (11-16 ECEF, 17-18 abs lon/lat, 20-23 Mercator).
  // The discriminated position source is branched ONCE here — never per point —
  // so the hot loop carries no closure/allocation for the per-path math. The
  // inline (lonlat) branch keeps its exact former arithmetic (byte-identical);
  // the tile (presplit) branch passes the compiler's pre-split ECEF + abs
  // lon/lat through unchanged (both copy-independent) and re-splits only
  // Mercator-x per world copy. ──
  if (position.kind === 'lonlat') {
    const { lons, lats } = position
    for (let w = 0; w < copies.length; w++) {
      const basePoint = w * N
      const wo = copies[w]
      for (let i = 0; i < N; i++) {
        const lon = lons[i]
        const lat = lats[i]
        // ECEF DSFUN: absolute ECEF with hi/lo split around origin.
        const ecef = lonLatToECEF(lon, lat)
        const exH = Math.fround(ecef[0]); const exL = ecef[0] - exH
        const eyH = Math.fround(ecef[1]); const eyL = ecef[1] - eyH
        const ezH = Math.fround(ecef[2]); const ezL = ecef[2] - ezH
        const dstOff = (basePoint + i) * S
        feat[dstOff + F.ecef_x_h] = exH; feat[dstOff + F.ecef_y_h] = eyH; feat[dstOff + F.ecef_z_h] = ezH
        feat[dstOff + F.ecef_x_l] = exL; feat[dstOff + F.ecef_y_l] = eyL; feat[dstOff + F.ecef_z_l] = ezL
        feat[dstOff + F.abs_lon] = lon; feat[dstOff + F.abs_lat] = lat
        // Absolute Mercator DSFUN (20-23) — precise flat-Mercator position.
        // For world copies (projType 0) apply a per-copy longitude offset of
        // wo*360° in Mercator metres so the point appears in every visible
        // world repeat. ECEF/abs_lon above are copy-independent.
        const mx = worldCopyMercX(lon, wo)
        const myClamp = Math.max(-85.051129, Math.min(85.051129, lat))
        const my = Math.log(Math.tan(Math.PI / 4 + myClamp * DEG2RAD / 2)) * R_MERC
        const mxH = Math.fround(mx); const myH = Math.fround(my)
        feat[dstOff + F.merc_x_h] = mxH; feat[dstOff + F.merc_x_l] = Math.fround(mx - mxH)
        feat[dstOff + F.merc_y_h] = myH; feat[dstOff + F.merc_y_l] = Math.fround(my - myH)
      }
    }
  } else {
    const pts = position.points
    for (let w = 0; w < copies.length; w++) {
      const basePoint = w * N
      const wo = copies[w]
      for (let i = 0; i < N; i++) {
        const pt = pts[i]
        const dstOff = (basePoint + i) * S
        // ECEF DSFUN + abs lon/lat are copy-independent — passed through as-is.
        feat[dstOff + F.ecef_x_h] = pt.exH; feat[dstOff + F.ecef_y_h] = pt.eyH; feat[dstOff + F.ecef_z_h] = pt.ezH
        feat[dstOff + F.ecef_x_l] = pt.exL; feat[dstOff + F.ecef_y_l] = pt.eyL; feat[dstOff + F.ecef_z_l] = pt.ezL
        feat[dstOff + F.abs_lon] = pt.absLon; feat[dstOff + F.abs_lat] = pt.absLat
        // Only Mercator-x shifts per world copy; Mercator-y is copy-independent.
        const [mxH, mxL] = mercXForCopy(pt.mxH, pt.mxL, wo)
        feat[dstOff + F.merc_x_h] = mxH; feat[dstOff + F.merc_x_l] = mxL
        feat[dstOff + F.merc_y_h] = pt.myH; feat[dstOff + F.merc_y_l] = pt.myL
      }
    }
  }

  // ── Pass 2: per-instance quad verts + the depth key / opaque index order — all
  // position-independent (style slots 0-10/19 were copied in Pass 0). The depth key
  // reads back the ECEF hi lanes (slots 11/12) Pass 1 wrote, so it stays
  // byte-identical to the former `exH * fwdX + eyH * fwdY`. ──
  for (let w = 0; w < copies.length; w++) {
    const basePoint = w * N
    for (let i = 0; i < N; i++) {
      const globalIdx = basePoint + i
      const dstOff = globalIdx * S

      // Build quad vertices
      const vBase = globalIdx * 4 * 4
      for (let q = 0; q < 4; q++) {
        const off = vBase + q * 4
        verts[off + 0] = 0
        verts[off + 1] = 0
        u32[off + 2] = q
        verts[off + 3] = globalIdx
      }

      // Depth sort key: use ECEF z-component as a proxy for back-to-front.
      // (more negative ez_h = further from viewer in most projections)
      if (depths && order) {
        depths[globalIdx] = feat[dstOff + F.ecef_x_h] * fwdX + feat[dstOff + F.ecef_y_h] * fwdY
        order[globalIdx] = globalIdx
      } else {
        // Feature-order indices for opaque layers.
        const iBase = globalIdx * 6
        const vIdx = globalIdx * 4
        idx[iBase] = vIdx; idx[iBase + 1] = vIdx + 1; idx[iBase + 2] = vIdx + 2
        idx[iBase + 3] = vIdx; idx[iBase + 4] = vIdx + 2; idx[iBase + 5] = vIdx + 3
      }
    }
  }

  // Back-to-front: larger depth first. Sorted order[p] gives the
  // globalIdx to emit at draw position p.
  if (depths && order) {
    const arr = Array.from(order)
    arr.sort((a, b) => depths[b] - depths[a])
    for (let p = 0; p < totalPoints; p++) {
      const globalIdx = arr[p]
      const iBase = p * 6
      const vIdx = globalIdx * 4
      idx[iBase] = vIdx; idx[iBase + 1] = vIdx + 1; idx[iBase + 2] = vIdx + 2
      idx[iBase + 3] = vIdx; idx[iBase + 4] = vIdx + 2; idx[iBase + 5] = vIdx + 3
    }
  }

  return totalPoints
}
