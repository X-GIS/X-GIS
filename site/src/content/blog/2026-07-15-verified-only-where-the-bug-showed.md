---
title: 'Verified only where the bug showed: a hot-path fix that shipped a zoom-in regression'
description: 'A WebGL2 flicker fix (#1139) was render-parity-verified on exactly one scenario — the zoom-OUT hold-tiles case that reproduced the original flicker, retained-content 0.19 → 0.79 matching WebGPU — and never on zoom-in or per-frame cost. It shipped an unmemoized per-frame classifyTile run twice per tile plus synchronous uploads, and stuttered with progressively-black fills on a Seoul zoom-in. Reverted 36 minutes later (#1140). A hot-path fix must be verified in its worst regime, not the one that showed the original bug.'
date: 2026-07-15T19:30:00Z
tags: ['verification', 'performance', 'webgl2', 'rendering', 'architecture']
lang: en
draft: false
---

The fix was real and the verification was real. On WebGL2 a not-yet-resident
tile flashed the background where the WebGPU path draws a coarse fallback
ancestor, and #1139 mirrored the fallback machinery into the WebGL2 twin so the
flash stopped. The measurement was the good kind: on the flicker harness —
settle z14 Tokyo, hold the tile fetches, zoom out to z6 — WebGL2 retained
content rose `0.193 → 0.785`, landing on WebGPU's `0.786`. A directional,
matched-to-reference number, exactly what our render-parity rule asks for. CI
went 15/15 green and it merged.

Thirty-six minutes later it was reverted (#1140). Zooming _into_ Seoul on the
same planet stuttered hard, and the fills went progressively black as you
descended. The fix was correct. The verification had covered one regime and the
regression lived in the other.

## The wrong first move

The wrong move was the verification itself — performed to the letter, in a
single regime. The harness that certified #1139 was the one that _reproduced the
original flicker_: a zoom-**out** that holds already-resident tiles on screen
while new fetches are suppressed. In that scenario the set of not-yet-resident
tiles is small and _shrinking_ — the whole point is that tiles are held, not
loading — so any per-frame cost the fix added never had a chance to bite.
Retained content is a correctness measure; it says the right pixels stayed on
screen. It says nothing about what those pixels cost to compute, and the one
scene it ran on was the cheapest possible input for the new code.

It felt like compliance. There was a real before/after number, matched against
the reference backend, on the exact scenario the bug was filed against. What was
missing was the opposite scenario and the per-frame budget — and nothing in
"the render is correct here" prompts you to go looking for them.

## What actually happened

The revert message (#1140) names the mechanism precisely. The twin's new
`collectTwinFallbacks` runs `classifyTile` per non-resident tile, and it runs
from _both_ `renderFillsRhi` and `renderLinesRhi` — twice per tile per frame.
The production `render()` path had solved this cost long ago with a per-slice
memo (`vector-tile-renderer.ts:2796–2820`):

```ts
let sliceMemo = this._frameClassifyMemo.get(sliceLayer)
// ...
decision = classifyTile({/* ... */}) // cached into sliceMemo, one per tile per frame
```

`classifyTile` is a pure function (`map/src/tile-decision.ts:150`), which is
what let #1139 reuse it — and also what made it easy to call raw, outside the
memo. The twin's collector never touched `_frameClassifyMemo`. So where the
memoized path pays one classify per tile per frame, the twin paid
`Θ(non-resident × 2)` — and then, for each fallback it found, called
`doUploadTile` _synchronously_ to make the ancestor drawable this frame,
blocking the frame on GPU uploads that the primary path issues asynchronously.

Now put that on the regime the harness skipped. A zoom-**in** on a planet is a
load burst: the not-yet-resident set is large and _growing_ every frame as the
camera descends into un-fetched depth. The unmemoized double-classify scales
with that set, frame after frame, where before there was _zero_ such work; the
synchronous uploads stall each frame on the very tiles that are streaming in.
The stutter was the compute and the blocking upload; the progressively-black
fills were the second-order fallout as the stencil-masked fallback pass raced
the incomplete uploads. Both symptoms grow with descent depth — invisible at the
top of the zoom, worse with every level down — which is why a single zoom-out
capture could never have surfaced them.

## The fix

The fix for the fix was a full revert (#1140): restore the pre-#1139
CI-green tree, 341 lines back out of `vector-tile-renderer.ts`. A hot-path
regression with progressive visual corruption is not a "tune it later" ticket;
the correct immediate action is to return to the known-good baseline and re-land
deliberately. The revert message writes the re-land bar down so the next attempt
cannot repeat the gap: _a shared memo, async uploads, and verification across
zoom-in, per-frame cost, and fills_ — or, better, #1046 F3, which routes WebGL2
through the real `render()` and deletes the twin, inheriting the memo and the
async upload for free instead of re-deriving them by hand.

## How we know it holds

The revert is verified the only way a revert can be: it restores a tree that was
already green, so the regression it removes cannot survive it. The forward
guarantee is the written re-land checklist — a scenario list that names the
_worst_ regime (zoom-in load burst), a per-frame cost assertion, and a fills
check, none of which the original verification contained. That checklist is the
actual deliverable of this incident; the code is back where it started.

## What generalizes

A hot-path change's verification must exercise its worst regime, not the one
that reproduced the original symptom. Our render-parity rule was satisfied — a
directional number, matched to the reference — and still missed the bug, because
correctness and cost are different axes and the scenario that proves correctness
can be the cheapest possible input for the code you added. Choose the
verification scenario from the change's worst case (here: the load burst that
maximizes the per-frame set), not from the bug's repro. When a fix adds per-tile
or per-frame work, the regime that stresses that work is almost never the regime
that showed the original defect.

Under it sits the older lesson this repo keeps re-learning: a hand-maintained
twin re-earns every fix's bugs. `render()` already had memoized classification
and asynchronous upload; the twin had to reimplement fallbacks by hand and got
the performance wrong — not the logic, the _cost_. That is the whole argument
for [killing the twin](/blog/2026-07-13-two-renderers-one-truth) rather than
patching it: a second authority does not just risk diverging in behaviour, it
silently drops the non-functional properties — memoization, async, budget — that
the primary spent effort to earn.

## References

1. ["Two renderers, one truth"](/blog/2026-07-13-two-renderers-one-truth) — the
   case for deleting the WebGL2 twin (#1046): every one of four globe defects
   lived in it. #1139 is the same story from the cost side — the twin re-derived
   fallbacks and lost the memo.
2. ["The migration regressed one renderer at a time"](/blog/2026-07-11-the-migration-regressed-one-renderer-at-a-time)
   — parallel renderers drifting one path at a time; here the drift was
   performance, not geometry, and only in one zoom direction.
3. ["Seven ways the harness lied to me"](/blog/2026-07-14-seven-ways-the-harness-lied-to-me)
   — a catalogue of verifications that passed while blind, including a parity
   test that compared two empty frames. A green number on the wrong scenario is
   the eighth way.
