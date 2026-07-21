---
title: 'The label in front lost to the one behind it'
description: "At pitch 81° the near city label vanished and the far one stayed — because the collision pass's tie-break was a stable identity, and stable is not the same as correct. 'Seoul' < 'Shanghai' decided a depth question. The fix is a screen-Y proxy slotted between layer precedence and identity, and the same depth-blind bug was hiding in the icon pass too."
date: 2026-07-21T22:00:00Z
tags: ['labels', 'rendering', 'determinism', 'debugging']
lang: en
draft: false
---

Two weeks ago I fixed a label-collision bug whose symptom was "the surviving
label changes when you pan." The tie-break between two overlapping labels was
tile-dispatch order — reversed — so which one won was a function of which tiles
happened to be loaded. The fix ([_The winner was whoever loaded
last_](/blog/2026-07-11-the-winner-was-whoever-loaded-last)) was to feed the
greedy allocator a **stable per-feature identity**: resolved text plus a
quantized world position, so the same overlap resolves to the same winner
regardless of input order. A permutation test locked it.

It was deterministic. It was also, at pitch, wrong — and the way it was wrong
is the more interesting bug.

## The symptom

A site-demo report, one line and a camera hash: on the "layer below labels"
demo at `#2.90/42.29894/119.09100/30.0/81.4` — pitch **81.4°**, the camera
nearly grazing the horizon — "Shanghai is in front of Seoul, but it's Shanghai
that gets hidden." Shanghai sits lower on screen, nearer the camera; Seoul is
behind it and higher up. Their label boxes overlap. The one that survived was
the far one.

That is exactly backwards from every other map engine, and from physical
intuition: the thing in front occludes the thing behind, not the reverse.

## Stable is not the same as correct

The collision pass places greedily — first to claim its box wins — over a
deterministic order. After the determinism fix that order was:

```
sortKey  →  collisionId  →  input index
```

where `collisionId` is `<layerPrecedence>`, a `U+0000` separator, then `<featureIdentity>`, and
`featureIdentity` for a point label is its resolved text plus quantized
position. Two same-layer city labels therefore resolved by comparing their
identity strings. `"Seoul|…"` and `"Shanghai|…"`, lexicographically: `e` (0x65)
< `h` (0x68), so `Seoul` sorts first, claims its box first, and wins. Shanghai —
nearer the camera, drawn in front — loses to a string comparison of the second
letter of a city name.

The determinism fix did its job: the winner no longer flipped on pan. But I had
made the tie-break **stable** and quietly assumed stable meant **right**. A
stable key that encodes no depth information will happily, reproducibly, pick
the wrong label every single frame. Determinism is a property of the _mapping
from input to output_; it says nothing about whether the output is correct. I
had built a machine that gave the same wrong answer every time and called the
consistency a fix.

## The fix: a depth proxy, in the right slot

Mapbox and MapLibre place symbols **near-first**: their per-tile symbol sort is
by rotated screen-Y descending, so the label closer to the camera claims its
box before the one behind. On a pitched view "closer to the camera" is "lower
on screen" — larger screen Y.

So the missing term is screen Y. The delicate part is _where_ it goes in the
order. It cannot go first: layer precedence still has to dominate (a country
label must beat a water label regardless of which is lower on screen). It cannot
go last: then it never breaks the identity comparison that caused the bug. It
belongs **between** them — after the layer-precedence group, before the
per-feature identity:

```
sortKey  →  layer-group  →  nearY (screen Y, descending)  →  full identity  →  index
```

The `collisionId` already carried layer precedence as a prefix segment before a
`U+0000` separator. I split that segment out as the group key, compared it
first, then compared `nearY` (descending — larger Y, nearer, places first),
then fell through to the full identity for the genuine tie (same layer, same
screen row, e.g. a flat north-up view of two labels at one latitude). The
wiring is a single field at the collision-input site:

```ts
nearY: s.layouts[0]?.draw.anchorY,
```

The one property I did not want to lose was byte-identity for everything that
was already correct. It falls out of the separator choice: `U+0000` is the
minimum code unit, so comparing `(group, whole-string)` as a tuple is identical
to comparing the whole string directly — **whenever `nearY` doesn't
intervene**. Labels with no `nearY`, imperative overlays, styles driven by
`symbol-sort-key`, and the explicit `symbol-z-order` modes all order exactly as
before. Only the depth-tied case moves, and it moves the right way.

## The wrong first move

The tempting one-liner is "just sort the whole draw list by screen Y." It is
wrong twice over. First, draw order is not collision order — Y-sorting what gets
_drawn_ doesn't change what gets _dropped_, and the bug is a drop. Second, and
worse, a global Y-sort silently breaks layer precedence: a later-layer label
that happens to sit higher on screen would be drawn under an earlier-layer label
below it, inverting the whole stack. The screen-Y term is only safe **inside a
layer group**, which is exactly why the slot in the ordering matters more than
the term itself.

## The same bug, one subsystem over

Once you can name a bug — _a greedy allocator whose ordering key is
depth-blind_ — you can go looking for its siblings. Text collision was one site.
The icon overlap pass (`#417`, the one that collapses two parallel roads'
direction arrows into a single chain) was another: it iterated the pending icons
in **dispatch order** and dropped any whose padded box overlapped an
already-placed one. Same greedy-first-wins shape, same depth-blindness — on a
pitched road the far arrow claimed the box and the near arrow disappeared.

The fix is the same idea: decide the collide-icon survivors in a nearest-first
pass (larger anchor-Y first, dispatch order as the stable tie on an exact Y
match), then emit the draws in the original order so painter order is untouched.
Equal-Y arrows — a flat road, the overwhelmingly common case — collide
byte-identically to before.

## What actually settled it

Three gates, because a render claim needs more than "looks right":

- **Fail-before, twice.** The near-first cases were red before the change — for
  text and, separately, for icons — and I proved the wiring was load-bearing by
  stashing just the one field and watching the reds come back. A test that has
  never failed is a test whose subject you haven't identified.
- **Permutation invariance survived.** The determinism property from the
  previous fix is a regression risk for any change to the same comparator, so
  the permutation test stayed and stayed green: the near label wins in _every_
  input order, not just the one the demo happens to produce.
- **The pixels moved, and only where they should.** At the reported camera the
  drawn set flipped `Seoul→Shanghai`, `Tokyo→Ōsaka`, `Dhaka→Kolkata` — three
  overlapping pairs, each now keeping the front label. The before/after
  directional diff was 2015 changed pixels, and read at full resolution in a
  4×4 split every one of them was a glyph-shaped label swap at those three
  sites: no positional-shift edge pairs, no fill blocks, no drift anywhere else
  in the frame.

## The takeaway

When you replace a flaky ordering with a stable one, you have answered
"_which_ input decides?" — you have not answered "_is the decision right?_"
Those are different questions, and a passing determinism test can only see the
first. A tie-break key should be interrogated for what it actually encodes:
`Seoul < Shanghai` is a fact about spelling, and it was deciding a fact about
depth. The moment your allocator's order is queried by an axis the key knows
nothing about — depth, recency, priority — stable just means you'll be wrong the
same way forever.
