---
title: 'The strongest render gate is hash equality'
description: 'A refactor rerouted the WebGPU frame shell through RHI wrappers and claimed byte-identical rendering. We did not diff pixels against a tolerance — we hashed three captures and got cd3097…9b0f three times. A same-code re-run proved the noise floor was zero, upgrading the gate from diff-below-tolerance to bit equality. Determinism is a property you engineer into the harness; once you have it, verification collapses from statistics to md5sum.'
date: 2026-07-14T13:00:00Z
tags: ['verification', 'rendering', 'determinism']
lang: en
draft: false
---

A refactor rerouted the WebGPU frame shell through RHI wrappers and claimed
_byte-identical rendering_. We did not diff the pixels and argue about whether
some percentage was small enough. We ran the capture three times and compared
32 hex digits:

```
cd3097376560d6523802ed4bea619b0f
```

Three times, identical. That is a stronger claim than any pixel-diff can make —
and it was reachable only because the harness had been engineered to be
deterministic. Here is the ladder that gets you there, and the rung below it
where a scare taught us to measure our own noise first.

## The claim

PR #1103 (phase F2) changed how the WebGPU frame originates. Instead of naming
the raw device — `device.createCommandEncoder()`, `context.getCurrentTexture()
.createView()`, `queue.submit()` — the frame shell mints its encoder via
`rhi.acquireFrameEncoder()` and its screen view via `rhi.acquireScreenView()`.
The wrappers are reused: created once, rebound each frame. The passes that have
not yet been converted unwrap them back to the native handles, and on WebGPU
that unwrap is the identity function. The claim that falls out of that design is
precise and byte-level: the native GPU ops, and their order, are unchanged. Not
"looks the same." The same bytes.

A byte-level claim deserves a byte-level gate. A pixel-diff percentage, however
small, tests something weaker.

## The rung we almost settled for: a tolerance

The natural render gate is a directional pixel-diff — capture before and after,
diff, check the change is below some tolerance. That is the right tool for an
_intentional_ change. For a claimed no-op it is a confession: a tolerance says
you cannot yet tell noise from signal, so you are willing to call "small enough"
a pass. An earlier phase of the same program (F1) walked into that trap. Its
WebGL2 before/after diff came back **0.020%** — nonzero, on a change designed to
be inert. Nonzero on a no-op reads as a regression, and the temptation is to
spend the afternoon arguing about whether 0.020% is small.

## Measuring the noise floor

The resolution was not to argue about the magnitude. It was to measure the
harness's own jitter: run the _same_ code twice and diff the two identical-code
captures. That control came back **0.023%**, its hot pixels confined to a
30×8-pixel stats-overlay band — a HUD counter ticking between shots. The
"regression" (0.020%) sat _below_ the harness's own run-to-run noise (0.023%),
and the claim that F1 changed the output was refuted by that main-vs-main
control. The lesson banked: never trust a diff until you have measured what the
same input diffs against itself.

## What actually happened: the noise floor was zero

F2 took that lesson and asked the sharper question — what _is_ the noise floor
for this capture? For a pipeline engineered to be deterministic, the answer can
be exactly zero, and if it is, the whole apparatus of tolerances evaporates. We
captured three PNGs of the live WebGPU globe: BEFORE at the merge base
(`f584e760`), AFTER at the refactor tip (`a7f8b7c8`), and the AFTER capture a
second time. All three hashed to one value, `cd3097376560d6523802ed4bea619b0f`.

The AFTER-vs-AFTER re-run is the control, and it is bit-identical: the noise
floor here is not "0.023%," it is zero. With a zero noise floor the before/after
comparison is no longer "diff below tolerance" — it is bit equality, `DC = 0` at
threshold `0`. That is the strongest form the byte-identity claim can take, and
it matches exactly the byte-level claim the refactor made about its native ops.

## The ladder

Three rungs, each a stronger gate than the last, each usable only when its
precondition holds:

1. **Directional diff** (`DC > 0`, `D1 < D0`) — for an intentional change.
   Proves the change moved the image toward the reference, not that it matched a
   particular magnitude.
2. **Threshold `DC = 0`** — for parity. Proves no change above the measured
   noise floor. Requires that you have measured that floor — F1's lesson.
3. **Hash equality** — for a deterministic pipeline. Proves no change at all.
   Requires that the pipeline be deterministic in the first place.

Every rung needs its noise floor measured before you trust it; rung 3 is the
special case where that measurement returns zero. And rung 3 is reachable only
because the capture protocol _makes_ the pipeline deterministic: a fixed camera
(`#2/20/0/0/0`), 30 invalidate-pumped frames so the render-on-demand loop settles
every async tile before the shot, and a software rasterizer (SwiftShader) with
none of a hardware driver's frame-to-frame nondeterminism. Remove any one of
those and the noise floor lifts off zero and you fall back to rung 2.

The pumping is not incidental. This engine renders on demand — the loop skips a
frame unless a predicate says there is work — so a single captured frame may be
of a half-loaded map. You have to pump `invalidate()` to convergence before the
bytes are stable enough to hash; the deadlock behind that predicate is its own
story in ["The map fossilized half-loaded"](/blog/2026-07-14-the-map-fossilized-half-loaded).

## What generalizes

Determinism is not a property you hope a render pipeline has; it is a property
you _engineer_ into the harness — pin the camera, pump to convergence, rasterize
in software — and it is worth the effort for what it buys at verification time.
Once the pipeline is deterministic, verification collapses from statistics to
`md5sum`. There is no tolerance to defend, no "0.00% rounded from what?": two
32-character strings are equal or they are not. The refactor claimed its native
ops were byte-identical; only a byte-identical gate actually tests that claim,
and only a deterministic harness lets you run one.

## References

1. ["The map fossilized half-loaded"](/blog/2026-07-14-the-map-fossilized-half-loaded)
   — the render-on-demand idle loop and the `invalidate()` pump; the reason a
   capture must force frames to convergence before it can be hashed, rather than
   trusting a single frame to be finished.
2. `.claude/skills/compare-parity-pixeldiff` — the directional-diff tool
   (`DC` / `D0` / `D1`) that is rungs 1 and 2 of the ladder; hash equality is
   what rung 2 becomes the day the measured noise floor is zero.
