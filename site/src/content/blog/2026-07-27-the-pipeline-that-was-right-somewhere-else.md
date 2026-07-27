---
title: 'The pipeline that was right somewhere else'
description: 'A copied line — depthCompare: always — turned every SetPipeline on an offscreen colour-only pass into a WebGPU validation error, so an entire animation layer never ran once. The line was correct in the draper it came from, because that draper draws into a pass that carries depth. Nothing in a GPU-less environment could see it: the step succeeded against a recorder, every test was green, and the only symptom was motion that never started. The gate that now catches it asserts the exact property the driver validates, through the same Material path production uses.'
date: 2026-07-27T15:00:00Z
tags: ['rendering', 'verification', 'webgpu']
lang: en
draft: false
---

A user pasted this from their browser console:

```
Attachment state of [RenderPipeline "flow-advect-pipeline"] is not compatible
with [RenderPassEncoder "flow-advect"].
  pass     expects { colorTargets: [0={format:R16Float}], sampleCount: 1 }
  pipeline has     { colorTargets: [0={format:R16Float}],
                     depthStencilFormat: Depth24PlusStencil8, sampleCount: 1 }
```

Three copies, one per frame. It reads like a warning. It was the whole feature
failing.

## What it cost

WebGPU requires a pipeline's attachment state to match the pass it is set on.
The advect pass is colour-only — one colour attachment, no
`depthStencilAttachment` — so the pipeline was rejected at `SetPipeline`, every
frame, forever. The image-based flow advection never executed a single step.

Which means the consumer built on top of it, a drape that samples the advected
field, had been sampling a texture nothing ever wrote. Two pull requests had
landed on the assumption that the producer worked. Both were green. Both were,
in the only sense that matters, dead.

## The line, and why it was correct

```ts
variants: [{ depthWrite: false, depthCompare: 'always', label: 'flow-advect-pipeline' }],
```

That came from `CoverageDraper`, verbatim, and in `CoverageDraper` it is right.
That draper draws inside the opaque pass, which carries a depth-stencil
attachment; `depthCompare: 'always'` is how you say "participate in this pass,
but do not depth-test". Correct, deliberate, tested.

The material layer then does this:

```ts
depthStencil: v.depthCompare || v.stencil ? { format: 'depth24plus-stencil8', … } : undefined
```

A **truthy** `depthCompare` synthesises the depth state. `'always'` is truthy.
So a line whose meaning is "do not depth-test" is also, silently, the switch
that says "this pipeline has depth". Move it to a pass without a depth
attachment and it becomes a hard incompatibility — with no diagnostic anywhere
in the source, because nothing in the source is wrong. Each half is correct;
only the pairing is not.

The fix is to delete both properties, leaving `depthStencil: undefined`.

## Why the tests could not have caught it

They were green, and they were green honestly. The step sequencing was verified
against a recorder. The uniform packing was verified by arithmetic. The binding
names were verified against the emitted shader. The pipeline's colour format was
verified to match the ping-pong pair's storage format — which it did.

What none of them asserted is that the pipeline's attachment state matches the
pass's, because that is a relationship between two objects that live in
different files and only meet inside a driver.

This is the shape worth naming: **a defect can be invisible not because the
tests are weak but because it exists only at a seam the environment cannot
instantiate.** A GPU-less harness can check everything about a pipeline
descriptor except whether a driver will accept it. The symptom — an animation
that never starts — is indistinguishable from a tuning constant set too low,
which is exactly what we had been telling the user was still unverified.

## The gate

The right gate asserts the property the driver validates, and reaches it through
the same path production uses — not a restatement of the fix:

```ts
const t = makeCtx({ backend: 'webgl2' })
new FlowRenderer(t.dev).step(frameAt(0), makeField())
expect(t.pipelines[0]!.depthStencil).toBeUndefined()
```

`makeCtx` hands `FlowRenderer` a recording device, so the descriptor under test
is the one `Material` actually builds — including the `depthCompare` inference.
Restoring the reported variant verbatim fails it:

```
AssertionError: the advect pass has no depth attachment, so its pipeline must
declare none: expected { Object (format, write, ...) } to be undefined
```

That is the fail-before that matters: not "does my new code pass" but "does the
exact reported production state fail".

## The generalisation

Sweeping the other material consumers — coverage, hillshade, line, point,
polygon fill, raster — every one draws into a pass that carries depth. The trap
was isolated to the single material that renders into an offscreen colour-only
target, which is also the newest one. That is not a coincidence: the copy came
from the nearest neighbour, and the nearest neighbour had a different
attachment topology.

**A pipeline variant is not portable between passes.** Copying a draper is
copying an assumption about the pass it draws into, and that assumption is
invisible at the copy site. When a material moves to a new pass topology, its
depth and sample state must be re-derived from that pass, not inherited from
where the code came from.

## What this does not fix

The advection now runs. Whether it _looks_ right is still a real-GPU judgement,
and the constants that decide it — modulation depth, advection rate, trail decay
— remain named, untuned placeholders. Unblocking a feature and verifying it are
different claims, and this post is only the first one.
