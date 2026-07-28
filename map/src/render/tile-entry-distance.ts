// INC-1 of docs/plans/2026-07-27-line-label-world-anchored-placement.md — where
// along a line-label polyline that polyline first enters its OWN tile.
//
// MVT geometry carries a buffer, so a tile's polyline starts OUTSIDE the tile
// bounds (measured on OFM Positron tile 14/13962/6331: vertex 0 sits 0.000687°
// west of the west edge, the last vertex 0.000691° east of the east edge). That
// overhang is ~119 px at z16.7 — and 119 px is exactly the phase error between
// X-GIS's shield chain and MapLibre's.
//
// MapLibre anchors its line symbols from the tile-clipped line, so its chain sits
// at `tileEntry + k · spacing`. Measured across a zoom sweep, every one of its
// anchors satisfies `(s − tileEntry) mod step ≈ 0` to within ±1 px while the entry
// offset itself moves 73.8 → 137.6 px — the rule reproducing, not a fitted
// constant. This function supplies that origin.
//
// Pure and camera-independent: the answer depends only on the polyline and its
// tile, so the caller caches it next to the run.

/** Arc-length (same units as the input coordinates) from vertex 0 to the point at
 *  which the polyline first enters the axis-aligned tile rect.
 *
 *  Returns 0 when vertex 0 is already inside — the common case for a road that
 *  starts within its tile — and 0 as well when the polyline never enters, which
 *  cannot happen for geometry decoded FROM that tile but keeps the function total
 *  (the caller then walks from vertex 0, i.e. the pre-INC-1 behaviour).
 *
 *  The crossing is solved exactly with a slab (Liang–Barsky) clip rather than by
 *  testing whether a vertex landed inside: a single segment can span the whole
 *  tile — a long straight road with sparse vertices enters and exits between two
 *  consecutive points — and an endpoint test misses that entirely, silently
 *  reporting 0 and reintroducing the phase error it exists to remove. */
export function tileEntryDistance(
  xs: Float64Array | readonly number[],
  ys: Float64Array | readonly number[],
  n: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number {
  if (n < 1) return 0
  if (xs[0]! >= minX && xs[0]! <= maxX && ys[0]! >= minY && ys[0]! <= maxY) return 0
  let acc = 0
  for (let i = 0; i < n - 1; i++) {
    const ax = xs[i]!,
      ay = ys[i]!
    const dx = xs[i + 1]! - ax,
      dy = ys[i + 1]! - ay
    // Slab clip of the segment against the rect: the parameter window [t0, t1]
    // over which it is inside. Non-empty ⇒ it enters at t0.
    let t0 = 0
    let t1 = 1
    let hit = true
    for (const [d, p, lo, hi] of [
      [dx, ax, minX, maxX],
      [dy, ay, minY, maxY],
    ] as const) {
      if (d === 0) {
        // Parallel to this slab: inside it for the whole segment, or never.
        if (p < lo || p > hi) {
          hit = false
          break
        }
        continue
      }
      const ta = (lo - p) / d
      const tb = (hi - p) / d
      const near = d > 0 ? ta : tb
      const far = d > 0 ? tb : ta
      if (near > t0) t0 = near
      if (far < t1) t1 = far
      if (t0 > t1) {
        hit = false
        break
      }
    }
    const segLen = Math.hypot(dx, dy)
    if (hit) return acc + segLen * t0
    acc += segLen
  }
  return 0
}
