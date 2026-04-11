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

import type { CompiledTileSet, CompiledTile, PropertyTable, PropertyFieldType } from './vector-tiler'
import { tileKeyUnpack } from './vector-tiler'
import { encodeCoords, encodeIndices, decodeCoords, decodeIndices, encodeFeatIds, decodeFeatIds, precisionForZoom, encodeRingData, decodeRingData } from './encoding'
import earcut from 'earcut'
// gzip: compile-time only (node:zlib), runtime uses DecompressionStream
let gzipSync: (buf: Buffer) => Buffer
let gunzipSync: (buf: Buffer) => Buffer
try {
  const zlib = require('node:zlib')
  gzipSync = zlib.gzipSync
  gunzipSync = zlib.gunzipSync
} catch {
  // Browser: gzipSync not available (only used at compile time)
  gzipSync = (_buf: Buffer) => { throw new Error('gzip not available in browser') }
  gunzipSync = (_buf: Buffer) => { throw new Error('gunzip not available in browser — use decompressTile()') }
}

// ═══ Constants ═══

const MAGIC = 0x54564758 // "XGVT" little-endian
const VERSION = 1 // ring-based format: polygon rings + line data

// ═══ Types ═══

export const TILE_FLAG_FULL_COVER = 0x1

export interface TileIndexEntry {
  tileHash: number      // Morton tile key
  dataOffset: number    // absolute byte position in file
  compactSize: number   // ZigZag compact layer size
  gpuReadySize: number  // Float32/Uint32 layer size
  vertexCount: number
  indexCount: number
  lineVertexCount: number
  lineIndexCount: number
  flags: number              // bit 0 = fullCover (reuses 4B padding)
  fullCoverFeatureId: number // flags >>> 1
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
    compact: { coords: Uint8Array; indices: Uint8Array; lineCoords: Uint8Array; lineIndices: Uint8Array; polyFeatIds: Uint8Array; lineFeatIds: Uint8Array }
    gpuReady: { vertices: Float32Array; indices: Uint32Array; lineVertices: Float32Array; lineIndices: Uint32Array }
    tile: CompiledTile
  }[] = []

  for (const { key, tile } of allTiles) {
    const precision = precisionForZoom(tile.z)

    // Encode ring data (polygon structure + coords) for runtime sub-tiling
    const ringDataBuf = encodeRingData(tile.polygons ?? [], precision)

    // Encode line data
    const lineCoordFlat: number[] = []
    const lineFeatIds: number[] = []
    for (let i = 0; i < tile.lineVertices.length; i += 3) {
      lineCoordFlat.push(tile.lineVertices[i], tile.lineVertices[i + 1])
      lineFeatIds.push(tile.lineVertices[i + 2])
    }

    encodedTiles.push({
      key,
      compact: {
        ringData: ringDataBuf,
        lineCoords: encodeCoords(lineCoordFlat, precision),
        lineIndices: encodeIndices(tile.lineIndices),
        lineFeatIds: encodeFeatIds(lineFeatIds),
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

  // Serialize property table
  const propTableBuf = serializePropertyTable(tileSet.propertyTable)

  // Calculate sizes
  const headerSize = 40 // v2: 32B + propTableOffset(4) + propTableLength(4)
  const indexEntrySize = 36
  const indexSize = 4 + encodedTiles.length * indexEntrySize
  const propTableOffset = headerSize + indexSize
  const propTableLength = propTableBuf.byteLength

  let dataOffset = propTableOffset + propTableLength
  const indexEntries: TileIndexEntry[] = []

  // Pre-compress each tile's compact data with gzip
  const compressedTiles: (Uint8Array | null)[] = []
  for (const et of encodedTiles) {
    // Full-cover tiles with no geometry: skip compact data entirely
    const isEmpty = et.tile.fullCover &&
      et.tile.vertices.length === 0 && et.tile.lineVertices.length === 0
    if (isEmpty) {
      compressedTiles.push(null) // no compact data
      continue
    }
    // Concatenate compact parts: ringData + lineCoords + lineIndices + lineFeatIds
    const parts = [et.compact.ringData, et.compact.lineCoords, et.compact.lineIndices, et.compact.lineFeatIds]
    let rawSize = 0
    for (const p of parts) rawSize += 4 + p.byteLength
    const rawBuf = new Uint8Array(rawSize)
    let off = 0
    for (const p of parts) {
      new DataView(rawBuf.buffer).setUint32(off, p.byteLength, true); off += 4
      rawBuf.set(p, off); off += p.byteLength
    }
    compressedTiles.push(new Uint8Array(gzipSync(Buffer.from(rawBuf))))
  }

  for (let ci = 0; ci < encodedTiles.length; ci++) {
    const et = encodedTiles[ci]
    const compactSize = compressedTiles[ci]?.byteLength ?? 0
    const gpuReadySize = includeGPUReady
      ? et.gpuReady.vertices.byteLength + et.gpuReady.indices.byteLength +
        et.gpuReady.lineVertices.byteLength + et.gpuReady.lineIndices.byteLength
      : 0

    const tile = et.tile
    const flagsWord = tile.fullCover
      ? (TILE_FLAG_FULL_COVER | ((tile.fullCoverFeatureId ?? 0) << 1))
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
      flags: flagsWord & 0x1,
      fullCoverFeatureId: flagsWord >>> 1,
    })

    dataOffset += compactSize + gpuReadySize
  }

  const totalSize = dataOffset

  // Write binary
  const buf = new ArrayBuffer(totalSize)
  const view = new DataView(buf)
  let pos = 0

  // Header (40 bytes, v2)
  view.setUint32(pos, MAGIC, true); pos += 4
  view.setUint16(pos, VERSION, true); pos += 2
  view.setUint8(pos, tileSet.levels.length); pos += 1
  view.setUint8(pos, tileSet.levels.length > 0 ? tileSet.levels[tileSet.levels.length - 1].zoom : 0); pos += 1
  view.setFloat32(pos, tileSet.bounds[0], true); pos += 4
  view.setFloat32(pos, tileSet.bounds[1], true); pos += 4
  view.setFloat32(pos, tileSet.bounds[2], true); pos += 4
  view.setFloat32(pos, tileSet.bounds[3], true); pos += 4
  view.setUint32(pos, headerSize, true); pos += 4 // indexOffset
  view.setUint32(pos, indexSize, true); pos += 4 // indexLength
  view.setUint32(pos, propTableOffset, true); pos += 4 // propTableOffset (v2)
  view.setUint32(pos, propTableLength, true); pos += 4 // propTableLength (v2)

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
    // flags: bit 0 = fullCover, bits 1-31 = fullCoverFeatureId
    const flagsWord = (entry.flags & 0x1) | ((entry.fullCoverFeatureId ?? 0) << 1)
    view.setUint32(pos, flagsWord, true); pos += 4
  }

  // Property Table
  new Uint8Array(buf, pos, propTableBuf.byteLength).set(new Uint8Array(propTableBuf))
  pos += propTableBuf.byteLength

  // Tile Data
  for (let i = 0; i < encodedTiles.length; i++) {
    const et = encodedTiles[i]

    // Gzip-compressed compact layer (null for empty full-cover tiles)
    const compressed = compressedTiles[i]
    if (compressed) {
      new Uint8Array(buf, pos, compressed.byteLength).set(compressed)
      pos += compressed.byteLength
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
  propTableOffset: number
  propTableLength: number
}

export interface XGVTIndex {
  header: XGVTHeader
  entries: TileIndexEntry[]
  entryByHash: Map<number, TileIndexEntry>
  propertyTable?: PropertyTable
}

/** Parse header + index from the beginning of an .xgvt file */
export function parseXGVTIndex(buf: ArrayBuffer): XGVTIndex {
  const view = new DataView(buf)
  let pos = 0

  // Header
  const magic = view.getUint32(pos, true); pos += 4
  if (magic !== MAGIC) throw new Error(`Invalid .xgvt file (expected XGVT magic)`)

  const version = view.getUint16(pos, true); pos += 2
  if (version !== VERSION) throw new Error(`Unsupported .xgvt version: ${version} (expected ${VERSION})`)

  const levelCount = view.getUint8(pos); pos += 1
  const maxLevel = view.getUint8(pos); pos += 1
  const bounds: [number, number, number, number] = [
    view.getFloat32(pos, true), view.getFloat32(pos + 4, true),
    view.getFloat32(pos + 8, true), view.getFloat32(pos + 12, true),
  ]
  pos += 16
  const indexOffset = view.getUint32(pos, true); pos += 4
  const indexLength = view.getUint32(pos, true); pos += 4

  // Property table offset/length
  const propTableOffset = view.getUint32(pos, true); pos += 4
  const propTableLength = view.getUint32(pos, true); pos += 4

  // Index
  pos = indexOffset
  const tileCount = view.getUint32(pos, true); pos += 4
  const entries: TileIndexEntry[] = []
  const entryByHash = new Map<number, TileIndexEntry>()

  for (let i = 0; i < tileCount; i++) {
    const flagsWord = view.getUint32(pos + 32, true)
    const entry: TileIndexEntry = {
      tileHash: view.getUint32(pos, true),
      dataOffset: view.getUint32(pos + 4, true),
      compactSize: view.getUint32(pos + 8, true),
      gpuReadySize: view.getUint32(pos + 12, true),
      vertexCount: view.getUint32(pos + 16, true),
      indexCount: view.getUint32(pos + 20, true),
      lineVertexCount: view.getUint32(pos + 24, true),
      lineIndexCount: view.getUint32(pos + 28, true),
      flags: flagsWord & 0x1,
      fullCoverFeatureId: flagsWord >>> 1,
    }
    pos += 36
    entries.push(entry)
    entryByHash.set(entry.tileHash, entry)
  }

  return {
    header: { levelCount, maxLevel, bounds, indexOffset, indexLength, propTableOffset, propTableLength },
    entries,
    entryByHash,
  }
}

/**
 * Decompress gzip'd tile data in browser using DecompressionStream API.
 * Returns decompressed ArrayBuffer.
 */
export async function decompressTileData(compressed: ArrayBuffer): Promise<ArrayBuffer> {
  try {
    const ds = new DecompressionStream('gzip')
    const reader = new Blob([compressed]).stream().pipeThrough(ds).getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    let totalLen = 0
    for (const c of chunks) totalLen += c.byteLength
    const result = new Uint8Array(totalLen)
    let offset = 0
    for (const c of chunks) { result.set(c, offset); offset += c.byteLength }
    return result.buffer
  } catch {
    // Not compressed or DecompressionStream unavailable
    return compressed
  }
}

function tileBoundsFromZXY(z: number, x: number, y: number) {
  const n = Math.pow(2, z)
  return {
    west: x / n * 360 - 180,
    south: Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI,
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

    const tb = tileBoundsFromZXY(z, x, y)
  return { z, x, y, tileWest: tb.west, tileSouth: tb.south, vertices, indices, lineVertices, lineIndices, featureCount: 0 }
  }

  // Decompress gzip'd compact layer
  const compressedBuf = new Uint8Array(buf, entry.dataOffset, entry.compactSize)
  let dataBuf: Uint8Array
  try {
    // Node/Bun: sync decompression
    dataBuf = new Uint8Array(gunzipSync(Buffer.from(compressedBuf)))
  } catch {
    // Browser or uncompressed: use raw data
    dataBuf = compressedBuf
  }
  let pos = 0

  function readSection(): Uint8Array {
    const len = new DataView(dataBuf.buffer, dataBuf.byteOffset + pos, 4).getUint32(0, true)
    pos += 4
    const section = dataBuf.slice(pos, pos + len)
    pos += len
    return section
  }

  // v1 ring-based format: [ringData][lineCoords][lineIndices][lineFeatIds]
  const ringDataBuf = readSection()
  const lineCoordsBuf = readSection()
  const lineIndicesBuf = readSection()
  const lineFeatIdsBuf = readSection()

  const precision = precisionForZoom(z)

  // Decode polygon rings and tessellate with earcut
  const polygons = decodeRingData(ringDataBuf, precision)
  const polyVerts: number[] = []
  const polyIdx: number[] = []
  const tb = tileBoundsFromZXY(z, x, y)

  for (const poly of polygons) {
    const baseVertex = polyVerts.length / 3
    const flatCoords: number[] = []
    const holeIndices: number[] = []

    for (let r = 0; r < poly.rings.length; r++) {
      if (r > 0) holeIndices.push(flatCoords.length / 2)
      for (const coord of poly.rings[r]) {
        flatCoords.push(coord[0], coord[1])
      }
    }

    const earcutIdx = earcut(flatCoords, holeIndices.length > 0 ? holeIndices : undefined)
    for (let i = 0; i < flatCoords.length; i += 2) {
      polyVerts.push(flatCoords[i] - tb.west, flatCoords[i + 1] - tb.south, poly.featId)
    }
    for (const idx of earcutIdx) {
      polyIdx.push(baseVertex + idx)
    }
  }

  const vertices = new Float32Array(polyVerts)
  const indices = new Uint32Array(polyIdx)

  // Decode line data
  const lineCoords = decodeCoords(lineCoordsBuf, precision)
  const lineFeatIds = decodeFeatIds(lineFeatIdsBuf)
  const lineVertices = new Float32Array(lineCoords.length / 2 * 3)
  for (let i = 0; i < lineCoords.length; i += 2) {
    const vi = (i / 2) * 3
    lineVertices[vi] = lineCoords[i]
    lineVertices[vi + 1] = lineCoords[i + 1]
    lineVertices[vi + 2] = lineFeatIds[i / 2] ?? 0
  }
  const lineIndices = decodeIndices(lineIndicesBuf)

  return {
    z, x, y, tileWest: tb.west, tileSouth: tb.south,
    vertices, indices, lineVertices, lineIndices,
    featureCount: polygons.length,
    polygons, // preserve for runtime sub-tiling
  }
}

// ═══ Property Table Serialization ═══

function serializePropertyTable(table: PropertyTable): ArrayBuffer {
  const textEncoder = new TextEncoder()

  // Pre-encode strings and build string pool
  const stringPool: string[] = []
  const stringIndex = new Map<string, number>()

  function internString(s: string): number {
    let idx = stringIndex.get(s)
    if (idx !== undefined) return idx
    idx = stringPool.length
    stringPool.push(s)
    stringIndex.set(s, idx)
    return idx
  }

  // Intern field names
  for (const name of table.fieldNames) internString(name)

  // Intern string values
  for (const row of table.values) {
    for (let fi = 0; fi < table.fieldTypes.length; fi++) {
      if (table.fieldTypes[fi] === 'string' && row[fi] !== null && typeof row[fi] === 'string') {
        internString(row[fi] as string)
      }
    }
  }

  // Calculate size
  let size = 4 + 2 // featureCount(u32) + fieldCount(u16)

  // Field names: u16 length + bytes each
  for (const name of table.fieldNames) {
    size += 2 + textEncoder.encode(name).byteLength
  }

  // Field types: 1 byte each
  size += table.fieldTypes.length

  // String pool: u32 count + (u16 len + bytes) each
  size += 4
  for (const s of stringPool) {
    size += 2 + textEncoder.encode(s).byteLength
  }

  // Values: per feature, per field
  for (let fi = 0; fi < table.fieldTypes.length; fi++) {
    const type = table.fieldTypes[fi]
    if (type === 'f64') size += table.values.length * 8
    else if (type === 'string') size += table.values.length * 4 // u32 index
    else if (type === 'bool') size += table.values.length * 1
  }

  const buf = new ArrayBuffer(size)
  const view = new DataView(buf)
  const u8 = new Uint8Array(buf)
  let pos = 0

  // Header
  view.setUint32(pos, table.values.length, true); pos += 4
  view.setUint16(pos, table.fieldNames.length, true); pos += 2

  // Field names
  for (const name of table.fieldNames) {
    const encoded = textEncoder.encode(name)
    view.setUint16(pos, encoded.byteLength, true); pos += 2
    u8.set(encoded, pos); pos += encoded.byteLength
  }

  // Field types (0=f64, 1=string, 2=bool)
  for (const type of table.fieldTypes) {
    view.setUint8(pos, type === 'f64' ? 0 : type === 'string' ? 1 : 2); pos += 1
  }

  // String pool
  view.setUint32(pos, stringPool.length, true); pos += 4
  for (const s of stringPool) {
    const encoded = textEncoder.encode(s)
    view.setUint16(pos, encoded.byteLength, true); pos += 2
    u8.set(encoded, pos); pos += encoded.byteLength
  }

  // Values: column-major (all values for field 0, then field 1, ...)
  for (let fi = 0; fi < table.fieldTypes.length; fi++) {
    const type = table.fieldTypes[fi]
    for (const row of table.values) {
      const val = row[fi]
      if (type === 'f64') {
        view.setFloat64(pos, typeof val === 'number' ? val : 0, true); pos += 8
      } else if (type === 'string') {
        const idx = (val !== null && typeof val === 'string') ? stringIndex.get(val) ?? 0xFFFFFFFF : 0xFFFFFFFF
        view.setUint32(pos, idx, true); pos += 4
      } else if (type === 'bool') {
        view.setUint8(pos, val === null ? 0xFF : val ? 1 : 0); pos += 1
      }
    }
  }

  return buf
}

/** Parse a PropertyTable from a buffer section */
export function parsePropertyTable(buf: ArrayBuffer): PropertyTable {
  const view = new DataView(buf)
  const u8 = new Uint8Array(buf)
  const textDecoder = new TextDecoder()
  let pos = 0

  const featureCount = view.getUint32(pos, true); pos += 4
  const fieldCount = view.getUint16(pos, true); pos += 2

  // Field names
  const fieldNames: string[] = []
  for (let i = 0; i < fieldCount; i++) {
    const len = view.getUint16(pos, true); pos += 2
    fieldNames.push(textDecoder.decode(u8.slice(pos, pos + len))); pos += len
  }

  // Field types
  const fieldTypes: PropertyFieldType[] = []
  for (let i = 0; i < fieldCount; i++) {
    const t = view.getUint8(pos); pos += 1
    fieldTypes.push(t === 0 ? 'f64' : t === 1 ? 'string' : 'bool')
  }

  // String pool
  const stringPoolSize = view.getUint32(pos, true); pos += 4
  const stringPool: string[] = []
  for (let i = 0; i < stringPoolSize; i++) {
    const len = view.getUint16(pos, true); pos += 2
    stringPool.push(textDecoder.decode(u8.slice(pos, pos + len))); pos += len
  }

  // Values (column-major)
  const values: (number | string | boolean | null)[][] = Array.from({ length: featureCount }, () => new Array(fieldCount).fill(null))

  for (let fi = 0; fi < fieldCount; fi++) {
    const type = fieldTypes[fi]
    for (let ri = 0; ri < featureCount; ri++) {
      if (type === 'f64') {
        values[ri][fi] = view.getFloat64(pos, true); pos += 8
      } else if (type === 'string') {
        const idx = view.getUint32(pos, true); pos += 4
        values[ri][fi] = idx === 0xFFFFFFFF ? null : stringPool[idx]
      } else if (type === 'bool') {
        const v = view.getUint8(pos); pos += 1
        values[ri][fi] = v === 0xFF ? null : v === 1
      }
    }
  }

  return { fieldNames, fieldTypes, values }
}
