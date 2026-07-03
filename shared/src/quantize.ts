// Vertex-position quantization shared by the two ground-tile packers:
// the compiler tiler (`compiler/src/tiler/vector-tiler.ts`) and the runtime
// synthetic-earth backend (`runtime/src/data/sources/synthetic-earth-surface-backend.ts`).
// Those two paths MUST quantize bit-for-bit identically — their ECEF tile
// anchors are documented as "bit-for-bit equal" so the RTC origins cancel
// with no residual; a divergence here is a silent CPU-side vertex-drift bug.
// Keeping ONE definition (S19) is the structural guard against that drift.
// Pure integer math, no dependencies (this package stays DEPENDENCY-FREE).

/** Quantize one absolute axis value into a double-u16 `[hi, lo]` pair for the
 *  packed ECEF vertex layout. `halfRange` is the exact max-abs over the tile's
 *  verts (+epsilon) and `invSpan` maps [-halfRange, +halfRange] onto the u32
 *  range, split into two u16 lanes. */
export function quantizeAxis(axis: number, halfRange: number, invSpan: number): [number, number] {
  let q = Math.round((axis + halfRange) * invSpan)
  // Clamp into [0, 0xFFFFFFFF] — by construction (halfRange = exact max-abs
  // over the tile's verts + epsilon) no axis exceeds the range, but rounding
  // at the extreme could land at 0x1_0000_0000; clamp defends the cast.
  if (q < 0) q = 0
  else if (q > 0xffffffff) q = 0xffffffff
  return [(q >>> 16) & 0xffff, q & 0xffff]
}
