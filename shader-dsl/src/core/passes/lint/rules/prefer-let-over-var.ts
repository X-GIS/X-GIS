import type { Stmt } from '../../../ir'
import type { LintRule } from '../engine'

/** Collect the names targeted by an 'assign'/'assignOp' whose target is a plain
 *  varref, recursing into nested blocks (if / for / switch). */
function collectReassigned(body: readonly Stmt[], names: Set<string>): void {
  for (const s of body) {
    if ((s.s === 'assign' || s.s === 'assignOp') && s.target.op === 'varref') names.add(s.target.name)
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
          ctx.report(`var '${v.name}' in fn '${f.name}' is never reassigned — use let`, { fn: f.name })
        }
      }
    },
  }),
}
