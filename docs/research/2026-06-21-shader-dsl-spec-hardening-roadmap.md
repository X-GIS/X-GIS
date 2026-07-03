# shader-dsl spec-hardening roadmap

**Date:** 2026-06-21
**Status:** PLAN — execution held (planning track; the adversarial review of the DSL core)
**Source:** adversarial review of `shader-dsl/src/core/**` (ir/types·nodes·node·builder, schema,
oracle, backend, emit). 13 findings, sorted here by **severity × fix-cost → ROI**.

The review's verdict: the current spec is "the minimum IR needed to pass the polygon migration,"
not a foundation library. It is a typed AST→string with **no validation pass**, WGSL-coupled at
the core, and a type-safety story that mostly collapses to `Node<string>`. This roadmap turns
the fix into ordered waves.

---

## Severity × cost matrix

| #   | Finding                                                                                                        | Severity     | Fix cost          | Wave  |
| --- | -------------------------------------------------------------------------------------------------------------- | ------------ | ----------------- | ----- |
| 2   | No validation/semantic pass — emit is GIGO (`oracle.ts:144` throws; WGSL emits undeclared refs)                | **Critical** | Medium            | **1** |
| 6   | Integer-arith f32-lift footgun — `u32.add(1)`→`(x + 1.0)`, naga-invalid (`node.ts:30,72`)                      | High         | Low               | **1** |
| 5b  | Invented int/float promotion (`f32 op u32 → f32`, `node.ts:50-55`) — WGSL forbids; emits invalid               | High         | Low               | **1** |
| 13  | Oracle `==` exact-f64 + `>>` always logical (`oracle.ts:54,166`) — silent CPU↔GPU divergence                   | Medium       | Low               | **1** |
| 4d  | Oracle f64 ≠ GPU f32: structurally blind to the repo's worst bug class (#392/#360) — **document the asterisk** | High         | Low (doc)         | **1** |
| 12d | GLSL backend never compiled on a GPU — neutrality "proof" is vacuous — **document + flag**                     | High         | Low (doc)         | **1** |
| 9   | Capability model not wired into emit (`covers/missing` uncalled) — fail-closed is hollow (`backend.ts:16`)     | Medium       | Low-Med           | **2** |
| 3a  | Intrinsic id IS the WGSL string (`'bitcast<u32>'`, `'atan2'`, `node.ts:227`) — structured IntrinsicId          | High         | Medium            | **2** |
| 12  | Headless-WebGL2 compile gate for the GLSL backend — make neutrality non-vacuous                                | High         | Medium            | **2** |
| 1   | Phantom-K type safety collapses to `string` (swizzle/field/struct/array/callFn) — `node.ts:130`, `types.ts:46` | High         | High              | **3** |
| 3b  | IO stored as WGSL attr strings (`@builtin`, `@location`, `nodes.ts:89,111`) — structured IO model              | High         | Med-High          | **3** |
| 8   | Composition too weak → flagship polygon falls back to `placeholder`+`raw` string-splice (`nodes.ts:52-71`)     | High         | High              | **3** |
| 3c  | Retire `Stmt.raw` (WGSL-only escape hatch; blocks GLSL) — depends on #8                                        | High         | High              | **3** |
| 4   | Real f32 differential oracle / headless-GPU diff — depends on #12                                              | High         | High              | **4** |
| 5a  | Impoverished type lattice (no f16/atomic/ptr/storage-tex/non-square mat)                                       | Medium       | Med (incremental) | **4** |
| 7   | No optimizer (CSE/fold/DCE) — naga does it downstream anyway                                                   | Low-Med      | High              | **4** |
| 10  | Manual string var names, no hygiene/gensym (`builder.ts:21`) — **breaks byte-identity**                        | Low-Med      | Med               | **4** |
| 11  | `readonly` IR is fiction — builder casts `as unknown as Stmt` (`builder.ts:59`)                                | Low          | Low               | **4** |

---

## Wave 1 — the validation spine (high ROI, build-time, CI-able, NO GPU)

This wave is the keystone. **#2 alone retroactively makes the type-safety claim true** by turning
deferred-to-driver errors into build-time errors — it subsumes most of #1 without perfecting the
generics. All of Wave 1 is pure build-time / CPU; it touches no render path, so it can interleave
with the map-spec-100% campaign without competing.

- **#2 — a `validate(module)` pass** (new `core/passes/validate.ts`). One typed walk that checks:
  scope (every `varref`/`param`/`constref` resolves to a declaration in scope), type agreement on
  binop/compare/assign, `call`/`callFn` target exists + arity, `return` type matches `f.ret` on all
  paths, entry stages write the required builtins, `(group,binding)` uniqueness, struct field names.
  Emit calls `validate` first and throws a localized error (not a driver reject). This is the single
  highest-ROI item.
- **#6 — typed arithmetic lift.** Mirror `bitBin` (`node.ts:99`): in `.add/.sub/.mul/.div/.mod`, a
  bare number lifts to the LHS scalar type, not always f32. Kills `(u32 + 1.0)`.
- **#5b — delete the invented promotion.** `binResultType` (`node.ts:50`) must make mixed int/float
  a validator error (WGSL semantics), not silently return f32. Falls out of #2's type-check.
- **#13 — oracle faithfulness patches.** `==`/`!=` on f32 operands compare `Math.fround`-ed values;
  `>>` uses arithmetic shift when the static type is i32 (`oracle.ts:54,166`).
- **#4d + #12d — honesty in the spec docs.** State plainly that the oracle validates **f64 algebra,
  not f32 precision** (so it cannot catch the #392/#360 class), and that the GLSL backend is
  **string-shape-only, never GPU-validated**. These caveats are currently implied, not stated.

**Byte-identity:** #2/#5b/#13 do not change emit. #6 changes emit ONLY where code currently emits
invalid WGSL (not in any passing snapshot) — verify the polygon snapshot stays byte-equal.

## Wave 2 — neutrality made real (medium cost)

- **#9 — wire capabilities.** A `requiredCaps(module)` walk (storage binding ⇒ `storageBuffer`,
  `@compute` ⇒ `compute`, `texture_2d-ms` load ⇒ `msaaTextureLoad`); emit entry asserts
  `backend.caps.covers(required)` and throws `UnsupportedFeatureError` listing `missing()`. Makes
  fail-closed real instead of the GLSL backend's ad-hoc `glslType` throws.
- **#3a — structured `IntrinsicId`.** Replace the WGSL-string `call.fn` for builtins with an enum
  (`Atan2`, `BitcastU32`, `Pack4x8Unorm`, `TextureSample`, …); each backend maps id→spelling. The
  GLSL `GLSL_RENAME` table already proves the mapping exists — invert ownership so the canonical id
  is neutral, not WGSL. (User-defined `callFn` stays a name string.)
- **#12 — headless-WebGL2 compile gate.** Compile the GLSL backend's output with a real GL ES 3.00
  context (headless) and assert it links. Turns "second backend proves neutrality" from a vacuous
  string-shape assertion into an actual compile. Seeds the #4 differential.

## Wave 3 — structured IO + composition (high cost, the real IR) — behind the spec campaign

- **#3b — structured IO model.** Replace attr strings with `{ builtin } | { location, interpolate? }`
  on params/fields/returns; each backend renders its own syntax (WGSL `@location(0) @interpolate(flat)`
  vs GLSL `flat in` / layout qualifiers). Prereq for any non-WGSL backend doing real IO.
- **#8 — composition primitive.** Function inlining / module linking with name hygiene, so a shader
  can be assembled from reusable fragments without concatenating decl arrays. Retires the
  `placeholder` Stmt + string-splice composer.
- **#3c — retire `Stmt.raw`** once #8 gives a structured way to inject the former raw fragments.

## Wave 4 — depth / precision / optimizer (defer / as-needed)

- **#4 — real f32 differential** (headless GPU diff, or an f32-simulating oracle). Depends on #12.
  The only thing that actually closes the precision blindness.
- **#1 — perfect the phantom type system** — only if #2's build-time validation proves insufficient;
  largely redundant once #2 exists.
- **#5a — expand the type lattice** incrementally, as real shaders need f16/atomic/storage-tex/etc.
- **#7 — optimizer (CSE/fold/DCE)** — lowest priority; naga/the GPU compiler already does this, so
  it only matters if emitted-source size becomes a problem.
- **#10 — var-name hygiene/gensym** — **post-campaign**: auto-renaming breaks the byte-identity
  snapshot guard, so it must wait until that guard is retired or made opt-in.
- **#11 — readonly cleanup** — trivial; whenever.

---

## Constraints (cross-cutting)

- **Byte-identity guard** (`polygon-variant-diff` snapshot) is load-bearing through Waves 1–2 — those
  waves add checks / fix invalid emits without changing valid WGSL. #10 is the one item that breaks
  it → Wave 4 / opt-in.
- **Priority:** Wave 1 is build-time-only and safe to interleave with the MapLibre/Mapbox spec-100%
  campaign. Waves 3–4 are large and sit behind it (same as the engine/content split's Phases 2–4).
- **Sequencing key:** #2 (validation) is the spine — do it first; it converts the type-safety claim
  from "phantom generics" into enforced build-time errors and de-risks every later wave.
- **Relation to the foundation/app split** (`2026-06-21-shader-dsl-foundation-app-split.md`): that
  plan moves the shaders OUT of `@xgis/shader-dsl`; this plan hardens what REMAINS (the foundation
  core). They are orthogonal and compatible — do the split first so this hardening targets a
  shader-free foundation.
