// ═══ Tile-point emit — one emission per source point per frame (#2028) ═══
//
// `VectorTileRenderer.stableKeys` is an EVICTION-PROTECTION set, not a partition
// of the screen: `neededKeys ∪ fallbackKeys ∪ protectedAncestors`, with each
// canonical key repeated once per visible world copy. The old emit iterated it
// directly, and the stride-13 point record carries ABSOLUTE ECEF + absolute
// Mercator with no tile-relative term — so one source feature reached
// `addTilePoint` twice at IDENTICAL coordinates. The point material alpha-blends
// with `depthCompare: 'less-equal'` (point-material.ts), so at equal depth the
// second draw is not rejected, it COMPOSITES: an opacity-0.5 marker renders at
// 0.75 while a sibling tile is in flight and snaps back when it lands.
//
// The rule below is the per-POINT refinement of the ancestry shadow this repo
// already ships for line labels (#616, label-feature-source.ts):
//
//   a record is emitted iff no STRICTLY DEEPER key in this frame's set
//   actually CARRIES POINT DATA for this slice at that position.
//
// Per-POINT and not per-KEY because a fallback ancestor must keep drawing over a
// visible child that has no slice yet — blanking it is the regression, not the
// fix. And "carries point data", never `hasTileData`: an empty placeholder slice
// (tile-catalog.ts, written for a tile with no features) reports as cached but
// has no `pointVertices`, and tile-decision.ts issues a parent-fallback for
// exactly that tile. A presence-based supplier test would suppress the
// ancestor's POINTS there while its FILL still drew — points and fills
// desynchronised.

import { tileKeyParent, tileKeyUnpack } from '@xgis/compiler'
import { EARTH } from '@xgis/shared'
import { POINT_VERTEX_STRIDE, type TileCatalog } from '@xgis/data'
import type { PointRenderer } from './point-renderer'

/** Mercator world width in metres, spelled the way `lonLatToMercF64` spells it
 *  (`lon * DEG2RAD * DSFUN_EARTH_R`) — the SAME radius slots 9-12 were packed
 *  against. NOT `EARTH.worldMerc` (the pinned literal 40075016.686, which is not
 *  2π·sphereR) and NOT `activeBody().sphereR` (what the fill path's clip_bounds
 *  uses — equal on Earth, divergent elsewhere). */
const WORLD_MERC = 2 * Math.PI * EARTH.sphereR
/** MAX_TILE_ZOOM is 22, so 2^23 per axis leaves headroom and 22·2^46 stays
 *  inside f64's exact-integer range. */
const CELL_SHIFT = 8388608
const POW2: readonly number[] = Array.from({ length: 23 }, (_, z) => 2 ** z)
/** Half-width of the seam / polar band, in normalised world units — see
 *  `coveredDeeper`. ~4 cm against a ~9.5 m z22 cell. */
const EDGE_EPS = 1e-9

/** Frame-scoped hash of a tile cell. Deliberately NOT a `tileKey`: it never
 *  leaves this call, so it skips the morton encode for two multiplies.
 *  `tileKeyUnpack` stays the one authority for decoding real keys. */
function cellCode(z: number, x: number, y: number): number {
  return (z * CELL_SHIFT + y) * CELL_SHIFT + x
}

// Module-scoped scratch. `accumulateTilePoints` is synchronous and its only
// call-out is a catalog Map lookup, so it never re-enters and one set serves
// every renderer. Numbers only — no TileData is retained past the call.
const _seen = new Set<number>()
const _supplierKeys = new Set<number>()
const _cells = new Set<number>()
const _shadow = new Map<number, number[]>()
const _keys: number[] = []
const _zs: number[] = []

/** True when a strictly deeper supplier carries point data at (mx, my).
 *  `zsList` holds the distinct zooms of the suppliers strictly BENEATH the
 *  source tile — usually one entry, so this is a couple of divides and a Set
 *  probe.
 *
 *  A point exactly ON the world seam or past the polar row is never gated:
 *  PMTiles MVT carries antimeridian wrap COPIES at ±πR, and the tiler clamps
 *  latitude to DSFUN_LAT_LIMIT 85.051129°, a hair PAST the y = πR row edge.
 *  Judging either against a clamped edge cell could DROP a point, and dropping
 *  is the regression; erring toward emitting leaves only a pre-existing double. */
function coveredDeeper(zsList: readonly number[], mx: number, my: number): boolean {
  const u = mx / WORLD_MERC + 0.5
  const v = 0.5 - my / WORLD_MERC
  // A BAND, not an exact `<= 0` test. The record stores Mercator as an f32
  // high/low pair, so a wrap copy authored at exactly −πR reconstructs a hair
  // INSIDE the world (measured: u ≈ 2.5e-15, not 0) and an equality test never
  // fires — the copy is then judged against cell x=0 and DROPPED whenever a
  // deeper supplier happens to occupy that cell. EDGE_EPS spans ~4 cm of the
  // 40 075 km world, against a z22 cell of ~9.5 m, so it cannot swallow an
  // interior point at any zoom while covering a reconstruction error ~1e-7 m.
  if (u <= EDGE_EPS || u >= 1 - EDGE_EPS || v <= EDGE_EPS || v >= 1 - EDGE_EPS) return false
  for (let i = 0; i < zsList.length; i++) {
    const z = zsList[i]!
    const n = POW2[z]!
    if (_cells.has(cellCode(z, Math.floor(u * n), Math.floor(v * n)))) return true
  }
  return false
}

/** Walk this frame's stable keys once and push each surviving point into the
 *  sink. Stride-13 record:
 *  `[ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, feat_id, abs_lon, abs_lat, mx_h, mx_l, my_h, my_l]`.
 *
 *  The gate reads the DSFUN Mercator TAIL (slots 9-12, summed to f64), NOT the
 *  f32 `abs_lon`/`abs_lat` at 7-8: those are lossy to ~6 px at z20, and the
 *  sub-tile generator already rejected them for the identical bbox test.
 *
 *  `featureProps` is PER TILE (fids collide across tiles), so it resolves inside
 *  the loop (#722 S4). */
export function accumulateTilePoints(
  stableKeys: readonly number[],
  source: Pick<TileCatalog, 'getTileData'>,
  sliceLayer: string,
  wantsFeatProps: boolean,
  sink: Pick<PointRenderer, 'addTilePoint'>,
): void {
  // ── 1. Suppliers: the canonical keys in this frame's set that actually carry
  //    point data for this slice. `_seen` collapses the world-copy repeats, so a
  //    key present N times contributes exactly one emission (its downstream
  //    fan-out to the other copies lives in PointRenderer).
  _seen.clear()
  _supplierKeys.clear()
  _cells.clear()
  let n = 0
  for (const key of stableKeys) {
    if (_seen.has(key)) continue
    _seen.add(key)
    const td = source.getTileData(key, sliceLayer)
    if (!td?.pointVertices || td.pointVertices.length < POINT_VERTEX_STRIDE) continue
    const [z, x, y] = tileKeyUnpack(key)
    _keys[n] = key
    _zs[n] = z
    n++
    _supplierKeys.add(key)
    _cells.add(cellCode(z, x, y))
  }
  // ── 2. Ancestry shadow (#616's walk, one level of refinement down). A supplier
  //    S records its ZOOM on every ancestor of S that is itself a supplier. Key
  //    arithmetic only — no floats, no re-derivation. `tileKeyParent` is
  //    `Math.floor(key / 4)`, strictly decreasing for `pk > 1`, so this
  //    terminates at the root.
  _shadow.clear()
  for (let i = 0; i < n; i++) {
    const z = _zs[i]!
    let pk = _keys[i]!
    while (pk > 1) {
      pk = tileKeyParent(pk)
      if (pk < 1 || !_supplierKeys.has(pk)) continue
      let list = _shadow.get(pk)
      if (list === undefined) {
        list = []
        _shadow.set(pk, list)
      }
      if (!list.includes(z)) list.push(z)
    }
  }
  // ── 3. Emit. A key with no shadow entry — every primary at the deepest zoom,
  //    and every ancestor with no data-bearing descendant in the set — takes the
  //    fast path: one Map.get, then the old loop unchanged.
  for (let i = 0; i < n; i++) {
    const td = source.getTileData(_keys[i]!, sliceLayer)
    const ptv = td?.pointVertices
    if (!ptv) continue
    const featProps = wantsFeatProps ? td.featureProps : undefined
    const shadowZs = _shadow.get(_keys[i]!)
    for (let j = 0; j < ptv.length; j += POINT_VERTEX_STRIDE) {
      if (
        shadowZs !== undefined &&
        coveredDeeper(shadowZs, ptv[j + 9]! + ptv[j + 10]!, ptv[j + 11]! + ptv[j + 12]!)
      )
        continue
      sink.addTilePoint(
        ptv[j]!,
        ptv[j + 1]!,
        ptv[j + 2]!, // ex_h, ey_h, ez_h
        ptv[j + 3]!,
        ptv[j + 4]!,
        ptv[j + 5]!, // ex_l, ey_l, ez_l
        ptv[j + 6]!, // feat_id
        ptv[j + 7]!,
        ptv[j + 8]!, // abs_lon, abs_lat (cull)
        ptv[j + 9]!,
        ptv[j + 10]!,
        ptv[j + 11]!,
        ptv[j + 12]!, // merc DSFUN mx_h,mx_l,my_h,my_l
        featProps ? (featProps.get(ptv[j + 6]!) ?? null) : null, // #722 S4 per-feature source props
      )
    }
  }
}
