// Legacy back-compat adapter for setVirtualCatalog (the old hook
// PMTiles wired through). The legacy fetcher returns a fully
// CompiledTile and pushes it via sink immediately on resolve —
// no two-stage fetch/compile split, no tick.
//
// Kept as a separate class so the new PMTilesBackend can adopt the
// paced raw-bytes pipeline without breaking the
// virtual-catalog-fetch.test.ts assertions that synthesise their
// own CompiledTile-returning fetcher in tests.
//
// New PMTiles loader code should use PMTilesBackend directly
// (via attachBackend); this adapter exists only for the
// VirtualCatalog interface that predates PMTilesBackend.

import { tileKeyUnpack } from '@xgis/compiler'
import type {
  TileSource, TileSourceSink, TileSourceMeta, BackendTileResult,
} from '../tile-source'
import type { VirtualCatalog } from '../tile-types'

const MAX_INFLIGHT = 32

export class VirtualCatalogAdapter implements TileSource {
  readonly meta: TileSourceMeta
  private catalog: VirtualCatalog
  private sink: TileSourceSink | null = null

  constructor(catalog: VirtualCatalog) {
    this.catalog = catalog
    this.meta = {
      bounds: catalog.bounds,
      minZoom: catalog.minZoom,
      maxZoom: catalog.maxZoom,
      propertyTable: { fieldNames: [], fieldTypes: [], values: [] },
      entries: undefined,
    }
  }

  attach(sink: TileSourceSink): void {
    this.sink = sink
  }

  has(key: number): boolean {
    const [z, x, y] = tileKeyUnpack(key)
    if (z < this.meta.minZoom || z > this.meta.maxZoom) return false
    return tileIntersectsBounds(z, x, y, this.meta.bounds)
  }

  loadTile(key: number): void {
    if (!this.sink) return
    if (this.sink.hasTileData(key)) return
    if (this.sink.getLoadingCount() >= MAX_INFLIGHT) return
    const [z, x, y] = tileKeyUnpack(key)
    const sink = this.sink
    sink.trackLoading(key)
    this.catalog.fetcher(z, x, y).then(tile => {
      sink.releaseLoading(key)
      sink.acceptResult(key, tile ? {
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
      } satisfies BackendTileResult : null)
    }).catch(err => {
      sink.releaseLoading(key)
      console.error('[virtual-catalog fetch]', (err as Error)?.stack ?? err)
    })
  }
}

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
