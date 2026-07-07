---
title: 'The flickering Mandelbrot: when the driver defeats your fast-math guard'
description: "A user reported our fp64 demo alternating between correct and broken — frame by frame, with identical inputs. The trail led from an 'impossible' symptom to a driver behavior the double-float literature doesn't cover, and to two fixes: render-on-demand, and a guard no compiler can constant-fold."
date: 2026-07-07
tags: ['shader-dsl', 'precision', 'debugging', 'gpu-drivers']
lang: en
---

Hours after we shipped the [emulated double precision](/blog/2026-07-07-emulated-double-precision-shader-dsl)
feature, a user filed the kind of bug report that makes a graphics programmer
sit up straight:

> The fp64 half of the Mandelbrot demo flickers. It renders like f32, then
> like f64, back and forth — **while I'm not touching anything.**

Windows 11, RTX 5060 Ti, Chrome, the production site. And here's why that
sentence should be impossible: the demo has no animation. Every frame binds
the *same program* with the *same uniforms*. GPU floating-point execution is
deterministic — identical inputs through identical code give identical
pixels, every time. If the output alternates, one of those two "identicals"
is a lie.

## What we knew, and what we couldn't see

The df64 emulation stands on error-free transformations whose error terms are
*algebraically zero* — $e = (a - (s - v)) + (b - v)$ folds to nothing in
real-number math and only survives because each intermediate rounds. Any
optimizer allowed to reassociate can legally delete the whole mechanism, which
is why every helper threads a runtime-opaque `one` through its intermediates
(the [previous post](/blog/2026-07-07-emulated-double-precision-shader-dsl)
tells that story). At ship time `one` lived in a uniform buffer, guarded by a
real-GPU known-answer gate with assertions plain f32 provably fails. That gate
was green on WebGPU/Tint and WebGL2/ANGLE.

Our CI GPU is SwiftShader. Ten consecutive frames of the deployed page,
pixel-diffed: **zero differing pixels**. Whatever this was, it did not
reproduce on our hardware. The user's machine was the only test bench — so
the next move had to be an experiment they could run in one click.

## One toggle, half the hypothesis space

The demo ships an `fp64 emulation` toggle: off routes the whole screen through
the plain-f32 branch of the same shader. We asked for one observation — does
the flicker survive with the toggle off?

It didn't. Toggle off: stable f32 rendering. Toggle on: alternation. That one
bit cut the problem space in half. The canvas, the compositor, the uniform
upload path, the render loop — all shared by both branches, all exonerated.
The instability lived **inside the df64 code path**, and since our uniforms
were byte-identical every frame, the only remaining variable was the thing
nobody thinks of as variable: *the compiled code itself, between draws.*

Modern drivers do exactly that. They ship a fast pipeline build first, keep
optimizing in the background, and hot-swap the re-optimized variant in — and
some specialize pipelines on **observed uniform values**. Our guard uniform
has one fatal property from that perspective: its value is *always exactly
1.0*. Specialize on it, and $(s \cdot \mathrm{one} - a) \cdot \mathrm{one}$
becomes $s - a$ — the error terms cancel, legally, and df64 collapses to f32.
Swap between variants mid-session and you get… alternation.

## Fix one: a frame that is never redrawn cannot flicker

Before chasing the driver, we took the root-cause-agnostic win. The playground
loop was redrawing every rAF tick even when nothing changed. But every live
input — clock, sliders, toggles, pointer, camera, canvas size — flows through
one packed uniform buffer, so *byte-equal uniforms* ⇒ *the frame would be
identical* ⇒ don't draw it. Whatever code variant the driver swaps in between
draws, it can't show if there is no draw.

We verified with an instrumented `drawArrays` counter: at rest, **zero draws
per second** (was ~60); dragging redraws per pointer step; the time-animated
examples keep animating. Idle GPU cost dropped to nothing, which would have
been a good change even with no bug to fix.

The user confirmed: at rest, cured. During drag and zoom — where we *must*
redraw — the f64 half still sometimes collapsed. The driver theory held; the
uniform guard really was being folded.

## Fix two: a value no compiler will ever constant-fold

If the weakness is "the driver can observe the uniform," the fix is to store
the guard where observation doesn't help: a **texture**. No shader compiler on
any driver treats texel contents as compile-time constants — texture data is
the canonical runtime-opaque input. The guard is now a 1×1 texture whose only
texel reads exactly 1.0, and every helper fetches it:

```
float one = texelFetch(_fp64, ivec2(0, 0), 0).x;   // GLSL ES 3.00
let one = textureLoad(_fp64, vec2<i32>(0, 0), 0).x; // WGSL
```

One design detail mattered more than the shader change. Our whole
verification pyramid — the correctly-rounding f32 oracle, the metamorphic
gate — executes the *lowered IR* on the CPU, and a CPU oracle has no textures.
So the guard is an IR-level intrinsic, `f64Guard()`, with three spellings:
the WGSL fetch, the GLSL fetch, and — on the oracle — *the number 1*. Every
test that proved the emulation correct kept running, unchanged, across a
complete change of the guard's physical representation.

Plus one interaction nicety: since we now freeze the last frame at rest, that
last frame could freeze on a bad in-flight variant — so the loop schedules a
single settle draw ~300 ms after the inputs stop changing, giving the final
frame a second chance on the settled pipeline.

Deployed. The user's machine: clean at rest, clean while dragging and zooming.

## What we're keeping

- **"Runtime-opaque" must mean opaque to the pipeline's whole lifecycle**, not
  just the ahead-of-time compile. The luma.gl-style uniform guard defeats
  compile-time folding; it does not defeat uniform-value specialization in a
  background re-optimizer. Texel fetches defeat both. If your extended
  precision must survive arbitrary drivers, put the guard in a texture.
- **Render-on-demand is a correctness feature.** Skipping redundant draws is
  usually pitched as battery savings; here it structurally eliminated a whole
  class of nondeterminism — anything the driver does *between* draws can't
  show on a canvas that isn't redrawn.
- **Design experiments the reporter can run in one click.** We couldn't
  reproduce the bug; the fp64 toggle turned the user's machine into a
  controlled experiment and localized the fault in one message.
- **Give GPU-opaque values a CPU-exact twin.** Because the guard is an
  intrinsic with a per-target spelling rather than a hand-written fetch, the
  test suite survived the representation change byte-for-byte — the kind of
  seam you only appreciate the day you need it.

The [fp64 Mandelbrot](/shader-dsl/examples/fp64-mandelbrot) now pans and zooms
on that machine with both halves telling the story they were built to tell:
f32 frozen at its floor, f64 sharp for six more orders of magnitude — and
nothing in between flickers.
