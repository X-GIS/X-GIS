// ═══════════════════════════════════════════════════════════════════
// nodeToWgslString — Expr → WGSL string oracle (test-only)
// ═══════════════════════════════════════════════════════════════════
//
// Thin DELEGATION to `@xgis/shader-dsl`'s `emitExpr` — the single neutral
// tree-walk + the WGSL backend's spelling. There is no hand-copied emit logic
// here (it was retired once `compiler → @xgis/shader-dsl` became an acyclic
// value-dep); `node.expr` is the package IR `Expr` directly.
//
// Production never calls this: fill/stroke colours flow into the runtime polygon
// composer as real DSL Nodes, emitted by `emitModule`. It survives only as a
// test emit-shape oracle (`v.fillExpr ? nodeToWgslString(v.fillExpr) : …`),
// asserting the WGSL a single Node lowers to. A `matchExpr` reaching the emitter
// throws (the pre-emit `lowerModule` pass should have hoisted it into a switch).

import type { NodeLike } from './node-types'
import { emitExpr } from '@xgis/shader-dsl'

/**
 * Convert a DSL `Node`-shaped value (`{ expr: Expr }`) to its WGSL string
 * representation. Emit-shape equality oracle for compiler + runtime tests.
 */
export function nodeToWgslString(node: NodeLike): string {
  return emitExpr(node.expr)
}
