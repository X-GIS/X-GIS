// ═══ Point feature packer (stateless) ═══
//
// Single authority for assembling the per-point stride-24 `feat_data` record,
// the world-copy fan-out, the per-instance quad verts/indices, and the
// translucent back-to-front depth sort. Extracted from PointRenderer so the
// inline GeoJSON path (PointRenderer.uploadLayer) and — in later stages — the
// tile path (flushTilePoints) share ONE record-assembly authority instead of
// two hand-mirrored copies.
//
// STATELESS pure functions only — no module-level mutable state, no reflect(),
// no *-uniform-slots. The caller owns the arena allocation + GPU buffer
// create/write; the packer only FILLS the pre-allocated typed arrays. This keeps
// it clear of the #612 eager-reflect crash class (see point-renderer.ts header).

import { lonLatToECEF } from '@xgis/engine'

/** Per-feature `feat_data` stride in f32 slots. Mirrors point.ts STRIDE (24):
 *  slots 0-10 style, 11-16 ECEF DSFUN hi/lo, 17-18 abs lon/lat, 19 shape_id,
 *  20-23 absolute-Mercator DSFUN tail. */
export const POINT_FEAT_STRIDE = 24

const DEG2RAD = Math.PI / 180
const R_MERC = 6378137 // web-Mercator sphere radius (matches the tiler packer)

/**
 * Returns the Mercator x (in metres) for a point at `lon` (degrees) in
 * world-copy `wo`.  `wo = 0` is the primary world; `wo = ±1, ±2, …` shift
 * by one full world-width (360° × DEG2RAD × R_MERC) each.
 * The caller is responsible for splitting into hi/lo f32 DSFUN slots.
 */
export function worldCopyMercX(lon: number, wo: number): number {
  return lon * DEG2RAD * R_MERC + wo * 360 * DEG2RAD * R_MERC
}

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
  /** Per-point longitude (degrees), indexed `[0, count)`. */
  readonly lons: ArrayLike<number>
  /** Per-point latitude (degrees), indexed `[0, count)`. */
  readonly lats: ArrayLike<number>
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
  const { count: N, copies, isTranslucent, fwdX, fwdY, srcFeatData, lons, lats } = input
  const { verts, u32, idx, feat, depths } = out
  const S = POINT_FEAT_STRIDE
  const totalPoints = N * copies.length

  // Pre-compute each instance's view-forward depth so we can write the index
  // buffer in back-to-front order. Only translucent layers need this (opaque
  // depth-test handles occlusion); for opaque we keep feature-index order.
  const order = isTranslucent ? new Uint32Array(totalPoints) : null

  for (let w = 0; w < copies.length; w++) {
    const basePoint = w * N

    for (let i = 0; i < N; i++) {
      const lon = lons[i]
      const lat = lats[i]

      // ECEF DSFUN: absolute ECEF with hi/lo split around origin.
      const ecef = lonLatToECEF(lon, lat)
      const exH = Math.fround(ecef[0]); const exL = ecef[0] - exH
      const eyH = Math.fround(ecef[1]); const eyL = ecef[1] - eyH
      const ezH = Math.fround(ecef[2]); const ezL = ecef[2] - ezH

      // Copy style data from original (slots 0-10)
      const srcOff = i * S
      const globalIdx = basePoint + i
      const dstOff = globalIdx * S
      feat.set(srcFeatData.subarray(srcOff, srcOff + 11), dstOff)
      // ECEF DSFUN at slots 11-16, abs_lon/lat at 17-18, shape_id at 19
      feat[dstOff + 11] = exH; feat[dstOff + 12] = eyH; feat[dstOff + 13] = ezH
      feat[dstOff + 14] = exL; feat[dstOff + 15] = eyL; feat[dstOff + 16] = ezL
      feat[dstOff + 17] = lon; feat[dstOff + 18] = lat
      feat[dstOff + 19] = srcFeatData[srcOff + 19] // shape_id
      // Absolute Mercator DSFUN (20-23) — precise flat-Mercator position.
      // For world copies (projType 0) apply a per-copy longitude offset
      // of wo*360° in Mercator metres so the point appears in every visible
      // world repeat.  The ECEF/abs_lon branches above are copy-independent
      // (absolute 3D position) and are left unchanged.
      const wo = copies[w]
      const mx = worldCopyMercX(lon, wo)
      const myClamp = Math.max(-85.051129, Math.min(85.051129, lat))
      const my = Math.log(Math.tan(Math.PI / 4 + myClamp * DEG2RAD / 2)) * R_MERC
      const mxH = Math.fround(mx); const myH = Math.fround(my)
      feat[dstOff + 20] = mxH; feat[dstOff + 21] = Math.fround(mx - mxH)
      feat[dstOff + 22] = myH; feat[dstOff + 23] = Math.fround(my - myH)

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
        depths[globalIdx] = exH * fwdX + eyH * fwdY
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
