// ═══════════════════════════════════════════════════════════════════
// nodeToWgslString — Expr → WGSL string oracle
// ═══════════════════════════════════════════════════════════════════
//
// Compiler-side HAND COPY of `@xgis/shader-dsl`'s WGSL `emitExpr`, now at
// `shader-dsl/src/core/backends/wgsl.ts` (the DSL was extracted out of `runtime/`).
// Relocated out of `_back-compat/` in PR 2e.B.2 when its last production
// consumer (the renderer polygon splice-point) retired: fill/stroke preambles
// now flow into the polygon composer as raw-WGSL Stmts, so the runtime no
// longer reconstructs the assign string via this adapter.
//
// It survives as a test-only emit-shape oracle (`v.fillExpr ?
// nodeToWgslString(v.fillExpr) : …`) — asserting the WGSL a Node lowers to.
//
// NOT an import — extraction debt. The old reason ("a relative import of the
// runtime wgsl.ts would push a runtime file outside compiler's rootDir; adding
// `@xgis/runtime` would create a cycle") is STALE: emitExpr now lives in the
// zero-dep `@xgis/shader-dsl`, so `compiler → @xgis/shader-dsl` is acyclic (the
// same shape as `compiler → @xgis/shared`; runtime already imports it). Dedup is
// tracked in docs/architecture/package-responsibilities.md (§5).
//
// Drift risk is REAL and UNGUARDED: this copy diverges from the package emitter
// if either changes, and `node-to-wgsl.test.ts` pins it only to ITSELF (hand-
// typed fixtures) — it never imports the live emitter, so it cannot catch drift.
// Known divergences: hardcoded `call`/`select` (vs the intrinsic registry) and
// `array<T,N>` spacing. Reachable only if a non-identity intrinsic spelling or a
// multisampled texture type flows through here (neither does today).

import type { NodeLike } from './node-types'
import { emitExpr } from '@xgis/shader-dsl'

// `nodeToWgslString` lowers a compiler `NodeLike` to its WGSL string by DELEGATING
// to the package emitter (`emitExpr` from `@xgis/shader-dsl` — the single neutral
// tree-walk + the WGSL backend's spelling). The only compiler-local op is
// `rawString` (a pre-built WGSL string), unwrapped verbatim here; everything else is
// the package IR `Expr`. A `matchExpr` that reaches the emitter throws (the pre-emit
// `lowerModule` pass should have hoisted it into a `Stmt.switch` first).

/**
 * Convert a DSL `Node`-shaped value (`{ expr: Expr }`) to its WGSL string
 * representation. Emit-shape equality oracle for compiler + runtime tests.
 */
export function nodeToWgslString(node: NodeLike): string {
  return node.expr.op === 'rawString' ? node.expr.value : emitExpr(node.expr)
}
