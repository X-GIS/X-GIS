# Shaders as typed data: the X-GIS shader DSL

> Edition: **dev**. Exhaustive version: [`../agent/03-shader-dsl.md`](../agent/03-shader-dsl.md).

X-GIS ships no hand-written WGSL or GLSL — a ratchet test forbids shader string literals
across the renderer and engine packages. Every shader is authored as a **typed node graph
in TypeScript**, and from that one graph the build emits WGSL, GLSL ES 3.00, a
double-precision CPU implementation, and a reflection object describing every binding and
byte offset. This chapter is why that's worth the trouble, and how the pieces fit.

## The moment that justified it

Before the DSL became the single source, per-projection thresholds lived as literals
inside WGSL strings, nominally mirrored by a table. The team's discriminating experiment:
mutate one culling literal inside the shader string and run the entire test suite.
**Everything stayed green.** Nothing pinned the emitted bytes to anything. That's the
authority-inversion smell — the "table" was pinned to the code instead of the code deriving
from the table — and it's what the DSL migration fixed: today a gate literally parses the
thresholds back *out of the emitted WGSL* and asserts they equal the table.

## Authoring: phantom types and method chains

TypeScript can't overload `+`, so arithmetic is chained (`a.add(b).mul(c)`), TSL-style.
The type system does the heavy lifting through a **phantom string key**:

```ts
class ReadonlyNode<K extends string> { readonly __k?: K; constructor(readonly expr: Expr) {} }
class Node<K> extends ReadonlyNode<K> { assign(v: ArithArg<K>): void { … } }
```

`K` is `'f32' | 'vec3<f32>' | 'mat4x4<f32>' | 'f64' | …`. Three consequences: `vec2 + vec3`
or `f32 ∘ i32` is a *compile error* (WGSL and GLSL have no implicit conversions, so the
type error is exactly the shader compile error you'd have gotten later, minus the GPU);
immutability is type-only (`Let` returns `ReadonlyNode`, so assigning to it doesn't
check — one runtime class, zero cost); and builtins are domain-bounded (`sin(bool)` won't
type). Literals lift contextually — `flags.bitAnd(1)` emits `1u` — and structs, uniforms
and resources are declared once through helpers that return typed proxy views, killing the
"layout declared in four places" drift by construction.

The IR underneath is deliberately boring: two closed discriminated unions (15 expression
ops, 13 statements), plain data, **every node carrying its type from construction** so
backends never re-infer. The distinctions encode legality-for-passes: a pipeline-override
constant is a different node kind than a foldable constant, so a future constant folder
*can't* make the illegal move.

## One walk, two backends, and a CPU twin

The tree-walk over the IR is written once. A backend contributes leaf spellings only —
type names, literals, an intrinsic registry mapping *neutral ids* to per-target spellings
(`select()` vs ternary; texture sampling with the sampler fused away on GL; array-texture
sampling as its own id because GLSL restructures the arguments). The genuinely divergent
stuff is handled as lowerings: GLSL has no storage buffers, so an `array<f32>` binding
becomes a 2D data texture and `data[i]` becomes a `texelFetch` at `(i%w, i/w)`; compute
shaders lower to fragment-shader GPGPU for gather-only kernels and *fail closed* on
anything else.

Then there's the third backend: the same IR evaluated on the **CPU in f64**. It validates
every optimizer pass (output must be bit-identical before and after), and it *is* the
production CPU math — tile selection and label anchors call a generated f64 lowering of
the projection graph, replacing a hand-maintained mirror that used to drift. Its header
contains the sentence every reference implementation should be forced to write: *"A
CPU↔CPU pass here is NOT evidence of GPU precision parity"* — it's an algebra oracle,
structurally blind to f32 loss, and its GPU stubs throw unless you opt in, because
"plausible-wrong is the worst failure mode for a reference backend."

The optimizer is a fixpoint pass list (const/copy prop, folding, dead branches, CSE, GVN,
LICM, DCE) run identically for both targets, with a tiered switch: O1 is bit-exact value
movers only; O2 adds passes that change *which float ops execute* — which is why O2 sits
behind a real-GPU differential gate rather than being assumed safe. One hard-won
measurement rule came out of this machinery: the emitter CSEs everything into `let`
chains, so **any tooling that regexes emitted text is blind** — patterns like
`vec2(x,y).x` are spelled `_cse7.y` two statements apart. Thirteen of fifteen
optimization-opportunity probes once measured "0 sites" that way; the IR said 37 (2,420
after inlining). Count on the IR; validate the instrument against a known positive before
believing any zero.

## Reflection: nobody hand-computes a byte offset

Emission and reflection come from the *same* lowered module, so the string and its
metadata cannot disagree. The reflection carries bind groups (with per-entry stage
visibility derived from the same reachability walk the GLSL per-stage emit uses), std140
and std430 layouts, the vertex attribute layout, overrides, and required features. On the
consumer side, the WebGPU backend maps reflection to pipeline descriptors mechanically,
and a typed uniform-block writer turns layouts into per-field pack functions "so a
struct's byte offsets never get hand-copied into a renderer again" — the motivating bug
was exactly a hand-copied `@20` that was really `@24`. Where the two targets genuinely
disagree (mat2 under std140), the layout engine **throws** instead of silently picking a
side.

## Baking, variants, and identity

Emission is milliseconds-expensive (the polygon vertex stage alone ~80 ms), so shaders
that every page needs are **baked** at build time into content-addressed stores, gated by
hash equality against a live emit (emission is measured byte-deterministic, which is what
makes equality rather than tolerance the right gate), completeness in both directions, and
a metadata leg that fails *by name* if the bake ran under different constants. The bake is
deliberately not part of the build that gates it — that would be green by construction.

Variants follow a decision table worth adopting wholesale: different program *shape* →
build-time function parameter (there is no preprocessor; the losing arm is never built,
and a disabled feature's binding isn't even declared, so it can't cost a slot); different
*value* → pipeline override constant; a *host-owned runtime axis* → a typed variant family
whose cache key is derived from the axes; *injecting style expressions* → placeholder
statements composed at the IR level, erroring on unswapped or misspelled tags (both were
once silent in the direction that matters). The cross-cutting law: **whatever you
specialize on becomes part of the shader's identity** — cache keys and baked ids included.
Omit an axis and one variant's compiled shader serves another's draw: "it compiles, it
links, it renders, and it is wrong."

## The gates, and what each one cannot see

- A **compile gate** feeds every emitted variant to a real WGSL compiler — unit tests
  byte-diff strings but never compile them, and a rejected string otherwise ships green
  and dies on a user's GPU.
- An **obfuscation gate** compiles *and links* the minified/mangled GLSL (linking is the
  point — it proves the mangle is deterministic across the two separately-emitted
  stages), then draws three modules plain-vs-transformed and requires **zero** differing
  bytes — plus a non-flatness check, after an all-ones test input once made a gradient
  legitimately flat and the assertion vacuous.
- The gate suite also records its own blind spots in comments: a pixel arm *cannot* detect
  the inlining-vs-opacity bug (the opaque guard value travels with the inlined bodies, so
  frames still match); that invariant is pinned structurally instead, with a note saying
  "do not re-add a pixel arm for it." Writing down what a gate can't see is half the value
  of the gate.

## What to steal

1. Author shaders as typed IR; emit text only at the edge. You get multi-target, an
   optimizer, reflection, and — most underrated — the ability to *measure on the IR*.
2. Phantom-key types + method chaining ≈ the target language's own type rules, at compile
   time, for free.
3. A CPU f64 twin generated from the same IR pays for itself three times — but write its
   blindness statement in its header and make its stubs throw.
4. Reflection from the same lowering as the string; typed uniform writers; throw on
   layout rules the targets disagree about.
5. Bake with hash-equality + completeness + meta gates; never let the build regenerate
   what it's gated against.
6. Variant identity is derived from specialization axes, never hand-assembled.
7. For every gate, record what it cannot see, next to it.
