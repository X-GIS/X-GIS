// ═══ Shader DSL — WGSL backend ═══
//
// Lowers a ModuleDecl (or individual funcs) to a WGSL string for
// device.createShaderModule. Binops are fully parenthesised — byte-identity
// with the hand-written shader is NOT a goal (the plan permits big-bang,
// behaviour-equivalent emission); correctness is gated by the executed-WGSL
// parity spec + the render-gate.
//
// S1: the emit driver is now backend-parameterised. The `*For(x, backend)`
// functions take a Backend for TYPE + LITERAL spelling; the single-arg exports
// (`emitExpr`/`emitConst`/… — used in `.map(...)` by the shaders) are thin
// WGSL-bound wrappers, so WGSL output stays byte-identical. Intrinsic/call and
// IO/attribute spelling remain WGSL-inline here until later steps abstract them.

import type {
  ShaderType, Expr, Stmt, ConstDecl, StructDecl, BindingDecl, FuncDecl, ModuleDecl,
} from '../ir'
import { Capabilities, type Backend } from '../backend'

export function wgslType(t: ShaderType): string {
  switch (t.kind) {
    case 'scalar': return t.scalar
    case 'vec': return `vec${t.n}<${t.elem}>`
    case 'mat': return `mat${t.n}x${t.n}<${t.elem}>`
    case 'struct': return t.name
    case 'array': return t.size !== undefined ? `array<${wgslType(t.elem)}, ${t.size}>` : `array<${wgslType(t.elem)}>`
    case 'texture': return t.dim === '2d-ms' ? `texture_multisampled_2d<${t.elem}>` : `texture_${t.dim}<${t.elem}>`
    case 'sampler': return 'sampler'
    case 'void': return 'void'
  }
}

/** A WGSL/GLSL-shared f32 literal: append `.0` to an integer-looking value so a
 *  float context never sees an int literal. Reused by the GLSL writer. */
export function f32Lit(v: number): string {
  const s = String(v)
  return /[.eE]/.test(s) ? s : `${s}.0`
}

function lit(value: number | boolean, t: ShaderType): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (t.kind === 'scalar' && t.scalar === 'u32') return `${value}u`
  if (t.kind === 'scalar' && t.scalar === 'i32') return `${value}`
  return f32Lit(value)
}

/** The WGSL target writer. typeName/literal reproduce wgslType/lit exactly, so
 *  any emit driven by wgslBackend is byte-identical to the pre-S1 output. */
export const wgslBackend: Backend = {
  id: 'wgsl',
  caps: new Capabilities(new Set(['storageBuffer', 'compute', 'msaaTextureLoad'])),
  typeName: wgslType,
  literal: lit,
  // WGSL spells every intrinsic / user call as `name(args)` — byte-identical to
  // the pre-S2 `call` emit. The reserved `'select'` id is WGSL's
  // select(falseVal, trueVal, cond); the caller passes the args in that order.
  intrinsic: (name, args) => `${name}(${args.join(', ')})`,
}

// Canonical Expr → WGSL emit. The compiler keeps a structural copy
// (compiler/src/codegen/node-to-wgsl.ts:nodeToWgslString) pinned against this
// as a test oracle; this export is also useful for match-expr.test.ts's
// defensive-throw probe.
// Expr emit is target-neutral except for the spelling the backend owns
// (typeName for `construct`, literal for `lit`, intrinsic for `call`/`select`).
// Exported so other writers (glsl) reuse it rather than duplicate the tree walk.
export function emitExprFor(e: Expr, be: Backend): string {
  const r = (x: Expr) => emitExprFor(x, be)
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
    // select(falseVal, trueVal, cond) — the writer owns the spelling (WGSL
    // select() vs GLSL ternary). Args passed in WGSL's (false, true, cond) order.
    case 'select': return be.intrinsic('select', [r(e.ifFalse), r(e.ifTrue), r(e.cond)])
    case 'index': return `${r(e.base)}[${r(e.idx)}]`
    // matchExpr is consumed by the neutral pre-emit pass (passes/match-lower.ts) before
    // emitModule reaches emitExpr. If one leaks through, the pre-emit
    // pass was bypassed — fail loudly rather than emit garbage WGSL.
    case 'matchExpr': throw new Error('shader-dsl/wgsl: matchExpr Expr leaked into emitExpr — lowerModule should have hoisted it')
  }
}
export const emitExpr = (e: Expr): string => emitExprFor(e, wgslBackend)

const pad = (depth: number): string => '  '.repeat(depth)

function emitStmtFor(s: Stmt, depth: number, be: Backend): string {
  const p = pad(depth)
  const r = (x: Expr) => emitExprFor(x, be)
  switch (s.s) {
    case 'let': return `${p}let ${s.name} = ${r(s.expr)};`
    case 'var':
      return s.init !== undefined
        ? `${p}var ${s.name}: ${be.typeName(s.type)} = ${r(s.init)};`
        : `${p}var ${s.name}: ${be.typeName(s.type)};`
    case 'assign': return `${p}${r(s.target)} = ${r(s.expr)};`
    case 'assignOp': return `${p}${r(s.target)} ${s.bop}= ${r(s.expr)};`
    case 'return': return s.expr !== undefined ? `${p}return ${r(s.expr)};` : `${p}return;`
    case 'break': return `${p}break;`
    case 'continue': return `${p}continue;`
    case 'discard': return `${p}discard;`
    case 'if': {
      const lines: string[] = []
      s.arms.forEach((arm, i) => {
        const head = i === 0 ? `${p}if` : `${p}} else if`
        lines.push(`${head} (${r(arm.cond)}) {`)
        lines.push(emitBodyFor(arm.body, depth + 1, be))
      })
      if (s.elseBody) {
        lines.push(`${p}} else {`)
        lines.push(emitBodyFor(s.elseBody, depth + 1, be))
      }
      lines.push(`${p}}`)
      return lines.filter((l) => l.length > 0).join('\n')
    }
    case 'for': {
      const init = forHeaderFor(s.init, be)
      const update = forHeaderFor(s.update, be)
      return `${p}for (${init}; ${r(s.cond)}; ${update}) {\n${emitBodyFor(s.body, depth + 1, be)}\n${p}}`
    }
    case 'placeholder': {
      // Phase 2.5 US-007 — emit a defensive WGSL comment if a
      // placeholder Stmt leaks past the polygon composer. Comments
      // are no-ops, so the WGSL still parses; the missing return
      // surfaces as a runtime no-op which is easier to localise
      // than a parser failure mid-shader.
      return `${p}// __placeholder: ${s.tag}`
    }
    // Phase 2 PR 2e.B.2 — raw WGSL passthrough. The first line gets the
    // enclosing body indent `p`; internal lines keep their own formatting.
    // This reproduces the renderer's former splice byte-for-byte (which
    // inserted the preamble string at the assign's original indent).
    case 'raw': return `${p}${s.wgsl}`
    case 'switch': {
      const lines: string[] = [`${p}switch ${r(s.scrut)} {`]
      for (const c of s.cases) {
        lines.push(`${pad(depth + 1)}case ${caseLabel(c.value, s.scrut)}: {`)
        lines.push(emitBodyFor(c.body, depth + 2, be))
        lines.push(`${pad(depth + 1)}}`)
      }
      lines.push(`${pad(depth + 1)}default: {`)
      if (s.defaultBody) lines.push(emitBodyFor(s.defaultBody, depth + 2, be))
      lines.push(`${pad(depth + 1)}}`)
      lines.push(`${p}}`)
      return lines.join('\n')
    }
  }
}

function caseLabel(value: number, scrut: Expr): string {
  return scrut.type.kind === 'scalar' && scrut.type.scalar === 'u32' ? `${value}u` : `${value}`
}

// For-loop header init/update: emit a var/assign WITHOUT trailing semicolon
// or indentation.
function forHeaderFor(s: Stmt, be: Backend): string {
  const r = (x: Expr) => emitExprFor(x, be)
  if (s.s === 'var') {
    return s.init !== undefined
      ? `var ${s.name}: ${be.typeName(s.type)} = ${r(s.init)}`
      : `var ${s.name}: ${be.typeName(s.type)}`
  }
  if (s.s === 'assign') return `${r(s.target)} = ${r(s.expr)}`
  if (s.s === 'assignOp') return `${r(s.target)} ${s.bop}= ${r(s.expr)}`
  throw new Error(`shader-dsl/wgsl: bad for-header stmt ${s.s}`)
}

function emitBodyFor(body: readonly Stmt[], depth: number, be: Backend): string {
  return body.map((s) => emitStmtFor(s, depth, be)).join('\n')
}

// const emit is WGSL-declaration-specific (`const name: T = v;`) and does not
// consult the backend — GLSL has its own `const T name = v;` form in glsl.ts.
export function emitConst(c: ConstDecl): string {
  return `const ${c.name}: ${wgslType(c.type)} = ${f32Lit(c.wgslValue)};`
}

function emitStructFor(s: StructDecl, be: Backend): string {
  const fields = s.fields.map((f) => `  ${f.attr ? `${f.attr} ` : ''}${f.name}: ${be.typeName(f.type)},`).join('\n')
  return `struct ${s.name} {\n${fields}\n}`
}
export const emitStruct = (s: StructDecl): string => emitStructFor(s, wgslBackend)

function emitBindingFor(b: BindingDecl, be: Backend): string {
  // texture / sampler are handle types — no address space (`var x: T;`).
  if (b.type.kind === 'texture' || b.type.kind === 'sampler') {
    return `@group(${b.group}) @binding(${b.binding}) var ${b.name}: ${be.typeName(b.type)};`
  }
  const space = b.space === 'storage' ? `storage, ${b.access ?? 'read'}` : 'uniform'
  return `@group(${b.group}) @binding(${b.binding}) var<${space}> ${b.name}: ${be.typeName(b.type)};`
}
export const emitBinding = (b: BindingDecl): string => emitBindingFor(b, wgslBackend)

function paramAttr(p: { builtin?: string; location?: number }): string {
  if (p.builtin) return `@builtin(${p.builtin}) `
  if (p.location !== undefined) return `@location(${p.location}) `
  return ''
}

function emitFuncFor(f: FuncDecl, be: Backend): string {
  const params = f.params.map((p) => `${paramAttr(p)}${p.name}: ${be.typeName(p.type)}`).join(', ')
  const ret = f.ret.kind === 'void' ? '' : ` -> ${f.retAttr ? `${f.retAttr} ` : ''}${be.typeName(f.ret)}`
  const attrs = f.attrs && f.attrs.length ? `${f.attrs.join(' ')}\n` : ''
  return `${attrs}fn ${f.name}(${params})${ret} {\n${emitBodyFor(f.body, 1, be)}\n}`
}
export const emitFunc = (f: FuncDecl): string => emitFuncFor(f, wgslBackend)

// matchExpr lowering pre-emit pass (Phase 2.5 US-001).
// Kept as a side-import so emitModule's body stays compact.
import { lowerModule } from '../passes/match-lower'

export function emitModule(m: ModuleDecl, be: Backend = wgslBackend): string {
  // Phase 2.5 US-001: run the matchExpr→{var slot, Stmt.switch} lowering
  // pass first so the rest of the emitter stays matchExpr-unaware. The
  // pass is an identity for any module that contains no matchExpr.
  const lowered = lowerModule(m)
  const parts: string[] = []
  if (lowered.consts.length) parts.push(lowered.consts.map(emitConst).join('\n'))
  if (lowered.structs.length) parts.push(lowered.structs.map((s) => emitStructFor(s, be)).join('\n\n'))
  if (lowered.bindings.length) parts.push(lowered.bindings.map((b) => emitBindingFor(b, be)).join('\n'))
  if (lowered.funcs.length) parts.push(lowered.funcs.map((f) => emitFuncFor(f, be)).join('\n\n'))
  return parts.join('\n\n') + '\n'
}
