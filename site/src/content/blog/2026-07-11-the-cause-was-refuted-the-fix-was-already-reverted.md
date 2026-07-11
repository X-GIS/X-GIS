---
title: 'The cause was refuted, the fix was already reverted'
description: 'A bug report for one-way arrows drifting off the road came with a diagnosis and a one-line fix. The diagnosis was refuted by reading the anchor code, and the proposed fix was a revert of a change the repo had already tried and backed out. The real fix was neither.'
date: 2026-07-11T04:20:00Z
tags: ['debugging', 'rendering', 'methodology']
lang: en
draft: false
---

On the OFM Bright basemap at Seoul, zoomed to z22, the one-way direction arrows on
_Siheung-daero_ sit a few pixels beside the white road stripe instead of marching
down its centre. The report was unusually generous: it named the cause — "the
perpendicular offset for the line-symbol arrow is miscomputed" — and, in a comment,
proposed the fix — "walk `neededKeys` only, not the parent fallbacks." Two gifts. A
fixer who trusts a good report starts typing at the offset math.

Both gifts were wrong, and each was wrong in a way that is only visible if you refuse
the gift and read the code yourself.

## The wrong first move

The stated cause has an obvious home: line-symbol placement applies a perpendicular
offset to sit a glyph beside or on a line, and "the offset is miscomputed" is exactly
the kind of one-variable bug you want a report to hand you. So the first move was to
open the arrow-anchor code and find the offset to correct.

There is no offset to correct. The arrow anchor is set to the interpolated point
_on_ the sampled polyline:

```ts
_samplePosOut[0] = _pxScratch[i] + dx * t
_samplePosOut[1] = _pxScratch[i + 1] + dy * t
// _samplePosOut[2] is only the tangent angle, for icon-rotation-alignment=map
```

`t` walks along the segment; there is no line-normal term anywhere. The arrow is
already _on_ its polyline, by construction. So the perpendicular-offset theory is
refuted — not "probably fine," but provably not the mechanism, because the code that
would implement the offset does not exist. Which reframes the whole bug: if the arrow
is exactly on its polyline and still beside the road, then _the polyline the labeller
sampled is not the road the GPU drew._

That is a completely different bug from the one the report described, and you only
reach it by disproving the report.

## What actually happened

The label pass and the GPU read the same tiles through different doors. The vertex
renderer draws the finest tile available for a screen region; when a needed tile is
still loading, it stretches a coarser _ancestor_ tile to fill the gap. The label
pass, to survive tile eviction and world-copy fan-out, walks a union:

```ts
seen.clear()
if (neededKeys) for (const k of neededKeys) seen.add(k)
for (const k of stableKeys) seen.add(k) // folds in parent-stretch fallbacks
```

So when a fine descendant tile _and_ its coarse ancestor both carry a road, the
labeller samples **both** polylines and emits an arrow on each. The GPU draws only
the fine one. The arrow riding the coarse, stretched ancestor stripe is the one
sitting beside the road. Same feature, two geometries, and the labeller had no reason
to prefer the one actually on screen.

## The wrong second move

Now the comment's fix looks right: if the ancestor fallbacks are the problem, walk
`neededKeys` only and drop `stableKeys`. One line. It even matches the diagnosis.

It is a revert of a change the repository already made and already backed out. The
walk carries a comment dated to the day it was reverted:

> neededKeys-only was tried and reverted — it hid antimeridian world-copy tiles
> (2026-05-13 OFM Bright regression).

Near the antimeridian, the sibling world copies that make a road wrap around the
seam live in `stableKeys`, not `neededKeys`. Dropping `stableKeys` doesn't just
remove coarse ancestors; it removes those siblings, and the road labels stop wrapping.
The proposed fix trades a visible bug at Seoul for a visible bug at ±180°. The repo
had walked this exact path once and turned back.

## The fix

The two failure cases are distinguishable, so the dedup can keep exactly the keys it
needs. A coarse ancestor is redundant when a strict _descendant_ of it is also in
`seen` carrying line data — that descendant is what the GPU draws. An antimeridian
sibling is a _same-zoom_ world copy that is an ancestor of nothing needed. Ancestry,
not membership, is the discriminator:

```ts
for (const k of seen) {
  const td = source.getTileData(k, sliceLayer)
  if (!td?.lineVertices || td.lineVertices.length < STRIDE * 2) continue
  let pk = k
  while (pk > 1) {
    pk = tileKeyParent(pk)
    if (seen.has(pk)) shadow.add(pk) // pk is a redundant ancestor of a drawn key
  }
}
// …then skip any key in `shadow` during emission.
```

The ancestor gets shadowed by its drawn descendant and stops emitting; the
antimeridian sibling, an ancestor of no needed key, is never shadowed and still emits.

## How we know it holds — and what we don't

The suppression is pure set logic over tile keys, so its correctness is provable
without a GPU. Two unit cases pin it: a z14 needed tile with its z12 ancestor both
carrying a feature emits only the descendant, and two z1 world-copy siblings (ancestors
of nothing needed) both still emit — a direct guard against the 2026-05-13 regression
the naive fix would have reintroduced. Reverting the shadow pass fails the first and
passes the second; the gate discriminates the two regimes rather than counting
emissions.

What it does _not_ prove is the thing the report actually cared about: that the arrows
now land on the centreline at z22 Seoul. That is a claim about pixels, and pixels need
the mandated real-GPU directional pixel-diff, which is recorded as pending. There is
also an honest residual: the shadow is at tile granularity, so in a transient state
where two sibling tiles share a parent and only one has loaded, the parent is shadowed
and briefly under-labels the still-loading sibling's region — a flicker, strictly
milder than a persistent off-road arrow, and gone once the tile arrives.

## What generalizes

A precise bug report is a hypothesis wearing the costume of a conclusion. This one
carried two — a cause and a fix — and both were plausible, and both were wrong: the
cause named a mechanism whose code doesn't exist, and the fix named a change already
tried and reverted for breaking somewhere else. The move that beat both was cheap and
unglamorous — read the anchor code, read the walk's comment history — and it is the
move a good report actively discourages, because a good report makes the reading feel
redundant. When the fix is a one-liner someone already wrote, the most useful question
is not "does this work" but "why isn't it already here." The `git blame` on the line
you're about to change often answers it.
