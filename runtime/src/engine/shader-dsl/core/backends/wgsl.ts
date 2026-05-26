// ═══ Shader DSL — WGSL backend ═══
//
// Lowers a ModuleDecl (or individual funcs) to a WGSL string for
// device.createShaderModule. Binops are fully parenthesised — byte-identity
// with the hand-written shader is NOT a goal (the plan permits big-bang,
// behaviour-equivalent emission); correctness is gated by the executed-WGSL
// parity spec + the render-gate.

import type {
  ShaderType, Expr, Stmt, ConstDecl, StructDecl, BindingDecl, FuncDecl, ModuleDecl,
} from '../ir'

export function wgslType(t: ShaderType): string {
  switch (t.kind) {
    case 'scalar': return t.scalar
    case 'vec': return `vec${t.n}<${t.elem}>`
    case 'mat': return `mat${t.n}x${t.n}<${t.elem}>`
    case 'struct': return t.name
    case 'array': return t.size !== undefined ? `array<${wgslType(t.elem)}, ${t.size}>` : `array<${wgslType(t.elem)}>`
    case 'texture': return `texture_${t.dim}<${t.elem}>`
    case 'sampler': return 'sampler'
    case 'void': return 'void'
  }
}

function f32Lit(v: number): string {
  const s = String(v)
  return /[.eE]/.test(s) ? s : `${s}.0`
}

function lit(value: number | boolean, t: ShaderType): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (t.kind === 'scalar' && t.scalar === 'u32') return `${value}u`
  if (t.kind === 'scalar' && t.scalar === 'i32') return `${value}`
  return f32Lit(value)
}

function emitExpr(e: Expr): string {
  switch (e.op) {
    case 'lit': return lit(e.value, e.type)
    case 'constref':
    case 'param':
    case 'varref': return e.name
    case 'binop': return `(${emitExpr(e.a)} ${e.bop} ${emitExpr(e.b)})`
    case 'unop': return `(-${emitExpr(e.a)})`
    case 'compare': return `(${emitExpr(e.a)} ${e.cop} ${emitExpr(e.b)})`
    case 'logical': return `(${emitExpr(e.a)} ${e.lop} ${emitExpr(e.b)})`
    case 'call': return `${e.fn}(${e.args.map(emitExpr).join(', ')})`
    case 'member': return `${emitExpr(e.base)}.${e.field}`
    case 'construct': return `${wgslType(e.type)}(${e.args.map(emitExpr).join(', ')})`
    // WGSL select(falseVal, trueVal, cond)
    case 'select': return `select(${emitExpr(e.ifFalse)}, ${emitExpr(e.ifTrue)}, ${emitExpr(e.cond)})`
    case 'index': return `${emitExpr(e.base)}[${emitExpr(e.idx)}]`
  }
}

const pad = (depth: number): string => '  '.repeat(depth)

function emitStmt(s: Stmt, depth: number): string {
  const p = pad(depth)
  switch (s.s) {
    case 'let': return `${p}let ${s.name} = ${emitExpr(s.expr)};`
    case 'var':
      return s.init !== undefined
        ? `${p}var ${s.name}: ${wgslType(s.type)} = ${emitExpr(s.init)};`
        : `${p}var ${s.name}: ${wgslType(s.type)};`
    case 'assign': return `${p}${emitExpr(s.target)} = ${emitExpr(s.expr)};`
    case 'assignOp': return `${p}${emitExpr(s.target)} ${s.bop}= ${emitExpr(s.expr)};`
    case 'return': return s.expr !== undefined ? `${p}return ${emitExpr(s.expr)};` : `${p}return;`
    case 'break': return `${p}break;`
    case 'continue': return `${p}continue;`
    case 'discard': return `${p}discard;`
    case 'if': {
      const lines: string[] = []
      s.arms.forEach((arm, i) => {
        const head = i === 0 ? `${p}if` : `${p}} else if`
        lines.push(`${head} (${emitExpr(arm.cond)}) {`)
        lines.push(emitBody(arm.body, depth + 1))
      })
      if (s.elseBody) {
        lines.push(`${p}} else {`)
        lines.push(emitBody(s.elseBody, depth + 1))
      }
      lines.push(`${p}}`)
      return lines.filter((l) => l.length > 0).join('\n')
    }
    case 'for': {
      const init = forHeader(s.init)
      const update = forHeader(s.update)
      return `${p}for (${init}; ${emitExpr(s.cond)}; ${update}) {\n${emitBody(s.body, depth + 1)}\n${p}}`
    }
    case 'switch': {
      const lines: string[] = [`${p}switch ${emitExpr(s.scrut)} {`]
      for (const c of s.cases) {
        lines.push(`${pad(depth + 1)}case ${caseLabel(c.value, s.scrut)}: {`)
        lines.push(emitBody(c.body, depth + 2))
        lines.push(`${pad(depth + 1)}}`)
      }
      lines.push(`${pad(depth + 1)}default: {`)
      if (s.defaultBody) lines.push(emitBody(s.defaultBody, depth + 2))
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
function forHeader(s: Stmt): string {
  if (s.s === 'var') {
    return s.init !== undefined
      ? `var ${s.name}: ${wgslType(s.type)} = ${emitExpr(s.init)}`
      : `var ${s.name}: ${wgslType(s.type)}`
  }
  if (s.s === 'assign') return `${emitExpr(s.target)} = ${emitExpr(s.expr)}`
  if (s.s === 'assignOp') return `${emitExpr(s.target)} ${s.bop}= ${emitExpr(s.expr)}`
  throw new Error(`shader-dsl/wgsl: bad for-header stmt ${s.s}`)
}

function emitBody(body: readonly Stmt[], depth: number): string {
  return body.map((s) => emitStmt(s, depth)).join('\n')
}

export function emitConst(c: ConstDecl): string {
  return `const ${c.name}: ${wgslType(c.type)} = ${f32Lit(c.wgslValue)};`
}

export function emitStruct(s: StructDecl): string {
  const fields = s.fields.map((f) => `  ${f.attr ? `${f.attr} ` : ''}${f.name}: ${wgslType(f.type)},`).join('\n')
  return `struct ${s.name} {\n${fields}\n}`
}

export function emitBinding(b: BindingDecl): string {
  // texture / sampler are handle types — no address space (`var x: T;`).
  if (b.type.kind === 'texture' || b.type.kind === 'sampler') {
    return `@group(${b.group}) @binding(${b.binding}) var ${b.name}: ${wgslType(b.type)};`
  }
  const space = b.space === 'storage' ? `storage, ${b.access ?? 'read'}` : 'uniform'
  return `@group(${b.group}) @binding(${b.binding}) var<${space}> ${b.name}: ${wgslType(b.type)};`
}

function paramAttr(p: { builtin?: string; location?: number }): string {
  if (p.builtin) return `@builtin(${p.builtin}) `
  if (p.location !== undefined) return `@location(${p.location}) `
  return ''
}

export function emitFunc(f: FuncDecl): string {
  const params = f.params.map((p) => `${paramAttr(p)}${p.name}: ${wgslType(p.type)}`).join(', ')
  const ret = f.ret.kind === 'void' ? '' : ` -> ${f.retAttr ? `${f.retAttr} ` : ''}${wgslType(f.ret)}`
  const attrs = f.attrs && f.attrs.length ? `${f.attrs.join(' ')}\n` : ''
  return `${attrs}fn ${f.name}(${params})${ret} {\n${emitBody(f.body, 1)}\n}`
}

export function emitModule(m: ModuleDecl): string {
  const parts: string[] = []
  if (m.consts.length) parts.push(m.consts.map(emitConst).join('\n'))
  if (m.structs.length) parts.push(m.structs.map(emitStruct).join('\n\n'))
  if (m.bindings.length) parts.push(m.bindings.map(emitBinding).join('\n'))
  if (m.funcs.length) parts.push(m.funcs.map(emitFunc).join('\n\n'))
  return parts.join('\n\n') + '\n'
}
