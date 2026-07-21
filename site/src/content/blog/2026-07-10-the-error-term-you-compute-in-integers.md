---
title: 'The error term you compute in integers'
description: 'Fast-math deleted our emulated-double multiply on Apple GPUs, and every float-side guard — including hardware FMA — died with it. So we rebuilt twoSum and twoProd in u32 bit arithmetic: same pair format, same compositions, exact by construction. The device that zeroed every float variant returned the golden answer.'
date: 2026-07-10T12:00:00Z
tags: ['precision', 'gpu-drivers', 'numerical', 'compilers']
lang: en
---

The [previous post in this series](/blog/2026-07-09-the-multiply-you-cannot-guard) ended on a resigned note: when a shader compiler's fast-math is licensed to apply the distributive law, no decoration of the operands protects the error term of an emulated-double multiply. The industry's answer is to restructure — subtract the planet-sized coordinate on the CPU so the GPU never sees a catastrophic cancellation. That is still the right answer _when you can take it_.

This post is about what to do when you can't. We ship a shader DSL — a library. A library does not get to choose its callers' coordinates. Someone will feed it `1e8 · (1 + 5e-9) − 1e8` on an iPhone, and "restructure your application" is not an error message a compiler is allowed to print. The library needs a lowering that is _correct on the worst case_, even if it costs more. We built one, and the route there produced the two most useful measurements of the whole saga.

## Fusion is not protection

The obvious candidate fix was FMA. The textbook alternative to the split-based `twoProd` is Two-Product-FMA — `e = fma(a, b, −a·b)` — one fused instruction, a single rounding, nothing to distribute. Thall's 2006 paper even recommends it where hardware supports it. Our library had deliberately avoided it, citing WGSL's spec language that `fma`'s accuracy is merely "inherited from `x*y+z`" — fusion not guaranteed.

So the first probe we shipped asked the question directly. `dg_fma_fused` computes `fma(v, v, −fround(v²)) · 2²⁴` for `v = 1 + 2⁻¹²`: the square has a tail exactly one bit below the f32 ulp, so a genuinely fused FMA recovers it (reads ~1.0) and a non-fused fallback rounds it away (reads 0).

On the iPhone: **1.0000. Apple's WGSL `fma` is genuinely fused.**

And in the same run, the FMA-based twoProd — `dg_mb_fma` — **still failed**, reading −1.5 where 0.5 was the answer.

That pair of numbers is worth the whole experiment. The mental model "fast-math breaks the error term because the multiply double-rounds" is wrong. The multiply was single-rounded, atomic, hardware-fused — and the _surrounding algebra_ was still rewritten. Metal doesn't need to open the `fma` to destroy the algorithm; it reassociates the cancellation around it: `big·hi − big + fma(...)` has enough float structure left to fold. Fusion protects one operation. Reassociation attacks the expression.

## The boundary: one integer is safe, a float sandwich is not

If no float formulation survives, the remaining move is to leave the domain. Integer arithmetic carries no rounding, so a fast-math pass — whose license extends only to floating-point — cannot touch it. The archived `metal-float64` project proved the principle years ago by emulating full IEEE FP64 in 32-bit integers.

But "rewrite everything in integer softfloat" is a big hammer, so we probed for the _minimal_ integer island first. Two variants, one deploy:

- `dg_imul`: the product `big · lo` assembled entirely in u32 bit arithmetic — unpack the IEEE fields, 24×24-bit mantissa product via 12-bit halves, renormalize, pack. **No float multiply exists.** Result on the iPhone: **0.5000 — survives.**
- `dg_iboth`: _both_ products integer-assembled, but the cancellation between them left as float ops: `imul(big,hi) − big + imul(big,lo)`. Result: **−1.5 — dies.**

So the boundary is exact. A value _produced_ by integer arithmetic is opaque to the optimizer — there is no float expression to rewrite. But the moment two such values meet in a float subtract at planet magnitude, the reassociator owns the expression again. The integer island has to cover the _entire_ multiply-cancel-add chain, down to where the result is small.

## Swap the leaves, keep the tree

The pleasant surprise was how little that requires. An emulated-double library looks big — add, sub, mul, div, sqrt, floor, fract, comparisons, vector lanes, matrices — but it bottoms out in a handful of _error-free transformations_: `twoSum` (exact `s + e = a + b`) and `twoProd` (exact `p + e = a·b`), plus a couple of derived forms. Everything else is composition, and the compositions call the primitives _by name_.

So the integer flavor swaps only the leaves:

- **`twoSum`**, in u32: unpack both floats to (mantissa, exponent) — magnitude-order them with the classic trick that IEEE bit patterns of same-sign floats compare like integers — align the smaller mantissa (a ≤ 25-bit shift; beyond that, `(a, b)` already _is_ the exact pair, which is the textbook far-path), add or subtract 24-bit limbs with carry/borrow, then round.
- **`twoProd`**, in u32: the exact 48-bit mantissa product from 12-bit halves, then round.
- A shared **rounding tail**: find the leading bit, round to 24 bits with real round-to-nearest-even (round bit, sticky bits, ties-to-even, carry renormalization), and — the part that makes it an EFT and not just a multiply — extract the discarded remainder _exactly_ as the second word. The classic theorem that the error of a rounded add/multiply is itself representable does the safety proof for us; the remainder always fits.
- `div` and `sqrt` keep their float bodies minus the old anti-fold guard: their seeds are single approximate operations (one reciprocal, one rsqrt) whose error the Newton step corrects through the now-exact integer sub and mul. A lone float op has nothing to reassociate with.

Same names, same `(hi, lo)` pair signature — so every composition in the library binds to the integer leaves untouched, and the guard machinery (the runtime-opaque `one` texel threaded through every float EFT) simply disappears: there is no error term left for a compiler to prove away.

Two implementation notes that cost us an afternoon each, recorded so they cost you nothing. First, GPU `select` evaluates _both_ arms, so a shift amount that is only meaningful in one arm still executes in the other — u32 shifts are defined mod 32 everywhere we emit (WGSL, GLSL, and our CPU oracle's JS), so the discarded arm computes well-defined garbage, which is fine, but you have to _decide_ that on purpose for every shift. Second, keep every exponent in a biased unsigned domain (+400 covers the product grids, which reach 2⁻¹⁴⁸ below the exponent field) — mixing signed arithmetic into u32 IR is where off-by-wraparound bugs breed.

## Proving it before the GPU sees it

The verification asset that made this safe to ship already existed: a CPU oracle that executes the _lowered_ IR with every f32 operation wrapped in `Math.fround` — real 24-bit rounding, no GPU, no driver. Pointing the same property harness at the integer flavor gave 20,000 seeded-random inputs per operation, and one assertion the float flavor could never make: for pure-f32 inputs, the integer `twoSum`/`twoProd` high word must equal `fround(exact)` **bit for bit** — it computes the true sum and rounds once, so anything else is a bug, not a tolerance. Plus the directed edges rounding code owes an answer to: a tie that must go to even, a round-up that carries into a new exponent, exact cancellation that must return `+0`, the far-path boundary at shift 25 versus 26, gradual underflow.

Then the on-device verdict, from the same free macOS CI oracle that replaced our paste-from-a-phone loop. Same run, same Apple GPU:

```
float flavor:    mul  → 0.0000  collapsed     div → 1.0000  wrong
integer flavor:  mul  → 0.5000  ✓             div → 0.5000  ✓
                 sub, mul_sq, sqrt, fract, vec_mul → 0.5000  ✓
                 loran chain → 0.1087  (the f64 golden, 4 decimals)
                 random composition tree → 0.0000  (golden)
```

The composed navigation chain — two distances, a subtract, a fract, the shape that started this whole series — reads the double-precision golden answer on the device where every float variant of it collapsed.

## The bill, and who should pay it

Integer EFT is not free, and the cost showed up somewhere we didn't expect: not execution, _compilation_. On Windows, ANGLE translates WebGL2 shaders to HLSL and hands them to FXC, and Dawn does the same for WebGPU — and FXC's optimizer choked on our deepest integer-flavor shaders (a random composition tree inlines the twoSum body ~30 times), taking long enough to trip the OS's GPU watchdog. The same shaders verify clean in isolation — `PIPELINE OK`, `LINK OK` — and Metal compiles and runs all of them without complaint. It is a per-compiler compile-cost ceiling, not a correctness problem.

Which settles the deployment policy, and it is pleasingly asymmetric:

- **Apple/Metal**: integer flavor. The float flavor is _wrong_ there; slower-but-correct wins by forfeit.
- **Everything else**: float flavor. It is correct on the real chains (D3D11's folding bites only adversarial synthetic trees), and it compiles fast.

The library exposes the decision as data — a `recommendFp64Flavor(signals)` that reads whatever the caller has (a WebGPU adapter's vendor, a WebGL renderer string, a user agent) and returns the flavor that device _needs_ — and the conformance probe now prints its own verdict, so every device report that reaches us states which lowering it should be running.

## What generalizes

The previous post's conclusion stands: if you can remove the large magnitude before the GPU multiplies, do that — it is faster than any emulation. What this episode adds is the fallback for when you are the library and the magnitude is not yours to remove: **the only barrier a float-rewriting optimizer respects is a change of domain.** Not a stronger guard, not a fused instruction — fusion protects an operation, and the optimizer attacks the expression — but arithmetic it has no license to touch. And the price of that move is smaller than it looks, _if_ your library routes everything through a few error-free primitives: swap the leaves, keep the tree, and let a bit-exact CPU oracle prove the rounding before a single shader compiles.

## References

1. Andrew Thall, ["Extended-Precision Floating-Point Numbers for GPU Computation"](https://andrewthall.org/papers/df64_qf128.pdf) — the split `twoProd`, and §D's Two-Product-FMA (Algorithm 5) we tested and Apple folded anyway.
2. [philipturner/metal-float64](https://github.com/philipturner/metal-float64) — full integer IEEE FP64 emulation on Metal; the domain-change principle at maximum strength.
3. WebGPU, [Issue #2076 — disable fast-math per shader](https://github.com/gpuweb/gpuweb/issues/2076) — why no qualifier saves you: the rewrite license is platform default, the remedy still unshipped.
4. Earlier in this series: [add held, mul collapsed](/blog/2026-07-09-add-held-mul-collapsed) and [The multiply you cannot guard](/blog/2026-07-09-the-multiply-you-cannot-guard).
