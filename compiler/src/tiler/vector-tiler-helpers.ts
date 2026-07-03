// ═══ Vector Tiler: pure tile-key helpers ═══
// Side-effect-free Morton-code (Z-order curve) + tile-key bit-twiddling
// extracted from vector-tiler.ts. None close over module state. Kept here
// so vector-tiler.ts stays focused on the tiling pipeline. Public functions
// are re-exported from vector-tiler.ts to keep the module surface unchanged.

// ═══ Morton Code (Z-Order Curve) Tile Key ═══
//
// Tile keys pack (z, x, y) into one f64-safe integer:
//   key = 4^z + mortonEncode(x, y)
//
// For z ≤ 15 the key fits in 32 bits and the bit-twiddling hacks
// (spreadBits/compactBits) produce identical values to the loop form.
// For z > 15 (DSFUN unlocked camera zooms 16–22) we need f64 arithmetic
// because `1 << 32` overflows JavaScript's 32-bit shift semantics and
// spreadBits truncates inputs to 16 bits.
//
// Max supported zoom = 22. At z=22, x and y reach 2^22, morton reaches
// 2^44, and the key plus z-prefix stays well below 2^53 (JS integer limit).

const MAX_TILE_ZOOM = 22

/** Spread the 22 low bits of `v` into even positions of a 44-bit result.
 *  Hot path — Math.pow inside the loop dominated CPU profile (5 % of
 *  total frame time on Bright). Accumulate the power-of-4 instead. */
function spreadBits22(v: number): number {
  let result = 0
  let pow = 1 // 4^0
  for (let i = 0; i < MAX_TILE_ZOOM; i++) {
    if ((v & (1 << i)) !== 0) result += pow
    pow *= 4
  }
  return result
}

/** Collect bits at positions `startBit`, `startBit+2`, `startBit+4`, … back into a packed integer.
 *  Hot path — `Math.pow + Math.floor + % 2` per iteration burned 17 % of
 *  total CPU time on Bright (748 ms / 4 s). Accumulate the divisor and
 *  use `& 1` for the bit test (works for f64 ints up to 2^32 — when the
 *  divided morton/pow sits in safe int range, integer-cast bit-and is
 *  identical to `% 2`). */
function collectBits22(morton: number, startBit: number): number {
  let result = 0
  // pow = 2^startBit, then ×4 per iteration (skip every other bit).
  let pow = startBit === 0 ? 1 : 2
  for (let i = 0; i < MAX_TILE_ZOOM; i++) {
    // Math.floor(morton / pow) is the high-bits-shifted-down view; the
    // low bit of THAT is the bit at position (2*i + startBit) in morton.
    // Fast path: when (morton / pow) < 2^31, the | 0 cast preserves the
    // bottom bit. When morton ≥ 2^32 (z > 15), fall back to the slower
    // arithmetic form.
    if (pow <= 0x80000000) {
      if (((morton / pow) | 0) & 1) result |= 1 << i
    } else {
      if (Math.floor(morton / pow) % 2 === 1) result |= 1 << i
    }
    pow *= 4
  }
  return result
}

export function mortonEncode(x: number, y: number): number {
  return spreadBits22(x) + 2 * spreadBits22(y)
}

export function mortonDecode(morton: number): [number, number] {
  return [collectBits22(morton, 0), collectBits22(morton, 1)]
}

export function tileKey(z: number, x: number, y: number): number {
  return Math.pow(4, z) + mortonEncode(x, y)
}

export function tileKeyUnpack(key: number): [number, number, number] {
  // Find the largest z such that 4^z ≤ key.
  let z = 0
  let acc = 1 // 4^0
  while (acc * 4 <= key) {
    acc *= 4
    z++
  }
  const morton = key - acc
  const [x, y] = mortonDecode(morton)
  return [z, x, y]
}

export function tileKeyParent(key: number): number {
  // Direct identity: key = 4^z + morton(x, y). Parent at z-1 is
  // 4^(z-1) + morton(x>>1, y>>1). Since morton(x>>1, y>>1) === morton(x, y) >> 2
  // (each interleaved bit-pair encodes one level), and 4^(z-1) = 4^z / 4,
  //   parent = 4^z / 4 + (key - 4^z) / 4 = key / 4.
  // Avoids the O(z) `while (acc * 4 <= key)` loop in `tileKeyUnpack` +
  // the morton encode in `tileKey`, both of which dominated the CPU
  // profile on 80-layer styles (Bright at z=14: tileKeyParent took
  // 12.6 % of total frame time; tileKeyUnpack another 4.5 %, much of
  // it called from this function).
  // Math.floor (not `>>> 2`) because tileKeys span up to ~2^45 at z=22,
  // exceeding the Int32 range that bitshift operates on.
  return Math.floor(key / 4)
}

export function tileKeyChildren(key: number): [number, number, number, number] {
  const [z, x, y] = tileKeyUnpack(key)
  const cz = z + 1
  const cx = x * 2
  const cy = y * 2
  return [
    tileKey(cz, cx, cy),
    tileKey(cz, cx + 1, cy),
    tileKey(cz, cx, cy + 1),
    tileKey(cz, cx + 1, cy + 1),
  ]
}
