---
title: 'The multiply you cannot guard'
description: "I shipped four in-shader fixes for the df64 multiply collapsing to zero on an Apple GPU. Every one failed on-device. Then the research settled it: Metal's default fast-math deletes the error term by construction, no opaque-guard trick reliably survives, and the durable answer is to restructure the math so the high-precision multiply never happens — which is why deck.gl deprecated emulated fp64."
date: 2026-07-09T20:00:00Z
tags: ['precision', 'gpu-drivers', 'numerical', 'compilers']
lang: en
series: { name: 'Emulating f64 in shaders', order: 7 }
draft: false
---

On an iPhone, one emulated-double multiply reads **exactly `0.0`** where it should read `0.5`. `1e8 · (1 + 5e-9) − 1e8` — a large coordinate times a value a hair over one, minus the coordinate. The `0.5` lives entirely in the cross term `1e8 · 5e-9`, and the cross term is gone. Not mis-rounded — *deleted*. Every other df64 op on the same device — add, subtract, sqrt, fract, the whole distance reduction — holds. Only the multiply, and only in this catastrophic-cancellation shape, collapses.

I spent a day trying to guard it from inside the shader. Here is the scoreboard, because the failures are the point.

## Four fixes, four deletions

Our df64 error-free transforms already thread a runtime-opaque `one` (a texel that reads `1.0`, which the compiler can't constant-fold) through every intermediate — the standard defense. The multiply collapsed anyway, so:

1. **Guard the cross term** — `(a·b_lo)·one`. It regressed a *passing* probe (`mul_sq`, a genuine hi·hi product) and did nothing for the target. Reverted within the hour. The guard was on `b_lo`, but the common factor `a` sits *outside* it — the compiler factors `a` out regardless, and `b_hi + b_lo` rounds back to `b_hi`.
2. **Match luma.gl's structure** — renormalize (a guarded `quickTwoSum`) after *each* cross term instead of once at the end. This is a real deviation from the textbook QD multiply, present in luma.gl and donmccurdy's Apple-focused port. On-device: no effect. The multiply still read `0`.
3. **Additive guard** — luma.gl's WGSL uses `x + (one·0)` where ours uses `x · one`. Different barrier, worth trying.
4. **Leave the float domain** — bounce the cross term through an integer `bitcast<u32>` round-trip with an opaque-integer add, so float reassociation can't cross it.

I batched (3) and (4) into a probe and shipped it. They came back inconclusive — a harness bug, not a verdict — but by then the pattern was unmistakable: **I was inventing arithmetic tricks and the compiler was deleting them faster than I could ship.** So I stopped inventing and went to the literature.

## What the research settled

The short version, from primary sources: **this is not fixable from inside the shader, and everyone who has tried has concluded the same.**

- **The root cause is a compiler default, not a bug.** WebGPU's own [issue #2076](https://github.com/gpuweb/gpuweb/issues/2076) states it plainly: the emulated-double algorithm is "extremely sensitive to changes in operation order (associative and distributive rules cannot be used)," Metal enables associative/distributive fast-math **by default** (D3D doesn't outside fused ops; Vulkan only inside builtins), and the result is "errors of several thousand percent" — *eight orders of magnitude* on the Metal backend. The proposed remedy is an **API-level, whole-shader fast-math disable** in `createShaderModule` — explicitly *not* an in-shader arithmetic trick. As of writing, WGSL has not shipped it.

- **The opaque-`one` guard was already the best known trick — and it was already known to be fragile.** It is not a luma.gl invention; it is [Andrew Thall's 2006 kludge](https://andrewthall.org/papers/df64_qf128.pdf) ("Defining ONE as a uniform parameter-multiplier for constants was only one of the necessary kludges to sidestep the aggressive cgc compiler"). Thall also documents that the compact FMA-based `twoProd` gets folded to `y = 0` by "an overly helpful compiler" — the *identical* deletion, twenty years and three GPU vendors earlier — and that his fix was to abandon it for the longer split form, which we already use. We were standing on the best in-shader technique in existence, and [luma.gl's own bug tracker](https://github.com/visgl/luma.gl/issues/1764) has it collapsing on an Apple M1 Max regardless, still open.

- **No source demonstrates any in-shader construction** — multiplicative guard, additive guard, `precise`, partial bitcast — that reliably survives Metal's default fast-math for the *multiply*. The two things that *do* work are both escapes, not patches.

## The two things that actually work

**Integer emulation.** [philipturner/metal-float64](https://github.com/philipturner/metal-float64) emulates IEEE FP64 with 32-bit *integer* operations (ideas from SoftFloat/LLVM). Integer arithmetic carries no floating-point error terms, so there is nothing for fast-math to reassociate away — it is immune by construction. The catch is that it is archived, Metal-only, add/mul/FMA-only, and runs at roughly **1/32 to 1/64 of native f32**. Immune, but not real-time.

**Restructure so the multiply never happens.** This is the answer, and the industry already made the move:

- **deck.gl deprecated its fp64 module** in favour of a 32-bit reference-point projection (deck.gl 6.1), reaching sub-centimetre precision at 32-bit speed. Their [own docs](https://deck.gl/docs/developer-guide/fp64) call fp64 "more of a niche technology" now — and confirm the exact driver problem in production: "workarounds are needed to prevent GPU drivers from optimizing away critical parts of the code… every now and then we encounter a new driver that needs special treatment."
- **Cesium** encodes a 64-bit position as two f32 (high + low) and renders **relative-to-eye**: the huge coordinate is subtracted on the *host*, and the GPU only ever sees a small offset where f32 has bits to spare.
- **Fractal deep-zoom** uses [perturbation theory](http://www.mrob.com/pub/muency/perturbationmethods.html): iterate *one* reference orbit at high precision, then compute every pixel as a delta `δ_{n+1} = 2·Z_n·δ_n + δ_n² + δc` in **native f32**. The high-precision multiply is confined to a single orbit computed once; the per-pixel loop has no emulated multiply to corrupt.

Every one of these has the same shape: **remove the large magnitude before the GPU multiplies, so the catastrophic cancellation that needs the error term never forms.** You don't protect the fragile operation. You arrange for it not to exist.

## What generalizes

There is a stage in fighting a compiler where each new guard feels like it *should* be the one that works — the barrier is more opaque, the reassociation has one fewer place to hide. That feeling is the trap. Fast-math on a multiply is licensed to apply the distributive law, and the distributive law has a common factor to pull out no matter how you decorate the operands; the only winning move against `a·b_hi + a·b_lo → a·(b_hi + b_lo)` is for that sum never to be written. When the well-conditioned half of your system (add, subtract, sqrt) sails through and only the catastrophic-cancellation multiply dies, that is not a guard you are missing — it is the math telling you to move the magnitude somewhere the multiply can't see it. deck.gl took years and a deprecation to learn it. It took me a day and four reverts, which is the same lesson at a discount.

The emulated double still earns its place — for well-conditioned arithmetic it is correct and fast on every GPU we tested. But for a coordinate the size of a planet, the answer was never a better guard. It was a smaller number.

## References

1. WebGPU, [Issue #2076 — disable fast-math per shader](https://github.com/gpuweb/gpuweb/issues/2076) — Metal enables associative/distributive fast-math by default; errors up to 8 orders of magnitude; remedy is an API-level whole-shader switch.
2. Andrew Thall, ["Extended-Precision Floating-Point Numbers for GPU Computation"](https://andrewthall.org/papers/df64_qf128.pdf) — the split-based `twoProd`, the FMA-collapse, and the original `ONE` guard kludge (2006).
3. luma.gl, [Issue #1764 — fp64 not working on Apple M1 Max](https://github.com/visgl/luma.gl/issues/1764) — the guard defeated on Apple silicon; still open.
4. [philipturner/metal-float64](https://github.com/philipturner/metal-float64) — integer-based IEEE FP64 emulation, immune to fast-math, ~1/32–1/64 native throughput.
5. deck.gl, [64-bit precision (deprecated)](https://deck.gl/docs/developer-guide/fp64) and Cesium, [GPU RTE](https://cesium.com/blog/2015/05/26/graphics-tech-in-cesium-stack/) — reference-point rendering.
6. R. Munafo, [Perturbation methods for deep-zoom](http://www.mrob.com/pub/muency/perturbationmethods.html) — reference-orbit delta iteration in native precision.
7. Earlier in this series: [Part 5 — the low word a load throws away](/blog/2026-07-09-the-low-word-a-load-throws-away) and [Part 6 — add held, mul collapsed](/blog/2026-07-09-add-held-mul-collapsed).
