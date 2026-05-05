// PMTilesBackend — lazy on-demand fetcher for PMTiles archives (and
// other "virtual catalog" sources that produce one CompiledTile per
// (z, x, y) on demand). Extracted from XGVTSource as Step 3 of the
// layer-type refactor (plans/delegated-hopping-cray.md).
//
// Generic over the actual tile producer: the fetcher closure is
// passed in at construction. The PMTiles HTTP/MVT specifics live in
// runtime/src/loader/pmtiles-source.ts (`attachPMTilesSource` builds
// the closure). This split keeps the data layer free of pmtiles
// client / @mapbox/vector-tile dependencies; only the loader module
// depends on those.
//
// Responsibility split (mirrors XGVTBinaryBackend):
//   • This module owns:
//       - the fetcher closure
//       - the catalog-window check (z range + lon/lat bounds)
//       - synthetic-entry creation in the catalog's index
//       - dispatch to cacheTileData / createFullCoverTileData via
//         sink callbacks
//   • Catalog owns:
//       - dataCache, loadingTiles, MAX_CONCURRENT_LOADS gate
//       - the synthesised XGVTIndex storage

import {
  TILE_FLAG_FULL_COVER,
  tileKeyUnpack,
  type CompiledTile, type TileIndexEntry, type RingPolygon,
} from '@xgis/compiler'
import { DSFUN_POLY_STRIDE, DSFUN_LINE_STRIDE } from '../tile-types'

/** Async tile producer signature. Returns null when the archive has
 *  no data for this (z, x, y) — catalog caches an empty placeholder
 *  so the renderer doesn't keep re-requesting. */
export type PMTilesFetcher = (
  z: number, x: number, y: number,
) => Promise<CompiledTile | null>

export interface PMTilesBackendOptions {
  fetcher: PMTilesFetcher
  minZoom: number
  maxZoom: number
  bounds: [number, number, number, number]
}

/** Callback bundle the PMTiles backend uses to write its results
 *  back into the catalog. Subset of the XGVTBinaryBackend sink:
 *  loadTile is single-shot per call, no batched range-merge. */
export interface PMTilesBackendSink {
  hasTileData(key: number): boolean
  trackLoading(key: number): void
  releaseLoading(key: number): void
  getLoadingCount(): number
  /** Add a synthetic index entry derived from the produced tile so
   *  subsequent hasEntryInIndex checks short-circuit to the cached
   *  entry path. Idempotent — catalog skips if the entry already
   *  exists. */
  registerEntry(key: number, entry: TileIndexEntry): void
  /** Look up an existing entry (used by the full-cover branch to
   *  resolve the entry just registered). */
  getEntry(key: number): TileIndexEntry | undefined
  cacheTileData(
    key: number,
    polygons: { rings: number[][][]; featId: number }[] | undefined,
    vertices: Float32Array,
    indices: Uint32Array,
    lineVertices: Float32Array,
    lineIndices: Uint32Array,
    pointVertices?: Float32Array,
    outlineIndices?: Uint32Array,
    outlineVertices?: Float32Array,
    outlineLineIndices?: Uint32Array,
  ): void
  createFullCoverTileData(
    key: number,
    entry: TileIndexEntry,
    lineVertices: Float32Array,
    lineIndices: Uint32Array,
  ): void
}

/** Per-format backend cap (mirrors catalog-level MAX_CONCURRENT_LOADS
 *  but applied as a guard inside the backend so a misbehaving
 *  catalog can't oversubscribe its own loadingTiles set). */
const MAX_INFLIGHT = 32

export class PMTilesBackend {
  readonly minZoom: number
  readonly maxZoom: number
  readonly bounds: [number, number, number, number]
  private fetcher: PMTilesFetcher

  constructor(opts: PMTilesBackendOptions, private sink: PMTilesBackendSink) {
    this.fetcher = opts.fetcher
    this.minZoom = opts.minZoom
    this.maxZoom = opts.maxZoom
    this.bounds = opts.bounds
  }

  /** Synchronous catalog-window predicate. True if the (z, x, y)
   *  could plausibly be served by this backend — catalog uses it to
   *  answer hasEntryInIndex for non-preregistered keys. */
  has(key: number): boolean {
    const [z, x, y] = tileKeyUnpack(key)
    if (z < this.minZoom || z > this.maxZoom) return false
    return tileIntersectsBounds(z, x, y, this.bounds)
  }

  /** Async fetch + decode + cache. Symmetric with XGVTBinaryBackend's
   *  requestTilesBatch but single-shot — PMTiles has no equivalent
   *  of byte-range merging since each tile is independently
   *  addressed in the archive directory. */
  loadTile(key: number): void {
    if (this.sink.hasTileData(key)) return
    if (this.sink.getLoadingCount() >= MAX_INFLIGHT) return
    const [z, x, y] = tileKeyUnpack(key)
    this.sink.trackLoading(key)
    this.fetcher(z, x, y).then(tile => {
      this.sink.releaseLoading(key)
      if (!tile) {
        // Empty placeholder so the renderer's parent-fallback bookkeeping
        // doesn't keep retrying this key every frame (matches the
        // empty-grid shortcut in compileTileOnDemand).
        const empty = new Float32Array(0)
        const emptyI = new Uint32Array(0)
        this.sink.cacheTileData(key, undefined, empty, emptyI, empty, emptyI)
        return
      }
      // Synthesise an index entry so subsequent hasEntryInIndex
      // checks short-circuit to the cached entry path.
      const tileFullCover = tile.fullCover ?? false
      const tileFullCoverFid = tile.fullCoverFeatureId ?? 0
      const synthEntry: TileIndexEntry = {
        tileHash: key, dataOffset: 0, compactSize: 0, gpuReadySize: 0,
        vertexCount: tile.vertices.length / DSFUN_POLY_STRIDE,
        indexCount: tile.indices.length,
        lineVertexCount: tile.lineVertices.length / DSFUN_LINE_STRIDE,
        lineIndexCount: tile.lineIndices.length,
        flags: tileFullCover ? (TILE_FLAG_FULL_COVER | (tileFullCoverFid << 1)) : 0,
        fullCoverFeatureId: tileFullCoverFid,
      }
      this.sink.registerEntry(key, synthEntry)

      if (tileFullCover && tile.vertices.length === 0) {
        const entry = this.sink.getEntry(key)
        if (entry) {
          this.sink.createFullCoverTileData(key, entry, tile.lineVertices, tile.lineIndices)
          return
        }
      }
      const polygons: RingPolygon[] | undefined = tile.polygons?.map(p => ({ rings: p.rings, featId: p.featId }))
      this.sink.cacheTileData(
        key, polygons,
        tile.vertices, tile.indices,
        tile.lineVertices, tile.lineIndices,
        tile.pointVertices,
        tile.outlineIndices,
        tile.outlineVertices,
        tile.outlineLineIndices,
      )
    }).catch(err => {
      this.sink.releaseLoading(key)
      console.error('[pmtiles fetch]', (err as Error)?.stack ?? err)
    })
  }
}

/** True if Web-Mercator tile (z, x, y) overlaps the given lon/lat bounds.
 *  Used by PMTilesBackend.has to skip fetcher requests for keys clearly
 *  outside the archive's coverage. */
function tileIntersectsBounds(
  z: number, x: number, y: number,
  bounds: [number, number, number, number],
): boolean {
  const n = 1 << z
  const tileWest = (x / n) * 360 - 180
  const tileEast = ((x + 1) / n) * 360 - 180
  const yToLat = (yt: number) => {
    const s = Math.PI - 2 * Math.PI * (yt / n)
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(s) - Math.exp(-s)))
  }
  const tileNorth = yToLat(y)
  const tileSouth = yToLat(y + 1)
  return !(tileEast < bounds[0] || tileWest > bounds[2] ||
           tileNorth < bounds[1] || tileSouth > bounds[3])
}
