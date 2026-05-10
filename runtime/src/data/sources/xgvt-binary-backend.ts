// XGVTBinaryBackend — TileSource implementation for the native .xgvt
// binary format (XGVTIndex header + range-batched tile bodies, optionally
// GPU-ready or compact-compressed). Refactored in Step 5 to implement
// the formal TileSource interface.
//
// Loading model: archive index is parsed up front (loadFromBuffer/URL).
// Once attached, the backend's meta.entries lists every preregistered
// tile so catalog can populate entryToBackend deterministically.
// Per-tile fetch is fired via loadTile (single) or loadTilesBatch
// (multi — does HTTP range-request merging in Range Request mode).
//
// The XGVT-binary path retains the worker-pool decompress + earcut
// off-thread for compact tiles. Backend uses sink callbacks
// (trackLoading / releaseLoading / acceptResult) to push results into
// the catalog's cache.

import {
  parseXGVTIndex, parseGPUReadyTile, parsePropertyTable,
  TILE_FLAG_FULL_COVER,
  tileKeyUnpack,
  type TileIndexEntry,
} from '@xgis/compiler'
import { getSharedPool, type XGVTWorkerPool } from '../workers/xgvt-worker-pool'
import type {
  TileSource, TileSourceSink, TileSourceMeta, BackendTileResult,
} from '../tile-source'

export class XGVTBinaryBackend implements TileSource {
  meta: TileSourceMeta = {
    bounds: [-180, -85, 180, 85],
    minZoom: 0,
    maxZoom: 0,
    propertyTable: undefined,
    entries: [],
  }

  private fileBuf: ArrayBuffer | null = null
  private fileUrl = ''
  private isFullFileMode = false
  private _pool: XGVTWorkerPool | null = null
  private sink: TileSourceSink | null = null
  /** Lookup the entry for a given key — used by has() + the request
   *  path to fetch the right byte range. Mirrors the index's
   *  entryByHash but lives on the backend so meta.entries stays the
   *  source of truth. */
  private entryByKey = new Map<number, TileIndexEntry>()

  attach(sink: TileSourceSink): void {
    this.sink = sink
  }

  has(key: number): boolean {
    return this.entryByKey.has(key)
  }

  // ── Loading (called by catalog.loadFromBuffer / loadFromURL) ──

  async loadFromBuffer(buf: ArrayBuffer): Promise<void> {
    this.fileBuf = buf
    const index = parseXGVTIndex(buf)
    this.isFullFileMode = true

    const { propTableOffset, propTableLength } = index.header
    if (propTableOffset > 0 && propTableLength > 0) {
      const propBuf = buf.slice(propTableOffset, propTableOffset + propTableLength)
      index.propertyTable = parsePropertyTable(propBuf)
    }

    this.adoptIndex(index)
    console.log(`[X-GIS] VectorTile index loaded: ${index.entries.length} tiles`)
    // Mirror loadFromURL's two-stage preload: z=0 synchronously (so the
    // render loop has a coarse global fallback on the first frame),
    // then z=1..3 in the background. Historically this called a
    // non-existent `preloadLowZoomTiles()` — the method was split into
    // preloadZeroTile + preloadBackground but the fallback path
    // (map.ts, reached when loadFromURL throws) wasn't updated, causing
    // a TypeError that left the source with no cached tiles at all —
    // the exact "nothing loads" symptom.
    await this.preloadZeroTile()
    this.preloadBackground().catch(e => console.error('[xgvt preload bg]', (e as Error)?.stack ?? e))
  }

  async loadFromURL(url: string): Promise<void> {
    this.fileUrl = url

    const headerBuf = await fetchRange(url, 0, 40)
    const view = new DataView(headerBuf)
    const indexOffset = view.getUint32(24, true)
    const indexLength = view.getUint32(28, true)

    const indexBuf = await fetchRange(url, 0, indexOffset + indexLength)
    const index = parseXGVTIndex(indexBuf)

    const propTableOffset = index.header.propTableOffset
    const propTableLength = index.header.propTableLength
    if (propTableOffset > 0 && propTableLength > 0) {
      const propBuf = await fetchRange(url, propTableOffset, propTableLength)
      index.propertyTable = parsePropertyTable(propBuf)
    }

    this.adoptIndex(index)
    console.log(`[X-GIS] VectorTile index loaded: ${index.entries.length} tiles (Range Request mode)`)

    // Stage the z = 0 tile BEFORE returning — this is 1 tile per source,
    // parses in <100 ms, and gives the render loop a coarse global
    // fallback to paint the first frame against. All remaining low-zoom
    // tiles (z=1..3) are queued in the background via preloadBackground()
    // and populate dataCache as they arrive.
    await this.preloadZeroTile()
    this.preloadBackground().catch(e => console.error('[xgvt preload bg]', (e as Error)?.stack ?? e))
  }

  // ── TileSource async/batched fetch ──

  loadTile(key: number): void {
    const entry = this.entryByKey.get(key)
    if (!entry) return
    this.requestEntries([{ key, entry }])
  }

  loadTilesBatch(keys: number[]): void {
    const entries: { key: number; entry: TileIndexEntry }[] = []
    for (const key of keys) {
      const entry = this.entryByKey.get(key)
      if (entry) entries.push({ key, entry })
    }
    if (entries.length > 0) this.requestEntries(entries)
  }

  // ── Internals ──

  /** Adopt a freshly-parsed XGVTIndex into the backend's meta + lookup
   *  map. Catalog's attachBackend re-merges meta after each backend
   *  attach; calling this AFTER attach is fine because catalog reads
   *  meta.entries each time it dispatches. */
  private adoptIndex(index: { header: { bounds: [number, number, number, number]; maxLevel: number }; entries: TileIndexEntry[]; propertyTable?: TileSourceMeta['propertyTable'] }): void {
    this.entryByKey.clear()
    const entryList: { key: number; entry: TileIndexEntry }[] = []
    for (const e of index.entries) {
      this.entryByKey.set(e.tileHash, e)
      entryList.push({ key: e.tileHash, entry: e })
    }
    this.meta = {
      bounds: index.header.bounds,
      minZoom: 0,
      maxZoom: index.header.maxLevel,
      propertyTable: index.propertyTable,
      entries: entryList,
    }
  }

  private getPool(): XGVTWorkerPool {
    if (!this._pool) this._pool = getSharedPool()
    return this._pool
  }

  /** Process a list of (key, entry) pairs that the catalog has already
   *  filtered (skipping already-cached / already-loading tiles and the
   *  full-cover-no-data fast path). Backend handles the actual fetch +
   *  decode + worker dispatch. */
  private requestEntries(entries: { key: number; entry: TileIndexEntry }[]): void {
    const sink = this.sink
    if (!sink || entries.length === 0) return

    // Full-file mode (ArrayBuffer already loaded)
    if (this.isFullFileMode && this.fileBuf) {
      for (const { key, entry } of entries) {
        sink.trackLoading(key)
        const isFullCover = !!(entry.flags & TILE_FLAG_FULL_COVER)

        if (entry.gpuReadySize > 0) {
          // GPU-ready: read directly from file buffer (no decompression, no copy)
          const tile = parseGPUReadyTile(this.fileBuf!, {
            ...entry, dataOffset: entry.dataOffset + entry.compactSize,
            compactSize: 0, gpuReadySize: entry.gpuReadySize,
          })
          sink.acceptResult(key, gpuTileToResult(tile, isFullCover, entry))
          sink.releaseLoading(key)
        } else {
          // Compact in full-file mode: hand off to worker pool so
          // decompress + earcut runs off-main-thread.
          const slice = this.fileBuf!.slice(entry.dataOffset, entry.dataOffset + entry.compactSize)
          this.getPool().parseTile(slice, entry).then(parsed => {
            sink.acceptResult(key, parsedTileToResult(parsed, isFullCover, entry))
            sink.releaseLoading(key)
          }).catch(err => {
            sink.releaseLoading(key)
            console.error('[xgvt-pool parse]', (err as Error)?.stack ?? err)
          })
        }
      }
      return
    }

    if (!this.fileUrl) return

    // Range Request mode: sort by offset, merge adjacent tiles
    entries.sort((a, b) => a.entry.dataOffset - b.entry.dataOffset)

    const MAX_GAP = 8 * 1024  // 8KB gap tolerance — merge nearby tiles into fewer requests
    const tileSize = (e: TileIndexEntry) => e.compactSize + e.gpuReadySize
    const batches: { entries: typeof entries; startOffset: number; endOffset: number }[] = []
    let current = {
      entries: [entries[0]],
      startOffset: entries[0].entry.dataOffset,
      endOffset: entries[0].entry.dataOffset + tileSize(entries[0].entry),
    }

    for (let i = 1; i < entries.length; i++) {
      const e = entries[i]
      const eEnd = e.entry.dataOffset + tileSize(e.entry)
      if (e.entry.dataOffset - current.endOffset <= MAX_GAP) {
        current.entries.push(e)
        current.endOffset = Math.max(current.endOffset, eEnd)
      } else {
        batches.push(current)
        current = { entries: [e], startOffset: e.entry.dataOffset, endOffset: eEnd }
      }
    }
    batches.push(current)

    for (const batch of batches) {
      for (const { key } of batch.entries) sink.trackLoading(key)

      const size = batch.endOffset - batch.startOffset
      if (size <= 0) continue

      fetchRange(this.fileUrl, batch.startOffset, size).then(buf => {
        for (const { key, entry } of batch.entries) {
          const isFullCover = !!(entry.flags & TILE_FLAG_FULL_COVER)
          const localOffset = entry.dataOffset - batch.startOffset

          if (entry.gpuReadySize > 0) {
            const gpuOffset = localOffset + entry.compactSize
            const gpuBuf = buf.slice(gpuOffset, gpuOffset + entry.gpuReadySize)
            const tile = parseGPUReadyTile(gpuBuf, { ...entry, dataOffset: 0, compactSize: 0, gpuReadySize: gpuBuf.byteLength })
            sink.acceptResult(key, gpuTileToResult(tile, isFullCover, entry))
            sink.releaseLoading(key)
          } else if (entry.compactSize > 0) {
            // Route compact-tile decompress + earcut through the worker
            // pool so the main thread stays free for interactive frames.
            const compressed = buf.slice(localOffset, localOffset + entry.compactSize)
            this.getPool().parseTile(compressed, entry).then(parsed => {
              sink.acceptResult(key, parsedTileToResult(parsed, isFullCover, entry))
              sink.releaseLoading(key)
            }).catch(err => {
              sink.releaseLoading(key)
              console.error('[xgvt-pool parse]', (err as Error)?.stack ?? err)
            })
          } else if (isFullCover) {
            sink.acceptResult(key, {
              vertices: new Float32Array(0),
              indices: new Uint32Array(0),
              lineVertices: new Float32Array(0),
              lineIndices: new Uint32Array(0),
              fullCover: true,
              fullCoverFeatureId: entry.fullCoverFeatureId,
            })
            sink.releaseLoading(key)
          }
        }
      }).catch(() => {
        for (const { key } of batch.entries) sink.releaseLoading(key)
      })
    }
  }

  /** Stage 1 of preload: the z=0 root tile only. */
  private async preloadZeroTile(): Promise<void> {
    const entries = this.meta.entries ?? []
    const matched: { key: number; entry: TileIndexEntry }[] = []
    for (const { key, entry } of entries) {
      const [z] = tileKeyUnpack(entry.tileHash)
      if (z === 0 && this.sink && !this.sink.hasTileData(entry.tileHash)) {
        matched.push({ key, entry })
      }
    }
    if (matched.length === 0) return

    if (this.isFullFileMode && this.fileBuf) {
      this.requestEntries(matched)
      return
    }

    if (!this.fileUrl) return
    const tileSize = (e: TileIndexEntry) => e.compactSize + e.gpuReadySize
    matched.sort((a, b) => a.entry.dataOffset - b.entry.dataOffset)
    const startOffset = matched[0].entry.dataOffset
    const lastEntry = matched[matched.length - 1]
    const endOffset = lastEntry.entry.dataOffset + tileSize(lastEntry.entry)
    const buf = await fetchRange(this.fileUrl, startOffset, endOffset - startOffset)
    await this.parseEntryBatch(matched, buf, startOffset)
  }

  /** Stage 2 of preload: all z=1..3 tiles, background. */
  private async preloadBackground(): Promise<void> {
    const PRELOAD_MAX_Z = 3
    const entries = this.meta.entries ?? []
    const matched: { key: number; entry: TileIndexEntry }[] = []
    for (const { key, entry } of entries) {
      const [z] = tileKeyUnpack(entry.tileHash)
      if (z >= 1 && z <= PRELOAD_MAX_Z && this.sink && !this.sink.hasTileData(entry.tileHash)) {
        matched.push({ key, entry })
      }
    }
    if (matched.length === 0) return

    if (this.isFullFileMode && this.fileBuf) {
      this.requestEntries(matched)
      return
    }

    if (!this.fileUrl) return
    const tileSize = (e: TileIndexEntry) => e.compactSize + e.gpuReadySize
    matched.sort((a, b) => a.entry.dataOffset - b.entry.dataOffset)
    const startOffset = matched[0].entry.dataOffset
    const lastEntry = matched[matched.length - 1]
    const endOffset = lastEntry.entry.dataOffset + tileSize(lastEntry.entry)
    const buf = await fetchRange(this.fileUrl, startOffset, endOffset - startOffset)
    await this.parseEntryBatch(matched, buf, startOffset)
  }

  /** Parse an entry list from an already-fetched shared buffer.
   *  Used by Range Request mode preload (full-file mode just calls
   *  requestEntries directly). Compact tiles dispatch to the worker
   *  pool for off-main-thread decompress + earcut. */
  private async parseEntryBatch(
    entries: { key: number; entry: TileIndexEntry }[],
    sharedBuf: ArrayBuffer,
    sharedStartOffset: number,
  ): Promise<void> {
    const sink = this.sink
    if (!sink) return
    const pool = this.getPool()
    const compactJobs: Promise<void>[] = []
    for (const { key, entry } of entries) {
      const isFullCover = !!(entry.flags & TILE_FLAG_FULL_COVER)
      const localOffset = entry.dataOffset - sharedStartOffset

      if (entry.gpuReadySize > 0) {
        const gpuOffset = localOffset + entry.compactSize
        const gpuBuf = sharedBuf.slice(gpuOffset, gpuOffset + entry.gpuReadySize)
        const tile = parseGPUReadyTile(gpuBuf, { ...entry, dataOffset: 0, compactSize: 0, gpuReadySize: gpuBuf.byteLength })
        sink.acceptResult(key, gpuTileToResult(tile, isFullCover, entry))
      } else if (entry.compactSize > 0) {
        const compressed = sharedBuf.slice(localOffset, localOffset + entry.compactSize)
        compactJobs.push(
          pool.parseTile(compressed, entry).then(parsed => {
            sink.acceptResult(key, parsedTileToResult(parsed, isFullCover, entry))
          }).catch(err => {
            console.error('[xgvt-pool parse]', (err as Error)?.stack ?? err)
          }),
        )
      } else if (isFullCover) {
        sink.acceptResult(key, {
          vertices: new Float32Array(0),
          indices: new Uint32Array(0),
          lineVertices: new Float32Array(0),
          lineIndices: new Uint32Array(0),
          fullCover: true,
          fullCoverFeatureId: entry.fullCoverFeatureId,
        })
      }
    }
    if (compactJobs.length > 0) await Promise.all(compactJobs)
  }
}

/** Project parseGPUReadyTile output into BackendTileResult shape. */
function gpuTileToResult(
  tile: { polygons?: { rings: number[][][]; featId: number }[]; vertices: Float32Array; indices: Uint32Array; lineVertices: Float32Array; lineIndices: Uint32Array; outlineIndices?: Uint32Array },
  isFullCover: boolean,
  entry: TileIndexEntry,
): BackendTileResult {
  return {
    vertices: tile.vertices,
    indices: tile.indices,
    lineVertices: tile.lineVertices,
    lineIndices: tile.lineIndices,
    outlineIndices: tile.outlineIndices,
    polygons: tile.polygons,
    fullCover: isFullCover,
    fullCoverFeatureId: entry.fullCoverFeatureId,
  }
}

/** Project worker-pool parseTile output into BackendTileResult shape. */
function parsedTileToResult(
  parsed: { polygons?: { rings: number[][][]; featId: number }[]; vertices: Float32Array; indices: Uint32Array; lineVertices: Float32Array; lineIndices: Uint32Array; outlineIndices?: Uint32Array },
  isFullCover: boolean,
  entry: TileIndexEntry,
): BackendTileResult {
  return {
    vertices: parsed.vertices,
    indices: parsed.indices,
    lineVertices: parsed.lineVertices,
    lineIndices: parsed.lineIndices,
    outlineIndices: parsed.outlineIndices,
    polygons: parsed.polygons,
    fullCover: isFullCover,
    fullCoverFeatureId: entry.fullCoverFeatureId,
  }
}

// ═══ HTTP Range fetch with full-file shortcut ═══

let fullFileCache: { url: string; buf: ArrayBuffer } | null = null

/** Reset the module-level full-file cache. Tests use this to avoid
 *  cross-suite bleed when multiple sources share the same backend
 *  module load. */
export function resetFullFileCache(): void {
  fullFileCache = null
}

async function fetchRange(url: string, offset: number, length: number): Promise<ArrayBuffer> {
  if (fullFileCache && fullFileCache.url === url) {
    return fullFileCache.buf.slice(offset, offset + length)
  }

  const res = await fetch(url, {
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
  })
  const buf = await res.arrayBuffer()

  if (res.status === 200 && buf.byteLength > length) {
    fullFileCache = { url, buf }
    return buf.slice(offset, offset + length)
  }
  return buf
}
