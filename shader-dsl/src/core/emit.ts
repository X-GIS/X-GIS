// ═══ Shader DSL — the neutral emit walk ═══
//
// ONE tree-walk over Expr / Stmt, shared by every backend. It is target-neutral:
// the only target-specific decisions are delegated to the Backend (type/literal/
// intrinsic spelling + the handful of divergent statement/declaration fragments
// in `backend.ts`). Backends provide those fragments; they do NOT re-implement
// the control-flow walk (no duplicated if/for/switch/return logic that can drift).

import type { Backend } from './backend'
import type { Expr, Stmt } from './ir'

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
