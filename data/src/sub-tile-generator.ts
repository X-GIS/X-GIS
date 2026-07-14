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

import { EARTH } from '@xgis/shared'
import {
  tileKeyUnpack,
  lonLatToMercF64,
  clipPolygonToRect,
  clipLineToRect,
  augmentRingWithArc,
  tessellateLineToArrays,
  packDSFUNLineVertices,
  packECEFPolygonVertices,
  packECEFPointFeatures,
  extractNonSyntheticArcs,
  makeSameBoundarySidePredicateMerc,
  type RingPolygon,
} from '@xgis/compiler'
import { type TileData, DSFUN_LINE_STRIDE } from './tile-types'
import { clipRingPolygonToWindow } from './clip-ring-polygon'

// ECEF stride-9 layout for polygon vertices (PR 2c.2):
//   [ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, fid, abs_lon_deg, abs_lat_deg]
// #398: parent polygon vertices are the quantized ECEF layout — stride 28
// bytes = 7 floats. Only the f32 tail (fid/abs_lon/abs_lat at float slots
// 3/4/5; true_lat @6 is re-derived by the re-pack, not read here) is read; the
// quantized u16 position (first 12 bytes) is never touched — the clipper
// reprojects via the tile-local Mercator tail.
const ECEF_POLY_STRIDE = 7
// WGS84 sphere radius for the abs_lon / Mercator inverse round-trip.
const ECEF_EARTH_R = EARTH.sphereR
const ECEF_DEG2RAD = Math.PI / 180
const ECEF_LAT_LIMIT = 85.051129

export class SubTileGenerator {
  /** iter-247 (Plan AAA B.2) — scratch fields. Pre-iter-247 every
   *  `generate()` call allocated 4 fresh `number[]` (outV/outI/outLV/
   *  outLI) + 2 `Map<string, number>` (outVKey/outLVKey) + 2 fresh
   *  number[] for outline (olvScratch/oliScratch). During zoom-
   *  transition cascades (over-zoom past archive maxLevel) the
   *  function fires per visible sub-tile — easily 30+ calls / frame
   *  on a typical pan into a deep-zoom region. The number[] arrays
   *  grow via push() with V8 internal capacity doubling, each grow
   *  allocating new backing storage; the Maps allocate hash buckets.
   *
   *  Hoisted to instance fields, cleared at the start of each
   *  generate() call. V8 retains the number[] backing array and the
   *  Map's hash buckets across clears, so amortized allocation drops
   *  to zero after the first call establishes peak size.
   *
   *  Lifetime: scoped to one generate() call. Final output is copied
   *  into `new Float32Array(outV)` etc. before return, so the
   *  permanent TileData doesn't depend on the scratch state. */
  private readonly _scratchOutV: number[] = []
  private readonly _scratchOutI: number[] = []
  private readonly _scratchOutVKey = new Map<string, number>()
  private readonly _scratchOutLV: number[] = []
  private readonly _scratchOutLI: number[] = []
  private readonly _scratchOutLVKey = new Map<string, number>()
  /** iter-250 — outline scratch arrays. olvScratch is `number[]`
   *  passed to `tessellateLineToArrays` which pushes vertices into
   *  it; oliScratch carries the index list. Each pre-iter-250
   *  generate() call allocated fresh arrays — hoist mirrors the
   *  iter-247 polygon scratch pattern. */
  private readonly _scratchOlv: number[] = []
  private readonly _scratchOli: number[] = []

  /** Returns true if `parent` carries any geometry the sub-tile can be
   *  clipped from. Polygon-only, line-only (PMTiles 'roads'), point-only
   *  ('places'), or mixed all qualify — the previous early-exit only
   *  checked indices/lineIndices and silently dropped line-only slices
   *  at over-zoom. */
  hasClippableGeometry(parent: TileData | null | undefined): boolean {
    if (!parent) return false
    return (
      parent.indices.length > 0 ||
      parent.lineIndices.length > 0 ||
      (parent.pointVertices !== undefined && parent.pointVertices.length >= 13)
    )
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

    const subWest = (sx / sn) * 360 - 180
    const subEast = ((sx + 1) / sn) * 360 - 180
    const subSouth = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (sy + 1)) / sn))) * 180) / Math.PI
    const subNorth = (Math.atan(Math.sinh(Math.PI * (1 - (2 * sy) / sn))) * 180) / Math.PI

    // Parent vertices are stored as DSFUN tile-local Mercator meters
    // (high/low pairs). Sub-tile clip must run in the same Mercator-
    // meter space, so we convert every bound to meters and work with
    // reconstructed f64 values.
    const [parentMx, parentMy] = lonLatToMercF64(parent.tileWest, parent.tileSouth)
    const [parentMxE, parentMyN] = lonLatToMercF64(
      parent.tileWest + parent.tileWidth,
      parent.tileSouth + parent.tileHeight,
    )
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

    // Polygon vertex INPUT layout (#398): quantized ECEF stride 28 bytes =
    // 7 floats — uint16×6 position (first 12 bytes) + f32 fid/abs_lon/abs_lat/
    // true_lat at float slots 3/4/5/6. The clipper still runs in tile-local Mercator
    // metres, so we recover Mercator from the packed `abs_lon, abs_lat` slots
    // (sub-mm round-trip per `ecef-precision-fuzz.test.ts` AC2c.2.3) instead
    // of dequantizing + inverting ECEF → lon/lat via Bowring iteration. The
    // quantized position is never read here.
    //
    // The sub-tile OUTPUT also ships stride-9 ECEF so the renderer's
    // ECEF VS reads the same layout for parent + sub-tile. Each output
    // vertex's `pos_h, pos_l` are DSFUN-split against the SUB-tile's own
    // ECEF anchor (computed below) so the same `u.mvp * vec4(pos_h +
    // pos_l, 1)` math works without re-anchoring (post PR 2d.5 closeout).
    const verts = parent.vertices
    const subClampLat = Math.max(-ECEF_LAT_LIMIT, Math.min(ECEF_LAT_LIMIT, subSouth))
    const subTileMx = subWest * ECEF_DEG2RAD * ECEF_EARTH_R
    const subTileMy =
      Math.log(Math.tan(Math.PI / 4 + (subClampLat * ECEF_DEG2RAD) / 2)) * ECEF_EARTH_R
    // WGS84 ellipsoidal ECEF anchor — must match the compiler tiler's
    // `tileEcefCenter` math (cross-package import forbidden in worker
    // threads; values are bit-identical to runtime/projection/ecef.ts's
    // `tileEcefCenterFromMerc`).
    const subTileEcefCenter = ((): readonly [number, number, number] => {
      const E2_ = EARTH.e2
      const subTileLonRad = subTileMx / ECEF_EARTH_R
      const subTileLatRad = 2 * Math.atan(Math.exp(subTileMy / ECEF_EARTH_R)) - Math.PI / 2
      const sinLat = Math.sin(subTileLatRad)
      const cosLat = Math.cos(subTileLatRad)
      const N = ECEF_EARTH_R / Math.sqrt(1 - E2_ * sinLat * sinLat)
      return [
        N * cosLat * Math.cos(subTileLonRad),
        N * cosLat * Math.sin(subTileLonRad),
        N * (1 - E2_) * sinLat,
      ]
    })()
    // Scratch holds the absolute-Mercator clipped polygon vertices in
    // stride-3 `[mx, my, fid]` shape; `packECEFPolygonVertices` consumes
    // this layout directly and emits the stride-9 ECEF output buffer.
    const outV = this._scratchOutV
    outV.length = 0
    const outI = this._scratchOutI
    outI.length = 0
    const outVKey = this._scratchOutVKey
    outVKey.clear()
    // Quantize to ~1 cm to tolerate clipper noise — DSFUN vertices afford
    // tighter quantization than the old 10 cm tile-local-degree key.
    // `pushDedupPV` receives PARENT-LOCAL Mercator metres (matches the
    // outputs of `readPV` and `clipPolygonToRect` which both work in the
    // parent-local frame). It re-anchors to absolute Mercator before
    // pushing into `outV` because `packECEFPolygonVertices` inverts
    // Mercator → lon/lat → ECEF internally and needs absolute inputs.
    const pushDedupPV = (xParentLocal: number, yParentLocal: number, fid: number): number => {
      const k = `${Math.round(xParentLocal * 100)},${Math.round(yParentLocal * 100)},${fid}`
      const hit = outVKey.get(k)
      if (hit !== undefined) return hit
      const idx = outV.length / 3
      outV.push(xParentLocal + parentMx, yParentLocal + parentMy, fid)
      outVKey.set(k, idx)
      return idx
    }
    // `splitLocal` (declared near the top of this function) is retained
    // for the line / outline / point paths below — those stay on the
    // Mercator-DSFUN packing until PR 2d migrates them.

    // Read parent ECEF stride-9 vertex back to parent-local Mercator. The
    // clip rect (`clipW..clipE × clipS..clipN`) is in parent-local
    // Mercator, so we subtract the parent tile origin from the packed
    // abs_lon/abs_lat-derived Mercator coords.
    const readPV = (vi: number): [number, number, number] => {
      // Slots 4/5 now carry TILE-LOCAL Mercator (vertex_merc − parentTileOrigin,
      // packed by packECEFPolygonVertices). The parent's origin == [parentMx,
      // parentMy], so the stored local Mercator IS already parent-local — read
      // it directly (sub-mm f32, no degree round-trip). Pre-fix this read the
      // f32 abs_lon/abs_lat DEGREE slots and re-projected (~1.3 m grain).
      const off = vi * ECEF_POLY_STRIDE
      return [verts[off + 4], verts[off + 5], verts[off + 3]]
    }

    // FILL: clip the parent's triangle mesh into the sub-rect. `readPV` recovers
    // each parent vertex's tile-local Mercator from the f32 tail slots — now
    // EXACT (they store tile-local Mercator metres, not the old ~1.3 m absolute-
    // degree round-trip), so the over-zoom fill is sub-mm-faithful and coincides
    // with the outline. Reusing the parent's existing triangulation is cheaper
    // than re-tessellating its rings per sub-tile.
    for (let t = 0; t < parent.indices.length; t += 3) {
      const i0 = parent.indices[t],
        i1 = parent.indices[t + 1],
        i2 = parent.indices[t + 2]
      const [x0, y0, fid] = readPV(i0)
      const [x1, y1] = readPV(i1)
      const [x2, y2] = readPV(i2)

      const minX = Math.min(x0, x1, x2),
        maxX = Math.max(x0, x1, x2)
      const minY = Math.min(y0, y1, y2),
        maxY = Math.max(y0, y1, y2)
      if (maxX < clipW || minX > clipE || maxY < clipS || minY > clipN) continue

      if (minX >= clipW && maxX <= clipE && minY >= clipS && maxY <= clipN) {
        outI.push(pushDedupPV(x0, y0, fid), pushDedupPV(x1, y1, fid), pushDedupPV(x2, y2, fid))
        continue
      }

      const clipped = clipPolygonToRect(
        [
          [
            [x0, y0],
            [x1, y1],
            [x2, y2],
          ],
        ],
        clipW,
        clipS,
        clipE,
        clipN,
      )
      if (clipped.length === 0 || clipped[0]!.length < 3) continue
      const ring = clipped[0]!
      const ringIdx: number[] = []
      for (const [x, y] of ring) ringIdx.push(pushDedupPV(x, y, fid))
      for (let j = 1; j < ring.length - 1; j++) outI.push(ringIdx[0]!, ringIdx[j]!, ringIdx[j + 1]!)
    }

    // Line clip (Liang-Barsky). DSFUN stride-10 reconstruction + dedup.
    // iter-247 — scratch reuse; clear at start.
    const lineVerts = parent.lineVertices
    const lineIdx = parent.lineIndices
    const outLV = this._scratchOutLV
    outLV.length = 0
    const outLI = this._scratchOutLI
    outLI.length = 0
    const outLVKey = this._scratchOutLVKey
    outLVKey.clear()
    const pushDedupLV = (
      x: number,
      y: number,
      fid: number,
      arc: number,
      tinX: number,
      tinY: number,
      toutX: number,
      toutY: number,
    ): number => {
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
    const readLV = (
      vi: number,
    ): [number, number, number, number, number, number, number, number] => {
      const off = vi * DSFUN_LINE_STRIDE
      const x = lineVerts[off] + lineVerts[off + 2]
      const y = lineVerts[off + 1] + lineVerts[off + 3]
      const fid = lineVerts[off + 4]
      const arc = lineVerts[off + 5]
      const tinX = lineVerts[off + 6] ?? 0,
        tinY = lineVerts[off + 7] ?? 0
      const toutX = lineVerts[off + 8] ?? 0,
        toutY = lineVerts[off + 9] ?? 0
      return [x, y, fid, arc, tinX, tinY, toutX, toutY]
    }

    for (let s = 0; s < lineIdx.length; s += 2) {
      const a = lineIdx[s],
        b = lineIdx[s + 1]
      const [ax, ay, afid, aarc, atinX, atinY, atoutX, atoutY] = readLV(a)
      const [bx, by, , barc, btinX, btinY, btoutX, btoutY] = readLV(b)

      if (
        Math.max(ax, bx) < clipW ||
        Math.min(ax, bx) > clipE ||
        Math.max(ay, by) < clipS ||
        Math.min(ay, by) > clipN
      )
        continue

      if (
        ax >= clipW &&
        ax <= clipE &&
        ay >= clipS &&
        ay <= clipN &&
        bx >= clipW &&
        bx <= clipE &&
        by >= clipS &&
        by <= clipN
      ) {
        const ia = pushDedupLV(ax, ay, afid, aarc, atinX, atinY, atoutX, atoutY)
        const ib = pushDedupLV(bx, by, afid, barc, btinX, btinY, btoutX, btoutY)
        if (ia !== ib) outLI.push(ia, ib)
        continue
      }

      const dx = bx - ax,
        dy = by - ay
      let tMin = 0,
        tMax = 1
      let valid = true
      const clipEdge = (p: number, q: number): void => {
        if (!valid) return
        if (Math.abs(p) < 1e-15) {
          if (q < 0) valid = false
          return
        }
        const r = q / p
        if (p < 0) {
          if (r > tMax) valid = false
          else if (r > tMin) tMin = r
        } else {
          if (r < tMin) valid = false
          else if (r < tMax) tMax = r
        }
      }
      clipEdge(-dx, ax - clipW)
      clipEdge(dx, clipE - ax)
      clipEdge(-dy, ay - clipS)
      clipEdge(dy, clipN - ay)
      if (!valid || tMax - tMin < 1e-10) continue

      const darc = barc - aarc
      // Mid-segment clip points: zero tangent → runtime boundary fallback.
      // Original vertices (tMin≈0 / tMax≈1): preserve tangent for cross-tile joins.
      const p0tinX = tMin < 1e-10 ? atinX : 0,
        p0tinY = tMin < 1e-10 ? atinY : 0
      const p0toutX = tMin < 1e-10 ? atoutX : 0,
        p0toutY = tMin < 1e-10 ? atoutY : 0
      const p1tinX = tMax > 1 - 1e-10 ? btinX : 0,
        p1tinY = tMax > 1 - 1e-10 ? btinY : 0
      const p1toutX = tMax > 1 - 1e-10 ? btoutX : 0,
        p1toutY = tMax > 1 - 1e-10 ? btoutY : 0
      const ia = pushDedupLV(
        ax + tMin * dx,
        ay + tMin * dy,
        afid,
        aarc + tMin * darc,
        p0tinX,
        p0tinY,
        p0toutX,
        p0toutY,
      )
      const ib = pushDedupLV(
        ax + tMax * dx,
        ay + tMax * dy,
        afid,
        aarc + tMax * darc,
        p1tinX,
        p1tinY,
        p1toutX,
        p1toutY,
      )
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
    // Parent's rings carry synthetic axis-aligned edges introduced by
    // Sutherland-Hodgman when the parent itself was clipped to its own
    // tile rect (e.g. Russia's eastern fill-edge at lon=90° in the
    // parent z=2 tile x=4). Without filtering, those synthetic edges
    // become visible vertical/horizontal strokes inside every sub-tile
    // they intersect — the user-visible "vertical line through Russia"
    // bug at z<3. extractNonSyntheticArcs walks each parent ring with a
    // predicate built from the PARENT tile's bounds and drops edges
    // whose both endpoints lie on the same parent-rect side.
    //
    // The ring coords are ABSOLUTE Mercator metres (vector-tiler emits
    // absolute MM; tile-catalog + this generator forward them unchanged),
    // so the predicate must be in absolute MM too — a parent-local rect
    // anchored at (0,0) never matches the absolute ring X (millions of m)
    // except at lon=-180, leaving the filter dead and the synthetic
    // axis-aligned frame edges visible as outline strokes.
    const isSameParentBoundarySide = makeSameBoundarySidePredicateMerc(
      parentMx,
      parentMy,
      parentMxE,
      parentMyN,
    )
    // iter-250 — scratch reuse; clear at start. Same pattern as
    // outV/outI hoist above.
    const olvScratch = this._scratchOlv
    olvScratch.length = 0
    const oliScratch = this._scratchOli
    oliScratch.length = 0
    if (parent.polygons && parent.polygons.length > 0) {
      for (const poly of parent.polygons) {
        for (const ring of poly.rings) {
          if (ring.length < 3) continue
          const interiorArcs = extractNonSyntheticArcs(ring, isSameParentBoundarySide)
          for (const arc of interiorArcs) {
            if (arc.length < 2) continue
            // `arc` is in ABSOLUTE Mercator metres (parent.polygons rings
            // are absolute MM), so skip augmentRingWithArc's lon/lat→MM
            // projection — matching the compiler outline path. Without
            // mmInput the metre coords are reprojected as degrees and the
            // subsequent MM-rect clip drops every segment (empty outlines).
            const arcRing = augmentRingWithArc(arc, { mmInput: true })
            if (arcRing.length < 2) continue
            // augmentRingWithArc CLOSES the chain (appends a wrap vertex =
            // first vertex). For an arc that was SPLIT out of a clipped
            // parent ring, that wrap re-introduces the synthetic boundary
            // edge extractNonSyntheticArcs just removed — the closing
            // segment runs between the two cut points on the same parent
            // rect side. Drop the wrap vertex only when it is such a
            // synthetic edge (same test the extractor uses); a fully-
            // interior ring's closure connects interior points and is kept.
            let chain = arcRing
            const last = arcRing[arcRing.length - 1]
            const prev = arcRing[arcRing.length - 2]
            if (
              Math.abs(last[0] - arcRing[0][0]) < 1e-6 &&
              Math.abs(last[1] - arcRing[0][1]) < 1e-6 &&
              isSameParentBoundarySide(prev, last)
            ) {
              chain = arcRing.slice(0, -1)
              if (chain.length < 2) continue
            }
            const segments = clipLineToRect(chain, subMxW, subMyS, subMxE, subMyN)
            for (const seg of segments) {
              if (seg.length >= 2) {
                tessellateLineToArrays(seg, poly.featId, olvScratch, oliScratch)
              }
            }
          }
        }
      }
    }
    const outlineVertices =
      olvScratch.length > 0
        ? packDSFUNLineVertices(olvScratch, subMxW, subMyS)
        : new Float32Array(0)
    const outlineLineIndices = new Uint32Array(oliScratch)

    // Point clip. Phase 2 PR 2d.2 — parent pointVertices is ECEF DSFUN
    // stride-9 [ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, fid, abs_lon, abs_lat]
    // carrying ABSOLUTE ECEF DSFUN (points re-center against the camera in the
    // VS, so they're not tile-anchored). Use abs_lon/abs_lat (slots 7/8) for
    // the sub-tile bounds check, then re-pack each surviving point via the
    // canonical packECEFPointFeatures (stride-3 absolute Mercator metres →
    // stride-9 absolute ECEF DSFUN). Without this, point layers (place labels,
    // POIs) vanish at over-zoom because they have no representation in the
    // sub-tile.
    let subPointVertices: Float32Array | undefined
    if (parent.pointVertices && parent.pointVertices.length >= 13) {
      const pv = parent.pointVertices
      // Stride-3 scratch: [mx, my, fid] absolute Mercator metres for the
      // points that survive the sub-tile bbox clip.
      const survivors: number[] = []
      for (let i = 0; i < pv.length; i += 13) {
        // Precise absolute Mercator from the DSFUN tail (slots 9-12), NOT the
        // lossy f32 abs_lon/abs_lat (7/8) — so over-zoom points keep sub-mm
        // precision through the re-pack.
        const px = pv[i + 9] + pv[i + 10]
        const py = pv[i + 11] + pv[i + 12]
        // clipW/E/S/N are parent-local offsets, so the bbox test must run in
        // the parent-local frame (matching the polygon/line paths). Compare
        // local coords, but push the ABSOLUTE px/py downstream.
        const lpx = px - parentMx
        const lpy = py - parentMy
        if (lpx < clipW || lpx > clipE || lpy < clipS || lpy > clipN) continue
        survivors.push(px, py, pv[i + 6])
      }
      if (survivors.length >= 3) {
        subPointVertices = packECEFPointFeatures(survivors)
      }
    }

    // Polygon vertices: pack `outV` (stride-3 absolute Mercator
    // `[mx, my, fid]`) into the PR 2f quantized ECEF layout via the
    // canonical tiler packer. Output sits in the same ECEF frame as parent
    // archive tiles so the renderer's ECEF VS reads one layout. The
    // per-tile dequant params travel on the sub-tile's TileData.
    const subQuant = packECEFPolygonVertices(outV, subTileEcefCenter, [subMxW, subMyS])

    // Clip the forwarded extrusion rings to THIS sub-tile's window. The
    // extruded-building upload path (upload-coordinator →
    // generateWallMeshExtrudedECEF) re-tessellates walls from `polygons`, so a
    // child forwarding the parent's ENTIRE ring set re-extrudes every building
    // in every child → duplicate overlapping walls + z-fighting at deep zoom
    // (#1082). Rings are absolute Mercator metres, so clip against the
    // absolute-MM sub-window [subMxW, subMyS, subMxE, subMyN] — the same window
    // the outline path above clips its ring arcs against.
    let subPolygons: RingPolygon[] | undefined
    if (parent.polygons && parent.polygons.length > 0) {
      const kept: RingPolygon[] = []
      for (const poly of parent.polygons) {
        const clippedPoly = clipRingPolygonToWindow(poly, subMxW, subMyS, subMxE, subMyN)
        if (clippedPoly !== null) kept.push(clippedPoly)
      }
      subPolygons = kept.length > 0 ? kept : undefined
    }
    return {
      vertices: subQuant.vertices,
      dequantScale: subQuant.dequantScale,
      dequantHalf: subQuant.dequantHalf,
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
      // Forward the parent's ring data CLIPPED to this sub-tile's window
      // (#1082) so the extrusion path re-extrudes only this child's buildings,
      // while further over-zoom of THIS sub-tile still has rings for the
      // global-arc outline path (grand-children clip the already-narrowed set
      // again — equivalent to clipping straight to the grand-child window;
      // otherwise they fall back to the legacy outlineIndices and the dash bug
      // recurs at very high zoom levels).
      polygons: subPolygons,
      // Per-feature attribute maps are keyed by tile-local featId,
      // which the clipper preserves (every emitted vertex carries its
      // parent's fid). So forwarding the parent's maps is safe — same
      // index space. Without this, over-zoom levels lose data-driven
      // fill (OFM Bright landuse `class` match disappeared at z>14)
      // and extruded buildings flatten to z=0. Heights/bases were
      // previously implicit via the over-zoom fallback; making the
      // contract explicit here fixes the OFM Bright school-fill bug.
      featureProps: parent.featureProps,
      heights: parent.heights,
      bases: parent.bases,
    }
  }
}
