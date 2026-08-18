// ═══ In-place point-feature patch for resident tile data (#1375) ═══
//
// A host push on a declared GeoJSON source had exactly two flush routes, and
// both re-tile the whole source: `teardownSource` (legacy raw-FC sources) or
// the #1242 virtual re-seed (`setSourceData` → new backend → `reseedTiles`).
// For the shape a realtime feed actually has — one POINT feature that moved a
// few metres and stayed in its tile — nothing about the tiling changed. The
// only bytes that differ are the 13 floats of that point's record.
//
// This module is that patch: locate the record by the feature's STABLE id and
// rewrite it from the new lon/lat. It never re-tiles, never tears a source
// down, and never needs `requestTiles` (which is only reachable from inside
// `VectorTileRenderer.render()`). The redraw rides the machinery that is
// already there: `TilePointPackKey.contentGeneration` (#1616) makes the point
// repack miss on the next frame, and the label path re-reads `pointVertices`
// every frame unconditionally.
//
// ── Why the id has to be a SIDE-CAR ──
// `pointVertices` slot 6 (`feat_id`) is NOT the host's stable id: it is the
// feature's index within the slice being compiled (`decomposeFeatures`'
// default resolver), which is what `featureProps` / `heights` / `widths` /
// `colors` are keyed by. Re-purposing it would break all four. So the stable
// id travels alongside, in `TileData.pointFeatureIds` — one u32 per packed
// point, produced by the same pass that packs the point (see
// `buildPointFeatureIds`), so the id and the geometry cannot drift apart.
//
// ── Why matching by POSITION was rejected ──
// The obvious index-free alternative — find the record whose stored position
// matches the feature's previous lon/lat — cannot work at coarse zoom. MVT
// quantises to `extent` units per tile, so at z0 one cell is ~4.9 km: two
// vessels in the same harbour are literally the same packed coordinate there,
// and the low-zoom tiles are exactly the ones the skeleton prewarm pins in
// cache. Position matching would have to bail on every realistic multi-point
// source, or guess. The side-car is exact at every zoom.

import { lonLatToMercF64, packECEFPointFeatures } from '@xgis/compiler'
import { toU32Id } from './id-resolver'
import type { TileData } from './tile-types'

/** Floats per packed point record in `TileData.pointVertices` — ECEF DSFUN
 *  stride 13: `[ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, fid, abs_lon, abs_lat,
 *  mx_h, mx_l, my_h, my_l]` (see `packECEFPointFeatures`). */
export const POINT_VERTEX_STRIDE = 13

/** Slot holding the per-slice feature INDEX inside a packed point record.
 *  Preserved verbatim by a patch — `featureProps` / `heights` / `widths` /
 *  `colors` are keyed by it. */
const FEAT_ID_SLOT = 6

/** `0` means "this packed point carries no stable id" — the same sentinel the
 *  pick decoder and `resolveIdResolver`'s `i + 1` offset already use, so a
 *  feature whose declared id IS `0` is treated as id-less and falls back to
 *  the re-seed path rather than aliasing every id-less point. */
const NO_STABLE_ID = 0

/** One requested move: put `featureId`'s point at (`lon`, `lat`). */
export interface PointFeatureMove {
  /** Stable u32 feature id, as produced by `toU32Id(feature.id)`. */
  featureId: number
  lon: number
  lat: number
}

/** One resolved rewrite target inside one resident slice. */
interface PointPatchSite {
  /** The slice's live `pointVertices` — patched THROUGH this view, so a view
   *  with a non-zero `byteOffset` (a sub-tile / arena window) writes to its
   *  own window and not to a neighbour's bytes. */
  points: Float32Array
  /** Float index of the record's first slot WITHIN `points`. */
  base: number
  /** The record's existing `feat_id` slot, carried through unchanged. */
  fid: number
  lon: number
  lat: number
}

/** A fully-resolved patch: every requested move has a site in every resident
 *  slice that holds it, and every new position stays inside its tile. */
export type PointPatchPlan = readonly PointPatchSite[]

/** Build the stable-id side-car for a compiled tile's packed points.
 *
 *  `pointVertices[k * 13 + 6]` is the index of the source feature that
 *  produced record `k`, so the side-car is a direct lookup — no ordering
 *  assumption about how the tiler emitted the points, and no second copy of
 *  the tiler's "which feature landed in this tile" rule.
 *
 *  Returns `undefined` when no packed point resolves to a usable id (an MVT
 *  archive with no `id` field, or a host FeatureCollection whose features
 *  carry only `properties.id` — `encodeMVT` writes MVT tag 1 only for a
 *  numeric top-level `id`). An absent side-car simply makes the slice
 *  un-patchable, which falls back to the re-seed path. */
export function buildPointFeatureIds(
  features: readonly { id?: string | number }[],
  pointVertices: Float32Array | undefined,
): Uint32Array | undefined {
  if (!pointVertices || pointVertices.length < POINT_VERTEX_STRIDE) return undefined
  const n = Math.floor(pointVertices.length / POINT_VERTEX_STRIDE)
  const ids = new Uint32Array(n)
  let any = false
  for (let k = 0; k < n; k++) {
    const raw = features[pointVertices[k * POINT_VERTEX_STRIDE + FEAT_ID_SLOT]]?.id
    // Only a non-negative INTEGER survives the MVT round trip (`encodeMVT`
    // writes a varint). `toU32Id` is the identity below 2^31 and the same
    // FNV-1a hash the feature-update queue keys by above it, so the two sides
    // agree by construction rather than by convention.
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) continue
    const id = toU32Id(raw)
    ids[k] = id
    if (id !== NO_STABLE_ID) any = true
  }
  return any ? ids : undefined
}

/** Resolve `moves` against every resident slice, or return `null` when the
 *  caller must fall back to the re-seed path.
 *
 *  The plan is ALL-OR-NOTHING on purpose. A partial patch is worse than no
 *  patch: if a feature crossed a tile boundary at z14 but not at z13, writing
 *  the z13 record alone leaves z14 drawing the point at its old position AND
 *  missing from the tile it moved into. So a single failing constraint sends
 *  the whole flush to the re-seed, which is correct by construction.
 *
 *  Rejected (→ `null`):
 *   · a move whose id is the `0` sentinel;
 *   · a slice whose side-car length disagrees with its packed point count
 *     (malformed / stale pairing — never patch on a guess);
 *   · an id appearing more than once in one slice (a MultiPoint feature emits
 *     one record per position; they do not share a destination);
 *   · a new position outside the tile that holds the record — the point now
 *     belongs to a different tile, which is a re-tile, not a patch;
 *   · a move no resident slice holds at all (nothing to patch in place). */
export function planPointFeaturePatch(
  slices: Iterable<TileData>,
  moves: readonly PointFeatureMove[],
): PointPatchPlan | null {
  if (moves.length === 0) return null
  for (const m of moves) {
    if (!Number.isInteger(m.featureId) || m.featureId === NO_STABLE_ID) return null
    if (!Number.isFinite(m.lon) || !Number.isFinite(m.lat)) return null
  }
  const sites: PointPatchSite[] = []
  const hit = new Set<number>()
  for (const data of slices) {
    const points = data.pointVertices
    const ids = data.pointFeatureIds
    if (!points || !ids || points.length < POINT_VERTEX_STRIDE) continue
    const n = Math.floor(points.length / POINT_VERTEX_STRIDE)
    // A side-car that does not describe THIS buffer cannot be trusted to
    // identify anything in it.
    if (ids.length !== n) return null
    for (const m of moves) {
      let base = -1
      for (let k = 0; k < n; k++) {
        if (ids[k] !== m.featureId) continue
        if (base >= 0) return null // ambiguous within one slice
        base = k * POINT_VERTEX_STRIDE
      }
      if (base < 0) continue
      if (!withinTile(data, m.lon, m.lat)) return null
      sites.push({ points, base, fid: points[base + FEAT_ID_SLOT], lon: m.lon, lat: m.lat })
      hit.add(m.featureId)
    }
  }
  if (hit.size !== moves.length) return null
  return sites
}

/** Rewrite every planned record. Re-uses `packECEFPointFeatures` rather than
 *  re-deriving the ECEF / DSFUN layout here, so the patched bytes are the
 *  SAME bytes the tiler would have produced for that position — the packing
 *  keeps exactly one authority. */
export function applyPointFeaturePatch(plan: PointPatchPlan): void {
  for (const site of plan) {
    const [mx, my] = lonLatToMercF64(site.lon, site.lat)
    // `TypedArray.set` is relative to the VIEW, so a `pointVertices` that is a
    // window into a larger buffer patches its own record and leaves the
    // neighbouring bytes alone.
    site.points.set(packECEFPointFeatures([mx, my, site.fid]), site.base)
  }
}

/** The tile-membership test, spelled exactly as `compileSingleTile` spells it
 *  (inclusive on all four edges, degrees). A point on a shared edge lands in
 *  both tiles and both hold a record for it, so both get patched. */
function withinTile(data: TileData, lon: number, lat: number): boolean {
  return (
    lon >= data.tileWest &&
    lon <= data.tileWest + data.tileWidth &&
    lat >= data.tileSouth &&
    lat <= data.tileSouth + data.tileHeight
  )
}
