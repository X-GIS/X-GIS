// ═══ Shader DSL — WGSL backend ═══
//
// Lowers a ModuleDecl to a WGSL string for device.createShaderModule. The
// statement/expression walk is the SHARED neutral emitter (core/emit.ts); this
// file provides the WGSL Backend (type/literal/intrinsic spelling + the divergent
// declaration fragments) and the WGSL module assembly (struct/binding/func/const
// + the matchExpr lowering pass). WGSL output is byte-identical to the pre-refactor
// emit — the wgslBackend fragments reproduce the exact former strings.

import type {
  ShaderType, Expr, ConstDecl, StructDecl, BindingDecl, FuncDecl, ModuleDecl,
} from '../ir'
import { Capabilities, type Backend } from '../backend'
import { emitExpr as emitExprNeutral, emitBody } from '../emit'
import { lowerModule } from '../passes/match-lower'
import { validate } from '../passes/validate'
import { assertCaps } from '../passes/required-caps'
import { cse, autoVars } from '../passes/opt'
import { spellIntrinsic } from '../intrinsics'

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

/** The WGSL target writer. Every method reproduces the exact pre-refactor
 *  spelling, so any emit driven by wgslBackend is byte-identical. */
export const wgslBackend: Backend = {
  id: 'wgsl',
  caps: new Capabilities(new Set(['storageBuffer', 'compute', 'msaaTextureLoad'])),
  typeName: wgslType,
  literal: lit,
  // WGSL spells every intrinsic / user call as `name(args)`; the reserved
  // `'select'` id is WGSL select(falseVal, trueVal, cond).
  intrinsic: (name, args) => spellIntrinsic('wgsl', name, args),
  localLet: (name, _type, init) => `let ${name} = ${init}`,
  localVar: (name, type, init) => init !== undefined ? `var ${name}: ${wgslType(type)} = ${init}` : `var ${name}: ${wgslType(type)}`,
  constDecl: (name, type, value) => `const ${name}: ${wgslType(type)} = ${value};`,
  caseLabel: (value, scrutType) => scrutType.kind === 'scalar' && scrutType.scalar === 'u32' ? `${value}u` : `${value}`,
  switchHead: (scrut) => `switch ${scrut} {`,
  rawStmt: (wgsl) => wgsl,
  placeholderStmt: (tag) => `// __placeholder: ${tag}`,
}

/** Single-arg WGSL-bound expr emit. The compiler keeps a structural copy
 *  (compiler/src/codegen/node-to-wgsl.ts) pinned against this; match-expr.test
 *  uses it for the defensive-throw probe. */
export const emitExpr = (e: Expr): string => emitExprNeutral(e, wgslBackend)

export function emitConst(c: ConstDecl): string {
  return wgslBackend.constDecl(c.name, c.type, f32Lit(c.wgslValue))
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

function paramAttr(p: { builtin?: string; location?: number; attr?: string }): string {
  if (p.attr) return `${p.attr} `
  if (p.builtin) return `@builtin(${p.builtin}) `
  if (p.location !== undefined) return `@location(${p.location}) `
  return ''
}

export function emitFunc(f: FuncDecl): string {
  const params = f.params.map((p) => `${paramAttr(p)}${p.name}: ${wgslType(p.type)}`).join(', ')
  const ret = f.ret.kind === 'void' ? '' : ` -> ${f.retAttr ? `${f.retAttr} ` : ''}${wgslType(f.ret)}`
  const attrs = f.attrs && f.attrs.length ? `${f.attrs.join(' ')}\n` : ''
  return `${attrs}fn ${f.name}(${params})${ret} {\n${emitBody(f.body, 1, wgslBackend)}\n}`
}

/** Emit a bare list of funcs through the SAME lower+cse pipeline emitModule uses, so the parity-harness
 *  emitted-WGSL accessors (getProjectionWgslFns / ECEF_WGSL_FNS / LOG_DEPTH_WGSL_FNS / …)
 *  stay byte-consistent with the decl-merged module emit — the auto-cache applies on BOTH
 *  paths, so dropping a hand `Let` re-binds the reuse uniformly regardless of which emit
 *  path a consumer takes. */
export function emitFuncsCsed(funcs: readonly FuncDecl[]): string {
  const lowered = cse(lowerModule(autoVars({ consts: [], structs: [], bindings: [], funcs: [...funcs] })))
  return lowered.funcs.map(emitFunc).join('\n\n')
}

export function emitModule(m: ModuleDecl): string {
  // Validate the AUTHORED module before any lowering (the rules reason about
  // the pre-lower shape — e.g. matchExpr chains, placeholder swap sites).
  validate(m)
  assertCaps(wgslBackend, m) // principled fail-closed gate (wgslBackend covers all caps)
  // Run the matchExpr→{var slot, Stmt.switch} lowering first so the rest of the
  // emitter stays matchExpr-unaware (identity for modules with no matchExpr), then
  // auto-cache: cse hoists any input-only subexpression reused ≥2x into one shared
  // `let`, so authors write plain inline expressions and the reuse is bound for them.
  const lowered = cse(lowerModule(autoVars(m)))
  const parts: string[] = []
  if (lowered.consts.length) parts.push(lowered.consts.map(emitConst).join('\n'))
  if (lowered.structs.length) parts.push(lowered.structs.map(emitStruct).join('\n\n'))
  if (lowered.bindings.length) parts.push(lowered.bindings.map(emitBinding).join('\n'))
  if (lowered.funcs.length) parts.push(lowered.funcs.map(emitFunc).join('\n\n'))
  return parts.join('\n\n') + '\n'
}
