// ═══ Point-cluster index — types and defaults (#2050) ═══
//
// The option surface of `compiler/src/tiler/cluster/`, an X-GIS-original
// implementation of the supercluster hierarchy (design doc
// `docs/plans/2026-08-24-geojson-clustering.md`, §4.1 for why this is not a vendored
// dependency and not a second port inside `geojsonvt/`).
//
// It deliberately mirrors `geojsonvt/types.ts`'s `GeoJSONVTOptions` in shape — the two
// indexes are built from the SAME GeoJSON by the same worker (§4.2), one serving
// `z ≤ maxZoom` and the other everything above it, so a reader comparing them should see
// the same kind of object. What it does NOT mirror is `GeoJSONVTOptions`' pre-baked
// px→extent constants (`tolerance: 6`, `buffer: 2048`): `radius` here is AUTHOR-supplied,
// so the conversion has to happen at runtime. `units.ts` owns it.

import type { ClusterProperty } from '../../ir/source-cluster'
import type { ClusterKdTree } from './kd-tree'

/** The four synthetic tags every cluster feature carries — Mapbox's names, which is what
 *  lets `["get","point_count"]` in a `circle-radius` step and
 *  `["get","point_count_abbreviated"]` in a `text-field` work with no expression, binder
 *  or renderer change (design §1.3: "the synthetic properties are the whole
 *  integration"). Written down once here so the index and its gates cannot drift. */
export const CLUSTER_TAG = {
  /** `true` on every aggregate — the canonical unclustered-layer filter is
   *  `["!", ["has", "point_count"]]`, but `["==", ["get","cluster"], true]` is the
   *  clustered half and both must work. */
  isCluster: 'cluster',
  /** Decodable back to (origin record index, origin zoom) — see `units.ts`. */
  id: 'cluster_id',
  /** Number of source points behind the aggregate. Always ≥ 2. */
  count: 'point_count',
  /** `point_count` in the abbreviated form — a NUMBER below 1000, a STRING above. */
  abbreviated: 'point_count_abbreviated',
} as const

/** How the cluster index is configured. Every field has a default; `PointCluster` never
 *  reads a partial object directly — `resolveClusterOptions` (units.ts) turns this into
 *  the internal form with the radius in extent units and `minPoints` lifted. */
export interface ClusterOptions {
  /** Mapbox `clusterRadius`, in 512-px TILE PIXELS — carried verbatim from the style
   *  through `SourceDef.clusterRadius` (the UNITS block in `ir/source-cluster.ts` is the
   *  record for why it is not pre-scaled there). THIS module applies
   *  `radius × extent / 512`; passing the raw 50 straight into the neighbourhood test
   *  would cluster at 1/16th the intended radius — design §2's "single easiest way to get
   *  this feature subtly wrong". Default 50, Mapbox's own. */
  radius: number
  /** Mapbox `clusterMaxZoom` — the deepest zoom served from the hierarchy. A `getTile`
   *  above it falls through to the raw-point level, which is what makes a clustered
   *  source show INDIVIDUAL points when zoomed in (design §7: the knob's whole meaning).
   *
   *  Default 14, matching `GEOJSONVT_DEFAULT_OPTIONS.maxZoom` so the two indexes the
   *  worker holds for one source agree on the deepest zoom either of them knows about.
   *  MapLibre's own default is `source maxzoom − 1` (design §2) — that resolution needs
   *  the SOURCE's maxzoom, which this module is not given, so it belongs to the P3
   *  caller that reads `SourceDef`. */
  maxZoom: number
  /** Mapbox `clusterMinPoints` — the smallest neighbourhood that becomes a cluster.
   *  Lifted to ≥ 2 at resolve time, as MapLibre does. NOT rounded: a fractional 2.4
   *  means "3 or more" inside `numPoints >= minPoints`, and the converter deliberately
   *  leaves it fractional for exactly that reason (`convert/sources-cluster.ts`). */
  minPoints: number
  /** Tile coordinate extent. MapLibre standard 8192 — the same value
   *  `GeoJSONVTOptions.extent` carries, and the one `encodeMVT` must be given. */
  extent: number
  /** Mapbox `clusterProperties`, already lowered to map/reduce expression pairs by
   *  `lowerSourceCluster`. `null` (the default) when the source declares none, which is
   *  also what keeps the per-point `map` evaluation off the build path entirely. */
  clusterProperties: Record<string, ClusterProperty> | null
}

export const DEFAULT_CLUSTER_OPTIONS: ClusterOptions = {
  radius: 50,
  maxZoom: 14,
  minPoints: 2,
  extent: 8192,
  clusterProperties: null,
}

/** `ClusterOptions` after `resolveClusterOptions` — the form the index actually runs on.
 *  Separate type, not a mutated `ClusterOptions`, so `radius` cannot be read in the wrong
 *  unit by accident: the field is renamed, so a stale read is a type error rather than a
 *  16× wrong answer. */
export interface ResolvedClusterOptions {
  /** The neighbourhood radius in EXTENT units (`radius × extent / 512`). */
  radiusExtent: number
  maxZoom: number
  /** `max(2, minPoints || 2)`. */
  minPoints: number
  extent: number
  clusterProperties: Record<string, ClusterProperty> | null
}

/** One zoom level of the hierarchy: a flat record store plus the k-d tree indexing it.
 *
 *  Parallel typed arrays rather than one interleaved `Float64Array` with a stride — the
 *  stride arithmetic is where upstream's `OFFSET_*` constants live, and every one of them
 *  is a place to read the wrong slot. There is no `parent` column: it exists upstream only
 *  to serve `getChildren` / `getLeaves`, which design §3 puts out of this track.
 *
 *  NO per-record "processed at zoom" column either, and that is a proof rather than an
 *  omission. Upstream carries `OFFSET_ZOOM` forward through `_cluster`'s pass-through
 *  branch, but at the START of the pass that produces level `z` every mark in level `z+1`
 *  is either `Infinity` (a record the previous pass created, or a freshly loaded point) or
 *  exactly `z+1` (a record the previous pass passed through) — both strictly greater than
 *  `z`, so no mark can ever make the `mark <= zoom` test fire on entry. The column is
 *  therefore pass-local, and `buildLevel` allocates it as a plain `Uint8Array` flag. */
export interface ClusterLevel {
  /** Quantized unit-square coordinates — see `units.ts`. */
  x: Int32Array
  y: Int32Array
  /** For a single point (`num === 1`) the index into the retained originals; for an
   *  aggregate (`num > 1`) the `cluster_id`. `num` is the discriminant. */
  id: Float64Array
  /** Source points behind each record. */
  num: Int32Array
  /** Index into the index's aggregated-property table, or −1 when there is none. */
  prop: Int32Array
  /** Spatial index over this level's `x`/`y`, answering both the build's `within` and the
   *  tile query's `range`. */
  tree: ClusterKdTree
}
