---
title: 'The low word a load throws away'
description: 'The same df64 value—1e8+0.5—minus 1e8. Computed on the GPU it reads 0.5; loaded from a uniform it reads 0.0, with the fast-math guard bound in both. To a reassociating compiler a loaded low word and a computed one are not the same number, and the fix is to launder one into the other.'
date: 2026-07-09T12:00:00Z
tags: ['precision', 'gpu-drivers', 'numerical', 'compilers']
lang: en
series: { name: 'Emulating f64 in shaders', order: 5 }
draft: false
---

Two probes, same arithmetic, opposite answers:

```ts
// (1e8 + 0.5) − 1e8, target 0.5, guard bound in both cases
mk('dg_sub_cp', () => toF32(toF64(B()).add(toF64(S())).sub(toF64(B()))), 0.5) // computed → PASS
mk('dg_sub_ld', () => toF32(U.field.val.x.sub(toF64(B()))), 0.5) // loaded  → FAIL
```

`val` is a uniform packed with the same double, `1e8 + 0.5`, split into its `(hi, lo)` pair exactly the way the on-GPU `add` builds it. Same value, same subtraction, same anti-fast-math guard threaded through both. On the reporter's iPhone, `dg_sub_cp` read `0.5` and `dg_sub_ld` read `0.0`. The only thing that differed between them was **where the low word came from**: one was computed on the GPU by a `twoSum`, the other arrived over the uniform bus.

At a coordinate near $10^8$, `f32`'s spacing is 8 metres — the `0.5` _is_ the sub-integer detail df64 exists to keep. A subtraction that drops it is the whole system failing silently. And it failed on exactly the input that a uniform-fed shader actually uses.

## The wrong first move

This surfaced from the other direction first. A reviewer reported that scalar `div` collapsed to zero on an **NVIDIA RTX 5060 Ti (Blackwell)** under WebGL2 — 45 of 58 probes passing, `div` reading a flat `−0.0000` where the golden was `0.5`. Blackwell's _WebGPU_ path (Dawn → D3D12) was a clean 58/58. Same silicon, one API perfect and the other broken.

My first hypothesis was the lossy-multiply class from [Part 4](/blog/2026-07-08-an-opaque-guard-cannot-fix-a-lossy-multiplier): `df64_div` runs a Newton correction that multiplies, a multiply is where a non-correctly-rounded ALU bites, and "it's fine on WebGPU but not WebGL2" reads like a hardware-path story. It was tempting because Part 4 had just taught me that some df64 failures live in the ALU where no value you thread into the shader can reach them — so I pattern-matched this onto the unreachable class and half-expected to need a per-vendor `df64_div` variant.

That was wrong. The fix that landed was pure _compiler_-class medicine — I renormalized the division's raw operands and nothing else — and `div` recovered on Blackwell WebGL2. If the multiplier had been lossy, re-touching the operands could not have helped. The multiply was never the problem. The problem was that ANGLE's D3D compiler (`fxc`), like Metal, drops a loaded low word before the cancellation — the identical trigger behind `dg_sub_ld`.

## What actually happened

The guard from [Part 3](/blog/2026-07-07-the-flickering-mandelbrot) threads an opaque `1.0` through the error-free transform's intermediates so the compiler can't fold `e = b − (s − a)` to zero. `dg_sub_ld` had that guard bound and still collapsed. So the guard, which lives _inside_ the `twoSum`, does not cover whatever happens to a freshly-loaded pair on its way _into_ the `twoSum`.

The `_cp`/`_ld` split isolates it to one variable. `dg_sub_cp` builds `1e8 + 0.5` on the GPU: the low word is the output of a guarded `twoSum`, an SSA temporary the compiler produced itself. `dg_sub_ld` reads the same pair from a uniform: the low word is a load. Feed each into the same cancelling subtract; only the load collapses.

I did not disassemble the driver's output, so I can't show you the reassociation it performed — what the probe _proves_ is the correlation and its cure. The mechanism I infer is that the uniform load is an optimization boundary the compiler is willing to reason across: seeing a `(hi, lo)` pair whose components arrive together and immediately enter `hi + (−b)`, a reassociating backend treats `lo` as discardable. A low word it _computed_ one instruction earlier, it keeps.

That inference makes a prediction: re-deriving the low word on the GPU, right before the cancellation, should restore it — regardless of the value, because the value doesn't change.

## The fix: launder a loaded low word into a computed one

The medicine is an addition of zero:

```ts
// shader-dsl/src/core/passes/fp64-lower.ts
const renormForCancel = (ctx, x) =>
  isHelperOutput(x) ? x : callHelper(ctx, 'df64_add', vec2fT, [x, RENORM_ZERO])
```

`RENORM_ZERO` is `vec2<f32>(0.0, 0.0)`. In real arithmetic `df64_add(x, 0)` is the identity — exact for any normalized pair, so the answer never moves. On the GPU it is not free: `df64_add` runs a `twoSum`, which _re-computes_ `x`'s two words as fresh temporaries. A loaded low word goes in; a computed one comes out. Same number, different provenance — and provenance is the thing the compiler was keying on.

Two properties make it a legal fix and not a new hazard:

- **Idempotent.** `df64_add(x, 0) == x` for a normalized pair, so the CPU oracle, the metamorphic gate, and every render on a correctly-rounded GPU are byte-unchanged. It only _does_ something on a machine that was already wrong.
- **Opaque.** It is a `df64_` call, not the binary expression `x + 0`. Written as `+ 0` our own optimizer would fold it away before the driver ever saw it — the same "it's algebraically nothing, delete it" reflex we're defending against, one layer up. The call is a wall on both sides.

Emitted, the guard on a distance subtraction looks like this — the raw lane `vec2<f32>(_v6.hi.x, _v6.lo.x)` sliced out of a loaded vector, now wrapped:

```diff
- let _lc2 = df64_sub(vec2<f32>(_v6.hi.x, _v6.lo.x), _cse3);
+ let _lc2 = df64_sub(df64_add(vec2<f32>(_v6.hi.x, _v6.lo.x), _cse9), _cse3);
```

## One trigger, many doorways

Here is the part that cost the most time. Fixing scalar `sub` and `div` did **not** fix `loran` — a probe that computes a hyperbolic position from the _difference of two nearly-equal distances_, the textbook catastrophic cancellation. It still failed on Blackwell WebGL2, reading `0.2469` against a `0.1087` golden.

`loran`'s core operation is a subtraction. I had just renormed subtraction. Why was it still broken?

Because "subtraction" is not one site in the compiler that lowers the language. A scalar `a - b` written by the author goes through the binary-operator path, where the renorm now lives. But `distance(p, q)` expands to $\sqrt{\sum (p_i - q_i)^2}$, and those per-lane subtractions are _synthesized_ — emitted directly by the `distance` lowering, in a different branch of the code, over lanes sliced out of a loaded vector. The renorm guarded the doorway the author walks through and left the one the compiler generates wide open.

That reframed the task from "fix loran" to "find every place a cancelling df64 op is _created_." An audit of the lowering pass turned up the same shape in six more:

| Doorway                   | The cancellation inside       |
| ------------------------- | ----------------------------- |
| `distance()` per-lane sub | $p_i - q_i$ over loaded lanes |
| scalar `fract`            | `sub(a, floor(a))`            |
| scalar `mix`              | `sub(b, a)`                   |
| vector `sub` / `div`      | over a loaded `DF64VecN`      |
| vector `fract` / `mix`    | per-lane `sub`                |
| vector `normalize`        | per-lane `div`                |

Every one takes a raw operand — a load, or a lane of a loaded vector — into a subtract or a divide, and none had the renorm. `abs`, `floor`, `min`, `max` don't cancel, so they were correctly left alone; `sqrt` cancels internally but passes on real hardware, so it stayed untouched too. The renorm is one small function; the work was proving _where_ it had to be called, which is a graph question about the lowering pass, not a math question about df64.

## How we know it holds

The oracle is a JS `number` — an IEEE double, correctly rounded — and so is the CI GPU (SwiftShader). Neither can _exhibit_ this bug; both agree the renorm changes nothing, which is exactly the metamorphic gate we want (authored ≈ lowered, 591 tests green) and exactly why they are blind to the failure itself. As in Part 4, the only witness that matters is a real driver.

So the probe carries **discriminative** assertions: every df64 test is constructed so that plain `f32` _provably_ fails it — `1e8 + 0.5` loses the `0.5`, `1e6 + 0.5` loses it too. A test a collapsed df64 could still pass proves nothing. The audit added three the old suite was missing: the previous vector-subtract probe used `vBig = 1e8`, which is `f32`-exact — its low word is `0`, so there was _nothing to drop_ and the probe was green by vacuity. The replacements use `(1e6 + 0.5, 0)`, whose lane carries a real `0.5` to lose.

The honest edge: `mix` and `normalize` got the renorm for structural completeness, but they also route through the multiply, so this probe can't isolate them from the separate lossy-multiply class. They are argued correct by identical mechanism, not independently witnessed. The final gate is on-device, because an earlier, _blanket_ version of this same laundering — applied to every operand indiscriminately — once _regressed_ a driver that the targeted version leaves alone, and had to be reverted. A transform that is invariant in mathematics is not automatically invariant to a fast-math backend, whose behaviour is sensitive to the code _pattern_, not just the value. That is the whole reason the guard is validated per device and not trusted from the algebra.

## What generalizes

To a compiler licensed to reassociate, two bit-identical extended-precision values are not interchangeable. The one it computed a moment ago, it trusts; the one you loaded, it feels free to simplify — and "simplify" for a `(hi, lo)` pair headed into a cancellation means throwing the `lo` away. The error-free transform's guard rides _inside_ the arithmetic and never sees the load, so the defense has to sit at the boundary: run a real, opaque operation on the value first, converting its low word from _loaded_ to _computed_ before the cancellation can reach it. It is the strangest kind of fix — an addition of zero that must not be optimized to nothing — and it only works because it changes the one thing the compiler cared about, which was never the value.

## References

1. WebGPU issue [gpuweb#2076](https://github.com/gpuweb/gpuweb/issues/2076) — an emulated-double subtraction that agrees across D3D12/Vulkan but is eight orders of magnitude off on a fast-math backend.
2. Andrew Thall, ["Extended-Precision Floating-Point Numbers for GPU Computation"](https://www.andrewthall.org/papers/df64_qf128.pdf) — the `twoSum` / `twoProd` error-free transforms whose low words this post is about.
3. [The flickering Mandelbrot](/blog/2026-07-07-the-flickering-mandelbrot) — Part 3, the texel-fetch guard against compile-time folding.
4. [An opaque guard defeats the compiler, not the hardware](/blog/2026-07-08-an-opaque-guard-cannot-fix-a-lossy-multiplier) — Part 4, the second failure class in the ALU.
