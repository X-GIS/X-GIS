// #2309 — the per-draw dedup key for `FrameDrawStats`.
//
// The dedup identity is the TRIPLE (tileKey, worldOff, visibleKey). It used to
// be flattened into `number | string`:
//
//     visibleKey >= 0 ? `${key}:${worldOff}:${visibleKey}`
//                     : worldOff === 0 ? key : key + worldOff * 1000000
//
// which built a template literal — three number→string conversions plus a
// concatenation — on the fallback-clip path, and left the Map's key type
// polymorphic for every lookup including the numeric ones. Measured on OFM
// Bright z14.7: 99.2% of `markDrawn` calls (1282 of 1292) keyed the map with a
// string, 28.7% of probes did, at 0.21 + 0.10 ms/frame.
//
// WHY NOT ONE NUMBER. The obvious fix -- pack the triple into a single f64-safe
// integer -- does not fit, and the shortfall is not marginal. `key` and
// `visibleKey` are both tile keys, `4^z + morton(x,y)`; at `maxSubTileZ = 22`
// one reaches ~7.04e13, so `MAX_SAFE` (9.007e15) leaves ~7 spare bits above a
// single key while the other components need more than that. Measured on a
// z~14 scene the product of the two observed keys is already 1.565e17, 17x over.
// A pack that fits at z14 and silently collides at z20 is exactly the latent
// trap this repo's ledger is full of, so the key stays two-level.
//
// WHAT THE SUB-KEY IS. The outer map is keyed by `tileKey` alone; this is the
// inner key, and it must be injective over (worldOff, visibleKey) for one tile.
// `worldOff` is NOT a small index: `_worldOffScratchKey` hands over
// `worldOffDeg * 1000`, and a whole-world copy is +/-360 degrees, so the values
// are multiples of 360000. Dividing by that recovers the copy index, which is
// what fits in a few bits -- packing the raw six-digit value would overflow.

/** World-copy step in `_worldOffScratchKey` units: 360 degrees x 1e3. */
const WORLD_COPY_STEP = 360_000
/** Copy indices are biased into a non-negative range before packing. A viewport
 *  can only show a handful of world copies; 16 each way is far past that, and
 *  the bias is asserted rather than assumed (see `packDrawSubKey`). */
const COPY_BIAS = 16
/** One tile key's span, as a power of two above `4^23` (z=22's exclusive end,
 *  `maxSubTileZ`). `visibleKey + 1` is stored, so 0 can mean "no visible key". */
const VISIBLE_STRIDE = 2 ** 47

/** Pack `(worldOff, visibleKey)` into one non-negative f64-safe integer.
 *
 *  Range: `(2 * COPY_BIAS) * 2^47 + 2^47` = 2.3e15 < `MAX_SAFE` 9.007e15, at any
 *  zoom -- no assumption about how deep the fallback descends or how the visible
 *  key relates to the tile key. */
export function packDrawSubKey(worldOff: number, visibleKey: number): number {
  const copy = Math.round(worldOff / WORLD_COPY_STEP)
  if ((globalThis as { __XGIS_INVARIANTS?: boolean }).__XGIS_INVARIANTS) {
    // The two premises this pack rests on, checked rather than assumed. The
    // whole-copy one is evidenced at raster-renderer.ts:696 (`ox = x + wc <<
    // z`) feeding tile-selection-cache.ts:1014 (`(ox - x) * (360 / tileN)`),
    // which is `wc * 360` exactly; if a non-copy offset ever reaches here the
    // rounding above would fold two distinct draws onto one key, and the
    // symptom would be a silently skipped tile -- the Korea fill-drop failure
    // mode (2026-05-10) this dedup key exists to prevent.
    if (copy * WORLD_COPY_STEP !== worldOff) {
      console.warn(`[XGIS] drawKey: worldOff ${worldOff} is not a whole world copy`)
    }
    if (copy < -COPY_BIAS || copy > COPY_BIAS) {
      console.warn(`[XGIS] drawKey: world-copy index ${copy} exceeds the +/-${COPY_BIAS} bias`)
    }
  }
  return (copy + COPY_BIAS) * VISIBLE_STRIDE + (visibleKey >= 0 ? visibleKey + 1 : 0)
}
