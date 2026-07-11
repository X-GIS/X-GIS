---
title: 'The winner was whoever loaded last'
description: "Two overlapping map labels swapped survivors on pan because the collision pass's tie-break was tile-dispatch order — reversed. The fix is a stable identity fed to the greedy allocator, and the gate is a permutation test."
date: 2026-07-11T01:00:00Z
tags: ['determinism', 'rendering', 'testing']
lang: en
draft: false
---

When two map labels overlap, exactly one survives the collision pass. In our
label pipeline, which one survived was a function of _which tiles happened to
be loaded_: with no explicit sort key, the collision input was iterated in
reverse dispatch order, and the greedy placer broke every remaining tie by
input position. Pan across a tile boundary, tiles re-arrive in a different
order, and the surviving label flips — the bug report's symptom was literally
"the winner changes when you move the camera."

This is not a label-rendering bug. It is the general shape of a bug: a greedy
allocator (first-come-claims-the-resource) whose iteration order is downstream
of I/O completion order. Any dedup, cache-admission, or placement pass with a
"stable sort, ties keep input order" comment sitting on top of a network is
nondeterministic in exactly this way — and it reproduces on no fixture,
because fixtures load in a fixed order.

## The wrong first move

The reversed iteration reads like gratuitous cleverness — the tempting cleanup
is to delete the reversal and iterate in plain input order. That would have
made the pass _deterministic per input order_ and still wrong: the reversal
was load-bearing. Reversing "last added wins" is how the pass gave
later-added labels precedence — which doubles as style-layer precedence when
input arrives in layer order. Deleting it would have silently inverted which
layer wins an overlap. (This one didn't fire — the existing z-order tests
would have caught it — but it is why "just remove the hack" was not the fix.)

The hack encoded a real requirement with the wrong key: _later layer_ wins was
implemented as _later arrival_ wins.

## What actually happened

The requirement got a name. The collision item grew a `tieBreak` — a stable
per-feature identity derived from keys that don't change when tiles reload:
layer precedence first (so later layers still win), then resolved text plus a
quantized world position for point labels, or the layer+route identity for
line labels. The greedy placer orders by sort key, then this identity, then
input index:

```ts
if (anyOrdering) {
  order.sort((a, b) => {
    const ka = items[a]!.sortKey ?? 0
    const kb = items[b]!.sortKey ?? 0
    if (ka !== kb) return ka - kb
    const ta = items[a]!.tieBreak
    const tb = items[b]!.tieBreak
    if (ta !== undefined && tb !== undefined) {
      if (ta < tb) return -1
      if (ta > tb) return 1
    } else if (ta !== undefined) return -1
    else if (tb !== undefined) return 1
    return a - b
  })
```

Two properties made this safe to land in a heavily-tuned pipeline. It is
additive: when no item carries either key, the sort is skipped entirely and
placement is byte-identical to the legacy order — every existing collision,
z-order, and dedup test passed unchanged. And it preserves the hack's intent
explicitly: the identity string sorts later layers first, which a dedicated
test pins ("later-layer-precedence id still wins the overlap").

## How we know it holds

Determinism claims need a determinism gate, and the gate is a permutation
test: feed the same label set to the pass in shuffled input orders and assert
the _surviving set_ is identical every time, plus the same check one level up
(`TextStage.prepare()` with `addLabel` calls in different dispatch orders).
Reverting only the two logic changes — comparator back to sortKey-only,
text-stage back to the reverse trick — failed four of the new tests, i.e. the
gate detects exactly the input-order dependence the report described, not
something adjacent to it.

What did _not_ land is as deliberate as what did: two neighbouring dedup paths
(a same-text distance check that ignores its own coordinates, and a 256 m
quantization lattice) are also order- or phase-dependent, but they interact
with tuned cross-tile behaviour that only a visual pass can vouch for. They
kept their issue with the stable identity noted as the prerequisite —
determinism of the _winner_ landed now; those follow.

## What generalizes

The reflex when you find an ordering hack is to remove it; the useful move is
to ask what requirement it smuggles in. "Reverse the input" meant _later wins_
— a real rule keyed to an accident. A greedy pass is deterministic only if
every decision is a function of item identity, and the cheapest proof of that
is a shuffle in a unit test: if your collision, dedup, or admission pass has
never run under a permuted input, its tie-breaks are load order, whether you
wrote that down or not.
