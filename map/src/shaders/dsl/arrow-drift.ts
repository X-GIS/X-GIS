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
//
// WHAT LEFT WITH THE PER-CELL GENERATOR (#1520 step 2). The LEASH (`ARROW_DRIFT_UV`), the SMEAR
// cap (`ARROW_SMEAR_SLOTS`) and the drift's tap count all existed to bound an excursion measured
// in GRID-uv against a pair of packed basis anchors. The field is now seeded on the SCREEN and its
// trains are walked in SCREEN arc length, so the bound is the inter-glyph spacing itself and the
// tap count belongs to the walk — both live in `arrow-view.ts` beside the lattice they describe.
// What survives here is the part that was never about the grid: an arrow is `(origin, phase)`.

import { fn, f32, fract, min, vec3, vec2fT, f32T } from '@xgis/shader-dsl'

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

/** Per-seed phase offset, so trains do not all wrap together. Value noise from the seed's own
 *  lattice index (Hoskins' "hash without sine") — `fract`/`mul` only, deliberately NOT sine-based:
 *  the sine hash's quality at large arguments is driver-dependent and this runs on both the WGSL
 *  and GLSL arms, where those differ.
 *
 *  A FUNCTION OF THE SEED, which is what makes it stable: the same lattice node gets the same
 *  offset every frame, across a forecast step, and across a change in how many glyphs are drawn.
 *  It is deliberately NOT a function of the seed's grid-uv — the water under a fixed screen node
 *  changes whenever the camera does, so a uv hash would re-roll every phase on every pan and the
 *  field would boil instead of flow. The lottery it replaces needed a per-frame seed and a state
 *  texture to remember its outcome. */
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
