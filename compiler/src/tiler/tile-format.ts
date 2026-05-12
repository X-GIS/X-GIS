// Tile-index data structures shared between the GeoJSON in-memory
// tiler (`compileGeoJSONToTiles`) and the runtime catalog
// (`TileCatalog.loadFromTileSet`). The .xgvt binary container that
// used to live here is gone — every X-GIS source now flows through
// MVT/PBF, so the on-disk format and its encoder/decoder are no
// longer needed. The interfaces below survive only as the shape of
// an in-memory tile index — the format-specific bits (MAGIC, VERSION,
// parseXGVTIndex, serializeXGVT, parseGPUReadyTile,
// decompressTileData, parsePropertyTable) have all been deleted.

import type { PropertyTable } from './vector-tiler'

/** Bit flag set on `TileIndexEntry.flags` when the tile is one
 *  full-cover polygon (the renderer draws a clip-rect quad instead
 *  of decoding the per-vertex geometry). */
export const TILE_FLAG_FULL_COVER = 0x1

export interface TileIndexEntry {
  tileHash: number      // Morton tile key
  dataOffset: number    // Always 0 for in-memory tile sets (no file backing)
  compactSize: number   // 0 for in-memory tile sets
  gpuReadySize: number  // 0 for in-memory tile sets
  vertexCount: number
  indexCount: number
  lineVertexCount: number
  lineIndexCount: number
  flags: number              // bit 0 = fullCover
  fullCoverFeatureId: number // flags >>> 1
}

/** Bounds + level metadata. Kept as a named type because the runtime
 *  catalog reads it back from the synthesized in-memory index. */
export interface XGVTHeader {
  levelCount: number
  maxLevel: number
  bounds: [number, number, number, number]
  /** Unused at runtime — kept as a type field so older snapshots that
   *  still set it parse without errors. */
  indexOffset: number
  indexLength: number
  propTableOffset: number
  propTableLength: number
}

/** Aggregate in-memory tile index. The catalog stores this on
 *  `loadFromTileSet` so per-key lookups (entryByHash) and bounding-
 *  box queries (header.bounds) work the same way they used to with
 *  the binary archive. */
export interface XGVTIndex {
  header: XGVTHeader
  entries: TileIndexEntry[]
  entryByHash: Map<number, TileIndexEntry>
  propertyTable?: PropertyTable
}
