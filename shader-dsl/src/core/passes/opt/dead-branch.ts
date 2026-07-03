// ═══ Shader DSL — dead-branch elimination (Optimization context) ═══
//
// Removes statically-decided control flow — the branches that const-prop +
// const-fold expose by collapsing a condition to a `lit` bool:
//   • an `if` arm whose cond is `lit false` is dropped (never taken);
//   • the first arm whose cond is `lit true` always fires (given earlier arms fell
//     through), so it absorbs the chain — earlier non-literal arms are kept and it
//     becomes their `else`; later arms / the original else are unreachable, dropped.
//     A FIRST-arm `lit true` collapses the whole `if` to that arm's body inline.
//
// Pure STRUCTURAL removal: surviving statements are byte-identical, so this needs
// no f32 reasoning. Inlining a body into the parent is safe — binding names are
// unique per fn (flat env, see oracle.ts). A fn with a raw Stmt is skipped.
// `select(lit cond, …)` is handled at the expr level by const-fold, not here.

import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../../ir'
import { bodyHasRaw } from './expr-utils'

const isLitBool = (e: Expr, v: boolean): boolean => e.op === 'lit' && e.value === v

function ddBody(body: readonly Stmt[]): Stmt[] {
  const out: Stmt[] = []
  for (const s of body) out.push(...ddStmt(s))
  return out
}

function ddStmt(s: Stmt): Stmt[] {
  switch (s.s) {
    case 'if': {
      const newArms: { cond: Expr; body: readonly Stmt[] }[] = []
      let elseBody = s.elseBody ? ddBody(s.elseBody) : undefined
      for (const arm of s.arms) {
        const body = ddBody(arm.body)
        if (isLitBool(arm.cond, false)) continue // never taken — drop the arm
        if (isLitBool(arm.cond, true)) {
          // Always taken (given earlier arms fell through). First arm → the whole
          // `if` is just this body; otherwise it becomes the else, rest unreachable.
          if (newArms.length === 0) return body
          elseBody = body
          break
        }
        newArms.push({ cond: arm.cond, body })
      }
      if (newArms.length === 0) return elseBody ? [...elseBody] : []
      return [{ s: 'if', arms: newArms, elseBody }]
    }
    case 'for':
      return [{ ...s, body: ddBody(s.body) }]
    case 'switch':
      return [
        {
          ...s,
          cases: s.cases.map((c) => ({ value: c.value, body: ddBody(c.body) })),
          defaultBody: s.defaultBody ? ddBody(s.defaultBody) : undefined,
        },
      ]
    default:
      return [s]
  }
}

function ddFn(f: FuncDecl): FuncDecl {
  if (bodyHasRaw(f.body)) return f
  return { ...f, body: ddBody(f.body) }
}

/** Eliminate statically-decided `if` branches. Pure (module -> module). */
export function deadBranch(m: ModuleDecl): ModuleDecl {
  return { ...m, funcs: m.funcs.map(ddFn) }
}
