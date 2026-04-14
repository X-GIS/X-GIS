// ═══ XGVT parse worker ═══
//
// Runs on a dedicated Web Worker thread. Receives one compact tile
// (compressed gzip + varint-encoded ring data) and returns the
// fully-parsed vertex/index arrays. All the expensive work lives here:
//
//   1. DecompressionStream gunzip
//   2. Ring-data varint decode
//   3. Earcut tessellation (Mercator-space)
//   4. Line segment build
//
// Main thread only has to receive the Transferable ArrayBuffers and
// wrap them into a TileData — no CPU cost per tile outside the GPU
// upload itself.
//
// Vite's `?worker` import handles the bundling; this file is a plain
// module that runs inside the worker scope (no DOM, no window).

import {
  parseGPUReadyTile,
  decompressTileData,
  type TileIndexEntry,
} from '@xgis/compiler'

// ── Message protocol ──

export interface WorkerParseRequest {
  kind: 'parse'
  taskId: number
  /** Compressed gzip bytes sliced out of the batched Range Request */
  compressed: ArrayBuffer
  /** Full tile index entry — parseGPUReadyTile reads vertexCount etc. */
  entry: TileIndexEntry
}

export interface WorkerParseResponse {
  kind: 'parse-done'
  taskId: number
  vertices: ArrayBuffer
  indices: ArrayBuffer
  lineVertices: ArrayBuffer
  lineIndices: ArrayBuffer
  outlineIndices: ArrayBuffer
  /** Polygon rings for runtime sub-tiling. Structured-cloned (not transferable). */
  polygons: { rings: number[][][]; featId: number }[] | undefined
}

export interface WorkerParseError {
  kind: 'parse-error'
  taskId: number
  message: string
  stack?: string
}

type InMsg = WorkerParseRequest
type OutMsg = WorkerParseResponse | WorkerParseError

// ── Worker entry point ──

self.addEventListener('message', async (e: MessageEvent<InMsg>) => {
  const msg = e.data
  if (msg.kind !== 'parse') return

  try {
    // 1. Decompress the compact bytes (async, runs on the worker's
    //    DecompressionStream pool — doesn't block the main thread).
    const decompressed = await decompressTileData(msg.compressed)

    // 2. Parse ring data + earcut + build line segments. This is the
    //    expensive CPU work that used to block the main thread.
    //    parseGPUReadyTile with compactSize > 0 + gpuReadySize = 0
    //    enters the compact-decode path (varint → earcut → buffers).
    const tile = parseGPUReadyTile(decompressed, {
      ...msg.entry,
      dataOffset: 0,
      compactSize: decompressed.byteLength,
      gpuReadySize: 0,
    })

    // 3. Send typed-array buffers back as Transferables so the main
    //    thread takes ownership without copying. The structured clone
    //    still serializes `polygons` (nested arrays) but that's cheap
    //    compared to the earcut we just avoided.
    const response: WorkerParseResponse = {
      kind: 'parse-done',
      taskId: msg.taskId,
      vertices: tile.vertices.buffer as ArrayBuffer,
      indices: tile.indices.buffer as ArrayBuffer,
      lineVertices: tile.lineVertices.buffer as ArrayBuffer,
      lineIndices: tile.lineIndices.buffer as ArrayBuffer,
      outlineIndices: tile.outlineIndices.buffer as ArrayBuffer,
      polygons: tile.polygons,
    }

    const transferables: ArrayBuffer[] = [
      response.vertices,
      response.indices,
      response.lineVertices,
      response.lineIndices,
      response.outlineIndices,
    ].filter(b => b.byteLength > 0)

    ;(self as unknown as { postMessage: (msg: OutMsg, transfer?: Transferable[]) => void })
      .postMessage(response, transferables)
  } catch (err) {
    const e = err as Error
    const response: WorkerParseError = {
      kind: 'parse-error',
      taskId: msg.taskId,
      message: e.message || String(err),
      stack: e.stack,
    }
    ;(self as unknown as { postMessage: (msg: OutMsg) => void }).postMessage(response)
  }
})
