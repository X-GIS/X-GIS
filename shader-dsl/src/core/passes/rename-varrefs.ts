// ═══ rewriteExprsInFunc / renameVarrefsInFunc — content-blind expression
//     rewriting over a function body ═══
//
// Host modules sometimes need to re-point references AFTER a module is
// assembled — e.g. deriving a variant of a module whose uniform block was
// split into several: DSL-built reads are `member` chains rooted at the
// block's binding `varref`, and compiler-spliced paint expressions carry the
// block alias INSIDE a dotted `varref` name (`u.zoom`) that backends emit
// verbatim. Both live in IR as plain data, so only an IR walk can re-point
// them.
//
// `rewriteExprsInFunc` maps a caller-supplied Expr rewrite over every
// expression in a FuncDecl's body — all statement and expression shapes, via
// the same mapStmt/mapExpr the mangler uses (one walker authority, no
// drift). The rewrite sees every node post-order; subtrees it RETURNS are
// not re-walked (they are the caller's finished output).
//
// `renameVarrefsInFunc` is the common special case: rename `varref` names
// (undefined = keep).

import type { Expr, FuncDecl, Stmt } from '../ir/nodes.js'
import { mapExpr, mapStmt } from './opt/ir-transform.js'

/** Map `rewrite` over every expression in `f`'s body. Returns `f` itself
 *  when nothing changed (referential no-op for memo friendliness). */
export function rewriteExprsInFunc(f: FuncDecl, rewrite: (e: Expr) => Expr): FuncDecl {
  let changed = false
  const body: Stmt[] = f.body.map((s) =>
    mapStmt(s, (e) =>
      mapExpr(e, (x) => {
        const y = rewrite(x)
        if (y !== x) changed = true
        return y
      }),
    ),
  )
  return changed ? { ...f, body } : f
}

/** Rename every `varref` in `f`'s body via `rename` (undefined = keep). */
export function renameVarrefsInFunc(
  f: FuncDecl,
  rename: (name: string) => string | undefined,
): FuncDecl {
  return rewriteExprsInFunc(f, (x) => {
    if (x.op !== 'varref') return x
    const to = rename(x.name)
    return to === undefined || to === x.name ? x : { ...x, name: to }
  })
}
