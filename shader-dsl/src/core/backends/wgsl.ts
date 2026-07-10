// ═══ Shader DSL — WGSL backend ═══
//
// Lowers a ModuleDecl to a WGSL string for device.createShaderModule. The
// statement/expression walk is the SHARED neutral emitter (core/emit.ts); this
// file provides the WGSL Backend (type/literal/intrinsic spelling + the divergent
// declaration fragments) and the WGSL module assembly (struct/binding/func/const
// + the matchExpr lowering pass). WGSL output is byte-identical to the pre-refactor
// emit — the wgslBackend fragments reproduce the exact former strings.

import type {
  ShaderType,
  Expr,
  ConstDecl,
  StructDecl,
  BindingDecl,
  FuncDecl,
  ModuleDecl,
  Capability,
} from '../ir'
import { Capabilities, type Backend } from '../backend'
import {
  emitExpr as emitExprNeutral,
  emitBody,
  emitModule as emitModuleDriver,
  emitModuleAt as emitModuleAtDriver,
  lowerForBackend,
  type EmitOptions,
} from '../emit'
import { lowerModule } from '../passes/match-lower'
import { fixpoint, autoVars, type OptLevel } from '../passes/opt'
import { spellIntrinsic } from '../intrinsics'
import { fp64Lower } from '../passes/fp64-lower'
import { dslError } from '../diagnostics/error'

export function wgslType(t: ShaderType): string {
  switch (t.kind) {
    case 'scalar':
      return t.scalar
    // f64/vec64 are PRE-LOWERING types only: fp64Lower (run inside
    // lowerForBackend) rewrites them to vec2<f32> / DF64VecN structs before any
    // backend spells a type. Reaching these arms means the pass was bypassed —
    // fail loud, never emit.
    case 'f64':
      throw dslError('SD0040', 'wgslType(f64)')
    case 'vec64':
      throw dslError('SD0040', `wgslType(vec${t.n}<f64>)`)
    case 'vec':
      return `vec${t.n}<${t.elem}>`
    case 'mat':
      // matNxN<f64> is a PRE-LOWERING type too (→ DF64MatN); reaching here means
      // fp64Lower was bypassed — fail loud, never spell an invalid mat<f64>.
      if (t.elem === 'f64') throw dslError('SD0040', `wgslType(mat${t.n}x${t.n}<f64>)`)
      return `mat${t.n}x${t.n}<${t.elem}>`
    case 'struct':
      return t.name
    case 'array':
      return t.size !== undefined
        ? `array<${wgslType(t.elem)}, ${t.size}>`
        : `array<${wgslType(t.elem)}>`
    case 'texture':
      return t.dim === '2d-ms'
        ? `texture_multisampled_2d<${t.elem}>`
        : `texture_${t.dim}<${t.elem}>`
    case 'sampler':
      return 'sampler'
    case 'void':
      return 'void'
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

function paramAttr(p: { builtin?: string; location?: number; attr?: string }): string {
  if (p.attr) return `${p.attr} `
  if (p.builtin) return `@builtin(${p.builtin}) `
  if (p.location !== undefined) return `@location(${p.location}) `
  return ''
}

/** WGSL `enable`-directive extension name for each language-feature capability that
 *  needs one (#628). Resource caps (storageBuffer / compute / msaaTextureLoad) need no
 *  directive and are absent here; a cap absent from this map contributes no header. */
const WGSL_ENABLE: Partial<Record<Capability, string>> = {
  f16: 'f16',
  subgroups: 'subgroups',
}

/** The WGSL target writer. Every method reproduces the exact pre-refactor
 *  spelling, so any emit driven by wgslBackend is byte-identical. */
export const wgslBackend: Backend = {
  id: 'wgsl',
  // The WGSL writer can SPELL every cap; whether a given adapter supports an optional
  // feature (shader-f16, subgroups) is a RUNTIME probe the RHI owns — it opts a module
  // in via `enables` only after it has confirmed the device feature (#628).
  caps: new Capabilities(
    new Set(['storageBuffer', 'compute', 'msaaTextureLoad', 'f16', 'subgroups']),
  ),
  typeName: wgslType,
  literal: lit,
  // WGSL spells every intrinsic / user call as `name(args)`; the reserved
  // `'select'` id is WGSL select(falseVal, trueVal, cond).
  intrinsic: (name, args) => spellIntrinsic('wgsl', name, args),
  localLet: (name, _type, init) => `let ${name} = ${init}`,
  localVar: (name, type, init) =>
    init !== undefined
      ? `var ${name}: ${wgslType(type)} = ${init}`
      : `var ${name}: ${wgslType(type)}`,
  constDecl: (name, type, value) => `const ${name}: ${wgslType(type)} = ${value};`,
  caseLabel: (value, scrutType) =>
    scrutType.kind === 'scalar' && scrutType.scalar === 'u32' ? `${value}u` : `${value}`,
  switchHead: (scrut) => `switch ${scrut} {`,
  rawStmt: (wgsl) => wgsl,
  placeholderStmt: (tag) => `// __placeholder: ${tag}`,
  // ── Module-decl surface (the WGSL spellings, lifted from the former free fns) ──
  emitConst: (c) =>
    wgslBackend.constDecl(
      c.name,
      c.type,
      c.valueExpr ? emitExprNeutral(c.valueExpr, wgslBackend) : f32Lit(c.wgslValue),
    ),
  // #923 — a pipeline specialization constant: a module-scope `override` the host
  // specializes via createRenderPipeline({ constants: { name } }). The default value
  // uses the same scalar spelling as any literal (1.0 / 2u / true), so the module
  // compiles standalone and a branch guarded by the override is dead-code-eliminated
  // by the DRIVER once specialized.
  emitOverride: (o) => `override ${o.name}: ${wgslType(o.type)} = ${lit(o.default, o.type)};`,
  emitStruct: (s) => {
    const fields = s.fields
      .map((f) => `  ${f.attr ? `${f.attr} ` : ''}${f.name}: ${wgslType(f.type)},`)
      .join('\n')
    return `struct ${s.name} {\n${fields}\n}`
  },
  emitBinding: (b) => {
    // texture / sampler are handle types — no address space (`var x: T;`).
    if (b.type.kind === 'texture' || b.type.kind === 'sampler') {
      return `@group(${b.group}) @binding(${b.binding}) var ${b.name}: ${wgslType(b.type)};`
    }
    const space = b.space === 'storage' ? `storage, ${b.access ?? 'read'}` : 'uniform'
    return `@group(${b.group}) @binding(${b.binding}) var<${space}> ${b.name}: ${wgslType(b.type)};`
  },
  emitFunc: (f) => {
    const params = f.params.map((p) => `${paramAttr(p)}${p.name}: ${wgslType(p.type)}`).join(', ')
    const ret =
      f.ret.kind === 'void' ? '' : ` -> ${f.retAttr ? `${f.retAttr} ` : ''}${wgslType(f.ret)}`
    const attrs = f.attrs && f.attrs.length ? `${f.attrs.join(' ')}\n` : ''
    return `${attrs}fn ${f.name}(${params})${ret} {\n${emitBody(f.body, 1, wgslBackend)}\n}`
  },
  // WGSL's emit-time optimizer: the full pipeline run to a fixed point — const/copy
  // propagation, const-fold (incl. literal compare/logical/select), algebraic
  // identities, dead-branch elim, cse auto-cache, licm, dce. Authors write plain
  // inline exprs; the optimizer folds constants, drops dead code, and binds reuse for
  // them. Correctness: oracle value-equality (unit) + the real-GPU optimizer-parity
  // gate (_optimizer-gpu-parity). Every pass skips a fn containing a raw Stmt (the
  // polygon composer's _mcSS fill/stroke), so those precision-critical paths are
  // emitted verbatim, untouched.
  optimize: (m) => fixpoint(m),
  // The WGSL `enable`-directive header (#628): one `enable <ext>;` per opt-in
  // language-feature cap the module declares (m.enables), deduped + sorted for a
  // deterministic byte order, then a blank line before the first declaration. Empty
  // when the module opts into nothing, so enables-free emit stays byte-identical.
  // assertCaps (run in lowerForBackend, before this string is used) has already
  // guaranteed this backend covers every declared cap.
  modulePreamble: (m) => {
    const dirs = (m.enables ?? [])
      .map((c) => WGSL_ENABLE[c])
      .filter((d): d is string => d !== undefined)
    if (dirs.length === 0) return ''
    return (
      [...new Set(dirs)]
        .sort()
        .map((d) => `enable ${d};`)
        .join('\n') + '\n\n'
    )
  },
}

/** Single-arg WGSL-bound expr emit. The compiler keeps a structural copy
 *  (compiler/src/codegen/node-to-wgsl.ts) pinned against this; match-expr.test
 *  uses it for the defensive-throw probe. */
export const emitExpr = (e: Expr): string => emitExprNeutral(e, wgslBackend)

// The module-decl emit functions now live as wgslBackend methods; these thin
// wrappers keep the existing public export names + signatures (runtime / compiler /
// shader composers / lint+ir tests import them directly).
export const emitConst = (c: ConstDecl): string => wgslBackend.emitConst(c)
export const emitStruct = (s: StructDecl): string => wgslBackend.emitStruct(s)
export const emitBinding = (b: BindingDecl): string => wgslBackend.emitBinding(b)
export const emitFunc = (f: FuncDecl): string => wgslBackend.emitFunc(f)

/** Emit a bare list of funcs through the SAME lower+optimize pipeline emitModule uses, so the
 *  parity-harness emitted-WGSL accessors (getProjectionWgslFns / ECEF_WGSL_FNS / LOG_DEPTH_WGSL_FNS / …)
 *  stay byte-consistent with the decl-merged module emit — the optimizer applies on BOTH paths, so
 *  folding / dead-code / reuse-binding happen uniformly regardless of which emit path a consumer takes.
 *  (Skips the validate/assertCaps preamble on purpose — a bare func list is not a complete authored
 *  module — so it runs only the lower+optimize the spelling needs; it mirrors `wgslBackend.optimize`
 *  (fixpoint) so this stays byte-identical to the func section of emitModule.) */
export function emitFuncs(funcs: readonly FuncDecl[]): string {
  const lowered = fixpoint(
    fp64Lower(lowerModule(autoVars({ consts: [], structs: [], bindings: [], funcs: [...funcs] }))),
  )
  return lowered.funcs.map((f) => wgslBackend.emitFunc(f)).join('\n\n')
}

/** @deprecated Renamed `emitFuncs` — the "Csed" suffix described a pipeline that was
 *  once cse-only and has been the full fixpoint optimizer for a long time. */
export const emitFuncsCsed = emitFuncs

/** Emit a ModuleDecl as a WGSL string. Thin wrapper over the shared backend-parameterised
 *  driver (core/emit.ts) bound to wgslBackend — the module assembly lives once. `opts` is
 *  the optional `{ plugins }` bag (production tooling: `@xgis/shader-dsl/emit-prod`). */
export const emitModule = (m: ModuleDecl, opts?: EmitOptions): string =>
  emitModuleDriver(m, wgslBackend, opts)

/** Emit WGSL at an explicit optimization level (O0/O1/O2). `emitModuleAt(m, 'O2')` is
 *  byte-identical to `emitModule(m)`; O0 is the naive (un-optimized) emit. Drives the
 *  emit-size measurement (core/measure.ts) and debug builds. */
export const emitModuleAt = (m: ModuleDecl, level: OptLevel): string =>
  emitModuleAtDriver(m, wgslBackend, level)

/** The lowered+optimized WGSL ModuleDecl at a level — the SAME pre-emit pipeline `emitModule`
 *  runs (validate → assertCaps → autoVars → lowerModule → optimizeAt), returned as IR rather
 *  than a string. Single source of the lowering recipe so an IR consumer (core/measure.ts's
 *  op-count) and the string emit cannot describe different modules. */
export const lowerWgsl = (m: ModuleDecl, level: OptLevel): ModuleDecl =>
  lowerForBackend(m, wgslBackend, level)
