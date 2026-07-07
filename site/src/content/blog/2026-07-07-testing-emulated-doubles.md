---
title: 'Testing emulated doubles'
description: "The verification stack behind shader-dsl's fp64: a correctly-rounding f32 machine built from Math.fround, a metamorphic oracle gate, byte goldens, and discriminative real-GPU known answers."
date: 2026-07-07T06:58:00Z
tags: ['shader-dsl', 'testing', 'precision', 'numerics']
lang: en
---

The [fp64 feature](/blog/2026-07-07-emulated-double-precision-shader-dsl)
poses an awkward testing problem. The thing under test is f32 arithmetic
arranged to behave like f64 — but CI has no GPU, JavaScript has no native
f32, and the algorithms fail in ways a "run it once, looks right" check
cannot catch. The gates below layer so that each catches a failure class the
others cannot.

## Layer 1: a correctly-rounding f32 machine

The df64 kernels (twoSum, twoProd, …) only work if every intermediate rounds
to f32 _exactly once_. JS numbers are IEEE doubles, but
$\mathrm{fround}(x \circ y)$ — round-to-f32 after a double-precision op — is
bit-exact f32 arithmetic for `+ − × ÷` and `sqrt`.

So the test harness takes the **actual lowered IR** (the same modules the
GPU receives), wraps every f32-typed operation in a synthetic `__fround`
call, and evaluates it on the CPU oracle:

```ts
const froundWrap = (e: Expr): Expr =>
  (e.op === 'binop' || e.op === 'unop' || e.op === 'call') && isF32ish(e.type)
    ? { op: 'call', type: e.type, fn: '__fround', args: [e] }
    : e
const cpu = compileModule(mapModuleExprs(fp64Lower(m), froundWrap))
cpu.fns['__fround'] = (x) => Math.fround(x)
```

No hand-written mirror of the formulas exists — a mirror would drift from
the shader and start testing itself. The known-answer vectors are chosen so
plain f32 _provably_ fails them:

| Case                          | exact             | plain f32      |
| ----------------------------- | ----------------- | -------------- |
| $(2^{20} + 2^{-20}) - 2^{20}$ | $2^{-20}$         | $0$            |
| $(10^8 + 0.5) - 10^8$         | $0.5$             | $0$            |
| $\pi \times e$                | full double       | 24-bit product |
| lo-word tie-break in `min`    | picks by $x_{lo}$ | cannot order   |

Each test asserts both halves: the df64 result lands within tolerance, _and_
the f32 twin misses by orders of magnitude more. A test that a broken
implementation could also pass proves nothing.

## Layer 2: the metamorphic gate

The CPU oracle evaluates _authored_ f64 natively — a JS number **is** an
IEEE double, so the authored module is its own specification. Lowering is
meant to preserve semantics, giving one property over arbitrary inputs:

$$
\mathrm{oracle}(\texttt{fp64Lower}(m)) \approx \mathrm{oracle}(m)
$$

This holds to $2^{-40}$ relative because in exact-enough arithmetic the EFT
error terms are genuinely near zero. One property, every rewrite rule in the
pass covered — no per-rule expectations to maintain.

## Layer 3: byte goldens and optimizer invariants

The guard threading (`* one` through every error term) is a _textual_
property of the emitted shader, so it is pinned as text: WGSL and GLSL
goldens are byte-compared per commit, and a re-bake is a reviewed diff. Two
invariants are asserted on the optimized output directly: `df64_*` helpers
are never inlined, and the guard reference survives the O2 fixpoint in every
EFT-bearing helper body. A module using no f64 must come out of the pass as
the same object — existing goldens changed by zero bytes when the feature
landed.

## Layer 4: discriminative real-GPU known answers

Everything above runs the IR under _our_ semantics. The failure mode fp64
exists to survive — a downstream shader compiler folding the EFTs — is only
visible on a real compiler stack. A Playwright gate executes the emitted
shaders on both backends:

- **WGSL**: a WebGPU compute pass writes each case's hi/lo pair to a storage
  buffer (runs under SwiftShader in CI).
- **GLSL ES 3.00**: a WebGL2 fragment pass renders one pass/fail pixel per
  case (exercises ANGLE), plus one pixel that runs the whole-plane vec64
  arithmetic and componentwise builtins.

The assertions reuse layer 1's discriminative structure: the result must
beat the plain-f32 twin by ≥8×, so a fast-math collapse turns the gate red
rather than passing vacuously.

## What each layer caught

The stack is not hypothetical: layer 1 caught tolerance mistakes in the
kernels' expected values, layer 2 caught lowering-shape bugs during the
vector milestone, layer 3 pinned the guard when the optimizer grew new
passes, and layer 4 is the only reason the
[driver-specialization incident](/blog/2026-07-07-the-flickering-mandelbrot)
could be fixed with confidence — when the guard's representation changed
from a uniform to a texel fetch, the intrinsic kept a CPU spelling of
exactly `1`, and every layer re-ran unchanged over the new lowered IR.
