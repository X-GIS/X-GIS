// MVT compile worker — runs the heavy PMTiles tile pipeline off the
// main thread:
//
//   bytes (raw MVT, gzipped or plain)
//     ↓ decodeMvtTile  (pbf decode + un-quantize to lon/lat)
//     ↓ decomposeFeatures  (project to MM, build GeometryParts)
//     ↓ compileSingleTile  (clip + simplify + earcut + DSFUN pack)
//     ↓ buildLineSegments  (CSR adjacency + miter pads, for outline + line)
//   typed-array buffers + transferables
//
// Returns ArrayBuffers transferred zero-copy back to main, where
// PMTilesBackend wraps them as a BackendTileResult and pushes via
// sink.acceptResult. Main thread cost per tile ≈ GPU upload only
// (~5 ms) instead of decode+compile+segments (~80 ms).

import {
  decodeMvtTile, decomposeFeatures, compileSingleTile,
} from '@xgis/compiler'
import { buildLineSegments } from '../engine/line-segment-build'

// ── Message protocol ──

export interface MvtCompileRequest {
  kind: 'compile-mvt'
  taskId: number
  bytes: ArrayBuffer
  z: number
  x: number
  y: number
  /** Compiler simplification cap (header.maxZoom of the archive) */
  maxZoom: number
  /** MVT layer name allow-list (decoder filters before decompose). */
  layers?: string[]
  /** Tile size in Mercator metres (precomputed by the dispatcher to
   *  avoid redoing the projection inside the worker). */
  tileWidthMerc: number
  tileHeightMerc: number
}

export interface MvtCompileResponse {
  kind: 'compile-done'
  taskId: number
  /** null result fields are encoded as undefined byteLength=0 buffers
   *  so the response shape stays stable. */
  vertices: ArrayBuffer
  indices: ArrayBuffer
  lineVertices: ArrayBuffer
  lineIndices: ArrayBuffer
  pointVertices?: ArrayBuffer
  outlineIndices?: ArrayBuffer
  outlineVertices?: ArrayBuffer
  outlineLineIndices?: ArrayBuffer
  /** Pre-built segment buffers — main skips buildLineSegments. */
  prebuiltLineSegments?: ArrayBuffer
  prebuiltOutlineSegments?: ArrayBuffer
  /** Polygon rings preserved for runtime sub-tiling (structured-cloned). */
  polygons?: { rings: number[][][]; featId: number }[]
  fullCover: boolean
  fullCoverFeatureId: number
  /** True when the archive returned no features for this key — main
   *  treats as empty placeholder. */
  empty: boolean
}

export interface MvtCompileError {
  kind: 'compile-error'
  taskId: number
  message: string
  stack?: string
}

type InMsg = MvtCompileRequest
type OutMsg = MvtCompileResponse | MvtCompileError

// ── Worker entry ──

self.addEventListener('message', (e: MessageEvent<InMsg>) => {
  const msg = e.data
  if (msg.kind !== 'compile-mvt') return

  try {
    const features = decodeMvtTile(
      new Uint8Array(msg.bytes), msg.z, msg.x, msg.y,
      { layers: msg.layers },
    )
    if (features.length === 0) {
      const empty = new Float32Array(0).buffer as ArrayBuffer
      const emptyI = new Uint32Array(0).buffer as ArrayBuffer
      const response: MvtCompileResponse = {
        kind: 'compile-done',
        taskId: msg.taskId,
        vertices: empty, indices: emptyI,
        lineVertices: empty, lineIndices: emptyI,
        fullCover: false, fullCoverFeatureId: 0, empty: true,
      }
      ;(self as unknown as { postMessage: (m: OutMsg) => void }).postMessage(response)
      return
    }

    const parts = decomposeFeatures(features)
    const tile = compileSingleTile(parts, msg.z, msg.x, msg.y, msg.maxZoom)
    if (!tile) {
      const empty = new Float32Array(0).buffer as ArrayBuffer
      const emptyI = new Uint32Array(0).buffer as ArrayBuffer
      const response: MvtCompileResponse = {
        kind: 'compile-done',
        taskId: msg.taskId,
        vertices: empty, indices: emptyI,
        lineVertices: empty, lineIndices: emptyI,
        fullCover: false, fullCoverFeatureId: 0, empty: true,
      }
      ;(self as unknown as { postMessage: (m: OutMsg) => void }).postMessage(response)
      return
    }

    // Pre-build SDF segment buffers so doUploadTile on main has zero
    // line-geometry work. Outline + line each go through
    // buildLineSegments with the same tile dimensions.
    let prebuiltLineSegments: ArrayBuffer | undefined
    let prebuiltOutlineSegments: ArrayBuffer | undefined
    if (tile.outlineVertices && tile.outlineVertices.length > 0
        && tile.outlineLineIndices && tile.outlineLineIndices.length > 0) {
      const seg = buildLineSegments(
        tile.outlineVertices, tile.outlineLineIndices, 10,
        msg.tileWidthMerc, msg.tileHeightMerc,
      )
      prebuiltOutlineSegments = seg.buffer as ArrayBuffer
    }
    if (tile.lineIndices.length > 0 && tile.lineVertices.length > 0) {
      // Match VTR's stride detection (vector-tile-renderer.ts): scan
      // the highest index and divide vertex array by vertex count to
      // pick stride 6 vs 10.
      let lineStride: 6 | 10 = 6
      let maxIdx = 0
      for (let li = 0; li < tile.lineIndices.length; li++) {
        if (tile.lineIndices[li] > maxIdx) maxIdx = tile.lineIndices[li]
      }
      const vertCount = maxIdx + 1
      if (vertCount > 0 && tile.lineVertices.length / vertCount >= 10) lineStride = 10
      const seg = buildLineSegments(
        tile.lineVertices, tile.lineIndices, lineStride,
        msg.tileWidthMerc, msg.tileHeightMerc,
      )
      prebuiltLineSegments = seg.buffer as ArrayBuffer
    }

    const response: MvtCompileResponse = {
      kind: 'compile-done',
      taskId: msg.taskId,
      vertices: tile.vertices.buffer as ArrayBuffer,
      indices: tile.indices.buffer as ArrayBuffer,
      lineVertices: tile.lineVertices.buffer as ArrayBuffer,
      lineIndices: tile.lineIndices.buffer as ArrayBuffer,
      pointVertices: tile.pointVertices?.buffer as ArrayBuffer | undefined,
      outlineIndices: tile.outlineIndices?.buffer as ArrayBuffer | undefined,
      outlineVertices: tile.outlineVertices?.buffer as ArrayBuffer | undefined,
      outlineLineIndices: tile.outlineLineIndices?.buffer as ArrayBuffer | undefined,
      prebuiltLineSegments,
      prebuiltOutlineSegments,
      polygons: tile.polygons?.map(p => ({ rings: p.rings, featId: p.featId })),
      fullCover: tile.fullCover ?? false,
      fullCoverFeatureId: tile.fullCoverFeatureId ?? 0,
      empty: false,
    }
    const transfer: ArrayBuffer[] = [
      response.vertices, response.indices,
      response.lineVertices, response.lineIndices,
    ]
    if (response.pointVertices) transfer.push(response.pointVertices)
    if (response.outlineIndices) transfer.push(response.outlineIndices)
    if (response.outlineVertices) transfer.push(response.outlineVertices)
    if (response.outlineLineIndices) transfer.push(response.outlineLineIndices)
    if (response.prebuiltLineSegments) transfer.push(response.prebuiltLineSegments)
    if (response.prebuiltOutlineSegments) transfer.push(response.prebuiltOutlineSegments)
    ;(self as unknown as { postMessage: (m: OutMsg, t?: Transferable[]) => void })
      .postMessage(response, transfer.filter(b => b.byteLength > 0))
  } catch (err) {
    const e = err as Error
    ;(self as unknown as { postMessage: (m: OutMsg) => void }).postMessage({
      kind: 'compile-error',
      taskId: msg.taskId,
      message: e.message || String(err),
      stack: e.stack,
    })
  }
})
