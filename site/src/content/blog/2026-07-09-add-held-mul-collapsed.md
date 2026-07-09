---
title: 'add held, mul collapsed, and the difference was one renormalize'
description: "The emulated-double add and multiply are the same algorithm family, but on an Apple GPU add read 0.5 and multiply read exactly 0. The bug was not in either — it was a renormalization step the textbook multiply omits and the battle-tested one keeps."
date: 2026-07-09T16:00:00Z
tags: ['precision', 'gpu-drivers', 'numerical', 'compilers']
lang: en
series: { name: 'Emulating f64 in shaders', order: 6 }
draft: false
---

On an iPhone, the per-op df64 probe drew a clean line. `add` read `0.5000`. `sub`, `neg`, `abs`, `fract`, every comparison — all `0.5000`, all PASS. `mul` read **exactly `0.0000`**. So did `vec_mul`, and `div` (whose Newton step multiplies). The emulated add and the emulated multiply are the same double-float algorithm family, built from the same `twoSum` / `twoProd` / `quickTwoSum` primitives, guarded by the same runtime-opaque texel. One held its low word; the other deleted it.

Two more facts framed it. First, the collapse was identical on WebGL2 and WebGPU — because Safari compiles *both* to Metal, so both inherit Metal's default fast-math. (On a Windows NVIDIA box the same probe splits: WebGPU via Dawn/D3D12 passes, WebGL2 via ANGLE/`fxc` fails — different compiler, different answer, same GPU.) Second, the multiply read `0.0`, not a small wrong number. `1e8 · 5e-9 = 0.5` is an exactly-representable f32 product; a merely lossy multiply lands near `0.5`. An exact `0` is a **deleted** term.

## The wrong first move

The deletion pointed at a distributive rewrite:

$$a\cdot b_{hi} + a\cdot b_{lo} \;\longrightarrow\; a\cdot(b_{hi} + b_{lo})$$

with $b_{hi}+b_{lo}$ rounding back to $b_{hi}$ in f32. Our whole df64 defense is a runtime-opaque `one` (a 1×1 texel that reads `1.0`, which no compiler will constant-fold) threaded through the error terms. So I threaded it through the multiply's cross terms:

```ts
// df64_mul cross terms, guarded (the WRONG fix)
prod.y = prod.y + (a.x * b.y) * one
prod.y = prod.y + (a.y * b.x) * one * one
```

It was tempting because the guard is *exactly* the tool that keeps `twoSum`'s cancellation alive, and `df64_twoSqr` (which `sqrt` uses) already guards its error terms this way — and `sqrt` passed. Same hammer, adjacent nail.

It failed twice over. `mul` still read `0`, and `mul_sq` — a probe that *had* been passing — flipped to a saturated `-2.0000`. Pass count went **34 → 33**. I had shipped a regression to fix a bug and moved the needle backwards. It reverted the same hour.

The reason is in the algebra I'd skipped. Guarding the cross term puts the `one` on the wrong side of the common factor:

$$a\cdot b_{hi} + (a\cdot b_{lo})\cdot 1 \;=\; a\cdot\big(b_{hi} + b_{lo}\cdot 1\big)$$

The compiler can *still* factor `a` out — the guard is inside the parenthesis it wanted to form, not blocking it. `one` defeats a *cancellation* (where the thing being deleted is the whole expression) but not a *distribution* (where the common factor sits outside every guard you can place on the operands).

## What actually happened: read the shipping code, not the paper

Our `df64_mul` is the textbook Bailey QD `dd_mul`: accumulate both cross terms, renormalize once at the end.

```ts
// ours — textbook QD
const prod = Var(df64_twoProd(a.x, b.x))
prod.y = prod.y + a.x * b.y
prod.y = prod.y + a.y * b.x
return df64_quickTwoSum(prod.x, prod.y)   // one renorm, at the end
```

luma.gl's `mul_fp64` — and donmccurdy's [`fp64-arithmetic`](https://github.com/donmccurdy/fp64-arithmetic), a repository that exists specifically to test df64 *on Apple GPUs* — do something the paper doesn't:

```glsl
// luma.gl / donmccurdy — renormalize after EACH cross term
vec2 prod = twoProd(a.x, b.x);
prod.y += a.x * b.y;
prod = quickTwoSum(prod.x, prod.y);   // ← an extra renorm the paper omits
prod.y += a.y * b.x;
prod = quickTwoSum(prod.x, prod.y);
```

The comment next to it: *"Apple optimizes away the calculation necessary for emulated fp64."* That intermediate `quickTwoSum` is not numerical hygiene — QD proves it unnecessary in exact arithmetic. It is an **anti-fast-math barrier**. It folds the first cross term into a fresh, renormalized, guarded `(hi, lo)` pair *before the second product is formed*, so there is never a single `a·b_hi + a·b_lo` sum sitting in the expression tree for the compiler to factor. You cannot distribute over a sum that was already collapsed to one number.

The clinching detail was one function over. Our `df64_add` was **already** written this way — `quickTwoSum` after each partial sum — because that is just how accurate df64 addition is written, in the paper *and* in luma.gl. It is identical to luma.gl's `sum_fp64` line for line. So the two helpers differed by exactly this: add renormalized between steps, mul did not. **Add held and mul collapsed, and the difference was one renormalize.**

## The fix

Match the shipping structure:

```ts
const prod = Var(df64_twoProd(a.x, b.x))
prod.y = prod.y + a.x * b.y
prod = df64_quickTwoSum(prod.x, prod.y)   // the barrier
prod.y = prod.y + a.y * b.x
return df64_quickTwoSum(prod.x, prod.y)
```

Then I did what I should have done before writing a line: diffed *every* df64 helper against luma.gl's, not just the one that failed.

- **add / sub** — already identical (renorm per step). This is why they passed.
- **div** — structurally identical; its only multiply is `df64_mul`, so it recovers for free once mul does.
- **sqrt** — structurally equivalent (a cosmetic `split(yn)` vs `vec2(yn, 0)`, both exact); it already passed, and it uses the *already-guarded* `twoSqr`.

`df64_mul` was the lone helper that had been transcribed from the paper instead of from a codebase that had already met a fast-math driver. One deviation, one bug.

## How we know it holds — and what's still open

The restructure is value-identical in exact arithmetic, so the whole gate stack is blind to it *by construction*: the CPU oracle (a JS double) and the CI GPU (SwiftShader) are correctly-rounded, the fround-mirror known-answer suite and the metamorphic gate (authored ≈ lowered) all stay green across 591 tests. That is the same blindness that let the textbook version ship in the first place — none of these machines can *delete* the term, so none of them can tell the two multiplies apart. Only a fast-math driver can, and that verdict is on-device; at the time of writing it is the pending final gate, and I am explicitly *not* claiming victory before the phone does. The last "obvious" multiply fix I shipped regressed the probe within the hour — the discipline that catches that is to let the device, not the algebra, close the loop.

One class stays open regardless: expression trees that collapse on *both* Apple and NVIDIA's WebGL2 path — a reassociation *across* a composed chain, where the compiler factors between operations no single guarded primitive spans. The per-op multiply is one renormalize from correct; the composition is a harder problem.

The transferable part has nothing to do with df64. A numerical routine copied from its paper is correct in the arithmetic the paper assumes — real numbers, or exact IEEE. The version in a library that has already shipped to Metal and D3D and ANGLE carries scars the paper never mentions: an extra renormalize here, an opaque multiply there, guards in load-bearing positions that look redundant until you meet the compiler that needs them. When your correctly-rounded oracle and your correctly-rounded CI both bless the textbook version, the shipping code's "unnecessary" line is the one to copy — it is the fossil of a bug you haven't hit yet.

## References

1. luma.gl, [`fp64-arithmetic-glsl`](https://github.com/visgl/luma.gl/blob/master/modules/shadertools/src/modules/math/fp64/fp64-arithmetic-glsl.ts) — `mul_fp64` renormalizes between cross terms; `sum_fp64` per partial sum.
2. Don McCurdy, [`fp64-arithmetic`](https://github.com/donmccurdy/fp64-arithmetic) — a minimal df64 harness built to reproduce the precision loss on Apple GPUs; source of the "Apple optimizes away the calculation" note.
3. WebGPU issue [gpuweb#2076](https://github.com/gpuweb/gpuweb/issues/2076) — a request to disable fast-math per shader; still open, which is why the defense lives in the shader's structure.
4. [The low word a load throws away](/blog/2026-07-09-the-low-word-a-load-throws-away) — Part 5, the loaded-vs-computed low word this multiply sits on top of.
5. [An opaque guard defeats the compiler, not the hardware](/blog/2026-07-08-an-opaque-guard-cannot-fix-a-lossy-multiplier) — Part 4, which first split df64 failures into compiler vs ALU classes.
