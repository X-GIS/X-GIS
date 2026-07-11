---
title: 'Reconstructing the absolute coordinate was the bug'
description: 'Line strokes shook at deep zoom in non-Mercator projections: the shader rebuilt an absolute longitude in f32 degrees, then a later stage subtracted the camera again — catastrophic cancellation. The fix subtracts first; the proof needs no GPU.'
date: 2026-07-11T01:20:00Z
tags: ['precision', 'shaders', 'verification']
lang: en
draft: false
---

At longitude ~127°, one f32 ULP of a degree value is roughly 1.7 metres on the
ground. Our line shader's non-Mercator branch rebuilt an _absolute_ longitude
in f32 degrees from tile-local coordinates, handed it to the projection, and
the projection's first act was `radians(abs_lon) − radians(clon)` — subtract
the camera longitude back out. Two nearly-equal large numbers, differenced in
f32: catastrophic cancellation, and strokes that visibly shook at high zoom in
every non-Mercator projection. The fill and point paths had already been fixed
to carry a split-precision tile-local tail; the line path was the sibling that
kept the old degree round-trip.

The bug's shape is worth naming precisely, because it recurs in any
coordinate pipeline: a value that is _born relative_ (tile-local, sub-metre
precise) gets promoted to absolute form (huge magnitude, precision destroyed),
travels one stage, and is demoted back to relative by subtracting the same
large anchor. The information the final stage needs — the small difference —
existed exactly at the start and was reconstructed, lossily, at the end.

## The wrong first move

For a render bug, the reflexive verification plan is "reproduce on screen,
fix, compare screenshots." For this class it is close to useless: the error is
sub-metre at z16–z20, visible mainly as temporal shimmer under camera motion,
and a screenshot diff of it proves nothing about the zooms and longitudes you
didn't capture. The issue itself had been filed from static analysis with the
honest caveat "NOT yet runtime/pixel-reproduced" — and it stayed open, because
"we'll verify it when we can render it" is where precision bugs go to wait.
Precision is math wearing a pixel costume; the admissible proof is an error
budget, not an eyeball.

## The fix

Feed the projection the difference that already exists. The renderer sets
`cam_h + cam_l` (a split-precision pair) to `camMercX − tileMercX`, so
`corner − (cam_h + cam_l)` _is_ the camera-relative position — the ~1.4×10⁷ m
anchor magnitude cancels in the split arithmetic, before f32 ever sees a large
number:

```ts
const clon = projParams.y
const relMercX = p.corner.x.sub(TILE.field.cam_h.x).sub(TILE.field.cam_l.x)
const dLon = relMercX.div(DEG2RAD.mul(EARTH_R))
const projParamsRel = vec4(projParams.x, f32(0), projParams.z, projParams.w)
const flatRel = flat_rel(dLon, absLat, projParamsRel, tileRefLonRel)
```

The projection depends only on `lon − clon`, so recentring the whole call onto
`clon = 0` is exact in real arithmetic — the same function evaluated at
shifted arguments — and it deletes the cancellation instead of guarding it.
Latitude deliberately keeps the absolute path: it has no linear
camera-relative form, and its magnitude keeps its residual sub-metre. The fix
is honest about being half a fix.

## How we know it holds

No GPU was involved, by design. The gate evaluates the old and new formulas
in a CPU model of the shader — every operation wrapped in `Math.fround`, so
f32 rounding happens where the hardware would round — against an f64
reference projection, across five projections at z16/z18/z20. The old path
leaks >0.2 m of longitude error; the new path is <0.01 m, a >20× reduction,
asserted as a budget, not a screenshot. Because a numeric model can drift
from what the compiler actually emits, two further tests pin the emitted WGSL
itself — that `flat_rel` receives the camera-relative operand and the
recentred parameters. Stashing the fix fails exactly those two (the pre-fix
emit contains the absolute-degree reconstruction); the suite stays green
otherwise. The end-to-end measurement keeps the honesty visible: total error
0.29–0.43 m after versus 0.48–0.64 m before — the longitude term is gone, the
documented latitude residual remains.

## What generalizes

When a pipeline subtracts a large anchor at stage N, the fix is almost never
higher precision at stage N — it is refusing to re-add the anchor at stage
N−1. Difference first, then round; any absolute form in the middle is a
precision tax paid for nothing. And for this bug class, flip the verification
instinct: an error-budget test over the whole input domain is strictly
stronger evidence than any number of screenshots, because the screenshot
samples one camera and the budget bounds all of them.
