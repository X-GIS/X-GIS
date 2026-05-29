# Phase 2 Plan — `_back-compat` Retire (PR 2e.B)

**Status:** design draft (code deferred to a follow-up session — this doc is the planning + risk-surface deliverable the PR 2e.A handoff demanded before code lands).
**Branch:** `claude/effect-command-19mGH`
**Handoff predecessor:** `.omc/handoffs/pr2e-backcompat-deferred.md` (PR 2e.A landed `reprojector.ts` deletion; this doc covers the deferred `_back-compat` retire).
**Scope contract reference:** `docs/shader-dsl/PHASE-3-SCOPE.md:235-238`.

---

## Requirements Summary

`compiler/src/codegen/_back-compat/node-to-wgsl-string.ts` (160 LOC) is the
last surviving Phase 2.5 migration adapter. It bundles **two distinct
concerns** that the handoff conflated into one "field rename":

| Concern | Symbols | Nature | Retirement gate |
|---|---|---|---|
| **A. Load-bearing type + helper** | `NodeLike<K>`, `wgslRaw`, plus the file-local `Expr` / `ShaderType` mirror types | Permanent compiler-side codegen vocabulary | None — just lives in the wrong directory |
| **B. Temporary string adapter** | `nodeToWgslString`, `emit`, `lit`, `wgslType`, `f32Lit` | Compiler-side copy of `runtime/.../wgsl.ts:emitExpr` | Renderer splice-point retire (US-011) |

The file's own header comment ("REMOVED IN STEP 14") treats the whole file
as transient. **That is wrong for concern A** — `NodeLike` and `wgslRaw`
are the structural codegen vocabulary the compiler's emit sites are built
on, not migration scaffolding. They must survive `_back-compat/`'s deletion.

### Ground-truthed consumer graph (verified this session)

**`nodeToWgslString` (concern B) — 1 production runtime call + oracle in tests:**
- `runtime/src/engine/render/renderer.ts:146,151` — the ONLY production
  consumer. Used to reconstruct the WGSL string the polygon composer already
  emitted (`out.color = <fillExpr-wgsl>;`) so `buildShader` can locate that
  assign and splice `variant.fillPreamble` (a string) before it.
- 9 test files use it as an emit-shape equality oracle (compiler + runtime).

**`NodeLike` (concern A) — ~6 compiler source files + tests + 1 runtime:**
- Source: `shader-gen.ts`, `shader-gen-types.ts`, `shader-gen-helpers.ts`,
  `palette-emit.ts`, `compute-output-binding.ts`, `_util/node-builders.ts`.
- `ShaderVariant.fillExpr: NodeLike | null` (`shader-gen-types.ts`) — the
  cross-workspace seam type the runtime casts through at `renderer.ts:102`.
- Re-exported from `compiler/src/index.ts:32`.

**`wgslRaw` (concern A) — compiler source + runtime tests:**
- Source: `shader-gen.ts`, `compute-output-binding.ts`, `compute-variant-merge.ts`,
  `shader-gen-types.ts`. Re-exported from `compiler/src/index.ts:32`.

### Why concern B is genuinely gated (the splice-point)

`renderer.ts:buildShader` (lines 81-157) feeds the polygon DSL composer
`emitPolygonWgsl`. The composer's `ShaderVariantInfo` (`polygon.ts:705`)
ALREADY accepts `fillPreamble: readonly Stmt[] | null` and injects it
internally (`variantReturnStmts`, `polygon.ts:765-779`: `[...preamble, ...assign]`).

**But the renderer passes `fillPreamble: null`** (`renderer.ts:116-117`) and
splices post-emit instead. Why: the compiler emits `fillPreamble` /
`strokePreamble` as **WGSL strings** (`shader-gen.ts:174-175` ←
`fillResult.matchPreamble`, the `var _mcSS = ...; if (...) { _mcSS = ...; }`
match chain authored in `wgsl-expr.ts`), not as `Stmt[]`. The composer's
slot is typed `Stmt[]`, and the runtime IR `Stmt` union
(`runtime/src/engine/shader-dsl/core/ir/nodes.ts:41-62`) has **no
raw-WGSL-string passthrough variant** — confirmed this session. So the
string preamble cannot enter the composer; the renderer reconstructs the
assign string via `nodeToWgslString` and does a `wgsl.replace(...)` splice.

Retiring `nodeToWgslString` (and thus deleting `_back-compat/`) requires
closing that splice-point, which requires one of two changes (US-011).

---

## Two-piece split

### PR 2e.B.1 — `NodeLike` + `wgslRaw` relocation (UNBLOCKED, low-risk)

Pure code-move. Behaviour byte-identical. Satisfies handoff precondition #2.

**Steps**
1. Create `compiler/src/codegen/node-types.ts` (permanent home). Move into it:
   the `Scalar` / `ShaderType` / `BinOp` / `CmpOp` / `LogOp` / `Expr` mirror
   types, `NodeLike<K>`, and `wgslRaw`. Keep all JSDoc; drop the "REMOVED IN
   STEP 14" framing from the relocated symbols (they are permanent).
2. `_back-compat/node-to-wgsl-string.ts` keeps `nodeToWgslString` + the `emit`
   / `lit` / `wgslType` / `f32Lit` machinery, now importing `Expr` /
   `ShaderType` / `NodeLike` from `../node-types`. The file shrinks; its
   header is rewritten to describe ONLY the still-transient adapter.
3. Update the ~6 source consumers + `compiler/src/index.ts:32` re-export to
   import `NodeLike` / `wgslRaw` from `./codegen/node-types` (or `./node-types`).
4. Tests importing `nodeToWgslString` are untouched (still from `_back-compat/`).
   Tests importing `NodeLike` repoint to the new home.

**Verify:** `tsc` clean in both workspaces; full `compiler` + `runtime` test
suites pass unchanged; `git grep "REMOVED IN STEP 14"` no longer matches the
relocated symbols; bundle byte-diff on emitted WGSL = 0 (no behaviour change).

**Risk:** Low. Single-symbol-per-import re-point. No logic touched. The
round-trip test (`_back-compat/node-to-wgsl-string.test.ts`) still pins the
adapter; the type relocation is structural only.

### PR 2e.B.2 — Splice-point retire + `_back-compat/` deletion (US-011, design-gated)

This is the multi-day piece. Two candidate approaches:

**Approach (a) — `rawStmt` IR variant (smaller, pragmatic).**
Add `{ readonly s: 'raw'; readonly wgsl: string }` to the runtime IR `Stmt`
union (`nodes.ts`) + emit support in `wgsl.ts` (`emitStmt` returns the raw
string verbatim, correctly indented). Then `buildShader` wraps
`variant.fillPreamble` / `strokePreamble` strings in a `rawStmt` and passes
them through `ShaderVariantInfo.fillPreamble` to the composer, which already
prepends them before the assign. Post-emit `wgsl.replace` splice + the
`nodeToWgslString` reconstruction both delete; `renderer.ts` drops its
`@xgis/compiler` `nodeToWgslString` import. `_back-compat/` deletes once the 9
test oracles migrate (see below).
- **Pro:** No compiler-side `_mcSS`-string → `Stmt[]` rewrite. Composer already
  does prepend-then-assign, so output is byte-identical IF indentation matches.
- **Con:** Introduces a raw-WGSL escape hatch into the typed IR — a
  predictability sink of its own. Must be scoped/documented as preamble-only.
  Indentation parity is the correctness risk (the current splice uses `'\n  '`).

**Approach (b) — compiler emits `Stmt[]` preambles (proper, larger).**
Migrate `wgsl-expr.ts`'s match-preamble authoring from string assembly to
Node/Stmt construction so `ShaderVariant.fillPreamble` becomes `Stmt[]`. This
is the true US-011. Eliminates the raw escape hatch entirely; the composer
consumes structured Stmts end-to-end.
- **Pro:** No raw-string IR hole; fully typed pipeline.
- **Con:** Multi-day. Touches every preamble-emitting idiom (match chains,
  categorical encoders). Cross-workspace `ShaderVariant` type change ripples
  to the runtime cast at `renderer.ts:99-107`.

**Test-oracle migration (both approaches):** the 9 files using
`nodeToWgslString` as an emit oracle either (i) keep a small `nodeToWgslString`
helper relocated to a permanent test-util (NOT `_back-compat/`), or (ii)
switch to a Node-structural-equality oracle. Decide during B.2 design.

**Verify (B.2):** pixel-diff harness across the variant-bearing polygon paths
(categorical fill, per-feature data-driven, compute-routed) — the splice
output must be byte-identical pre/post, gated at ≤ 0% WGSL delta on the
canonical fixtures. `git grep -r "_back-compat"` reaches 0.

---

## Risk surface analysis

1. **Concern A/B conflation (handoff's own framing).** Mitigated by the split:
   B.1 ships the safe relocation; B.2 owns the gated deletion. Neither pretends
   to be the other.
2. **Indentation parity (Approach a).** The current splice prepends with
   `'\n  '` (2-space body indent, `renderer.ts:148`). A `rawStmt` emitted by
   `wgsl.ts:emitStmt` must reproduce that exact indent or the WGSL output
   drifts (compiles, but snapshot/byte gates fire). Pin with a byte-diff gate.
3. **`ShaderVariant` cross-workspace type (Approach b).** Changing `fillPreamble`
   from `string` to `Stmt[]` ripples through `compute-variant-merge.ts:123-124`
   (the override-drop logic) and the runtime cast seam. Full type audit needed.
4. **Test-oracle dependency.** 9 files depend on `nodeToWgslString` for emit
   assertions. Deleting it without a replacement oracle breaks them — the
   migration must land in the same PR as the deletion.
5. **`matchExpr` throw path.** `nodeToWgslString` throws on `matchExpr`
   (fn-body-only). Any replacement emit path must preserve that invariant or a
   pre-emit lowering guarantee.

---

## ADR

**Decision:** Split PR 2e.B into **B.1 (relocation, unblocked)** and **B.2
(splice-point retire + deletion, US-011-gated)**. Write this design doc first;
do not land B.2 blind.

**Drivers:**
- Handoff explicitly demanded "a planning step + risk surface analysis before
  code lands."
- Concern A (relocation) is safe and unblocked; concern B is genuinely
  multi-day and design-gated on the runtime IR / compiler preamble shape.
- The runtime IR `Stmt` union has no raw passthrough — confirmed, so B is not
  a trivial wiring change.

**Alternatives considered:**
- **Monolithic PR 2e.B (relocate + delete in one):** rejected — bundles a
  zero-risk code-move with a multi-day refactor; un-revertible as a unit.
- **Approach (b) only (skip the raw-Stmt option):** acknowledged; it is the
  "correct" end state but the larger lift. Approach (a) may be an acceptable
  intermediate if the raw-Stmt hole is tightly scoped — decide at B.2 design.

**Consequences:**
- After B.1, `NodeLike` / `wgslRaw` live in a permanent home; the
  "REMOVED IN STEP 14" framing no longer mislabels load-bearing types.
- `_back-compat/node-to-wgsl-string.ts` remains (shrunk) until B.2.
- B.2 closes `PHASE-3-SCOPE.md:235-238` and removes the last Phase 2.5 adapter.

---

## Open Questions (resolve at B.2 design)

1. Approach (a) raw-`Stmt` vs (b) full compiler `Stmt[]` preamble emit — which?
2. Test-oracle: relocate `nodeToWgslString` to a test-util, or switch to
   Node-equality? (Affects whether the symbol survives at all.)
3. Permanent home filename: `compiler/src/codegen/node-types.ts` vs folding
   into an existing codegen module — confirm against directory conventions.
