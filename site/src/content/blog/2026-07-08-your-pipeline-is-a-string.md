---
title: 'Your render pipeline is just a string'
description: "217 GPURenderPipeline references stood between @xgis/map and backend-neutrality. Most of them turned out not to be pipelines at all — they were labels being matched. Collapsing them to a neutral { label } handle, and how prove-or-refute kept us from doing the wrong migration."
date: 2026-07-08
tags: ['architecture', 'rhi', 'refactoring', 'types']
lang: en
---

The goal: make `@xgis/map` depend on `@xgis/engine` alone, so it names no
`@webgpu/types` symbol and the backend (WebGPU / WebGL2) is chosen inside the
engine. The obstacle: `map/src` has ~700 `GPU*` type references, and the single
densest cluster is `GPURenderPipeline` — 217 of them, concentrated in the vector
tile renderer, the pipeline factory, the bind-group registry, and the bucket
scheduler.

The plan on paper (an architect's scoping) said: *swap
`device.createRenderPipeline` for `rhi.createPipeline`*. The RHI already has a
backend-neutral `createPipeline(RhiPipelineDesc)` that emits the same WGSL, and
it's byte-identity tested. Adopt it, and `GPURenderPipeline` becomes
`RhiPipeline`. Clean.

Except it isn't, and a prior migration attempt had already been reverted for
going the wrong direction. So before touching 217 references, we proved what
those references actually *are*.

## The claim, and the proof

**Claim:** the vector-tile renderer's fill/line pipeline objects are *draw
inputs* — the renderer calls `setPipeline(pipeline)` with them, so they must be
real backend pipelines.

We went looking for the witness — a native `pass.setPipeline(fillPipeline)` in
the VTR:

```
$ rg 'setPipeline' vector-tile-renderer.ts
3529:   *  method this calls on `pass` (`setPipeline`, `setBindGroup`, …)
4036:        // The 6 GPU commands below (setPipeline, setBindGroup, …)
```

Both hits are *comments*. There is no live `pass.setPipeline` in the VTR. The
fill draw goes somewhere else:

```ts
// recordTileFill → recordFillDraw
recordFillDraw(this._fillRhi, encoder, pipeline, tileBg, slotOffset, cached, bindZBuffer)
```

And `recordFillDraw` does this with the `pipeline` it's handed:

```ts
// Match the draw pipeline to its built Material twin. IDENTITY FIRST, then
// LABEL fallback (dual-instance safe). executeItems runs the twin's OWN
// (descriptor-equivalent) pipeline, so a label match is exact.
const eq = (a) => pipeline === a || (!!pipeline.label && !!a && pipeline.label === a.label)
```

There it is. The `pipeline` object is never bound. It is a **routing key**:
`recordFillDraw` matches it — by object identity, falling back to its stable
factory `.label` — to a pre-built RHI *Material* twin, and `executeItems` runs
the Material's own pipeline. The native `GPURenderPipeline` the pipeline factory
built is threaded through the whole renderer solely so that, at draw time, its
`.label` can be compared against a Material's `.label`.

∴ The VTR path never needs a pipeline. It needs a `.label`. Converting those
217-in-the-VTR-path references to `rhi.createPipeline` would be pointless — the
draw already runs through RHI; the native objects are dead weight used as map
keys.

## The neutral handle

If the only thing read off these objects is `.label`, the type that describes
them is:

```ts
// @xgis/rhi
export interface RhiPipelineHandle {
  readonly label: string
}
```

A `GPURenderPipeline` *is* structurally an `RhiPipelineHandle` (it has a
`label`). So the pipeline factory keeps building real native pipelines, and they
flow — unchanged, same objects — into fields now *typed* `RhiPipelineHandle`.
The renderer's fill-state, `recordFillDraw`'s parameter, the bind-group
registry's stored pipelines, the bucket scheduler's threaded closures: retyped
`GPURenderPipeline → RhiPipelineHandle`, one connected graph.

It cascades exactly as far as the routing keys reach and no further:

- `polygon-fill-material` (FillRhiState + recordFillDraw): 17 refs.
- `vector-tile-renderer`: 17 refs.
- `bind-group-registry`: 23 refs.
- `bucket-scheduler`: 30 refs.

**87 references**, and the compiler stops there — because the *boundary* is
clean. The pipeline **factory** still names `GPURenderPipeline` (it creates
them). `renderer.ts` (the direct-geometry path) and the compose passes still
name it (they *do* call native `setPipeline`). But those are on the other side
of the routing-key graph, and a native `GPURenderPipeline` assigns into an
`RhiPipelineHandle` field structurally, so nothing at the boundary breaks. The
whole VTR-path pipeline threading — the largest `@webgpu/types` concentration in
map — now names no WebGPU pipeline symbol.

## Why this is a type-only change

Nothing at runtime moved. The `sed` that did the retype touched only type
annotations; the pipeline objects are identical, `recordFillDraw`'s label-match
and identity-match logic is byte-for-byte the same, the emitted JavaScript is
unchanged. We verified it the way you verify a claimed no-op: full build green,
the renderer's 292 unit tests unchanged, and a real WebGL2 render (fills, lines,
pick) producing the same output. A type-level refactor that reduces coupling and
compiles to identical bytes is the cheapest kind of architectural progress there
is — *if* you've correctly identified what the types describe.

## The meta-lesson: name the thing by what's read off it

The wrong migration (swap the create call) and the right one (collapse to a
label handle) start from the same 217 references. The difference is entirely in
having *proven* what those references are used for. A confident static read —
"they're pipelines, they get drawn" — would have sent us swapping 217 create
calls for no benefit, or worse, breaking the routing.

The discriminator was a two-line search (`rg setPipeline` → both hits are
comments) plus reading the six lines of `recordFillDraw`. That's the whole
proof. It reframed "a pipeline" as "a label that happens to be carried on a
pipeline object," and once you see the object by what's actually read off it,
the neutral type writes itself.

Types should describe the *contract a value is used under*, not the concrete
class that happens to satisfy it. When a `GPURenderPipeline` is threaded through
four files only to have its `.label` compared, its contract is `{ label:
string }` — and saying so, out loud, in the type, is what lets the whole path
cross a package boundary it looked hopelessly entangled with.
