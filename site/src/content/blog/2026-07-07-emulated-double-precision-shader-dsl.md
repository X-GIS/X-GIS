---
title: 'Emulated double precision in the shader DSL'
description: 'f64 and vecN<f64> as first-class shader-dsl types, emulated as two-f32 double-float pairs — same authoring syntax as f32, one lowering pass, ~48 significand bits.'
date: 2026-07-07T03:32:00Z
tags: ['shader-dsl', 'precision', 'compiler', 'webgpu']
lang: en
---

At a world coordinate near $10^8$, f32's spacing is $\mathrm{ulp}_{f32}(10^8) = 8$:
every sub-integer detail is unrepresentable. GPUs offer no `f64` (WGSL has
none; GLSL ES never did), so map engines accumulate hand-rolled hi/lo
workarounds — relative-to-center encoding, DSFUN lane packing. Those hold
while the precision only has to survive _into_ a coordinate: recenter once on
the CPU, render f32 offsets. They break the moment the coordinate feeds
_iterated_ nonlinear arithmetic — the fp64 Mandelbrot below squares
$z \mapsto z^2 + c$ hundreds of times per pixel, and a once-recentered offset
loses its tail on the first squaring. That is when you need precision carried
_through_ the operations, which is a general df64 type, not a coordinate
trick.

`@xgis/shader-dsl` now has the general mechanism: first-class **`f64`** and
**`vec2/3/4<f64>`** types, emulated as _double-float_ (df64) pairs of f32s,
~48 significand bits. The design constraint: **authoring syntax is identical
to f32** — only the declared type differs.

```ts
const U = uniformStruct(
  'U',
  { group: 0, binding: 0, as: 'u' },
  {
    origin: vec3f64T, // ← the only fp64-specific line in the module
    scale: f64T,
  },
)
const k = fn('k', { p: vec3f64T }, (args) =>
  toF32(length(args.p.sub(U.field.origin).mul(U.field.scale))),
)
```

## Representation

An f64 value is an unevaluated sum of two floats,

$$
x = x_{hi} + x_{lo}, \qquad |x_{lo}| \le \tfrac{1}{2}\,\mathrm{ulp}(x_{hi}),
$$

carried as a `vec2<f32>`. Arithmetic uses _error-free transformations_ (EFTs):
Knuth's 2Sum [2], Dekker's Fast2Sum and the Veltkamp split [1] (×4097 —
FMA-based twoProd is deliberately avoided; WGSL `fma()` accuracy is only
"inherited from x*y+z"). 2Sum is the archetype: for any floats $a, b$,

$$
s = \mathrm{fl}(a + b), \qquad a + b = s + e \;\; \textit{exactly},
$$

with the error $e$ recovered by six ordinary additions — the same expansion
machinery behind Shewchuk's robust geometric predicates [3] and the
double-double/quad-double libraries [4]. Division and square root use an f32
seed plus one Newton–Raphson correction, following luma.gl's formulation [7].
The GPU lineage runs DSFUN90 [5] → the NVIDIA CUDA SDK Mandelbrot sample's
`dsadd`/`dsmul` [6] → Thall's df64/qf128 paper [8] → luma.gl [7].

## One lowering pass

All f64 semantics live in a single pre-emit pass, `fp64Lower`, wired into the
shared backend pipeline so WGSL and GLSL lower identically and the optimizer
only ever sees ordinary IR plus opaque `df64_*` calls:

- `f64` → `vec2<f32>`; literals split losslessly at build time (a JS number
  _is_ an f64)
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

The EFT error terms are algebraically zero, and the WGSL specification
explicitly permits implementations to reassociate and fuse floating-point
operations [9][10] — a legal transformation that deletes the whole mechanism.
The lowering therefore threads a runtime-opaque `one` (value 1.0) through
every error-compensation term — luma.gl's
`LUMA_FP64_CODE_ELIMINATION_WORKAROUND` [7] — and injects its source
automatically: a **1×1 texture** bound as `_fp64`. The emitted 2Sum shows the
shape (the fetch is CSE-hoisted once per helper body):

```wgsl
fn df64_twoSum(a: f32, b: f32) -> vec2<f32> {
  let _cse0 = textureLoad(_fp64, vec2<i32>(0, 0), 0).x;
  let _v0 = (a + b);
  let _v1 = (((_v0 * _cse0) - a) * _cse0);
  let _v2 = (((((a - ((_v0 - _v1) * _cse0)) * _cse0) * _cse0) * _cse0) + (b - _v1));
  return vec2<f32>(_v0, _v2);
}
```

A texel is the strongest opacity WebGL offers: a uniform's value is visible to
the pipeline compiler and can be specialized on, whereas current WebGL2/WebGPU
stacks never fold texture contents into a compile-time constant. A
uniform-sourced guard is therefore defeated by drivers that specialize
pipelines on observed uniform values, which we learned from a production bug
report —
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
attributes are deferred and fail loud. Each df64 op expands to a chain of these
EFTs — an add to two 2Sums plus two renormalizing quick-2Sums, a multiply to a
two-Veltkamp-split 2Prod plus its cross terms — so the emitted body is on the
order of a few dozen f32 ops, and the helpers stay out-of-line calls (they are
never inlined, by design). Roughly an order of magnitude over the f32
counterpart: opt in per _value_, not per shader.

How a numeric type like this gets tested without native f64 on the GPU or
native f32 on the CPU is its own topic:
[Testing emulated doubles](/blog/2026-07-07-testing-emulated-doubles).

## References

1. T. J. Dekker, ["A Floating-Point Technique for Extending the Available
   Precision,"](https://doi.org/10.1007/BF01397083) _Numerische Mathematik_
   18 (1971), 224–242 — Fast2Sum, the split, and double-length arithmetic.
2. D. E. Knuth, _The Art of Computer Programming_, Vol. 2:
   _Seminumerical Algorithms_, §4.2.2 — the 2Sum algorithm.
3. J. R. Shewchuk, ["Adaptive Precision Floating-Point Arithmetic and Fast
   Robust Geometric Predicates,"](https://people.eecs.berkeley.edu/~jrs/papers/robust-predicates.pdf)
   _Discrete & Computational Geometry_ 18 (1997), 305–363.
4. Y. Hida, X. S. Li, D. H. Bailey, ["Algorithms for Quad-Double Precision
   Floating Point Arithmetic,"](https://www.davidhbailey.com/dhbpapers/arith15.pdf)
   _Proc. ARITH-15_ (2001), 155–162.
5. D. H. Bailey, [DSFUN90: a double-single floating-point
   package](https://www.davidhbailey.com/dhbsoftware/).
6. NVIDIA, [CUDA Samples — Mandelbrot](https://github.com/NVIDIA/cuda-samples)
   (`dsadd`/`dsmul`, the original GPU double-single port).
7. luma.gl, [fp64 shader module](https://luma.gl/docs/api-reference/shadertools/shader-modules/fp64)
   — GLSL df64 with the `ONE`-threading code-elimination workaround.
8. A. Thall, ["Extended-Precision Floating-Point Numbers for GPU
   Computation"](https://andrewthall.org/papers/df64_qf128.pdf) (2006) —
   df64/qf128 on graphics hardware.
9. W3C, [WebGPU Shading Language — Reassociation and
   fusion](https://www.w3.org/TR/WGSL/#reassociation).
10. gpuweb/gpuweb, [issue #2402: "reassociation is always
    allowed"](https://github.com/gpuweb/gpuweb/issues/2402).
