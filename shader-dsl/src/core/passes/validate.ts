// ═══ Shader DSL — module validation pass ═══
//
// A pre-emit static check over an AUTHORED ModuleDecl, run at the TOP of
// emitModule / emitGlslModule / compileModule (BEFORE lowerModule). It catches
// the structurally-invalid modules a composer / hand-author can produce —
// duplicate struct/func names, colliding (group,binding) slots, an unresolved
// function-local name, and a non-void fn whose every path falls through without
// a return — and throws ValidationError so the failure surfaces at authoring
// time instead of as opaque WGSL the driver later rejects.
//
// SCOPE (the shipped spine): only the rules that PROVABLY hold for all 21 live
// shaders are implemented (a' scope / c return / d binding / e dup-name). The
// cross-module rules (constref-resolves, callee-exists+arity, member-field) are
// DEFERRED — the live shaders prepend their consts/helpers as raw WGSL outside
// m.consts / m.funcs, so those rules would false-flag every real shader. See the
// validate task design for the per-rule risk table.
//
// HARD INVARIANTS: raw + placeholder Stmts are OPAQUE leaves (the polygon
// composer injects returns via a raw/placeholder swap, so a body containing one
// is treated as may-return); constref names are SKIPPED (they resolve to
// prepended raw consts); the Expr walker handles matchExpr (validate runs
// pre-lowerModule, so polygon's match chains are still matchExpr Exprs).

import { typeKey } from '../ir'
import type { ModuleDecl, FuncDecl, Stmt, Expr, ShaderType } from '../ir'

export class ValidationError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ValidationError' }
}

/** Validate an authored module. Throws ValidationError on the first violation;
 *  returns silently for a valid module (and never mutates it — emit stays
 *  byte-identical). */
export function validate(m: ModuleDecl): void {
  // RULE e-struct — duplicate struct name.
  const structNames = new Set<string>()
  for (const s of m.structs) {
    if (structNames.has(s.name)) throw new ValidationError(`duplicate struct '${s.name}'`)
    structNames.add(s.name)
  }

  // RULE e-func — duplicate func name.
  const funcNames = new Set<string>()
  for (const f of m.funcs) {
    if (funcNames.has(f.name)) throw new ValidationError(`duplicate function '${f.name}'`)
    funcNames.add(f.name)
  }

  // RULE d — (group,binding) uniqueness (texture/sampler bindings occupy a slot too).
  const slots = new Map<string, string>()
  for (const b of m.bindings) {
    const key = `${b.group}:${b.binding}`
    const prev = slots.get(key)
    if (prev !== undefined) {
      throw new ValidationError(`binding collision @group(${b.group}) @binding(${b.binding}) — '${b.name}' vs '${prev}'`)
    }
    slots.set(key, b.name)
  }

  // Module bindings (uniform / storage / texture / sampler) are in scope in
  // EVERY function — seed them so a `varref` to a binding (e.g. `u.field(...)`,
  // `u` = `@group(0) @binding(0) var<uniform> u`) is not mis-flagged as an
  // unresolved local. (Raw-prepended consts/helpers are handled separately:
  // constref is skipped; raw/placeholder are opaque.)
  const bindingNames = new Set<string>(m.bindings.map((b) => b.name))
  for (const f of m.funcs) validateFn(f, bindingNames)
}

function validateFn(f: FuncDecl, bindingNames: ReadonlySet<string>): void {
  // RULE a' — function-local name resolution. Flat, lenient: every introduced
  // name (param / let / var / for-counter) is collected across ALL nested
  // bodies into ONE set, mirroring the oracle's one-flat-env-per-call reality
  // (oracle.ts evalExpr: a single `env` Map per fn call), plus the module-level
  // binding names (in scope everywhere). Then every leaf varref/param Expr must
  // resolve to a collected name.
  const declared = new Set<string>(bindingNames)
  for (const p of f.params) declared.add(p.name)
  for (const s of f.body) collectDeclared(s, declared)
  // RULE a' is SKIPPED for any fn whose body contains a raw Stmt: raw WGSL can
  // DECLARE names (the polygon composer injects `var _mcSS: vec4f = …` as a raw
  // preamble) that a structured sibling `varref` then references, and validate
  // cannot parse the raw string to learn those names. Same leniency as RULE c.
  if (!bodyContainsRaw(f.body)) {
    for (const s of f.body) checkStmtNames(s, declared, f.name)
  }

  // RULE c — a non-void fn must return on every path.
  if (f.ret.kind !== 'void' && !alwaysReturns(f.body)) {
    throw new ValidationError(`fn '${f.name}' returns non-void but a code path falls through without return`)
  }

  // RULE t — mixed-scalar binop (#5b). WGSL has no implicit int↔float (nor
  // i32↔u32) conversion, so a binop whose two operands are scalars of DIFFERENT
  // type is a driver compile error. Uses Expr.type only (never names), so it is
  // safe even for raw-containing fns. Shifts are exempt (their RHS is u32 by spec).
  for (const s of f.body) checkBinopScalars(s, f.name)
}

// ── RULE a' scope: pre-pass name collection ──

/** Collect every name a Stmt (and its nested bodies) introduces into `out`.
 *  raw / placeholder Stmts are opaque — they introduce nothing. */
function collectDeclared(s: Stmt, out: Set<string>): void {
  switch (s.s) {
    case 'let': out.add(s.name); break
    case 'var': out.add(s.name); break
    case 'if':
      for (const arm of s.arms) for (const b of arm.body) collectDeclared(b, out)
      if (s.elseBody) for (const b of s.elseBody) collectDeclared(b, out)
      break
    case 'for':
      // The init Stmt is a `var` introducing the loop counter.
      collectDeclared(s.init, out)
      for (const b of s.body) collectDeclared(b, out)
      break
    case 'switch':
      for (const c of s.cases) for (const b of c.body) collectDeclared(b, out)
      if (s.defaultBody) for (const b of s.defaultBody) collectDeclared(b, out)
      break
    // assign / assignOp / return / break / continue / discard / raw / placeholder
    // introduce no names (raw/placeholder are opaque leaves).
    default: break
  }
}

/** True iff any Stmt in `body` (recursively, through if/for/switch) is a raw
 *  WGSL Stmt — a fn with one may declare names validate cannot see. */
function bodyContainsRaw(body: readonly Stmt[]): boolean {
  for (const s of body) {
    if (s.s === 'raw') return true
    if (s.s === 'if') {
      if (s.arms.some((a) => bodyContainsRaw(a.body))) return true
      if (s.elseBody && bodyContainsRaw(s.elseBody)) return true
    } else if (s.s === 'for') {
      if (bodyContainsRaw(s.body)) return true
    } else if (s.s === 'switch') {
      if (s.cases.some((c) => bodyContainsRaw(c.body))) return true
      if (s.defaultBody && bodyContainsRaw(s.defaultBody)) return true
    }
  }
  return false
}

// ── RULE a' scope: leaf varref/param resolution ──

function checkStmtNames(s: Stmt, declared: Set<string>, fnName: string): void {
  switch (s.s) {
    case 'let': checkExprNames(s.expr, declared, fnName); break
    case 'var': if (s.init) checkExprNames(s.init, declared, fnName); break
    case 'assign':
      checkExprNames(s.target, declared, fnName)
      checkExprNames(s.expr, declared, fnName)
      break
    case 'assignOp':
      checkExprNames(s.target, declared, fnName)
      checkExprNames(s.expr, declared, fnName)
      break
    case 'if':
      for (const arm of s.arms) {
        checkExprNames(arm.cond, declared, fnName)
        for (const b of arm.body) checkStmtNames(b, declared, fnName)
      }
      if (s.elseBody) for (const b of s.elseBody) checkStmtNames(b, declared, fnName)
      break
    case 'return': if (s.expr) checkExprNames(s.expr, declared, fnName); break
    case 'for':
      checkStmtNames(s.init, declared, fnName)
      checkExprNames(s.cond, declared, fnName)
      checkStmtNames(s.update, declared, fnName)
      for (const b of s.body) checkStmtNames(b, declared, fnName)
      break
    case 'switch':
      checkExprNames(s.scrut, declared, fnName)
      for (const c of s.cases) for (const b of c.body) checkStmtNames(b, declared, fnName)
      if (s.defaultBody) for (const b of s.defaultBody) checkStmtNames(b, declared, fnName)
      break
    // break / continue / discard / raw / placeholder — opaque leaves, no Exprs to gate.
    default: break
  }
}

function checkExprNames(e: Expr, declared: Set<string>, fnName: string): void {
  switch (e.op) {
    case 'varref':
    case 'param':
      // The only gate-checked leaf. constref is deliberately NOT here — it
      // resolves to a prepended raw const outside m.consts.
      if (!declared.has(e.name)) {
        throw new ValidationError(`unresolved name '${e.name}' in fn '${fnName}'`)
      }
      break
    case 'lit':
    case 'constref':
      break
    case 'binop':
    case 'compare':
      checkExprNames(e.a, declared, fnName)
      checkExprNames(e.b, declared, fnName)
      break
    case 'logical':
      checkExprNames(e.a, declared, fnName)
      checkExprNames(e.b, declared, fnName)
      break
    case 'unop':
      checkExprNames(e.a, declared, fnName)
      break
    case 'call':
      for (const a of e.args) checkExprNames(a, declared, fnName)
      break
    case 'construct':
      for (const a of e.args) checkExprNames(a, declared, fnName)
      break
    case 'member':
      checkExprNames(e.base, declared, fnName)
      break
    case 'index':
      checkExprNames(e.base, declared, fnName)
      checkExprNames(e.idx, declared, fnName)
      break
    case 'select':
      checkExprNames(e.cond, declared, fnName)
      checkExprNames(e.ifTrue, declared, fnName)
      checkExprNames(e.ifFalse, declared, fnName)
      break
    case 'matchExpr':
      // validate runs BEFORE lowerModule, so polygon's match chains are still
      // matchExpr Exprs — visit scrutinee / case values / default.
      checkExprNames(e.scrutinee, declared, fnName)
      for (const [, v] of e.cases) checkExprNames(v, declared, fnName)
      checkExprNames(e.default, declared, fnName)
      break
  }
}

// ── RULE c: conservative all-paths-return analysis ──

/** True iff the LAST reachable Stmt of `body` guarantees an exit. Conservative:
 *  only return / discard, and an if/switch whose EVERY branch (incl. else /
 *  default) always returns, terminate. LENIENCY: a body containing a raw or
 *  placeholder Stmt anywhere is treated as may-return (true) — the polygon
 *  composer injects returns via a raw/placeholder swap, so fs_fill / fs_stroke
 *  must not be flagged pre-swap. */
function alwaysReturns(body: readonly Stmt[]): boolean {
  if (body.some((s) => s.s === 'raw' || s.s === 'placeholder')) return true
  if (body.length === 0) return false
  return stmtTerminates(body[body.length - 1])
}

function stmtTerminates(s: Stmt): boolean {
  switch (s.s) {
    case 'return': return true
    case 'discard': return true
    case 'if':
      return s.elseBody !== undefined
        && s.arms.every((arm) => alwaysReturns(arm.body))
        && alwaysReturns(s.elseBody)
    case 'switch':
      return s.defaultBody !== undefined
        && s.cases.every((c) => alwaysReturns(c.body))
        && alwaysReturns(s.defaultBody)
    default:
      // let / var / assign / assignOp / for / break / continue / raw / placeholder
      return false
  }
}

// ── RULE t: mixed-scalar binop type check (#5b) ──

// Shift ops are exempt — WGSL allows `i32 << u32` (the shift amount is u32 by spec).
const SHIFT_OPS = new Set(['<<', '>>'])

/** True iff a and b are scalars of DIFFERENT type (an implicit WGSL mix error). */
function mixedScalar(a: ShaderType, b: ShaderType): boolean {
  if (a.kind !== 'scalar' || b.kind !== 'scalar') return false
  if (a.scalar === 'bool' || b.scalar === 'bool') return false
  return a.scalar !== b.scalar
}

function checkExprBinops(e: Expr, fnName: string): void {
  if (e.op === 'binop' && !SHIFT_OPS.has(e.bop) && mixedScalar(e.a.type, e.b.type)) {
    throw new ValidationError(
      `mixed-scalar binop in fn '${fnName}': ${typeKey(e.a.type)} ${e.bop} ${typeKey(e.b.type)} — WGSL has no implicit int/float conversion`,
    )
  }
  switch (e.op) {
    case 'binop':
    case 'compare':
    case 'logical':
      checkExprBinops(e.a, fnName); checkExprBinops(e.b, fnName); break
    case 'unop':
      checkExprBinops(e.a, fnName); break
    case 'call':
    case 'construct':
      for (const a of e.args) checkExprBinops(a, fnName); break
    case 'member':
      checkExprBinops(e.base, fnName); break
    case 'index':
      checkExprBinops(e.base, fnName); checkExprBinops(e.idx, fnName); break
    case 'select':
      checkExprBinops(e.cond, fnName); checkExprBinops(e.ifTrue, fnName); checkExprBinops(e.ifFalse, fnName); break
    case 'matchExpr':
      checkExprBinops(e.scrutinee, fnName)
      for (const [, v] of e.cases) checkExprBinops(v, fnName)
      checkExprBinops(e.default, fnName); break
    default:
      break // lit / constref / param / varref
  }
}

function checkBinopScalars(s: Stmt, fnName: string): void {
  switch (s.s) {
    case 'let': checkExprBinops(s.expr, fnName); break
    case 'var': if (s.init) checkExprBinops(s.init, fnName); break
    case 'assign':
    case 'assignOp':
      checkExprBinops(s.target, fnName); checkExprBinops(s.expr, fnName); break
    case 'return': if (s.expr) checkExprBinops(s.expr, fnName); break
    case 'if':
      for (const arm of s.arms) {
        checkExprBinops(arm.cond, fnName)
        for (const b of arm.body) checkBinopScalars(b, fnName)
      }
      if (s.elseBody) for (const b of s.elseBody) checkBinopScalars(b, fnName)
      break
    case 'for':
      checkBinopScalars(s.init, fnName)
      checkExprBinops(s.cond, fnName)
      checkBinopScalars(s.update, fnName)
      for (const b of s.body) checkBinopScalars(b, fnName)
      break
    case 'switch':
      checkExprBinops(s.scrut, fnName)
      for (const c of s.cases) for (const b of c.body) checkBinopScalars(b, fnName)
      if (s.defaultBody) for (const b of s.defaultBody) checkBinopScalars(b, fnName)
      break
    default:
      break // break / continue / discard / raw / placeholder
  }
}
