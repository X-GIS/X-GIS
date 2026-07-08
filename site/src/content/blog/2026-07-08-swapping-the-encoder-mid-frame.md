---
title: 'Swapping the command encoder without stopping the frame'
description: "Moving map's render passes behind the RHI one at a time meant two encoders — native and RHI — had to share a single frame and a single submit. Why createCommandEncoder was the wrong tool, and the wrapper that let a native encoder be driven through the RHI interface for one pass at a time."
date: 2026-07-08
tags: ['rhi', 'architecture', 'webgpu', 'refactoring']
lang: en
---

X-GIS renders a frame as a sequence of passes: background, points, opaque,
translucent, order-independent transparency, heatmap, overdraw, graphics. On the
WebGPU path each pass records into one `GPUCommandEncoder`, and the render loop
`submit`s that single encoder's buffer once at the end of the frame. One encoder,
one submit, per frame. That invariant is load-bearing — passes share depth
buffers and intermediate targets, and splitting the submit would break ordering
and cost a GPU sync.

The migration in flight: convert those passes, **one at a time**, to record
through the RHI (`RhiCommandEncoder` / `RhiRenderPass`) instead of the native
encoder, so the backend becomes swappable. The catch is the "one at a time." You
cannot convert eight passes in a single commit and expect to verify each in
isolation — that's a big-bang change with no per-step pixel gate. You want to
convert *pass N*, prove DC=0 against the previous frame, then convert *pass N+1*.

Which means, mid-migration, the frame is half-and-half: some passes still record
natively, some record through the RHI — **and they must share the same encoder
and the same submit.**

## Why `createCommandEncoder` is the wrong tool

The obvious RHI call is `rhi.createCommandEncoder()`. It exists; it returns an
`RhiCommandEncoder`; the converted pass could use it. But look at what it does on
the WebGPU backend:

```ts
createCommandEncoder(label?: string): RhiCommandEncoder {
  return new WebGpuCommandEncoder(this.device, label) // device.createCommandEncoder()
}
```

It mints a **new** native `GPUCommandEncoder`. So a half-migrated frame would
have *two* encoders — the render loop's original native one (still used by the
un-migrated passes) and the RHI's fresh one (used by the migrated pass). Two
encoders means two command buffers means two `submit`s, and the moment you have
two submits you've broken the one-submit-per-frame invariant: pass ordering
across the two encoders is no longer guaranteed by recording order, shared
targets get a pipeline-barrier surprise, and the whole point of the incremental
migration — *prove each step changes nothing* — is lost, because step one already
changed the submit topology.

To be honest about the epistemics: we did not *observe* a two-encoder frame come
out mis-ordered. This failure is reasoned from the invariant, not from a broken
screenshot — and deliberately so. The seam landed **inert**, with zero callers,
exactly so the two-submit topology never had to exist in a running frame to be
believed wrong. When a property is guaranteed by construction (recording order
determines execution order *only within one encoder*), the disciplined move is
to preserve it, not to first violate it and photograph the damage.

`createCommandEncoder` is right for *code that owns its whole frame*. It is
exactly wrong for *code migrating into a frame someone else already owns*.

## Wrap the encoder that already exists

What the migrated pass actually needs is to drive the render loop's **existing**
native encoder through the RHI interface — same underlying `GPUCommandEncoder`,
same eventual single submit, just addressed via `RhiCommandEncoder` methods so
the pass body can be written backend-neutrally. That's a wrapper, not a factory:

```ts
// rhi-webgpu/src/rhi-webgpu.ts
export function wrapWebGpuCommandEncoder(
  device: GPUDevice,
  enc: GPUCommandEncoder,
): RhiCommandEncoder {
  // ownsSubmit = false → finish() is a no-op; the render loop still owns submit.
  return new WebGpuCommandEncoder(device, { wrap: enc })
}
```

The encoder class grew one bit of state to make this safe:

```ts
class WebGpuCommandEncoder implements RhiCommandEncoder {
  private readonly enc: GPUCommandEncoder
  private readonly ownsSubmit: boolean

  constructor(device: GPUDevice, labelOrWrap?: string | { wrap: GPUCommandEncoder }) {
    if (typeof labelOrWrap === 'object') {
      this.enc = labelOrWrap.wrap   // adopt the render loop's encoder
      this.ownsSubmit = false
    } else {
      this.enc = device.createCommandEncoder(/* … */)
      this.ownsSubmit = true
    }
  }

  finish(): void {
    // Owns its encoder → finish AND submit here. Wrapped → do nothing; the render
    // loop finishes + submits the real encoder at end-of-frame.
    if (this.ownsSubmit) this.device.queue.submit([this.enc.finish()])
  }
  // beginRenderPass / copyBufferToBuffer / etc. all forward to this.enc
}
```

`ownsSubmit` is the whole idea. A wrapped encoder **forwards** every recording
call (`beginRenderPass`, copies, …) to the render loop's real
`GPUCommandEncoder`, but its `finish()` is a no-op — because the render loop, not
the pass, calls `finish()` and `submit()` on the real encoder at end-of-frame.
The migrated pass records into the exact same command stream as the native
passes, in the exact same order, and the frame still ends in one submit.

The return type carries the safety. `RhiCommandEncoder.finish()` returns
`void`, not a command buffer — so a converted pass has *nothing to submit* and
no handle to mis-submit. This matters because a pass author's muscle memory is
"finish the encoder when I'm done recording." If `finish()` handed back a real
`GPUCommandBuffer`, a migrated pass could do exactly that and enqueue a second,
partial submit — the very split the wrapper exists to prevent. Because the
wrapped `finish()` is inert and returns nothing, an over-eager pass calling it
mid-frame is a no-op, not a bug: the loop's single end-of-frame submit remains
the only one that fires.

## What this buys the migration

With the wrapper in place, converting a pass is a genuinely local change with a
real gate:

1. The render loop still creates its one native `GPUCommandEncoder`.
2. It exposes it wrapped — `frameCtx.rhiEncoder = wrapWebGpuCommandEncoder(device,
   nativeEnc)` — alongside the raw one the un-migrated passes still use.
3. Pass N is rewritten to record through `frameCtx.rhiEncoder` (RHI calls),
   while passes 1…N-1 and N+1…8 keep using the native encoder.
4. Both write into the same underlying encoder; the loop finishes and submits
   once, unchanged.
5. Run the pixel gate: this frame vs the previous commit, directional diff,
   DC=0. Because the command stream and submit topology are byte-identical, a
   correctly-converted pass produces an identical frame. A mistake shows up as a
   non-zero diff *on that one pass*, localized.

The invariant the migration must not disturb — one encoder, one submit — is
preserved at every intermediate step, which is what makes "one pass at a time
with a pixel gate between" actually possible instead of aspirational.

## The general shape — and where it stops

When you migrate code into a resource that a larger loop already owns and
finalizes — an encoder, a transaction, a batch, a frame buffer — the instinct to
*create a fresh one from the new abstraction* is usually wrong. Creating a second
owner splits the finalize step (submit / commit / flush), and the split is
exactly the thing that makes incremental migration unverifiable, because step one
already perturbs the global topology you were trying to hold constant. Reach
instead for a **wrapper that adopts the existing resource and disclaims ownership
of finalization** — forward the mutations, no-op the commit.

But adopt-and-disclaim has a precondition worth naming: it assumes there *is* an
existing resource to adopt. That assumption is backend-specific, and the other
backend breaks it. The WebGL2 device implements the same `RhiCommandEncoder`
interface — but WebGL2 is immediate-mode and has **no `GPUCommandEncoder` at
all**. There is no native encoder to wrap, and no command buffer to submit;
`copyBufferToBuffer` executes at call time via `copyBufferSubData`, and the
per-frame submit analog is a `gl.flush()` elsewhere. So `WebGl2CommandEncoder`
satisfies the contract with `finish()` as a no-op too — but for the *opposite*
reason. The WebGPU wrapper no-ops `finish()` because *someone else* (the loop)
will finalize; the WebGL2 encoder no-ops it because *nobody* finalizes — the work
already happened. Same `finish(): void` signature, two unrelated justifications.

That is the real lesson under the wrapper. The `RhiCommandEncoder` contract
isn't "an encoder you finish"; it's "a place to record, whose finalization the
*backend* defines." The interface deliberately says nothing about *who* submits
or *whether* a submit even exists — which is what lets one backend adopt a
borrowed encoder, another own a fresh one, and a third disclaim the whole notion,
all behind one `finish(): void`. Adopt-and-disclaim is one valid implementation
of that freedom, not the meaning of the interface. When you design the seam,
encode the *permission* (finalization is the backend's business), not the
mechanism.
