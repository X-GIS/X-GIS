// PMTilesBackend — TileSource implementation for PMTiles archives
// (and other "virtual catalog" sources that produce one CompiledTile
// per (z, x, y) on demand). Refactored in Step 5 to implement the
// formal TileSource interface (was Step 3's bespoke
// PMTilesBackendSink callback shape).
//
// Generic over the actual tile producer: the fetcher closure is
// passed in at construction. The PMTiles HTTP/MVT specifics live in
// runtime/src/loader/pmtiles-source.ts (`attachPMTilesSource` builds
// the closure). This split keeps the data layer free of pmtiles
// client / @mapbox/vector-tile dependencies; only the loader module
// depends on those.

import {
  tileKeyUnpack,
  type CompiledTile,
} from '@xgis/compiler'
import type {
  TileSource, TileSourceSink, TileSourceMeta, BackendTileResult,
} from '../tile-source'

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

/** Per-backend cap on simultaneous in-flight fetches. Catalog also
 *  enforces its own MAX_CONCURRENT_LOADS across all backends; this
 *  is a per-backend defence against a single misconfigured archive
 *  saturating the catalog's queue. */
const MAX_INFLIGHT = 32

export class PMTilesBackend implements TileSource {
  readonly meta: TileSourceMeta
  private fetcher: PMTilesFetcher
  private sink: TileSourceSink | null = null

  constructor(opts: PMTilesBackendOptions) {
    this.fetcher = opts.fetcher
    this.meta = {
      bounds: opts.bounds,
      minZoom: opts.minZoom,
      maxZoom: opts.maxZoom,
      // Empty property table — PMTiles' MVT properties aren't yet
      // surfaced to the styling layer. Catalog merges this with
      // first-wins precedence; another backend's table wins if
      // attached first.
      propertyTable: { fieldNames: [], fieldTypes: [], values: [] },
      // No preregistered entries — PMTiles discovers tiles lazily on
      // fetch, catalog synthesises XGVTIndex entries via acceptResult.
      entries: undefined,
    }
  }

  attach(sink: TileSourceSink): void {
    this.sink = sink
  }

  /** Synchronous catalog-window predicate. True if the (z, x, y)
   *  could plausibly be served by this backend — catalog uses it to
   *  answer hasEntryInIndex for non-preregistered keys. */
  has(key: number): boolean {
    const [z, x, y] = tileKeyUnpack(key)
    if (z < this.meta.minZoom || z > this.meta.maxZoom) return false
    return tileIntersectsBounds(z, x, y, this.meta.bounds)
  }

  /** Async fetch + decode + push to sink. Single-shot: PMTiles has no
   *  equivalent of byte-range merging since each tile is independently
   *  addressed in the archive directory. */
  loadTile(key: number): void {
    if (!this.sink) return
    if (this.sink.hasTileData(key)) return
    if (this.sink.getLoadingCount() >= MAX_INFLIGHT) return
    const [z, x, y] = tileKeyUnpack(key)
    const sink = this.sink
    sink.trackLoading(key)
    this.fetcher(z, x, y).then(tile => {
      sink.releaseLoading(key)
      sink.acceptResult(key, tile ? compiledToResult(tile) : null)
    }).catch(err => {
      sink.releaseLoading(key)
      console.error('[pmtiles fetch]', (err as Error)?.stack ?? err)
    })
  }
}

/** Convert compiler's CompiledTile into the catalog-side
 *  BackendTileResult shape. Pure field projection — same arrays,
 *  smaller surface (no z/x/y/tileWest/tileSouth which catalog
 *  recomputes from the key). */
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

/** True if Web-Mercator tile (z, x, y) overlaps the given lon/lat bounds.
 *  Used by has() to skip fetcher requests for keys clearly outside
 *  the archive's coverage. */
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
