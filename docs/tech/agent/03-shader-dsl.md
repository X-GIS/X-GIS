# 03 — The shader DSL: one typed node graph → WGSL + GLSL + a CPU oracle + reflection

> Edition: **agent**. Companion: [`../dev/03-shader-dsl.md`](../dev/03-shader-dsl.md).
> Package: `shader-dsl/` (core under `src/core/`). Rationale ADR:
> `docs/adr/0003-shader-dsl-single-emit.md`.

## 1. Why this exists (ADR-0003)

Two coupled decisions: (1) every shader the engine runs is **emitted** from one TypeScript
DSL, sharing one projection graph across all render surfaces; (2) the projections table is
the single authority everything per-projType derives from. The prior state was an
**authority inversion** — a "table" pinned to scattered WGSL string literals. The
discriminating evidence: before the flip, mutating a single cull literal inside a WGSL
string left the entire test suite green; nothing pinned emitted bytes to anything.
Acknowledged cost: contributors author shaders against a builder API, not raw WGSL — and a
ratchet (`raw-shader-string-ratchet.test.ts`) forbids hand-authored WGSL/GLSL template
literals everywhere in map+engine.

## 2. Authoring surface

The type model is a **phantom string key**, not a nominal type hierarchy:

```ts
class ReadonlyNode<K extends string = string> {
  readonly __k?: K            // phantom; optional + never assigned → covariant
  constructor(readonly expr: Expr) {}
}
class Node<K> extends ReadonlyNode<K> { assign(v: ArithArg<K>): void { … } }
```

`K` ranges over template-literal keys (`'f32'`, `'vec3<f32>'`, `'mat4x4<f32>'`, `'f64'`,
`'texture_2d<f32>'`…), inferred from `as const satisfies ShaderType` type constants. The
Let/Var read/write split is **type-only** (one runtime class): `Let`, fn params,
const refs all return `ReadonlyNode`, so `someLet.assign(…)` is a tsc error, mirroring
RxJS's Observable/Subject.

JS cannot overload operators, so arithmetic is method chaining (TSL-style): `.add .sub .mul
.div .neg .lt .eq .and .bitAnd .shl`, swizzle getters (`.xy`, `.rgb`), `x += v` spelled
`x.assign(x.add(v))` deliberately. Three type-safety layers all pushed to tsc:

1. `ArithArg<K>`: a binary operand must be the same vector key or a scalar of the vector's
   element kind — WGSL/GLSL have no implicit scalar conversions, so `vec2 + vec3` or
   `f32 ∘ i32` would emit code neither target compiles; it's a compile error instead.
2. `this:`-bounds remove broadcast overloads from vector receivers so error messages stay
   readable.
3. Builtin key domains (`FloatKey`, `Float64Key`, `IntKey`): `sin(someBool)` doesn't check;
   `sin/cos` accept f64 because the lowering whitelists them.

Plus contextual literal lifting (`flags.bitAnd(1)` emits `1u`; a number added to an f64
lifts to f64 preserving the full JS double), a runtime `binResultType` law for what types
can't express (bool arithmetic → diagnostic; non-finite literals rejected — neither target
can spell Infinity), and a **cross-instance brand** (`Symbol.for`) instead of `instanceof`
so a dual-loaded copy of the package still recognizes foreign nodes.

Control flow is ambient: `Let, Var, If(…).elif(…).else(…), Loop, Switch, Return, Discard`
resolve the current builder from a stack; a plain JS closure that calls DSL functions is a
**code generator** (loops/branches in JS unroll into IR). Structs/uniforms/resources are
declared once via SoT declarators (`ioStruct`, `uniformStruct`, `storageBuffer`,
`resource`, `builtin(name)` bounded to a closed WGSL builtin-name union so a typo is a tsc
error). The declarator returns a Proxy view where `o.uv` is a typed member expression —
the fix for "a layout declared in four places that had to agree by hand."

## 3. IR: plain data, fully typed at construction

Two closed discriminated unions, no classes, no methods: `Expr` (15 variants: lit,
constref, overrideref, externref, param, varref, binop, unop, compare, logical, call,
member, construct, select, index, matchExpr) and `Stmt` (13). Invariants:

- **Every variant carries its own `type: ShaderType`** — backends never re-infer while
  emitting.
- Exhaustive `switch (e.op)` is tsc-checked at every backend.
- No identity semantics → subtrees are structurally shared freely (what makes CSE/GVN cheap).
- Distinctions exist where a future pass could otherwise do something illegal:
  `overrideref` ≠ `constref` (a const may be folded; an override's value is fixed at
  _pipeline creation_ — opacity by construction); `externref` ≠ `varref` (mangling renames
  varrefs; externs must survive and reflect as host requirements); `logical` ≠ `binop`
  (short-circuit); `raw` is two union members so a payload-less raw is unrepresentable and
  each backend fails closed on the missing side.
- `'f64'` is deliberately **not** a scalar kind: it lowers to `vec2<f32>`, and giving it its
  own kind forces every `t.kind` switch to decide about it — verification by construction.
  A multisampled integer texture is likewise unrepresentable rather than a runtime throw.
- `ConstDecl` carries a **dual-precision pair**: `wgslValue` (the truncated literal the GPU
  gets) and `cpuValue` (`Math.PI`) — the structural form of the two-tolerance reality.
- Struct fields carry both the WGSL attr _spelling_ and structured `location/builtin/
interpolate` _semantics_; backends read the structured fields, never re-parse the string.
- `fn()` returns a handle that is simultaneously the FuncDecl and a typed callable; the
  typed object-param call form checks names/types/completeness (the positional form is
  deprecated precisely because a lon/lat swap compiles). Calls stamp a `declRef` so
  `module()` auto-collects transitively called functions.

## 4. Emission: one walk, two backends

The tree-walk over Expr/Stmt is written **exactly once** (`emit.ts`); a backend supplies
only leaf spellings: type names, literals, intrinsic spellings, let/var syntax, switch/case
syntax, float-mod, module sections. Shared pre-emit pipeline for every target:

```
validate → assertCaps → assertBuiltins
→ autoVars → matchLower → fp64Lower → spellExterns
→ optimize (same fixpoint pass list on BOTH backends)
→ assemble (overrides, consts, structs, bindings, funcs)
```

Key divergences handled at the leaves: `select()` vs ternary; `textureSample(t,s,uv)` vs
`texture(t,uv)` (sampler fused); array-texture sampling is a **distinct neutral intrinsic
id** because GLSL restructures the arguments (`vec3(uv, layer)`) — "a spelling that
switches on args.length makes the id's meaning depend on the call site, which is exactly
the WGSL leak the registry exists to prevent"; uniform blocks emit `std140` GLSL with
offsets computed by the **same layout engine** the host packs against; storage buffers
don't exist in GLSL ES 3.00, so a GLSL-local pre-pass rewrites `array<f32>` bindings into
2D-tiled data textures and `data[i]` into `texelFetch(t, ivec2(i%w, i/w), 0).r`; compute
shaders lower to fragment-shader GPGPU on GLSL (gather-only kernels; fails closed on
scatter); builtin vocabulary maps per stage and direction (with the documented
`gl_FragCoord` bottom-left vs WGSL top-left trap). The intrinsic registry inverts
ownership: the IR carries neutral ids; each backend maps id → spelling ("previously the id
WAS the WGSL string and the GLSL writer had to UN-rename it — a WGSL leak at the core").

A worked micro-lesson in why helpers beat inline text templates: a storage-fetch spelled as
a text template duplicated its width computation _after_ every optimizer pass had run
(text doesn't exist until the writer produces it) — `textureSize(t,0).x` appeared 998
times in the baked corpus; binding the width once inside an emitted helper cut raw bytes
8.1 %.

### CSE and the let chain

`cse` hoists the **maximal** repeated input-only subexpression into a `let` at the
**shallowest block dominating every use** — not fn-top: fn-top hoisting of a 5-way method
dispatch made every fragment execute all five methods' math (deleting the dispatch cut the
hillshade fragment ~52 %). A `for` body is never a placement block (that would re-evaluate
per iteration; LICM owns loop motion). The emitted "let chain" is also why **any probe that
regexes emitted text is blind**: `vec2(x,y).x` is spelled `_cseN.y` two statements apart.
The paid-for rule (§12 of CLAUDE.md): 13 of 15 optimizer-opportunity counts measured "0
sites" by text regex; re-measured on the IR, one pattern alone had 37 sites (2,420 after
full inlining) — _count on the IR, never the text; validate the instrument against a known
positive before believing a zero._

Pass tiers: `O0 = []`; `O1` = bit-exact value movers (constProp, copyProp, deadBranch, cse,
cseLocal, gvn, dce); `O2` adds constFold + algebraic + licm — passes that can change
_which_ float ops execute, which is why O2 sits behind a real-GPU f32 differential gate.
Measured effect of the full pipeline on production modules: 208 of 6,008 IR ops removed.

## 5. The CPU oracle (the most transferable idea)

Two CPU backends over the SAME IR, bit-identical by construction:

- a tree-walk interpreter evaluating the identical op tree in JS f64 (no `fround`),
- a `new Function` codegen twin that inlines the same scalar ops and calls the same
  runtime helpers (exists because the interpreter was ~40 % of frame time in production
  CPU-projection use; falls back per-fn on `raw`, per-module on CSP).

Uses: (1) **pass correctness** — every optimizer pass must leave oracle output identical;
the projection module runs a bit-equality loop over every projection function; (2)
**production CPU math** — the generated f64 lowering of the projection graph replaced a
hand-maintained mirror, so tile selection and label anchors _are_ the shader math; (3) the
executed-WGSL parity gate diffs a real GPU compute pass against this lowering.

Its header carries the honesty clause every reference backend should copy: _"this is an f64
ALGEBRA oracle, NOT an f32-precision oracle … structurally BLIND to the codebase's worst
bug class … A CPU↔CPU pass here is therefore NOT evidence of GPU precision parity."_ GPU
stubs (`textureSample`, `fwidth`) **throw unless explicitly opted in** — "plausible-wrong
is the worst failure mode for a reference backend." One deliberate f32 concession: `==`
compares after `fround` on f32-typed operands (the GPU computes f32; exact f64 equality
silently disagrees on equality branches).

## 6. Reflection: the host never hand-computes a byte offset

`emitModuleWithReflection` derives the shader string **and** a `Reflection` from the _same_
lowered module: bind groups (with per-entry `stages` derived from the same reachability
walk the per-stage GLSL emit uses — "a host's stage mask can never describe a narrower
program than the emit produces"), std140 uniform layouts, std430 storage layouts, vertex
attribute layout from the `@vertex` entry's params, entry IO, overrides, required features,
and host-provided extern requirements. Consumers:

- `rhi-webgpu/src/reflection-to-webgpu.ts` — a pure, device-free mapper from Reflection to
  WebGPU descriptors; visibility masks are **derived**, not authored.
- `engine/src/render/uniform-block.ts` — turns field layouts into typed pack/write
  functions "so a struct's byte offsets never get hand-copied into a renderer again."
  (The motivating bug: a hand-derived `viewport @20` vs the real `@24`.)

Paid-for GLSL traps recorded in the reflection layer: a GLSL host must bind a uniform
block by **struct name**, not instance name — getting it wrong doesn't fail to link, it
silently lands on binding point 0 and aliases; and `group` has no GLSL counterpart, so the
backend folds it as `group·8 + binding` for UBOs but raw binding for sampler units — the
two namespaces are _not_ folded the same way. `mat2` under std140 **throws** rather than
silently picking between WGSL's column stride 8 and GLSL's 16.

## 7. Baking

Runtime emit is too slow for first paint (polygon vertex emit alone ~80 ms; a retained
family 58-184 ms), so unconditionally-needed shaders are **baked**: a closed key registry
("the closed set is a property of the CALL SITES, not the emitters"), six committed
generated files — content-addressed stores `{index: id→hash, contents: hash→source}` per
(language × boot-group) — and variant-carrying emits stay runtime **by construction**.
Verification is three gates with distinct failure meanings: (a) **hash equality** — baked
bytes === a live emit right now (emission is byte-deterministic across processes, measured
six independent runs bit-identical — that's what makes equality, not tolerance, the right
gate); (b) **completeness** — index keys equal registry ids in both directions; (c)
**meta** — baked constants equal live ConstDecls (a bake under a different planet fails
by _name_, not just by hash). The bake is deliberately **not** part of `bun run build`: CI
runs build before tests, and a bake wired into the build would regenerate the artifact it
is about to be gated against — "green by construction, proving nothing."

Consumption discipline: the id→source store distinguishes three fall-through outcomes —
CLOSED (moved under the bake, expected), ABSENT (family not installed, expected), MISS
(family installed but id absent — **a bug every time**, silent, invisible to every other
gate because a miss just runs the emit thunk and renders correctly, only slower). The
loader merges (two maps with different backends can share a page) and never throws (a 404
costs a slower first draw, not a dead map). Architecture Gate 9 keeps the 24 DSL emitters
out of the runtime bundle by allowing exactly one value-importer of the registry.

## 8. Variants: four mechanisms for four questions

The authoring guide's decision table, worth adopting verbatim:

1. **The program's SHAPE differs → build-time specialization.** "This DSL has no
   preprocessor, and does not need one" — a module is a JS value returned by a function, so
   the varying thing is a function parameter and a plain `if` decides what enters the IR;
   the losing arm is never built. A disabled feature's binding **is not declared**, so it's
   absent from reflection and the host never allocates the resource (the classic `#ifdef`
   failure — a "disabled" feature still costing a binding slot — is unrepresentable).
2. **A VALUE differs, shape doesn't → `override`** (WGSL pipeline constants / GLSL
   `#define` after `#version`). Rule of thumb: same instruction sequence with one literal
   changed = override; different code = build parameter.
3. **The HOST owns the axis at runtime → `variantFamily`**: a typed axes → module builder
   with a derived key; `emit()` returns a map of per-variant sources (the only WGSL shape),
   and a GLSL-only `emitGuarded()` _generates_ a `#if` ladder whose arms are asserted
   byte-identical to the standalone emits — "a lowering of a typed matrix, not hand-written
   text — which is what makes it checkable."
4. **Injecting expressions into seams → placeholder composition.** A base module lays down
   `placeholder('fill-return')` statements; `composeModule(base, swaps)` replaces them,
   erroring on an un-swapped placeholder _and_ on a typo'd swap key — both were previously
   silent in the direction that matters (an un-swapped placeholder emits a comment and
   renders wrong with no error).

The cross-cutting rule: **whatever you specialize on becomes part of the shader's
identity** — the pipeline cache key, and the baked id. An id that omits an axis hands one
variant's compiled shader to another variant's draw: "it compiles, it links, it renders,
and it is wrong — the failure has no error, only wrong pixels." `variantFamily` derives the
key from the axes so it _cannot_ omit one.

## 9. Verification gates (what each proves)

- **`_wgsl-compile-gate`**: every emitted variant (~20 surfaces) is accepted by a real WGSL
  compiler (Tint) via `createShaderModule` + `getCompilationInfo`. Closes the gap where
  unit tests byte-diff strings but never compile them — a rejected string ships CI-green
  and dies on a user's GPU as "nothing renders for layer X." Runs on SwiftShader because
  _compilation needs no raster_. Anti-vacuity: variant count > 10, non-trivial lengths,
  missing adapter = failure not skip.
- **`_emit-obfuscate-gate`**: three claims — minified/mangled WGSL compiles (Tint); GLSL
  compiles _and links_ (linking proves the mangle is deterministic across the two separate
  per-stage emits — varyings must agree by name); and a **pixel-identity arm** draws three
  modules plain vs `[inline, mangle, minify]` and requires `diff === 0` over all bytes plus
  a non-flatness check (a varied UBO pattern — an all-1.0 fill once made a gradient
  legitimately flat and the assertion vacuous). Recorded negative result: a pixel gate
  **cannot** see the #1926 opacity defect (flattening the EFT library still draws
  identical frames because the opaque ONE travels with the bodies) — that invariant is
  pinned structurally (emitted fn count) instead. "Do not re-add a pixel arm for it."
- **`_shader-math-parity`**: executes the real emitted WGSL in a compute pass against the
  generated CPU-f64 lowering (grid over 7 projections), GPU-class-aware tolerances
  (see [`02-coordinates-precision.md`](./02-coordinates-precision.md) §7).
- **Byte-drift snapshots**: 8 polygon-variant fixtures, byte-equal (deliberately not
  AST-equivalent — semantic equivalence is covered end-to-end by pixel gates; the snapshot
  pins per-commit emit stability), each with a recorded ancestor SHA.
- **Threshold-drift gate**: parses cull/rim literals back _out of the emitted WGSL_ and
  asserts they equal the projections-table rows — the direct fix for the "mutate a literal,
  suite stays green" incident.
- Emit goldens (39 committed WGSL+GLSL pairs), semantic-diff corpus, minify safety, per-
  variant compile+link with the GL context and WGSL validator as structural parameters (so
  the package stays browser-free and a test can drive aggregation with a recorder).

## 10. Transferable design rules

1. **Author shaders as a typed IR in the host language; emit text only at the edge.** You
   get: multi-backend from one source, an optimizer, reflection, lintability, and the
   ability to _count on the IR_ instead of regexing text.
2. **Phantom-key types + method chaining** give near-full shader type safety with zero
   runtime cost; make read-only-ness a type-level property of one runtime class.
3. **Fully type the IR at construction; keep it plain data** with closed unions — every
   pass and backend gets exhaustiveness checking for free, and structural sharing makes
   CSE cheap.
4. **Write the control-flow walk once**; backends supply leaf spellings through an
   intrinsic registry of neutral ids (never let one target's spelling become the id).
5. **Reflection must come from the same lowering as the emitted string**, and hosts must
   consume it (typed uniform writers, derived bind layouts, derived visibility). Every
   hand-copied offset is a future drift bug.
6. **A CPU reference backend pays for itself three times** (pass validation, production CPU
   math, GPU parity) — but write its blindness statement in its header, make missing GPU
   stubs throw, and never let a CPU↔CPU pass masquerade as GPU evidence.
7. **Bake unconditional shaders at build time behind hash-equality + completeness + meta
   gates**; never wire the bake into the build that gates it; make cache misses of
   installed families a distinguishable outcome (they are bugs that render correctly).
8. **Variant identity = specialization axes, derived not hand-assembled**; placeholders
   must fail closed in both directions.
9. **Verification is layered**: compile gate (cheap, CI) → link gate (cross-stage
   determinism) → pixel identity (semantics) → byte snapshots (stability) → literal
   re-parse (authority coupling) — and record what each gate _cannot_ see next to it.

## 11. Code map

- Authoring/IR: `shader-dsl/src/core/ir/{node,nodes,types,builder}.ts`, `sot.ts`
- Emit: `core/emit.ts`, `core/backends/{wgsl,glsl}.ts`, `core/intrinsics.ts`
- Passes: `core/passes/` (`opt/` optimizer family, `fp64-lower.ts`, `match-lower.ts`,
  `compose.ts`, `force-inline.ts`, `mangle.ts`, `variant-family.ts` at core root,
  `lint/rules/` — 25 rules)
- Oracle: `core/oracle.ts`, `core/cpu-codegen.ts`, `core/cpu-runtime.ts`
- Reflection: `core/reflect.ts`; consumers `rhi-webgpu/src/reflection-to-webgpu.ts`,
  `engine/src/render/uniform-block.ts`
- Baking: `map/src/shaders/baked/{bake,registry,store,install}.ts`,
  `baked-sync.test.ts`
- Gates: `playground/e2e/_wgsl-compile-gate.spec.ts`, `_emit-obfuscate-gate.spec.ts`,
  `_shader-math-parity.spec.ts`, `map/src/shaders/dsl/polygon-variant-diff.test.ts`
- Consumer graphs: `map/src/shaders/dsl/*.ts` (polygon, line, point, raster, text, icon,
  heatmap, hillshade, atmosphere, flow, arrows, coverage…)
