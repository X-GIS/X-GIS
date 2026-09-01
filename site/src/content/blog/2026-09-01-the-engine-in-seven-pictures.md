---
title: 'The engine in seven pictures'
description: 'A diagram-first tour of the X-GIS renderer: how a GPU that computes in 32-bit floats draws a sub-pixel-correct planet, why a line is a quad that lies, what keeps a fill and its outline within a metre of each other, and how a rendered frame gets proven with an md5. Companion to the new docs/tech deep-dive series.'
date: 2026-09-01T03:10:00Z
tags: ['architecture', 'rendering', 'precision', 'verification']
lang: en
draft: false
---

We just finished writing a nine-chapter technical documentation series for this engine
(`docs/tech/` [1] — one narrative edition for engineers, one dense citation-first
edition for AI agents). This post is the third form the same material wanted to take:
the whole design as seven pictures, each with just enough words to read it. Every number
below is measured in this repository — the deep chapter behind each picture carries the
`file:line` receipts.

## 1. The system

<figure>
  <img src="/diagrams/engine-big-picture.svg" alt="Flow left to right: .xgis style text into a pure-TypeScript compiler producing SceneCommands and shader variants; data (PMTiles, GeoJSON, HDF5) into workers that decode, clip, earcut and pack; both feed the GPU's 13-pass frame, which outputs pixels; eight projections are one uniform switch." />
  <figcaption>Styles compile; data packs off-thread; one 13-pass frame draws it. Switching any of the eight projections is a GPU uniform change — no re-tessellation.</figcaption>
</figure>

The compiler never touches the GPU (it emits commands and typed shader IR as data), and
the tile pipeline never touches the style. The two meet in a frame whose pass order is a
single constant the chain is _built from_, so it cannot drift. The full package graph —
and the ratchet tests that keep every boundary a mechanical CI failure instead of a
review comment — is chapter 01 [2].

## 2. Why the planet doesn't jitter

<figure>
  <img src="/diagrams/precision-ladder.svg" alt="Ladder from absolute Mercator metres (~1.4e7, one f32 ULP ≈ 1.7 m) through three f64 CPU subtractions — vertex minus tile center, quantize to two u16 per axis with 0.57 micrometre steps at z14, tile center minus camera center split hi/lo — into a GPU that only adds small numbers, with error bound 512 times 2 to the minus 23, about 6e-5 px at every zoom." />
  <figcaption>Three subtractions, all f64, all CPU. The GPU only ever adds small numbers — and in the tile-local frame the zoom cancels out of the error bound entirely.</figcaption>
</figure>

A GPU computes in 32-bit floats, and at Seoul's longitude one float step is **1.7
metres** — several pixels past z14. The cure is never letting the GPU see a big number:
subtract the tile center from every vertex (f64, at pack time), quantize the residual,
and ship the camera offset as a split hi/lo pair. In the tile-local frame the error
bound is `512 · 2⁻²³ ≈ 6×10⁻⁵ px` — _at every zoom_, because the zoom cancels
algebraically. The same discipline, applied to the camera anchor, is the difference
between a map that shakes more than a pixel while panning at z18 and one that holds
under 0.05 px. The error-budget method, the emulated-doubles fallback, and the geoid
story are chapter 02 [3].

## 3. A line is a quad that lies

<figure>
  <img src="/diagrams/line-quad-sdf.svg" alt="Two dashed rectangles generously bound a two-segment polyline; inside them an amber stroke with a round join at the shared vertex, highlighted by a dashed circle, and a butt cap at the start. Labels: CPU emits one instanced quad per segment as a generous bound; the fragment SDF carves body, joins, caps and dashes; AA feather is half a device pixel." />
  <figcaption>The CPU emits one instanced 6-vertex quad per segment — only a conservative bound. The fragment shader carves the true stroke as a signed distance field: a round join is a circle <em>union</em>, a cap is a half-plane, a dash is arithmetic on arc length.</figcaption>
</figure>

There is no vertex buffer at all: quad corners come from `vertex_index`, segment data
(128 bytes: split-precision endpoints, neighbour tangents, arc length, miter pads) from
a storage buffer indexed by `instance_index`. Everything visual is a distance-field
operation, which is why joins, caps, dashes, patterns and gradients all fall out of one
per-fragment arc coordinate — and why the anti-aliasing band can be exactly half a
device pixel (`0.5/dpr`). The join math, the width-projection corrections, and the bug
ledger behind each constant are chapter 04 [4].

## 4. The fill/outline pact

<figure>
  <img src="/diagrams/fill-stroke-pact.svg" alt="One clipped ring set in Mercator metres feeds both the fill packer (quantized ECEF) and the outline packer (DSFUN hi/lo); shared authorities — tile anchor, projection functions, reflected uniform layout — feed both with dotted lines; both flow into a gate: outline endpoint within 1 metre of the fill edge, decode split under 0.25 px at z19.4." />
  <figcaption>Fill and outline are packed by different kernels — so they derive from one clipped ring set, share one anchor and one reflected uniform layout, and two numeric gates hold them together.</figcaption>
</figure>

The engine's dominant historical bug shape is two sibling paths that must agree,
drifting. Before the spaces were unified, the polygon fill clipped in lon/lat while its
stroke clipped in Mercator — **27 km** of divergence at z8 boundary tiles. Today both
walk the same rings, and gates assert every outline endpoint sits within 1 m of a fill
boundary edge and the two vertex encodings decode to within 0.25 px at deep zoom. The
tessellation pipeline, patterns that never swim (world-anchored UVs), and the extrusion
frame are chapter 05 [5].

## 5. One graph, four outputs

<figure>
  <img src="/diagrams/one-graph-four-outputs.svg" alt="One typed node graph in the TypeScript shader DSL emits four things: WGSL for WebGPU, GLSL ES 3.00 for WebGL2, a CPU f64 oracle used by tile selection and label anchors, and reflection carrying byte layouts and bind groups." />
  <figcaption>No hand-written shader strings anywhere — a ratchet test forbids them. One typed IR emits both GPU dialects, the CPU's own f64 math, and the byte layouts renderers bind with.</figcaption>
</figure>

The migration was motivated by an experiment worth repeating on any codebase: mutate one
culling literal inside a WGSL string and run the whole suite — everything stayed green,
because nothing pinned the emitted bytes to anything. Now thresholds derive from one
table, the CPU projects with a generated f64 lowering of the _same_ graph the GPU runs,
and a gate parses the literals back out of the emitted WGSL to prove they match. The IR,
the optimizer, baking, and variant identity rules are chapter 03 [6].

## 6. The frame that mostly doesn't run

<figure>
  <img src="/diagrams/frame-loop-gate.svg" alt="A decision diamond, render this frame?, takes the yes branch when the camera moved, an animation is active, or any of 12 pending-work kinds is in flight, into the 13-pass frame and render bundles where 270 draw calls become one replay; the no branch skips with a zero-allocation tick." />
  <figcaption>Render-on-demand: the frame runs only when something changed — and "something" is an enumerated registry of 12 async work kinds, each with a deadline, because six separate incidents were one forgotten list entry.</figcaption>
</figure>

The fastest frame is the one you skip, and the second-fastest is the one you replay:
render bundles took a measured 270 draw calls at city zoom down to one. The rest of the
performance story is budgets — worker completions per frame, uploads per frame, bytes
per cache with hysteresis — and a single adaptive-quality controller whose levers are
inert by construction where they shouldn't act. That, plus the tile-selection metric and
the memory arenas underneath, are chapters 06 and 07 [7][8].

## 7. Proving a frame with an md5

<figure>
  <img src="/diagrams/verification-ladder.svg" alt="Three rungs: directional (DC greater than zero and D1 less than D0), zero diff (valid only after measuring the noise floor), and hash equality (three captures, one md5) — with engineered determinism feeding the top rung: pinned camera, pumped convergence, software rasterizer, chrome-free capture." />
  <figcaption>The render-gate ladder. Determinism is not found, it is engineered — and once it is, verification collapses from statistics to a checksum.</figcaption>
</figure>

This repository carries more test code than source code, and the reason is that a GPU
engine's worst bugs are invisible to types, unit tests, and green CI — one incident
shipped fifteen green checks and zero drawn pixels. The answer is layered instruments:
directional pixel diffs for intended changes, zero-diff only after measuring the
harness's own noise floor, and — with a pinned camera, pumped convergence and a software
rasterizer — plain hash equality: three captures across a merge, one md5. The full gate
philosophy, including the fail-before ladder and the anti-blessing rule for baselines,
is chapter 09 [9].

## Where to go deeper

The pictures stop here; the receipts don't. The series behind this post ships in two
mirrored editions — `docs/tech/dev/` [10] reads like essays (each chapter's war stories
included), and `docs/tech/agent/` [11] is the dense, `file:line`-cited edition built
for an AI agent to mine when designing a new engine. Start with the series README [1] for reading orders.

## References

1. [`docs/tech/README.md`](https://github.com/X-GIS/X-GIS/blob/main/docs/tech/README.md) — the nine-chapter series this post illustrates, with reading orders.
2. [`docs/tech/agent/01-architecture.md`](https://github.com/X-GIS/X-GIS/blob/main/docs/tech/agent/01-architecture.md) — packages, ratchets, ADRs, the pass chain.
3. [`docs/tech/agent/02-coordinates-precision.md`](https://github.com/X-GIS/X-GIS/blob/main/docs/tech/agent/02-coordinates-precision.md) — error budgets, RTC, df64, depth.
4. [`docs/tech/agent/04-line-rendering.md`](https://github.com/X-GIS/X-GIS/blob/main/docs/tech/agent/04-line-rendering.md) — the quad+SDF model in full.
5. [`docs/tech/agent/05-polygon-rendering.md`](https://github.com/X-GIS/X-GIS/blob/main/docs/tech/agent/05-polygon-rendering.md) — tessellation, the pact, patterns, extrusion.
6. [`docs/tech/agent/03-shader-dsl.md`](https://github.com/X-GIS/X-GIS/blob/main/docs/tech/agent/03-shader-dsl.md) — the typed IR and its four outputs.
7. [`docs/tech/agent/06-memory-upload.md`](https://github.com/X-GIS/X-GIS/blob/main/docs/tech/agent/06-memory-upload.md) — arenas, budgets, workers.
8. [`docs/tech/agent/07-performance.md`](https://github.com/X-GIS/X-GIS/blob/main/docs/tech/agent/07-performance.md) — demand rendering, SSE, adaptive quality.
9. [`docs/tech/agent/09-verification.md`](https://github.com/X-GIS/X-GIS/blob/main/docs/tech/agent/09-verification.md) — the gate ladder end to end.
10. [`docs/tech/dev/`](https://github.com/X-GIS/X-GIS/tree/main/docs/tech/dev) — the narrative edition.
11. [`docs/tech/agent/`](https://github.com/X-GIS/X-GIS/tree/main/docs/tech/agent) — the agent edition.
