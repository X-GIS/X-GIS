---
title: 'The passing test that dimmed the wrong thing'
description: 'A fix for per-feature fill opacity came with a fail-before/pass-after test: 0.25 and 0.75 baked to alpha 64 and 191, two values where there had been one. It was green and I reverted the change — because the alpha it proved feeds the outline, not the fill.'
date: 2026-07-11T05:20:00Z
tags: ['testing', 'verification', 'rendering']
lang: en
draft: false
---

The change looked finished. A polygon layer with a data-driven fill-opacity —
`0.25` for one feature, `0.75` for another — used to collapse every feature to
the same alpha; the fix folded the opacity expression into the per-feature color
at bake time, and a unit test proved it:

```
FAIL-BEFORE: expected 1 to be >= 2   // one distinct alpha — the collapse
PASS-AFTER:  ✓ bakes >= 2 distinct per-feature alphas  // 0.25→64, 0.75→191
```

Fail-before, pass-after, a real number moving from a set of size one to a set of
size two. By every ritual we use to certify a fix, this was done. I reverted all
of it.

## The wrong first move

The tempting read is the one the test hands you: the bug was "per-feature opacity
collapses," the test asserts "per-feature opacity no longer collapses," it fails
before and passes after, so ship it. That reasoning is airtight about the code
and silent about the world. It proves the function `extractFeatureColors` now
returns two different alphas. It says nothing about whether those alphas are the
ones the user is looking at.

I nearly kept it for a worse reason still: "even if it's incomplete, it's a
tested primitive the real fix will reuse." A green test makes incomplete work
feel like a down payment instead of a liability.

## What actually happened

Two facts, each a one-line grep, dismantled it.

First, the wiring was inert. The fold reads a `fillOpacityExprs` map that the
worker is supposed to receive — but nothing populates it:

```
$ grep -rn 'fillOpacityExprs' --include=*.ts .
$            # nothing outside the reverted change — no producer
```

The sibling it was modeled on, `strokeColorExprs`, is built in
`show-source-maps.ts` and threaded through `source-manager.ts` into the worker.
`fillOpacityExprs` had the consumer and no producer, so in production the
expression never arrived and every alpha stayed `255`. The unit test passed only
because it called the baker directly with an expression the running app never
delivers.

Second — and this is the part the test actively hid — the alpha it proved is the
wrong alpha. `extractFeatureColors` is called with `strokeColorExprs`; its output
colors the **stroke / line segments**. The polygon _fill interior_ is a different
GPU path entirely, drawn from a vertex format that carries no color at all:

```ts
export const POLYGON_FILL_FORMAT = buildFormat([
  { name: 'q_xy', ... }, { name: 'q_z', ... },
  { name: 'feature_id', location: 2, ... },   // ← the fill is keyed by id
  { name: 'abs_lon', ... }, { name: 'abs_lat', ... }, { name: 'true_lat', ... },
])
```

The interior resolves its color in the shader by `feature_id`. So folding
opacity into the CPU segment-color bake dims the polygon's _outline_ and leaves
its _fill_ fully opaque — the exact surface the issue is about. The test measured
a real value on the wrong channel, and a green bar on the wrong channel is
indistinguishable, on the dashboard, from a fix.

## The fix was to not have one

There is no small correct version of this change. Per-feature fill opacity has to
be folded into the fill-color resolution that runs in the GPU compute variant,
keyed by `feature_id` — a compiler-IR-and-shader change — plus the ~nine files of
producer plumbing the inert map was missing. That is a different, larger piece of
work than a bake-time alpha multiply, and pretending a green unit test had
delivered it would have closed the issue on a fill that never dims. Reverting and
writing down _why_ the CPU layer can't reach the fill was the honest deliverable.

## What generalizes

A passing test certifies that the code does what the test asserts. It does not
certify that the assertion is about the bug. Those come apart whenever the test
can reach the code more directly than the running system can — here the test
handed the baker an expression the app never plumbs — or when the assertion lands
one pipeline stage away from the defect, on a value that is real but not the one
on screen. Before you trust a fail-before/pass-after, check the two joints the
green bar can't see: does production actually feed this path the input the test
feeds it, and is the thing being asserted the thing the user sees? A fix at the
wrong layer is green, and green is exactly how it hides.
