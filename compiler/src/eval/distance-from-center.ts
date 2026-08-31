// ═══ ["distance-from-center"] — the units, written down (#2119) ═══
//
// Mapbox `["distance-from-center"]` returns the feature anchor's distance
// from the viewport centre, in units of the viewport's HALF-DIAGONAL:
// 0 at dead centre, ~1 at the edge, >1 once the anchor is off-screen. This
// module is the ONE place that arithmetic is written down — reserved-
// keys.ts's DISTANCE_FROM_CENTER_KEY only carries the already-computed
// number, exactly as CAMERA_ZOOM_KEY / CAMERA_PITCH_KEY do for their values.
//
// UNITS — SCREEN PIXELS in, a DIMENSIONLESS ratio out. `anchorX/Y` and
// `viewportWidth/Height` must already share one pixel space (post-
// projection, post-DPR — whichever grid the caller rasterizes into; this
// function never looks past its four numbers, so it does not care WHICH
// grid, only that all four agree). Pixels cancel in the division, so the
// result carries no unit of its own — never degrees, never metres, never
// tile/EXTENT units.
//
// THE DENOMINATOR IS THE HALF-DIAGONAL — sqrt((w/2)² + (h/2)²) — never
// half-width and never half-height alone. Half-diagonal is the only
// normalizer under which the ratio is well-behaved across BOTH axes of a
// non-square viewport at once:
//   - half-diagonal: EVERY corner reads exactly 1, regardless of aspect
//     ratio (the anchor-to-centre offset AT a corner, by construction, IS
//     the half-diagonal). Edge midpoints read <1, closer to 1 the nearer
//     the viewport is to square.
//   - half-height alone: a WIDE viewport's left/right edge midpoints read
//     ≫1 (correctly off-screen symbols would read as "in view") while the
//     top/bottom edges read exactly 1.
//   - half-width alone: the mirrored bug on a TALL viewport.
// A square dev-server window can't tell these three formulas apart — they
// only diverge once width ≠ height, which is why #2119 calls this "the
// trap": a half-height (or half-width) slip ships silently and only fades
// the wrong ring of symbols the first time the style runs on a real
// (non-square) screen. See distance-from-center.test.ts for the witness
// that pins the divergence with actual numbers.
//
// ANCHOR NOT WELL-DEFINED — deliberately out of THIS function's scope.
// A line-placed label's anchor moves continuously along the line (no
// single point); a non-point feature's "anchor" is a per-feature,
// per-geometry runtime fact this compiler package does not resolve
// (mirrors how $geometryType itself is resolved per-feature at eval time,
// never statically). Both are the caller's decision: pass a resolved
// anchor, or leave `distanceFromCenter` absent from makeEvalProps() and
// `["distance-from-center"]` reads null, same as any other unset reserved
// key. The symbol-placement:line case additionally gets a precise
// CONVERT-TIME warning — see layers-helpers.ts
// distanceFromCenterAnchorWarning.

/**
 * `["distance-from-center"]` (#2119): the feature anchor's distance from
 * the viewport centre, normalized to the viewport's half-diagonal.
 *
 * @param anchorX Feature anchor X, in the same pixel space as `viewportWidth`.
 * @param anchorY Feature anchor Y, in the same pixel space as `viewportHeight`.
 * @param viewportWidth Viewport width in that pixel space. Must be > 0.
 * @param viewportHeight Viewport height in that pixel space. Must be > 0.
 * @returns 0 at dead centre, 1.0 at any of the four corners, <1 at edge
 *   midpoints (aspect-ratio dependent — see the module doc above), growing
 *   unboundedly past 1 once the anchor is off-screen. `null` for any
 *   non-finite input or a degenerate (≤0) viewport dimension — there is no
 *   meaningful distance from an undefined viewport.
 */
export function distanceFromCenterRatio(
  anchorX: number,
  anchorY: number,
  viewportWidth: number,
  viewportHeight: number,
): number | null {
  if (
    !Number.isFinite(anchorX) ||
    !Number.isFinite(anchorY) ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return null
  }
  const halfW = viewportWidth / 2
  const halfH = viewportHeight / 2
  const halfDiagonal = Math.hypot(halfW, halfH)
  return Math.hypot(anchorX - halfW, anchorY - halfH) / halfDiagonal
}
