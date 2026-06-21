// ═══ Shader DSL — GLSL ES 3.00 backend (WebGL2) ═══
//
// The second writer — proves the IR is target-neutral. It reuses the neutral
// expression walk (emitExprFor) and provides GLSL spelling (types, literals,
// intrinsics) + GLSL declaration/statement syntax (which genuinely differs from
// WGSL: `T name = e` vs `let name = e`, `R name(...)` vs `fn name(...) -> R`,
// `const T name = v` vs `const name: T = v`).
//
// SCOPE (walking skeleton): pure-function modules (the projection / log-depth
// math graphs) — no entry-point IO, no bindings, no compute, no storage. Those
// raise UnsupportedFeatureError (the GLSL writer declares caps = none); the
// struct-IO flatten + data-texture buffer emulation are later steps.

import type { ShaderType, Expr, Stmt, ConstDecl, FuncDecl, ModuleDecl } from '../ir'
import { Capabilities, type Backend } from '../backend'
import { emitExprFor, f32Lit } from './wgsl'
import { lowerModule } from '../passes/match-lower'

export class UnsupportedFeatureError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsupportedFeatureError' }
}

function glslType(t: ShaderType): string {
  switch (t.kind) {
    case 'scalar': return ({ f32: 'float', i32: 'int', u32: 'uint', bool: 'bool' } as const)[t.scalar]
    case 'vec': return `${({ f32: 'vec', i32: 'ivec', u32: 'uvec' } as const)[t.elem]}${t.n}`
    case 'mat': return `mat${t.n}`
    case 'struct': return t.name
    case 'array': {
      if (t.size === undefined) throw new UnsupportedFeatureError('glsl-es300: runtime-sized array (storage buffer) — needs a data-texture (later step)')
      return `${glslType(t.elem)}[${t.size}]`
    }
    case 'texture':
      if (t.dim === '2d-ms') throw new UnsupportedFeatureError('glsl-es300: multisampled texture sampling — resolve first (later step)')
      return 'sampler2D' // GLSL fuses texture+sampler into one combined sampler
    case 'sampler': throw new UnsupportedFeatureError('glsl-es300: standalone sampler — fused into the combined sampler2D')
    case 'void': return 'void'
  }
}

function glslLit(value: number | boolean, t: ShaderType): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (t.kind === 'scalar' && t.scalar === 'u32') return `${value}u`
  if (t.kind === 'scalar' && t.scalar === 'i32') return `${value}`
  return f32Lit(value)
}

// Divergent intrinsic spellings WGSL → GLSL ES 3.00. Anything not listed passes
// through unchanged (the ~23 portable builtins + user-defined function calls).
const GLSL_RENAME: Record<string, string> = {
  atan2: 'atan',                  // GLSL overloads atan(y, x)
  inverseSqrt: 'inversesqrt',
  unpack4x8unorm: 'unpackUnorm4x8',
  pack4x8unorm: 'packUnorm4x8',
  'bitcast<u32>': 'floatBitsToUint',
  'bitcast<f32>': 'uintBitsToFloat',
  textureLoad: 'texelFetch',
  textureDimensions: 'textureSize',
}

export const glslEs300Backend: Backend = {
  id: 'glsl-es300',
  caps: new Capabilities(new Set()), // no storage buffers, no compute, no MSAA-load on WebGL2
  typeName: glslType,
  literal: glslLit,
  intrinsic(name, args) {
    if (name === 'select') return `(${args[2]} ? ${args[1]} : ${args[0]})` // (cond ? true : false)
    if (name === 'textureSample') return `texture(${args[0]}, ${args[2]})`  // drop the separate sampler arg
    return `${GLSL_RENAME[name] ?? name}(${args.join(', ')})`
  },
}

// ── GLSL declaration / statement emit (the syntax that differs from WGSL) ──
const pad = (d: number) => '  '.repeat(d)
const ex = (e: Expr) => emitExprFor(e, glslEs300Backend)

function emitStmt(s: Stmt, depth: number): string {
  const p = pad(depth)
  switch (s.s) {
    case 'let': return `${p}${glslType(s.expr.type)} ${s.name} = ${ex(s.expr)};`
    case 'var':
      return s.init !== undefined
        ? `${p}${glslType(s.type)} ${s.name} = ${ex(s.init)};`
        : `${p}${glslType(s.type)} ${s.name};`
    case 'assign': return `${p}${ex(s.target)} = ${ex(s.expr)};`
    case 'assignOp': return `${p}${ex(s.target)} ${s.bop}= ${ex(s.expr)};`
    case 'return': return s.expr !== undefined ? `${p}return ${ex(s.expr)};` : `${p}return;`
    case 'break': return `${p}break;`
    case 'continue': return `${p}continue;`
    case 'discard': return `${p}discard;`
    case 'if': {
      const lines: string[] = []
      s.arms.forEach((arm, i) => {
        lines.push(`${i === 0 ? `${p}if` : `${p}} else if`} (${ex(arm.cond)}) {`)
        lines.push(emitBody(arm.body, depth + 1))
      })
      if (s.elseBody) { lines.push(`${p}} else {`); lines.push(emitBody(s.elseBody, depth + 1)) }
      lines.push(`${p}}`)
      return lines.filter((l) => l.length > 0).join('\n')
    }
    case 'for': {
      const head = (st: Stmt): string => {
        if (st.s === 'var') return st.init !== undefined ? `${glslType(st.type)} ${st.name} = ${ex(st.init)}` : `${glslType(st.type)} ${st.name}`
        if (st.s === 'assign') return `${ex(st.target)} = ${ex(st.expr)}`
        if (st.s === 'assignOp') return `${ex(st.target)} ${st.bop}= ${ex(st.expr)}`
        throw new UnsupportedFeatureError(`glsl-es300: bad for-header stmt ${st.s}`)
      }
      return `${p}for (${head(s.init)}; ${ex(s.cond)}; ${head(s.update)}) {\n${emitBody(s.body, depth + 1)}\n${p}}`
    }
    case 'placeholder': throw new UnsupportedFeatureError('glsl-es300: un-swapped placeholder Stmt — composer must run first')
    case 'raw': throw new UnsupportedFeatureError('glsl-es300: raw WGSL Stmt cannot lower to GLSL (backendOnly:wgsl)')
    case 'switch': {
      const lines: string[] = [`${p}switch (${ex(s.scrut)}) {`]
      for (const c of s.cases) {
        lines.push(`${pad(depth + 1)}case ${c.value}: {`)
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
const emitBody = (body: readonly Stmt[], depth: number): string => body.map((s) => emitStmt(s, depth)).join('\n')

function emitConst(c: ConstDecl): string {
  return `const ${glslType(c.type)} ${c.name} = ${f32Lit(c.wgslValue)};`
}
function emitFunc(f: FuncDecl): string {
  if (f.attrs?.length) throw new UnsupportedFeatureError(`glsl-es300: entry-point function '${f.name}' (${f.attrs.join(' ')}) — struct-IO flatten is a later step`)
  for (const p of f.params) {
    if (p.builtin !== undefined || p.location !== undefined)
      throw new UnsupportedFeatureError(`glsl-es300: function '${f.name}' has IO-attributed params — entry lowering is a later step`)
  }
  const params = f.params.map((p) => `${glslType(p.type)} ${p.name}`).join(', ')
  return `${glslType(f.ret)} ${f.name}(${params}) {\n${emitBody(f.body, 1)}\n}`
}

/** Emit a pure-function ModuleDecl as GLSL ES 3.00 (with the version + precision
 *  header). Bindings/structs/entry-IO raise UnsupportedFeatureError. */
export function emitGlslModule(m: ModuleDecl): string {
  const lowered = lowerModule(m)
  if (lowered.bindings.length) throw new UnsupportedFeatureError('glsl-es300: resource bindings — std140 UBO / data-texture lowering is a later step')
  if (lowered.structs.length) throw new UnsupportedFeatureError('glsl-es300: struct decls (IO/uniform) — std140 lowering is a later step')
  const parts: string[] = ['#version 300 es', 'precision highp float;', '']
  if (lowered.consts.length) parts.push(lowered.consts.map(emitConst).join('\n'))
  if (lowered.funcs.length) parts.push(lowered.funcs.map(emitFunc).join('\n\n'))
  return parts.join('\n') + '\n'
}
