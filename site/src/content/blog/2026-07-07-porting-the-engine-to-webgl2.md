---
title: 'Porting a WebGPU-first engine to WebGL2'
description: "Not a fork, not an if-else forest: how we grew a WebGL2 backend under X-GIS with package-enforced neutrality, a single shader IR emitting both WGSL and GLSL, and pixel gates instead of promises."
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

## Make neutrality structural, not disciplinary

First the compiler: the engine core compiles with `types: []`, so the moment
a `GPUDevice` identifier appears in core code, `tsc` fails. Then the package
boundary: an interface-only `@xgis/rhi` package (`RhiDevice`, `RhiRenderPass`,
`RhiBuffer`, …), with `@xgis/rhi-webgpu` as the **only** package in the
monorepo that may see `@webgpu/types`, and `@xgis/rhi-webgl2` implementing
the same interface over GL. A canary CI job builds the engine against
`@xgis/rhi` alone to prove the boundary holds. 147 files had their imports
split — mechanical, but everything after it was safe.

Boot is inverted the same way: an ordered `RhiBackendProvider[]` at the
composition root. `?forcegl2=1` is just a different provider array; the
renderer never learns which backend it runs on.

## One shader IR, two emitters

The hard part is shaders. Rewriting dozens of WGSL modules in GLSL ES 3.00
by hand would fork the pixel math forever. Our shaders are authored in a
TypeScript eDSL that builds an IR, so we added a second emitter:

- **WGSL stays the authority.** The GLSL emitter re-assembles the same
  module declarations (structs, bindings, functions); shader logic is never
  duplicated, so the backends structurally cannot disagree.
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
  and nothing happens. Reset masks first.
- **FBO row order is inverted.** Anything rendered to an FBO and sampled
  back needs a V-flip. We missed one — the story is in the companion post.
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
