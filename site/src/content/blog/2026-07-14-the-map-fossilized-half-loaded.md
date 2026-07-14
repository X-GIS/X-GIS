---
title: 'The map fossilized half-loaded: the render loop stopped because its work was hidden in a buffer it could not see'
description: 'Labels decayed 6980 → 2138 → 76 → 0 pixels across four probe runs — in commit order, looking exactly like a regression gradient. Every HTTP fetch returned 200. The frame trace said all 46 labels placed. The real bug: an upload staging buffer invisible to the render-on-demand idle predicate, a deadlock that fossilized the map mid-load on any machine. One line made the buffer visible; labels went 0 → 7,081 pixels with zero interaction.'
date: 2026-07-14T03:00:00Z
tags: ['debugging', 'render-loop', 'scheduling', 'deadlock']
lang: en
draft: false
---

A user filed three symptoms against the globe at zoom 2: most labels missing,
the east half of the visible hemisphere stuck on coarse border-less fills, and
a thin white line running along the equator. Our headless captures agreed —
and added a detail that shaped the whole hunt wrongly. Counting dark label
pixels at the identical camera across four probe runs gave 6,980 → 2,138 → 76
→ 0. The runs happened to be in branch-history order. It read exactly like a
regression gradient: each merge eats more labels. It was nothing of the sort.

## The wrong first move

We started a bisect. The prime suspect was the most recent merge — a fix that
finally made fallback ancestor tiles draw on the globe's drape path. It was
tempting for two reasons: it was the only code between the labels-rich capture
and the labels-dead one, and it touched exactly the fallback machinery whose
output (coarse ancestor fills) now covered the label-less regions.

The bisect refuted itself in one step: checking out the merge's parent
reproduced the dead labels too. Then the "gradient" collapsed — re-running the
same commit produced different label counts on different runs. The monotonic
decay was a coincidence of run order, not a property of the commits. Whatever
this was, `git bisect` could not see it.

## What actually happened

With code history exonerated, we instrumented the running page instead. Three
observations, each of which killed a hypothesis:

**The network was innocent.** A relay tally of every request: 18 tile fetches,
all HTTP 200, zero glyph failures, zero console errors. The data arrived.

**The label pipeline was innocent.** The engine's frame-trace hook — which
records every label's resolved state as it is submitted — reported 46 of 46
labels `placed`, zero collision-dropped, zero out-of-frustum. The missing
labels were not being culled; they were never _submitted_, because their
tiles never finished materializing.

**The pipeline was frozen, not slow.** The tile diagnostic read
`catalogLoading=15, missed=90, pendingUp=4` — and held those exact values for
ten-second stretches. Then the discriminating experiment: forcing frames by
calling `invalidate()` in a loop drained `catalogLoading` from 15 to 0
immediately and the GPU tile cache started climbing. Frames were the only
missing ingredient. The map wasn't overloaded. It had _stopped_.

The engine renders on demand: a `renderLoop` skips `renderFrame()` unless a
predicate says there is work. The predicate looked airtight — fetches in
flight, or GPU uploads pending, or tiles missed last frame:

```ts
if (source.hasPendingLoads?.()) return true
if (renderer.hasPendingUploads?.()) return true
if (stats.missedTiles > 0) return true
```

Each signal individually had a hole, and the holes lined up:

1. Upload admission is capped at 4 slices per frame; overflow is parked in a
   `_heldUploads` array, replayed only by `resetFrameCap()` — which runs at
   the top of a rendered frame. An 80-layer style pushes ~80 slice-uploads per
   tile, so on a fresh load nearly everything transits this buffer.
2. `hasPendingUploads()` reported only the visible queue —
   `uploadQueue.running`. The held buffer was invisible to it.
3. A viewport cell covered by an ancestor fallback is classified
   `parent-fallback`, not `pending` — so once coarse ancestors covered the
   screen, `missedTiles` read 0.

The moment fetches settled, the visible queue momentarily self-drained, and
ancestors covered the viewport, all three signals read false — _while the
held buffer was full_. The loop stopped. The replay site never ran again.
Every held slice froze forever, and late-decoded tiles' labels never got a
placement frame, because placement happens inside `renderFrame` and nothing
invalidates on tile arrival.

The two "regional" symptoms fell out of one more property: the upload queue is
distance-prioritized. The frozen tail is always the tiles farthest from the
camera center — at a Greenwich-centered camera, the east half. And the white
equator line was the fallback tiles' clip seam, made permanent by the freeze
(fallback states are supposed to be transient).

One caveat kept us honest about our own harness: an injected
self-perpetuating `requestAnimationFrame` counter ticked **5 times in 18
seconds** on the headless box — the probe environment itself was rAF-starved,
which amplified the freeze but did not cause it. The deadlock needs only the
race "held non-empty at the frame where the predicate reads false", which a
heavy style makes near-certain at any frame rate. Instrument the harness
before believing the app.

## The fix

One point. The buffer becomes visible to the predicate:

```diff
   hasPending(): boolean {
-    return this.uploadQueue.running
+    return this.uploadQueue.running || this._heldUploads.length > 0
   }
   pendingCount(): number {
-    return this.uploadQueue.size() + this.uploadQueue.activeCount()
+    return this.uploadQueue.size() + this.uploadQueue.activeCount() + this._heldUploads.length
   }
```

The admission cap and the replay mechanics are untouched — the loop simply
keeps ticking until the pipeline truly converges, which is what every caller
of `hasPending()` already believed it was checking.

## How we know it holds

A fail-before test pins the exact scenario: enqueue more slices than the
per-frame cap, let the visible queue self-drain to idle, and assert
`hasPending()` is still true while slices are held — the pristine source
fails at that assertion (`expected false to be true`), the fixed source
passes, and a replay loop then drains everything to a genuinely idle zero.

On the live globe, the witness is stark. Same camera, no interaction, 60
seconds: before the fix, all counters frozen across 10+ second windows,
label pixels 0; after, `catalogLoading 17→0`, GPU tile cache `1→38`
monotonic, label pixels **7,081** — statistically the same as the 6,980
healthy baseline. The half-loaded fossil simply finishes loading.

## What generalizes

Every deferral buffer in a render-on-demand pipeline is a deadlock waiting
for a race, unless it satisfies one of two contracts: it is _visible_ to the
idle predicate, or it owns its _own wakeup_. Our buffer had neither — it was
drained by frames and invisible to the thing that decides whether frames
happen. The system was, by construction, one unlucky interleaving away from
stopping with work in hand. That the interleaving also needed two other
signals to blink false at the same instant is exactly why it shipped: three
individually-reasonable signals, each with a hole, and nobody owned the
union.

And distrust metric gradients whose x-axis is "runs I happened to make in
this order". Ours pointed at a merge with commit-level precision and was
pure noise.

## References

1. ["The hemisphere that wasn't there"](/blog/2026-07-13-the-hemisphere-that-wasnt-there) — the earlier face of the same freeze: before fallback ancestors drew on this path, the identical stall rendered as a blank half-planet, and we fixed the _symptom's renderer_ without yet seeing the scheduler hole underneath.
2. NASA-AMMOS 3DTilesRendererJS [`PriorityQueue`](https://github.com/NASA-AMMOS/3DTilesRendererJS) — the microtask-self-draining queue whose healthy autonomy made the _held_ side-buffer's frame-coupling easy to miss.
