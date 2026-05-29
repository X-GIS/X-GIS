// ═══════════════════════════════════════════════════════════════════
// nodeToWgslString — Expr → WGSL string oracle
// ═══════════════════════════════════════════════════════════════════
//
// Compiler-side copy of `runtime/src/engine/shader-dsl/core/backends/wgsl.ts:emitExpr`.
// Relocated out of `_back-compat/` in PR 2e.B.2 when its last production
// consumer (the renderer polygon splice-point) retired: fill/stroke preambles
// now flow into the polygon composer as raw-WGSL Stmts, so the runtime no
// longer reconstructs the assign string via this adapter.
//
// It survives as the emit-shape equality ORACLE used across compiler + runtime
// tests (`v.fillExpr ? nodeToWgslString(v.fillExpr) : …`) — asserting the WGSL
// a Node lowers to. The round-trip test (`node-to-wgsl.test.ts`) pins it
// against the runtime emit.
//
// Implementation choice: self-contained `emit` copy rather than a
// cross-workspace import. The compiler/tsconfig.json has `rootDir: ./src`, so
// a relative import of the runtime wgsl.ts backend would push a runtime file
// into the compiler's TypeScript program (outside rootDir → tsc error).
// Adding `@xgis/runtime` as a compiler workspace dep would create a cycle.
//
// Drift risk: the copy diverges from `runtime/.../wgsl.ts:emitExpr` if either
// file changes. The round-trip test pins the boundary.

import type { Expr, ShaderType, NodeLike } from './node-types'

// ── emitExpr copy ──
//
// Verbatim copy of the runtime `wgsl.ts:emitExpr`. The matchExpr case throws —
// the runtime's pre-emit lowerModule pass owns matchExpr-to-Stmt.switch
// hoisting; if a matchExpr reaches THIS path, the caller forgot to wrap the
// Node in a fn body first.

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
    case 'matchExpr': throw new Error('compiler/node-to-wgsl: matchExpr is fn-body-only — wrap the Node in an fn before stringifying')
    case 'rawString': return e.value
  }
}

/**
 * Convert a DSL `Node`-shaped value (`{ expr: Expr }`) to its WGSL string
 * representation. Emit-shape equality oracle for compiler + runtime tests.
 */
export function nodeToWgslString(node: NodeLike): string {
  return emit(node.expr)
}
