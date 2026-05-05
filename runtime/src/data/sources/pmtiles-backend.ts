// PMTilesBackend — TileSource implementation for PMTiles archives.
//
// Two-stage pipeline (fetch / compile separation):
//
//   loadTile(key)
//     ↓ async HTTP byte-range request
//   pendingMvt: Map<key, Uint8Array>       ← raw MVT bytes queued
//     ↓ tick(budget) per frame
//   decodeMvtTile + decomposeFeatures + compileSingleTile
//     ↓ sink.acceptResult
//   catalog cache → onTileLoaded → VTR upload
//
// Why split: a v4 world basemap tile decode + compile takes 5-50 ms
// on the main thread. With 30+ fetches in flight, all .then handlers
// resolve in the same microtask boundary and stack 30+ compiles
// consecutively, blocking frames for hundreds of ms. Splitting lets
// catalog pace compile work via the per-frame tick budget while
// fetches keep streaming in async.

import {
  tileKeyUnpack,
  decodeMvtTile, decomposeFeatures, compileSingleTile,
  type CompiledTile,
} from '@xgis/compiler'
import type {
  TileSource, TileSourceSink, TileSourceMeta, BackendTileResult,
} from '../tile-source'

/** Async HTTP byte fetcher. Returns the raw MVT bytes for the given
 *  (z, x, y), or null when the archive has no entry. Decode + compile
 *  intentionally happen later in tick(), not here. */
export type PMTilesFetcher = (
  z: number, x: number, y: number,
) => Promise<Uint8Array | null>

export interface PMTilesBackendOptions {
  fetcher: PMTilesFetcher
  minZoom: number
  maxZoom: number
  bounds: [number, number, number, number]
  /** MVT layer name allow-list (decoder filters before compile). */
  layers?: string[]
}

/** Per-backend cap on simultaneous in-flight HTTP fetches. Independent
 *  of catalog-level MAX_CONCURRENT_LOADS — protects this backend from
 *  oversubscribing one archive's network. */
const MAX_INFLIGHT = 16

export class PMTilesBackend implements TileSource {
  readonly meta: TileSourceMeta
  private fetcher: PMTilesFetcher
  private layers: string[] | undefined
  private sink: TileSourceSink | null = null

  /** Raw MVT bytes waiting for decode+compile. Drained by tick(). */
  private pendingMvt: { key: number; bytes: Uint8Array }[] = []

  constructor(opts: PMTilesBackendOptions) {
    this.fetcher = opts.fetcher
    this.layers = opts.layers
    this.meta = {
      bounds: opts.bounds,
      minZoom: opts.minZoom,
      maxZoom: opts.maxZoom,
      // Empty property table — PMTiles' MVT properties aren't yet
      // surfaced to the styling layer. Catalog merges this with
      // first-attached-wins precedence; another backend's table wins
      // if attached first.
      propertyTable: { fieldNames: [], fieldTypes: [], values: [] },
      // No preregistered entries — PMTiles discovers tiles lazily on
      // fetch, catalog synthesises XGVTIndex entries via acceptResult.
      entries: undefined,
    }
  }

  attach(sink: TileSourceSink): void {
    this.sink = sink
  }

  /** Synchronous catalog-window predicate. True if (z, x, y) could
   *  plausibly be served — catalog uses this for hasEntryInIndex on
   *  non-preregistered keys. */
  has(key: number): boolean {
    const [z, x, y] = tileKeyUnpack(key)
    if (z < this.meta.minZoom || z > this.meta.maxZoom) return false
    return tileIntersectsBounds(z, x, y, this.meta.bounds)
  }

  /** Stage 1: kick off async HTTP fetch. Bytes land in pendingMvt
   *  when the fetcher resolves; the actual decode+compile waits
   *  for tick() to dequeue. */
  loadTile(key: number): void {
    if (!this.sink) return
    if (this.sink.hasTileData(key)) return
    if (this.sink.getLoadingCount() >= MAX_INFLIGHT) return
    const [z, x, y] = tileKeyUnpack(key)
    const sink = this.sink
    sink.trackLoading(key)
    this.fetcher(z, x, y).then(bytes => {
      if (!bytes) {
        // Archive has no entry — push empty placeholder immediately
        // (no compile work needed). Cheap, keeps the catalog from
        // re-requesting this key.
        sink.releaseLoading(key)
        sink.acceptResult(key, null)
        return
      }
      // Bytes ready; queue for paced compile in tick(). Note we do
      // NOT releaseLoading here — the slot stays held until compile
      // finishes, providing back-pressure on requestTiles.
      this.pendingMvt.push({ key, bytes })
    }).catch(err => {
      sink.releaseLoading(key)
      console.error('[pmtiles fetch]', (err as Error)?.stack ?? err)
    })
  }

  /** Stage 2: drain up to maxOps queued tiles per frame. Catalog
   *  calls this from resetCompileBudget with a small budget so
   *  compile work spreads across frames instead of blocking the
   *  main thread on a microtask burst. */
  tick(maxOps: number): void {
    if (!this.sink || this.pendingMvt.length === 0) return
    const sink = this.sink
    const n = Math.min(maxOps, this.pendingMvt.length)
    for (let i = 0; i < n; i++) {
      const { key, bytes } = this.pendingMvt.shift()!
      const [z, x, y] = tileKeyUnpack(key)
      try {
        const features = decodeMvtTile(bytes, z, x, y, { layers: this.layers })
        if (features.length === 0) {
          sink.acceptResult(key, null)
        } else {
          const parts = decomposeFeatures(features)
          const tile = compileSingleTile(parts, z, x, y, this.meta.maxZoom)
          sink.acceptResult(key, tile ? compiledToResult(tile) : null)
        }
      } catch (err) {
        console.error('[pmtiles compile]', (err as Error)?.stack ?? err)
        sink.acceptResult(key, null)
      } finally {
        sink.releaseLoading(key)
      }
    }
  }
}

/** Convert compiler's CompiledTile into the catalog-side
 *  BackendTileResult shape. Pure field projection. */
function compiledToResult(tile: CompiledTile): BackendTileResult {
  return {
    vertices: tile.vertices,
    indices: tile.indices,
    lineVertices: tile.lineVertices,
    lineIndices: tile.lineIndices,
    pointVertices: tile.pointVertices,
    outlineIndices: tile.outlineIndices,
    outlineVertices: tile.outlineVertices,
    outlineLineIndices: tile.outlineLineIndices,
    polygons: tile.polygons?.map(p => ({ rings: p.rings, featId: p.featId })),
    fullCover: tile.fullCover,
    fullCoverFeatureId: tile.fullCoverFeatureId,
  }
}

/** True if Web-Mercator tile (z, x, y) overlaps the given lon/lat bounds. */
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
