import type { Stmt, Expr } from '../../../ir'
import { mapStmts, type LintRule } from '../engine'

/** Peel member/index access to the root varref name — so `out.pos = x` and `v[i] = x`
 *  both count as mutating `out` / `v` (a struct/vector var with field mutation MUST
 *  stay a var; it cannot be a let). Returns undefined if the target is not var-rooted. */
function rootVarref(e: Expr): string | undefined {
  let cur: Expr = e
  for (;;) {
    if (cur.op === 'varref') return cur.name
    if (cur.op === 'member' || cur.op === 'index') {
      cur = cur.base
      continue
    }
    return undefined
  }
}

/** Collect the names mutated by an 'assign'/'assignOp' — direct (`v = …`) or via a
 *  member/index target (`v.x = …`) — recursing into nested blocks (if / for / switch). */
function collectReassigned(body: readonly Stmt[], names: Set<string>): void {
  for (const s of body) {
    if (s.s === 'assign' || s.s === 'assignOp') {
      const r = rootVarref(s.target)
      if (r) names.add(r)
    }
    if (s.s === 'if') {
      for (const arm of s.arms) collectReassigned(arm.body, names)
      if (s.elseBody) collectReassigned(s.elseBody, names)
    } else if (s.s === 'for') {
      collectReassigned([s.init, s.update], names)
      collectReassigned(s.body, names)
    } else if (s.s === 'switch') {
      for (const c of s.cases) collectReassigned(c.body, names)
      if (s.defaultBody) collectReassigned(s.defaultBody, names)
    }
  }
}

/** Collect the names declared by a 'var' Stmt, recursing into nested blocks. */
function collectVars(body: readonly Stmt[], out: { name: string }[]): void {
  for (const s of body) {
    if (s.s === 'var') out.push({ name: s.name })
    if (s.s === 'if') {
      for (const arm of s.arms) collectVars(arm.body, out)
      if (s.elseBody) collectVars(s.elseBody, out)
    } else if (s.s === 'for') {
      collectVars([s.init, s.update], out)
      collectVars(s.body, out)
    } else if (s.s === 'switch') {
      for (const c of s.cases) collectVars(c.body, out)
      if (s.defaultBody) collectVars(s.defaultBody, out)
    }
  }
}

/** A `var` that is never reassigned should be a `let` (immutable). Flags any 'var'
 *  Stmt whose name is never the target of an 'assign'/'assignOp' in the fn body. */
export const preferLetOverVar: LintRule = {
  id: 'prefer-let-over-var',
  description: 'a var that is never reassigned should be a let',
  severity: 'warning',
  category: 'style',
  create: (ctx) => ({
    Func(f) {
      const reassigned = new Set<string>()
      collectReassigned(f.body, reassigned)
      const vars: { name: string }[] = []
      collectVars(f.body, vars)
      for (const v of vars) {
        if (!reassigned.has(v.name)) {
          ctx.report(`var '${v.name}' in fn '${f.name}' is never reassigned — use let`, {
            fn: f.name,
          })
        }
      }
    },
  }),
  // auto-fix: rewrite each never-reassigned `var name = init` to `let name = init`.
  fix(m) {
    let changed = false
    const funcs = m.funcs.map((f) => {
      const reassigned = new Set<string>()
      collectReassigned(f.body, reassigned)
      const body = mapStmts(f.body, (s) => {
        if (s.s === 'var' && s.init !== undefined && !reassigned.has(s.name)) {
          changed = true
          return { s: 'let', name: s.name, expr: s.init }
        }
        return s
      })
      return { ...f, body }
    })
    return changed ? { ...m, funcs } : null
  },
}
