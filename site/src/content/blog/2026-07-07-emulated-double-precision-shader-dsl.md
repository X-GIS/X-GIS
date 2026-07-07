---
title: 'Emulated double precision in the shader DSL'
description: "f64 and vecN<f64> as first-class shader-dsl types, emulated as two-f32 double-float pairs — same authoring syntax as f32, one lowering pass, ~48 significand bits."
date: 2026-07-07
tags: ['shader-dsl', 'precision', 'compiler', 'webgpu']
lang: en
---

At a world coordinate near $10^8$, f32's spacing is $\mathrm{ulp}_{f32}(10^8) = 8$:
every sub-integer detail is unrepresentable. GPUs offer no `f64` (WGSL has
none; GLSL ES never did), so map engines accumulate hand-rolled hi/lo
workarounds — relative-to-center encoding, DSFUN lane packing.

`@xgis/shader-dsl` now has the general mechanism: first-class **`f64`** and
**`vec2/3/4<f64>`** types, emulated as *double-float* (df64) pairs of f32s,
~48 significand bits. The design constraint: **authoring syntax is identical
to f32** — only the declared type differs.

```ts
const U = uniformStruct('U', { group: 0, binding: 0, as: 'u' }, {
  origin: vec3f64T, // ← the only fp64-specific line in the module
  scale: f64T,
})
const k = fn('k', { p: vec3f64T }, (args) =>
  toF32(length(args.p.sub(U.field.origin).mul(U.field.scale))),
)
```

## Representation

An f64 value is an unevaluated sum of two floats,

$$
x = x_{hi} + x_{lo}, \qquad |x_{lo}| \le \tfrac{1}{2}\,\mathrm{ulp}(x_{hi}),
$$

carried as a `vec2<f32>`. Arithmetic uses *error-free transformations*:
Knuth's twoSum, Dekker's quickTwoSum, the Veltkamp split (×4097 — FMA-based
twoProd is deliberately avoided; WGSL `fma()` accuracy is only "inherited
from x*y+z"). twoSum is the archetype: for any floats $a, b$,

$$
s = \mathrm{fl}(a + b), \qquad a + b = s + e \;\; \textit{exactly},
$$

with the error $e$ recovered by six ordinary additions. Division and square
root use an f32 seed plus one Newton–Raphson correction. Lineage: DSFUN90 →
the NVIDIA CUDA SDK Mandelbrot sample (`dsadd`/`dsmul`) → Thall's df64 paper
→ luma.gl's GLSL module.

## One lowering pass

All f64 semantics live in a single pre-emit pass, `fp64Lower`, wired into the
shared backend pipeline so WGSL and GLSL lower identically and the optimizer
only ever sees ordinary IR plus opaque `df64_*` calls:

- `f64` → `vec2<f32>`; literals split losslessly at build time (a JS number
  *is* an f64)
- `vecN<f64>` → `struct DF64VecN { hi: vecN<f32>, lo: vecN<f32> }`;
  componentwise `+ − × ÷` run the same EFTs on whole hi/lo planes
- `abs/min/max/mix/floor/fract/normalize` on vectors compose the verified
  scalar helpers lane by lane inside one helper body; `dot/length/distance`
  accumulate through the scalar df64 chain
- f32 widens implicitly (exact); narrowing is explicit `toF32(x)` only;
  every unsupported builtin on an f64 operand fails loud (`SD0041`)
- a module with no f64 passes through as the **same object** — non-f64 emit
  bytes are unchanged by construction

## The anti-fast-math guard

The EFT error terms are algebraically zero, and both WGSL (§15.7.5) and
common driver stacks permit reassociation that would legally delete them. The
lowering therefore threads a runtime-opaque `one` (value 1.0) through every
error-compensation term, and injects its source automatically: a **1×1
texture** bound as `_fp64`, fetched with `textureLoad`/`texelFetch`. A texel
is the strongest opacity WebGL offers — a uniform-sourced guard is defeated
by drivers that specialize pipelines on observed uniform values, which we
learned from a production bug report;
[the incident write-up](/blog/2026-07-07-the-flickering-mandelbrot) covers
that investigation. Hosts bind a texture whose texel reads exactly 1.0;
`fp64Guard({ group, binding })` pins the slot when a fixed bind-group layout
requires it.

## Layout and host surface

- An f64 uniform field or vertex attribute occupies its lowered `vec2<f32>`
  slot ({size 8, align 8}); vec64 fields use their struct's std140/std430
  layout through the same layout engine, so authored and lowered `reflect()`
  agree byte-for-byte.
- Hosts pack values with the exported `splitF64(x) = [hi, lo]`.
- f64 varyings are rejected (`SD0044`) — interpolating hi/lo pairs is
  numerically wrong. A vec64 vertex attribute is rejected with a
  two-`@location` + `f64FromParts` hint (the existing DSFUN lane convention).

## The demos

[![fp64 deep zoom](/shader/fp64-deep-zoom.jpg)](/shader-dsl/examples/fp64-deep-zoom)

[fp64 deep zoom](/shader-dsl/examples/fp64-deep-zoom): a world coordinate
near $10^8$ as `fract()` stripes — f32 (left) renders flat, f64 (right) keeps
the stripes.

[![fp64 Mandelbrot](/shader/fp64-mandelbrot.jpg)](/shader-dsl/examples/fp64-mandelbrot)

[fp64 Mandelbrot](/shader-dsl/examples/fp64-mandelbrot): a needle-spike
filament at a $\sim 10^{-7}$ span — narrower than one f32 ulp at
$x \approx -1.749$. Drag to pan, wheel to zoom (the camera accumulates in
JS doubles and lands in the `vec2<f64>` center uniform via `splitF64`), and
an `fp64` toggle routes the whole screen through the f32 branch for a direct
A/B.

## Scope and cost

Supported today: `+ − × ÷`, comparisons, `neg`, `abs`, `min`, `max`, `sqrt`,
`mix` (f32 interpolant), `floor`, `fract`, and on vectors additionally
`dot`, `length`, `distance`, `normalize`. Transcendentals and two-slot vec64
attributes are deferred and fail loud. Each df64 op costs several-to-10× its
f32 counterpart — opt in per *value*, not per shader.

How a numeric type like this gets tested without native f64 on the GPU or
native f32 on the CPU is its own topic:
[Testing emulated doubles](/blog/2026-07-07-testing-emulated-doubles).
