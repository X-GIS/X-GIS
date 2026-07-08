---
title: 'An opaque guard defeats the compiler, not the hardware'
description: "After a texel-fetched guard fixed the fast-math collapse, isolated df64 ops passed on the reporter's phone but composed ones still broke. There are two failure classes, not one — and the second lives in the ALU, where no value you thread into the shader can reach it. df64 is per-vendor, and our CI's SwiftShader is structurally blind to half of it."
date: 2026-07-08T10:00:00Z
tags: ['shader-dsl', 'precision', 'gpu-drivers', 'numerical']
lang: en
series: { name: 'Emulating f64 in shaders', order: 4 }
---

Our df64 multiply splits each `f32` operand with the Dekker constant $4097 = 2^{12}+1$. In our shader it is never written as the literal `4097.0`:

```ts
// shader-dsl/src/core/fp64/df64-lib.ts — df64_split
const t = Let(p.a.mul(one.mul(4097.0)))   // 4097 * one, not 4097
```

`one` is a texel fetch from a 1×1 texture that reads exactly `1.0` — the anti-fast-math guard from [Part 3](/blog/2026-07-07-the-flickering-mandelbrot). The split constant rides it because `4097` is as much a constant-fold target as the error terms are: fold `4097 * one → 4097` and a compiler is free to reassociate the split's recovery steps into the identity, and the whole error-free transform evaporates. So far so good — that is a *compiler* problem, and an opaque value is the right hammer for it.

Then this happened. On the reporter's iPhone, the [per-op probe](/shader-dsl/fp64-probe) showed the isolated primitives — `add`, `sub`, `mul`, `sqrt` — all **passing**, guard bound. The composed examples on the same device still rendered at f32 precision. Every primitive green, the composition wrong. The guard was not the whole story.

## The wrong first move

We assumed the texel guard had made df64 *correct everywhere*, and that any remaining per-GPU handling was a performance concern — skip the guard where a driver doesn't need it, nothing more.

It was a comfortable assumption because everything we could run agreed with it. The guard demonstrably fixed the flicker in Part 3. Our CI GPU is SwiftShader; our CPU oracle is a JS `number` (an IEEE double). Both are **correctly-rounded IEEE-754 machines**. The full known-answer suite — every EFT, every lane — passes on both. When your oracle and your CI GPU are both exact, "it passes" tells you nothing about a machine that *isn't* exact.

The assumption was wrong, and the tell was in luma.gl's source: alongside the code-elimination guard we already had, it carries a *second*, unrelated workaround — `LUMA_FP64_HIGH_BITS_OVERFLOW_WORKAROUND` — enabled on Apple and Intel GPUs but not NVIDIA or AMD. If df64 were universally correct once the compiler was tamed, that switch would not exist.

## What actually happened: two failure classes, not one

They have different root causes and only one of them is a compiler problem.

**Class 1 — the compiler deletes the error term.** The residual $e = b - (s - a)$ is algebraically zero, so any implementation licensed to reassociate or fuse may prove it zero and drop it. WGSL §15.7.5 blesses this explicitly ("An implementation may reassociate operations… may fuse operations") and offers no per-operation `precise` qualifier; GLSL ES 3.00 (what WebGL2 speaks) gained `precise` only in ES 3.20, so it has none either. The canonical field report is [gpuweb#2076](https://github.com/gpuweb/gpuweb/issues/2076): an emulated-double subtraction that agrees CPU-to-GPU on D3D12 and Vulkan is *eight orders of magnitude off on Metal*, because Metal is the one backend that won't disable associative/distributive rewrites without disabling all of fast-math. **This class is fixable from inside the shader** — thread through an opaque runtime value the compiler can't fold. That is the guard. It is why our `twoProd` is split-based and never FMA-based (`df64-lib.ts:143`): a fused `a*b - p` collapses the residual to zero with no intermediate rounding to recover, so — following Thall — we pay for the longer split form on purpose.

**Class 2 — the hardware multiply is lossy.** The Veltkamp/Dekker `twoProd` assumes the machine's `f32` multiply is *correctly rounded* — result within ½ ulp. If it isn't, the four split partial products are already wrong before any compiler touches them, and the recovered error term is garbage. This is not hypothetical: Thall's *GPU Paranoia* measurements found pre-G80 NVIDIA parts used **truncated** multiply (error up to ~1 ulp, not ½), and only the GeForce 8800 reached correctly-rounded add/sub/mul. luma.gl's comment for the Intel branch is blunter — *"Intel GPU doesn't have full 32 bits precision in some cases, causes overflow"* — and its remedy is an extra re-split (`split2`) of the product before renormalizing. **Nothing you thread into the shader can fix this one.** An opaque `1.0` defeats the *compiler*; it does not make a lossy *multiplier* correctly rounded. Our `df64_mul` has no such re-split:

```ts
// shader-dsl/src/core/fp64/df64-lib.ts — df64_mul (no split2 renormalization)
const prod = Var(df64_twoProd({ a: p.a.x, b: p.b.x }))
prod.y.assign(prod.y.add(p.a.x.mul(p.b.y)))
prod.y.assign(prod.y.add(p.a.y.mul(p.b.x)))
return df64_quickTwoSum({ a: prod.x, b: prod.y })
```

SwiftShader and the CPU oracle are both correctly rounded, so they *cannot* exhibit Class 2. Our CI is structurally blind to it — not under-tested, blind by construction.

### An aside the source made me check: 4097, not 8193

The df64 shaders you find in the wild are split between two constants: `4097` and `8193 = 2^{13}+1`. Both are error-free at ordinary magnitudes — I confirmed a scan of random `f32` pairs gives 0-ulp `twoProd` for either, because each split half stays ≤ 12 bits so all four partial products fit exactly in 24. The difference is provenance and headroom. `8193` traces to Bailey's DSFUN90 Fortran ported into the CUDA SDK Mandelbrot sample's `dsmul` (`float cona = a0 * 8193.0f`) and copied onward into GLSL blogs with no justification given in any of them. `4097 = 2^{\lceil 24/2 \rceil}+1` is the canonical Veltkamp constant for a 24-bit significand — Thall and Norbert Juffa's validated routine both use it.

The one concrete difference: the split's first line `c = C·a` overflows to infinity when $|a| > \mathrm{FMAX}/C$. For `4097` that is $\approx 2^{116}$; for `8193`, one binade sooner. Our code comment (`df64-lib.ts:135`) flags it conservatively as `~2^115`. Either way it is astronomically outside a globe's range: ECEF coordinates at sub-millimetre scale stay under $2^{30}$. So the *magnitude*-overflow that the name "high bits overflow" suggests **cannot happen for us** — which means if we ever adopt the `split2` re-normalization, it will be for the lossy-*multiply* reason (Class 2), not for overflow. The workaround's name and its actual rationale point at different things; the source comment, not the macro name, is the one to trust.

## The design answer: per-vendor, but not a preprocessor

So per-vendor handling is real, not a speed knob. The question for a DSL that compiles one authored module to *both* WGSL and GLSL is *how* to express it without bolting a C preprocessor onto a typed IR.

Two separable axes, two mechanisms:

- **Class 1 stays a texel-fetch guard, always on, identical on every target.** Part 3's lesson bounds the alternatives: a *uniform* guard defeats ahead-of-time folding but loses to a driver that specializes a pipeline on the uniform's observed value — and the value is always `1.0`, so the specialized variant folds the cancellation right back. That is why even luma.gl's `ONE` and `SPLIT` *uniforms* are, in an iterative loop, weaker than a texel fetch. We keep the fetch.
- **Class 2 is a per-vendor code variant, selected at build/pipeline-creation time.** The honest form of luma.gl's `#ifdef` is a typed specialization constant, not a text macro: one IR node that lowers to a WGSL `override` and to a GLSL `#define` + `#if`. luma.gl's own selection mechanism is a device-string switch — WebGL `UNMASKED_RENDERER` / WebGPU adapter info → `apple|intel|nvidia|amd` → the set of defines. The variant axis lives in the type system; the vendor detection lives on the host; the shader output stays one clean string per target.

That is the shape. It is not built yet — and building it before we know *which* of the reporter's devices actually need the `split2` variant would be speculation.

## How we know — and what we don't

We can't reproduce Class 2 on the hardware we own in CI, so the proof has to move to the devices that show it. That is what the [probe](/shader-dsl/fp64-probe) is: every df64 op, on **both** backends, GPU readback compared to the `f64` oracle, each case built so plain f32 gives a visibly wrong answer. It is the verification oracle precisely because SwiftShader is not.

Being exact about the gap: we have **not** measured which vendors need the `split2` re-normalization on *our* kernels. luma.gl's Apple/Intel gating is strong prior evidence, and the reporter's "primitives pass, composition fails" is consistent with a Class-2 collapse under accumulation — but a collapse that only a lossy multiplier produces cannot be confirmed on a correctly-rounded one. The claim "our `df64_mul` needs `split2` on device X" is, until the probe runs on device X, a hypothesis with a named missing step, not a verdict. The instrument is built; the measurement is the next move.

What *did* land this cycle, on the verifiable side: `matNxN<f64>` — emulated-double matrices whose matmul, mat·vec and transpose compose the very same scalar EFTs, gated by the same known-answer and metamorphic tests as the scalar and vector layers.

## What generalizes

An opaque runtime value defeats the *compiler*; nothing you can write in the shader defeats a *lossy ALU*. Those are two different adversaries, and emulated precision has to answer both — a compiler defense that is identical on every target, and a hardware variant that is selected per vendor. Collapse them into one "make df64 robust" bucket and you will ship the first defense, watch your correctly-rounded CI go green, and conclude you are done.

That is the real trap, and it is not about df64 specifically: **a correctly-rounded oracle is blind, by construction, to every bug whose cause is incorrect rounding.** The closer your reference implementation is to the IEEE ideal, the less it can tell you about the hardware that isn't. When "it passes on SwiftShader" felt like proof, that was exactly when it proved the least.

## References

1. A. Thall, ["Extended-Precision Floating-Point Numbers for GPU Computation"](https://www.andrewthall.org/papers/df64_qf128.pdf) — the df64 representation, split-based `twoProd`, the FMA-`twoProd` failure, and the *GPU Paranoia* rounding table (pre-G80 truncated multiply).
2. T. J. Dekker, ["A floating-point technique for extending the available precision"](https://link.springer.com/article/10.1007/BF01397083), Numer. Math. 18 (1971) — the original FastTwoSum and Veltkamp-split TwoProduct, and the no-overflow precondition.
3. W3C, [WGSL — Reassociation and fusion (§15.7.5)](https://www.w3.org/TR/WGSL/#reassociation); gpuweb/gpuweb [#2076, "disable fast-math on a per-shader basis"](https://github.com/gpuweb/gpuweb/issues/2076) — the Metal "8 orders of magnitude" report.
4. luma.gl, [fp64 shader module](https://luma.gl/docs/api-reference/shadertools/shader-modules/fp64) and its `LUMA_FP64_CODE_ELIMINATION_WORKAROUND` / `LUMA_FP64_HIGH_BITS_OVERFLOW_WORKAROUND` (Apple/Intel-gated); deck.gl, [64-bit layers](https://deck.gl/docs/developer-guide/fp64) — "every now and then we encounter a new driver that needs special treatment."
5. NVIDIA CUDA SDK Mandelbrot `dsmul` (the `8193.0f` split); N. Juffa, [double-single routines](https://forums.developer.nvidia.com/t/emulated-double-precision-double-single-routine-header/4686) (the `4097.0f` split) — the constant's provenance.
6. D. McCurdy, [fp64-arithmetic](https://github.com/donmccurdy/fp64-arithmetic); visgl/luma.gl [#1764, "fp64… not working under Apple M1 Max"](https://github.com/visgl/luma.gl/issues/1764) — independent per-device field reports.

Earlier in this series: [Part 1 — Emulated double precision in the shader DSL](/blog/2026-07-07-emulated-double-precision-shader-dsl) · [Part 2 — Testing emulated doubles](/blog/2026-07-07-testing-emulated-doubles) · [Part 3 — The flickering Mandelbrot](/blog/2026-07-07-the-flickering-mandelbrot).
