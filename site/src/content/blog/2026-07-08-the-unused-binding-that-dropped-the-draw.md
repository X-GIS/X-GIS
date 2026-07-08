---
title: 'The unused binding that silently dropped the draw'
description: 'A shader drew correctly on one GPU and returned the clear colour on another — not precision, but layout:auto deleting a binding it declared but never read. When an interface is derived from usage, an unused declaration is a mismatch only the strict backend reveals.'
date: 2026-07-08T22:30:00Z
tags: ['webgpu', 'graphics', 'api-design', 'debugging']
lang: en
draft: false
---

Six comparison operators — `<`, `<=`, `>`, `>=`, `==`, `!=` — read back as
**exactly the clear colour** on a Windows/NVIDIA machine. Not a wrong number,
not a collapsed-to-zero number: the literal value the render pass was told to
clear to, byte for byte. The _same_ shader, through the _same_ WebGPU API,
rendered those six correctly in Safari on a Mac. Every other operator in the
suite — add, multiply, square root, length — passed on both.

That shape is a trap, because everything about the surrounding work pointed the
wrong way.

## The wrong first move

The shader in question emulates `f64` on GPUs that only have `f32`, and the
entire preceding week had been a march of _driver numerical bugs_: fast-math
reassociation folding away error-correction terms, multipliers that aren't
correctly rounded corrupting a split product. So when six operators failed on
one GPU and passed on another, the reflex — a well-trained one by then — was
"another driver precision bug: the comparison path must evaluate differently on
this hardware."

It fit the prior. It was also wrong, and one observation killed it: **a
precision bug produces a wrong number; these produced the clear colour.** A
lexicographic `hi/lo` comparison that miscompiled would return `0.0` where it
should return `0.5`, or some near-miss. It would not return the exact RGBA the
attachment's `loadOp: 'clear'` was configured with. The clear colour means the
fragment shader's output never reached the attachment at all. The draw didn't
run.

So the question was never "why is the comparison wrong on this GPU." It was
"why did the draw get dropped — and only for the operators that happen to carry
no error term."

## What actually happened

Those six operators are the only family in the set that never touches a
particular resource. The emulation defends its arithmetic against fast-math with
an opaque runtime value, fetched from a 1×1 texture bound as `_fp64`; the add
and multiply helpers thread that fetch through their error terms. The
comparisons don't have an error term to protect, so they never read the guard
texture. But the code that assembled each shader module declared the `_fp64`
binding _unconditionally_ — every `f64` module got it, whether its body read it
or not.

Declaring a binding a shader never reads sounds harmless. Under WebGPU's
`layout: 'auto'`, it is not. The relevant clause is that an automatically
generated pipeline layout contains only the resources the shader **statically
uses** [1]. A binding that is declared but never loaded is, to the layout
generator, not used — so it does not appear in the derived bind-group layout.
The host, meanwhile, was still handing that texture to the bind group:

```ts
const pipeline = device.createRenderPipeline({ layout: 'auto' /* … */ })

const entries = [{ binding: 0, resource: { buffer: ubuf } }]
if (guardBinding != null) entries.push({ binding: guardBinding, resource: guardView })

// layout derived from the shader; for a comparison-only module it has NO entry
// for `guardBinding`, because the shader never reads _fp64.
const bg = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries })
```

Now the two sides disagree. The host's bind group carries a texture at a binding
the derived layout does not contain. That is a validation error — and here is
the second half of the trap: **the strict implementation caught it, and still
failed silently.** A `createBindGroup` / `setBindGroup` validation error in
WebGPU surfaces on the device's error channel (an uncaptured-error event, or an
error scope you have to push). It does not throw where you're looking. The
render pass simply doesn't execute, and the attachment keeps its clear value. If
you aren't listening on `device.addEventListener('uncapturederror', …)`, the
only observable effect is a frame the colour of your `clearValue`.

And the platform split — the thing that screamed "driver bug" — turned out to be
a _specification-conformance_ split, not a numerical one:

| Backend                     | Unused `_fp64` binding            | Result                             |
| --------------------------- | --------------------------------- | ---------------------------------- |
| Dawn (Chrome, D3D12/NVIDIA) | stripped from the auto layout     | bind-group mismatch → clear colour |
| WebKit (Safari)             | kept in the layout                | binds fine → renders               |
| WebGL2 (GLSL)               | no such thing as a derived layout | renders                            |

WebGL has no auto-derived bind-group layout to prune against, so the whole
failure mode doesn't exist there. WebKit kept the declared-but-unused binding
(more lenient than the spec requires). Dawn pruned it (defensible, arguably
correct) — and routed the resulting error somewhere a casual run never checks.
The one backend strict enough to enforce the rule was also the one that enforced
it quietest.

## The fix

The binding should exist only when a shader that reaches the GPU actually reads
it. So: walk the helper closure that will be emitted, and inject the guard
binding only if some helper in it truly references the guard intrinsic.

```ts
const helpers = helperClosure(ctx.used)
- if (helpers.length > 0) injectGuard(bindings)
+ if (helpers.length > 0 && helpersUseGuard(helpers)) injectGuard(bindings)
```

`helpersUseGuard` is an ordinary expression/statement walk that returns true the
moment it sees the guard intrinsic in a helper body — `df64_add` and its EFT
primitives hit it; `df64_lt` and the other comparators never do. A
comparison-only module now emits no `_fp64` binding, the host adds no entry for
it, the auto layout and the bind group agree again, and the draw runs. Modules
that _do_ fetch the guard are byte-for-byte unchanged — the arithmetic emit
goldens didn't move.

## How we know it holds

Two regression tests pin the contract from the compiler side, so it can't
silently come back:

```ts
it('a comparison-ONLY module injects the comparator but NO guard binding', () => {
  const k = fn('k', { a: f64T, b: f64T }, (p) => p.a.lt(p.b).select(1.0, 0.0))
  const lowered = fp64Lower(module({ funcs: [k] }))
  expect(lowered.funcs.map((f) => f.name)).toContain('df64_lt') // comparator emitted
  expect(lowered.bindings).toEqual([]) // but no _fp64 binding
})

it('an arithmetic op alongside a comparison still injects the guard', () => {
  const k = fn('k', { a: f64T, b: f64T }, (p) => p.a.add(p.b).lt(p.b).select(1.0, 0.0))
  const lowered = fp64Lower(module({ funcs: [k] }))
  expect(lowered.bindings.some((b) => b.name === '_fp64')).toBe(true)
})
```

But a compiler test can't prove a driver stopped dropping the draw — that
required the hardware that exhibited it. On the desktop that first showed the
clear-colour failure (an NVIDIA RTX 2080, through Chrome/Dawn), the six
comparison operators went from returning `-2.0000` — the probe's decode of a
black, undrawn pixel — to their correct values, matching what Safari had shown
all along. The bug lived in a place no CPU reference and no software rasterizer
could reach: a conformance difference between two WebGPU implementations, on a
resource the shader didn't even use.

## What generalizes

Watch the two halves separately, because each is a habit worth keeping.

The diagnostic half: _the exact clear colour is not a value, it's the absence of
one._ When output equals the literal you initialized the buffer/attachment/field
to — not a plausible-wrong number near it — stop debugging the computation and
start asking why the computation never ran. A dropped write and a wrong write
have disjoint fixes, and they are easy to confuse when the surrounding bugs have
all been wrong writes.

The design half is the one you might have disagreed with before the clear
colour: **declaring something you don't use is free only when you write the
interface by hand.** The moment a tool _derives_ the interface from what your
code actually uses — WebGPU's `layout: 'auto'`, a bundler tree-shaking an unused
export out of a package's public surface, a codegen client that omits fields no
caller references, a linker's `--gc-sections` dropping a symbol another
translation unit expected — an unused declaration stops being inert. It becomes
a lie the tool will quietly correct on one side of a boundary while the other
side still believes it, and the disagreement waits for the strictest
implementation to turn it fatal. Prefer the interface that reflects real usage;
an extra declaration "just in case" is a mismatch you haven't triggered yet.

## References

1. W3C, ["WebGPU — Default pipeline layout"](https://www.w3.org/TR/webgpu/#default-pipeline-layout)
   — a pipeline created with `layout: 'auto'` derives each bind-group layout
   from the resources the shader statically uses; unused declared bindings are
   not part of it.
2. This engine's earlier fast-math incident, [The flickering Mandelbrot](/blog/2026-07-07-the-flickering-mandelbrot),
   and [An opaque guard defeats the compiler, not the hardware](/blog/2026-07-08-an-opaque-guard-cannot-fix-a-lossy-multiplier)
   — why the guard exists in the first place, and why it is a texture fetch. This
   post is the failure mode of injecting it too eagerly.
3. [What a software GPU can and cannot verify](/blog/2026-07-07-what-a-software-gpu-can-verify)
   — the companion boundary: some bugs, like this one, live only on real
   implementations and are invisible to the CPU reference that passes everything.
