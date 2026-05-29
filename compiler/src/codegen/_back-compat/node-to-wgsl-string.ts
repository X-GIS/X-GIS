// ═══════════════════════════════════════════════════════════════════
// nodeToWgslString — DSL Node → WGSL string adapter (TRANSIENT)
// ═══════════════════════════════════════════════════════════════════
//
// Compiler-side copy of `runtime/src/engine/shader-dsl/core/backends/wgsl.ts:emitExpr`.
// The runtime's polygon-composer splice-point (`renderer.ts:146,151`)
// reconstructs the `out.color = <expr-wgsl>;` assign string via this adapter
// so it can locate the assign and splice the (string) fill/stroke preamble
// before it. Both produce byte-identical WGSL for the same Expr.
//
// RETIRES with the splice-point (PR 2e.B.2 / US-011): once the compiler emits
// preambles as Stmt[] (or a raw-Stmt IR variant lands), the renderer feeds
// them to the composer directly and this file + the `_back-compat/` directory
// delete. The permanent `NodeLike` / `wgslRaw` / `Expr` vocabulary lives in
// `../node-types` (relocated in PR 2e.B.1) and survives that deletion.
//
// Implementation choice: self-contained `emit` copy rather than a
// cross-workspace import. The compiler/tsconfig.json has `rootDir: ./src`, so
// a relative import of the runtime wgsl.ts backend would push a runtime file
// into the compiler's TypeScript program (outside rootDir → tsc error).
// Adding `@xgis/runtime` as a compiler workspace dep would create a cycle.
//
// Drift risk: the copy diverges from `runtime/.../wgsl.ts:emitExpr` if either
// file changes. The round-trip test (`node-to-wgsl-string.test.ts`) pins the
// boundary.

import type { Expr, ShaderType, NodeLike } from '../node-types'

// ── emitExpr copy ──
//
// Verbatim copy of the runtime `wgsl.ts:emitExpr` at PR #150 main HEAD. The
// matchExpr case throws — the runtime's pre-emit lowerModule pass owns
// matchExpr-to-Stmt.switch hoisting; if a matchExpr reaches THIS path, the
// caller forgot to wrap the Node in a fn body first.

function f32Lit(v: number): string {
  if (Number.isInteger(v)) return `${v.toFixed(1)}`
  return `${v}`
}

function wgslType(t: ShaderType): string {
  switch (t.kind) {
    case 'scalar': return t.scalar
    case 'vec': return `vec${t.n}<${t.elem}>`
    case 'mat': return `mat${t.n}x${t.n}<${t.elem}>`
    case 'struct': return t.name
    case 'array': return t.size !== undefined ? `array<${wgslType(t.elem)},${t.size}>` : `array<${wgslType(t.elem)}>`
    case 'texture': return `texture_${t.dim}<${t.elem}>`
    case 'sampler': return 'sampler'
    case 'void': return 'void'
  }
}

function lit(value: number | boolean, t: ShaderType): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (t.kind === 'scalar' && t.scalar === 'u32') return `${value}u`
  if (t.kind === 'scalar' && t.scalar === 'i32') return `${value}`
  return f32Lit(value)
}

function emit(e: Expr): string {
  switch (e.op) {
    case 'lit': return lit(e.value, e.type)
    case 'constref':
    case 'param':
    case 'varref': return e.name
    case 'binop': return `(${emit(e.a)} ${e.bop} ${emit(e.b)})`
    case 'unop': return `(-${emit(e.a)})`
    case 'compare': return `(${emit(e.a)} ${e.cop} ${emit(e.b)})`
    case 'logical': return `(${emit(e.a)} ${e.lop} ${emit(e.b)})`
    case 'call': return `${e.fn}(${e.args.map(emit).join(', ')})`
    case 'member': return `${emit(e.base)}.${e.field}`
    case 'construct': return `${wgslType(e.type)}(${e.args.map(emit).join(', ')})`
    case 'select': return `select(${emit(e.ifFalse)}, ${emit(e.ifTrue)}, ${emit(e.cond)})`
    case 'index': return `${emit(e.base)}[${emit(e.idx)}]`
    case 'matchExpr': throw new Error('compiler/back-compat: matchExpr is fn-body-only — wrap the Node in an fn before stringifying')
    case 'rawString': return e.value
  }
}

/**
 * Convert a DSL `Node`-shaped value (`{ expr: Expr }`) to its WGSL string
 * representation. The renderer splice-point's string-lookup oracle; retires
 * in PR 2e.B.2 with the splice-point itself.
 */
export function nodeToWgslString(node: NodeLike): string {
  return emit(node.expr)
}
