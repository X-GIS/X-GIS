---
title: "Why we built a GPU-first map engine"
description: "X-GIS compiles a declarative style language into optimized WebGPU shaders — through a real compiler and a typed shader IR. Here's the shape of the system and why each layer exists."
date: 2026-06-26
tags: ["engine", "webgpu", "compiler", "intro"]
lang: en
---

Most web maps push work to the CPU: parse a style, walk features every frame,
build vertex buffers in JavaScript. X-GIS takes the opposite stance — **the GPU
is the runtime, and the style is a program we compile.**

## A style is source code

You write declarative `.xgis`:

```xgis
layer continents {
  source: countries
  | fill match(.CONTINENT) {
      "Africa" -> amber-600,
      "Asia"   -> rose-500,
      _        -> gray-400
    }
}
```

That isn't interpreted per frame. A real **compiler** — lexer → parser → IR →
optimizer → codegen — turns it into GPU programs at load time. Constants fold to
literals. Data-driven paint (`match`, `interpolate`) becomes a per-feature
**compute kernel**. Zoom-dependent paint becomes a pre-baked gradient atlas. The
per-frame cost collapses to "bind and draw."

## One shader layer, two backends

Every shader — the geometry pipelines and the compute kernels — is authored in a
typed **shader IR** (`@xgis/shader-dsl`), not hand-written WGSL strings. That IR
emits **WGSL** for WebGPU and **GLSL ES 3.00** for the WebGL2 fallback from the
same source, and runs an optimizer over it: constant folding, common-subexpression
elimination, dead-code elimination. The compiler lowers your paint expressions
into the very same IR, so a `match()` in your style and a hand-written polygon
shader fold and dedupe the same way.

## Built for a globe

The target isn't a flat slippy map — it's a 3D globe with real geodesy: ECEF
positioning, an ellipsoidal geoid, and precision math (relative-to-center
encoding, logarithmic depth) so a building at street level and a continent at
orbit both render crisp in the same frame.

## What's next

This blog will go deep on each layer — the compiler passes, the shader IR and its
optimizer, the projection/globe math, the WebGPU render graph, and the
performance work (GPU arenas, compute scheduling) that keeps it smooth. The
[Concepts](/docs/concepts/pipeline) docs cover the architecture; here we'll cover
the decisions and the war stories.
