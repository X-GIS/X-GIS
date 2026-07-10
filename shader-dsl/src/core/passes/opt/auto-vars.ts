// ═══ Shader DSL — auto-var construction (Optimization context) ═══
//
// Lets authors write a MUTATED value as a plain `const x = expr` + `assign(x, …)` with no `Var`
// ceremony: the developer never names/types a mutable binding, and never picks `var`/`let`. This
// pass finds any value that is later ASSIGNED (an `assign`/`assignOp` whose target is a whole value,
// not a field/element access) and materialises it as a WGSL `var`, inserted just before the binding's
// first use and with every reference rewritten to the var.
//
// Correctness for loops hinges on Expr OBJECT IDENTITY: `assign(acc, f(acc, …))` records the SAME
// Expr object as both the assign target AND inside the value `f(acc, …)`, so rewriting that object →
// the varref fixes the target AND the read in one pass (`_av = f(_av, …)`, not `_av = f(<init>, …)`).
// Runs BEFORE lower/cse (which clone exprs and would break identity).

import type { Expr, Stmt, FuncDecl, ModuleDecl, ShaderType } from '../../ir'
import { eachExpr, mapChildren, mapStmtTop } from './expr-utils'

// The ROOT of an assign/assignOp target — peel any `.field` / `[i]` access so a member-assign
// (`c.a = …` / `m[i] = …`) materialises the underlying value `c` / `m`, not the access expr.
function targetRoot(t: Expr): Expr {
  let e = t
  while (e.op === 'member' || e.op === 'index') e = e.base
  return e
}

// A materialisable root — a plain value the author held in a `const` (a literal / call / construct /
// select / arith), NOT one that is already a named binding (varref) or an input (param / constref /
// overrideref — a specialization constant is a named symbolic input, #923).
function isMaterialisable(e: Expr): boolean {
  return e.op !== 'varref' && e.op !== 'param' && e.op !== 'constref' && e.op !== 'overrideref'
}

function collectTargets(
  body: readonly Stmt[],
  out: Map<Expr, { name: string; type: ShaderType }>,
  next: { n: number },
): void {
  for (const s of body) {
    if (s.s === 'assign' || s.s === 'assignOp') {
      const root = targetRoot(s.target)
      if (isMaterialisable(root) && !out.has(root))
        out.set(root, { name: `_av${next.n++}`, type: root.type })
    }
    // recurse nested bodies
    if (s.s === 'if') {
      for (const a of s.arms) collectTargets(a.body, out, next)
      if (s.elseBody) collectTargets(s.elseBody, out, next)
    } else if (s.s === 'for') {
      collectTargets(s.body, out, next)
    } else if (s.s === 'switch') {
      for (const c of s.cases) collectTargets(c.body, out, next)
      if (s.defaultBody) collectTargets(s.defaultBody, out, next)
    }
  }
}

/** True if `s`'s whole subtree references any of `targets` (by identity). */
function stmtRefs(s: Stmt, targets: ReadonlySet<Expr>): boolean {
  let hit = false
  const scan = (e: Expr): void => {
    eachExpr(e, (x) => {
      if (targets.has(x)) hit = true
    })
  }
  const walk = (st: Stmt): void => {
    if (hit) return
    switch (st.s) {
      case 'let':
        scan(st.expr)
        break
      case 'var':
        if (st.init !== undefined) scan(st.init)
        break
      case 'assign':
      case 'assignOp':
        scan(st.target)
        scan(st.expr)
        break
      case 'return':
        if (st.expr !== undefined) scan(st.expr)
        break
      case 'if':
        for (const a of st.arms) {
          scan(a.cond)
          a.body.forEach(walk)
        }
        st.elseBody?.forEach(walk)
        break
      case 'for':
        walk(st.init)
        scan(st.cond)
        walk(st.update)
        st.body.forEach(walk)
        break
      case 'switch':
        scan(st.scrut)
        for (const c of st.cases) c.body.forEach(walk)
        st.defaultBody?.forEach(walk)
        break
      default:
        break
    }
  }
  walk(s)
  return hit
}

function autoVarsFn(f: FuncDecl): FuncDecl {
  const targets = new Map<Expr, { name: string; type: ShaderType }>()
  collectTargets(f.body, targets, { n: 0 })
  if (targets.size === 0) return f

  // Rewrite every occurrence of a target Expr (by identity) to its varref; recurse otherwise.
  const rewrite = (e: Expr): Expr => {
    const av = targets.get(e)
    if (av !== undefined) return { op: 'varref', type: e.type, name: av.name }
    return mapChildren(e, rewrite)
  }

  const declared = new Set<Expr>()
  const targetList = [...targets.keys()]

  const processBlock = (body: readonly Stmt[]): Stmt[] => {
    const out: Stmt[] = []
    for (const s of body) {
      // Declare (just before its first-use stmt) any not-yet-declared target this stmt references.
      for (const t of targetList) {
        if (!declared.has(t) && stmtRefs(s, new Set([t]))) {
          declared.add(t)
          const av = targets.get(t)!
          // init = the target Expr itself (its children rewritten in case they reference earlier vars).
          out.push({ s: 'var', name: av.name, type: av.type, init: mapChildren(t, rewrite) })
        }
      }
      out.push(processStmt(s))
    }
    return out
  }

  const processStmt = (s: Stmt): Stmt => {
    switch (s.s) {
      case 'if':
        return {
          ...s,
          arms: s.arms.map((a) => ({ cond: rewrite(a.cond), body: processBlock(a.body) })),
          elseBody: s.elseBody ? processBlock(s.elseBody) : undefined,
        }
      case 'for':
        return {
          ...s,
          init: processStmt(s.init),
          cond: rewrite(s.cond),
          update: processStmt(s.update),
          body: processBlock(s.body),
        }
      case 'switch':
        return {
          ...s,
          scrut: rewrite(s.scrut),
          cases: s.cases.map((c) => ({ value: c.value, body: processBlock(c.body) })),
          defaultBody: s.defaultBody ? processBlock(s.defaultBody) : undefined,
        }
      default:
        return mapStmtTop(s, rewrite)
    }
  }

  return { ...f, body: processBlock(f.body) }
}

/** Materialise assigned plain-value bindings as WGSL vars (module → module). Pure. */
export function autoVars(m: ModuleDecl): ModuleDecl {
  return { ...m, funcs: m.funcs.map(autoVarsFn) }
}
