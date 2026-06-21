// ═══ Shader DSL — module validation pass ═══
//
// A pre-emit static check over an AUTHORED ModuleDecl, run at the TOP of
// emitModule / emitGlslModule / compileModule (BEFORE lowerModule). It catches
// the structurally-invalid modules a composer / hand-author can produce —
// duplicate struct/func names, colliding (group,binding) slots, a mixed-scalar
// binop, and a non-void fn whose every path falls through without a return — and
// throws ValidationError so the failure surfaces at authoring time instead of as
// opaque WGSL the driver later rejects.
//
// SCOPE (the shipped spine): only the rules that PROVABLY hold for every shader —
// including the RUNTIME-composed variants — are implemented: dup-name (e), binding
// collision (d), all-paths-return (c), mixed-scalar binop (t). Name-resolution
// rules (varref/param scope, constref-resolves, callee-exists+arity, member-field)
// are DEFERRED: the compiler / composer prepend consts and uniforms (PI, OPACITY,
// …) as raw WGSL OUTSIDE m.consts / m.funcs and reference them by plain name, so a
// name rule cannot distinguish a valid injected name from a typo and false-flags
// real shaders (it once broke the polygon VT variant on `OPACITY` at runtime).
//
// HARD INVARIANTS: raw + placeholder Stmts are OPAQUE leaves (the polygon composer
// injects returns via a raw/placeholder swap, so a body containing one is treated
// as may-return); RULE t walks matchExpr (validate runs pre-lowerModule, so
// polygon's match chains are still matchExpr Exprs).

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

  for (const f of m.funcs) validateFn(f)
}

function validateFn(f: FuncDecl): void {
  // NOTE: the former function-local varref/param SCOPE-RESOLUTION rule (RULE a')
  // was REMOVED — it kept false-flagging live shaders. The compiler / composer
  // prepend consts and uniforms (PI, OPACITY, …) as raw WGSL OUTSIDE m.consts and
  // reference them by plain name in non-raw fn bodies; validate cannot distinguish
  // such a valid injected name from a typo'd local, so the rule was net-negative
  // (false-flagged `u`, `_mcSS`, `OPACITY` at runtime). The structurally-safe rules
  // — dup-name, binding-collision, all-paths-return, mixed-scalar — remain and hold
  // for every shader incl. the runtime-composed variants.

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
