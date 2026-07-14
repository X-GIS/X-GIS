---
title: '20.7 km and 0.7 m: a difference forgives the bias its terms share'
description: "I spec'd a drift guard for the globe's camera-relative ECEF offset: force the ellipsoid constant to a sphere, assert the result shifts >10 km. The implementer measured it: 0.7 m. Turning the WHOLE computation spherical barely moves a relative offset, because both endpoints carry the same 21 km bias and a subtraction cancels it. The regression that actually bites is the mixed frame — ellipsoid tile, spherical camera — and only a guard that breaks the symmetry the same way sees it."
date: 2026-07-14T01:00:00Z
tags: ['precision', 'geodesy', 'testing', 'numerical']
lang: en
series: { name: 'Emulating f64 in shaders', order: 10 }
draft: false
---

Two numbers, same constant, same formula, same Tokyo tile at z14. Delete the
Earth's flattening from one _term_ of a camera-relative offset: the offset's
Z lane moves **20.7 km**. Delete it from the _whole_ computation: the same
lane moves **0.7 m**. Four and a half orders of magnitude between "the
ingredient barely matters" and "the ingredient is thousands of pixels" —
depending only on whether you removed it symmetrically.

I got this wrong in a test spec, and the wrongness is the useful part.

## The seam being guarded

This series has circled one strategy the whole time: planet-sized
coordinates don't fit in f32, so you subtract a reference on the CPU in f64
and hand the GPU a small relative number. On the globe that's the RTC
offset `tileEcefCenter − cameraCenter`, split DSFUN hi/lo into the
`cam_ecef_off` uniform lanes. Both endpoints are computed on the WGS84
**ellipsoid**, because the tiler packs vertices via `lonLatToECEF` on the
ellipsoid — and the anchor's header comment records what happened when that
agreement once broke: mixing a spherical camera term put the
ellipsoid−sphere discrepancy (~21.5 km at Tokyo's latitude) straight into
the offset, "sub-pixel at z1.5 but thousands of pixels at z14."

After the [twin-frame bundle](/blog/2026-07-13-two-renderers-one-truth)
extracted this math into a single authority, it needed a drift guard. I
wrote the spec for it in one line: _"force E2 → 0 and assert the result
shifts by more than 10 km."_ Reasonable-sounding — the flattening is the
load-bearing ingredient; a test should prove the code depends on it.

## The measurement that refuted the spec

The implementer didn't argue. They computed both witnesses at the Tokyo z14
case and put the numbers in the test's comment:

```ts
// Force E2→0 on the CAMERA term only (ellipsoid tile vertices + spherical
// camera origin) — the #1044-adjacent regression the authority names. NOTE:
// forcing E2→0 on BOTH terms (a full sphere) would NOT trip this — the
// ellipsoid−sphere bias cancels between the two ~1 km-apart points in the
// RTC difference (~0.7 m). The regression lives in the camera term, where
// the ~21.5 km class error is; the guard isolates exactly that.
const sphereCameraOffZ = refEcef(c, E2, 0).offZ
expect(Math.abs(ellipsoidOffZ - sphereCameraOffZ)).toBeGreaterThan(10_000)
```

As spec'd — E2 → 0 everywhere — the assertion is simply **false** on
correct code: the shift is ~0.7 m, and the guard would have been born red.
And the two lazy ways to make it green are both worse than no guard. Lower
the threshold to half a metre, and the test now "passes" while saying
nothing about the 20.7 km failure. Keep the threshold and flip the
assertion's direction after watching it fail, and you have enshrined the
opposite of the truth.

The algebra is one line. A relative offset is a difference, and both
endpoints carry nearly the same model bias:

$$(A + b_A) - (B + b_B) = (A - B) + (b_A - b_B)$$

Turn the whole computation spherical and $b_A \approx b_B$ — the bias field
varies smoothly with latitude, and the tile corner and the camera centre
sit ~1 km apart at z14, so what survives is the bias _gradient_ times 1 km:
~0.7 m. But the regression class that actually occurs — someone recomputes
the _camera_ term with a simpler spherical formula while the tile term (and
every packed vertex) stays ellipsoidal — is the asymmetric case:
$(A + b_A) - B$. The full common-mode bias, all 20.7 km of it at this
latitude and axis, lands in the offset and the vector layer leaves the
raster underneath it.

So the reference recomputation in the test takes _independent_
eccentricities per term, precisely so the guard can break the symmetry the
way the bug would:

```ts
function refEcef(c: AnchorCase, tileE2 = E2, camE2 = E2) { … }
```

## Why this is the flip side of the whole series

Relative-to-center rendering works _because_ subtraction is a great
forgiver: it cancels the shared magnitude that f32 can't hold. This post is
the bill for that: subtraction also cancels shared **model error**. The same
mechanism that makes the technique numerically kind makes it observationally
blind — you cannot detect a wrong-but-consistent geoid from inside a
difference of two points computed on it. At these distances a fully
spherical Earth renders indistinguishably; the 21 km lie is common-mode.

Which reframes what a drift guard is for. The danger at a
two-authority seam (tiler packs the vertices, renderer packs the camera) is
never "someone deletes the constant from the shared header" — that breaks
symmetrically and mostly harmlessly. The danger is the two authorities
_disagreeing about the model_, which is asymmetric by construction. A guard
that perturbs an ingredient globally tests the ingredient. A guard that
perturbs one term tests the seam. Only the second one covers the failure
mode that ever actually shipped.

## The refutation was the process working

One more thing worth keeping, because it's the cheapest part to replicate:
the spec author (me) and the implementer were different roles, and the
implementer's first move on receiving a testable claim was to _measure it_,
not implement it. The refutation cost one evaluation of `refEcef` with two
argument shapes and produced both witnesses — 20.7 km and 0.7 m — which then
went into the test as its own documentation. A drift guard whose comment
carries the number it must catch _and_ the number that fooled its author is
a guard the next engineer won't "simplify" back into the symmetric form.

I'd have merged my own spec. It asserted something quantitative, cited the
right constant, and would have either failed mysteriously or been threshold-
tweaked into decoration. The system that saved it was not cleverness but
sequence: claims about magnitudes get measured before they get encoded.

## References

1. ["Two renderers, one truth"](/blog/2026-07-13-two-renderers-one-truth) — the #1044 anchor-authority extraction this guard protects, and the bundle it shipped in.
2. ["The precision fix that opened a seam"](/blog/2026-07-11-the-precision-fix-that-opened-a-seam) — the previous entry in this series: two paths disagreeing about a frame is the bug class; this post is its test-design corollary.
3. Guard under discussion: `map/src/render/tile-camera-anchor-authority.test.ts` (lane-exact parity + the camera-term witness); authority: `map/src/render/tile-camera-anchor.ts`.
