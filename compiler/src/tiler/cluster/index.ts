// ═══ Point-cluster index — the supercluster hierarchy, CPU-only (#2050) ═══
//
// An X-GIS-original implementation of the algorithm design §2 measured from
// `mapbox/supercluster@main`, emitting the same `TransformedTile` `geojsonvt/` emits so
// `encodeMVT` consumes it verbatim and nothing downstream of the tiler changes (§1).
// Sibling of `geojsonvt/`, not a second port inside it: that directory's provenance claim
// is "a 1:1 port of ONE upstream project", and mixing a second project's port into it
// would make that false (§4.1).
//
// THE SHAPE OF THE HIERARCHY. Points are indexed at `maxZoom + 1`; then for
// `z = maxZoom … 0` the previous level's output is clustered with radius
// `r = radiusExtent / (extent · 2^z)` in unit-square coordinates, each level getting its
// own k-d tree. `getTile(z, …)` ranges the tree for `min(z, maxZoom + 1)`, which is what
// makes a request ABOVE `clusterMaxZoom` serve individual points — MapLibre's split, and
// the entire meaning of the knob (§7).
//
// WHAT IS NOT HERE, deliberately: no worker, pool or backend wiring (P3 — this module is
// a pure CPU data structure and knows nothing about `instanceId`s or `postMessage`); no
// `getClusterExpansionZoom` / `getChildren` / `getLeaves` (§3 — interaction APIs, not
// style support; the `cluster_id` packing in `units.ts` is the one concession that keeps
// them addable without a rebuild); no `parent` column, which exists upstream only to
// serve them.

import { projectX, projectY } from '../geojsonvt/convert'
import { transformPoint } from '../geojsonvt/transform'
import type { GeoJSONInput, TransformedTile, TransformedTileFeature } from '../geojsonvt/types'
import type { GeoJSONGeometry } from '../geojson-types'
import { ClusterKdTree } from './kd-tree'
import { ClusterPropertyAggregator, clusterFeatureTags } from './cluster-props'
import type { ClusterLevel, ClusterOptions, ResolvedClusterOptions } from './types'
import {
  QUANT_SCALE,
  assertClusterIdCapacity,
  clusterIdFor,
  dequantizeUnit,
  quantizeUnit,
  resolveClusterOptions,
  unitToQuant,
} from './units'

/** Hard ceiling on a `getTile` zoom, mirroring `geojsonvt/index.ts`'s `MAX_ALLOWED_ZOOM`.
 *  The two indexes serve one source between them, so a zoom one accepts and the other
 *  rejects would be a hole in the middle of the split. */
const MAX_TILE_ZOOM = 25

/** The unit-square projections of every indexed point, kept at FULL Float64 precision
 *  alongside the quantized records. Design §2's "unclustered output is drift-free": a
 *  single point is emitted from HERE, never from the Int32 store, whose half-step is
 *  ~1.9 cm at the equator — invisible, and exactly the kind of silent divergence
 *  CLAUDE.md §5 exists for. Cluster centroids have no such source and are read back from
 *  the store; they are averages of many points and the quantum is far below the radius of
 *  the circle drawn for them. */
interface IndexedPoints {
  x: Float64Array
  y: Float64Array
  props: (Record<string, unknown> | null)[]
  ids: (string | number | undefined)[]
  /** Input FEATURES that contributed no indexed point — see `skippedFeatureCount`. */
  skipped: number
}

export class PointCluster {
  readonly options: ResolvedClusterOptions
  /** Input features dropped because they are not Point / MultiPoint (design §4.6).
   *
   *  Upstream would index a LineString at whatever `coordinates[0]` destructures to — a
   *  silent wrong position — and reproducing that "for compatibility" would be shipping a
   *  bug on purpose. The count is surfaced rather than logged here because the diagnostic
   *  §4.6 asks for names the SOURCE, and the source name lives with the P3 caller; this
   *  module is not given one. */
  readonly skippedFeatureCount: number

  private readonly points: IndexedPoints
  /** Indexed by zoom, `0 … maxZoom + 1`. `maxZoom + 1` is the raw point level. */
  private readonly levels: ClusterLevel[]
  /** Aggregated `clusterProperties` bags, addressed by `ClusterLevel.prop`. */
  private readonly aggregated: Record<string, unknown>[] = []
  private readonly aggregator: ClusterPropertyAggregator | null

  constructor(data: GeoJSONInput, options?: Partial<ClusterOptions>) {
    this.options = resolveClusterOptions(options)
    this.points = collectPoints(data)
    this.skippedFeatureCount = this.points.skipped
    assertClusterIdCapacity(this.points.x.length, this.options.maxZoom)
    this.aggregator = this.options.clusterProperties
      ? new ClusterPropertyAggregator(this.options.clusterProperties)
      : null

    const maxZoom = this.options.maxZoom
    this.levels = new Array<ClusterLevel>(maxZoom + 2)
    this.levels[maxZoom + 1] = rawLevel(this.points)
    for (let z = maxZoom; z >= 0; z--) {
      this.levels[z] = this.buildLevel(this.levels[z + 1], z)
    }
  }

  /** The tile at `(z, x, y)` with coordinates in extent units, or `null` when it holds no
   *  features — the same contract `GeoJSONVT.getTile` has, so the P3 router can treat the
   *  two indexes identically. */
  getTile(z: number, x: number, y: number): TransformedTile | null {
    const tz = Math.floor(+z)
    if (!Number.isFinite(tz) || tz < 0 || tz > MAX_TILE_ZOOM) return null
    const z2 = 2 ** tz
    // Wrap x around the antimeridian exactly as `GeoJSONVT.getTile` does. Upstream
    // supercluster does not, but the two indexes answer for ONE source: a viewport that
    // asks for x = -1 would otherwise get a tile from one and null from the other.
    const tx = (x + z2) & (z2 - 1)
    const ty = y

    const level = this.levels[Math.max(0, Math.min(tz, this.options.maxZoom + 1))]
    // Tile-fraction padding, so a point just outside the tile still reaches a style that
    // draws a cluster circle overlapping the edge (§2 — the box is expanded by
    // `radius/extent` on every side).
    const p = this.options.radiusExtent / this.options.extent
    const top = unitToQuant((ty - p) / z2)
    const bottom = unitToQuant((ty + 1 + p) / z2)

    const features: TransformedTileFeature[] = []
    this.addTileFeatures(
      level,
      level.tree.range(unitToQuant((tx - p) / z2), top, unitToQuant((tx + 1 + p) / z2), bottom),
      tx,
      ty,
      z2,
      features,
    )
    // The two antimeridian arms: the world's right edge bleeding into the leftmost tile
    // and vice versa, each emitted against a shifted tile origin so the coordinates land
    // in that tile's buffer.
    if (tx === 0) {
      this.addTileFeatures(
        level,
        level.tree.range(unitToQuant(1 - p / z2), top, unitToQuant(1), bottom),
        z2,
        ty,
        z2,
        features,
      )
    }
    if (tx === z2 - 1) {
      this.addTileFeatures(
        level,
        level.tree.range(unitToQuant(0), top, unitToQuant(p / z2), bottom),
        -1,
        ty,
        z2,
        features,
      )
    }

    if (features.length === 0) return null
    return finishTile(features, tx, ty, tz, this.options.extent)
  }

  /** One zoom of the hierarchy from the level above it. Mirrors upstream `_cluster`. */
  private buildLevel(prev: ClusterLevel, zoom: number): ClusterLevel {
    const { extent, radiusExtent, minPoints } = this.options
    // The neighbourhood radius, unit-square → quantized domain. Halving per zoom is what
    // makes a pair separate as the map zooms in; without the `2 ** zoom` the hierarchy
    // collapses to one clustering decision repeated at every level.
    const r = (radiusExtent / (extent * 2 ** zoom)) * QUANT_SCALE
    const n = prev.num.length
    // Pass-local, not a record column — see `ClusterLevel`'s note for why that is exactly
    // equivalent to upstream's carried-forward `OFFSET_ZOOM` mark.
    const processed = new Uint8Array(n)
    const out = emptyLevelBuilder()

    for (let i = 0; i < n; i++) {
      if (processed[i]) continue
      processed[i] = 1

      const x = prev.x[i]
      const y = prev.y[i]
      const neighbours = prev.tree.within(x, y, r)
      const numPointsOrigin = prev.num[i]
      let numPoints = numPointsOrigin
      for (const k of neighbours) if (!processed[k]) numPoints += prev.num[k]

      // The admission rule, both halves: something must actually merge, AND the result
      // must reach `minPoints`. `>=` not `>`, and `minPoints` is not rounded — a
      // fractional 2.4 legitimately means "3 or more".
      if (numPoints > numPointsOrigin && numPoints >= minPoints) {
        // Centroid weighted by CHILD POINT COUNTS, not the arithmetic mean of positions:
        // a cluster of 9 merging with a lone point must land next to the 9.
        let wx = x * numPointsOrigin
        let wy = y * numPointsOrigin
        const id = clusterIdFor(i, zoom, this.points.x.length)
        let acc: Record<string, unknown> | null = null
        let propIndex = -1

        for (const k of neighbours) {
          if (processed[k]) continue
          processed[k] = 1
          const kNum = prev.num[k]
          wx += prev.x[k] * kNum
          wy += prev.y[k] * kNum
          if (this.aggregator !== null) {
            if (acc === null) {
              // Seeded from the ORIGIN's own mapped bag — the origin is never reduced
              // into the accumulator, mirroring `wx`'s seeding above.
              acc = this.mappedOf(prev, i, true)
              propIndex = this.aggregated.length
              this.aggregated.push(acc)
            }
            this.aggregator.reduce(acc, this.mappedOf(prev, k, false))
          }
        }

        pushRecord(
          out,
          Math.round(wx / numPoints),
          Math.round(wy / numPoints),
          id,
          numPoints,
          propIndex,
        )
      } else {
        copyRecord(out, prev, i)
        // The else-branch ALSO consumes its unprocessed neighbours: a neighbourhood that
        // failed `minPoints` is not re-examined at this zoom from another seed. Dropping
        // this loop does not merely change performance — a neighbour left unprocessed
        // becomes a seed of its own and can form a cluster the reference never forms.
        if (numPoints > 1) {
          for (const k of neighbours) {
            if (processed[k]) continue
            processed[k] = 1
            copyRecord(out, prev, k)
          }
        }
      }
    }

    return finishLevel(out)
  }

  /** The mapped `clusterProperties` bag behind one record: a cluster's stored aggregate,
   *  or a freshly mapped bag for a single point. */
  private mappedOf(level: ClusterLevel, i: number, clone: boolean): Record<string, unknown> {
    const aggregator = this.aggregator as ClusterPropertyAggregator
    if (level.num[i] > 1) {
      const stored = this.aggregated[level.prop[i]]
      return clone ? { ...stored } : stored
    }
    return aggregator.map(this.points.props[level.id[i]])
  }

  private addTileFeatures(
    level: ClusterLevel,
    ids: number[],
    tx: number,
    ty: number,
    z2: number,
    out: TransformedTileFeature[],
  ): void {
    const extent = this.options.extent
    for (const i of ids) {
      const num = level.num[i]
      let tags: Record<string, unknown> | null
      let px: number
      let py: number
      let id: string | number | undefined

      if (num > 1) {
        const clusterId = level.id[i]
        const propIndex = level.prop[i]
        tags = clusterFeatureTags(
          num,
          clusterId,
          propIndex >= 0 ? this.aggregated[propIndex] : null,
        )
        px = dequantizeUnit(level.x[i])
        py = dequantizeUnit(level.y[i])
        id = clusterId
      } else {
        // The drift-free half — see `IndexedPoints`.
        const origin = level.id[i]
        tags = this.points.props[origin]
        px = this.points.x[origin]
        py = this.points.y[origin]
        id = this.points.ids[origin]
      }

      const feature: TransformedTileFeature = {
        type: 1,
        geometry: [transformPoint(px, py, extent, z2, tx, ty)],
        tags,
      }
      if (id !== undefined) feature.id = id
      out.push(feature)
    }
  }
}

/** Convenience constructor mirroring `geojsonvt(data, options)`. */
export function pointCluster(data: GeoJSONInput, options?: Partial<ClusterOptions>): PointCluster {
  return new PointCluster(data, options)
}

// ── input ───────────────────────────────────────────────────────────

function collectPoints(data: GeoJSONInput): IndexedPoints {
  const x: number[] = []
  const y: number[] = []
  const props: (Record<string, unknown> | null)[] = []
  const ids: (string | number | undefined)[] = []
  let skipped = 0

  const add = (
    geometry: GeoJSONGeometry | null | undefined,
    p: Record<string, unknown> | null,
    id: string | number | undefined,
  ) => {
    const before = x.length
    if (geometry) {
      if (geometry.type === 'Point') {
        pushPoint(x, y, props, ids, geometry.coordinates, p, id)
      } else if (geometry.type === 'MultiPoint') {
        // Expanded per coordinate, as upstream: every member becomes its own indexed
        // point sharing the parent feature's properties and id.
        for (const c of geometry.coordinates) pushPoint(x, y, props, ids, c, p, id)
      }
    }
    // A feature that contributed nothing — a LineString, a Polygon, a
    // GeometryCollection, an unlocated `geometry: null`, or coordinates that are not a
    // usable pair. Counted once, never indexed at a made-up position.
    if (x.length === before) skipped++
  }

  if (data.type === 'FeatureCollection') {
    for (const f of data.features ?? []) add(f.geometry, f.properties ?? null, f.id)
  } else if (data.type === 'Feature') {
    add(data.geometry as GeoJSONGeometry | null, data.properties ?? null, data.id)
  } else {
    // A bare geometry (`{ type: 'Point', coordinates: … }`), the third shape
    // `GeoJSONInput` models.
    add(
      { type: data.type, coordinates: data.coordinates } as GeoJSONGeometry,
      data.properties ?? null,
      data.id,
    )
  }

  return { x: Float64Array.from(x), y: Float64Array.from(y), props, ids, skipped }
}

function pushPoint(
  x: number[],
  y: number[],
  props: (Record<string, unknown> | null)[],
  ids: (string | number | undefined)[],
  coords: unknown,
  p: Record<string, unknown> | null,
  id: string | number | undefined,
): void {
  if (!Array.isArray(coords) || coords.length < 2) return
  const lon = coords[0] as number
  const lat = coords[1] as number
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return
  x.push(projectX(lon))
  y.push(projectY(lat))
  props.push(p)
  ids.push(id)
}

// ── level construction ──────────────────────────────────────────────

interface LevelBuilder {
  x: number[]
  y: number[]
  id: number[]
  num: number[]
  prop: number[]
}

function emptyLevelBuilder(): LevelBuilder {
  return { x: [], y: [], id: [], num: [], prop: [] }
}

function pushRecord(
  out: LevelBuilder,
  x: number,
  y: number,
  id: number,
  num: number,
  prop: number,
): void {
  out.x.push(x)
  out.y.push(y)
  out.id.push(id)
  out.num.push(num)
  out.prop.push(prop)
}

function copyRecord(out: LevelBuilder, prev: ClusterLevel, i: number): void {
  pushRecord(out, prev.x[i], prev.y[i], prev.id[i], prev.num[i], prev.prop[i])
}

function finishLevel(out: LevelBuilder): ClusterLevel {
  const x = Int32Array.from(out.x)
  const y = Int32Array.from(out.y)
  return {
    x,
    y,
    id: Float64Array.from(out.id),
    num: Int32Array.from(out.num),
    prop: Int32Array.from(out.prop),
    tree: new ClusterKdTree(x, y, out.x.length),
  }
}

/** The `maxZoom + 1` level: one record per indexed point, `id` = its index into the
 *  retained originals, `num` = 1. */
function rawLevel(points: IndexedPoints): ClusterLevel {
  const n = points.x.length
  const x = new Int32Array(n)
  const y = new Int32Array(n)
  const id = new Float64Array(n)
  const num = new Int32Array(n)
  const prop = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    x[i] = quantizeUnit(points.x[i])
    y[i] = quantizeUnit(points.y[i])
    id[i] = i
    num[i] = 1
    prop[i] = -1
  }
  return { x, y, id, num, prop, tree: new ClusterKdTree(x, y, n) }
}

/** Wrap the emitted features in the `TransformedTile` `encodeMVT` reads. The bbox is in
 *  geojson-vt's pre-multiply space (`c · 2^z − tileIndex`), the same space
 *  `InternalTile.minX` carries, recovered from the emitted extent coordinates so the two
 *  cannot disagree. */
function finishTile(
  features: TransformedTileFeature[],
  x: number,
  y: number,
  z: number,
  extent: number,
): TransformedTile {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const f of features) {
    const [gx, gy] = (f.geometry as [number, number][])[0]
    if (gx < minX) minX = gx
    if (gx > maxX) maxX = gx
    if (gy < minY) minY = gy
    if (gy > maxY) maxY = gy
  }
  return {
    features,
    numPoints: features.length,
    numSimplified: features.length,
    numFeatures: features.length,
    source: null,
    x,
    y,
    z,
    transformed: true,
    minX: minX / extent,
    minY: minY / extent,
    maxX: maxX / extent,
    maxY: maxY / extent,
  }
}
