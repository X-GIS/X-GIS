---
title: 'Slicing a 700-reference coupling into moves you can verify'
description: "@xgis/map named backend types in ~700 places. You cannot cut that in one commit and stay honest. The method: sort every reference into layers by how it's actually used, find the one clean move, and prove each slice compiles to identical bytes before the next."
date: 2026-07-08
tags: ['architecture', 'refactoring', 'methodology', 'rhi']
lang: en
---

`@xgis/map` had roughly 700 references to WebGPU-specific types spread across 71
files. The architectural goal was one sentence — *map depends on `@xgis/engine`
only; the engine picks the backend and gets the RHI interface injected* — but 700
references is not one change. It's a migration, and migrations that land as a
single "fix all the coupling" commit are unverifiable: if the frame breaks, you
have 700 suspects and no bisect.

The method that worked was not "start editing." It was "sort first." Every one of
those 700 references is a *different kind* of coupling, and the kinds want
different treatment — some are free, some are hard, and one or two are actually
impossible to move without a separate upstream migration. You have to know which
before you touch a line.

## Sort by how the value is used, not by its type

The naive sort is by type name: 217 `GPURenderPipeline`, N `GPUBuffer`, M
`GPUTextureView`, and so on. That grouping is useless, because two references to
the same type can have completely different couplings. The useful sort is by
**what the code does with the value.** Three buckets emerged:

**Layer-0 — pure routing keys.** Values that are stored and compared but never
*used* as a backend object. The biggest surprise here: most of map's
`GPURenderPipeline` references are never bound to a render pass — they're matched
by `.label` to route a draw to its RHI Material twin. A value read only for its
`.label` doesn't need a backend type at all; it needs `{ label: string }`. These
are *free* to move — retype to a neutral handle, zero runtime change, identical
emitted bytes. (Covered in depth in a companion post.)

**Layer-1 — backend-neutral symbols that just live in the wrong package.** Types
and small classes that are already backend-agnostic but happen to be *defined* in
map or in the concrete backend package, so referencing them creates a bad edge.
`RhiContext`, `RhiDeviceLostInfo`, `BackendChoice` — move the *definition*
upstream (to `@xgis/rhi`), import from `@xgis/engine`, done. The reference stops
being a coupling the instant the symbol it names lives upstream.

**Layer-2 — genuine native GPU handles on the hot path.** Places where map holds
a real `GPUBuffer`/`GPUTextureView`/`GPUCommandEncoder` and *calls native methods
on it* — writes, copies, `beginRenderPass`. These cannot be retyped away. They
need real RHI-ification: the underlying operation has to go through
`RhiCommandEncoder` / `RhiBuffer`, which is a behavioural change requiring a pixel
gate per pass. This is the expensive bucket, and it's where the milestone's
remaining work lives.

The sort is the plan. Layer-0 and Layer-1 are cheap and land first (they buy the
biggest reference-count reduction for the least risk); Layer-2 is carved into
per-pass slices each with its own gate.

## Prove which "moves" are actually clean

Sorting suggests moves; it doesn't validate them. For Layer-1, the instinct is
"just move all the neutral-looking symbols to the engine." That instinct is
wrong more often than it's right, because a symbol that *looks* neutral often
drags a native dependency behind it. So each candidate move gets a
prove-or-refute pass before it's made.

The clearest example: `FrameArena`, a per-frame bump allocator, lived in
`rhi-webgpu`. It looks like a pure data-structure — surely a clean Layer-1 move
to the engine? We checked what it imports. It allocates from and writes to a
`GPUBuffer` ring, but only through methods the RHI already exposes; its type
surface is `RhiBuffer`, not `GPUBuffer`. Refuted the "it's coupled" worry — it
moved cleanly via `git mv`, re-exported from `@xgis/engine`, and `rhi-webgpu`
re-exports it back for its own consumers. **It was the only class in map's
orbit that moved to the engine with zero native residue.** Every other
"neutral-looking" candidate turned out to name a real `GPU*` handle somewhere in
its body and got kicked to Layer-2.

That asymmetry — one clean move out of many hopefuls — is exactly why you prove
each one instead of batch-moving. A batch move of the "neutral-looking" set would
have dragged native handles into the engine and inverted the very dependency the
milestone protects.

## Gate every slice on identical bytes (until it can't be)

Layer-0 and Layer-1 slices are, by construction, supposed to change nothing at
runtime — they're type relocations and retypes. So they're gated the way you gate
any claimed no-op:

- Full workspace `tsc` green and `bun run build` green (the build, not vitest, is
  the type authority here).
- The renderer's unit suite unchanged.
- A real WebGL2 render — fills, lines, pick — producing the same output, captured
  via `canvas.toBlob` and directionally pixel-diffed. DC=0.

If a Layer-0/1 slice produces any pixel delta, it wasn't a no-op and the retype
was wrong somewhere — the gate catches it while the slice is still small enough
to read in one screen.

Layer-2 can't promise identical bytes — it changes *how* a pass records. Its gate
is different: convert exactly one pass to the RHI, diff that frame against the
pre-conversion frame, require DC=0 because a faithful RHI translation of the same
draws must produce the same pixels. Same DC=0 bar, but now it's proving
*behavioural equivalence of a translation* rather than *no-op of a retype*. Either
way, the unit of work is one slice, and the gate runs between slices, not at the
end.

## Why this beats "fix it all and test once"

A single 700-reference commit has one test at the end and, if it fails, no
localization. The layered-slice method trades a bit of ceremony (sort, prove,
gate, repeat) for two properties that matter on a 5-year codebase:

- **Every intermediate state is shippable.** After each slice, map compiles,
  renders, and passes gates. The migration can pause for a week between slices
  and main is never broken.
- **Every regression is localized to one slice.** DC≠0 after slice K means the
  bug is in slice K's handful of files, not somewhere in 71.

The counting also keeps you honest about progress. "Reduce map's `GPU*` refs"
sounds fuzzy; "Layer-0 collapsed 87 pipeline refs to a handle, Layer-1 moved 3
symbols upstream, Layer-2 has 8 passes left, each its own gated slice" is a
burndown you can actually manage — and it tells you truthfully that the cheap
90% is done and the expensive 10% (the native hot-path handles) is what remains.

The lesson generalizes past this codebase: when a coupling is too big to cut at
once, the first work is not editing — it's sorting the references by how they're
*used* so the free moves, the relocations, and the genuine rewrites separate
cleanly. Then prove each move is what you think it is, and gate each slice before
the next. The migration becomes a sequence of small, verified, individually
reversible steps instead of one leap you can't check.
