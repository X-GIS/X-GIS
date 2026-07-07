// ═══ Shader DSL — IR reference collector (the walk SoT) ═══
//
// Collects, from a FuncDecl, every NAME its emitted text can reference:
//   • calls   — `call` Expr ids (module fns AND builtins/intrinsics)
//   • vars    — `varref` names. Module BINDING references are varrefs
//               (node.ts bindingRef), so this set decides which bindings a
//               function's body touches; locals in the set only over-keep.
//   • structs — struct type names spelled anywhere text is emitted from a
//               type: the signature, `var` decls, and every Expr's `type`
//               (a `let` of struct type spells `Name _v0 = …` in GLSL).
//
// Consumers: passes/opt/dce-fns (whole-module fn tree-shaking, calls only) and
// the GLSL backend's per-stage emit scope (all three sets). ONE exhaustive
// switch so a future Expr/Stmt op cannot be handled by one consumer's private
// walker and silently missed by the other's.

import type { Expr, Stmt, FuncDecl } from './nodes'
import type { ShaderType } from './types'

export interface RefSet {
  readonly calls: Set<string>
  readonly vars: Set<string>
  readonly structs: Set<string>
}

export const emptyRefSet = (): RefSet => ({
  calls: new Set(),
  vars: new Set(),
  structs: new Set(),
})

/** Struct names reachable from a TYPE (recurses array elements). */
export function typeStructNames(t: ShaderType, out: Set<string>): void {
  if (t.kind === 'struct') out.add(t.name)
  else if (t.kind === 'array') typeStructNames(t.elem, out)
}

function collectExpr(e: Expr, out: RefSet): void {
  typeStructNames(e.type, out.structs)
  switch (e.op) {
    case 'call':
      out.calls.add(e.fn)
      for (const a of e.args) collectExpr(a, out)
      break
    case 'construct':
      for (const a of e.args) collectExpr(a, out)
      break
    case 'binop':
    case 'compare':
    case 'logical':
      collectExpr(e.a, out)
      collectExpr(e.b, out)
      break
    case 'unop':
      collectExpr(e.a, out)
      break
    case 'member':
      collectExpr(e.base, out)
      break
    case 'index':
      collectExpr(e.base, out)
      collectExpr(e.idx, out)
      break
    case 'select':
      collectExpr(e.cond, out)
      collectExpr(e.ifTrue, out)
      collectExpr(e.ifFalse, out)
      break
    case 'matchExpr':
      collectExpr(e.scrutinee, out)
      for (const [, v] of e.cases) collectExpr(v, out)
      collectExpr(e.default, out)
      break
    case 'varref':
      out.vars.add(e.name)
      break
    default:
      break // lit / constref / param — no nested refs
  }
}

function collectStmt(s: Stmt, out: RefSet): void {
  switch (s.s) {
    case 'let':
      collectExpr(s.expr, out)
      break
    case 'var':
      typeStructNames(s.type, out.structs)
      if (s.init !== undefined) collectExpr(s.init, out)
      break
    case 'assign':
    case 'assignOp':
      collectExpr(s.target, out)
      collectExpr(s.expr, out)
      break
    case 'return':
      if (s.expr !== undefined) collectExpr(s.expr, out)
      break
    case 'if':
      for (const arm of s.arms) {
        collectExpr(arm.cond, out)
        for (const b of arm.body) collectStmt(b, out)
      }
      if (s.elseBody) for (const b of s.elseBody) collectStmt(b, out)
      break
    case 'for':
      collectStmt(s.init, out)
      collectExpr(s.cond, out)
      collectStmt(s.update, out)
      for (const b of s.body) collectStmt(b, out)
      break
    case 'switch':
      collectExpr(s.scrut, out)
      for (const c of s.cases) for (const b of c.body) collectStmt(b, out)
      if (s.defaultBody) for (const b of s.defaultBody) collectStmt(b, out)
      break
    default:
      break // break / continue / discard / placeholder / raw — no Expr to walk
  }
}

/** Collect every call id / varref name / struct type name referenced by `f`
 *  (signature + body), accumulating into `out` when given. NOTE: a `raw` Stmt
 *  is invisible to this walk — callers that need soundness in its presence
 *  must bail (see dce-fns / the GLSL stage scope). */
export function collectFnRefs(f: FuncDecl, out: RefSet = emptyRefSet()): RefSet {
  for (const p of f.params) typeStructNames(p.type, out.structs)
  typeStructNames(f.ret, out.structs)
  for (const s of f.body) collectStmt(s, out)
  return out
}
