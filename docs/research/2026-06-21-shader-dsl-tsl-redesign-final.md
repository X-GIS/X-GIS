# TSL-grade node shader DSL — final redesign spec (reconciled)

**Date:** 2026-06-21
**Status:** APPROVED for autonomous Ralph implementation (owner authorized full completion, TDD, DDD,
dynamic workflows, never-stop). Supersedes the framing of `2026-06-21-shader-dsl-spec-hardening-roadmap.md`
(that roadmap's wave order is reused; this doc is the authority).
**Inputs:** the 6-DSL comparative study + synthesis + adversarial critic (workflow `we8nykw7p`),
reconciled with owner directives below.

---

## Owner directives (binding)

1. **General-purpose, standalone DSL** — reused beyond X-GIS. Build to professional TSL/Slang-grade
   completeness; **cost is no object**. Do NOT scope-minimize to the map subset.
2. **WebGPU / WGSL backend FIRST + industry-best optimization.** The optimizer is a **PRIMARY goal**,
   not deferred. **WebGL2 / GLSL is a later fallback** — keep the IR + Backend contract target-NEUTRAL
   so it adds with no rework, but defer its implementation; it is a capability-gated *subset* target
   (storage-buffer / compute shaders stay WGSL-only).
3. **TDD always** — write the test first, confirm it fails for the right reason, implement minimal, verify.
4. **DDD** — model the DSL domain explicitly (bounded contexts below); ubiquitous language.
5. **Autonomous to completion** — Ralph drives, never stops mid-way, uses dynamic Workflows. Overrides the
   per-PR merge-approval cadence for THIS effort. `no npm publish until review` STILL holds.

## Verdict & reconciliation (critic ADOPT-WITH-CUTS × owner directives)

| Critic recommendation | Owner directive | Resolution |
|---|---|---|
| Cut hash-consing / CSE / optimizer ("driver does it") | Optimizer is PRIMARY (industry-best, WebGPU-first) | **KEEP the optimizer** — but as a separate, independently-tested **pass pipeline over the existing `Expr`-tree-as-graph**, NOT a rewrite of how authoring builds nodes. CSE/hash-consing is an opt-in optimization PASS, verified by byte-diff + the GPU differential — never a change to the `new Node(...)` authoring path. |
| Strike "graph closes #360/#392" overclaims | — | **Accepted.** The f32-precision class is closed ONLY by the #4 GPU differential. Auto-resource-wiring = binding-slot hygiene, not a precision fix. Every "architecture solves precision" claim is struck. |
| Sequence #4 (f32 GPU differential) BEFORE Phase-3 re-bakes; keep byte guard opt-in, don't retire | WebGPU-first + optimizer correctness | **Accepted + ELEVATED.** The real-GPU executed-WGSL-vs-f64 differential is the correctness backbone for both the optimizer and the precision class — it moves early. |
| #13 arithmetic-shift already done; only `==`/`!=` fround remains (roadmap was stale) | — | **Accepted** — verify on disk; the roadmap trusted a summary over the source (the recurring failure mode). |
| WebGL2 = capability-gated subset, not co-equal | WebGL2 later | **Accepted** — matches the deferral; #12's compile gate proves only the GLSL-expressible subset. |
| Keep the "AVOID" list, apply it to the proposal | General-purpose completeness | **Accepted** — even general-purpose, a JS-embedded WGSL/GLSL DSL does NOT need: trait-generics+monomorphizer, autodiff, SPIR-V/DXIL binary emission, a source lexer/parser, a Halide-style schedule sublanguage, or flat-CFG→restructure. Completeness = rich type lattice + validation + optimization + composition, NOT those. |

**Net architecture:** the existing `Expr`/`Stmt` typed AST **is** the graph. We add — under TDD —
(1) a **validation pass** (the keystone), (2) a **neutral seam** (IntrinsicId enum + capability wiring +
structured IO), (3) an **optimization pass pipeline** (the owner's headline; CSE/fold/DCE/tree-shake +
GPU-aware passes), (4) a **real-GPU f32 differential** (correctness backbone), and (5) **composition**
(Fn-inlining + auto-gensym, retiring `placeholder`/`raw`). We KEEP the Backend contract, the neutral
emit walk, and the f64 oracle (reframed as a third graph-walking backend).

---

## DDD — bounded contexts & ubiquitous language

- **IR / Graph** — `Node`, `Expr`, `Stmt`, `ShaderType`, `ModuleDecl`. The typed dependency graph. (Today: `ir/`.)
- **Validation** — `validate(module) → Diagnostics`; the semantic/type pass. Codegen cannot run on un-validated IR. (New: `passes/validate.ts`.)
- **Optimization** — `optimize(module, level) → module`; CSE, const-fold, DCE, tree-shake, varying-elision, GPU-aware passes. Correctness-preserving, proven by differential. (New: `passes/opt/`.)
- **Codegen / Backends** — `Backend` writers: `WGSLBuilder` (primary), `GLSLBuilder` (subset, deferred), and the **CPU f64 oracle as the third backend** (`generate` = evaluate). `IntrinsicId` is the neutral spelling key. (Today: `backends/`, `oracle.ts`, `emit.ts`.)
- **Composition** — `Fn()` reusable functions inlined into the graph; auto-gensym names; projection-spec injection. Retires string-splice. (Today: `configureProjections`; `builder.ts`.)
- **Resource / IO** — structured IO (`{builtin} | {location, interpolate?}`), binding allocation/dedup. (Today: WGSL attr strings — to be structured.)
- **Differential Verification** — byte-identity snapshot (opt-in tripwire) + the real-GPU f32 differential (the authority for precision + optimization correctness).

---

## Phase backbone (the Ralph spine; each phase = TDD, DDD-scoped)

**P0 — Validation spine** *(roadmap Wave 1; build-time, byte-neutral; partly already on disk from the
stopped W1 workflow — verify, don't redo)*. `validate(module)` (#2) wired at every emit/compile entry;
typed arithmetic lift (#6); delete invented int/float promotion (#5b → validator error); oracle `==`/`!=`
fround-compare (#13 remaining half — arithmetic-shift already done); honest doc caveats (#4d/#12d).
**Exit:** the 21 shaders all PASS validate; polygon snapshot byte-equal; fail-before tests for each rule.

**P1 — Neutral seam** *(roadmap Wave 2; byte-neutral)*. Structured `IntrinsicId` enum (#3a) — invert
ownership; WGSL spells byte-identically, oracle `BUILTINS` dispatches by id, GLSL maps from id. Wire
capabilities (#9): `requiredCaps(module)` → `caps.covers/missing` → `UnsupportedFeatureError`. **Exit:**
WGSL byte-identical; capability violations throw; oracle id-dispatch parity green.

**P2 — Optimization pipeline** *(ELEVATED per owner; WebGPU-first, industry-best)*. `optimize(module)`
pass pipeline over the graph: const-fold, DCE/tree-shake per entry point, common-subexpression elimination
(hash-cons as a pass), dead-varying elision, algebraic simplification, and GPU-aware passes (uniform
hoisting, branch/divergence-minimizing, vectorization where sound). Each pass: correctness-preserving,
**proven by the P3 differential + byte-diff**, with `.toVar()`/`.toConst()` author overrides. **Exit:**
each pass has a fail-before test (input→optimized output), the differential proves semantics-equality, and
emitted WGSL is measurably smaller/cheaper on the benchmark shaders with zero output-value change.

**P3 — Real-GPU f32 differential** *(ELEVATED before any snapshot re-bake)*. A headless WebGPU gate that
runs the *executed* WGSL and diffs against the f64 oracle under an f32 tolerance — the authority for both
the precision class (#4, closes the #392/#360 blindness honestly) and optimization correctness. **Exit:**
the gate runs in CI-capable form (real GPU locally), green on the current shaders; it is the precondition
for P4.

**P4 — Composition + structured IO + gensym** *(roadmap Wave 3; HIGH; gated behind P3)*. `Fn()`-inlining
(#8) replacing the polygon `placeholder`+`raw` composer; structured IO (#3b); auto-gensym (#10). These
**change emitted text**, so the byte-identity guard goes **opt-in / deliberately re-baked per-shader**,
each migration verified by the P3 differential on real GPU (NOT by eyeball — CLAUDE.md §5). Retire
`Stmt.raw`/`placeholder` (#3c). **Exit:** polygon emits via inlined Fn, differential-green, no raw/placeholder.

**P5 — Completeness & deferred** *(general-purpose; as-needed)*. Type-lattice expansion (#5a: f16/atomic/
ptr/storage-tex/non-square mat — for general-purpose use); branded typed nodes (#1, only if the validator
proves insufficient); **GLSL/WebGL2 subset backend + headless-WebGL2 compile gate (#12)** — the later
fallback, capability-gated subset; `readonly` cleanup (#11).

---

## Migration constraints (load-bearing)

- **Byte-identity guard** (`polygon-variant-diff`) stays a tripwire through P0–P2; in P4 it becomes opt-in /
  re-baked per-shader, never retired wholesale.
- **The P3 GPU differential precedes every snapshot re-bake** (P4) — the largest IR surgery must not run
  while the cheapest tripwire is thrown away and the real precision gate is absent.
- **Real-GPU verification is MANDATORY** for any render/precision claim (CLAUDE.md §5) — no eyeballing.
- **Sequential heavy jobs only** (tsc, vitest, GPU) — concurrent froze the machine before.
- **TDD per story; one shader migrated at a time in P4.**
