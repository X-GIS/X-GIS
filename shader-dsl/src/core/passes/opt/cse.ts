// ═══ Shader DSL — common-subexpression elimination (Optimization context) ═══
//
// Hoists a compound subexpression that occurs >= 2x and depends ONLY on fn
// inputs (params / consts / bindings — no local `let`) into a single `let` at the
// fn top, replacing each occurrence with a varref. This is a PASS over the IR,
// not an authoring change (the critic's "hash-consing rebuilds authoring" risk
// does not apply — `new Node(...)` is untouched).
//
// SAFE SUBSET (v1): only "independent" repeated exprs are hoisted — a selected
// expr that nests another selected expr is skipped (the inner one is hoisted
// instead), so no ordering/nesting interaction. A fn containing a raw Stmt is
// skipped (raw WGSL is opaque). Correctness is pinned by oracle value-equality.

import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../../ir'
import {
  keyOf, isCompound, eachExpr, mapChildren, forEachTopExpr, mapStmtTop,
  bodyHasRaw, collectLocals, refsLocal,
} from './expr-utils'

function cseFn(f: FuncDecl): FuncDecl {
  if (bodyHasRaw(f.body)) return f
  const locals = new Set<string>()
  collectLocals(f.body, locals)

  // Count occurrences of every compound, input-only subexpression.
  const counts = new Map<string, number>()
  const exemplar = new Map<string, Expr>()
  for (const s of f.body) {
    forEachTopExpr(s, (e) => {
      if (!isCompound(e) || refsLocal(e, locals)) return
      const k = keyOf(e)
      counts.set(k, (counts.get(k) ?? 0) + 1)
      if (!exemplar.has(k)) exemplar.set(k, e)
    })
  }
  const repeated = new Set<string>([...counts].filter(([, n]) => n >= 2).map(([k]) => k))
  if (repeated.size === 0) return f

  // Keep only "independent" repeated exprs (no repeated proper sub-expr) — the
  // inner one is hoisted instead, so there is no ordering/nesting interaction.
  const independent = [...repeated].filter((k) => {
    const e = exemplar.get(k)!
    let nests = false
    eachExpr(e, (sub) => { if (sub !== e && repeated.has(keyOf(sub))) nests = true })
    return !nests
  })
  if (independent.length === 0) return f

  // Assign a temp per independent key; build the hoisted lets + replacement map.
  const temp = new Map<string, string>()
  const lets: Stmt[] = []
  independent.forEach((k, i) => {
    const name = `_cse${i}`
    temp.set(k, name)
    lets.push({ s: 'let', name, expr: exemplar.get(k)! })
  })

  const replace = (e: Expr): Expr => {
    const t = temp.get(keyOf(e))
    if (t !== undefined) return { op: 'varref', type: e.type, name: t }
    return mapChildren(e, replace)
  }
  const newBody = f.body.map((s) => mapStmtTop(s, replace))
  return { ...f, body: [...lets, ...newBody] }
}

/** Hoist repeated input-only subexpressions to shared temps. Pure (module -> module). */
export function cse(m: ModuleDecl): ModuleDecl {
  return { ...m, funcs: m.funcs.map(cseFn) }
}
