// ═══ Vector Tiler ═══
// Compiles GeoJSON → pyramid of GPU-ready tiles (COG-style overview levels).
// Per-part decomposition: MultiPolygons are split into individual parts
// with tighter bounding boxes, dramatically reducing tile scatter for large features.

import earcut from 'earcut'
import { simplifyPolygon, simplifyLine, mercatorToleranceForZoom } from './simplify'
import { clipPolygonToRect, clipLineToRect, splitBoundaryBacktracks } from './clip'
import { precisionForZoomMM } from './encoding'
import type { GeoJSONFeatureCollection, GeoJSONFeature } from './geojson-types'
import { tileKey, tileKeyUnpack } from './vector-tiler-helpers'
import type {
  CompiledTileSet,
  PropertyTable,
  PropertyFieldType,
  TileLevel,
  CompiledTile,
  GeometryPart,
  FeatureIdResolver,
  TilerOptions,
} from './vector-tiler-types'

// Re-export shared types so the module's public surface is unchanged.
export type {
  CompiledTileSet,
  PropertyTable,
  PropertyFieldType,
  TileLevel,
  CompiledTile,
  GeometryPart,
  FeatureIdResolver,
  TilerOptions,
} from './vector-tiler-types'

// Re-export tile-key helpers so the module's public surface is unchanged.
export {
  mortonEncode,
  mortonDecode,
  tileKey,
  tileKeyUnpack,
  tileKeyParent,
  tileKeyChildren,
} from './vector-tiler-helpers'

/** Tile coordinate extent (like MVT 4096, but higher for military precision) */
export const TILE_EXTENT = 8192

// ═══ ECEF / DSFUN GPU byte-packing kernels ═══
// The byte-layout-exact serialization cluster (lonLatToMercF64, splitF64,
// packECEFPointFeatures, packECEFPolygonVertices, projectRingsToMM,
// packECEFLineSegments, packDSFUNLineVertices + the per-tile ECEF anchor
// tileEcefCenterFromMerc) now lives in ./ecef-packing — a pure module the five
// byte-for-byte fuzz tests pin directly. The tiler imports the packers it calls
// in the per-tile assembly back here and re-exports the public surface so
// downstream (@xgis/compiler barrel + direct ./vector-tiler importers) are
// unchanged.
import {
  lonLatToMercF64,
  projectRingsToMM,
  packECEFPointFeatures,
  packECEFPolygonVertices,
  packDSFUNLineVertices,
  tileEcefCenterFromMerc,
  DSFUN_EARTH_R,
  DSFUN_DEG2RAD,
} from './ecef-packing'
import { subdivideGreatCircle } from './geometry-sphere'
import { tilePolygonPart } from './polygon-tiler'
import { tileLinePart } from './line-tiler'
import { tilePointPart } from './point-tiler'

// Re-export the byte-packing kernels so the module's public surface is
// unchanged (the @xgis/compiler barrel re-points to ./ecef-packing directly;
// these keep direct `./vector-tiler` importers — e.g. korea-z7-clip-backtrack
// — resolving without change).
export {
  lonLatToMercF64,
  splitF64,
  projectRingsToMM,
  packECEFPointFeatures,
  packECEFPolygonVertices,
  packECEFLineSegments,
  packDSFUNLineVertices,
  tileEcefCenterFromMerc,
  type QuantizedPolygonVertices,
} from './ecef-packing'

// ═══ Geometry Part ═══
// `GeometryPart` + `FeatureIdResolver` types live in vector-tiler-types.ts.

const defaultIdResolver: FeatureIdResolver = (_f, i) => i

export function decomposeFeatures(
  features: GeoJSONFeature[],
  idResolver: FeatureIdResolver = defaultIdResolver,
): GeometryPart[] {
  const parts: GeometryPart[] = []

  // Recursive per-geometry dispatch so a GeometryCollection (RFC 7946
  // §3.1.8) decomposes each member under the parent id — matches the
  // sibling geojson-vt path; was a silent drop (zero parts) before.
  function decomposeGeom(geom: GeoJSONFeature['geometry'], id: number): void {
    if (!geom) return
    if (geom.type === 'Polygon') {
      const rings = geom.coordinates as number[][][]
      parts.push(makePolygonPart(rings, id))
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates as number[][][][]) {
        parts.push(makePolygonPart(poly, id))
      }
    } else if (geom.type === 'LineString') {
      const coords = geom.coordinates as number[][]
      parts.push(makeLinePart(coords, id))
    } else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates as number[][][]) {
        parts.push(makeLinePart(line, id))
      }
    } else if (geom.type === 'Point') {
      const coord = geom.coordinates as number[]
      parts.push({
        type: 'point',
        point: coord,
        featureIndex: id,
        minLon: coord[0],
        minLat: coord[1],
        maxLon: coord[0],
        maxLat: coord[1],
      })
    } else if (geom.type === 'MultiPoint') {
      for (const coord of geom.coordinates as number[][]) {
        parts.push({
          type: 'point',
          point: coord,
          featureIndex: id,
          minLon: coord[0],
          minLat: coord[1],
          maxLon: coord[0],
          maxLat: coord[1],
        })
      }
    } else if ((geom as { type: string }).type === 'GeometryCollection') {
      const members =
        (geom as unknown as { geometries?: GeoJSONFeature['geometry'][] }).geometries ?? []
      for (const member of members) decomposeGeom(member, id)
    }
  }

  for (let fi = 0; fi < features.length; fi++) {
    const feature = features[fi]
    if (!feature.geometry) continue
    decomposeGeom(feature.geometry, idResolver(feature, fi))
  }

  return parts
}

function makePolygonPart(rings: number[][][], featureIndex: number): GeometryPart {
  // BBox is computed in LL (for cheap bbox-reject against LL tile
  // bounds). Rings themselves are pre-projected to MERCATOR METERS
  // so every downstream per-tile compile skips the projection step —
  // matches Tippecanoe / Mapbox's "project once at source load"
  // pattern, and keeps the compileTileOnDemand hot path O(clipped
  // vertices) instead of O(source vertices × tiles).
  //
  // Great-circle subdivision is NOT applied here (only on lines —
  // makeLinePart). Polygon fill and outline both derive from the same
  // un-simplified `clipped` ring per tile (see processZoomLevelShared /
  // compileSingleTile), so they coincide by construction (d34aed2).
  const bbox = ringsBBox(rings[0])
  const mmRings = projectRingsToMM(rings)
  return { type: 'polygon', rings: mmRings, featureIndex, ...bbox }
}

function makeLinePart(coords: number[][], featureIndex: number): GeometryPart {
  // Same great-circle subdivision as makePolygonPart — see the
  // comment there. Without this, fixtures like `[[-30, 0], [30, 0]]`
  // render as a chord cutting through the orthographic globe.
  const subdivided = subdivideGreatCircle(coords)
  const bbox = coordsBBox(subdivided)
  return { type: 'line', coords: subdivided, featureIndex, ...bbox }
}

function ringsBBox(ring: number[][]): {
  minLon: number
  minLat: number
  maxLon: number
  maxLat: number
} {
  let minLon = Infinity,
    minLat = Infinity,
    maxLon = -Infinity,
    maxLat = -Infinity
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
  }
  return { minLon, minLat, maxLon, maxLat }
}

function coordsBBox(coords: number[][]): {
  minLon: number
  minLat: number
  maxLon: number
  maxLat: number
} {
  return ringsBBox(coords)
}

/** Even-odd-rule point-in-polygon test for a single ring. Returns
 *  true when (x, y) is strictly inside `ring`, false otherwise.
 *  Boundary classification is technically undefined per the
 *  algorithm; in practice the caller (hole-distribution loop in
 *  compileSingleTile) tests the hole's first vertex which is
 *  always interior to the source polygon, so boundary cases don't
 *  fire. */
function pointInRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false
  const n = ring.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i]![0]!,
      yi = ring[i]![1]!
    const xj = ring[j]![0]!,
      yj = ring[j]![1]!
    // Ray from (x, y) extending right (positive X). Edge crosses
    // iff its endpoints straddle the ray's Y AND the intersection X
    // is to the right of `x`.
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (crosses) inside = !inside
  }
  return inside
}

/** Pick the sub-outer that owns a hole after `splitBoundaryBacktracks`
 *  fragmented the outer ring into `effectiveOuters`. Testing only
 *  `hole[0]` (the old behaviour) SILENTLY DROPPED a hole whose first
 *  vertex landed in a concavity between sub-outers or in a region the
 *  split cut away — the fill then painted over the cutout. This never
 *  drops a real hole: it scans EVERY hole vertex (a hole interior to a
 *  sub-outer always has an interior vertex, and a point cannot be strictly
 *  interior to two disjoint-interior sub-outers, so the first hit is the
 *  correct bucket), then falls back to the largest-area sub-outer so every
 *  surviving hole lands in exactly one bucket. (The centroid is deliberately
 *  NOT probed: a non-convex hole's centroid can fall outside its own ring —
 *  inside a NEIGHBOURING sub-outer — and mis-bucket; vertices cannot.) */
export function assignHoleBucket(hole: number[][], effectiveOuters: number[][][]): number {
  // 1. Every hole vertex (hole[0] first = the common in-one-sub-outer case).
  //    Each probe point is ON the hole's own ring, so it is interior to the
  //    hole's true container and to no other sub-outer.
  for (let vi = 0; vi < hole.length; vi++) {
    for (let si = 0; si < effectiveOuters.length; si++) {
      if (pointInRing(hole[vi]![0]!, hole[vi]![1]!, effectiveOuters[si]!)) return si
    }
  }
  // 2. Last resort — the largest sub-outer. A clipped hole that matches no
  //    sub-outer by point test still belongs to the feature; bucketing it
  //    here keeps it in the ring set (earcut handles a hole that pokes
  //    slightly past the outer) instead of erasing the cutout entirely.
  let largest = 0,
    largestArea = -1
  for (let si = 0; si < effectiveOuters.length; si++) {
    const a = Math.abs(shoelaceArea(effectiveOuters[si]!))
    if (a > largestArea) {
      largestArea = a
      largest = si
    }
  }
  return largest
}

// ═══ Tile Math ═══

function tileBounds(
  z: number,
  x: number,
  y: number,
): { west: number; south: number; east: number; north: number } {
  const n = Math.pow(2, z)
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    north: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
    south: (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI,
  }
}

function lonToTileX(lon: number, z: number): number {
  const n = Math.pow(2, z)
  return Math.max(0, Math.min(n - 1, Math.floor(((lon + 180) / 360) * n)))
}

function latToTileY(lat: number, z: number): number {
  const n = Math.pow(2, z)
  const clamped = Math.max(-85.0511287, Math.min(85.0511287, lat))
  return Math.max(
    0,
    Math.min(
      n - 1,
      Math.floor(
        ((1 -
          Math.log(Math.tan((clamped * Math.PI) / 180) + 1 / Math.cos((clamped * Math.PI) / 180)) /
            Math.PI) /
          2) *
          n,
      ),
    ),
  )
}

// ═══ Full Cover Detection ═══

/** Signed area of a ring via shoelace formula (degrees²) */
function shoelaceArea(ring: number[][]): number {
  let area = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const j = (i + 1) % n
    area += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1]
  }
  return area / 2
}

// ═══ Tessellation ═══
//
// Note: the old `latToMercatorY(lat)` helper was removed when
// `tessellatePolygonToArrays` moved to MM-native input (commit
// 5ee001c — industry-standard pipeline). Earcut now runs directly
// on MM coords since all upstream clipping + simplification already
// happens in MM, so the "project-just-for-earcut" step became a
// no-op.

/** Vertex dedup key: quantize x/y to 1e6 (~0.1m) and pack into a
 *  single 53-bit-safe number combined with featureId.
 *
 *  Layout (all integer arithmetic, no string allocation):
 *    qx = (x * 1e6) | 0  → 32-bit signed; offset to non-negative via +2^31
 *    qy = (y * 1e6) | 0  → same
 *    key = (qx + 2^31) * 2^22 + (qy + 2^31 & 0x3FFFFF) ⊕ (fid * 0x9e3779b1)
 *
 *  Strict uniqueness for the (qx, qy, fid) triple isn't guaranteed by
 *  this packing — qy uses only 22 bits, dropping the high bits of any
 *  vertex more than ±2.1m × 2^22 / 1e6 ≈ ±2 billion meters from the
 *  origin (well outside the ±20M MM range used by Web Mercator), so
 *  collisions are mathematically impossible inside the planet.
 *  featureId is folded in via XOR with a 32-bit prime so distinct
 *  features at the same (qx, qy) hash to different cells.
 *
 *  Performance: previously a `${qx},${qy},${fid}` template literal
 *  allocated a new string per vertex (top-3 GC source in PMTiles v4
 *  perf profile). Numeric Map keys avoid both the allocation and the
 *  V8 internal string hash. */
function vertexKey(x: number, y: number, fid: number): string {
  // Pre-MM refactor this was a packed int32 over (x*1e6, y*1e6, fid) —
  // valid when input was LL degrees (±180 → ±1.8e8 fits int32). After
  // the polygon pipeline moved to absolute Mercator meters, x/y range
  // ±2.0e7 m so x*1e6 ≈ ±2e13 OVERFLOWS int32 catastrophically — the
  // `| 0` truncation produced essentially random bits and adjacent
  // vertices collided into shared dedup slots. earcut then received
  // self-intersecting/degenerate index lists and emitted huge wedge
  // triangles spanning entire ocean tiles (visible as triangular
  // artifacts in pmtiles_layered at z=3-5).
  //
  // String key with 1mm quantization (Math.round(coord * 1000)) is
  // unambiguous, collision-free, and only ~2x slower than the broken
  // numeric hash on V8 (Map<string,number> internalises short ASCII
  // strings). Tessellation runs off-thread on the worker pool, so the
  // perf delta is invisible at the frame level.
  return `${Math.round(x * 1000)},${Math.round(y * 1000)},${fid | 0}`
}

// ── Triangle subdivision for non-Mercator projections ─────────────────
// earcut produces triangles whose edges are straight lines in MM. When the
// runtime renders under a non-Mercator projection (orthographic, oblique,
// etc.), the GPU rasterizer linearly interpolates triangle interiors in
// SCREEN space, so a triangle whose vertices span large angular distance
// renders as a screen-space-straight chord instead of curving along the
// surface. The visible artifacts are wedges, antimeridian shortcuts, and
// horizontal stripes at the Mercator clamp.
//
// Densifying the mesh — splitting any triangle whose edge exceeds
// MAX_TRI_DEGREES_FOR_PROJ in lon/lat angular distance into 4 sub-triangles
// at MM midpoints — reduces each chord to a smaller angular span, so the
// per-triangle screen-space approximation tracks the surface closely.
//
// Mirrors the legacy logic in runtime/src/loader/geojson.ts that was lost
// when GeoJSON polygon rendering moved to the tile-based pipeline. Linear
// MM midpoints (not great-circle slerp) are sufficient for the visible
// wedge artifact and stay consistent with the MM-throughout pipeline; a
// future quality pass could swap in geodesic midpoints for high-latitude
// polygons spanning >10° if needed.
const MAX_TRI_DEGREES_FOR_PROJ = 2
const MAX_TRI_SUBDIVIDE_DEPTH = 5

function mmToLonLatDeg(x: number, y: number): [number, number] {
  const lon = x / DSFUN_EARTH_R / DSFUN_DEG2RAD
  const lat = (2 * Math.atan(Math.exp(y / DSFUN_EARTH_R)) - Math.PI / 2) / DSFUN_DEG2RAD
  return [lon, lat]
}

// lonLatDegToMM was the inverse of mmToLonLatDeg used by
// geodesicMidpointMM (iter 6, reverted iter 56). Removed with the
// geodesicMidpointMM revert; the slerp / Mercator round-trip
// pattern stays documented in the iter-56 commit body for any
// future projection-aware refinement.

/** Geodesic midpoint of two MM points: project both to lon/lat,
 *  slerp on the sphere at t=0.5, project back to MM. Used when a
 *  triangle's edges span enough latitude/longitude that the linear
 *  MM midpoint diverges visibly from the great-circle midpoint on
 *  globe / orthographic / stereographic projections (z=0..3 country
 *  polygons). For small edges the linear midpoint is already
 *  indistinguishable from slerp; the caller gates via edge span.
 *  Slerp is symmetric in t=0.5 so adjacent triangles sharing an edge
 *  produce identical midpoints — dedupMap keeps the mesh watertight. */
// NOTE: geodesicMidpointMM removed in iter 56 — iter 6 introduction
// caused z=0 banding artefacts on production deploy that iter 41's
// 60°-cap didn't fully fix. Reverted to pre-iter-6 linear-midpoint
// behaviour. Helper definition kept inline for reference if a
// future runtime-projection-aware refinement lands.
/*
function geodesicMidpointMM(x0: number, y0: number, x1: number, y1: number): [number, number] {
  const [lon0, lat0] = mmToLonLatDeg(x0, y0)
  const [lon1, lat1] = mmToLonLatDeg(x1, y1)
  const [mLon, mLat] = slerpLonLat(lon0, lat0, lon1, lat1, 0.5)
  return lonLatDegToMM(mLon, mLat)
}
*/

/** Get-or-add a vertex (MM coords) into the dedup-mapped output array.
 *  Stride-3 layout: x, y, featureId. Returns the global vertex index. */
function getOrAddVertexMM(
  x: number,
  y: number,
  featureId: number,
  outVerts: number[],
  dedupMap: Map<string, number>,
): number {
  const key = vertexKey(x, y, featureId)
  let idx = dedupMap.get(key)
  if (idx === undefined) {
    idx = outVerts.length / 3
    outVerts.push(x, y, featureId)
    dedupMap.set(key, idx)
  }
  return idx
}

/** Recursively split a triangle into 4 at MM midpoints when any edge
 *  exceeds the angular threshold. Adjacent triangles sharing an edge
 *  share the same midpoint via dedupMap, so the densified mesh stays
 *  watertight (no gaps, no T-junctions). */
function subdivideTriangleMM(
  i0: number,
  i1: number,
  i2: number,
  featureId: number,
  outVerts: number[],
  outIdx: number[],
  dedupMap: Map<string, number>,
  depth: number,
): void {
  const x0 = outVerts[i0 * 3],
    y0 = outVerts[i0 * 3 + 1]
  const x1 = outVerts[i1 * 3],
    y1 = outVerts[i1 * 3 + 1]
  const x2 = outVerts[i2 * 3],
    y2 = outVerts[i2 * 3 + 1]

  // Fast MM-space early-out: if all edges are clearly below the
  // angular threshold, skip the expensive mmToLonLatDeg projection
  // entirely. 2° lon → 222 km in MM; lat is denser at high latitudes
  // (lat 85: 1° ≈ 1500 km MM) so we use a conservative MM bound that
  // can NEVER exceed 2° in either direction. 50 km MM is below 0.45°
  // lon at any latitude AND below 0.5° lat at lat<85. Any triangle
  // entirely below this skips both projection and subdivision —
  // which is the common case at z>=8 (tile spans <0.7° at z=8).
  const FAST_SKIP_MM = 50_000
  const dx01 = Math.abs(x1 - x0),
    dy01 = Math.abs(y1 - y0)
  const dx12 = Math.abs(x2 - x1),
    dy12 = Math.abs(y2 - y1)
  const dx20 = Math.abs(x0 - x2),
    dy20 = Math.abs(y0 - y2)
  if (
    dx01 < FAST_SKIP_MM &&
    dy01 < FAST_SKIP_MM &&
    dx12 < FAST_SKIP_MM &&
    dy12 < FAST_SKIP_MM &&
    dx20 < FAST_SKIP_MM &&
    dy20 < FAST_SKIP_MM
  ) {
    outIdx.push(i0, i1, i2)
    return
  }

  const [lon0, lat0] = mmToLonLatDeg(x0, y0)
  const [lon1, lat1] = mmToLonLatDeg(x1, y1)
  const [lon2, lat2] = mmToLonLatDeg(x2, y2)
  const d01 = Math.max(Math.abs(lon1 - lon0), Math.abs(lat1 - lat0))
  const d12 = Math.max(Math.abs(lon2 - lon1), Math.abs(lat2 - lat1))
  const d20 = Math.max(Math.abs(lon0 - lon2), Math.abs(lat0 - lat2))
  const maxEdge = Math.max(d01, d12, d20)

  if (maxEdge <= MAX_TRI_DEGREES_FOR_PROJ || depth >= MAX_TRI_SUBDIVIDE_DEPTH) {
    outIdx.push(i0, i1, i2)
    return
  }

  // Linear MM midpoint — matches the pre-iter-6 baseline that was
  // shipped to production without z=0 banding artefacts. Iter 6
  // added geodesic (slerp) midpoint for sphere projections (globe /
  // ortho / azimuth / stereo) but introduced regressions at z=0
  // Mercator (user-reported on x-gis.github.io, iter 56). Iter 41
  // capped the slerp to (5°, 60°) but the regression persisted in
  // deploy. Reverting to linear midpoint entirely — the chord-vs-
  // arc fidelity loss on globe was the documented acceptable
  // baseline before iter 6 anyway. Plan §6 (geodesic refinement)
  // deferred until a robust runtime-projection-aware path lands.
  const m01x = (x0 + x1) * 0.5,
    m01y = (y0 + y1) * 0.5
  const m12x = (x1 + x2) * 0.5,
    m12y = (y1 + y2) * 0.5
  const m20x = (x2 + x0) * 0.5,
    m20y = (y2 + y0) * 0.5
  const i01 = getOrAddVertexMM(m01x, m01y, featureId, outVerts, dedupMap)
  const i12 = getOrAddVertexMM(m12x, m12y, featureId, outVerts, dedupMap)
  const i20 = getOrAddVertexMM(m20x, m20y, featureId, outVerts, dedupMap)

  subdivideTriangleMM(i0, i01, i20, featureId, outVerts, outIdx, dedupMap, depth + 1)
  subdivideTriangleMM(i01, i1, i12, featureId, outVerts, outIdx, dedupMap, depth + 1)
  subdivideTriangleMM(i20, i12, i2, featureId, outVerts, outIdx, dedupMap, depth + 1)
  subdivideTriangleMM(i01, i12, i20, featureId, outVerts, outIdx, dedupMap, depth + 1)
}

/** Densify a polygon-OUTLINE MM chain by inserting linear-MM midpoints on any
 *  segment whose lon/lat angular span exceeds MAX_TRI_DEGREES_FOR_PROJ — the SAME
 *  gate `subdivideTriangleMM` applies to the FILL's triangle edges. The clipped-ring
 *  outline is stroked as straight chords (`augmentChainWithArc` inserts no vertices),
 *  so on globe / non-Mercator projections a long low-zoom edge cuts straight across the
 *  sphere while the densified fill boundary curves (issue #585). Densifying the outline
 *  with the fill's gate makes the stroke follow the same curve as the fill it traces.
 *  Linear midpoints are collinear with the parent segment, so fill/outline coincidence
 *  (the d34aed2 invariant) is preserved. This revives the densification cc497884 added
 *  and #387's parallel outline path silently dropped on merge.
 *
 *  Returns the densified chain; the original endpoints are always preserved in order. */
function subdivideChainMM(chain: number[][]): number[][] {
  if (chain.length < 2) return chain
  // 50 km MM is below 0.45° lon / 0.5° lat at any latitude < 85 — mirrors
  // subdivideTriangleMM's FAST_SKIP so a short segment skips the projection entirely.
  const FAST_SKIP_MM = 50_000
  const out: number[][] = [chain[0]]
  const emit = (ax: number, ay: number, bx: number, by: number, depth: number): void => {
    if (
      depth < MAX_TRI_SUBDIVIDE_DEPTH &&
      (Math.abs(bx - ax) >= FAST_SKIP_MM || Math.abs(by - ay) >= FAST_SKIP_MM)
    ) {
      const [lonA, latA] = mmToLonLatDeg(ax, ay)
      const [lonB, latB] = mmToLonLatDeg(bx, by)
      if (Math.max(Math.abs(lonB - lonA), Math.abs(latB - latA)) > MAX_TRI_DEGREES_FOR_PROJ) {
        const mx = (ax + bx) * 0.5,
          my = (ay + by) * 0.5
        emit(ax, ay, mx, my, depth + 1)
        emit(mx, my, bx, by, depth + 1)
        return
      }
    }
    out.push([bx, by])
  }
  for (let i = 1; i < chain.length; i++) {
    emit(chain[i - 1][0], chain[i - 1][1], chain[i][0], chain[i][1], 0)
  }
  return out
}

/** Detect whether Sutherland-Hodgman's clipped output ring would cause
 *  earcut to produce overlapping triangles — the failure mode the
 *  `splitBoundaryBacktracks` repair was written for. The test runs a
 *  cheap probe-earcut on the outer ring (with holes treated as negative
 *  regions per earcut's contract) and compares the triangle-area sum
 *  to the polygon's signed area. A self-touching ring produces ≥ 1.5×
 *  coverage (Korea z=7's canonical case is 2.57×). A clean complex
 *  polygon — even a heavily non-convex coastline like demotiles z=6
 *  China — produces ≈ 1.00× coverage.
 *
 *  Returns true when the outer ring has visible self-overlap (caller
 *  should apply the splitter repair); false when earcut would produce
 *  a clean tessellation without help (caller should pass the ring
 *  through unchanged). The cost is one earcut call, which we already
 *  pay during the real tessellation — the probe earcut is a small
 *  overhead specific to this safety check.
 */
export function needsBacktrackRepair(outer: number[][], holes: number[][][]): boolean {
  const flat: number[] = []
  const holeIdx: number[] = []
  for (const p of outer) flat.push(p[0]!, p[1]!)
  for (const hole of holes) {
    holeIdx.push(flat.length / 2)
    for (const p of hole) flat.push(p[0]!, p[1]!)
  }
  const idx = earcut(flat, holeIdx.length > 0 ? holeIdx : undefined)
  let triArea = 0
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t]! * 2,
      i1 = idx[t + 1]! * 2,
      i2 = idx[t + 2]! * 2
    triArea +=
      Math.abs(
        (flat[i1]! - flat[i0]!) * (flat[i2 + 1]! - flat[i0 + 1]!) -
          (flat[i2]! - flat[i0]!) * (flat[i1 + 1]! - flat[i0 + 1]!),
      ) * 0.5
  }
  let ringArea = 0
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    ringArea += (outer[j]![0]! - outer[i]![0]!) * (outer[j]![1]! + outer[i]![1]!)
  }
  ringArea = Math.abs(ringArea / 2)
  for (const hole of holes) {
    let a = 0
    for (let i = 0, j = hole.length - 1; i < hole.length; j = i++) {
      a += (hole[j]![0]! - hole[i]![0]!) * (hole[j]![1]! + hole[i]![1]!)
    }
    ringArea -= Math.abs(a / 2)
  }
  if (ringArea <= 0) return false
  // 1.2× threshold: anything materially over 1.0 means earcut produced
  // overlapping triangles. The Korea regression's broken case is 2.57×;
  // China z=6 is 1.00× to floating-point precision. 1.2 sits well
  // above realistic numerical noise from the simplify + clip pipeline.
  return triArea / ringArea > 1.2
}

export function tessellatePolygonToArrays(
  rings: number[][][],
  featureId: number,
  outVerts: number[],
  outIdx: number[],
  dedupMap?: Map<string, number>,
): void {
  // Input rings are in MERCATOR METERS (MM), per docs/COORDINATES.md.
  // Triangle edges are straight in MM — matches GPU rendering so there's
  // no coastline overshoot from earcut working in a different space than
  // the output vertex buffer. Historical note: used to take lon/lat and
  // project to MM internally just for earcut; removed when the whole
  // polygon pipeline moved to MM to match the industry-standard
  // Mapbox GL / MapLibre / Tippecanoe convention.
  const flatCoords: number[] = []
  const holeIndices: number[] = []

  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holeIndices.push(flatCoords.length / 2)
    for (const coord of rings[r]) {
      flatCoords.push(coord[0], coord[1])
    }
  }

  const earcutIdx = earcut(flatCoords, holeIndices.length > 0 ? holeIndices : undefined)

  if (dedupMap) {
    const localToGlobal: number[] = []
    for (let i = 0; i < flatCoords.length; i += 2) {
      const x = flatCoords[i],
        y = flatCoords[i + 1]
      const key = vertexKey(x, y, featureId)
      let globalIdx = dedupMap.get(key)
      if (globalIdx === undefined) {
        globalIdx = outVerts.length / 3
        outVerts.push(x, y, featureId)
        dedupMap.set(key, globalIdx)
      }
      localToGlobal.push(globalIdx)
    }
    // Densify each earcut triangle so non-Mercator projections can curve
    // along the surface (see subdivideTriangleMM rationale above).
    for (let t = 0; t < earcutIdx.length; t += 3) {
      subdivideTriangleMM(
        localToGlobal[earcutIdx[t]],
        localToGlobal[earcutIdx[t + 1]],
        localToGlobal[earcutIdx[t + 2]],
        featureId,
        outVerts,
        outIdx,
        dedupMap,
        0,
      )
    }
  } else {
    const baseVertex = outVerts.length / 3
    for (let i = 0; i < flatCoords.length; i += 2) {
      outVerts.push(flatCoords[i], flatCoords[i + 1], featureId)
    }
    for (const idx of earcutIdx) {
      outIdx.push(baseVertex + idx)
    }
  }
}

/**
 * Project an open polyline OR a closed polygon ring to Mercator meters
 * with per-vertex arc-length + tangents — the lossless input shape that
 * `clipLineToRect` and `tessellateLineToArrays` expect. Each output
 * vertex is a 7-tuple `[mxAbs, myAbs, arcStart, tin_x, tin_y, tout_x,
 * tout_y]`; arcStart and tangents are computed once on the ORIGINAL
 * unclipped chain so they survive tile splitting (clipLineToRect
 * interpolates arc at boundary crossings; tangents at original vertices
 * are preserved as-is, mid-segment clip points get zero tangents and
 * the runtime falls back to its boundary-detection heuristic).
 *
 * `closed=true` treats the input as a polygon ring: the last vertex
 * connects back to the first, the closing segment contributes to the
 * arc total, and the wrap vertex is appended so the renderer can draw
 * the close-segment without inventing a cap. GeoJSON's "first vertex
 * duplicated at end" convention is detected and stripped — passing a
 * `[A, B, C, D, A]` ring works the same as passing `[A, B, C, D]`.
 *
 * `closed=false` matches the legacy `augmentLineWithArc` behaviour
 * (open polyline with cap-style endpoints).
 *
 * Why this exists as one helper: polygon outlines and line features
 * share every downstream stage (clip, tessellate, GPU stride-10
 * pack, SDF segment build). The only meaningful difference is the
 * wrap-around at the close. Keeping the projection / arc / tangent
 * math in one place means a future precision tweak (e.g., switching
 * f64 Mercator to a higher-precision projection) lives in one spot
 * and doesn't drift between the two paths.
 */
export function augmentChainWithArc(
  coords: number[][],
  closed: boolean,
  opts?: { mmInput?: boolean },
): number[][] {
  const DEG2RAD = Math.PI / 180
  const R = DSFUN_EARTH_R
  const LAT_LIMIT = 85.051129
  const clampLat = (v: number) => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, v))

  // For closed rings, strip GeoJSON's trailing duplicate-of-first
  // vertex so we don't emit a zero-length wrap segment. The wrap is
  // handled explicitly below.
  //
  // Demotion: binary .xgvt tiles store per-tile-clipped polygon rings
  // that may be open chains (when clipping cut across the ring at a
  // tile boundary). When `closed=true` is passed for input that
  // doesn't actually close, demote to open chain rather than dropping
  // it — this keeps the shared compiler helper usable from both the
  // GeoJSON tiler (always closed source rings) and runtime decoders
  // that can't always tell ahead of time.
  let n = coords.length
  let actuallyClosed = closed
  if (closed && n >= 4) {
    const f = coords[0],
      l = coords[n - 1]
    if (Math.abs(f[0] - l[0]) < 1e-12 && Math.abs(f[1] - l[1]) < 1e-12) n -= 1
  } else if (closed && n >= 2) {
    // Open chain mistakenly tagged as closed — treat as line.
    actuallyClosed = false
  }
  if (actuallyClosed && n < 3) return []
  if (!actuallyClosed && n < 2) return []

  // Output length: open chain emits N vertices; closed ring emits N+1
  // (the appended wrap vertex carries arc=perimeter so the closing
  // segment t_along stays monotonic).
  const outN = actuallyClosed ? n + 1 : n

  // Pass 1: project (if input is LL) + accumulate arc. For closed
  // rings, also walk the closing segment so arcArr[n] is the full
  // perimeter. The `mmInput` opt skips projection when the caller has
  // already projected to MM — used by the industry-standard MM-native
  // polygon outline path.
  const mmInput = opts?.mmInput === true
  const mxArr = new Float64Array(n)
  const myArr = new Float64Array(n)
  const arcArr = new Float64Array(outN)
  let arc = 0
  for (let i = 0; i < n; i++) {
    const c = coords[i]
    if (mmInput) {
      mxArr[i] = c[0]
      myArr[i] = c[1]
    } else {
      mxArr[i] = c[0] * DEG2RAD * R
      myArr[i] = Math.log(Math.tan(Math.PI / 4 + (clampLat(c[1]) * DEG2RAD) / 2)) * R
    }
    if (i > 0) {
      const dx = mxArr[i] - mxArr[i - 1],
        dy = myArr[i] - myArr[i - 1]
      arc += Math.sqrt(dx * dx + dy * dy)
    }
    arcArr[i] = arc
  }
  if (actuallyClosed) {
    const dx = mxArr[0] - mxArr[n - 1],
      dy = myArr[0] - myArr[n - 1]
    arc += Math.sqrt(dx * dx + dy * dy)
    arcArr[n] = arc
  }

  // Pass 2: emit per-vertex tangents.
  //
  //   tangent_in[i]  = unit direction arriving at vertex i (prev → i)
  //   tangent_out[i] = unit direction leaving  vertex i (i → next)
  //
  // Open chain: endpoints have a zero tangent on the missing side so
  // the renderer draws a cap there.
  // Closed ring: tangents wrap (prev of 0 = n-1, next of n-1 = 0) so
  // every join sees real neighbours and no spurious cap is drawn at
  // the start/end vertex of the wrap.
  //
  // Hot-path optimisation: tangent computation is inlined and
  // results land directly into the output 7-tuple — eliminates two
  // 2-element [dx/len, dy/len] allocations per vertex (was the
  // top-3 GC source in PMTiles v4 perf profile).
  const out: number[][] = new Array(outN)
  for (let i = 0; i < n; i++) {
    let tinX = 0,
      tinY = 0,
      toutX = 0,
      toutY = 0
    if (actuallyClosed) {
      const prev = i === 0 ? n - 1 : i - 1
      const next = i === n - 1 ? 0 : i + 1
      const inDx = mxArr[i] - mxArr[prev],
        inDy = myArr[i] - myArr[prev]
      const inLen = Math.sqrt(inDx * inDx + inDy * inDy)
      if (inLen > 1e-9) {
        tinX = inDx / inLen
        tinY = inDy / inLen
      }
      const outDx = mxArr[next] - mxArr[i],
        outDy = myArr[next] - myArr[i]
      const outLen = Math.sqrt(outDx * outDx + outDy * outDy)
      if (outLen > 1e-9) {
        toutX = outDx / outLen
        toutY = outDy / outLen
      }
    } else {
      if (i > 0) {
        const inDx = mxArr[i] - mxArr[i - 1],
          inDy = myArr[i] - myArr[i - 1]
        const inLen = Math.sqrt(inDx * inDx + inDy * inDy)
        if (inLen > 1e-9) {
          tinX = inDx / inLen
          tinY = inDy / inLen
        }
      }
      if (i < n - 1) {
        const outDx = mxArr[i + 1] - mxArr[i],
          outDy = myArr[i + 1] - myArr[i]
        const outLen = Math.sqrt(outDx * outDx + outDy * outDy)
        if (outLen > 1e-9) {
          toutX = outDx / outLen
          toutY = outDy / outLen
        }
      }
    }
    out[i] = [mxArr[i], myArr[i], arcArr[i], tinX, tinY, toutX, toutY]
  }
  // Wrap vertex for closed rings: same coords as vertex 0 but
  // arc=perimeter. Tangent_in matches the closing segment (n-1→0),
  // tangent_out matches the first segment (0→1) so the join looks
  // identical to a regular interior join.
  if (actuallyClosed) {
    let tinX = 0,
      tinY = 0,
      toutX = 0,
      toutY = 0
    const inDx = mxArr[0] - mxArr[n - 1],
      inDy = myArr[0] - myArr[n - 1]
    const inLen = Math.sqrt(inDx * inDx + inDy * inDy)
    if (inLen > 1e-9) {
      tinX = inDx / inLen
      tinY = inDy / inLen
    }
    if (n > 1) {
      const outDx = mxArr[1] - mxArr[0],
        outDy = myArr[1] - myArr[0]
      const outLen = Math.sqrt(outDx * outDx + outDy * outDy)
      if (outLen > 1e-9) {
        toutX = outDx / outLen
        toutY = outDy / outLen
      }
    }
    out[n] = [mxArr[0], myArr[0], arcArr[n], tinX, tinY, toutX, toutY]
  }
  return out
}

/** Polygon ring → arc-augmented chain (closed). Thin shim around
 *  `augmentChainWithArc` for call-site readability. Exported for
 *  runtime sub-tilers that need to derive cross-tile-continuous
 *  outline geometry from `polygons` preserved on a TileData. */
export function augmentRingWithArc(ring: number[][], opts?: { mmInput?: boolean }): number[][] {
  return augmentChainWithArc(ring, true, opts)
}

/** Extract the "interior" arcs of a clipped polygon ring — the
 *  sub-chains whose edges come from the ORIGINAL polygon's boundary,
 *  not the synthetic axis-aligned edges Sutherland-Hodgman added to
 *  close the ring at the tile rect.
 *
 *  WHY THIS EXISTS (bug 2026-04-21, user-reported):
 *    d34aed2 routed polygon OUTLINE emission through the fill's
 *    clipped ring so fill/stroke endpoints would coincide. But the
 *    clipped ring's closure includes edges ALONG the tile border
 *    (v_i → v_{i+1} where BOTH lie on a tile-rect edge). Emitting
 *    those as stroke drew a visible cross-hatch at every tile
 *    boundary whenever a polygon spanned multiple tiles.
 *
 *    The fix is to exclude edges where both endpoints lie on the
 *    tile rect — those are synthetic, and the ORIGINAL polygon
 *    never had a stroke there. The output is a list of open
 *    polylines (each representing a contiguous run of original
 *    polygon edges inside this tile). When the polygon is
 *    entirely inside the tile, a single closed ring is returned.
 */
export function extractNonSyntheticArcs(
  ring: number[][],
  isSameBoundarySide: (a: number[], b: number[]) => boolean,
): number[][][] {
  const n = ring.length
  if (n < 2) return []

  // An edge is "synthetic" when both endpoints lie on the SAME axis
  // of the tile rect — a clip added it to close the ring along that
  // rect edge. "Both on boundary" alone isn't enough: a real polygon
  // edge that crosses the tile enters/exits through the rect, so
  // both endpoints can land on boundary lines but on DIFFERENT sides
  // (e.g. enters at x=west, exits at y=north). Those are real edges
  // of the source polygon and MUST keep rendering as stroke.
  const edgeSynthetic: boolean[] = new Array(n)
  for (let i = 0; i < n; i++) {
    edgeSynthetic[i] = isSameBoundarySide(ring[i], ring[(i + 1) % n])
  }

  // All edges real → original polygon is fully inside the tile.
  // Return the whole CLOSED ring (downstream treats closed=true so
  // the last→first wrap renders, preserving join semantics).
  if (edgeSynthetic.every((s) => !s)) return [ring]
  // All edges synthetic → this ring is entirely the tile rect's
  // outline, no source polygon content. Emit nothing.
  if (edgeSynthetic.every((s) => s)) return []

  // Find a rotation start: the first edge that is real AND preceded
  // by a synthetic one. That's where an arc begins.
  let start = 0
  for (let i = 0; i < n; i++) {
    if (edgeSynthetic[(i - 1 + n) % n] && !edgeSynthetic[i]) {
      start = i
      break
    }
  }

  const arcs: number[][][] = []
  let current: number[][] = []
  for (let off = 0; off < n; off++) {
    const i = (start + off) % n
    if (edgeSynthetic[i]) {
      if (current.length >= 2) arcs.push(current)
      current = []
    } else {
      const a = ring[i]
      const b = ring[(i + 1) % n]
      if (current.length === 0) current.push(a)
      current.push(b)
    }
  }
  if (current.length >= 2) arcs.push(current)
  return arcs
}

/** Build the `isSameBoundarySide` predicate for a MM tile rect. */
export function makeSameBoundarySidePredicateMerc(
  mxW: number,
  myS: number,
  mxE: number,
  myN: number,
  eps: number = 1.0,
): (a: number[], b: number[]) => boolean {
  return (a, b) => {
    // Both on x=mxW (tile west edge)
    if (Math.abs(a[0] - mxW) < eps && Math.abs(b[0] - mxW) < eps) return true
    // Both on x=mxE
    if (Math.abs(a[0] - mxE) < eps && Math.abs(b[0] - mxE) < eps) return true
    // Both on y=myS
    if (Math.abs(a[1] - myS) < eps && Math.abs(b[1] - myS) < eps) return true
    // Both on y=myN
    if (Math.abs(a[1] - myN) < eps && Math.abs(b[1] - myN) < eps) return true
    return false
  }
}

/** Open polyline → arc-augmented chain. Thin shim around
 *  `augmentChainWithArc` for call-site readability. */
export function augmentLineWithArc(coords: number[][]): number[][] {
  return augmentChainWithArc(coords, false)
}

/** Drop consecutive-duplicate vertices from a polyline. Sutherland-
 *  Hodgman can emit a repeated vertex when the source ring's closing
 *  point coincides with the clip rect corner (e.g. a fully-interior
 *  ring keeps its GeoJSON first==last as two adjacent identical
 *  vertices). Feeding that to the outline tessellator makes a zero-
 *  length segment → a degenerate self-adjacency that poisons the
 *  runtime join walker. Removing it changes nothing visible (the
 *  segment had no length; the fill's earcut ignores it too), so
 *  fill/outline coincidence is preserved. */
export function dropConsecutiveDuplicates(coords: number[][], eps = 1e-6): number[][] {
  if (coords.length < 2) return coords
  const out: number[][] = [coords[0]!]
  for (let i = 1; i < coords.length; i++) {
    const p = coords[i]!,
      q = out[out.length - 1]!
    if (Math.abs(p[0]! - q[0]!) > eps || Math.abs(p[1]! - q[1]!) > eps) out.push(p)
  }
  return out
}

/** Push a single chain (open or closed-and-augmented) into stride-8
 *  scratch arrays + emit consecutive-pair line indices. Exported for
 *  runtime sub-tilers that need to assemble outline scratch from
 *  per-tile clipped chains. */
export function tessellateLineToArrays(
  coords: number[][],
  featureId: number,
  outVerts: number[],
  outIdx: number[],
): void {
  // Stride 8: [lon, lat, featId, arcStart, tangent_in_x, tangent_in_y, tangent_out_x, tangent_out_y]
  const baseVertex = outVerts.length / 8
  for (const coord of coords) {
    outVerts.push(
      coord[0],
      coord[1],
      featureId,
      coord[2] ?? 0,
      coord[3] ?? 0,
      coord[4] ?? 0,
      coord[5] ?? 0,
      coord[6] ?? 0,
    )
  }
  for (let i = 0; i < coords.length - 1; i++) {
    outIdx.push(baseVertex + i, baseVertex + i + 1)
  }
}

// ═══ Auto Zoom Detection ═══
// `TilerOptions` type lives in vector-tiler-types.ts.

function autoDetectMaxZoom(features: GeoJSONFeature[]): number {
  const sampleSize = Math.min(features.length, 50)
  let totalSpacing = 0
  let spacingCount = 0

  for (let i = 0; i < sampleSize; i++) {
    const geom = features[i].geometry
    const coords = extractFirstRing(geom)
    if (!coords || coords.length < 2) continue

    for (let j = 1; j < coords.length; j++) {
      const dx = Math.abs(coords[j][0] - coords[j - 1][0])
      const dy = Math.abs(coords[j][1] - coords[j - 1][1])
      const spacing = Math.sqrt(dx * dx + dy * dy)
      if (spacing > 0) {
        totalSpacing += spacing
        spacingCount++
      }
    }
  }

  if (spacingCount === 0) return 6

  const avgSpacing = totalSpacing / spacingCount
  // Tile at zoom z covers 360/2^z degrees. Cap conservatively to manage tile count.
  const maxZoom = Math.max(2, Math.min(7, Math.ceil(Math.log2(360 / (avgSpacing * 16)))))
  console.log(`  Auto maxZoom: ${maxZoom} (avg vertex spacing: ${avgSpacing.toFixed(4)}°)`)
  return maxZoom
}

function extractFirstRing(geom: GeoJSONFeature['geometry']): number[][] | null {
  if (geom.type === 'Polygon') return (geom.coordinates as number[][][])[0]
  if (geom.type === 'MultiPolygon') return (geom.coordinates as number[][][][])[0]?.[0]
  if (geom.type === 'LineString') return geom.coordinates as number[][]
  return null
}

// ═══ Main Tiler ═══

export function compileGeoJSONToTiles(
  geojson: GeoJSONFeatureCollection,
  options?: TilerOptions,
): CompiledTileSet {
  const minZoom = options?.minZoom ?? 0
  const maxZoom = options?.maxZoom ?? autoDetectMaxZoom(geojson.features)

  // Step 1: Decompose features into individual geometry parts with tight bboxes
  const allParts = decomposeFeatures(geojson.features, options?.idResolver)
  console.log(`  Decomposed ${geojson.features.length} features → ${allParts.length} parts`)

  // Global bounds
  let gMinLon = Infinity,
    gMinLat = Infinity,
    gMaxLon = -Infinity,
    gMaxLat = -Infinity
  for (const p of allParts) {
    if (p.minLon < gMinLon) gMinLon = p.minLon
    if (p.maxLon > gMaxLon) gMaxLon = p.maxLon
    if (p.minLat < gMinLat) gMinLat = p.minLat
    if (p.maxLat > gMaxLat) gMaxLat = p.maxLat
  }

  // Build property table early (needed for progressive onLevel callbacks)
  const propertyTable = buildPropertyTable(geojson.features)
  const bounds: [number, number, number, number] = [gMinLon, gMinLat, gMaxLon, gMaxLat]

  // Step 2: Per-zoom processing with adaptive subdivision
  const levels: TileLevel[] = []
  const needsSubdivision = new Set<number>()
  const scratch = {
    pv: [] as number[],
    pi: [] as number[],
    lv: [] as number[],
    li: [] as number[],
    ptv: [] as number[],
    olv: [] as number[],
    oli: [] as number[],
  }

  function processZoomLevel(z: number): void {
    processZoomLevelShared(
      z,
      minZoom,
      maxZoom,
      allParts,
      levels,
      needsSubdivision,
      scratch,
      bounds,
      propertyTable,
      options?.onLevel,
    )
  }

  for (let z = minZoom; z <= maxZoom; z++) {
    processZoomLevel(z)
  }

  console.log(
    `  Properties: ${propertyTable.fieldNames.length} fields (${propertyTable.fieldNames.join(', ')})`,
  )

  return {
    levels,
    bounds,
    featureCount: geojson.features.length,
    propertyTable,
  }
}

// ═══ Shared Zoom Level Processing ═══

function processZoomLevelShared(
  z: number,
  minZoom: number,
  maxZoom: number,
  allParts: GeometryPart[],
  levels: TileLevel[],
  needsSubdivision: Set<number>,
  scratch: {
    pv: number[]
    pi: number[]
    lv: number[]
    li: number[]
    ptv: number[]
    olv: number[]
    oli: number[]
  },
  bounds: [number, number, number, number],
  propertyTable: PropertyTable,
  onLevel?: (
    level: TileLevel,
    bounds: [number, number, number, number],
    propertyTable: PropertyTable,
  ) => void,
): void {
  const zStart = performance.now()

  // Simplification applied per-tile AFTER clipping (clip → simplify → tessellate)
  // This preserves tile boundary vertices while reducing interior detail
  interface PreparedPart {
    original: GeometryPart
    rings?: number[][][]
    coords?: number[][]
    minLon: number
    minLat: number
    maxLon: number
    maxLat: number
  }

  const preparedParts: PreparedPart[] = []

  for (const part of allParts) {
    if (part.type === 'polygon' && part.rings) {
      if (part.rings.length === 0 || part.rings[0].length < 3) continue
      preparedParts.push({
        original: part,
        rings: part.rings,
        minLon: part.minLon,
        minLat: part.minLat,
        maxLon: part.maxLon,
        maxLat: part.maxLat,
      })
    } else if (part.type === 'line' && part.coords) {
      if (part.coords.length < 2) continue
      preparedParts.push({
        original: part,
        coords: part.coords,
        minLon: part.minLon,
        minLat: part.minLat,
        maxLon: part.maxLon,
        maxLat: part.maxLat,
      })
    } else if (part.type === 'point' && part.point) {
      // Points carry their single coord as both min and max so the scatter
      // bbox math below places them in exactly one tile per world copy.
      preparedParts.push({
        original: part,
        minLon: part.minLon,
        minLat: part.minLat,
        maxLon: part.maxLon,
        maxLat: part.maxLat,
      })
    }
  }

  // Scatter: assign parts to tiles using per-part bbox
  // At z > minZoom, only create tiles whose parent was marked for subdivision
  const tileFeaturesMap = new Map<number, number[]>()

  for (let pi = 0; pi < preparedParts.length; pi++) {
    const sp = preparedParts[pi]
    const fxMin = lonToTileX(sp.minLon, z)
    const fxMax = lonToTileX(sp.maxLon, z)
    const fyMin = latToTileY(sp.maxLat, z) // lat reversed
    const fyMax = latToTileY(sp.minLat, z)

    for (let x = fxMin; x <= fxMax; x++) {
      for (let y = fyMin; y <= fyMax; y++) {
        // Adaptive: skip if parent tile didn't need subdivision
        if (z > minZoom) {
          const parentKey = tileKey(z - 1, x >>> 1, y >>> 1)
          if (!needsSubdivision.has(parentKey)) continue
        }
        const key = tileKey(z, x, y)
        let list = tileFeaturesMap.get(key)
        if (!list) {
          list = []
          tileFeaturesMap.set(key, list)
        }
        list.push(pi)
      }
    }
  }

  // Assemble tiles: clip → tessellate per tile
  const tiles = new Map<number, CompiledTile>()

  for (const [key, partIndices] of tileFeaturesMap) {
    const [, tx, ty] = tileKeyUnpack(key)
    const tb = tileBounds(z, tx, ty)
    // Mercator tile bounds for line clipping (lines must be clipped in
    // Mercator space to match generateSubTile's Mercator-space clipper).
    const [tbMxW, tbMyS] = lonLatToMercF64(tb.west, tb.south)
    const [tbMxE, tbMyN] = lonLatToMercF64(tb.east, tb.north)

    scratch.pv.length = 0
    scratch.pi.length = 0
    scratch.lv.length = 0
    scratch.li.length = 0
    scratch.olv.length = 0
    scratch.oli.length = 0
    scratch.ptv.length = 0
    const featureIds = new Set<number>()
    const dedupMap = new Map<string, number>()

    // Lock predicate: vertices on tile boundary edges must survive
    // simplification. Single MM predicate — polygons + lines + outlines
    // now all clip/simplify in MM (docs/COORDINATES.md).
    const MERC_EPS = 1.0
    const isOnBoundaryMerc = (c: number[]) =>
      Math.abs(c[0] - tbMxW) < MERC_EPS ||
      Math.abs(c[0] - tbMxE) < MERC_EPS ||
      Math.abs(c[1] - tbMyS) < MERC_EPS ||
      Math.abs(c[1] - tbMyN) < MERC_EPS

    // Track clipped rings for full-cover detection + ring storage
    const tileClippedRings: number[][][] = []
    const tilePolyFeatureIds = new Set<number>()
    const tilePolygons: { rings: number[][][]; featId: number }[] = []
    // Track pre/post simplification vertex counts for adaptive subdivision
    let preSimplifyVerts = 0
    let postSimplifyVerts = 0

    for (const pi of partIndices) {
      const sp = preparedParts[pi]
      const fid = sp.original.featureIndex // stable feature ID

      if (sp.rings) {
        // sp.rings are already MM (projected in makePolygonPart). The
        // FILL uses the raw `clipped` ring at EVERY zoom (no simplify),
        // so it shares the exact ring set the OUTLINE line-clips below —
        // boundaries coincide by construction (d34aed2). Fill is NOT
        // simplified because the outline keeps the original ring's full
        // detail for cross-tile dash-arc continuity (3227174); a
        // simplified fill at z<maxZoom diverged from its own stroke by
        // up to the tolerance (km at low zoom). simplify∘clip ≠
        // clip∘simplify, so simplifying the outline can't fix it either.
        const clipped = clipPolygonToRect(
          sp.rings,
          tbMxW,
          tbMyS,
          tbMxE,
          tbMyN,
          precisionForZoomMM(z),
        )
        if (clipped.length > 0 && clipped[0].length >= 3) {
          tileClippedRings.push(...clipped)
          tilePolyFeatureIds.add(fid)
          for (const ring of clipped) preSimplifyVerts += ring.length
          const dataRings = clipped
          // Adaptive-subdivision metric ONLY (preSimplifyVerts >
          // postSimplifyVerts → needsSubdivision); the probe-simplify
          // output is discarded, never touching the emitted fill above.
          if (z < maxZoom) {
            for (const ring of simplifyPolygon(
              clipped,
              z,
              isOnBoundaryMerc,
              mercatorToleranceForZoom(z),
            ))
              postSimplifyVerts += ring.length
          } else {
            postSimplifyVerts += preSimplifyVerts
          }
          // Sutherland-Hodgman can emit a self-touching ring when the
          // source polygon enters/exits the tile rect multiple times.
          // Run the back-track repair, but only KEEP its split output
          // when earcut on the un-split ring would actually produce
          // overlapping triangles. The triangle-area-vs-ring-area
          // check distinguishes a TRUE clipper artifact (Korea z=7,
          // coverage ~2.57) from a legitimate complex coastline
          // (demotiles z=6 China, coverage ~1.00 — the splitter
          // would otherwise destroy the Yangtze river concavity by
          // chord-cutting through it).
          if (dataRings.length > 0 && dataRings[0]!.length >= 3) {
            const holes = dataRings.slice(1).filter((r) => r.length >= 3)
            const acceptSplit = needsBacktrackRepair(dataRings[0]!, holes)
            if (!acceptSplit) {
              const repairedRings = [dataRings[0]!, ...holes]
              tessellatePolygonToArrays(repairedRings, fid, scratch.pv, scratch.pi, dedupMap)
              featureIds.add(fid)
              tilePolygons.push({ rings: repairedRings, featId: fid })
            } else {
              const outerSubs = splitBoundaryBacktracks(dataRings[0]!, tbMxW, tbMyS, tbMxE, tbMyN)
              const usableOuters = outerSubs.filter((r) => r.length >= 3)
              const effectiveOuters = usableOuters.length > 0 ? usableOuters : [dataRings[0]!]
              if (effectiveOuters.length === 1) {
                const repairedRings = [effectiveOuters[0]!, ...holes]
                tessellatePolygonToArrays(repairedRings, fid, scratch.pv, scratch.pi, dedupMap)
                featureIds.add(fid)
                tilePolygons.push({ rings: repairedRings, featId: fid })
              } else {
                // Distribute holes via point-in-polygon — each clipper
                // sub-outer gets only the holes that fall inside it.
                const subHoles: number[][][][] = effectiveOuters.map(() => [])
                for (const hole of holes) {
                  subHoles[assignHoleBucket(hole, effectiveOuters)]!.push(hole)
                }
                const allRingsForFeature: number[][][] = []
                for (let si = 0; si < effectiveOuters.length; si++) {
                  const subRings = [effectiveOuters[si]!, ...subHoles[si]!]
                  tessellatePolygonToArrays(subRings, fid, scratch.pv, scratch.pi, dedupMap)
                  for (const r of subRings) allRingsForFeature.push(r)
                }
                featureIds.add(fid)
                tilePolygons.push({ rings: allRingsForFeature, featId: fid })
              }
            }
          }
          // Outline: derive from the SAME `clipped` rings the fill
          // tessellates, NOT a line-clip of the original ring. The two
          // clippers round boundary-crossing intersections differently,
          // so a line-clipped outline lands up to ~3.8 m off the fill
          // edge at tile crossings — a gap visible under magnification.
          // Tracing the identical `clipped` vertices makes fill/outline
          // coincide by construction (d34aed2, now real).
          // `extractNonSyntheticArcs` strips the synthetic tile-rect
          // edges Sutherland-Hodgman adds to close the ring (#347 — else
          // the outline strokes a seam at every internal tile boundary),
          // returning open boundary arcs or the whole closed ring when
          // fully interior.
          const sidePred = makeSameBoundarySidePredicateMerc(tbMxW, tbMyS, tbMxE, tbMyN, 1.0)
          for (const ring of clipped) {
            if (ring.length < 2) continue
            for (const arc of extractNonSyntheticArcs(ring, sidePred)) {
              // mmInput augment adds per-tile arc + tangents WITHOUT
              // moving any vertex, so coincidence holds. Cross-tile
              // GLOBAL arc (3227174) is traded for exact coincidence:
              // the clipped ring has no whole-ring parameter. Strip the
              // S-H closing-duplicate first (degenerate self-adjacency).
              const isClosed = arc.length >= 3 && arc === ring
              const clean = dropConsecutiveDuplicates(arc)
              if (clean.length < 2) continue
              // Densify the outline to the FILL's angular gate so a long low-zoom edge
              // curves on globe/non-Mercator instead of stroking a straight chord across
              // the sphere (#585). Collinear midpoints keep fill/outline coincidence.
              const densified = subdivideChainMM(clean)
              const chain = augmentChainWithArc(densified, isClosed, { mmInput: true })
              if (chain.length >= 2) tessellateLineToArrays(chain, fid, scratch.olv, scratch.oli)
            }
          }
        }
      }

      if (sp.coords) {
        const arcLine = augmentLineWithArc(sp.coords)
        const segments = clipLineToRect(arcLine, tbMxW, tbMyS, tbMxE, tbMyN)
        for (const seg of segments) {
          if (seg.length >= 2) {
            preSimplifyVerts += seg.length
            const dataLine =
              z < maxZoom
                ? simplifyLine(seg, z, isOnBoundaryMerc, mercatorToleranceForZoom(z))
                : seg
            if (z < maxZoom) {
              postSimplifyVerts += dataLine.length
            } else {
              postSimplifyVerts += seg.length
            }
            if (dataLine.length >= 2) {
              tessellateLineToArrays(dataLine, fid, scratch.lv, scratch.li)
              featureIds.add(fid)
            }
          }
        }
      }

      // Point: check bounds in LL (point data is lon/lat) and project
      // to MM before pushing into the scratch buffer so all downstream
      // DSFUN packing runs in MM.
      if (sp.original.type === 'point' && sp.original.point) {
        const [px, py] = sp.original.point
        if (px >= tb.west && px <= tb.east && py >= tb.south && py <= tb.north) {
          const [pmx, pmy] = lonLatToMercF64(px, py)
          scratch.ptv.push(pmx, pmy, fid)
          featureIds.add(fid)
        }
      }
    }

    // Full-cover detection: single feature, single ring, area matches tile.
    // Both areas computed in MM (tileClippedRings are MM per above).
    let fullCover = false
    let fullCoverFeatId = -1
    if (tilePolyFeatureIds.size === 1 && tileClippedRings.length === 1) {
      const tileArea = (tbMxE - tbMxW) * (tbMyN - tbMyS)
      const polyArea = Math.abs(shoelaceArea(tileClippedRings[0]))
      if (Math.abs(polyArea - tileArea) / tileArea < 1e-6) {
        fullCover = true
        fullCoverFeatId = [...tilePolyFeatureIds][0]
        // #716 — keep the covering-rect polygon geometry (do NOT clear). The synthesised client
        // quad never received the data-driven per-feature colour, so match()/gradient() fills went
        // BLACK over large-polygon interiors. Keeping the ~4-vertex rect renders identically for
        // constant fills and correctly (per-feature colour) for data-driven. See compileSingleTile.
      }
    }

    // Minimum size filter
    const hasGeometry = scratch.pv.length >= 9 || scratch.lv.length >= 8 || scratch.ptv.length >= 3
    if (fullCover || hasGeometry) {
      // No post-hoc boundary-edge filter: the outline path strips
      // synthetic tile-rect edges up front via extractNonSyntheticArcs
      // (#347), so scratch.olv never holds a tile-boundary segment.

      // DSFUN pack: project scratch vertices (absolute lon/lat) to tile-local
      // Mercator meters in f64, then split into (high, low) f32 pairs.
      const [tileMx, tileMy] = lonLatToMercF64(tb.west, tb.south)

      // ECEF tile-corner anchor for `packECEFPolygonVertices`. WGS84
      // ellipsoidal math (shared with the packer's own per-vertex ECEF via
      // the same module-level A/E2) — a sphere anchor would leave a ~21 km
      // constant offset, breaking the sub-mm DSFUN round-trip gated by
      // ecef-precision-fuzz.test.ts.
      const tileEcefCenter = tileEcefCenterFromMerc(tileMx, tileMy)

      const quantPv = packECEFPolygonVertices(scratch.pv, tileEcefCenter, [tileMx, tileMy])
      tiles.set(key, {
        z,
        x: tx,
        y: ty,
        tileWest: tb.west,
        tileSouth: tb.south,
        vertices: quantPv.vertices,
        dequantScale: quantPv.dequantScale,
        dequantHalf: quantPv.dequantHalf,
        indices: new Uint32Array(scratch.pi),
        lineVertices: packDSFUNLineVertices(scratch.lv, tileMx, tileMy),
        lineIndices: new Uint32Array(scratch.li),
        outlineIndices: new Uint32Array(0), // deprecated — see CompiledTile docstring
        outlineVertices:
          scratch.olv.length > 0
            ? packDSFUNLineVertices(scratch.olv, tileMx, tileMy)
            : new Float32Array(0),
        outlineLineIndices: new Uint32Array(scratch.oli),
        pointVertices: scratch.ptv.length > 0 ? packECEFPointFeatures(scratch.ptv) : undefined,
        featureCount: featureIds.size,
        fullCover,
        fullCoverFeatureId: fullCoverFeatId,
        polygons: tilePolygons.length > 0 ? tilePolygons : undefined,
      })

      // Adaptive subdivision:
      // - Full-cover tiles: always subdivide (original data has coastline/border detail at higher zoom)
      // - Polygon/line tiles: subdivide only if simplification removed vertices
      // - Point-bearing tiles: always subdivide so points spread across finer
      //   tiles at higher zooms (no vertex-simplification metric applies).
      const hasPoints = scratch.ptv.length > 0
      if (z < maxZoom && (fullCover || hasPoints || preSimplifyVerts > postSimplifyVerts)) {
        needsSubdivision.add(key)
      }
    }
  }

  if (tiles.size > 0) {
    const level = { zoom: z, tiles }
    levels.push(level)
    onLevel?.(level, bounds, propertyTable)
  }

  const fullCoverCount = [...tiles.values()].filter((t) => t.fullCover).length
  const leafCount = tiles.size - [...tiles.keys()].filter((k) => needsSubdivision.has(k)).length
  const zElapsed = (performance.now() - zStart).toFixed(0)
  console.log(
    `  z${z}: ${tiles.size} tiles${fullCoverCount > 0 ? ` (${fullCoverCount} full-cover)` : ''}${leafCount > 0 && z < maxZoom ? ` (${leafCount} leaf)` : ''} (${zElapsed}ms)`,
  )
}

// ═══ On-Demand Single Tile Compilation ═══

/** Compile a single tile from raw geometry parts. Used for on-demand tiling
 *  where only visible tiles are compiled instead of the entire pyramid. */
export function compileSingleTile(
  parts: GeometryPart[],
  z: number,
  x: number,
  y: number,
  maxZoom: number,
): CompiledTile | null {
  const tb = tileBounds(z, x, y)
  const precisionMM = precisionForZoomMM(z)
  // Mercator tile bounds — derived from LL tile bounds via the canonical
  // projection. All polygon / line / outline clipping, simplification,
  // and tessellation happens in MM per docs/COORDINATES.md.
  const [stMxW, stMyS] = lonLatToMercF64(tb.west, tb.south)
  const [stMxE, stMyN] = lonLatToMercF64(tb.east, tb.north)
  const clipMerc = { mxW: stMxW, myS: stMyS, mxE: stMxE, myN: stMyN }
  const scratch = {
    pv: [] as number[],
    pi: [] as number[],
    lv: [] as number[],
    li: [] as number[],
    ptv: [] as number[],
    olv: [] as number[],
    oli: [] as number[],
  }
  const featureIds = new Set<number>()
  const dedupMap = new Map<string, number>()
  const MERC_EPS = 1.0 // 1 meter tolerance for tile-boundary detection
  const isOnBoundaryMerc = (c: number[]) =>
    Math.abs(c[0] - stMxW) < MERC_EPS ||
    Math.abs(c[0] - stMxE) < MERC_EPS ||
    Math.abs(c[1] - stMyS) < MERC_EPS ||
    Math.abs(c[1] - stMyN) < MERC_EPS
  const tilePolygons: { rings: number[][][]; featId: number }[] = []

  for (const part of parts) {
    // Quick bbox reject (bbox in LL, tile bounds in LL — fastest path;
    // the actual clip runs in MM below).
    if (
      part.maxLon < tb.west ||
      part.minLon > tb.east ||
      part.maxLat < tb.south ||
      part.minLat > tb.north
    )
      continue

    const fid = part.featureIndex

    // Per-geometry dispatch. Each branch's body lives in its own
    // concern module (polygon-tiler / line-tiler / point-tiler);
    // the logic, call order, and the packed buffer bytes are
    // identical to the former inline branches. The shared clip /
    // tessellate / DSFUN-pack helpers stay in their current modules
    // (the vertex bytes are a CPU↔WGSL contract).
    if (part.type === 'polygon' && part.rings) {
      tilePolygonPart(part, fid, clipMerc, precisionMM, scratch, dedupMap, featureIds, tilePolygons)
    }

    if (part.type === 'line' && part.coords) {
      tileLinePart(part, fid, clipMerc, z, maxZoom, isOnBoundaryMerc, scratch, featureIds)
    }

    if (part.type === 'point' && part.point) {
      tilePointPart(part, fid, tb, scratch, featureIds)
    }
  }

  // Full-cover detection: ring is MM-clipped, so compute tile area
  // in MM too. (tileArea in LL degrees² vs polyArea in MM m² mismatch
  // is the bug this comment saves future contributors from.)
  let fullCover = false
  let fullCoverFeatId = -1
  if (tilePolygons.length === 1 && tilePolygons[0].rings.length === 1) {
    const ring = tilePolygons[0].rings[0]
    const tileArea = (stMxE - stMxW) * (stMyN - stMyS)
    const polyArea = Math.abs(shoelaceArea(ring))
    if (tileArea > 0 && Math.abs(polyArea - tileArea) / tileArea < 1e-6) {
      fullCover = true
      fullCoverFeatId = tilePolygons[0].featId
      // #716 — DO NOT clear the polygon scratch. Dropping the covering-rect geometry to let the
      // client synthesise a quad saved ~100 B/tile but the quad never got the data-driven per-feature
      // colour, so match()/gradient() fills rendered BLACK over large-polygon interiors (control test:
      // constant 100%, data-driven 0%). Keeping the ~4-vertex covering rect renders identically for
      // constant fills and correctly (per-feature colour) for data-driven — same path as edge tiles.
    }
  }

  if (!fullCover && scratch.pv.length < 9 && scratch.lv.length < 8 && scratch.ptv.length < 3)
    return null

  // No post-hoc boundary-edge filter — the outline path above strips
  // synthetic tile-rect edges via extractNonSyntheticArcs (#347).

  // DSFUN pack: project to tile-local Mercator meters, split into high/low pairs
  const [tileMx, tileMy] = lonLatToMercF64(tb.west, tb.south)

  // ECEF tile-corner anchor for `packECEFPolygonVertices`. See the
  // matching block in `compileGeoJSONToTiles` for the WGS84-vs-sphere
  // rationale (must match `packECEFPolygonVertices` for sub-mm
  // DSFUN reconstruction).
  const tileEcefCenter = tileEcefCenterFromMerc(tileMx, tileMy)

  const quantPv = packECEFPolygonVertices(scratch.pv, tileEcefCenter, [tileMx, tileMy])
  return {
    z,
    x,
    y,
    tileWest: tb.west,
    tileSouth: tb.south,
    vertices: quantPv.vertices,
    dequantScale: quantPv.dequantScale,
    dequantHalf: quantPv.dequantHalf,
    indices: new Uint32Array(scratch.pi),
    lineVertices: packDSFUNLineVertices(scratch.lv, tileMx, tileMy),
    lineIndices: new Uint32Array(scratch.li),
    outlineIndices: new Uint32Array(0), // deprecated — see CompiledTile docstring
    outlineVertices:
      scratch.olv.length > 0
        ? packDSFUNLineVertices(scratch.olv, tileMx, tileMy)
        : new Float32Array(0),
    outlineLineIndices: new Uint32Array(scratch.oli),
    pointVertices: scratch.ptv.length > 0 ? packECEFPointFeatures(scratch.ptv) : undefined,
    featureCount: featureIds.size,
    fullCover,
    fullCoverFeatureId: fullCover ? fullCoverFeatId : undefined,
    polygons: tilePolygons.length > 0 ? tilePolygons : undefined,
  }
}

/** Async version: yields to the event loop between zoom levels so the
 *  browser can render intermediate results (z0 appears immediately).
 *  Uses the same internal state as sync version (adaptive subdivision preserved). */
export async function compileGeoJSONToTilesAsync(
  geojson: GeoJSONFeatureCollection,
  options?: TilerOptions,
): Promise<CompiledTileSet> {
  const origOnLevel = options?.onLevel

  return new Promise<CompiledTileSet>((resolve) => {
    const minZoom = options?.minZoom ?? 0
    const maxZoom = options?.maxZoom ?? autoDetectMaxZoom(geojson.features)
    const allParts = decomposeFeatures(geojson.features, options?.idResolver)

    let gMinLon = Infinity,
      gMinLat = Infinity,
      gMaxLon = -Infinity,
      gMaxLat = -Infinity
    for (const p of allParts) {
      if (p.minLon < gMinLon) gMinLon = p.minLon
      if (p.maxLon > gMaxLon) gMaxLon = p.maxLon
      if (p.minLat < gMinLat) gMinLat = p.minLat
      if (p.maxLat > gMaxLat) gMaxLat = p.maxLat
    }
    const bounds: [number, number, number, number] = [gMinLon, gMinLat, gMaxLon, gMaxLat]
    const propertyTable = buildPropertyTable(geojson.features)
    const levels: TileLevel[] = []
    const needsSubdivision = new Set<number>()
    const scratch = {
      pv: [] as number[],
      pi: [] as number[],
      lv: [] as number[],
      li: [] as number[],
      ptv: [] as number[],
      olv: [] as number[],
      oli: [] as number[],
    }

    // Process one zoom level, then schedule the next via setTimeout
    function step(z: number) {
      processZoomLevelShared(
        z,
        minZoom,
        maxZoom,
        allParts,
        levels,
        needsSubdivision,
        scratch,
        bounds,
        propertyTable,
        origOnLevel,
      )

      if (z < maxZoom) {
        setTimeout(() => step(z + 1), 0)
      } else {
        console.log(
          `  Properties: ${propertyTable.fieldNames.length} fields (${propertyTable.fieldNames.join(', ')})`,
        )
        resolve({ levels, bounds, featureCount: geojson.features.length, propertyTable })
      }
    }

    console.log(`  Decomposed ${geojson.features.length} features → ${allParts.length} parts`)
    step(minZoom)
  })
}

/**
 * Build a property table from GeoJSON features.
 * Scans all features to determine field names, types, and values.
 */
function buildPropertyTable(features: GeoJSONFeature[]): PropertyTable {
  // Collect union of all property keys
  const fieldSet = new Map<string, PropertyFieldType>()

  for (const feature of features) {
    if (!feature.properties) continue
    for (const [key, val] of Object.entries(feature.properties)) {
      if (val === null || val === undefined) continue
      const existing = fieldSet.get(key)
      const valType = typeof val === 'number' ? 'f64' : typeof val === 'boolean' ? 'bool' : 'string'
      if (!existing) {
        fieldSet.set(key, valType)
      } else if (existing !== valType) {
        fieldSet.set(key, 'string') // mixed types → string
      }
    }
  }

  const fieldNames = [...fieldSet.keys()]
  const fieldTypes = fieldNames.map((k) => fieldSet.get(k)!)

  // Build values array
  const values: (number | string | boolean | null)[][] = []
  for (const feature of features) {
    const row: (number | string | boolean | null)[] = []
    for (const name of fieldNames) {
      const val = feature.properties?.[name]
      if (val === undefined || val === null) {
        row.push(null)
      } else {
        row.push(val as number | string | boolean)
      }
    }
    values.push(row)
  }

  return { fieldNames, fieldTypes, values }
}
