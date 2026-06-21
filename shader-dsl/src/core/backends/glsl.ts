// ═══ Shader DSL — GLSL ES 3.00 backend (WebGL2) ═══
//
// The second writer — proves the IR is target-neutral. It reuses the SHARED
// neutral walk (core/emit.ts) and provides GLSL spelling (types, literals,
// intrinsics) + the divergent declaration fragments (`T name = e` vs `let name =
// e`, GLSL `switch (x)` + int case labels, fail-closed raw/placeholder). The
// control-flow walk is NOT duplicated here.
//
// SCOPE (walking skeleton): pure-function modules (projection / log-depth math)
// — no entry-point IO, no bindings, no compute, no storage. Those raise
// UnsupportedFeatureError (caps = none); struct-IO flatten + data-texture buffer
// emulation are later steps.
// ─── CAVEAT — string-shape-validated only; NEVER GPU-compiled ───
//
// This emitter has never run through a real GL driver. The "proves the IR is
// target-neutral" claim above is bounded by what the tests actually assert:
// glsl.test.ts checks the SHAPE of the emitted string (type spellings, intrinsic
// renames, declaration fragments) — it does NOT invoke `gl.compileShader`, so a
// string that is well-formed-looking but rejected by the GLSL ES 3.00 compiler
// (precision-qualifier omissions, reserved-word collisions, version-pragma order,
// implicit-conversion rules) would still pass today.
//
// Target-neutrality is therefore UNPROVEN until a headless-WebGL2 compile gate
// (W2) lands: spin up an offscreen WebGL2 context, `compileShader` every emitted
// module, and fail on the info-log. Until W2, treat GLSL output as a plausible
// transcription, not a verified one.

import type { ShaderType, ConstDecl, FuncDecl, ModuleDecl } from '../ir'
import { Capabilities, type Backend } from '../backend'
import { f32Lit } from './wgsl'
import { emitBody } from '../emit'
import { lowerModule } from '../passes/match-lower'
import { validate } from '../passes/validate'

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
  localLet: (name, type, init) => `${glslType(type)} ${name} = ${init}`,
  localVar: (name, type, init) => init !== undefined ? `${glslType(type)} ${name} = ${init}` : `${glslType(type)} ${name}`,
  constDecl: (name, type, value) => `const ${glslType(type)} ${name} = ${value};`,
  caseLabel: (value) => `${value}`, // GLSL ES switch requires int labels (no `u` suffix)
  switchHead: (scrut) => `switch (${scrut}) {`,
  rawStmt: () => { throw new UnsupportedFeatureError('glsl-es300: raw WGSL Stmt cannot lower to GLSL (backendOnly:wgsl)') },
  placeholderStmt: () => { throw new UnsupportedFeatureError('glsl-es300: un-swapped placeholder Stmt — composer must run first') },
}

function emitConst(c: ConstDecl): string {
  return glslEs300Backend.constDecl(c.name, c.type, f32Lit(c.wgslValue))
}
function emitFunc(f: FuncDecl): string {
  if (f.attrs?.length) throw new UnsupportedFeatureError(`glsl-es300: entry-point function '${f.name}' (${f.attrs.join(' ')}) — struct-IO flatten is a later step`)
  for (const p of f.params) {
    if (p.builtin !== undefined || p.location !== undefined)
      throw new UnsupportedFeatureError(`glsl-es300: function '${f.name}' has IO-attributed params — entry lowering is a later step`)
  }
  const params = f.params.map((p) => `${glslType(p.type)} ${p.name}`).join(', ')
  return `${glslType(f.ret)} ${f.name}(${params}) {\n${emitBody(f.body, 1, glslEs300Backend)}\n}`
}

/** Emit a pure-function ModuleDecl as GLSL ES 3.00 (version + precision header).
 *  Bindings/structs/entry-IO raise UnsupportedFeatureError. */
export function emitGlslModule(m: ModuleDecl): string {
  validate(m) // validate the authored module before any lowering
  const lowered = lowerModule(m)
  if (lowered.bindings.length) throw new UnsupportedFeatureError('glsl-es300: resource bindings — std140 UBO / data-texture lowering is a later step')
  if (lowered.structs.length) throw new UnsupportedFeatureError('glsl-es300: struct decls (IO/uniform) — std140 lowering is a later step')
  const parts: string[] = ['#version 300 es', 'precision highp float;', '']
  if (lowered.consts.length) parts.push(lowered.consts.map(emitConst).join('\n'))
  if (lowered.funcs.length) parts.push(lowered.funcs.map(emitFunc).join('\n\n'))
  return parts.join('\n') + '\n'
}
