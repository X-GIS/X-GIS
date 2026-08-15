// ═══ Shader DSL — identifier mangling (emit-time obfuscation) ═══
//
// mangleModule(m) renames every identifier the EMITTED TEXT does not need to
// keep — the authored vocabulary (helper fn names, plain struct names, module
// const names, helper PARAMS and every local) is what leaks a shader's design
// through devtools/`shaderSource` interception, and no JS minifier can reach it.
//
// Names are BASE-52 short (`a`, `b`, … `aa`), not `_f0`-style tags: the
// optimizer's machine names are themselves 3–5 chars and hugely repeated
// (`_cse0` × 774, `_v0` × 1232 across the example corpus), so the tag prefix was
// the single heaviest identifier cost in the shipped text — 28.4 KB of the
// 140 KB obfuscated corpus, against 8.0 KB at one char each. Locals restart from
// the same pool in EVERY function (they are function-scoped), so the short end
// of the alphabet is reused instead of counting monotonically upward.
//
// The ABI boundary — names that are NEVER renamed, each load-bearing:
//   • entry-point names — WebGPU `createRenderPipeline({ entryPoint })` refers
//     to them; GLSL derives `<name>_impl` from them.
//   • entry-point PARAM names — a non-struct entry param IS the GLSL varying
//     name (`glsl.ts:559` reads `inName(p.name)`), and the vertex side spells
//     that varying from its RETURN STRUCT's field name in a SEPARATE emit call.
//     Renaming one side and not the other links to nothing. Helper-fn params
//     have no such reader and ARE renamed.
//   • binding names — hosts resolve them by name (`getUniformLocation`,
//     reflection-driven bind points), incl. the fp64 guard `_fp64`, whose
//     intrinsic SPELLING also names it textually (INTRINSIC_BINDING_REFS).
//   • binding-STRUCT names — the GLSL UBO block tag (`uniform Uniforms {…} u;`)
//     is host-visible via getUniformBlockIndex.
//   • struct FIELD names — std140 host packing documentation + GLSL varying
//     linkage (vertex `out` ↔ fragment `in` link BY NAME, and the two stages
//     are emitted in separate calls).
//
// Runs at the very END of the emit pipeline (after lowerForBackend's optimize),
// so the optimizer's invariants — notably the `df64_` opacity contract — see
// only authored names; the rename is a pure spelling change on the final IR.
// Deterministic: names are assigned in declaration order, so the two GLSL
// stage emits of one module (separate calls) agree on every shared name.
// Bails to identity when a fn body carries a `raw` Stmt (textual references
// this walk cannot see).

import { stageOf } from '../ir'
import type { ModuleDecl, FuncDecl, StructDecl, ConstDecl, BindingDecl, Expr, Stmt } from '../ir'
import type { ShaderType } from '../ir'
import { collectFnRefs, emptyRefSet } from '../ir/collect-refs'
import { mapExpr } from './opt/ir-transform'
import { bodyHasRaw } from './opt/dce'

export interface MangleResult {
  readonly module: ModuleDecl
  /** authored name → emitted name, for every renamed decl (the shader "source
   *  map": decode production driver logs / captures back to authored names).
   *  A function-scoped name (param / local) is keyed `authoredFn.authoredName`,
   *  since the same spelling is renamed independently in each function. */
  readonly renames: ReadonlyMap<string, string>
}

/** Spellings a generated name must never take. Language keywords plus the type
 *  and qualifier vocabulary the BACKENDS write textually (`vec2`, `float`,
 *  `layout`, `precision`) — none of it appears in the IR, so the identifier
 *  sweep below cannot see it. Everything that DOES appear in the IR (intrinsic
 *  call targets, binding names, struct fields, overrides) is collected from the
 *  module instead, so this list only has to cover the textual half. */
const RESERVED: ReadonlySet<string> = new Set([
  // WGSL
  'alias',
  'break',
  'case',
  'const',
  'const_assert',
  'continue',
  'continuing',
  'default',
  'diagnostic',
  'discard',
  'else',
  'enable',
  'false',
  'fn',
  'for',
  'if',
  'let',
  'loop',
  'override',
  'requires',
  'return',
  'struct',
  'switch',
  'true',
  'var',
  'while',
  // GLSL ES 3.00
  'attribute',
  'centroid',
  'coherent',
  'do',
  'flat',
  'highp',
  'in',
  'inout',
  'invariant',
  'layout',
  'lowp',
  'main',
  'mediump',
  'noperspective',
  'out',
  'precision',
  'readonly',
  'restrict',
  'smooth',
  'uniform',
  'varying',
  'void',
  'volatile',
  'writeonly',
  // scalar / vector / matrix / opaque types, both languages
  'bool',
  'f16',
  'f32',
  'float',
  'i32',
  'int',
  'u32',
  'uint',
  'half',
  'double',
  'atomic',
  'array',
  'ptr',
  'ref',
  'texture',
  // sampler types, GLSL ES 3.00 §3.7 — the same completion as glsl-sanitize's set
  // (#1703): the float 2D/3D/Cube trio was ES-1.00-era and left every array/integer
  // sampler spelling absent.
  'sampler',
  'sampler2D',
  'sampler3D',
  'samplerCube',
  'sampler2DShadow',
  'samplerCubeShadow',
  'sampler2DArray',
  'sampler2DArrayShadow',
  'isampler2D',
  'isampler3D',
  'isamplerCube',
  'isampler2DArray',
  'usampler2D',
  'usampler3D',
  'usamplerCube',
  'usampler2DArray',
  'vec2',
  'vec3',
  'vec4',
  'bvec2',
  'bvec3',
  'bvec4',
  'ivec2',
  'ivec3',
  'ivec4',
  'uvec2',
  'uvec3',
  'uvec4',
  'mat2',
  'mat3',
  'mat4',
  'mat2x2',
  'mat2x3',
  'mat2x4',
  'mat3x2',
  'mat3x3',
  'mat3x4',
  'mat4x2',
  'mat4x3',
  'mat4x4',
])

const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** The i-th short name in bijective base-52: a, b, … Z, aa, ab, … */
function nthName(i: number): string {
  let out = ''
  let n = i
  do {
    out = ALPHA[n % 52]! + out
    n = Math.floor(n / 52) - 1
  } while (n >= 0)
  return out
}

/** Hands out the shortest names not in `blocked`, in order. One pool names the
 *  module scope; a FRESH pool per function names that function's scope, so the
 *  short end of the alphabet is reused across functions. */
function pool(blocked: ReadonlySet<string>): () => string {
  let i = 0
  return () => {
    let n = nthName(i++)
    while (blocked.has(n)) n = nthName(i++)
    return n
  }
}

/** Local decl names (let/var), recursively — collectFnRefs sees only
 *  REFERENCES (varref); an unreferenced local still emits a declaration whose
 *  name a generated name must not collide with. */
function collectDeclNames(body: readonly Stmt[], acc: Set<string>): void {
  for (const s of body) {
    if (s.s === 'let' || s.s === 'var') acc.add(s.name)
    else if (s.s === 'if') {
      for (const a of s.arms) collectDeclNames(a.body, acc)
      if (s.elseBody) collectDeclNames(s.elseBody, acc)
    } else if (s.s === 'for') {
      collectDeclNames([s.init], acc)
      collectDeclNames(s.body, acc)
    } else if (s.s === 'switch') {
      for (const c of s.cases) collectDeclNames(c.body, acc)
      if (s.defaultBody) collectDeclNames(s.defaultBody, acc)
    }
  }
}

export function mangleModule(m: ModuleDecl): MangleResult {
  // A raw WGSL fragment can reference any name textually — renaming around it
  // would desync the verbatim splice. Identity, like dce-fns / stageScope.
  if (m.funcs.some((f) => bodyHasRaw(f.body))) return { module: m, renames: new Map() }

  const bindingStructNames = new Set<string>()
  for (const b of m.bindings) if (b.type.kind === 'struct') bindingStructNames.add(b.type.name)

  // ── every spelling that SURVIVES the rename (the collision guard) ──
  // A generated name may not take any of these. Entry-fn names and entry PARAM
  // names are here because they are ABI (see the header); everything else that
  // is renamed below is deliberately absent, so its old spelling is free to be
  // handed back out as a short name.
  const survivors = new Set<string>(RESERVED)
  const refs = emptyRefSet()
  for (const f of m.funcs) {
    collectFnRefs(f, refs)
    if (stageOf(f) === undefined) continue
    survivors.add(f.name)
    for (const p of f.params) survivors.add(p.name)
  }
  for (const n of refs.calls) survivors.add(n) // intrinsics + helper calls
  for (const s of m.structs) for (const f of s.fields) survivors.add(f.name)
  for (const b of m.bindings) survivors.add(b.name)
  for (const o of m.overrides ?? []) survivors.add(o.name)
  // #1713 — a host-provided global is spelled by the HOST's prelude, so renaming it (or
  // handing its spelling out as a generated short name) would desync the two. Same
  // treatment as an override name, and `rE` below likewise never rewrites an `externref`.
  for (const e of m.externs ?? []) {
    survivors.add(e.name)
    if (e.spelling?.wgsl) survivors.add(e.spelling.wgsl)
    if (e.spelling?.glsl) survivors.add(e.spelling.glsl)
  }
  for (const n of bindingStructNames) survivors.add(n)

  // ── rename maps, in declaration order (deterministic across emit calls) ──
  const fresh = pool(survivors)

  const fnMap = new Map<string, string>()
  for (const f of m.funcs) if (stageOf(f) === undefined) fnMap.set(f.name, fresh())

  const structMap = new Map<string, string>()
  for (const s of m.structs) if (!bindingStructNames.has(s.name)) structMap.set(s.name, fresh())

  const constMap = new Map<string, string>()
  for (const c of m.consts) constMap.set(c.name, fresh())

  // Function-scoped names restart from a pool that only has to dodge the module
  // scope, so `a`/`b`/`c` are reused in every function.
  const moduleScope = new Set<string>([
    ...survivors,
    ...fnMap.values(),
    ...structMap.values(),
    ...constMap.values(),
  ])
  const localMaps = new Map<string, ReadonlyMap<string, string>>()
  for (const f of m.funcs) {
    const scoped = new Map<string, string>()
    const next = pool(moduleScope)
    // A helper's params share the scope with its locals; an entry's do not move.
    const declared = new Set<string>()
    if (stageOf(f) === undefined) for (const p of f.params) declared.add(p.name)
    collectDeclNames(f.body, declared)
    for (const name of declared) scoped.set(name, next())
    localMaps.set(f.name, scoped)
  }

  const anyLocal = [...localMaps.values()].some((s) => s.size > 0)
  if (fnMap.size === 0 && structMap.size === 0 && constMap.size === 0 && !anyLocal)
    return { module: m, renames: new Map() }

  const renameType = (t: ShaderType): ShaderType => {
    if (t.kind === 'struct') {
      const to = structMap.get(t.name)
      return to === undefined ? t : { ...t, name: to }
    }
    if (t.kind === 'array') {
      const elem = renameType(t.elem)
      return elem === t.elem ? t : { ...t, elem }
    }
    return t
  }

  // `locals` is the enclosing function's scope map — `varref`/`param` are the
  // only reads of a function-scoped name, and both carry it in `.name`.
  const rE =
    (locals: ReadonlyMap<string, string>) =>
    (e: Expr): Expr =>
      mapExpr(e, (x) => {
        let y: Expr = x
        if (y.op === 'call' && fnMap.has(y.fn)) y = { ...y, fn: fnMap.get(y.fn)! }
        else if (y.op === 'constref' && constMap.has(y.name))
          y = { ...y, name: constMap.get(y.name)! }
        else if ((y.op === 'varref' || y.op === 'param') && locals.has(y.name))
          y = { ...y, name: locals.get(y.name)! }
        const t = renameType(y.type)
        return t === y.type ? y : { ...y, type: t }
      })

  // mapStmt covers exprs but not the `var` stmt's DECLARED type — a struct-typed
  // local (`VsOut _out;`) spells the struct name, so rename it here. `let`/`var`
  // also carry the DECLARATION of a function-scoped name in `.name`.
  const mkRS = (locals: ReadonlyMap<string, string>): ((s: Stmt) => Stmt) => {
    const rX = rE(locals)
    const decl = (name: string): string => locals.get(name) ?? name
    const rS = (s: Stmt): Stmt => {
      switch (s.s) {
        case 'let':
          return { ...s, name: decl(s.name), expr: rX(s.expr) }
        case 'var':
          return {
            ...s,
            name: decl(s.name),
            type: renameType(s.type),
            ...(s.init !== undefined ? { init: rX(s.init) } : {}),
          }
        case 'assign':
        case 'assignOp':
          return { ...s, target: rX(s.target), expr: rX(s.expr) }
        case 'return':
          return s.expr !== undefined ? { ...s, expr: rX(s.expr) } : s
        case 'if':
          return {
            ...s,
            arms: s.arms.map((a) => ({ cond: rX(a.cond), body: a.body.map(rS) })),
            elseBody: s.elseBody?.map(rS),
          }
        case 'for':
          return {
            ...s,
            init: rS(s.init),
            cond: rX(s.cond),
            update: rS(s.update),
            body: s.body.map(rS),
          }
        case 'switch':
          return {
            ...s,
            scrut: rX(s.scrut),
            cases: s.cases.map((c) => ({ value: c.value, body: c.body.map(rS) })),
            defaultBody: s.defaultBody?.map(rS),
          }
        default:
          return s // break / continue / discard / placeholder (raw already bailed)
      }
    }
    return rS
  }

  const rFn = (f: FuncDecl): FuncDecl => {
    const locals = localMaps.get(f.name) ?? new Map<string, string>()
    return {
      ...f,
      name: fnMap.get(f.name) ?? f.name,
      params: f.params.map((p) => {
        const t = renameType(p.type)
        const name = locals.get(p.name) ?? p.name
        return t === p.type && name === p.name ? p : { ...p, type: t, name }
      }),
      ret: renameType(f.ret),
      body: f.body.map(mkRS(locals)),
    }
  }
  const rStruct = (s: StructDecl): StructDecl => ({
    ...s,
    name: structMap.get(s.name) ?? s.name,
    fields: s.fields.map((f) => {
      const t = renameType(f.type)
      return t === f.type ? f : { ...f, type: t }
    }),
  })
  const rConst = (c: ConstDecl): ConstDecl => ({
    ...c,
    name: constMap.get(c.name)!,
    type: renameType(c.type),
    // A module const's initializer is in module scope — no function-scoped
    // names are visible to it, so it renames under an empty local map.
    ...(c.valueExpr !== undefined ? { valueExpr: rE(new Map())(c.valueExpr) } : {}),
  })
  // Binding names AND top-level binding-struct names are the host ABI — only
  // nested types (array elements) are renamed.
  const rBinding = (b: BindingDecl): BindingDecl => {
    if (b.type.kind === 'struct') return b
    const t = renameType(b.type)
    return t === b.type ? b : { ...b, type: t }
  }

  // Function-scoped entries are keyed `authoredFn.authoredName` — the same
  // spelling is renamed independently per function, so a flat key would collide.
  const renames = new Map<string, string>([...fnMap, ...structMap, ...constMap])
  for (const [fnName, scoped] of localMaps)
    for (const [from, to] of scoped) renames.set(`${fnName}.${from}`, to)
  return {
    // `...m` preserves every module field this pass does NOT rewrite — the #923
    // `overrides` (whose names, like binding names above, are the host ABI and must
    // survive un-renamed so both emit paths still declare them) and the #628
    // `enables`, and the #1713 `externs` (spelled by the host's prelude, so ours to
    // reference and never to rename). Only the four renamed collections are replaced;
    // `overrideref` and `externref` reads in bodies are already left un-renamed by `rE`,
    // matching the untouched decls.
    module: {
      ...m,
      consts: m.consts.map(rConst),
      structs: m.structs.map(rStruct),
      bindings: m.bindings.map(rBinding),
      funcs: m.funcs.map(rFn),
    },
    renames,
  }
}
