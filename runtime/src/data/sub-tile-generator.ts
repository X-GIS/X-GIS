// Sub-tile generation — extracted from TileCatalog to keep that class
// focused on catalog state (cache, eviction, dispatch) rather than the
// CPU-side geometry clipping algorithm.
//
// At over-zoom past archive maxZoom, every visible tile that has no
// real archive entry is built from its closest indexed ancestor by
// clipping the parent's polygon / line / outline / point geometry
// into the sub-tile's rectangle. The clipper runs in tile-local
// Mercator-meter coordinates and re-packs vertex data into the
// sub-tile's own DSFUN local frame so the renderer's DSFUN camera
// uniform and boundary-detection both use the sub-tile origin —
// seamless joins across edges.
//
// Pure with respect to TileCatalog state: takes a parent TileData
// + sub-tile key, returns a fresh TileData. Stateless = unit-testable
// in isolation, no catalog setup required.

import {
  tileKeyUnpack, lonLatToMercF64,
  clipPolygonToRect, clipLineToRect,
  augmentRingWithArc, tessellateLineToArrays, packDSFUNLineVertices,
} from '@xgis/compiler'
import { type TileData, DSFUN_LINE_STRIDE } from './tile-types'

export class SubTileGenerator {
  /** Returns true if `parent` carries any geometry the sub-tile can be
   *  clipped from. Polygon-only, line-only (PMTiles 'roads'), point-only
   *  ('places'), or mixed all qualify — the previous early-exit only
   *  checked indices/lineIndices and silently dropped line-only slices
   *  at over-zoom. */
  hasClippableGeometry(parent: TileData | null | undefined): boolean {
    if (!parent) return false
    return parent.indices.length > 0
      || parent.lineIndices.length > 0
      || (parent.pointVertices !== undefined && parent.pointVertices.length >= 5)
  }

  /** Clip `parent`'s geometry into the sub-tile addressed by `subKey`,
   *  returning a fresh TileData with the sub-tile's own bounds + DSFUN
   *  local origin. Returns `null` when nothing survives the clip — caller
   *  should NOT cache an empty TileData (sub-tile gen retries on the
   *  next visible-tile pass).
   *
   *  Caller is responsible for budget gating and cache writes; this is
   *  pure clipping math, no catalog mutations. */
  generate(parent: TileData, subKey: number): TileData | null {
    const [sz, sx, sy] = tileKeyUnpack(subKey)
    const sn = Math.pow(2, sz)

    const subWest = sx / sn * 360 - 180
    const subEast = (sx + 1) / sn * 360 - 180
    const subSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (sy + 1) / sn))) * 180 / Math.PI
    const subNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * sy / sn))) * 180 / Math.PI

    // Parent vertices are stored as DSFUN tile-local Mercator meters
    // (high/low pairs). Sub-tile clip must run in the same Mercator-
    // meter space, so we convert every bound to meters and work with
    // reconstructed f64 values.
    const [parentMx, parentMy] = lonLatToMercF64(parent.tileWest, parent.tileSouth)
    const [subMxW, subMyS] = lonLatToMercF64(subWest, subSouth)
    const [subMxE, subMyN] = lonLatToMercF64(subEast, subNorth)
    const clipW = subMxW - parentMx
    const clipE = subMxE - parentMx
    const clipS = subMyS - parentMy
    const clipN = subMyN - parentMy

    // Re-origin offset: subtract from parent-local to get sub-tile-local.
    const reoriginX = clipW
    const reoriginY = clipS

    const splitLocal = (v: number): [number, number] => {
      const h = Math.fround(v)
      return [h, Math.fround(v - h)]
    }

    // Polygon vertex output: DSFUN stride-5 [mx_h, my_h, mx_l, my_l, feat_id].
    const verts = parent.vertices
    const outV: number[] = []
    const outI: number[] = []
    const outVKey = new Map<string, number>()
    // Quantize to ~1 cm to tolerate clipper noise — DSFUN vertices afford
    // tighter quantization than the old 10 cm tile-local-degree key.
    const pushDedupPV = (x: number, y: number, fid: number): number => {
      const k = `${Math.round(x * 100)},${Math.round(y * 100)},${fid}`
      const hit = outVKey.get(k)
      if (hit !== undefined) return hit
      const idx = outV.length / 5
      const [xH, xL] = splitLocal(x - reoriginX)
      const [yH, yL] = splitLocal(y - reoriginY)
      outV.push(xH, yH, xL, yL, fid)
      outVKey.set(k, idx)
      return idx
    }

    const readPV = (vi: number): [number, number, number] => {
      const off = vi * 5
      const x = verts[off] + verts[off + 2]
      const y = verts[off + 1] + verts[off + 3]
      const fid = verts[off + 4]
      return [x, y, fid]
    }

    for (let t = 0; t < parent.indices.length; t += 3) {
      const i0 = parent.indices[t], i1 = parent.indices[t + 1], i2 = parent.indices[t + 2]
      const [x0, y0, fid] = readPV(i0)
      const [x1, y1] = readPV(i1)
      const [x2, y2] = readPV(i2)

      const minX = Math.min(x0, x1, x2), maxX = Math.max(x0, x1, x2)
      const minY = Math.min(y0, y1, y2), maxY = Math.max(y0, y1, y2)
      if (maxX < clipW || minX > clipE || maxY < clipS || minY > clipN) continue

      if (minX >= clipW && maxX <= clipE && minY >= clipS && maxY <= clipN) {
        outI.push(pushDedupPV(x0, y0, fid), pushDedupPV(x1, y1, fid), pushDedupPV(x2, y2, fid))
        continue
      }

      const clipped = clipPolygonToRect([[[x0, y0], [x1, y1], [x2, y2]]], clipW, clipS, clipE, clipN)
      if (clipped.length === 0 || clipped[0].length < 3) continue
      const ring = clipped[0]
      const ringIdx: number[] = []
      for (const [x, y] of ring) ringIdx.push(pushDedupPV(x, y, fid))
      for (let j = 1; j < ring.length - 1; j++) outI.push(ringIdx[0], ringIdx[j], ringIdx[j + 1])
    }

    // Line clip (Liang-Barsky). DSFUN stride-10 reconstruction + dedup.
    const lineVerts = parent.lineVertices
    const lineIdx = parent.lineIndices
    const outLV: number[] = []
    const outLI: number[] = []
    const outLVKey = new Map<string, number>()
    const pushDedupLV = (x: number, y: number, fid: number, arc: number, tinX: number, tinY: number, toutX: number, toutY: number): number => {
      const k = `${Math.round(x * 100)},${Math.round(y * 100)},${fid}`
      const hit = outLVKey.get(k)
      if (hit !== undefined) return hit
      const idx = outLV.length / DSFUN_LINE_STRIDE
      const [xH, xL] = splitLocal(x - reoriginX)
      const [yH, yL] = splitLocal(y - reoriginY)
      outLV.push(xH, yH, xL, yL, fid, arc, tinX, tinY, toutX, toutY)
      outLVKey.set(k, idx)
      return idx
    }
    const readLV = (vi: number): [number, number, number, number, number, number, number, number] => {
      const off = vi * DSFUN_LINE_STRIDE
      const x = lineVerts[off] + lineVerts[off + 2]
      const y = lineVerts[off + 1] + lineVerts[off + 3]
      const fid = lineVerts[off + 4]
      const arc = lineVerts[off + 5]
      const tinX = lineVerts[off + 6] ?? 0, tinY = lineVerts[off + 7] ?? 0
      const toutX = lineVerts[off + 8] ?? 0, toutY = lineVerts[off + 9] ?? 0
      return [x, y, fid, arc, tinX, tinY, toutX, toutY]
    }

    for (let s = 0; s < lineIdx.length; s += 2) {
      const a = lineIdx[s], b = lineIdx[s + 1]
      const [ax, ay, afid, aarc, atinX, atinY, atoutX, atoutY] = readLV(a)
      const [bx, by, , barc, btinX, btinY, btoutX, btoutY] = readLV(b)

      if (Math.max(ax, bx) < clipW || Math.min(ax, bx) > clipE ||
          Math.max(ay, by) < clipS || Math.min(ay, by) > clipN) continue

      if (ax >= clipW && ax <= clipE && ay >= clipS && ay <= clipN &&
          bx >= clipW && bx <= clipE && by >= clipS && by <= clipN) {
        const ia = pushDedupLV(ax, ay, afid, aarc, atinX, atinY, atoutX, atoutY)
        const ib = pushDedupLV(bx, by, afid, barc, btinX, btinY, btoutX, btoutY)
        if (ia !== ib) outLI.push(ia, ib)
        continue
      }

      const dx = bx - ax, dy = by - ay
      let tMin = 0, tMax = 1
      let valid = true
      const clipEdge = (p: number, q: number): void => {
        if (!valid) return
        if (Math.abs(p) < 1e-15) { if (q < 0) valid = false; return }
        const r = q / p
        if (p < 0) { if (r > tMax) valid = false; else if (r > tMin) tMin = r }
        else       { if (r < tMin) valid = false; else if (r < tMax) tMax = r }
      }
      clipEdge(-dx, ax - clipW)
      clipEdge(dx, clipE - ax)
      clipEdge(-dy, ay - clipS)
      clipEdge(dy, clipN - ay)
      if (!valid || tMax - tMin < 1e-10) continue

      const darc = barc - aarc
      // Mid-segment clip points: zero tangent → runtime boundary fallback.
      // Original vertices (tMin≈0 / tMax≈1): preserve tangent for cross-tile joins.
      const p0tinX = tMin < 1e-10 ? atinX : 0, p0tinY = tMin < 1e-10 ? atinY : 0
      const p0toutX = tMin < 1e-10 ? atoutX : 0, p0toutY = tMin < 1e-10 ? atoutY : 0
      const p1tinX = tMax > 1 - 1e-10 ? btinX : 0, p1tinY = tMax > 1 - 1e-10 ? btinY : 0
      const p1toutX = tMax > 1 - 1e-10 ? btoutX : 0, p1toutY = tMax > 1 - 1e-10 ? btoutY : 0
      const ia = pushDedupLV(ax + tMin * dx, ay + tMin * dy, afid, aarc + tMin * darc, p0tinX, p0tinY, p0toutX, p0toutY)
      const ib = pushDedupLV(ax + tMax * dx, ay + tMax * dy, afid, aarc + tMax * darc, p1tinX, p1tinY, p1toutX, p1toutY)
      if (ia !== ib) outLI.push(ia, ib)
    }

    // Polygon outlines: route through the SAME augment + clip + tessellate
    // pipeline used by line features so dash phase + pattern arc stay
    // continuous across the sub-tile boundary. The previous per-segment
    // Liang-Barsky on parent.outlineIndices reset arc_start at every
    // sub-tile clip, surfacing as the dash bug at high zooms.
    //
    // We need the original ring data (parent.polygons) for arc continuity
    // — parent.outlineIndices are stride-5 (no arc, no tangents) and
    // walking them per-tile gives the buggy reset behaviour. When
    // parent.polygons is absent (e.g. a sub-tile of a sub-tile that
    // dropped polygons during its own re-pack), we fall back to the old
    // legacy path — dash bug recurs there but no visible regression vs.
    // previous behaviour.
    const olvScratch: number[] = []
    const oliScratch: number[] = []
    if (parent.polygons && parent.polygons.length > 0) {
      for (const poly of parent.polygons) {
        for (const ring of poly.rings) {
          if (ring.length < 3) continue
          const arcRing = augmentRingWithArc(ring)
          if (arcRing.length < 2) continue
          const segments = clipLineToRect(arcRing, subMxW, subMyS, subMxE, subMyN)
          for (const seg of segments) {
            if (seg.length >= 2) {
              tessellateLineToArrays(seg, poly.featId, olvScratch, oliScratch)
            }
          }
        }
      }
    }
    const outlineVertices = olvScratch.length > 0
      ? packDSFUNLineVertices(olvScratch, subMxW, subMyS)
      : new Float32Array(0)
    const outlineLineIndices = new Uint32Array(oliScratch)

    // Point clip. Parent point vertices are stride-5 DSFUN
    // [mx_h, my_h, mx_l, my_l, fid] in PARENT-local Mercator meters;
    // reconstruct, test against (clipW..clipN), re-pack into SUB-tile-
    // local DSFUN. Without this, point layers (place labels, POIs)
    // vanish at over-zoom because they have no representation in
    // sub-tile.
    let subPointVertices: Float32Array | undefined
    if (parent.pointVertices && parent.pointVertices.length >= 5) {
      const pv = parent.pointVertices
      const out: number[] = []
      for (let i = 0; i < pv.length; i += 5) {
        const px = pv[i] + pv[i + 2]
        const py = pv[i + 1] + pv[i + 3]
        if (px < clipW || px > clipE || py < clipS || py > clipN) continue
        const lx = px - reoriginX
        const ly = py - reoriginY
        const xH = Math.fround(lx); const xL = Math.fround(lx - xH)
        const yH = Math.fround(ly); const yL = Math.fround(ly - yH)
        out.push(xH, yH, xL, yL, pv[i + 4])
      }
      if (out.length >= 5) subPointVertices = new Float32Array(out)
    }

    return {
      vertices: new Float32Array(outV),
      indices: new Uint32Array(outI),
      lineVertices: new Float32Array(outLV),
      lineIndices: new Uint32Array(outLI),
      outlineIndices: new Uint32Array(0),
      outlineVertices: outlineVertices.length > 0 ? outlineVertices : undefined,
      outlineLineIndices: outlineLineIndices.length > 0 ? outlineLineIndices : undefined,
      pointVertices: subPointVertices,
      tileWest: subWest,
      tileSouth: subSouth,
      tileWidth: subEast - subWest,
      tileHeight: subNorth - subSouth,
      tileZoom: sz,
      // Forward parent's ring data so further over-zoom of THIS sub-tile
      // can also use the global-arc outline path (otherwise grand-child
      // sub-tiles fall back to the legacy outlineIndices and the dash
      // bug recurs at very high zoom levels).
      polygons: parent.polygons,
    }
  }
}
