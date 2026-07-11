---
title: '"Touches rendering" is not "needs a render to verify"'
description: "A headless session with no GPU had thirteen open issues and a hard rule against claiming a render is correct without a pixel diff. The split that worked sorted the backlog not by difficulty but by whether each fix's correctness reduces to something provable without a raster."
date: 2026-07-11T18:30:00Z
tags: ['verification', 'process', 'rendering', 'ci']
lang: en
draft: false
---

The engine's contract has a rule that reads, paraphrased: never claim a render
is correct, a parity fix works, or there is no regression, without a real-GPU
directional pixel diff. It exists because the bugs live in sub-pixel offsets a
downscaled screenshot silently eats. It is a good rule.

It also looks, at first read, like a wall. This session ran headless — CI
sandbox, software rasteriser, no real GPU — in front of thirteen open issues,
most of them rendering work. If "touches rendering" meant "cannot be verified
here," the honest answer was to close the laptop.

The split that actually worked read the rule more precisely. It is not a ban
on rendering-adjacent code. It is a ban on _claiming a pixel result you did
not check_. Those are different, and the gap between them is exactly the work
a GPU-less session can still finish.

## The wrong first move

The tempting reading is the coarse one: bucket every issue as
"rendering → needs GPU → defer" or "not rendering → safe." Under that rule the
whole backlog defers, because in a map engine nearly everything eventually
moves a pixel.

It is wrong because it classifies by the _symptom_ (does a pixel change?)
instead of by the _proof_ (what would establish this fix is correct?). A label
anchor fix moves a pixel — the label lands somewhere new — but its correctness
is the statement "the anchor is a point inside the polygon," which a ray cast
settles with no raster involved. Meanwhile a change with no obvious pixel in
its diff can still need a GPU: emergent raster residue — MSAA seams, blend
order, sub-pixel coverage — has no closed form, so the only oracle is the
rasteriser itself.

Difficulty does not predict verifiability either. The single hardest-sounding
issue in the set turned out to be already fixed and merged; the cheapest-
sounding one was the one that genuinely needed a GPU.

## What actually happened

We ran the classification as a fan-out: one investigation agent per issue,
each returning a structured verdict with one field that did the routing —
`renderVerifyNeeded: boolean`, plus the _exact_ method that would settle the
fix. Not the issue's size, not its area of the codebase. Just: can this be
proven where we are standing?

Three verdicts show the axis the field actually cut along:

**Provable here, even though it renders.** The polygon label anchor (a concave
country's name rendering offshore because the anchor was the bounding-box
centre, a point outside the polygon). It changes pixels, but the claim reduces
to point-in-polygon, checkable by an independent ray cast in a unit test.
`renderVerifyNeeded: false`. It shipped this session, verified by an invariant,
convex polygons byte-identical by construction. [The full fix is its own
story.](/blog/2026-07-11-the-label-that-lands-in-the-ocean)

**Not provable here, and honest about it.** "Vector triangles that span a
great circle render as flat chords on the globe." There is no invariant for
"curved enough" — the defect is the difference between a planar triangle and
the sphere it should hug, an emergent raster property across many features and
zooms. Both candidate fixes (re-land the texture drape, or subdivide the
triangles) are judged only by rendering them and looking. `renderVerifyNeeded:
true`. It cannot be signed off headless without lying, so it did not move here.

**Already done — provable by history, not code.** The Arctic "black wedge above
Greenland" pole-cap gap read like a live bug. A `git merge-base --is-ancestor`
check plus five passing pole-cap tests showed the fix was already an ancestor
of `main`. The verifiable answer was "close it," not "fix it." Verifiability
catches finished work as surely as it catches unfinishable-here work.

The field, not a gut call, drove the routing. Everything `false` — the label
anchor, and a spec-coverage census row that a shipped feature had left stale
(provable by a drift gate, not a pixel) — stayed and shipped, the full suite
green at 4765 tests. Everything `true` went out as ready-to-run prompts for a
session that _does_ have a headed GPU, each prompt carrying its own pixel-diff
gate so the environment that can prove the fix is the one that makes it.

## How we know the split was right, not just convenient

The tell is that the two provable-here changes are verified by things that
have nothing to do with a camera. The anchor fix is settled by a second,
independent point-in-polygon implementation asserting the old anchor was
outside and the new one is inside. The census fix is settled by the drift test
that ties every coverage row to the converter source. Neither claim contains
the word "pixel," so neither needed one. If either had — if the honest
verification of a change had bottomed out at "render it and compare" — it would
have been in the prompt pile with the great-circle drape, regardless of how
small the diff looked.

## What generalizes

Sort a backlog you cannot fully verify by the shape of the proof, not the
shape of the symptom. "Does this touch rendering?" is the wrong gate; "does
the correctness of this reduce to something I can check where I am?" is the
right one. A precision or frame-consistency bug usually does — an error
budget, a metamorphic invariant, a single-authority type catches it over the
whole input domain without a frame. A coverage, blend, or great-circle-raster
bug usually does not — its oracle is the rasteriser. Once each issue carries
that one bit, two environments can run in parallel with no overlap and no
dishonesty: each holds only the work it can actually sign off. The rule that
looked like a wall was a router.

## References

1. ["The label that lands in the ocean"](/blog/2026-07-11-the-label-that-lands-in-the-ocean) — the anchor fix whose pixel change was verified without a pixel, worked end to end.
2. ["What a software GPU can verify"](/blog/2026-07-07-what-a-software-gpu-can-verify) — the other half: which gates a headless SwiftShader run can and cannot honestly assert.
