// ═══ Shader DSL — optimization pipeline (Optimization context) ═══
//
// optimize(module) runs an ordered list of correctness-preserving passes, each
// pure (module -> module). The headline value of the node IR: a real optimizing
// compiler, not a transliterator. Correctness is pinned by oracle value-equality
// (every pass must leave compileModule(m) producing identical results) and, once
// it lands (P3), the real-GPU f32 differential.

import type { ModuleDecl } from '../../ir'
import { constFold } from './const-fold'
import { algebraicSimplify } from './algebraic'
import { cse } from './cse'
import { licm } from './licm'
import { dce } from './dce'

export type OptPass = (m: ModuleDecl) => ModuleDecl

/** The default pipeline. const-fold + algebraic-simplify first (they create
 *  literals / expose subexpressions), then CSE (hoist repeats) and LICM (hoist
 *  loop invariants), then DCE last (clean up anything the earlier passes orphaned). */
export const DEFAULT_PASSES: readonly OptPass[] = [constFold, algebraicSimplify, cse, licm, dce]

export function optimize(m: ModuleDecl, passes: readonly OptPass[] = DEFAULT_PASSES): ModuleDecl {
  return passes.reduce((mod, pass) => pass(mod), m)
}
