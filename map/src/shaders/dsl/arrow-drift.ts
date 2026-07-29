// ═══ How far an S-111 arrow drifts, and where it is in its life (#1520) ═══
//
// THE LEASH and THE PHASE, in one place because they are two halves of one rule: an arrow is
// `(origin, phase)`, it travels the leash over one phase cycle, and it is back at its origin when
// the phase wraps.
//
// WHY THIS REPLACED A STATE TEXTURE. The drifted position used to be accumulated every frame into
// a texel — one texel per arrow, paired 1:1 with the instance index. That pairing WAS the
// portrayal's ceiling: the state texture's size bounded the arrow count (100 000, shared across
// every resident mosaic region — #1513), the origin key existed because a changed instance COUNT
// re-seeded the texture and snapped every arrow home, and view-driven density therefore had to be
// a cull that never changes the count. None of that is about the data or the catalogue; all of it
// is about holding a position per arrow.
//
// A phase holds no position. `drift(origin, phase)` is a pure function, so there is no state to
// size, no identity to preserve, and the instance count becomes a per-frame decision — which is
// what lets density follow the VIEW rather than the grid. IBFV has had this property all along
// (its "instances" are fragments, so there is nothing discrete to recycle); this gives it to the
// catalogue glyph without giving up the glyph.
//
// Three things fall out that the stateful version could not have:
//
//   • A FADE. The old path held a position and had no notion of how far through its life an
//     arrow was, so a recycle was an instant jump — and #1333 rejected moving glyphs for exactly
//     that reason ("a respawn forces a fade, and a fade on a large symbol IS a blink"). A phase
//     is that notion, so the wrap can be faded and the argument dissolves.
//   • DETERMINISM. The field is a pure function of the clock, so a render gate needs no settling
//     and no pumped convergence — pin the clock and the frame is reproducible.
//   • Frame 0 IS the catalogue placement, for every arrow, at phase 0 — without seeding it from
//     anywhere.

import { fn, f32, fract, min, vec3, vec2fT, f32T } from '@xgis/shader-dsl'

/** THE LEASH — how far, in grid-uv, an arrow travels from its own origin over one phase cycle.
 *
 *  5% of the grid span is ~30 cells on a 596×433 CBOFS grid: unmistakably motion, still local
 *  enough for the VS's two-basis linearization to hold over the whole excursion. That bound is
 *  why a short fixed-tap integration can replace a per-frame accumulation at all — the path an
 *  arrow is ever allowed to take is short.
 *
 *  ONE number, two consumers: the generator packs each instance's basis anchors at exactly this
 *  distance, and the VS divides its drift by it. */
export const ARROW_DRIFT_UV = 0.05

/** Seconds for one phase cycle: origin → leash → origin. A DISPLAY control, like the rate it
 *  replaces — the catalogue says nothing about animation, and speed is read from the band colour
 *  and the glyph scale, never from how fast a symbol moves. What the period buys is legibility:
 *  long enough that a glyph reads as drifting rather than twitching.
 *
 *  Note what is NOT claimed: that this is real time. It is not, and it should not be — at true
 *  rate a 0.5 kn current moves a glyph ~4 mm per frame. Relative speed is still exact, because
 *  the drift integrates the actual normalized velocity: twice the current still travels twice as
 *  far within one cycle. */
export const ARROW_PHASE_SECONDS = 8

/** Euler taps used to integrate the drift over the phase.
 *
 *  The excursion is one leash, so the path is short and curvature over it is small — this is the
 *  same integration the per-frame pass did, just evaluated in one go instead of accumulated. Four
 *  is where the path stops visibly straightening on the demo fixture's gyre; more taps buy
 *  curvature nobody can see and cost a texture fetch each. */
export const ARROW_DRIFT_TAPS = 4

/** Per-arrow phase offset, so arrows do not all wrap together. Value noise from the origin
 *  (Hoskins' "hash without sine") — `fract`/`mul` only, deliberately NOT sine-based: the sine
 *  hash's quality at large arguments is driver-dependent and this runs on both the WGSL and GLSL
 *  arms, where those differ.
 *
 *  A FUNCTION OF THE ORIGIN, which is what makes it stable: the same arrow gets the same offset
 *  every frame, across a forecast step, and across a change in how many arrows are drawn. The
 *  lottery it replaces needed a per-frame seed and a state texture to remember its outcome. */
export const arrow_phase_offset = fn('arrow_phase_offset', { p: vec2fT }, (a) => {
  const p3 = fract(vec3(a.p.x, a.p.y, a.p.x.add(f32(0.37))).mul(f32(0.1031)))
  const d = p3.x
    .mul(p3.y.add(f32(33.33)))
    .add(p3.y.mul(p3.z.add(f32(33.33))))
    .add(p3.z.mul(p3.x.add(f32(33.33))))
  const q = p3.add(vec3(d, d, d))
  return fract(q.x.add(q.y).mul(q.z))
})

/** Fraction of the cycle spent fading in and out at each end. */
export const ARROW_FADE_FRACTION = 0.15

/** Alpha ramp across the phase, so the wrap is a fade rather than a jump. Zero at both ends,
 *  one across the middle — `min(phase, 1 - phase)` scaled and clamped, which is one expression
 *  and no branch.
 *
 *  This is the term the stateful design could not write. It is also what keeps the wrap from
 *  reading as the blink #1333 rejected the whole moving-glyph idea over. */
export const arrow_phase_alpha = fn('arrow_phase_alpha', { phase: f32T }, (a) =>
  min(min(a.phase, f32(1).sub(a.phase)).div(f32(ARROW_FADE_FRACTION)), f32(1)),
)
