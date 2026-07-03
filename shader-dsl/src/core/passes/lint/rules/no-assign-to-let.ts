import type { Expr, Stmt } from '../../../ir'
import type { LintRule } from '../engine'

// Split a fn body's local bindings into immutable `let` names and mutable `var` names
// (recursing into if / for / switch blocks; the for-init counter is a `var`). A name that
// is BOTH (a shadowing redeclare) is treated as mutable — it is not the footgun this rule
// targets, and binding-collision already covers genuine name clashes.
function collectLetVar(body: readonly Stmt[], lets: Set<string>, vars: Set<string>): void {
  for (const s of body) {
    if (s.s === 'let') lets.add(s.name)
    else if (s.s === 'var') vars.add(s.name)
    else if (s.s === 'if') {
      for (const a of s.arms) collectLetVar(a.body, lets, vars)
      if (s.elseBody) collectLetVar(s.elseBody, lets, vars)
    } else if (s.s === 'for') {
      collectLetVar([s.init], lets, vars)
      collectLetVar(s.body, lets, vars)
    } else if (s.s === 'switch') {
      for (const c of s.cases) collectLetVar(c.body, lets, vars)
      if (s.defaultBody) collectLetVar(s.defaultBody, lets, vars)
    }
  }
}

// The root binding name an assignment lvalue writes — peel `.field` / `[i]` to the base, and
// return its name only if that base is a `varref` (a named binding). A non-varref root (the
// pre-autoVars `const x = expr; x.assign(…)` pattern, whose target is the raw expr) returns
// undefined, so this rule never fires on the auto-var sugar — autoVars materialises it into a
// real var before emit.
function targetRootName(e: Expr): string | undefined {
  let cur = e
  while (cur.op === 'member' || cur.op === 'index') cur = cur.base
  return cur.op === 'varref' ? cur.name : undefined
}

/** Flag an assignment whose target is a `let`-bound (immutable) binding — `Let(x); x.assign(…)`
 *  emits `let x = …; x = …;`, which is invalid WGSL (a `let` cannot be reassigned) and only
 *  surfaces at `device.createShaderModule`. `.assign()` lives on every Node, so nothing else
 *  stops it; this rule is the guard. Fix: declare the binding with `Var()` to mutate it. */
export const noAssignToLet: LintRule = {
  id: 'no-assign-to-let',
  description:
    'assigning to a let-bound (immutable) binding is invalid WGSL — declare it with Var() to mutate',
  severity: 'error',
  category: 'correctness',
  create: (ctx) => {
    let lets = new Set<string>()
    let vars = new Set<string>()
    return {
      // Func runs immediately before this fn's Stmt walk (engine order), so the sets are this fn's.
      Func(f) {
        lets = new Set()
        vars = new Set()
        collectLetVar(f.body, lets, vars)
      },
      Stmt(s, fn) {
        if (s.s !== 'assign' && s.s !== 'assignOp') return
        const root = targetRootName(s.target)
        if (root !== undefined && lets.has(root) && !vars.has(root)) {
          ctx.report(
            `assignment to immutable 'let' binding '${root}' in fn '${fn.name}' — declare it with Var() to mutate (assigning to a 'let' is invalid WGSL)`,
            {
              fn: fn.name,
              node: s,
              code: 'SD0107',
              hint: 'declare the binding with Var() instead of Let() to mutate it',
            },
          )
        }
      },
    }
  },
}
