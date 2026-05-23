// Type declarations extracted from vector-tile-loader.ts.
//
// Public types (VectorLayerInfo / VectorTileFormat / PMTilesSourceOptions /
// ResolvedSource) are re-exported from vector-tile-loader.ts to preserve every
// prior import path. The internal cache/manifest shapes (CachedArchive /
// CachedTileJSON / RawTileJSON) are imported directly by the loader module.

import type { PMTiles, Header } from 'pmtiles'
import type { PMTilesFetcher } from '../data/sources/pmtiles-backend'

/** Per-MVT-layer info pulled from `metadata.vector_layers`. Used by
 *  the runtime to skip work when the current camera zoom is outside a
 *  layer's data range — protomaps v4 only carries `roads` at z≥6 and
 *  `buildings` at z≥14, so requesting them at z=0/z=3 would otherwise
 *  trigger FLICKER warnings + sub-tile generation for tiles the archive
 *  simply doesn't have features in. */
export interface VectorLayerInfo {
  id: string
  minzoom: number
  maxzoom: number
  fields?: Record<string, string>
}

/** The vector tile formats this loader knows how to attach. `null`
 *  means "the URL doesn't look like any of these" — the caller (e.g.
 *  the data-load loop in map.ts) routes to a different branch (raster,
 *  GeoJSON, etc.). */
export type VectorTileFormat = 'pmtiles' | 'tilejson'

export interface PMTilesSourceOptions {
  url: string
  /** Explicit declaration of what's at the URL. Bypasses URL-extension
   *  sniffing when the caller already knows the format (`.pmtiles` is
   *  unambiguous; `.json` could be TileJSON or GeoJSON; manifest URLs
   *  often have no extension at all). Default `'auto'`.
   *
   *  - `'pmtiles'` — single .pmtiles archive, byte-range MVT.
   *  - `'tilejson'` — TileJSON manifest pointing at an XYZ MVT server.
   *  - `'auto'` — sniff by URL extension. */
  kind?: VectorTileFormat | 'auto'
  /** Restrict to a subset of MVT layer names (default: all layers). */
  layers?: string[]
  /** Per-MVT-layer 3D-extrude expression AST. */
  extrudeExprs?: Record<string, unknown>
  /** Per-MVT-layer 3D-extrude BASE expression AST. */
  extrudeBaseExprs?: Record<string, unknown>
  /** Per-show slice descriptors. */
  showSlices?: Array<{ sliceKey: string; sourceLayer: string; filterAst: unknown | null }>
  /** Per-sliceKey stroke-width override AST. */
  strokeWidthExprs?: Record<string, unknown>
  /** Per-sliceKey stroke-colour override AST. */
  strokeColorExprs?: Record<string, unknown>
  /** Skeleton prewarm depth — see TileCatalog.prewarmSkeleton. */
  prewarmSkeletonDepth?: number
}

/** Unified shape returned by `VectorTileSource.resolve()` for sources
 *  that go through `PMTilesBackend`. PMTiles and TileJSON produce
 *  different metadata containers (header vs manifest) but the attach
 *  flow only needs the same six fields + a fetcher closure. XGVT-
 *  binary sources don't go through PMTilesBackend and return null. */
export interface ResolvedSource {
  format: VectorTileFormat
  name?: string
  attribution?: string
  minZoom: number
  maxZoom: number
  bounds: [number, number, number, number]
  vectorLayers: VectorLayerInfo[]
  /** Format-specific log fragment ("N tile entries" vs "template=..."). */
  logDetail: string
  fetcher: PMTilesFetcher
}

export interface CachedArchive {
  archive: PMTiles
  header: Header
  vectorLayers: VectorLayerInfo[]
  archiveName?: string
  attribution?: string
}

export interface CachedTileJSON {
  tilesTemplate: string
  bounds: [number, number, number, number]
  minzoom: number
  maxzoom: number
  vectorLayers: VectorLayerInfo[]
  name?: string
  attribution?: string
}

export interface RawTileJSON {
  tilejson?: string
  tiles?: string[]
  bounds?: [number, number, number, number]
  minzoom?: number
  maxzoom?: number
  name?: string
  attribution?: string
  vector_layers?: Array<{
    id: string
    minzoom?: number
    maxzoom?: number
    fields?: Record<string, string>
  }>
}
