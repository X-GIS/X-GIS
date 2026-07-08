---
title: 'Porting a WebGPU-first engine to WebGL2'
description: "The program index for X-GIS's WebGL2 port: package-enforced backend neutrality, a single shader IR emitting both WGSL and GLSL, and pixel gates instead of promises — with links to the per-subsystem deep-dives. Shared shader math still can't stop pipeline state and target conventions from diverging."
date: 2026-07-07
tags: ['webgl2', 'rhi', 'shader-dsl', 'architecture']
lang: en
---

X-GIS was designed WebGPU-first: storage buffers, MRT, compute passes, MSAA
resolve — the whole frame graph speaks WebGPU. But the web still ships
browsers and drivers where WebGPU isn't there. We needed a WebGL2 fallback
that wouldn't slowly fork the renderer into two diverging engines.

The easy path is `if (isWebGL2)` scattered through the draw code. On a
five-year library that's how you get regressions that only one backend sees.
We took three steps instead.

This post is the program index: it lays out the three-step shape and the
mines, and each subsystem has its own deep-dive — the [fail-loud device
stub](/blog/2026-07-08-fail-loud-stub), the [700-reference type
de-coupling](/blog/2026-07-08-slicing-a-700-reference-coupling) (and [the
dependency-direction wrong turn](/blog/2026-07-08-import-source-is-not-dependency)
inside it), the [mid-frame encoder
swap](/blog/2026-07-08-swapping-the-encoder-mid-frame), and the [pixel gate
that caught what "it compiles" missed](/blog/2026-07-07-pixels-dont-lie).
Start here; follow the links where a slice gets interesting.

## Make neutrality structural, not disciplinary

First the compiler: the engine core compiles with `types: []`, so the moment
a `GPUDevice` identifier appears in core code, `tsc` fails. Then the package
boundary: an interface-only `@xgis/rhi` package (`RhiDevice`, `RhiRenderPass`,
`RhiBuffer`, …), with `@xgis/rhi-webgpu` as the **only** package in the
monorepo that may see `@webgpu/types`, and `@xgis/rhi-webgl2` implementing
the same interface over GL. A canary CI job builds the engine against
`@xgis/rhi` alone to prove the boundary holds. Splitting the imports was
mostly mechanical; the one thing it surfaced was that *where a type is
imported from* is not the same as *which package the dependency points at* —
a wrong turn worth its own post.

Boot is inverted the same way: an ordered `RhiBackendProvider[]` at the
composition root. `?forcegl2=1` is just a different provider array; the
renderer never learns which backend it runs on.

## One shader IR, two emitters

The hard part is shaders. Rewriting dozens of WGSL modules in GLSL ES 3.00
by hand would fork the pixel math forever. Our shaders are authored in a
TypeScript eDSL that builds an IR, so we added a second emitter:

- **WGSL stays the authority.** The GLSL emitter re-assembles the same
  module declarations (structs, bindings, functions); shader logic is never
  duplicated, so the two backends cannot disagree *about shader math*. They
  can still disagree about everything the IR doesn't own — pipeline STATE
  (which depth variant a fill selects) and target CONVENTIONS (FBO row order).
  Both of those bit us with byte-identical shaders; the [pixel-gate
  post](/blog/2026-07-07-pixels-dont-lie) is the two autopsies.
- **Per-stage assembly.** GLSL has one `main` per stage, and a
  fragment-only helper containing `discard` must never reach a vertex
  compilation — so each stage's module is assembled from the entry's
  transitive callees, not filtered after the fact.
- **Storage emulation.** ES 3.00 has no SSBOs; `array<Struct>` storage
  buffers lower to R32F data textures in an IR pass. Authoring code is
  untouched.

Binding is by name: `RhiBindLayoutEntry` carries `'Uniforms'` or
`'sprite_atlas'`, and the GL device resolves uniform-block indices and
texture units by reflection, since GL has no `(group, binding)` tuples.

## ES 3.00 will fight you

A few mines we stepped on, recorded so you don't have to:

- **No per-target blend.** If any color target is an integer format (our
  picking MRT is `rg32uint`), the whole pipeline's blend must be forced off.
- **`clearBuffer*` honours write masks.** Clear with `colorMask` disabled
  and nothing happens — the target silently keeps last frame's contents
  instead of the clear colour. Reset masks first.
- **FBO row order is inverted.** A GL FBO stores clip `y = -1` at texture
  row 0 — the inverse of WebGPU — so anything rendered to an FBO and sampled
  back needs a V-flip. We missed one on the translucent composite: the whole
  offscreen buffer sampled mirrored, so stroke tint landed on the wrong half
  of the frame. It even passed its own parity gate, because that gate's
  fixture was a centred band, symmetric under the very flip it should have
  caught. Full autopsy in the [pixel-gate post](/blog/2026-07-07-pixels-dont-lie).
- **GL executes immediately.** WebGPU lets you flush a uniform ring once at
  pass end because `submit()` orders everything; GL draws at call time, so
  the staged slot must land in the buffer *before each draw*.

## Gates, not promises

Every slice — fills, lines, raster, labels, icons, dash/pattern, translucent
compositing, picking — landed together with a headless e2e gate: SwiftShader
in CI renders the `?forcegl2=1` page and compares it against the WebGPU
frame (IoU / directional pixel diff). The distance between "it compiles" and
"it draws the same picture" is enormous, and pixel comparison is the only
thing that closes it. The final gate renders a real 117-layer basemap on
both backends and diffs them tile by tile — which is where the most
interesting bugs were hiding.
