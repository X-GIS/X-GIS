---
title: 'The split constant was never the bug'
description: 'GPU double-single splits floats with 8193; the textbook says 4097. I was sure 8193 was cargo-culted from a wider type — until two million float32 products came back error-free for both. The split constant that breaks is one too small; the real bug was never the split.'
date: 2026-07-08T23:15:00Z
tags: ['floating-point', 'precision', 'gpu', 'verification']
lang: en
---

There are two magic numbers in the wild for the same job, and I was sure one of
them was a bug.

To multiply two floats and recover the part that doesn't fit — the error term
that makes emulated double precision work — you split each operand into a high
and low half using [Dekker's method](https://doi.org/10.1007/BF01397083) [1].
The split is a single multiply by a constant. The GPU lineage of this code —
NVIDIA's CUDA Mandelbrot sample, and the GLSL ports that descend from it — uses
`8193.0`:

```c
// CUDA samples, Mandelbrot_kernel.cuh — dsmul (double-single multiply)
float cona = a0 * 8193.0f;
float sa1  = cona - (cona - a0);   // high half
float sa2  = a0 - sa1;             // low half
```

The textbook constant for IEEE single precision is `4097.0`. So is the one in
Simon Green's double-single routine on the NVIDIA developer forums, attributed
to Norbert Juffa — NVIDIA's own floating-point architect:

```c
up = x * 4097.0f; u1 = (x - up) + up;
```

Same vendor, same operation, two different constants. They can't both be the
intended value, and `8193 = 2^13 + 1` has the fingerprint of a cargo-cult. Which
brings me to the wrong first move.

## The wrong first move

Here is the reasoning I was completely satisfied by, right up until I tested it.

Dekker's split point should fall at the middle of the significand. The
error-free rule, the one in every EFT reference [2][3], is a constant of
$2^{\lceil p/2 \rceil} + 1$ for a $p$-bit significand. IEEE single has 24 bits,
so the constant is $2^{12} + 1 = 4097$, splitting the significand into two
12-bit halves. Meanwhile $8193 = 2^{13} + 1$ is the constant for
$\lceil p/2 \rceil = 13$ — a **26-bit** significand. There is no 26-bit IEEE
float. `8193` is the split constant for a type wider than the one the code runs
on, carried unexamined from an ancestor and pasted onto `float`. Our own
emulated-double multiply uses `4097`, and I was ready to write the sentence
explaining why the GPU folklore had been wrong for fifteen years.

It has every ingredient of a satisfying gotcha: a suspicious power-of-two
constant, a plausible story about a copy-paste lineage, and a tidy derivation
that fingers the exact value. The only thing missing was a check.

## What actually happened

The check is cheap, because the oracle is free. Two `float`s multiplied together
have a product with at most 48 significand bits, which fits exactly in a
`double`. So for any float32 `a`, `b`, the exact product is just `a * b` computed
in float64 — and a split constant is error-free if and only if the two-float
result `hi + lo` reconstructs it with no residue. Two million random pairs,
across a wide range of exponents, per constant:

```js
const f = Math.fround // round to float32
const split = (a, C) => {
  const t = f(C * a),
    hi = f(t - f(t - a))
  return [hi, f(a - hi)]
}
const twoProd = (a, b, C) => {
  const p = f(a * b),
    [ah, al] = split(a, C),
    [bh, bl] = split(b, C)
  const e = f(f(f(f(f(ah * bh) - p) + f(ah * bl)) + f(al * bh)) + f(al * bl))
  return [p, e] // claims a*b === p + e exactly
}
// error-free ⟺ p + e (in float64) equals the exact float64 product a*b
```

| constant |            | high / low split      | error-free? (of 2,000,000) |
| -------- | ---------- | --------------------- | -------------------------- |
| `2049`   | $2^{11}+1$ | 13-bit hi / 10-bit lo | **806,169 failures**       |
| `4097`   | $2^{12}+1$ | 12-bit hi / 11-bit lo | 0 failures                 |
| `8193`   | $2^{13}+1$ | 11-bit hi / 12-bit lo | 0 failures                 |
| `16385`  | $2^{14}+1$ | 10-bit hi / 13-bit lo | **277,889 failures**       |

`8193` is error-free. My whole derivation, the one that "proved" it was a bug,
was wrong — and the row that gives it away is `2049`. A constant _smaller_ than
the textbook value is the one that shatters, and it fails 40% of the time.

The reason is the half I wasn't looking at. Dekker's product forms four partial
products of the split halves, and it's exact only when **each half fits in
$\lceil p/2 \rceil = 12$ bits**, so that every partial product fits in 24. The
constant $2^s+1$ puts roughly $p-s$ bits in the high half and $s-1$ in the low.
I had fixated on the low half getting too big. But shrinking the constant grows
the _high_ half: `2049` ($s=11$) makes it 13 bits, so `hi·hi` needs 26 bits and
rounds. The safe window is exactly $s \in \{12, 13\}$ — that is, `4097` **and**
`8193`, the two constants I'd been told to choose between. `4097` sits in the
middle of the window; `8193` sits at its upper edge; both are inside. Push one
step past either edge — `2049` below, `16385` above — and the product stops
being error-free. The folklore had correctly sensed that the constant matters. It
just named the wrong direction as dangerous, and the wrong value as the villain.

## Where the bug actually was

If the split constant is a red herring, where does GPU double-single actually
lose precision? Two places, neither of them the constant.

The first is renormalization. On the same forum thread, Sylvain Collange notes
that a widely-used GPU float-float multiply "seems to neglect the lowest-order
bits, and to skip a few normalization steps, which probably causes the advertised
larger error" [5]. That is a real precision loss, and it lives in the _steps
around_ the split, not the split's constant. A correct constant in an algorithm
that drops a renormalization is still lossy — and it will pass exactly the
random-product test above for the multiply in isolation, because the loss is in
how results are combined, not in `twoProd` itself.

The second is the one that actually cost this project days, and the constant is
irrelevant to it: the compiler and the hardware. An optimizer permitted to
reassociate floating-point arithmetic can algebraically cancel the entire error
term to zero — the split is perfect and the result it feeds is deleted anyway.
And a GPU whose `float` multiply isn't correctly rounded corrupts the partial
products no matter which legal constant you split with. Those two — chronicled in
[the flickering Mandelbrot](/blog/2026-07-07-the-flickering-mandelbrot) and
[an opaque guard defeats the compiler, not the hardware](/blog/2026-07-08-an-opaque-guard-cannot-fix-a-lossy-multiplier)
— are where the precision went. The split constant, the thing that _looked_ like
the bug, was never within a mile of it.

## What generalizes

We did keep `4097` over `8193` — but for the honest reasons (it centers the
split, and leaves a little more headroom before `C·a` overflows for large
operands), not because `8193` is broken. That distinction is the whole point. A
magic constant that disagrees with the textbook is an invitation to test, not a
bug to fix on sight; and the test is usually cheaper than the argument you'd
have instead — here, a free exact oracle and a `for` loop settled in seconds what
a plausible derivation got backwards. When you do run it, probe both directions,
because received wisdom about _which_ way a number is dangerous is exactly the
part no one re-derives. The constant you can safely copy is not evidence the
algorithm around it is correct — and the thing that looks like the bug, precisely
because it looks like one, is worth clearing before you go and find the real one.

## References

1. T. J. Dekker, ["A Floating-Point Technique for Extending the Available
   Precision,"](https://doi.org/10.1007/BF01397083) _Numerische Mathematik_ 18
   (1971), 224–242 — the split and the two-product.
2. T. Ogita, S. M. Rump, S. Oishi, ["Accurate Sum and Dot
   Product,"](https://www.tuhh.de/ti3/paper/rump/OgRuOi05.pdf) _SIAM J. Sci.
   Comput._ 26(6) (2005) — `TwoProduct`/`Split` and the $2^{\lceil p/2\rceil}+1$
   factor.
3. J. R. Shewchuk, ["Adaptive Precision Floating-Point Arithmetic and Fast Robust
   Geometric Predicates,"](https://people.eecs.berkeley.edu/~jrs/papers/robust-predicates.pdf)
   _Discrete & Comput. Geom._ 18 (1997) — `Split` produces a $(p-\lceil
   p/2\rceil)$-bit high part and a $(\lceil p/2\rceil-1)$-bit low part.
4. NVIDIA, [CUDA Samples — Mandelbrot](https://github.com/NVIDIA/cuda-samples)
   (`dsmul`, split `8193.0f`, "based on DSFUN90"); the same constant appears in
   the [GLSL translation](https://blog.cyclemap.link/2011-06-09-glsl-part2-emu/),
   also crediting DSFUN90.
5. NVIDIA Developer Forums, ["Emulated double precision double-single routine
   header"](https://forums.developer.nvidia.com/t/emulated-double-precision-double-single-routine-header/4686)
   — a `4097.0f` split attributed to N. Juffa, and S. Collange on skipped
   renormalization as the source of a multiply's error.
6. The type this split serves: [Emulated double precision in the shader
   DSL](/blog/2026-07-07-emulated-double-precision-shader-dsl).
