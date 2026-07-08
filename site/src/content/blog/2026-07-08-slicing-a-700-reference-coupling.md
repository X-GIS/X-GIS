---
title: 'Slicing a 700-reference coupling into moves you can verify'
description: "@xgis/map named backend types in ~700 places. You cannot cut that in one commit and stay honest. The method: sort every reference into layers by how it's actually used, find the one clean move, and prove each slice compiles to identical bytes before the next."
date: 2026-07-08
tags: ['architecture', 'refactoring', 'methodology', 'rhi']
lang: en
series: { name: 'WebGL2 backend program', order: 5 }
---

`@xgis/map` had roughly 700 references to WebGPU-specific types spread across 71
files. The architectural goal was one sentence — _map depends on `@xgis/engine`
only; the engine picks the backend and gets the RHI interface injected_ — but 700
references is not one change. It's a migration, and migrations that land as a
single "fix all the coupling" commit are unverifiable: if the frame breaks, you
have 700 suspects and no bisect.

Here is the surprise that set the whole method. `FrameArena` — a per-frame bump
allocator, pure CPU, no `GPU*` type anywhere in its signature — looked like the
safest move imaginable: `git mv` it to the neutral engine and go. It _was_ clean.
The catch, which took proving to trust, is that it was the _only_ class in map's
orbit that was. Every other class that read just as neutral
named a real `GPU*` handle somewhere in its body, and moving one on appearance
alone would have dragged the concrete backend up into the engine — inverting the exact
dependency the milestone exists to protect. If the safest-looking move is the
one that's genuinely clean and its look-alikes are traps, you cannot move on
appearance. You have to _prove_ each one.

So the method that worked was not "start editing." It was "sort first, then
prove each move." Every one of those 700 references is a _different kind_ of
coupling, and the kinds want different treatment — some are free, some are hard,
and one or two are actually impossible to move without a separate upstream
migration. You have to know which before you touch a line.

## Sort by how the value is used, not by its type

The naive sort is by type name: 217 `GPURenderPipeline`, ~90 `GPUBuffer`, ~28
`GPUTextureView`, and so on. That grouping is useless, because two references to
the same type can have completely different couplings. The useful sort is by
**what the code does with the value.** Three buckets emerged:

**Layer-0 — pure routing keys.** Values that are stored and compared but never
_used_ as a backend object. The counterintuitive part: most of map's
`GPURenderPipeline` references are never bound to a render pass. The
vector-tile path proves it mechanically — there is zero native
`pass.setPipeline` in it; `recordFillDraw` and `recordTileFill` take the
"pipeline" only to match it _by stable factory label_ to a pre-built RHI
Material twin, and then `executeItems` runs that Material's own pipeline. So the
stored `GPURenderPipeline` is a routing key wearing a backend type: the code
reads nothing off it but `.label`. It doesn't need a backend type at all — it
needs `RhiPipelineHandle { readonly label: string }`, a neutral type in
`@xgis/rhi`. Retyping the field is a pure type change: `pipeline-factory` still
_creates_ a native `GPURenderPipeline` and it flows structurally into the
handle's `.label`, so the emitted bytes are identical and no pixel moves. That
retype collapsed 87 pipeline references across the VTR path,
`BindGroupRegistry`, `polygon-fill-material`, and the bucket-scheduler in two
increments. (The routing-key argument gets its own companion post.)

**Layer-1 — backend-neutral symbols that just live in the wrong package.** Types
and small classes that are already backend-agnostic but happen to be _defined_ in
map or in the concrete backend package, so referencing them creates a bad edge.
`RhiContext`, `RhiDeviceLostInfo`, `BackendChoice` — move the _definition_
upstream (to `@xgis/rhi`), import from `@xgis/engine`, done. The reference stops
being a coupling the instant the symbol it names lives upstream.

**Layer-2 — genuine native GPU handles on the hot path.** Places where map holds
a real `GPUBuffer`/`GPUTextureView`/`GPUCommandEncoder` and _calls native methods
on it_ — writes, copies, `beginRenderPass`. These cannot be retyped away. They
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
wrong more often than it's right, because a symbol that _looks_ neutral often
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

This is not hypothetical. One "make the native resource lazy" slice — deferring
the heatmap renderer's blur-direction uniform write out of the constructor and
onto the first draw, exactly the kind of change that _should_ be inert — moved
that 16-byte write to _after_ `addLayer`. A data-path test that had been
identifying the compose-params buffer as "the last 16-byte write" silently
started capturing the blur direction instead, and its intensity assertion read
zero. Nothing in the render changed; a test's load-bearing assumption did. The
failure was localized to that one slice in one commit, and the fix was to key
the capture by buffer _label_ rather than by write order — a correctness
improvement the slice boundary handed us for free. Fold ten such deferrals into
one big commit and that red test is a needle in a ten-file haystack.

Layer-2 can't promise identical bytes — it changes _how_ a pass records. Its gate
is different: convert exactly one pass to the RHI, diff that frame against the
pre-conversion frame, require DC=0 because a faithful RHI translation of the same
draws must produce the same pixels. Same DC=0 bar, but now it's proving
_behavioural equivalence of a translation_ rather than _no-op of a retype_. The
one subtlety that makes per-pass conversion possible at all: a half-migrated
frame has some passes recording through the RHI and some still native, yet they
must share the render loop's _one_ command encoder and _one_ submit, or the DC=0
comparison is measuring a changed submit topology rather than a changed pass.
The seam that holds that invariant — wrap the existing encoder, no-op its
`finish()` — is its [own companion
post](/blog/2026-07-08-swapping-the-encoder-mid-frame). Either way, the unit of work is one
slice, and the gate runs between slices, not at the end.

## Why this beats "fix it all and test once"

A single 700-reference commit has one test at the end and, if it fails, no
localization: 71 suspect files, no bisect. The layered-slice method keeps every
intermediate state shippable and pins each regression — a DC≠0 after slice K — to
that slice's handful of files. The heatmap test above is the proof: one deferral,
one red test, one commit to look in.

But the sharper payoff is that the counting turns a fuzzy goal into a burndown
you can read off. "Reduce map's `GPU*` refs" tells you nothing; the actual arc
does. Layer-0 collapsed 87 pipeline references to a `{ label }` handle in two
increments. Layer-1 relocated the neutral type-and-interface symbols upstream —
`RhiContext`, `RhiDeviceLostInfo`, `BackendChoice` — a trivial move because they
name no GPU handle; and among the _classes with a runtime body_, `FrameArena`
was the one that moved to the engine with zero native residue while its
look-alikes fell through to Layer-2. What's left is Layer-2: the eight-pass
frame, each pass its own gated slice through the RHI. That's the honest shape of the milestone — the cheap, high-count moves are
done, and what remains is the small set of real native hot-path handles, which is
exactly the expensive part the counting refused to let us pretend away.

The lesson generalizes past this codebase: when a coupling is too big to cut at
once, the first work is not editing — it's sorting the references by how they're
_used_ so the free moves, the relocations, and the genuine rewrites separate
cleanly. Then prove each move is what you think it is, and gate each slice before
the next. The migration becomes a sequence of small, verified, individually
reversible steps instead of one leap you can't check.
