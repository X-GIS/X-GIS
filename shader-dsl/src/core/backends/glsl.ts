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

import type { ShaderType, ModuleDecl } from '../ir'
import { Capabilities, UnsupportedFeatureError, type Backend } from '../backend'
import { spellIntrinsic } from '../intrinsics'
import { f32Lit } from './wgsl'
import { emitBody, lowerForBackend } from '../emit'

// UnsupportedFeatureError now lives in the backend contract; re-exported here so
// existing importers (`from './glsl'`) keep working.
export { UnsupportedFeatureError } from '../backend'

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

// Intrinsic spelling is owned by the neutral registry (core/intrinsics.ts) now —
// the divergent WGSL→GLSL mappings (atan2→atan, bitcastU32→floatBitsToUint,
// textureSample→texture, select→ternary, …) live there as the single SoT, so this
// writer no longer needs its own rename table.
export const glslEs300Backend: Backend = {
  id: 'glsl-es300',
  caps: new Capabilities(new Set()), // no storage buffers, no compute, no MSAA-load on WebGL2
  typeName: glslType,
  literal: glslLit,
  intrinsic: (name, args) => spellIntrinsic('glsl', name, args),
  localLet: (name, type, init) => `${glslType(type)} ${name} = ${init}`,
  localVar: (name, type, init) => init !== undefined ? `${glslType(type)} ${name} = ${init}` : `${glslType(type)} ${name}`,
  constDecl: (name, type, value) => `const ${glslType(type)} ${name} = ${value};`,
  caseLabel: (value) => `${value}`, // GLSL ES switch requires int labels (no `u` suffix)
  switchHead: (scrut) => `switch (${scrut}) {`,
  rawStmt: () => { throw new UnsupportedFeatureError('glsl-es300: raw WGSL Stmt cannot lower to GLSL (backendOnly:wgsl)') },
  placeholderStmt: () => { throw new UnsupportedFeatureError('glsl-es300: un-swapped placeholder Stmt — composer must run first') },
  // ── Module-decl surface ──
  emitConst: (c) => glslEs300Backend.constDecl(c.name, c.type, f32Lit(c.wgslValue)),
  // struct / binding emission is a later step (std140 UBO / data-texture lowering); fail closed.
  emitStruct: () => { throw new UnsupportedFeatureError('glsl-es300: struct decls (IO/uniform) — std140 lowering is a later step') },
  emitBinding: () => { throw new UnsupportedFeatureError('glsl-es300: resource bindings — std140 UBO / data-texture lowering is a later step') },
  emitFunc: (f) => {
    if (f.attrs?.length) throw new UnsupportedFeatureError(`glsl-es300: entry-point function '${f.name}' (${f.attrs.join(' ')}) — struct-IO flatten is a later step`)
    for (const p of f.params) {
      if (p.builtin !== undefined || p.location !== undefined)
        throw new UnsupportedFeatureError(`glsl-es300: function '${f.name}' has IO-attributed params — entry lowering is a later step`)
    }
    const params = f.params.map((p) => `${glslType(p.type)} ${p.name}`).join(', ')
    return `${glslType(f.ret)} ${f.name}(${params}) {\n${emitBody(f.body, 1, glslEs300Backend)}\n}`
  },
  // GLSL has no emit-time auto-cache (cse stays WGSL-only so byte-identity holds); identity.
  optimize: (lowered) => lowered,
}

/** Emit a pure-function ModuleDecl as GLSL ES 3.00 (version + precision header).
 *  Bindings/structs/entry-IO raise UnsupportedFeatureError. The shared preamble
 *  (lowerForBackend) runs validate → assertCaps → optimize(lowerModule(autoVars)) — with
 *  GLSL's `optimize` being identity, so the lowered shape (and emit bytes) are unchanged;
 *  the version/precision header + `\n`-join + binding/struct fail-closed framing is the
 *  GLSL-specific part that stays here. */
export function emitGlslModule(m: ModuleDecl): string {
  // autoVars BEFORE lowerModule (inside lowerForBackend), same order as the WGSL backend /
  // CPU oracle. Materialising assigned plain-value bindings (the `const x = expr; x.assign(…)`
  // auto-var pattern) into real vars is BACKEND-NEUTRAL — skipping it would let such a module
  // emit invalid `(expr) = …;` GLSL. Identity for modules that don't use the pattern (e.g.
  // projection, which holds mutated values in explicit Var()), so existing GLSL output is unchanged.
  const lowered = lowerForBackend(m, glslEs300Backend)
  if (lowered.bindings.length) throw new UnsupportedFeatureError('glsl-es300: resource bindings — std140 UBO / data-texture lowering is a later step')
  if (lowered.structs.length) throw new UnsupportedFeatureError('glsl-es300: struct decls (IO/uniform) — std140 lowering is a later step')
  const parts: string[] = ['#version 300 es', 'precision highp float;', '']
  if (lowered.consts.length) parts.push(lowered.consts.map((c) => glslEs300Backend.emitConst(c)).join('\n'))
  if (lowered.funcs.length) parts.push(lowered.funcs.map((f) => glslEs300Backend.emitFunc(f)).join('\n\n'))
  return parts.join('\n') + '\n'
}
