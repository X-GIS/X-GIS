---
title: 'The hemisphere that was never selected: a fast-path bbox that collapsed to a point'
description: 'Half the globe rendered as background again — same symptom as the drape-suppression bug, opposite root cause. This time the trans-antimeridian tiles were never selected: the overzoom fast-path unprojects the viewport corners to a lon/lat box, but on a small globe disc the corners miss the sphere, the box collapses to the sub-camera point, and it emits the single tile column under the camera — which a contiguous longitude range can never wrap across the dateline. Told apart from the draw bug by seam location and persistence.'
date: 2026-07-15T02:30:00Z
tags: ['rendering', 'debugging', 'globe', 'tiles', 'verification']
lang: en
draft: false
---

A user pans the globe to the antimeridian — hash
`#2.70/29.61151/179.66439/0.0/21.4`, sub-camera longitude 179.66° — imports
the OpenFreeMap planet, and half the world is missing. Japan, the
Philippines, Papua New Guinea render on the left; the right half is flat
cream background, and the boundary is a hard vertical seam straight down the
middle of the disc.

If that reads like a rerun, it should. Two days earlier the same engine
produced [a planet cut in
half](/blog/2026-07-13-the-hemisphere-that-wasnt-there), and that post's
diagnostic tell applies verbatim here: **a projection or culling bug curves;
a data-availability bug follows tile boundaries.** The seam sits exactly on a
tile-column edge — the antimeridian is the `x=0` boundary at every zoom — so
this is availability, not geometry. The question is _which_ availability bug,
because the last one was a trap that cost a full session.

## Two discriminators rule out the previous bug

The [#1076 hemisphere bug](/blog/2026-07-13-the-hemisphere-that-wasnt-there)
was a **draw** failure: the missing half's fallback ancestors were computed,
CPU-cached, and force-uploaded to the GPU, then suppressed at the last hop by
a drape flag (`_drapeGlobeFills`) scoped to the renderer instead of to one
dispatch. The tiles were _there_; the draw call never fired.

Two things say this is not that:

1. **The seam is on the other meridian.** #1076 cut at the **0-meridian**
   while the west column streamed. This cuts at the **antimeridian**, 180°
   away.
2. **It persists.** #1076 was transient — it healed the moment the delayed
   tiles arrived. This one is pumped through forty frames over six seconds of
   convergence and never heals. Nothing is _en route_ to fill the gap.

Persistence points upstream of the draw, upstream of the upload, all the way
to selection. So instrument the one function whose job is to answer "which
tiles?" — `globeVisibleTiles` — and read its raw return before any world-copy
fan-out:

```
before:  z2  x∈{2,3}     (lon 0..180 — the east/front column only)
after:   z2  x∈{0,3}     (both sides of the dateline)
```

Loaded tiles: 31 → 50. The selector was never returning the far half. This is
a **selection** bug, a different function in a different package from #1076's
renderer flag. Same symptom, opposite layer.

## A fast-path that fires in the wrong regime

`globeVisibleTiles` normally descends the mercator tile pyramid in continuous
sphere space, which wraps the dateline by construction. But it has an
_overzoom_ fast-path, added so that when the camera zooms past the data's max
level — where a single tile projects larger than the whole viewport and the
5-sample descent cull collapses to ~1 tile — it can bypass the descent:
unproject the nine viewport probes (corners, edges, centre) onto the sphere,
take the lon/lat bounding box, and emit every tile covering it.

It enters on `zoom > maxZ`. That test is the bug. On the globe `maxZ` is the
current integer render level, `floor(cameraZoom)`, so `zoom > maxZ` is true
for _any fractional zoom_ — including low zoom, where the globe is a small
disc floating in background, nothing like the "one tile fills the viewport"
regime the fast-path was written for.

And on a small disc the probe math quietly degenerates. Seven of the nine
probes are corners and edges; on a disc smaller than the viewport they miss
the sphere entirely and return null. Only the two centre-ish probes hit — both
at the sub-camera longitude, 179.66°. The bounding box collapses to a
**point**:

```
ozHits: 2   ozLonMin: 179.66   ozLonMax: 179.66
```

A collapsed box has zero longitude span, so it sails through the guard meant
to catch the _opposite_ failure — `lonMax - lonMin <= 170`, there to reject a
box so wide it straddles the limb. The path then maps that single point to one
tile column (`x=3`, plus a ±1 pad → `x∈{2,3}`) and emits it. Everything else
on the visible hemisphere is dropped.

At any other longitude you would not notice: the front hemisphere is roughly
contiguous in tile-x, so a padded column near the centre covers most of what
matters and the far edge that gets dropped is back-facing anyway. The
antimeridian is the one place where the visible region **wraps** the `x=0`
seam — front tiles live at both `x≈0` and `x≈2^z−1`, which are maximally far
apart in x. A contiguous `[x0..x1]` range physically cannot contain both ends.
The collapsed fast-path emits the near column and the wrap-around half has no
representation at all.

## The fix is a precondition, not a special case

The fast-path's bounding box is only meaningful when the viewport is entirely
_on_ the sphere — the deep zoom-in regime it was built for, where all nine
probes hit. So gate on exactly that:

```ts
if (hits === probes.length && lonMax - lonMin <= 170 && latMax - latMin <= 170) {
```

When the disc is smaller than the viewport, some probes miss, the guard fails,
and selection falls through to the descent — which reasons in continuous
sphere space and keeps both sides of the dateline by construction. It is the
correct selector whenever the disc does not fill the frame, which at low zoom
is always. Nothing else moves: a deep-zoom view sitting exactly on the
antimeridian still has all nine probes hit but a ~360° span, so the existing
span guard routes _it_ to the descent too; a grazing-limb high-pitch view
likewise. The fast-path keeps firing only where it was ever valid.

The regression test pins the regime the old tests missed. The existing
dateline test ran at `zoom < maxZ` — the descent path, which was always
correct — so the overzoom path had no coverage at all. The new one runs the
user's camera (`zoom > maxZ`, antimeridian, small disc) and asserts tiles on
both sides; it fails on the pre-fix `hits > 0` guard and passes on
`hits === probes.length`.

## Verifying without re-learning the readback lesson

The fix is a change in a pure function, so it is proven at that layer. But
"half the globe" is a claim about pixels, and the sibling bug left a landmine
in exactly this verification: on a WebGPU canvas under Chromium, reading the
frame back through a Canvas2D `getImageData` yields transparent pixels — all
zeros — and would report the fix broken. The compositor screenshot is ground
truth; the in-page readback is not. So the check used `page.screenshot()` on a
headless SwiftShader run, never a readback.

Before versus after, 860×720, forty pumped frames: the directional diff
changed 30.1% of the frame, **entirely in the previously-blank half** (186,644
changed pixels on the right, 23 on the left). Read at full resolution, the
before frame is the reported bug — a hard seam at screen centre, right half
solid cream — and the after frame renders the North Pacific, Bering Sea, and
Gulf of Alaska continuously across the antimeridian with no seam. The half
that wasn't there is there.

## What generalizes

**"Half the globe is background, cut on a tile line" is a symptom with (at
least) two root causes at two layers.** One is a draw suppressed by state
scoped wider than its decision; the other is a selection that never named the
tiles. The seam's meridian and whether it heals tell them apart before you
open a single file — a cheap triage the corpus now supports.

**A fast-path is a promise about a regime, and it must guard the regime, not a
proxy for it.** `zoom > maxZ` was a proxy for "one tile is bigger than the
viewport," and it aliased a second, opposite situation — a small disc at
fractional zoom — into the same branch. The honest precondition (the viewport
is entirely on the sphere: every probe hits) names the regime directly, so the
branch cannot fire outside it.

**A degenerate primitive slips through a guard built for the other extreme.**
The span guard was written to reject boxes that are too _wide_. A box
collapsed to a point is as far from that failure as possible, so it passes —
and is just as wrong, in the other direction. When a guard bounds one end of a
range, ask what happens at zero.

## References

1. ["The hemisphere that wasn't there: computed, cached, uploaded, drawn
   nowhere"](/blog/2026-07-13-the-hemisphere-that-wasnt-there) — the sibling
   bug: identical symptom, a suppressed _draw_ rather than an empty
   _selection_. Read together they are a triage table.
2. ["The map that downloaded the world"](/blog/2026-07-13-the-map-that-downloaded-the-world)
   — the same selection machinery seen from the cost side; what "always have a
   tile" spends to be true.
3. ["Two renderers, one truth"](/blog/2026-07-13-two-renderers-one-truth) —
   four globe defects, none in shared code; on trusting the backend that
   renders correctly and pinning the one that drifts.
