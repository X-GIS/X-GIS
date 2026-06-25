// ═══════════════════════════════════════════════════════════════════
// node-types — compiler-side DSL Node vocabulary (permanent)
// ═══════════════════════════════════════════════════════════════════
//
// The compiler's codegen Node vocabulary: the package IR `Expr`/`ShaderType`
// (IMPORTED from `@xgis/shader-dsl`) plus the compiler-local `rawString` op, the
// `NodeLike` seam type, and the `wgslRaw` helper. NOT migration scaffolding — a
// permanent home.
//
// Relocated out of the former `_back-compat/` directory: the type vocabulary
// landed here in PR 2e.B.1; the `nodeToWgslString` emit oracle (`node-to-wgsl.ts`)
// imports its types from here. The renderer splice-point that depended on the
// adapter retired in PR 2e.B.2.
//
// `Expr`/`ShaderType` are now IMPORTED from the package (Tier-2 dedup — see
// docs/architecture/package-responsibilities.md §5): `@xgis/shader-dsl` is a
// zero-dep leaf, so `compiler → @xgis/shader-dsl` is acyclic (the same shape as
// the existing `compiler → @xgis/shared` edge; runtime already imports it). The
// only compiler-local addition is the `rawString` op below.

import type { Expr as DslExpr, ShaderType } from '@xgis/shader-dsl'

export type { ShaderType }

// The compiler's Node vocabulary = the package IR `Expr` PLUS one compiler-local
// op, `rawString` — a back-compat wrapper that carries a pre-built WGSL string so
// emit sites can satisfy the Node-typed ShaderVariant fields without constructing a
// real Node. `nodeToWgslString` unwraps it verbatim. (Retires with the renderer
// splice-point, PR 2e.B.2; once gone the union equals the package's `Expr`.)
export type Expr = DslExpr | { readonly op: 'rawString'; readonly value: string }

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

/**
 * Wrap a pre-built WGSL string as a NodeLike so the compiler-side emit
 * sites can satisfy the Node-typed ShaderVariant fields where a real Node
 * value is not yet constructed. The renderer splice-point reconstructs the
 * string via `nodeToWgslString`; both retire in PR 2e.B.2.
 */
export function wgslRaw<K extends string>(s: string): NodeLike<K> {
  return { expr: { op: 'rawString', value: s } }
}
