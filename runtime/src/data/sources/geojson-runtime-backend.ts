// GeoJSONRuntimeBackend — TileSource implementation for in-memory
// raw GeoJSON parts. Owns the spatial-grid index and the synchronous
// compileSingleTile dispatch. Refactored in Step 5 to implement the
// formal TileSource interface.
//
// Scope: backend handles the FULL compile cycle (find parts → run
// compileSingleTile → push result via sink). Per-frame compile budget
// stays on the catalog because it's shared with sub-tile generation
// (catalog gates calls to compileSync via its budget check before
// invoking the backend).

import {
  tileKey, tileKeyUnpack,
  compileSingleTile,
  type GeometryPart, type RingPolygon,
} from '@xgis/compiler'
import type {
  TileSource, TileSourceSink, TileSourceMeta,
} from '../tile-source'

export class GeoJSONRuntimeBackend implements TileSource {
  meta: TileSourceMeta
  private rawParts: GeometryPart[] = []
  private sink: TileSourceSink | null = null

  /** Spatial grid index: z=3 tile key → indices into rawParts. */
  private partGrid: Map<number, number[]> = new Map()
  private static readonly GRID_ZOOM = 3

  constructor() {
    this.meta = {
      bounds: [-180, -85, 180, 85],
      minZoom: 0,
      maxZoom: 7,
      // GeoJSON-runtime doesn't carry a property table — feature
      // properties stay on the in-memory features and are looked up
      // at compile time. Catalog merges (first-wins).
      propertyTable: undefined,
      entries: undefined,
    }
  }

  attach(sink: TileSourceSink): void {
    this.sink = sink
  }

  get partCount(): number {
    return this.rawParts.length
  }

  /** Replace the backend's raw geometry + rebuild the spatial grid.
   *  Updates meta (bounds, maxZoom) so a follow-up catalog re-merge
   *  reflects the new state. */
  setParts(parts: GeometryPart[], maxZoom: number): void {
    this.rawParts = parts
    this.meta = {
      ...this.meta,
      maxZoom,
      bounds: computeBounds(parts),
    }
    this.buildPartGrid(parts)
  }

  /** Synchronous predicate — does this backend potentially have data
   *  for the given (z, x, y)? Catalog uses this for hasEntryInIndex. */
  has(key: number): boolean {
    if (this.rawParts.length === 0) return false
    const [z] = tileKeyUnpack(key)
    return z <= this.meta.maxZoom
  }

  /** TileSource.loadTile: defer to the synchronous compile path. The
   *  catalog's compileTileOnDemand path is preferred for raw-parts
   *  sources (it consults the per-frame budget); loadTile is the
   *  fallback when the catalog dispatches via the generic loop. */
  loadTile(key: number): void {
    this.compileSync(key)
  }

  /** Synchronous compile + push to sink. Returns true if anything was
   *  pushed (real result, full-cover, or empty placeholder), false if
   *  this backend can't serve the key (z out of range, no parts).
   *  Catalog uses the return value to decide whether to consume budget. */
  compileSync(key: number): boolean {
    if (!this.sink || !this.has(key)) return false
    const [z, x, y] = tileKeyUnpack(key)

    // Empty-tile shortcut: if the spatial grid has no parts overlapping
    // this tile, push an empty placeholder (catalog caches it as zero-
    // geometry tile). Without this, every VTR.render loop finds the
    // tile absent, falls through to parent-fallback, and increments
    // missedTiles — producing sustained [FLICKER] warnings for regions
    // with no data (e.g. z=6 ocean tiles far from a fixture's line).
    const parts = this.getRelevantParts(z, x, y)
    if (!parts || parts.length === 0) {
      this.sink.acceptResult(key, null)
      return true
    }

    const tile = compileSingleTile(parts, z, x, y, this.meta.maxZoom)
    if (!tile) {
      // Same rationale as the empty-grid branch — a tile that
      // overlapped the spatial grid but produced no triangles after
      // clipping (very thin line slicing a corner, for example) would
      // otherwise stay "missed" forever.
      this.sink.acceptResult(key, null)
      return true
    }
    const polygons: RingPolygon[] | undefined = tile.polygons?.map(p => ({ rings: p.rings, featId: p.featId }))
    this.sink.acceptResult(key, {
      vertices: tile.vertices,
      indices: tile.indices,
      lineVertices: tile.lineVertices,
      lineIndices: tile.lineIndices,
      pointVertices: tile.pointVertices,
      outlineIndices: tile.outlineIndices,
      outlineVertices: tile.outlineVertices,
      outlineLineIndices: tile.outlineLineIndices,
      polygons,
      fullCover: tile.fullCover,
      fullCoverFeatureId: tile.fullCoverFeatureId,
    })
    return true
  }

  /** Get parts that potentially overlap a tile (via grid index).
   *  Public for tests + the catalog's diagnostic accessors. */
  getRelevantParts(z: number, x: number, y: number): GeometryPart[] | null {
    if (this.rawParts.length === 0) return null
    if (this.partGrid.size === 0) return this.rawParts
    const gz = GeoJSONRuntimeBackend.GRID_ZOOM

    if (z >= gz) {
      const shift = z - gz
      const k = tileKey(gz, x >> shift, y >> shift)
      const indices = this.partGrid.get(k)
      if (!indices) return null
      return indices.map(i => this.rawParts[i])
    }

    const shift = gz - z
    const gx0 = x << shift
    const gy0 = y << shift
    const span = 1 << shift
    const seen = new Set<number>()
    const result: GeometryPart[] = []
    for (let gx = gx0; gx < gx0 + span; gx++) {
      for (let gy = gy0; gy < gy0 + span; gy++) {
        const k = tileKey(gz, gx, gy)
        const indices = this.partGrid.get(k)
        if (!indices) continue
        for (const idx of indices) {
          if (!seen.has(idx)) { seen.add(idx); result.push(this.rawParts[idx]) }
        }
      }
    }
    return result.length > 0 ? result : null
  }

  /** Build spatial grid index at z=3 (64 cells) for fast part lookup. */
  private buildPartGrid(parts: GeometryPart[]): void {
    const z = GeoJSONRuntimeBackend.GRID_ZOOM
    const n = Math.pow(2, z)
    const grid = new Map<number, number[]>()

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      const minTX = Math.max(0, Math.floor((p.minLon + 180) / 360 * n))
      const maxTX = Math.min(n - 1, Math.floor((p.maxLon + 180) / 360 * n))
      const minTY = Math.max(0, Math.floor((1 - Math.log(Math.tan(Math.max(p.minLat, -85) * Math.PI / 180) + 1 / Math.cos(Math.max(p.minLat, -85) * Math.PI / 180)) / Math.PI) / 2 * n))
      const maxTY = Math.min(n - 1, Math.floor((1 - Math.log(Math.tan(Math.min(p.maxLat, 85) * Math.PI / 180) + 1 / Math.cos(Math.min(p.maxLat, 85) * Math.PI / 180)) / Math.PI) / 2 * n))

      // Note: in Mercator tile coords, smaller Y = higher latitude
      const yLo = Math.min(minTY, maxTY)
      const yHi = Math.max(minTY, maxTY)

      for (let tx = minTX; tx <= maxTX; tx++) {
        for (let ty = yLo; ty <= yHi; ty++) {
          const k = tileKey(z, tx, ty)
          let arr = grid.get(k)
          if (!arr) { arr = []; grid.set(k, arr) }
          arr.push(i)
        }
      }
    }
    this.partGrid = grid
  }
}

function computeBounds(parts: GeometryPart[]): [number, number, number, number] {
  if (parts.length === 0) return [-180, -85, 180, 85]
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
  for (const p of parts) {
    if (p.minLon < minLon) minLon = p.minLon
    if (p.maxLon > maxLon) maxLon = p.maxLon
    if (p.minLat < minLat) minLat = p.minLat
    if (p.maxLat > maxLat) maxLat = p.maxLat
  }
  return [minLon, minLat, maxLon, maxLat]
}
