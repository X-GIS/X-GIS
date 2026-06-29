// ═══════════════════════════════════════════════════════════════════
// node-types — compiler-side DSL Node vocabulary (permanent)
// ═══════════════════════════════════════════════════════════════════
//
// The compiler's codegen Node vocabulary: the package IR `Expr` (IMPORTED from
// `@xgis/shader-dsl`) + the `NodeLike` seam type. Single-emit: every fill/stroke
// expression is now a real IR Node, so the compiler-local `rawString` escape-hatch
// op + its `wgslRaw` wrapper are gone — `Expr` equals the package's union exactly.
//
// Relocated out of the former `_back-compat/` directory: the type vocabulary
// landed here in PR 2e.B.1; the `nodeToWgslString` emit oracle (`node-to-wgsl.ts`)
// imports its types from here.
//
// `Expr` IMPORTED from the package (Tier-2 dedup — see
// docs/architecture/package-responsibilities.md §5): `@xgis/shader-dsl` is a
// zero-dep leaf, so `compiler → @xgis/shader-dsl` is acyclic (the same shape as
// the existing `compiler → @xgis/shared` edge; runtime already imports it).

import type { Expr as DslExpr } from '@xgis/shader-dsl'

export type Expr = DslExpr

/**
 * Structural Node mirror — the compiler can't import the runtime Node
 * class directly (compiler/tsconfig.json's rootDir excludes runtime/
 * and the runtime package is the dependent in the workspace chain).
 * Runtime's actual `Node<K>` is structurally assignable to this shape;
 * the typed `__k?: K` brand carries the WGSL key for type safety in
 * the compiler-side codegen.
 */
export interface NodeLike<K extends string = string> {
  readonly expr: Expr
  readonly __k?: K
}
