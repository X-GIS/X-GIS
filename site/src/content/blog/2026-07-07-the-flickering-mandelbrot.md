---
title: 'The flickering Mandelbrot: a driver defeats the fast-math guard'
description: "Incident report: the fp64 demo alternated between correct and f32-collapsed frames under byte-identical inputs. Root cause: driver pipeline re-optimization specializing on uniform values. Fixes: render-on-demand and a texel-fetched guard."
date: 2026-07-07
tags: ['shader-dsl', 'precision', 'debugging', 'gpu-drivers']
lang: en
---

**Report** (Windows 11, RTX 5060 Ti, Chrome, production): the f64 half of the
[fp64 Mandelbrot](/shader-dsl/examples/fp64-mandelbrot) alternated between
correct rendering and an f32-collapsed one, frame to frame, with no
interaction. The demo has no animation — every frame binds the same program
with the same uniforms, so with deterministic GPU execution the output cannot
change. Either the inputs or the code differed between draws.

## Localizing without a repro

The [df64 emulation](/blog/2026-07-07-emulated-double-precision-shader-dsl)
depends on error-free transformations whose error terms are algebraically
zero; they survive only because a runtime-opaque `one` (then a uniform, value
1.0) is threaded through the intermediates. On our CI GPU (SwiftShader) the
deployed page was frame-stable: ten consecutive frames, zero differing
pixels. The bug reproduced only on the reporter's machine.

The demo ships an `fp64 emulation` toggle whose *off* state routes the whole
screen through the plain-f32 branch of the same shader — same canvas, same
loop, same uniform upload. One observation from the reporter settled it:

- toggle off → stable
- toggle on → alternating

Everything shared by both branches was exonerated. The instability lived in
the df64 code path, and since the uniform bytes were identical every frame,
the remaining variable was the compiled code itself: drivers ship a fast
pipeline build, re-optimize in the background, and hot-swap variants — and
some **specialize pipelines on observed uniform values**. The guard uniform's
value is *always exactly 1.0*; specialized, $(s \cdot \mathrm{one} - a)
\cdot \mathrm{one}$ becomes $s - a$ and the EFTs legally cancel. Variant
swapping mid-session produces exactly the observed alternation.

## Fix 1: render-on-demand

The playground loop redrew every rAF tick with unchanged inputs. Every live
input (clock, sliders, toggles, pointer, camera, canvas size) flows through
one packed uniform buffer, so byte-equal uniforms imply an identical frame —
skip the draw. A frame that is never redrawn cannot alternate, regardless of
what the driver swaps in between draws.

Measured with an instrumented `drawArrays` counter: 0 draws/s at rest (was
~60), one draw per pointer step while dragging, animated examples unaffected.
Result on the reporter's machine: at rest, fixed; during drag/zoom — where
redrawing is unavoidable — the collapse still appeared intermittently. The
specialization theory held.

## Fix 2: a texel-fetched guard

If the driver can observe the uniform, store the guard where observation
doesn't help. No shader compiler treats **texture contents** as compile-time
constants. The guard is now a 1×1 texture whose texel reads exactly 1.0:

```
float one = texelFetch(_fp64, ivec2(0, 0), 0).x;    // GLSL ES 3.00
let one = textureLoad(_fp64, vec2<i32>(0, 0), 0).x; // WGSL
```

At the IR level the guard is an intrinsic, `f64Guard()`, with three
spellings: the WGSL fetch, the GLSL fetch, and — on the CPU oracle — the
number 1. The entire
[verification stack](/blog/2026-07-07-testing-emulated-doubles) re-ran
unchanged across the representation change.

Two supporting changes: the lowering injects the texture binding
automatically (as it did the uniform), and the render loop schedules one
extra draw ~300 ms after inputs stop changing, so the frozen at-rest frame
cannot be one that landed on a bad in-flight variant.

Deployed; the reporter's machine is clean at rest and during interaction.

## Takeaways

- **"Runtime-opaque" must cover the pipeline's whole lifecycle.** A uniform
  guard defeats ahead-of-time folding; it does not defeat uniform-value
  specialization in a background re-optimizer. Texel fetches defeat both.
- **Render-on-demand is a correctness feature.** Skipping redundant draws
  structurally removes any nondeterminism the driver introduces *between*
  draws — the battery savings are incidental.
- **Ship one-click experiments.** The fp64 toggle turned an unreproducible
  report into a controlled A/B on the only machine that mattered.
- **Give GPU-opaque values a CPU-exact twin.** Because the guard is an
  intrinsic with per-target spellings, changing its physical representation
  cost the test suite nothing.
