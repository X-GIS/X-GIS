---
title: 'The .xgis compiler pipeline: from style text to GPU programs'
description: 'How a declarative map style becomes GPU work: lexer → parser → a Scene IR → optimization passes → codegen that emits typed shader-dsl IR (never WGSL strings), per-feature compute kernels for match(), and a gradient atlas for zoom-dependent paint.'
date: 2026-07-07
tags: ['compiler', 'engine', 'webgpu', 'shader-dsl']
lang: en
---

The [first post on this blog](/blog/2026-06-26-why-a-gpu-first-map-engine)
claimed that an X-GIS style is _source code_ — compiled once, not interpreted
per frame. This post is the anatomy of that compiler in `@xgis/compiler`: five
stages, and one design rule that shapes everything downstream.

## The stages

<figure>
  <img src="/diagrams/compiler-pipeline.svg" alt="Compiler stages left to right: .xgis text, lexer, parser, lower to Scene IR, optimize pass manager, codegen to shader-dsl IR, emit to SceneCommands." />
  <figcaption>Five stages plus the runtime handoff: text → lexer → parser → lower (Scene IR) → optimize → codegen (shader-dsl IR) → emit (SceneCommands).</figcaption>
</figure>

The IR is a **`Scene`**: sources, an array of render nodes, symbols. Each
render node carries its paint as typed value unions (`ColorValue`,
`SizeValue`, …) — a constant, a data-driven `match`, a zoom `interpolate` —
which is exactly the shape the optimizer and codegen dispatch on.

## The optimizer

A small LLVM-flavored pass manager runs over the Scene. Most of its passes
are the obvious folds — a zoom `interpolate` whose stops are all identical
collapses to a constant, a `match()` whose arms all yield the same literal
collapses to that literal, scalar constant folding runs wherever expressions
are classified. The value is mundane: paint that _can_ be static becomes
static before any GPU decision, so the expensive machinery below only fires
for paint that genuinely varies.

The one pass worth dwelling on is the one that has to iterate:
`dead-layer-elim` and `dead-source-elim` run as a **fixpoint group**, not a
single sweep, because the two eliminations feed each other. Consider a source
`countries` consumed by exactly one layer, and that layer is dead — every arm
folded to transparent, say, so nothing it draws is visible. Pass one removes
the layer. Only _now_ is `countries` an orphan: it has zero consumers. A
one-shot pipeline would stop there and hand the runtime a source nothing reads
— a tile fetch and upload for no pixels. Running the group to a fixpoint lets
the _next_ iteration see the freshly-orphaned source and drop it too. The
ordering isn't decorative; the second removal only becomes legal _because_ the
first one happened.

## Rule one: codegen emits IR, not strings

Codegen's output is **typed [shader-dsl](/blog/2026-07-07-emulated-double-precision-shader-dsl)
IR** — `ModuleDecl` fragments and expression `Node`s — never WGSL text. The
former raw-WGSL escape hatch was deliberately removed. Three things fall out:

- **Type safety across the seam.** A fill expression is a
  `NodeLike<'vec4<f32>'>`; producing the wrong type is a TypeScript error in
  the compiler, not a GPU compile error in a user's browser.
- **Backend neutrality.** The same emitted IR lowers to WGSL for WebGPU and
  GLSL ES 3.00 for the WebGL2 fallback, and the DSL's CPU oracle can execute
  it for parity tests.
- **Structural deduplication.** Compute kernels are fingerprinted on the
  serialized IR module — two layers whose `match()` compiles to the same
  kernel share one, by reference, across fill and stroke.

## Where data-driven paint goes

Paint routing splits on what an expression depends on:

**`match(.CONTINENT) { … }`** — depends on feature data, invariant per
feature. It compiles to a **per-feature compute kernel** (workgroup size 64)
that evaluates the match once per feature and packs the resulting RGBA into
a storage buffer with `pack4x8unorm`. The render shader then does a single
buffer read per vertex — the per-frame cost of data-driven paint collapses
to a lookup.

The same `match` AST also has a second emitter that inlines it into a
fragment shader when compute isn't available — _two emitters, one canonical
AST_, which keeps the two paths provably equivalent (the CPU oracle executes
the same IR both derive from).

### The bug that `categoryOrder` exists to kill

`match(.class)` doesn't compare strings on the GPU — the shader compares
integer IDs. So somewhere a string like `"hospital"` becomes an `i32` the
shader's `switch` has a `case` for, and _two_ pieces of code have to pick the
same integer: the codegen that emits the case table, and the runtime packer
that writes each feature's ID into the storage buffer. If they ever disagree,
the shader compiles fine and draws the wrong colour.

The tempting way to assign IDs is from the data — number the category values
you actually see, in order. It's also the trap, because vector tiles arrive
_per tile_. A tile containing `{cemetery, hospital, school}` numbers hospital
`1`; the neighbouring tile, which happens to hold only `{cemetery, hospital}`,
numbers the same hospital… also `1` here, but in a tile with
`{cemetery, hospital, railway, school}` it might land on `2`. The shader's
case table is fixed, so the _same category comes out the right colour in one
tile and the wrong colour in the tile next to it_ — a seam of miscoloured
polygons that moves as you pan.

The fix is a **single authority**: IDs come not from the tile's data but from
the _style's_ arm patterns, sorted alphabetically once —
`['cemetery', 'hospital', 'railway', 'school'] → 0,1,2,3` — and that list
(`categoryOrder`) is carried on the shader variant. Codegen builds its `case i`
table from it; the runtime packer maps each feature string to its index in the
exact same list (a miss packs `-1`, so the shader's `else` fires the default
colour). Neither side ever looks at what a particular tile happens to contain,
so tiles can't drift. The comparison chain and the packer agree byte-for-byte
because they read one sorted map.

**`interpolate` over zoom** — continuous in a frame-varying input. Zoom
changes essentially every frame while the user navigates, so treating a zoom
ramp like feature paint — re-dispatching a compute kernel to re-evaluate the
ramp whenever zoom moves — pays a per-gradient dispatch _every frame_, and
there's no discrete "zoom granularity" you can precompute at because zoom is
continuous. So the ramp is baked _once_, at compile time, into a **gradient
atlas**: an N×1 texture row per ramp, sampled with hardware linear filtering
at the current zoom. The entire runtime cost of zoom-dependent paint collapses
to one `textureSampleLevel` — the hardware sampler does the interpolation the
rejected kernel would have recomputed frame after frame.

## The handoff

The compiler's artifact is a `SceneCommands` list — load/show commands, each
carrying its shader variant (a module _preamble_ plus the fill/stroke
expression nodes), the palette, and the compute plan. The runtime composes
these fragments with its own geometry pipelines and only then does
shader-dsl emit WGSL. No shader text exists until the last step, on the
consumer's side of the seam.

## Pinned by tests

The pipeline is snapshot- and parity-gated: IR snapshots per fixture, WGSL
snapshots for the compute kernels, per-pass statistics tests, and
end-to-end conversion tests against real MapLibre/Mapbox styles (including
full basemaps) that assert the compiled scene, not just "it didn't throw".
When [the optimizer grew GPU-execution parity
gates](/blog/2026-07-07-what-a-software-gpu-can-verify), the compiler's
output was already IR those gates could run.

## What generalizes

- Put a **typed IR at every seam** where one system hands programs to
  another; strings type-check nothing.
- **Classify paint by its dependency set** (constant / per-feature /
  per-frame) and pick the cheapest home for each class: fold it, precompute
  it in a kernel, or bake it into a texture.
- Make every cross-system agreement (category IDs, buffer layouts) a
  **single exported authority** — the bugs live wherever two copies can
  drift.
