# Phase 2 PR 2e — `_back-compat` retire DEFERRED to PR 2e.B

**PR 2e.A scope (this PR):** `reprojector.ts` deletion only (2 files removed, 3 comment cleanups).

**PR 2e.B scope (deferred):** polygon DSL `_back-compat` adapter (`compiler/src/codegen/_back-compat/node-to-wgsl-string.ts`) retire.

## Why the split

The PR 2e task description conflated two independent retirements. Reality on `main` (commit `984a328`):

### `_back-compat` is NOT just a polygon DSL "preamble field"

The directory `compiler/src/codegen/_back-compat/` contains a **single 158-LOC adapter** (`node-to-wgsl-string.ts`) that exports `nodeToWgslString` + `wgslRaw` + `NodeLike`. These are:

1. **Runtime-load-bearing:** `runtime/src/engine/render/renderer.ts:146-151` calls `nodeToWgslString(variant.fillExpr)` + `nodeToWgslString(variant.strokeExpr)` at every pipeline build. This is the splice-marker path that converts compiler-emitted Node DSL into the WGSL strings the polygon DSL composer's marker-substitution stage replaces.

2. **Compiler-pervasive type:** `NodeLike` is the structural type used by:
   - `compiler/src/codegen/shader-gen.ts` (imports `wgslRaw` + `NodeLike`)
   - `compiler/src/codegen/shader-gen-types.ts` (`ShaderVariant.fillExpr: NodeLike | null`)
   - `compiler/src/codegen/palette-emit.ts` (palette helper return type)
   - `compiler/src/codegen/compute-output-binding.ts` (compute binding emit return type)
   - `compiler/src/codegen/_util/node-builders.ts` (the per-idiom node builders)

3. **Test-pervasive:** `nodeToWgslString` is the equality oracle in 9 test files (compiler + runtime) for asserting variant emit shape:
   - `compiler/src/codegen/_back-compat/node-to-wgsl-string.test.ts` (6 tests)
   - `compiler/src/codegen/_util/node-builders.test.ts` (15+ assertions)
   - `compiler/src/codegen/compute-variant-merge.test.ts`
   - `compiler/src/codegen/compute-variant-build.test.ts`
   - `compiler/src/codegen/shader-gen-palette.test.ts`
   - `compiler/src/__tests__/emit-compute-plan.test.ts`
   - `runtime/src/engine/continent-match-compute-mock.test.ts`
   - `runtime/src/engine/render/p4-end-to-end.test.ts`
   - `runtime/src/engine/render/renderer-compute-simulation.test.ts`

## Retirement preconditions

Per `docs/shader-dsl/PHASE-3-SCOPE.md:235-238`:

> `_back-compat/node-to-wgsl-string.ts` adapter deletes after `NodeLike` + `wgslRaw` relocate to a stable compiler-side location (post-US-010) AND the renderer.ts splice-point lookup drops the `nodeToWgslString` call.

Two independent prerequisites — neither is done on `main`:

1. **`NodeLike` + `wgslRaw` relocation.** These must move out of `_back-compat/` into a permanent compiler-side home (e.g., `compiler/src/codegen/node-types.ts`). All ~9 consumers re-import from the new location. Stays a code-move, behaviour-byte-identical.

2. **Renderer.ts splice-point retire.** The polygon DSL composer must accept Node values directly so `renderer.ts:146,151` stops converting `variant.fillExpr` → WGSL string at runtime via `nodeToWgslString`. The composer currently uses string-splice marker substitution (`FILL_EXPR_MARKER` / `STROKE_EXPR_MARKER`); migrating it to accept Node values is a multi-day refactor with full pixel-diff coverage requirement.

## Why "22 consumers" is misleading

The PR 2e task description quoted "22 consumers" — actual reality is:
- **9 test files** referencing `nodeToWgslString` (oracle role, not production)
- **~6 compiler source files** referencing `NodeLike` type (structural type, not behaviour)
- **1 runtime production site** (`renderer.ts`) calling `nodeToWgslString` at pipeline-build time
- **1 export site** (`compiler/src/index.ts`) re-exporting the trio

This is NOT a "22-consumer field rename" — it's two distinct refactors (type-relocation + splice-point retire) gated on the polygon DSL composer accepting Node values directly. Neither has a current design doc; PR 2e.B will require a planning step + risk surface analysis before code lands.

## Decision

Land PR 2e.A (`reprojector.ts` deletion) now — clean dead-code drop with zero blast radius. Defer `_back-compat` retire to a dedicated PR 2e.B once:

1. The polygon DSL composer Node-accepting refactor lands (depends on US-011 from `docs/shader-dsl/PHASE-3-SCOPE.md`).
2. `NodeLike` + `wgslRaw` relocate to a permanent compiler-side home.
3. The 9 test files migrate from the `nodeToWgslString` oracle to a Node-equality oracle (or remain importing from the new permanent location if the helper itself is kept around outside `_back-compat/`).

## PR 2e.A grep audit (this PR)

Post-deletion grep `[Rr]eprojector` results:

| Directory | Hits | Notes |
|-----------|------|-------|
| `runtime/src/` | 1 | `projection-inverse-roundtrip.test.ts` comment — historical pointer to iter-311 bug origin |
| `compiler/src/` | 0 | Compiler had no consumers |
| `docs/` | 1 | `shader-dsl/PHASE-3-SCOPE.md` — historical documentation of Phase 4+ deferral status |
| `.omc/` | many | Plan + memory files — read-only |

AC7 strict-grep gate (`runtime/src/engine/` `/* wgsl */` audit per `docs/shader-dsl/PHASE-3-SCOPE.md`): `reprojector.ts` was the last remaining file in the unfiltered count. After this PR, the unfiltered grep reaches 0 — the long-term target documented at `PHASE-3-SCOPE.md:246` ("AC7 unfiltered grep reaches 0 — DEFERRED on reprojector.ts").
