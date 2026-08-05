// ═══ Two-finger gesture geometry + decisions — pure, GPU-free, event-free ═══
//
// Extracted from controller.ts (#1566) to pay for the rotate dead-zone under the
// 800-LOC ceiling, not to change any behaviour: every function below is byte-
// identical to its previous form except `rotateGestureDecision`, which is new.
// `controller.ts` re-exports the two decision functions so existing import paths
// (`controller-pitch-gesture.test.ts`) keep working.

export function getPinchDistance(pointers: Map<number, { x: number; y: number }>): number {
  const pts = [...pointers.values()]
  if (pts.length < 2) return 0
  const dx = pts[1].x - pts[0].x
  const dy = pts[1].y - pts[0].y
  return Math.sqrt(dx * dx + dy * dy)
}

export function getPinchAngle(pointers: Map<number, { x: number; y: number }>): number {
  const pts = [...pointers.values()]
  if (pts.length < 2) return 0
  return (Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) * 180) / Math.PI
}

export function getPinchCenter(pointers: Map<number, { x: number; y: number }>): {
  x: number
  y: number
} {
  const pts = [...pointers.values()]
  if (pts.length < 2) return pts[0] ?? { x: 0, y: 0 }
  return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
}

/** Two-finger pitch-vs-pinch disambiguation WITH HYSTERESIS. A parallel vertical
 *  drag (vertical centre movement dominating the finger-distance change) tilts
 *  the camera. Entry is STRICT (centreMove must dominate distChange 2×) so a
 *  pinch-zoom never accidentally tilts; but once engaged the test RELAXES
 *  (centreMove need only exceed distChange) so incidental finger-distance wobble
 *  — worse when LOWERING pitch, where the fingers tend to converge — no longer
 *  stutters a sustained tilt back into pinch-zoom every noisy frame (the "pitch
 *  won't go down" feel). A clear pinch (distChange dominating) disengages.
 *  Pure so the hysteresis is unit-testable without simulating touch events. */
export function pitchGestureDecision(
  centreMove: number,
  distChange: number,
  engaged: boolean,
): { apply: boolean; engaged: boolean } {
  const applies = engaged
    ? centreMove > 1 && centreMove > distChange // relaxed: stay engaged through wobble
    : centreMove > 2 && centreMove > distChange * 2 // strict: don't hijack a pinch
  return { apply: applies, engaged: applies }
}

/** Degrees of accumulated pair-angle change a two-finger gesture must cover
 *  before it counts as a deliberate rotation. Fingers are never steady, so a
 *  plain pinch-zoom wanders a couple of degrees over its life; below this the
 *  gesture is a zoom that happens to wobble, not a twist. */
const ROTATE_ENTER_DEG = 8

/** Two-finger rotate dead-zone WITH HYSTERESIS — the rotation counterpart of
 *  `pitchGestureDecision`, and deliberately the same shape rather than a second
 *  pattern (#1566). Before this, ANY nonzero pair-angle delta was applied to the
 *  bearing immediately, so 2-3° of ordinary finger jitter during a pinch-zoom
 *  spun the map — and it stayed spun, because the 15° release snap only runs for
 *  the explicit right-click rotate gesture.
 *
 *  Entry is STRICT: the gesture must ACCUMULATE `ROTATE_ENTER_DEG` of pair-angle
 *  change (signed, so a wobble that goes 3° one way and 3° back nets ~0 and never
 *  engages). Once engaged it stays engaged for the rest of the gesture — unlike
 *  pitch, rotation has no competing interpretation to fall back to, and a
 *  deliberate twist that pauses mid-way must not need re-crossing the threshold.
 *  The accumulated dead-zone is absorbed, not replayed, so engaging does not jump
 *  the map by 8°.
 *
 *  Pure so the threshold is unit-testable without simulating touch events. */
export function rotateGestureDecision(
  accumulatedDeg: number,
  engaged: boolean,
): { apply: boolean; engaged: boolean } {
  const applies = engaged || Math.abs(accumulatedDeg) > ROTATE_ENTER_DEG
  return { apply: applies, engaged: applies }
}
