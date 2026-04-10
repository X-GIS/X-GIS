// ═══ .xgvt (X-GIS Vector Tile) Binary Format ═══
// COG-style single-file format with overview pyramid.
//
// Layout:
//   [Header 32B] [TileIndex] [TileData...]
//
// Features:
//   - Sparse: only tiles with data are stored
//   - 2-layer encoding: Compact (ZigZag delta) + GPU-Ready (Float32/Uint32)
//   - HTTP Range Request compatible: Header+Index first, then individual tiles
//   - Morton-keyed tile index for spatial cache coherence

import type { CompiledTileSet, TileLevel, CompiledTile } from './vector-tiler'
import { tileKey, tileKeyUnpack } from './vector-tiler'
import { encodeCoords, encodeIndices, decodeCoords, decodeIndices, precisionForZoom } from './encoding'

// ═══ Constants ═══

const MAGIC = 0x54564758 // "XGVT" little-endian
const VERSION = 1

// ═══ Types ═══

export interface TileIndexEntry {
  tileHash: number      // Morton tile key
  dataOffset: number    // absolute byte position in file
  compactSize: number   // ZigZag compact layer size
  gpuReadySize: number  // Float32/Uint32 layer size
  vertexCount: number
  indexCount: number
  lineVertexCount: number
  lineIndexCount: number
}

// ═══ Serialize ═══

export interface SerializeOptions {
  /** Include GPU-ready layer (Float32/Uint32). Doubles file size but enables zero-copy GPU upload. Default: false */
  includeGPUReady?: boolean
}

export function serializeXGVT(tileSet: CompiledTileSet, options?: SerializeOptions): ArrayBuffer {
  const includeGPUReady = options?.includeGPUReady ?? false
  // Collect all tiles across levels
  const allTiles: { key: number; tile: CompiledTile }[] = []
  for (const level of tileSet.levels) {
    for (const [key, tile] of level.tiles) {
      allTiles.push({ key, tile })
    }
  }

  // Sort by Morton key for spatial coherence
  allTiles.sort((a, b) => a.key - b.key)

  // Pre-encode all tiles (both layers)
  const encodedTiles: {
    key: number
    compact: { coords: Uint8Array; indices: Uint8Array; lineCoords: Uint8Array; lineIndices: Uint8Array }
    gpuReady: { vertices: Float32Array; indices: Uint32Array; lineVertices: Float32Array; lineIndices: Uint32Array }
    tile: CompiledTile
  }[] = []

  for (const { key, tile } of allTiles) {
    // Compact layer: ZigZag delta encoding with zoom-adaptive precision
    const precision = precisionForZoom(tile.z)
    const polyCoordFlat: number[] = []
    for (let i = 0; i < tile.vertices.length; i += 3) {
      polyCoordFlat.push(tile.vertices[i], tile.vertices[i + 1])
    }
    const lineCoordFlat: number[] = []
    for (let i = 0; i < tile.lineVertices.length; i += 3) {
      lineCoordFlat.push(tile.lineVertices[i], tile.lineVertices[i + 1])
    }

    encodedTiles.push({
      key,
      compact: {
        coords: encodeCoords(polyCoordFlat, precision),
        indices: encodeIndices(tile.indices),
        lineCoords: encodeCoords(lineCoordFlat, precision),
        lineIndices: encodeIndices(tile.lineIndices),
      },
      gpuReady: {
        vertices: tile.vertices,
        indices: tile.indices,
        lineVertices: tile.lineVertices,
        lineIndices: tile.lineIndices,
      },
      tile,
    })
  }

  // Calculate sizes
  const headerSize = 32
  const indexEntrySize = 36 // 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 bytes
  const indexSize = 4 + encodedTiles.length * indexEntrySize // tileCount(u32) + entries

  let dataOffset = headerSize + indexSize
  const indexEntries: TileIndexEntry[] = []

  for (const et of encodedTiles) {
    const compactSize = et.compact.coords.byteLength + et.compact.indices.byteLength +
      et.compact.lineCoords.byteLength + et.compact.lineIndices.byteLength + 16 // 4 size headers
    const gpuReadySize = includeGPUReady
      ? et.gpuReady.vertices.byteLength + et.gpuReady.indices.byteLength +
        et.gpuReady.lineVertices.byteLength + et.gpuReady.lineIndices.byteLength
      : 0

    indexEntries.push({
      tileHash: et.key,
      dataOffset,
      compactSize,
      gpuReadySize,
      vertexCount: et.gpuReady.vertices.length / 3,
      indexCount: et.gpuReady.indices.length,
      lineVertexCount: et.gpuReady.lineVertices.length / 3,
      lineIndexCount: et.gpuReady.lineIndices.length,
    })

    dataOffset += compactSize + gpuReadySize
  }

  const totalSize = dataOffset

  // Write binary
  const buf = new ArrayBuffer(totalSize)
  const view = new DataView(buf)
  let pos = 0

  // Header (32 bytes)
  view.setUint32(pos, MAGIC, true); pos += 4
  view.setUint16(pos, VERSION, true); pos += 2
  view.setUint8(pos, tileSet.levels.length); pos += 1
  view.setUint8(pos, tileSet.levels.length > 0 ? tileSet.levels[tileSet.levels.length - 1].zoom : 0); pos += 1
  view.setFloat32(pos, tileSet.bounds[0], true); pos += 4 // minLon
  view.setFloat32(pos, tileSet.bounds[1], true); pos += 4 // minLat
  view.setFloat32(pos, tileSet.bounds[2], true); pos += 4 // maxLon
  view.setFloat32(pos, tileSet.bounds[3], true); pos += 4 // maxLat
  view.setUint32(pos, headerSize, true); pos += 4 // indexOffset
  view.setUint32(pos, indexSize, true); pos += 4 // indexLength

  // Tile Index
  view.setUint32(pos, indexEntries.length, true); pos += 4
  for (const entry of indexEntries) {
    view.setUint32(pos, entry.tileHash, true); pos += 4
    view.setUint32(pos, entry.dataOffset, true); pos += 4
    view.setUint32(pos, entry.compactSize, true); pos += 4
    view.setUint32(pos, entry.gpuReadySize, true); pos += 4
    view.setUint32(pos, entry.vertexCount, true); pos += 4
    view.setUint32(pos, entry.indexCount, true); pos += 4
    view.setUint32(pos, entry.lineVertexCount, true); pos += 4
    view.setUint32(pos, entry.lineIndexCount, true); pos += 4
    // padding to 36 bytes
    view.setUint32(pos, 0, true); pos += 4
  }

  // Tile Data
  for (let i = 0; i < encodedTiles.length; i++) {
    const et = encodedTiles[i]

    // Compact layer: [coordsLen][coords][indicesLen][indices][lineCoords...][lineIndices...]
    const compactParts = [et.compact.coords, et.compact.indices, et.compact.lineCoords, et.compact.lineIndices]
    for (const part of compactParts) {
      view.setUint32(pos, part.byteLength, true); pos += 4
      new Uint8Array(buf, pos, part.byteLength).set(part)
      pos += part.byteLength
    }

    // GPU-Ready layer: raw Float32/Uint32 arrays (optional)
    if (includeGPUReady) {
      const gpuParts: ArrayBufferView[] = [
        et.gpuReady.vertices, et.gpuReady.indices,
        et.gpuReady.lineVertices, et.gpuReady.lineIndices,
      ]
      for (const part of gpuParts) {
        new Uint8Array(buf, pos, part.byteLength).set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength))
        pos += part.byteLength
      }
    }
  }

  return buf
}

// ═══ Deserialize (Index only — tiles loaded on demand) ═══

export interface XGVTHeader {
  levelCount: number
  maxLevel: number
  bounds: [number, number, number, number]
  indexOffset: number
  indexLength: number
}

export interface XGVTIndex {
  header: XGVTHeader
  entries: TileIndexEntry[]
  entryByHash: Map<number, TileIndexEntry>
}

/** Parse header + index from the beginning of an .xgvt file */
export function parseXGVTIndex(buf: ArrayBuffer): XGVTIndex {
  const view = new DataView(buf)
  let pos = 0

  // Header
  const magic = view.getUint32(pos, true); pos += 4
  if (magic !== MAGIC) throw new Error(`Invalid .xgvt file (expected XGVT magic)`)

  const version = view.getUint16(pos, true); pos += 2
  if (version !== VERSION) throw new Error(`Unsupported .xgvt version: ${version}`)

  const levelCount = view.getUint8(pos); pos += 1
  const maxLevel = view.getUint8(pos); pos += 1
  const bounds: [number, number, number, number] = [
    view.getFloat32(pos, true), view.getFloat32(pos + 4, true),
    view.getFloat32(pos + 8, true), view.getFloat32(pos + 12, true),
  ]
  pos += 16
  const indexOffset = view.getUint32(pos, true); pos += 4
  const indexLength = view.getUint32(pos, true); pos += 4

  // Index
  pos = indexOffset
  const tileCount = view.getUint32(pos, true); pos += 4
  const entries: TileIndexEntry[] = []
  const entryByHash = new Map<number, TileIndexEntry>()

  for (let i = 0; i < tileCount; i++) {
    const entry: TileIndexEntry = {
      tileHash: view.getUint32(pos, true),
      dataOffset: view.getUint32(pos + 4, true),
      compactSize: view.getUint32(pos + 8, true),
      gpuReadySize: view.getUint32(pos + 12, true),
      vertexCount: view.getUint32(pos + 16, true),
      indexCount: view.getUint32(pos + 20, true),
      lineVertexCount: view.getUint32(pos + 24, true),
      lineIndexCount: view.getUint32(pos + 28, true),
    }
    pos += 36
    entries.push(entry)
    entryByHash.set(entry.tileHash, entry)
  }

  return {
    header: { levelCount, maxLevel, bounds, indexOffset, indexLength },
    entries,
    entryByHash,
  }
}

/** Extract tile data — uses GPU-ready layer if available, otherwise decodes compact layer */
export function parseGPUReadyTile(
  buf: ArrayBuffer,
  entry: TileIndexEntry,
): CompiledTile {
  const [z, x, y] = tileKeyUnpack(entry.tileHash)

  // If GPU-ready layer exists, use it directly (zero-copy)
  if (entry.gpuReadySize > 0) {
    const gpuStart = entry.dataOffset + entry.compactSize
    const gpuBuf = buf.slice(gpuStart, gpuStart + entry.gpuReadySize)

    let offset = 0
    const vertBytes = entry.vertexCount * 3 * 4
    const idxBytes = entry.indexCount * 4
    const lineVertBytes = entry.lineVertexCount * 3 * 4

    const vertices = new Float32Array(gpuBuf, offset, entry.vertexCount * 3); offset += vertBytes
    const indices = new Uint32Array(gpuBuf, offset, entry.indexCount); offset += idxBytes
    const lineVertices = new Float32Array(gpuBuf, offset, entry.lineVertexCount * 3); offset += lineVertBytes
    const lineIndices = new Uint32Array(gpuBuf, offset, entry.lineIndexCount)

    return { z, x, y, vertices, indices, lineVertices, lineIndices, featureCount: 0 }
  }

  // Decode compact layer (ZigZag delta → Float32/Uint32)
  const dataBuf = new Uint8Array(buf, entry.dataOffset, entry.compactSize)
  let pos = 0

  function readSection(): Uint8Array {
    const len = new DataView(dataBuf.buffer, dataBuf.byteOffset + pos, 4).getUint32(0, true)
    pos += 4
    const section = dataBuf.slice(pos, pos + len)
    pos += len
    return section
  }

  const coordsBuf = readSection()
  const indicesBuf = readSection()
  const lineCoordsBuf = readSection()
  const lineIndicesBuf = readSection()

  // Decode coordinates with zoom-adaptive precision
  const precision = precisionForZoom(z)
  const coords = decodeCoords(coordsBuf, precision)
  const vertices = new Float32Array(coords.length / 2 * 3)
  for (let i = 0; i < coords.length; i += 2) {
    const vi = (i / 2) * 3
    vertices[vi] = coords[i]       // lon
    vertices[vi + 1] = coords[i + 1] // lat
    vertices[vi + 2] = 0           // feat_id (not preserved in compact)
  }

  const indices = decodeIndices(indicesBuf)

  const lineCoords = decodeCoords(lineCoordsBuf, precision)
  const lineVertices = new Float32Array(lineCoords.length / 2 * 3)
  for (let i = 0; i < lineCoords.length; i += 2) {
    const vi = (i / 2) * 3
    lineVertices[vi] = lineCoords[i]
    lineVertices[vi + 1] = lineCoords[i + 1]
    lineVertices[vi + 2] = 0
  }

  const lineIndices = decodeIndices(lineIndicesBuf)

  return { z, x, y, vertices, indices, lineVertices, lineIndices, featureCount: 0 }
}
