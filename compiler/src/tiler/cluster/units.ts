// ═══ The numeric conventions the cluster boundary owns (#2050) ═══
//
// Three conversions, all of them a place this feature can be subtly and invisibly wrong,
// so they live in one file with their arithmetic written down:
//
//   1. RADIUS — `clusterRadius` is in 512-px tile pixels and the neighbourhood test runs
//      in extent units, so `radiusExtent = radius × extent / 512` (×16 at extent 8192).
//      This is THE conversion `ir/source-cluster.ts`'s UNITS block defers to the tiler
//      and #2050's P1 decision comment names: a hand-authored `.xgis` reaches the same
//      `SourceDef.clusterRadius` with no converter in the loop, so the style language
//      must not carry a tiler constant. Skipping it clusters at 1/16 the radius — a
//      plausible-looking map with far too many clusters (design §2).
//
//   2. QUANTIZATION — the spatial index stores each unit-square coordinate as the Int32
//      `round((c − 0.5) × 2^30)`, upstream's encoding. Half a step is ~1.9 cm at the
//      equator, which is why single points are NOT emitted through it: `PointCluster`
//      retains the Float64 projections and reads THOSE for an unclustered feature
//      (design §2, "unclustered output is drift-free"). Cluster centroids are averages of
//      quantized positions and are quantized again; that is upstream's behaviour and the
//      error is far below the size of the thing being drawn.
//
//   3. CLUSTER_ID — `(originIndex << 5) + (zoom + 1) + pointCount`, upstream's packing,
//      kept because it is DECODABLE back to (origin index, origin zoom) and that is the
//      only thing keeping `getClusterExpansionZoom` / `getChildren` addable later without
//      a rebuild (design §4.4; those APIs are explicitly not in this track, §3).

import { DEFAULT_CLUSTER_OPTIONS, type ClusterOptions, type ResolvedClusterOptions } from './types'

/** The tile size `clusterRadius` is expressed against. MapLibre's whole GeoJSON path is
 *  512-px-tile: `geojson_source.ts` converts with `EXTENT / tileSize`, and
 *  `GEOJSONVT_DEFAULT_OPTIONS`' `tolerance: 6` / `buffer: 2048` are the same 8192/512 = 16
 *  already baked in. Not an option — a source cannot mix tile sizes with the index that
 *  serves its other half. */
export const RADIUS_TILE_SIZE = 512

/** Scale of the Int32 quantization. `c ∈ [0,1] → q ∈ [−2^29, 2^29]`, comfortably inside
 *  Int32, with a step of 2^−30 of the unit square. */
export const QUANT_SCALE = 2 ** 30

/** The largest input point count `clusterIdFor` can pack. `originIndex << 5` is a signed
 *  32-bit shift, so an index at or above 2^26 wraps NEGATIVE and every id it produces
 *  becomes garbage — silently, since the arithmetic still yields a number. */
export const MAX_CLUSTERABLE_POINTS = 2 ** 26

/** The largest `maxZoom` that fits the 5-bit zoom field (`zoom + 1 ≤ 31`). */
export const MAX_CLUSTER_ZOOM = 30

/** Fill in defaults and apply the two conversions MapLibre applies before it hands
 *  supercluster anything: the radius into extent units, and `minPoints` lifted to 2.
 *
 *  The lift is `max(2, minPoints || 2)` — MapLibre's exact expression, so `0` (falsy) and
 *  `undefined` both land on 2, and a declared `clusterMinPoints: 1` is silently lifted
 *  rather than honoured (design §2). Note that the lift is not observable end-to-end: the
 *  admission rule's `numPoints > numPointsOrigin` half already forces `numPoints ≥ 2`, so
 *  0, 1 and 2 cluster identically. It is applied because the reference applies it, and it
 *  is pinned HERE, on the function, rather than through an index-level assertion that
 *  could not distinguish the states. A FRACTIONAL value survives: 2.4 means "3 or more"
 *  inside `numPoints >= minPoints`, and `convert/sources-cluster.ts` deliberately does not
 *  round it. */
export function resolveClusterOptions(options?: Partial<ClusterOptions>): ResolvedClusterOptions {
  const o: ClusterOptions = { ...DEFAULT_CLUSTER_OPTIONS, ...(options ?? {}) }
  return {
    radiusExtent: (o.radius * o.extent) / RADIUS_TILE_SIZE,
    maxZoom: o.maxZoom,
    minPoints: Math.max(2, o.minPoints || 2),
    extent: o.extent,
    clusterProperties: o.clusterProperties,
  }
}

/** Unit-square coordinate → the quantized integer domain, WITHOUT rounding or clamping.
 *  Query bounds legitimately fall outside `[0,1]` (a tile's buffer at x = 0 reaches
 *  negative), so they use this and compare against stored integers as doubles. */
export function unitToQuant(c: number): number {
  return (c - 0.5) * QUANT_SCALE
}

/** Unit-square coordinate → the Int32 a record STORES. The clamp is what makes the domain
 *  closed: `projectY` already clamps latitude, but a longitude outside ±180 would project
 *  past the unit square and overflow the Int32Array silently. */
export function quantizeUnit(c: number): number {
  const clamped = c < 0 ? 0 : c > 1 ? 1 : c
  return Math.round(unitToQuant(clamped))
}

/** The inverse of `quantizeUnit`, for cluster centroids (never for a single point). */
export function dequantizeUnit(q: number): number {
  return q / QUANT_SCALE + 0.5
}

/** Upstream's `cluster_id` packing. `originIndex` is the record's index within the level
 *  BEING clustered (i.e. level `zoom + 1`), which is what `getChildren` would need to walk
 *  down one step; `zoom + 1` occupies the low 5 bits, so `(id − pointCount) >> 5` and
 *  `((id − pointCount) % 32) − 1` recover the pair. Decodability needs only that encoder
 *  and decoder agree on the offset — what the offset is FOR is lifting every cluster id
 *  clear of the raw record indices sharing the same numeric space.
 *
 *  `pointCount` is therefore the number of INDEXED POINTS — MultiPoint coordinates counted
 *  individually — and not the number of input FEATURES upstream offsets by. A MultiPoint
 *  makes those two differ, and only the former is an upper bound on every record index at
 *  every level. It is also exactly the quantity `assertClusterIdCapacity` bounds, so the
 *  packing has one number carrying one meaning. */
export function clusterIdFor(originIndex: number, zoom: number, pointCount: number): number {
  return (originIndex << 5) + (zoom + 1) + pointCount
}

/** Guard the packing's two arithmetic bounds, per design §4.4 ("the bound goes in the code
 *  as an assert, not a comment").
 *
 *  Reachable ON PURPOSE — it takes its inputs as arguments instead of reading them off a
 *  built index, so a gate can drive it to the cliff without materialising 67 million
 *  points. An assert nothing can execute is not an assert. */
export function assertClusterIdCapacity(pointCount: number, maxZoom: number): void {
  if (pointCount >= MAX_CLUSTERABLE_POINTS) {
    throw new Error(
      `cluster index: ${pointCount} points exceeds the ${MAX_CLUSTERABLE_POINTS}-point ` +
        `cluster_id capacity — the origin index no longer fits the 26 bits above the ` +
        `5-bit zoom field and every cluster_id would wrap negative`,
    )
  }
  if (maxZoom > MAX_CLUSTER_ZOOM) {
    throw new Error(
      `cluster index: maxZoom ${maxZoom} exceeds ${MAX_CLUSTER_ZOOM} — zoom + 1 no longer ` +
        `fits the 5-bit zoom field of cluster_id`,
    )
  }
}
