// ═══ #2501 — globe limb containment for a label's screen box ═══
//
// The #1042 gate keeps a label's ANCHOR ≥ LABEL_LIMB_INSET_PX inside the
// projected globe silhouette (render-loop-helpers.ts) — a vertical half-extent.
// The quad also extends ±width/2 horizontally, and at whole-earth zoom the disc
// is ~150 CSS px across while names run 20–170 px, so a label anchored near the
// left/right limb drew its text into space (measured: Montevideo 23 px,
// Buenos Aires 59 px past the limb at globe z0). The box's half-WIDTH was never
// tested — text-stage's cull compared the centre inset against the half-HEIGHT.
//
// A box is inside a convex region iff its four corners are, so the test is the
// corner insets against the same signed-distance query the anchor gate uses —
// one silhouette authority, no second constant beyond the 2 px rasterization
// slack the old half-height test already carried.

/** Signed screen-px distance INSIDE the projected globe silhouette (positive
 *  inside; +Infinity when there is no silhouette) — `limbInsetPx` from
 *  makeLabelProjectors. */
export type LimbInset = (x: number, y: number) => number

/** Rasterization slack (px) a corner may sit inside the limb: the same 2 px the
 *  pre-#2501 half-height test allowed, so a box that touches the limb is culled
 *  before its anti-aliased edge reaches space. */
export const LIMB_CORNER_SLACK_PX = 2

/** True when any corner of the screen box `b` sits less than
 *  LIMB_CORNER_SLACK_PX inside the globe silhouette — i.e. the label's quad would
 *  draw past the limb. Off the globe (`limbInset` ≡ +Infinity) never culls. */
export function limbCullsBox(
  limbInset: LimbInset,
  b: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
  const m = LIMB_CORNER_SLACK_PX
  return (
    limbInset(b.minX, b.minY) < m ||
    limbInset(b.maxX, b.minY) < m ||
    limbInset(b.minX, b.maxY) < m ||
    limbInset(b.maxX, b.maxY) < m
  )
}
