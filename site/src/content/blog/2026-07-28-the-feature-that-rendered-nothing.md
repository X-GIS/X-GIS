---
title: 'The feature that rendered nothing'
description: 'Nine commits, 3900 green unit tests, a green typecheck and fifteen green CI checks, and the layer drew zero pixels. Two independent breaks, neither visible to any of them: skipping the drape arm to say "this portrayal paints no drape" also skipped the coverage UPLOAD, and the store took its advected draper and its frame-side source as one constructor argument although the two become available in that order. The render gate found both on its first run, before a human ever looked at the map.'
date: 2026-07-28T06:30:00Z
tags: ['rendering', 'verification', 'architecture']
lang: en
draft: false
---

The gate printed one number and the whole feature fell over:

```
Error: the advected field rasterises too
expect(received).toBeGreaterThan(expected)
Expected: > 0.005
Received:   0
```

Zero painted pixels. Behind it: nine commits, 3900 passing unit tests, a green
`bun run build`, and fifteen green CI checks. The S-111 arrows were supposed to
be drifting through the current. They were not drifting, because they were not
there.

## Two breaks, and neither one is a typo

**The drape arm was also the upload.** The new portrayal advects the catalogue
glyphs themselves, so the image-based drape underneath has nothing left to
contribute — drawing both would put two independently-advected motion layers on
top of each other, visibly disagreeing about the same current. The way to say
"this layer draws no drape" was to skip the arm:

```ts
const arm = coverageDrapeArm(show)
if (!arm.draw) return
this.coverageRenderer.setCoverage(handle, { … }, region)
```

`setCoverage` is also what uploads the coverage's textures — including the
velocity pair the arrows read. Skipping the arm to express a PAINTING decision
silently withdrew the DATA. The arrow field then had no velocity textures to
build from, so no batch was ever created.

**The draper and its source arrived in the wrong order.** The store needed two
things for an advected batch: a draper (a pipeline) and a frame-side source
(where the arrows currently are). It took them as one argument:

```ts
attach(rhi, draper, advected?: { draper: …; source: … })
```

The draper exists at `attachDevice`. The source is a `FlowRenderer`, which
`buildSceneRenderers` constructs _after_ that. So the pair was `undefined` at
every attach, and the guard did exactly what it was written to do:

```ts
if (advected && !this.advectedDraper) return // …every batch, always
```

Both breaks are one line each. Both are the kind of line that reads correctly in
review. And both were invisible to every gate we had.

## Why 3900 tests were green

They were green honestly, and each one was testing something real.

The shader emit was asserted against the emitted WGSL — bindings, entry points,
the fact that the band lookup traces back to the decoded state position. The
packer was asserted slot by slot. The store's lifecycle was asserted through the
manager's public surface with a stub device. The step's ping-pong was asserted
against a recorder: renders into the write side, swaps after the draw, memoizes
its bind group per side.

Every one of those tests injects its own dependencies. That is what makes them
fast and deterministic, and it is also why not one of them could observe that in
the real assembly the source arrives after the attach, or that the arm which
decides painting is the arm which performs the upload. Those are facts about how
the pieces are _composed_, and a test that composes them itself cannot see them.

This is the same shape as [the pipeline that was right somewhere
else](/blog/2026-07-27-the-pipeline-that-was-right-somewhere-else/): a
relationship between two objects that live in different files and only meet at
runtime.

## The gate that caught it, and why it is not a pixel count

A painted-fraction threshold would have caught _this_ failure — zero is zero —
and would have passed happily on the next one, because a field frozen at its
origins and a field of arrows drawn at garbage positions paint the same number
of pixels. So the gate states two directional claims, each a ratio against a
measured baseline:

| quantity                                    | value  |
| ------------------------------------------- | ------ |
| same-code noise floor                       | 0.0000 |
| parity: static portrayal ↔ advected frame 0 | 2.17   |
| moved: advected frame 0 ↔ +3 s              | 4.43   |

The first claim is the one worth stealing. The origins seed the position state,
so **frame 0 of the advected field is exactly the static catalogue placement**.
That turns "does the GPU path work" into a parity question between two
independent implementations of one rule: the static path bakes colour and size
on the CPU from the band ramp and the scale rule, while the advected vertex
shader looks them up on the GPU from an uploaded table, at a position it decoded
from a texture. If the band table, the normalization by peak speed, the scale
rule or the origin encoding were wrong in any way, the two fields would not
agree — and no threshold has to be invented to say so.

The second claim then only has to beat the noise floor, which is measured rather
than assumed. On this deterministic software rasteriser it is exactly zero.

## The trap inside the gate

The first version of the gate would have passed over a frozen field, and the
reason is worth writing down.

The advected field animates every frame, so the adaptive quality ladder read the
sustained load and stepped the device pixel ratio down: **1 → 0.72 → 0.5 within
three seconds**, measured. Every pixel in the frame then changes for a reason
that has nothing to do with arrows moving. "The field changed" would have been
true of a field that never moved at all.

It also turned the glyphs into formless blobs at ×8 — no shaft, no arrowhead. I
spent a while treating that as a shape bug in the vertex shader before checking
the drawing buffer's dimensions and finding the canvas rendering at half
resolution and being upscaled. Pinning the resolution (`adaptive=0`) restored crisp catalogue arrows,
off the grid lattice, still band-coloured.

Two lessons, one of them embarrassing. The gate must control the quality ladder,
or its own metric is contaminated by it. And reading an image at ×8 tells you
what the pixels _are_, but not why they are that way — the drawing buffer's
dimensions were one property call away and would have saved the detour.

## What changed structurally

`CoverageArmOptions` gained `hidden`, so residency and painting are separate
questions:

```ts
/** RESIDENT BUT NOT DRAWN. The region's textures — the velocity pair above all —
 *  are uploaded and available to everything that reads them, while the drape
 *  itself paints nothing. */
hidden?: boolean
```

And the store takes its draper at attach, its source through a setter, and
requires both to add a batch — which is the honest encoding of "these arrive at
different times, and both are needed."

Neither change is clever. The value is in the failure that forced them, which no
amount of unit testing was going to produce, and which one headless WebGL2
render produced on the first try.

## The rule this is filed under

There is a GPU here. WebGL2 renders headlessly under SwiftShader — it is what
the CI render-gate leg drives — and only WebGPU has no software adapter. "I
cannot verify this without a GPU" was available as an excuse for this entire
feature, and it was false for the half that mattered.

The feature drew nothing for six commits. It would have drawn nothing for six
more.
