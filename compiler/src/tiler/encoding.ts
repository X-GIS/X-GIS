// ═══ ZigZag Delta Varint Encoding ═══
// Compact coordinate encoding for vector tile storage.
// Coordinates are delta-encoded, zigzag-mapped, then varint-packed.
//
// Example: [127.0, 37.5, 127.1, 37.6] (degrees)
//   → quantize (×1e6): [127000000, 37500000, 127100000, 37600000]
//   → delta:           [127000000, 37500000, 100000, 100000]
//   → zigzag:          [254000000, 75000000, 200000, 200000]
//   → varint:          variable-length bytes (small deltas = fewer bytes)

const PRECISION = 1e6 // 6 decimal places ≈ ~0.1m accuracy

// ═══ Varint ═══

/** Encode a non-negative integer as varint bytes */
export function encodeVarint(value: number, out: number[]): void {
  let v = value >>> 0 // ensure unsigned 32-bit
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v & 0x7f)
}

/** Decode a varint from a buffer. Returns [value, bytesRead] */
export function decodeVarint(buf: Uint8Array, offset: number): [number, number] {
  let result = 0
  let shift = 0
  let pos = offset
  while (pos < buf.length) {
    const byte = buf[pos++]
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return [result >>> 0, pos - offset]
}

// ═══ ZigZag ═══

/** ZigZag encode: maps signed → unsigned (0→0, -1→1, 1→2, -2→3, 2→4, ...) */
export function zigzagEncode(n: number): number {
  return (n << 1) ^ (n >> 31)
}

/** ZigZag decode: maps unsigned → signed */
export function zigzagDecode(n: number): number {
  return (n >>> 1) ^ -(n & 1)
}

// ═══ Delta + ZigZag + Varint: Coordinate Arrays ═══

/**
 * Encode a coordinate array (lon/lat pairs) to compact bytes.
 * Input: [lon0, lat0, lon1, lat1, ...] in degrees
 * Output: varint-encoded zigzag deltas
 */
export function encodeCoords(coords: number[]): Uint8Array {
  const bytes: number[] = []

  encodeVarint(coords.length / 2, bytes)

  let prevLon = 0
  let prevLat = 0

  for (let i = 0; i < coords.length; i += 2) {
    const lon = Math.round(coords[i] * PRECISION)
    const lat = Math.round(coords[i + 1] * PRECISION)

    const dLon = lon - prevLon
    const dLat = lat - prevLat

    encodeVarint(zigzagEncode(dLon), bytes)
    encodeVarint(zigzagEncode(dLat), bytes)

    prevLon = lon
    prevLat = lat
  }

  return new Uint8Array(bytes)
}

/**
 * Decode compact bytes back to coordinate array.
 * Output: [lon0, lat0, lon1, lat1, ...] in degrees
 */
export function decodeCoords(buf: Uint8Array): Float32Array {
  let offset = 0

  const [count, countBytes] = decodeVarint(buf, offset)
  offset += countBytes

  const coords = new Float32Array(count * 2)
  let prevLon = 0
  let prevLat = 0

  for (let i = 0; i < count; i++) {
    const [zLon, lonBytes] = decodeVarint(buf, offset)
    offset += lonBytes
    const [zLat, latBytes] = decodeVarint(buf, offset)
    offset += latBytes

    prevLon += zigzagDecode(zLon)
    prevLat += zigzagDecode(zLat)

    coords[i * 2] = prevLon / PRECISION
    coords[i * 2 + 1] = prevLat / PRECISION
  }

  return coords
}

/**
 * Encode a Uint32Array (indices) to compact varint bytes.
 * Uses delta encoding for sequential indices.
 */
export function encodeIndices(indices: Uint32Array): Uint8Array {
  const bytes: number[] = []
  encodeVarint(indices.length, bytes)

  let prev = 0
  for (let i = 0; i < indices.length; i++) {
    const delta = indices[i] - prev
    encodeVarint(zigzagEncode(delta), bytes)
    prev = indices[i]
  }

  return new Uint8Array(bytes)
}

/**
 * Decode compact varint bytes back to Uint32Array (indices).
 */
export function decodeIndices(buf: Uint8Array): Uint32Array {
  let offset = 0

  const [count, countBytes] = decodeVarint(buf, offset)
  offset += countBytes

  const indices = new Uint32Array(count)
  let prev = 0

  for (let i = 0; i < count; i++) {
    const [zDelta, deltaBytes] = decodeVarint(buf, offset)
    offset += deltaBytes
    prev += zigzagDecode(zDelta)
    indices[i] = prev
  }

  return indices
}

/**
 * Encode per-vertex feature IDs to compact varint bytes.
 * Uses delta encoding (feat_ids are often runs of the same value).
 */
export function encodeFeatIds(ids: number[]): Uint8Array {
  const bytes: number[] = []
  encodeVarint(ids.length, bytes)

  let prev = 0
  for (const id of ids) {
    encodeVarint(zigzagEncode(id - prev), bytes)
    prev = id
  }

  return new Uint8Array(bytes)
}

/**
 * Decode compact varint bytes back to feature ID array.
 */
export function decodeFeatIds(buf: Uint8Array): Float32Array {
  let offset = 0

  const [count, countBytes] = decodeVarint(buf, offset)
  offset += countBytes

  const ids = new Float32Array(count) // f32 to match vertex stride
  let prev = 0

  for (let i = 0; i < count; i++) {
    const [zDelta, deltaBytes] = decodeVarint(buf, offset)
    offset += deltaBytes
    prev += zigzagDecode(zDelta)
    ids[i] = prev
  }

  return ids
}
