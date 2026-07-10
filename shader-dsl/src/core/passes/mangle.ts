// ═══ Shader DSL — identifier mangling (emit-time obfuscation) ═══
//
// mangleModule(m) renames every identifier the EMITTED TEXT does not need to
// keep — the authored vocabulary (helper fn names, plain struct names, module
// const names) is what leaks a shader's design through devtools/`shaderSource`
// interception, and no JS minifier can reach it. Locals are already
// machine-named (`_v0`/`_cse0`) by the optimizer.
//
// The ABI boundary — names that are NEVER renamed, each load-bearing:
//   • entry-point names — WebGPU `createRenderPipeline({ entryPoint })` refers
//     to them; GLSL derives `<name>_impl` from them.
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
   *  map": decode production driver logs / captures back to authored names). */
  readonly renames: ReadonlyMap<string, string>
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

  // ── every identifier that will still exist after the rename (collision guard) ──
  const taken = new Set<string>()
  const refs = emptyRefSet()
  for (const f of m.funcs) {
    taken.add(f.name)
    for (const p of f.params) taken.add(p.name)
    collectDeclNames(f.body, taken)
    collectFnRefs(f, refs)
  }
  for (const n of refs.vars) taken.add(n)
  for (const n of refs.calls) taken.add(n)
  for (const s of m.structs) {
    taken.add(s.name)
    for (const f of s.fields) taken.add(f.name)
  }
  for (const c of m.consts) taken.add(c.name)
  for (const b of m.bindings) taken.add(b.name)

  const fresh = (prefix: string, i: { n: number }): string => {
    let name = `${prefix}${i.n++}`
    while (taken.has(name)) name = `${prefix}${i.n++}`
    taken.add(name)
    return name
  }

  // ── rename maps, in declaration order (deterministic across emit calls) ──
  const bindingStructNames = new Set<string>()
  for (const b of m.bindings) if (b.type.kind === 'struct') bindingStructNames.add(b.type.name)

  const fnMap = new Map<string, string>()
  const fi = { n: 0 }
  for (const f of m.funcs) if (stageOf(f) === undefined) fnMap.set(f.name, fresh('_f', fi))

  const structMap = new Map<string, string>()
  const si = { n: 0 }
  for (const s of m.structs)
    if (!bindingStructNames.has(s.name)) structMap.set(s.name, fresh('_S', si))

  const constMap = new Map<string, string>()
  const ki = { n: 0 }
  for (const c of m.consts) constMap.set(c.name, fresh('_k', ki))

  if (fnMap.size === 0 && structMap.size === 0 && constMap.size === 0)
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

  const rE = (e: Expr): Expr =>
    mapExpr(e, (x) => {
      let y: Expr = x
      if (y.op === 'call' && fnMap.has(y.fn)) y = { ...y, fn: fnMap.get(y.fn)! }
      else if (y.op === 'constref' && constMap.has(y.name))
        y = { ...y, name: constMap.get(y.name)! }
      const t = renameType(y.type)
      return t === y.type ? y : { ...y, type: t }
    })

  // mapStmt covers exprs but not the `var` stmt's DECLARED type — a struct-typed
  // local (`VsOut _out;`) spells the struct name, so rename it here.
  const rS = (s: Stmt): Stmt => {
    switch (s.s) {
      case 'let':
        return { ...s, expr: rE(s.expr) }
      case 'var':
        return {
          ...s,
          type: renameType(s.type),
          ...(s.init !== undefined ? { init: rE(s.init) } : {}),
        }
      case 'assign':
      case 'assignOp':
        return { ...s, target: rE(s.target), expr: rE(s.expr) }
      case 'return':
        return s.expr !== undefined ? { ...s, expr: rE(s.expr) } : s
      case 'if':
        return {
          ...s,
          arms: s.arms.map((a) => ({ cond: rE(a.cond), body: a.body.map(rS) })),
          elseBody: s.elseBody?.map(rS),
        }
      case 'for':
        return {
          ...s,
          init: rS(s.init),
          cond: rE(s.cond),
          update: rS(s.update),
          body: s.body.map(rS),
        }
      case 'switch':
        return {
          ...s,
          scrut: rE(s.scrut),
          cases: s.cases.map((c) => ({ value: c.value, body: c.body.map(rS) })),
          defaultBody: s.defaultBody?.map(rS),
        }
      default:
        return s // break / continue / discard / placeholder (raw already bailed)
    }
  }

  const rFn = (f: FuncDecl): FuncDecl => ({
    ...f,
    name: fnMap.get(f.name) ?? f.name,
    params: f.params.map((p) => {
      const t = renameType(p.type)
      return t === p.type ? p : { ...p, type: t }
    }),
    ret: renameType(f.ret),
    body: f.body.map(rS),
  })
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
    ...(c.valueExpr !== undefined ? { valueExpr: rE(c.valueExpr) } : {}),
  })
  // Binding names AND top-level binding-struct names are the host ABI — only
  // nested types (array elements) are renamed.
  const rBinding = (b: BindingDecl): BindingDecl => {
    if (b.type.kind === 'struct') return b
    const t = renameType(b.type)
    return t === b.type ? b : { ...b, type: t }
  }

  const renames = new Map<string, string>([...fnMap, ...structMap, ...constMap])
  return {
    // `...m` preserves every module field this pass does NOT rewrite — the #923
    // `overrides` (whose names, like binding names above, are the host ABI and must
    // survive un-renamed so both emit paths still declare them) and the #628
    // `enables`. Only the four renamed collections are replaced; `overrideref` reads
    // in bodies are already left un-renamed by `rE`, matching the untouched decls.
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
