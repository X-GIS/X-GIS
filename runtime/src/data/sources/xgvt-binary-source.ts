// XGVTBinaryBackend — loads tiles from the native .xgvt binary format
// (XGVTIndex header + range-batched tile bodies, optionally GPU-ready
// or compact-compressed). Extracted from XGVTSource as Step 2 of the
// layer-type refactor (plans/delegated-hopping-cray.md).
//
// Responsibility split:
//   • This module owns:
//       - the file backing (in-memory ArrayBuffer or remote URL)
//       - parseXGVTIndex / parsePropertyTable invocation
//       - the worker pool reference (compact-tile decompress + earcut
//         off the main thread)
//       - HTTP range-batching (8 KB gap merge) and the module-level
//         fullFileCache
//       - z=0 + z=1..3 preload sequencing
//       - GPU-ready vs compact dispatch when serving requestTiles
//   • Catalog (XGVTSource for now, TileCatalog post-rename) owns:
//       - dataCache, loadingTiles, the synthesised XGVTIndex shape
//       - cacheTileData / createFullCoverTileData (final cache writes
//         + onTileLoaded fan-out — same impl regardless of backend)
//
// Backend → catalog communication is via the BinaryBackendSink callback
// bundle (no direct catalog reference, no inheritance). This keeps the
// catalog's private state private and lets the backend be tested in
// isolation against a mock sink.

import {
  parseXGVTIndex, parseGPUReadyTile, parsePropertyTable,
  TILE_FLAG_FULL_COVER,
  tileKeyUnpack,
  type XGVTIndex, type TileIndexEntry,
} from '@xgis/compiler'
import { getSharedPool, type XGVTWorkerPool } from '../xgvt-worker-pool'
import { MAX_CONCURRENT_LOADS } from '../tile-types'

/** Callback bundle the binary backend uses to write its results back
 *  into the catalog's cache without touching catalog internals. */
export interface BinaryBackendSink {
  /** True if the catalog has already cached the tile (skip re-fetch). */
  hasTileData(key: number): boolean
  /** Mark a tile as in-flight (back-pressure + dedup). */
  trackLoading(key: number): void
  /** Tile finished (success or failure) — release the slot. */
  releaseLoading(key: number): void
  /** Number of tiles currently in-flight across the catalog. */
  getLoadingCount(): number
  /** Standard cache write — fires onTileLoaded → VTR upload. */
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
  /** Quad-synthesised cache write for full-cover tiles with empty
   *  vertex buffers — same downstream effect as cacheTileData. */
  createFullCoverTileData(
    key: number,
    entry: TileIndexEntry,
    lineVertices: Float32Array,
    lineIndices: Uint32Array,
  ): void
}

export class XGVTBinaryBackend {
  private fileBuf: ArrayBuffer | null = null
  private fileUrl = ''
  private isFullFileMode = false
  private _pool: XGVTWorkerPool | null = null
  /** The parsed index. Catalog reads it via getIndex() to populate its
   *  own state; backend keeps a reference for preload + range-batch. */
  index: XGVTIndex | null = null

  constructor(private sink: BinaryBackendSink) {}

  // ── Loading ──

  async loadFromBuffer(buf: ArrayBuffer): Promise<void> {
    this.fileBuf = buf
    this.index = parseXGVTIndex(buf)
    this.isFullFileMode = true

    const { propTableOffset, propTableLength } = this.index.header
    if (propTableOffset > 0 && propTableLength > 0) {
      const propBuf = buf.slice(propTableOffset, propTableOffset + propTableLength)
      this.index.propertyTable = parsePropertyTable(propBuf)
    }

    console.log(`[X-GIS] VectorTile index loaded: ${this.index.entries.length} tiles`)
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
    this.index = parseXGVTIndex(indexBuf)

    const propTableOffset = this.index.header.propTableOffset
    const propTableLength = this.index.header.propTableLength
    if (propTableOffset > 0 && propTableLength > 0) {
      const propBuf = await fetchRange(url, propTableOffset, propTableLength)
      this.index.propertyTable = parsePropertyTable(propBuf)
    }

    console.log(`[X-GIS] VectorTile index loaded: ${this.index.entries.length} tiles (Range Request mode)`)

    // Stage the z = 0 tile BEFORE returning — this is 1 tile per source,
    // parses in <100 ms, and gives the render loop a coarse global
    // fallback to paint the first frame against. All remaining low-zoom
    // tiles (z=1..3) are queued in the background via preloadBackground()
    // and populate dataCache as they arrive. The render loop's parent
    // walk will find them as soon as they're ready; until then it falls
    // back to the z=0 tile or renders nothing.
    await this.preloadZeroTile()
    // Kick off background preload but do NOT await — loadFromURL returns
    // immediately after z=0 is ready.
    this.preloadBackground().catch(e => console.error('[xgvt preload bg]', (e as Error)?.stack ?? e))
  }

  // ── Per-batch entries (called by catalog.requestTiles) ──

  /** Process a list of (key, entry) pairs that the catalog has already
   *  filtered (skipping already-cached / already-loading tiles and the
   *  full-cover-no-data fast path). Backend handles the actual fetch +
   *  decode + worker dispatch. Catalog's loadingTiles tracking is done
   *  via the sink callbacks. */
  requestTilesBatch(entries: { key: number; entry: TileIndexEntry }[]): void {
    if (entries.length === 0) return

    // Full-file mode (ArrayBuffer already loaded)
    if (this.isFullFileMode && this.fileBuf) {
      for (const { key, entry } of entries) {
        this.sink.trackLoading(key)
        const isFullCover = !!(entry.flags & TILE_FLAG_FULL_COVER)

        if (entry.gpuReadySize > 0) {
          // GPU-ready: read directly from file buffer (no decompression, no copy)
          const tile = parseGPUReadyTile(this.fileBuf!, {
            ...entry, dataOffset: entry.dataOffset + entry.compactSize,
            compactSize: 0, gpuReadySize: entry.gpuReadySize,
          })
          if (isFullCover) {
            this.sink.createFullCoverTileData(key, entry, tile.lineVertices, tile.lineIndices)
          } else {
            this.sink.cacheTileData(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices, undefined, tile.outlineIndices)
          }
          this.sink.releaseLoading(key)
        } else {
          // Compact in full-file mode: hand off to worker pool so
          // decompress + earcut runs off-main-thread.
          const slice = this.fileBuf!.slice(entry.dataOffset, entry.dataOffset + entry.compactSize)
          this.getPool().parseTile(slice, entry).then(parsed => {
            if (isFullCover) {
              this.sink.createFullCoverTileData(key, entry, parsed.lineVertices, parsed.lineIndices)
            } else {
              this.sink.cacheTileData(
                key, parsed.polygons,
                parsed.vertices, parsed.indices,
                parsed.lineVertices, parsed.lineIndices,
                undefined, parsed.outlineIndices,
              )
            }
            this.sink.releaseLoading(key)
          }).catch(err => {
            this.sink.releaseLoading(key)
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
      for (const { key } of batch.entries) this.sink.trackLoading(key)

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
            if (isFullCover) {
              this.sink.createFullCoverTileData(key, entry, tile.lineVertices, tile.lineIndices)
            } else {
              this.sink.cacheTileData(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices, undefined, tile.outlineIndices)
            }
            this.sink.releaseLoading(key)
          } else if (entry.compactSize > 0) {
            // Route compact-tile decompress + earcut through the worker
            // pool so the main thread stays free for interactive frames.
            const compressed = buf.slice(localOffset, localOffset + entry.compactSize)
            this.getPool().parseTile(compressed, entry).then(parsed => {
              if (isFullCover) {
                this.sink.createFullCoverTileData(key, entry, parsed.lineVertices, parsed.lineIndices)
              } else {
                this.sink.cacheTileData(
                  key, parsed.polygons,
                  parsed.vertices, parsed.indices,
                  parsed.lineVertices, parsed.lineIndices,
                  undefined, parsed.outlineIndices,
                )
              }
              this.sink.releaseLoading(key)
            }).catch(err => {
              this.sink.releaseLoading(key)
              console.error('[xgvt-pool parse]', (err as Error)?.stack ?? err)
            })
          } else if (isFullCover) {
            this.sink.createFullCoverTileData(key, entry, new Float32Array(0), new Uint32Array(0))
            this.sink.releaseLoading(key)
          }
        }
      }).catch(() => {
        for (const { key } of batch.entries) this.sink.releaseLoading(key)
      })
    }
  }

  // ── Internals ──

  private getPool(): XGVTWorkerPool {
    if (!this._pool) this._pool = getSharedPool()
    return this._pool
  }

  /** Parse an entry list from an already-fetched shared buffer into
   *  the catalog's cache. Called by both preloadZeroTile and
   *  preloadBackground. Compact tiles are dispatched to the worker
   *  pool so decompress + earcut runs off the main thread. */
  private async parseEntryBatch(
    entries: { key: number; entry: TileIndexEntry }[],
    sharedBuf: ArrayBuffer,
    sharedStartOffset: number,
  ): Promise<void> {
    const pool = this.getPool()
    const compactJobs: Promise<void>[] = []
    for (const { key, entry } of entries) {
      const isFullCover = !!(entry.flags & TILE_FLAG_FULL_COVER)
      const localOffset = entry.dataOffset - sharedStartOffset

      if (entry.gpuReadySize > 0) {
        const gpuOffset = localOffset + entry.compactSize
        const gpuBuf = sharedBuf.slice(gpuOffset, gpuOffset + entry.gpuReadySize)
        const tile = parseGPUReadyTile(gpuBuf, { ...entry, dataOffset: 0, compactSize: 0, gpuReadySize: gpuBuf.byteLength })
        if (isFullCover) this.sink.createFullCoverTileData(key, entry, tile.lineVertices, tile.lineIndices)
        else this.sink.cacheTileData(key, tile.polygons, tile.vertices, tile.indices, tile.lineVertices, tile.lineIndices, undefined, tile.outlineIndices)
      } else if (entry.compactSize > 0) {
        // Slice the compressed bytes and hand them to a worker. The
        // worker returns already-decompressed + earcut-tessellated
        // typed arrays as Transferables, so the main thread only runs
        // cacheTileData / createFullCoverTileData (which is fast).
        const compressed = sharedBuf.slice(localOffset, localOffset + entry.compactSize)
        compactJobs.push(
          pool.parseTile(compressed, entry).then(parsed => {
            if (isFullCover) {
              this.sink.createFullCoverTileData(key, entry, parsed.lineVertices, parsed.lineIndices)
            } else {
              this.sink.cacheTileData(
                key, parsed.polygons,
                parsed.vertices, parsed.indices,
                parsed.lineVertices, parsed.lineIndices,
                undefined, parsed.outlineIndices,
              )
            }
          }).catch(err => {
            console.error('[xgvt-pool parse]', (err as Error)?.stack ?? err)
          }),
        )
      } else if (isFullCover) {
        this.sink.createFullCoverTileData(key, entry, new Float32Array(0), new Uint32Array(0))
      }
    }
    if (compactJobs.length > 0) await Promise.all(compactJobs)
  }

  /** Stage 1 of preload: the z=0 root tile only. Resolves in ~50-100 ms
   *  per source and gives the render loop a coarse global fallback so
   *  the first frame paints immediately. Full-file and Range Request
   *  paths handled uniformly. */
  private async preloadZeroTile(): Promise<void> {
    if (!this.index) return
    const entries: { key: number; entry: TileIndexEntry }[] = []
    for (const entry of this.index.entries) {
      const [z] = tileKeyUnpack(entry.tileHash)
      if (z === 0 && !this.sink.hasTileData(entry.tileHash)) {
        entries.push({ key: entry.tileHash, entry })
      }
    }
    if (entries.length === 0) return

    if (this.isFullFileMode && this.fileBuf) {
      // In-memory mode: entries already point into the full buffer.
      await this.parseEntryBatch(entries, this.fileBuf, 0)
      return
    }

    if (!this.fileUrl) return
    const tileSize = (e: TileIndexEntry) => e.compactSize + e.gpuReadySize
    entries.sort((a, b) => a.entry.dataOffset - b.entry.dataOffset)
    const startOffset = entries[0].entry.dataOffset
    const lastEntry = entries[entries.length - 1]
    const endOffset = lastEntry.entry.dataOffset + tileSize(lastEntry.entry)
    const buf = await fetchRange(this.fileUrl, startOffset, endOffset - startOffset)
    await this.parseEntryBatch(entries, buf, startOffset)
  }

  /** Stage 2 of preload: all z=1..3 tiles, background. Runs after
   *  loadFromURL has already returned. Tiles populate dataCache as they
   *  finish; the render loop's parent walk picks them up as soon as
   *  they're ready. Errors are logged, never thrown. */
  private async preloadBackground(): Promise<void> {
    if (!this.index) return
    const PRELOAD_MAX_Z = 3
    const entries: { key: number; entry: TileIndexEntry }[] = []
    for (const entry of this.index.entries) {
      const [z] = tileKeyUnpack(entry.tileHash)
      if (z >= 1 && z <= PRELOAD_MAX_Z && !this.sink.hasTileData(entry.tileHash)) {
        entries.push({ key: entry.tileHash, entry })
      }
    }
    if (entries.length === 0) return

    if (this.isFullFileMode && this.fileBuf) {
      await this.parseEntryBatch(entries, this.fileBuf, 0)
      return
    }

    if (!this.fileUrl) return
    const tileSize = (e: TileIndexEntry) => e.compactSize + e.gpuReadySize
    entries.sort((a, b) => a.entry.dataOffset - b.entry.dataOffset)
    const startOffset = entries[0].entry.dataOffset
    const lastEntry = entries[entries.length - 1]
    const endOffset = lastEntry.entry.dataOffset + tileSize(lastEntry.entry)
    const buf = await fetchRange(this.fileUrl, startOffset, endOffset - startOffset)
    await this.parseEntryBatch(entries, buf, startOffset)
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

// MAX_CONCURRENT_LOADS imported for symmetry — sink.getLoadingCount
// vs MAX_CONCURRENT_LOADS check is currently performed by the catalog
// before invoking requestTilesBatch, but exposing here keeps the
// constant near its consumer for future refactors.
void MAX_CONCURRENT_LOADS
