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
bit-exact f32 arithmetic for `+ − × ÷` and `sqrt`. That is not an accident of
testing luck: for binary32 operands, computing in binary64 and then rounding
to binary32 provably equals the single rounding, because binary64 carries
more than $2p + 2$ significand bits — Figueroa's classic _innocuous double
rounding_ result [1]. It is the same theorem that lets JS engines implement
`Math.fround`-typed code with native float32 instructions [2].

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
meant to preserve semantics, giving one metamorphic relation [3] over
arbitrary inputs:

$$
\mathrm{oracle}(\texttt{fp64Lower}(m)) \approx \mathrm{oracle}(m)
$$

In exact-enough arithmetic the EFT error terms are genuinely near zero, so the
pass reproduces the native-f64 oracle to roughly $2^{-45}$–$2^{-48}$ relative
(df64 keeps ~48 bits, dropping only the lo·lo cross terms); the gate itself
asserts a looser $2^{-40}$ so honest rounding never trips it. One property,
every rewrite rule in the pass covered — no per-rule expectations to maintain.

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

The assertions reuse layer 1's discriminative structure: the result must beat
the plain-f32 twin by ≥8×, so a fast-math collapse turns the gate red rather
than passing vacuously. The 8 is not a precision target — the CPU gate demands
$10^4\times$; the real-GPU threshold is deliberately loosened to leave
headroom for driver rounding on the collapsed path (and the total-cancellation
cases, where the f32 twin is exactly 0, are gated on the absolute tolerance
instead).

## What each layer caught

The stack is not hypothetical, and each layer is discriminative about a
different shape of failure:

- **Layer 1** pins exact answers with a paired f32-fails half:
  $(2^{20}+2^{-20})-2^{20}$ must land on $2^{-20}$ (a 41-bit tail plain f32
  flushes to $0$), the product $(1+2^{-30})^2$ must keep its $2^{-29}$ cross
  term (f32 keeps $1$). Because every case also asserts the f32 twin missing
  by orders of magnitude, a too-loose tolerance or a wrong expected value
  cannot slip through as a vacuous pass.
- **Layer 2** is where the vector milestone's lowering shapes get caught:
  `vecN<f64>` lowers to hi/lo _planes_ (`struct DF64VecN { hi, lo }`), and a
  swizzle or a `dot` that gathers the wrong plane or lane still type-checks.
  The metamorphic relation $\mathrm{oracle}(\texttt{fp64Lower}(m)) \approx
  \mathrm{oracle}(m)$ diverges the instant a lane is mis-indexed — no per-shape
  golden to hand-maintain.
- **Layer 3** asserts on the _optimized_ output that `df64_sqrt`/`df64_div`
  are still called (nothing inlined the EFT bodies) and that each of
  `df64_twoSum`/`quickTwoSum`/`split` still references `_fp64` after the O2
  fixpoint — so a new algebraic pass that folds `* one` away turns the
  assertion red instead of silently collapsing precision.
- **Layer 4** is the only reason the
  [driver-specialization incident](/blog/2026-07-07-the-flickering-mandelbrot)
  could be fixed with confidence — when the guard's representation changed
  from a uniform to a texel fetch, the intrinsic kept a CPU spelling of
  exactly `1`, and every layer re-ran unchanged over the new lowered IR.

## References

1. S. A. Figueroa, ["When is Double Rounding
   Innocuous?"](https://dl.acm.org/doi/10.1145/221332.221334) _ACM SIGNUM
   Newsletter_ 30(3) (1995), 21–26 — why binary64-then-binary32 rounding
   equals a single binary32 rounding for the basic operations.
2. Mozilla, ["Efficient float32 arithmetic in
   JavaScript"](https://blog.mozilla.org/javascript/2013/11/07/efficient-float32-arithmetic-in-javascript/)
   — the `Math.fround` design and the same double-rounding argument in
   engine practice.
3. T. Y. Chen, S. C. Cheung, S. M. Yiu, "Metamorphic Testing: A New Approach
   for Generating Next Test Cases," Technical Report HKUST-CS98-01 (1998) —
   testing without an output oracle via relations between runs.
4. W3C, [WebGPU Shading Language — Reassociation and
   fusion](https://www.w3.org/TR/WGSL/#reassociation) — the license the
   real-GPU layer exists to catch.
