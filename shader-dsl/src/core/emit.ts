// ═══ Shader DSL — the neutral emit walk ═══
//
// ONE tree-walk over Expr / Stmt, shared by every backend. It is target-neutral:
// the only target-specific decisions are delegated to the Backend (type/literal/
// intrinsic spelling + the handful of divergent statement/declaration fragments
// in `backend.ts`). Backends provide those fragments; they do NOT re-implement
// the control-flow walk (no duplicated if/for/switch/return logic that can drift).

import type { Backend } from './backend'
import type { Expr, Stmt, ModuleDecl } from './ir'
import { validate } from './passes/validate'
import { assertCaps } from './passes/required-caps'
import { lowerModule } from './passes/match-lower'
import { autoVars } from './passes/opt'

const pad = (depth: number): string => '  '.repeat(depth)

export function emitExpr(e: Expr, be: Backend): string {
  const r = (x: Expr) => emitExpr(x, be)
  switch (e.op) {
    case 'lit': return be.literal(e.value, e.type)
    case 'constref':
    case 'param':
    case 'varref': return e.name
    case 'binop': return `(${r(e.a)} ${e.bop} ${r(e.b)})`
    case 'unop': return `(-${r(e.a)})`
    case 'compare': return `(${r(e.a)} ${e.cop} ${r(e.b)})`
    case 'logical': return `(${r(e.a)} ${e.lop} ${r(e.b)})`
    case 'call': return be.intrinsic(e.fn, e.args.map(r))
    case 'member': return `${r(e.base)}.${e.field}`
    case 'construct': return `${be.typeName(e.type)}(${e.args.map(r).join(', ')})`
    // select(false, true, cond) — the writer owns the spelling (WGSL select() vs
    // GLSL ternary). Args passed in WGSL's (false, true, cond) order.
    case 'select': return be.intrinsic('select', [r(e.ifFalse), r(e.ifTrue), r(e.cond)])
    case 'index': return `${r(e.base)}[${r(e.idx)}]`
    // matchExpr is consumed by the neutral pre-emit pass (passes/match-lower.ts)
    // before emit. If one leaks through, that pass was bypassed — fail loudly.
    case 'matchExpr': throw new Error('shader-dsl: matchExpr Expr leaked into emitExpr — lowerModule should have hoisted it')
  }
}

export function emitStmt(s: Stmt, depth: number, be: Backend): string {
  const p = pad(depth)
  const r = (x: Expr) => emitExpr(x, be)
  switch (s.s) {
    case 'let': return `${p}${be.localLet(s.name, s.expr.type, r(s.expr))};`
    case 'var': return `${p}${be.localVar(s.name, s.type, s.init !== undefined ? r(s.init) : undefined)};`
    case 'assign': return `${p}${r(s.target)} = ${r(s.expr)};`
    case 'assignOp': return `${p}${r(s.target)} ${s.bop}= ${r(s.expr)};`
    case 'return': return s.expr !== undefined ? `${p}return ${r(s.expr)};` : `${p}return;`
    case 'break': return `${p}break;`
    case 'continue': return `${p}continue;`
    case 'discard': return `${p}discard;`
    case 'if': {
      const lines: string[] = []
      s.arms.forEach((arm, i) => {
        lines.push(`${i === 0 ? `${p}if` : `${p}} else if`} (${r(arm.cond)}) {`)
        lines.push(emitBody(arm.body, depth + 1, be))
      })
      if (s.elseBody) { lines.push(`${p}} else {`); lines.push(emitBody(s.elseBody, depth + 1, be)) }
      lines.push(`${p}}`)
      return lines.filter((l) => l.length > 0).join('\n')
    }
    case 'for': {
      const init = forHeader(s.init, be)
      const update = forHeader(s.update, be)
      return `${p}for (${init}; ${r(s.cond)}; ${update}) {\n${emitBody(s.body, depth + 1, be)}\n${p}}`
    }
    case 'placeholder': return `${p}${be.placeholderStmt(s.tag)}`
    case 'raw': return `${p}${be.rawStmt(s.wgsl)}`
    case 'switch': {
      const lines: string[] = [`${p}${be.switchHead(r(s.scrut))}`]
      for (const c of s.cases) {
        lines.push(`${pad(depth + 1)}case ${be.caseLabel(c.value, s.scrut.type)}: {`)
        lines.push(emitBody(c.body, depth + 2, be))
        lines.push(`${pad(depth + 1)}}`)
      }
      lines.push(`${pad(depth + 1)}default: {`)
      if (s.defaultBody) lines.push(emitBody(s.defaultBody, depth + 2, be))
      lines.push(`${pad(depth + 1)}}`)
      lines.push(`${p}}`)
      return lines.join('\n')
    }
  }
}

export function emitBody(body: readonly Stmt[], depth: number, be: Backend): string {
  return body.map((s) => emitStmt(s, depth, be)).join('\n')
}

// For-loop header init/update: a var/assign WITHOUT trailing `;` or indentation.
export function forHeader(s: Stmt, be: Backend): string {
  const r = (x: Expr) => emitExpr(x, be)
  if (s.s === 'var') return s.init !== undefined ? be.localVar(s.name, s.type, r(s.init)) : be.localVar(s.name, s.type)
  if (s.s === 'assign') return `${r(s.target)} = ${r(s.expr)}`
  if (s.s === 'assignOp') return `${r(s.target)} ${s.bop}= ${r(s.expr)}`
  throw new Error(`shader-dsl: bad for-header stmt ${s.s}`)
}

// ── Module-level emit (shared driver) ──
// The module assembly pipeline, parameterised by the Backend, lives here ONCE so a
// new backend does not copy it. Per-target spelling (const/struct/binding/func) and
// the emit-time optimisation (`optimize`: WGSL = cse, GLSL = identity) are delegated
// to the Backend; the validate → assertCaps → autoVars → lowerModule → optimize
// preamble is identical for every target.

/** Run the authored module through the shared pre-emit pipeline for a backend:
 *  validate the AUTHORED shape, fail-closed on unsupported caps, then
 *  `optimize(lowerModule(autoVars(m)))`. Returns the lowered module ready for
 *  per-declaration spelling. (autoVars BEFORE lowerModule — var materialisation is
 *  backend-neutral; cse runs only inside the WGSL backend's `optimize`.) */
export function lowerForBackend(m: ModuleDecl, be: Backend): ModuleDecl {
  // Validate the AUTHORED module before any lowering (the rules reason about the
  // pre-lower shape — e.g. matchExpr chains, placeholder swap sites).
  validate(m)
  assertCaps(be, m) // principled fail-closed gate
  // matchExpr→{var slot, Stmt.switch} lowering first so the rest of the emitter stays
  // matchExpr-unaware (identity for modules with no matchExpr); auto-cache (cse, in the
  // WGSL backend's optimize) then hoists any input-only subexpression reused ≥2x into one
  // shared `let`, so authors write plain inline expressions and the reuse is bound for them.
  return be.optimize(lowerModule(autoVars(m)))
}

/** Emit a ModuleDecl to a target string: shared preamble (`lowerForBackend`) then the
 *  declaration assembly (consts → structs → bindings → funcs, only non-empty sections),
 *  joined `\n\n` with a trailing newline. Each backend's public module entry
 *  (`emitModule` for WGSL) routes through here, so the assembly lives once. */
export function emitModule(m: ModuleDecl, be: Backend): string {
  const lowered = lowerForBackend(m, be)
  const parts: string[] = []
  if (lowered.consts.length) parts.push(lowered.consts.map((c) => be.emitConst(c)).join('\n'))
  if (lowered.structs.length) parts.push(lowered.structs.map((s) => be.emitStruct(s)).join('\n\n'))
  if (lowered.bindings.length) parts.push(lowered.bindings.map((b) => be.emitBinding(b)).join('\n'))
  if (lowered.funcs.length) parts.push(lowered.funcs.map((f) => be.emitFunc(f)).join('\n\n'))
  return parts.join('\n\n') + '\n'
}
