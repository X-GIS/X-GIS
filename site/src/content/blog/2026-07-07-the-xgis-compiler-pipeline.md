---
title: 'The .xgis compiler pipeline: from style text to GPU programs'
description: "How a declarative map style becomes GPU work: lexer → parser → a Scene IR → optimization passes → codegen that emits typed shader-dsl IR (never WGSL strings), per-feature compute kernels for match(), and a gradient atlas for zoom-dependent paint."
date: 2026-07-07
tags: ['compiler', 'engine', 'webgpu', 'shader-dsl']
lang: en
---

The [first post on this blog](/blog/2026-06-26-why-a-gpu-first-map-engine)
claimed that an X-GIS style is *source code* — compiled once, not interpreted
per frame. This post is the anatomy of that compiler: ~37k lines in
`@xgis/compiler`, five stages, and one design rule that shapes everything
downstream.

## The stages

```txt
.xgis text
  → lexer                (tokens)
  → parser               (AST)
  → lower                (Scene IR)
  → optimize             (pass manager over the IR)
  → codegen              (shader-dsl IR modules + palette + compute plan)
  → emit                 (SceneCommands — the runtime handoff)
```

The IR is a **`Scene`**: sources, an array of render nodes, symbols. Each
render node carries its paint as typed value unions (`ColorValue`,
`SizeValue`, …) — a constant, a data-driven `match`, a zoom `interpolate` —
which is exactly the shape the optimizer and codegen dispatch on.

## The optimizer

A small LLVM-flavored pass manager runs over the Scene:

- `fold-trivial-stops` — a zoom interpolation whose stops are all identical
  is a constant.
- `fold-trivial-case` — a `match()` whose every arm yields the same literal
  is that literal.
- `dead-layer-elim` / `dead-source-elim` — run as a fixpoint group: removing
  a dead layer can orphan a source, which the next iteration removes.
- `merge-layers` — same-source layer groups collapse into compound nodes.
- `cse-annotate` / `expr-analyze` — side-tables (shared-subexpression and
  purity metadata) that later stages consult for kernel deduplication.
- Scalar constant folding runs inline wherever expressions are classified.

Nothing exotic — the value is that paint which *can* be static becomes
static before any GPU decision is made, so the expensive machinery below
only fires for paint that genuinely varies.

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
fragment shader when compute isn't available — *two emitters, one canonical
AST*, which keeps the two paths provably equivalent (the CPU oracle executes
the same IR both derive from).

One subtlety worth stealing: the category-string → ID mapping
(`categoryOrder`) is a **single authority** carried on the shader variant.
The shader's comparison chain and the runtime's feature-data packer must
agree on it byte-for-byte; deriving both from one sorted map is what
prevents per-tile ID collisions.

**`interpolate` over zoom** — continuous in a frame-varying input, so a
kernel per zoom would be wasted work. Instead every zoom ramp in the style
is baked into one **gradient atlas**: an N×1 texture row per ramp, sampled
with hardware linear filtering at the current zoom. The entire cost of
zoom-dependent paint at runtime is one `textureSampleLevel`.

## The handoff

The compiler's artifact is a `SceneCommands` list — load/show commands, each
carrying its shader variant (a module *preamble* plus the fill/stroke
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
