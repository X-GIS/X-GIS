---
title: 'Extended precision on the GPU: a field guide'
description: "The GPU has no double. There are four ways to get one anyway — double-float error-free transforms, integer emulation, reference-point rendering, and perturbation — and they are not interchangeable. A decision guide, from a survey of Thall, QD/CAMPARY, Cesium, deck.gl, and fractal deep-zoom engines."
date: 2026-07-09T22:00:00Z
tags: ['precision', 'numerical', 'gpu-drivers', 'rendering']
lang: en
series: { name: 'Emulating f64 in shaders', order: 8 }
draft: false
---

Consumer GPUs give you `f32` and, if you're lucky, an `f64` that runs at 1/32 to 1/64 the speed. For a globe, a fractal, or any world larger than a few million units, `f32`'s 24-bit mantissa runs out of resolution long before the scene does. There are four distinct ways to buy more precision, and choosing wrong costs either correctness or an order of magnitude of performance. This is the map, drawn from the primary sources.

## 1. Double-float (df64): two f32 that pretend to be a double

Represent a number as an **unevaluated sum** of two f32 — a high word and a low word carrying the rounding error the high word dropped. Every operation is an *error-free transform* (EFT): `twoSum` and `twoProd` compute both the rounded result and the exact residual, so precision propagates. You get ~48 mantissa bits at f32 exponent range, at roughly 40% of f32 throughput.

This is the lineage most web code descends from: [Andrew Thall's 2006 df64/qf128](https://andrewthall.org/papers/df64_qf128.pdf) (the canonical GPU paper), Bailey's double-double / QD, [CAMPARY](https://hal.science/hal-01312858/document) on CUDA, and luma.gl's WebGL module. The multiply is the delicate part — `twoProd` on the high words, then the low cross-products, then a renormalize — and the residual it computes is exactly the term a compiler can destroy.

**When it wins:** general-purpose extended-precision arithmetic anywhere in the shader, on a GPU whose compiler respects operation order.

**The catch — read [Part 7](/blog/2026-07-09-the-multiply-you-cannot-guard) first.** The EFT residual `e = b − (s − a)` is algebraically zero; a compiler with *fast-math* on (associative + distributive reassociation, FMA contraction) is licensed to prove it zero and delete it, collapsing df64 back to f32. Metal enables this **by default** ([gpuweb#2076](https://github.com/gpuweb/gpuweb/issues/2076): errors of "several thousand percent," eight orders of magnitude on Metal). The portable defense — thread a runtime-opaque `ONE` through the error terms — is [Thall's 2006 kludge](https://andrewthall.org/papers/df64_qf128.pdf), and it is a *stopgap*: it fixed Intel, but Apple silicon still collapses guarded df64 ([luma.gl#1764](https://github.com/visgl/luma.gl/issues/1764), open). No in-shader trick — multiplicative guard, additive guard, `precise`, partial bitcast — reliably survives Metal's default fast-math for the multiply. If you need df64 and hit this, your real options are the next three.

## 2. Integer emulation: leave the float domain entirely

Emulate IEEE FP64 with **32-bit integer** operations — extract the mantissa and exponent as `u32`, multiply and carry by hand, reconstruct — the way [philipturner/metal-float64](https://github.com/philipturner/metal-float64) does (ideas from SoftFloat/LLVM). Integer arithmetic carries no floating-point error terms, so there is nothing for fast-math to reassociate away: it is **immune by construction**, and it buys true IEEE semantics (11-bit exponent, 52-bit mantissa, denormals, INF/NAN) that the df64 trick can't.

**When it wins:** you genuinely need full `f64` and cannot restructure — and you can afford the price. The price is steep: ~1/32 to 1/64 of native f32, Metal-only in that implementation, and archived/incomplete. This is a correctness backstop, not a real-time path.

## 3. Reference-point rendering: subtract the magnitude first

The precision problem isn't that coordinates are *large*; it's that a large coordinate plus a small detail can't both fit in 24 bits. So don't put the large part on the GPU. Keep the origin (the eye, or a per-tile anchor) in `f64` **on the host**, subtract it there, and hand the GPU only a small offset where f32 has bits to spare.

- **Cesium** encodes each 64-bit position as two f32 (high + low) and renders **relative-to-eye** (GPU RTE): the [vertex shader is procedurally modified](https://cesium.com/blog/2015/05/26/graphics-tech-in-cesium-stack/) to do the high-precision subtraction.
- **deck.gl deprecated its fp64 module** in favour of a 32-bit reference-point projection (deck.gl 6.1), reaching sub-centimetre precision at f32 speed. Their [docs](https://deck.gl/docs/developer-guide/fp64) now call fp64 "more of a niche technology" — and name the reason: "workarounds are needed to prevent GPU drivers from optimizing away critical parts of the code."

The one high-precision operation that survives is the host-side subtract (or a df64 `add`, which is well-conditioned and *does* survive fast-math). There is no per-pixel high-precision **multiply** to corrupt.

**When it wins:** large static coordinates — maps, globes, planetary terrain. This is the default for GIS.

## 4. Perturbation: one orbit at high precision, the rest as deltas

For iterated systems — the multiply-heavy case, like a Mandelbrot deep-zoom — reference-point isn't enough, because the *iteration itself* squares a high-precision number every step. [Perturbation theory](http://www.mrob.com/pub/muency/perturbationmethods.html) fixes it: iterate **one** reference orbit `Z_n` at high precision (once, on the host or in a prepass), then compute every pixel as a delta from it in **native f32**:

$$\delta_{n+1} = 2\,Z_n\,\delta_n + \delta_n^2 + \delta c$$

The high-precision multiply is confined to the single reference orbit; the per-pixel loop is pure f32. When the deltas themselves underflow f32's *exponent*, an extended-range float (a mantissa-f32 + int-exponent pair) fixes the range without needing an emulated-double *mantissa* — a different, cheaper problem.

**When it wins:** deep-zoom fractals and any per-pixel iteration where reference-point alone leaves a high-precision multiply in the inner loop.

## The decision, in one table

| Situation | Use | Why |
|---|---|---|
| General extended-precision math, correct-rounding GPU | **df64** | Simple, ~40% f32, works where the compiler behaves |
| Large static coordinates (maps, globes) | **Reference-point / RTE** | No per-pixel high-precision multiply exists to corrupt |
| Per-pixel iteration (deep-zoom fractals) | **Perturbation** | Confines high precision to one reference orbit |
| True IEEE f64 required, cannot restructure | **Integer emulation** | Fast-math-immune, but ~1/32 f32 and incomplete |
| Anywhere, as a compiler stopgap | df64 + opaque-`ONE` guard | Helps, but fragile — do not rely on it on Metal |

The through-line: **df64 is a tool, not a default.** For well-conditioned arithmetic it is correct and cheap on every GPU. For the catastrophic-cancellation cases that actually motivate wanting a double — a small delta against a planet-sized coordinate — the durable answer is not a more precise multiply but a smaller number: move the magnitude off the GPU (reference-point) or out of the inner loop (perturbation), so the fragile operation never runs. Two of the biggest names in web geospatial rendering, Cesium and deck.gl, both landed there. The multiply you don't perform is the only one a fast-math compiler can't break.

## References

1. Andrew Thall, ["Extended-Precision Floating-Point Numbers for GPU Computation"](https://andrewthall.org/papers/df64_qf128.pdf) — the canonical df64/qf128 paper; split-based `twoProd`, the FMA collapse, the `ONE` guard.
2. Joldes, Muller, Popescu et al., [CAMPARY](https://hal.science/hal-01312858/document) — CUDA multiple-precision via floating-point expansions (relies on IEEE-compliant FMA that fast-math shaders withhold).
3. WebGPU, [Issue #2076](https://github.com/gpuweb/gpuweb/issues/2076) — Metal's default associative/distributive fast-math; the case for a whole-shader disable.
4. luma.gl, [Issue #1764](https://github.com/visgl/luma.gl/issues/1764) — df64 collapse on Apple M1 Max despite the guard.
5. [philipturner/metal-float64](https://github.com/philipturner/metal-float64) — integer-based IEEE FP64 on Apple GPUs.
6. Cesium, [GPU RTE](https://cesium.com/blog/2015/05/26/graphics-tech-in-cesium-stack/); deck.gl, [64-bit precision (deprecated)](https://deck.gl/docs/developer-guide/fp64).
7. R. Munafo, [Perturbation methods](http://www.mrob.com/pub/muency/perturbationmethods.html); C. Heiland-Allen, [deep-zoom theory and practice](https://mathr.co.uk/blog/2021-05-14_deep_zoom_theory_and_practice.html).
