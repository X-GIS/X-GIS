// ═══ ZigZag Delta Varint Encoding ═══
// Compact coordinate encoding for vector tile storage.
// Coordinates are delta-encoded, zigzag-mapped, then varint-packed.
//
// Example: [127.0, 37.5, 127.1, 37.6] (degrees)
//   → quantize (×1e6): [127000000, 37500000, 127100000, 37600000]
//   → delta:           [127000000, 37500000, 100000, 100000]
//   → zigzag:          [254000000, 75000000, 200000, 200000]
//   → varint:          variable-length bytes (small deltas = fewer bytes)

const PRECISION = 1e6 // default: 6 decimal places ≈ ~0.1m accuracy

/** Zoom-adaptive precision: lower zooms don't need sub-meter accuracy.
 *  Scale factor for LON/LAT-space snapping: coord is quantized to
 *  `round(coord * precision) / precision`. Returned value is in
 *  degrees⁻¹ (e.g. 1e6 ⇒ ~0.1m at the equator). */
export function precisionForZoom(zoom: number): number {
  if (zoom <= 2) return 1e3   // ~100m (world/continent scale)
  if (zoom <= 5) return 1e4   // ~10m  (country scale)
  if (zoom <= 7) return 1e5   // ~1m   (city scale)
  return 1e6                   // ~0.1m (street scale)
}

/** Zoom-adaptive precision in MERCATOR meters⁻¹ — same GRAIN as
 *  `precisionForZoom` but applied to meter-space coordinates.
 *  Used for clipping / simplification in MM after polygons are
 *  projected up-front (industry-standard pipeline — matches Mapbox
 *  GL / MapLibre / Tippecanoe). */
export function precisionForZoomMM(zoom: number): number {
  if (zoom <= 2) return 0.01  // ~100m
  if (zoom <= 5) return 0.1   // ~10m
  if (zoom <= 7) return 1     // ~1m
  return 10                    // ~0.1m
}

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
export function encodeCoords(coords: number[], precision = PRECISION): Uint8Array {
  const bytes: number[] = []

  encodeVarint(coords.length / 2, bytes)

  let prevLon = 0
  let prevLat = 0

  for (let i = 0; i < coords.length; i += 2) {
    const lon = Math.round(coords[i] * precision)
    const lat = Math.round(coords[i + 1] * precision)

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
export function decodeCoords(buf: Uint8Array, precision = PRECISION): Float32Array {
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

    coords[i * 2] = prevLon / precision
    coords[i * 2 + 1] = prevLat / precision
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

// ═══ Ring Data: Polygon structure + coordinates ═══

export interface RingPolygon {
  rings: number[][][]  // [[x,y], ...] per ring (outer + holes)
  featId: number
}

/**
 * Encode polygon ring data: structure metadata + delta-zigzag-varint coordinates.
 * Format: [polyCount] then per polygon: [featId, ringCount, ...rings]
 * Each ring: [vertexCount, delta-encoded x,y pairs]
 */
export function encodeRingData(polygons: RingPolygon[], precision = PRECISION): Uint8Array {
  const bytes: number[] = []
  encodeVarint(polygons.length, bytes)

  for (const poly of polygons) {
    encodeVarint(poly.featId, bytes)
    encodeVarint(poly.rings.length, bytes)

    for (const ring of poly.rings) {
      encodeVarint(ring.length, bytes)
      let prevX = 0, prevY = 0
      for (const coord of ring) {
        const qx = Math.round(coord[0] * precision)
        const qy = Math.round(coord[1] * precision)
        encodeVarint(zigzagEncode(qx - prevX), bytes)
        encodeVarint(zigzagEncode(qy - prevY), bytes)
        prevX = qx
        prevY = qy
      }
    }
  }

  return new Uint8Array(bytes)
}

/**
 * Decode polygon ring data back to RingPolygon array.
 */
export function decodeRingData(buf: Uint8Array, precision = PRECISION): RingPolygon[] {
  let offset = 0

  const [polyCount, pcBytes] = decodeVarint(buf, offset); offset += pcBytes
  const polygons: RingPolygon[] = []

  for (let p = 0; p < polyCount; p++) {
    const [featId, fidBytes] = decodeVarint(buf, offset); offset += fidBytes
    const [ringCount, rcBytes] = decodeVarint(buf, offset); offset += rcBytes
    const rings: number[][][] = []

    for (let r = 0; r < ringCount; r++) {
      const [vertCount, vcBytes] = decodeVarint(buf, offset); offset += vcBytes
      const ring: number[][] = []
      let prevX = 0, prevY = 0

      for (let v = 0; v < vertCount; v++) {
        const [zx, xBytes] = decodeVarint(buf, offset); offset += xBytes
        const [zy, yBytes] = decodeVarint(buf, offset); offset += yBytes
        prevX += zigzagDecode(zx)
        prevY += zigzagDecode(zy)
        ring.push([prevX / precision, prevY / precision])
      }

      rings.push(ring)
    }

    polygons.push({ rings, featId })
  }

  return polygons
}
