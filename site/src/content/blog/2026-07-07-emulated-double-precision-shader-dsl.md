---
title: 'Emulated double precision in the shader DSL'
description: "GPUs don't have f64 — so we taught the shader IR to fake it with pairs of f32s, without changing a line of authoring syntax. On surviving fast-math compilers, testing a numeric type you can't run natively, and a Mandelbrot you can feel."
date: 2026-07-07
tags: ['shader-dsl', 'precision', 'compiler', 'webgpu']
lang: en
---

Zoom deep enough into any map and `f32` runs out. At a world coordinate near
$10^8$, a 32-bit float's spacing is $\mathrm{ulp}_{f32}(10^8) = 8$ — **eight
whole units** between representable values, so every sub-integer detail is
gone. GPUs don't offer `f64` (WGSL has none; GLSL ES never did), which is why
map engines grow hand-rolled hi/lo tricks: relative-to-center encoding, DSFUN
lane packing, per-case workarounds scattered through the shaders.

We just landed the general version in `@xgis/shader-dsl`: a first-class **f64
type** — plus `vec2/3/4<f64>` — emulated as *double-float* (df64) pairs of
f32s, good for ~48 significand bits. The hard constraint we set ourselves:
**authoring syntax must not change.** Only the declared type differs.

```ts
const U = uniformStruct('U', { group: 0, binding: 0, as: 'u' }, {
  origin: vec3f64T, // ← the only fp64-specific line in the module
  scale: f64T,
})
const k = fn('k', { p: vec3f64T }, (args) =>
  toF32(length(args.p.sub(U.field.origin).mul(U.field.scale))),
)
```

`.add`, `.mul`, comparisons, `sqrt`, `dot`, swizzles — all unchanged. There is
nothing fp64-shaped to learn and nothing to declare.

## One pass owns the semantics

df64 is old, good technology: represent a double as an unevaluated sum of two
floats,

$$
x = x_{hi} + x_{lo}, \qquad |x_{lo}| \le \tfrac{1}{2}\,\mathrm{ulp}(x_{hi}),
$$

and use *error-free transformations* — Knuth's twoSum, Dekker's quickTwoSum,
the Veltkamp split — to keep the rounding error of every operation as an
explicit second term. twoSum is the archetype: for any two floats $a, b$,

$$
s = \mathrm{fl}(a + b), \qquad a + b = s + e \;\; \textit{exactly},
$$

where the error $e$ is itself a float, recovered with six ordinary additions.
The lineage runs from Bailey's DSFUN90 through the NVIDIA CUDA SDK's
Mandelbrot sample (`dsadd`/`dsmul`) and Thall's df64 paper to luma.gl's GLSL
port.

In the DSL, all of it lives in **one pre-emit lowering pass**. `fp64Lower`
rewrites every f64 into `vec2<f32>` (vectors into a `{hi, lo}` plane struct)
and every operation into a call against an injected `df64_*` helper library —
itself authored in the DSL. The pass sits inside the shared backend pipeline,
so WGSL and GLSL lower identically, the optimizer never sees an f64, and a
module that doesn't use f64 passes through as the *same object* — the existing
emit goldens moved by zero bytes.

## The compiler is allowed to delete your algorithm

Here's the fun part. The core of twoSum is:

```
s = a + b
v = s - a
e = (a - (s - v)) + (b - v)   // the rounding error of s = a + b
```

In *real-number* algebra that error term collapses:

$$
(a - (s - v)) + (b - v) \;=\; a + b - s \;=\; 0.
$$

It is only nonzero because each intermediate **rounds**. And the WGSL spec
(§15.7.5) explicitly permits reassociation; Metal compiles with fast-math by
default; ANGLE's D3D path reorders too. Any of them is **legally allowed to
fold your entire error-compensation term to 0.0 at compile time** — silently
collapsing df64 back to f32 precision. Your tests on one GPU pass; a user's
Mac quietly loses 24 bits.

The only portable defense (battle-tested by luma.gl) is to make the values
*runtime-opaque*: thread a uniform `one` — that the compiler cannot prove is
1.0 — through the EFT intermediates: `(s * one - a) * one`. We bake this in
from the start, and the guard uniform is **auto-injected by the lowering** at
a deterministic binding slot. Authors declare nothing; hosts write `1.0f` into
the buffer. The one failure mode no CPU-side test can see is covered by a
real-GPU gate: known-answer vectors on WebGPU/Tint and WebGL2/ANGLE, each with
a *discriminative* assertion that plain f32 provably fails — so the test can't
pass vacuously.

## Testing a type you can't run natively

How do you unit-test f64 emulation without a GPU in CI? Two tricks carried the
whole feature:

**A correctly-rounding f32 machine, for free.** Take the *actual lowered IR*,
wrap every f32-typed operation in `Math.fround`, and evaluate it on the CPU
oracle. JS numbers are IEEE doubles, and
$\mathrm{fround}(x \circ y) = \mathrm{fl}_{32}(x \circ y)$ — exactly f32
arithmetic — so the known-answer suite executes the very code the GPU will
run, under a bit-exact f32 model, against vectors like
$(10^8 + 0.5) - 10^8 = 0.5$ that single precision provably cannot produce.

**A metamorphic gate.** The CPU oracle evaluates f64 *natively* (a JS number
IS an f64), and lowering is meant to preserve semantics — so
`oracle(fp64Lower(m)) ≈ oracle(m)` must hold for any module. One property,
every rewrite rule covered.

Below those sit byte-stable emit goldens (the guard threading is *pinned as
text*) and optimizer invariants (df64 helpers are never inlined, `* _fp64.one`
survives the fixpoint).

## A Mandelbrot you can feel

The classic df64 demo, updated for the gallery — and wired to the new pointer
uniform. Both examples split the screen: the **left half computes in plain
f32, the right half runs the same formula on f64**.

[![fp64 deep zoom — f32 collapses flat on the left, f64 keeps the stripes on the right](/shader/fp64-deep-zoom.jpg)](/shader-dsl/examples/fp64-deep-zoom)

[fp64 deep zoom](/shader-dsl/examples/fp64-deep-zoom) sweeps a world
coordinate near 10⁸ across the screen as `fract()` stripes: f32 renders a flat
field (the fraction is unrepresentable), f64 renders clean stripes.

[![fp64 Mandelbrot — the needle-spike filament at a 1e-7 span](/shader/fp64-mandelbrot.jpg)](/shader-dsl/examples/fp64-mandelbrot)

[fp64 Mandelbrot](/shader-dsl/examples/fp64-mandelbrot) zooms a needle-spike
filament to a $\sim 10^{-7}$ span — *narrower than one f32 ulp at
$x \approx -1.749$*, so the f32 half cannot distinguish any two pixels in the
window. **Drag to pan and wheel to zoom, map-style.** The camera is the
host-side half of the story: drags accumulate in full JS-double precision and
land in the `vec2<f64>` center uniform via `splitF64` every frame, so the f64
half stays sharp from the f32 floor near $10^{-7.5}$ all the way down to the
df64 floor near $10^{-13}$ — six more orders of magnitude. And both examples
carry an **fp64 toggle** — flip it off and the f64 half collapses to f32 in
place, which is the whole feature in one switch. You can feel exactly where
each precision runs out.

## What the examples caught

Building the live examples flushed out two latent library bugs that no fp64
code caused but fp64 code was the first to hit: the GLSL uniform-block emitter
mis-laid-out **nested structs** (the `{hi, lo}` plane struct was the first
struct-in-struct uniform any example shipped), and a contextual-inference
footgun where an inline `select(0.0, 1.0)` could get its type pinned by an
unrelated broadcast overload. Both are fixed in the same PR — the quiet
argument for building real examples on top of new machinery before calling it
done.

The full gate hierarchy, the guard design, and the vector lowering are in the
PR if you want the details; the authoring story is in the shader-dsl
[AUTHORING](https://github.com/X-GIS/X-GIS/blob/main/shader-dsl/AUTHORING.md)
docs, §7.
