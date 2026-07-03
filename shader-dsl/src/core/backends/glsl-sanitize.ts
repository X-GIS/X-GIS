// ═══ Shader DSL — GLSL ES 3.00 reserved-word identifier sanitisation ═══
//
// WGSL and GLSL have DIFFERENT reserved-word sets, so a perfectly legal DSL
// identifier (an entry param named `input`, `in`, an `out` local) is a GLSL
// compile error ("Illegal use of reserved word"). The WGSL backend emits these
// names verbatim (legal there); the GLSL backend must RENAME any param/local-var
// whose name collides with a GLSL ES reserved word — consistently across the
// declaration AND every reference. This pass is GLSL-LOCAL (only emitGlslModule
// calls it), so WGSL emit stays byte-identical. Struct FIELD names are left alone
// (they are the std140 host-offset + cross-stage varying linkage contract, and are
// accessed as `.field`, not bare identifiers).
//
// Split out of glsl.ts (which exceeded the 500-LOC ratchet) — emit is unchanged;
// emitGlslModule imports sanitizeReservedIdents from here.

import type { ModuleDecl, FuncDecl, Expr, Stmt } from '../ir'
import { UnsupportedFeatureError } from '../backend'

const GLSL_RESERVED: ReadonlySet<string> = new Set([
  'input',
  'output',
  'in',
  'out',
  'inout',
  'attribute',
  'varying',
  'uniform',
  'buffer',
  'shared',
  'coherent',
  'volatile',
  'restrict',
  'readonly',
  'writeonly',
  'atomic_uint',
  'layout',
  'centroid',
  'flat',
  'smooth',
  'noperspective',
  'patch',
  'sample',
  'subroutine',
  'precision',
  'invariant',
  'precise',
  'common',
  'partition',
  'active',
  'asm',
  'class',
  'union',
  'enum',
  'typedef',
  'template',
  'this',
  'packed',
  'resource',
  'goto',
  'inline',
  'noinline',
  'public',
  'static',
  'extern',
  'external',
  'interface',
  'long',
  'short',
  'half',
  'fixed',
  'unsigned',
  'superp',
  'filter',
  'sizeof',
  'cast',
  'namespace',
  'using',
  'sampler',
  'sampler2D',
  'sampler3D',
  'samplerCube',
  'texture',
])

/** Rename any param/local-var identifier that collides with a GLSL reserved word
 *  (and every reference to it), per-function, returning a new module. Identity for
 *  a module with no collisions. Struct fields + binding names are untouched. */
export function sanitizeReservedIdents(m: ModuleDecl): ModuleDecl {
  const collectDeclNames = (body: readonly Stmt[], acc: Set<string>): void => {
    for (const s of body) {
      if (s.s === 'let' || s.s === 'var') acc.add(s.name)
      if (s.s === 'for') {
        collectDeclNames([s.init], acc)
        collectDeclNames(s.body, acc)
      }
      if (s.s === 'if') {
        s.arms.forEach((a) => collectDeclNames(a.body, acc))
        if (s.elseBody) collectDeclNames(s.elseBody, acc)
      }
      if (s.s === 'switch') {
        s.cases.forEach((c) => collectDeclNames(c.body, acc))
        if (s.defaultBody) collectDeclNames(s.defaultBody, acc)
      }
    }
  }
  const rewriteFunc = (f: FuncDecl): FuncDecl => {
    const names = new Set<string>(f.params.map((p) => p.name))
    collectDeclNames(f.body, names)
    const map = new Map<string, string>()
    for (const n of names) {
      if (!GLSL_RESERVED.has(n)) continue
      let safe = n + '_'
      while (GLSL_RESERVED.has(safe) || names.has(safe) || [...map.values()].includes(safe))
        safe += '_'
      map.set(n, safe)
    }
    if (map.size === 0) return f
    const rn = (n: string) => map.get(n) ?? n
    const rE = (e: Expr): Expr => {
      switch (e.op) {
        case 'param':
        case 'varref':
          return map.has(e.name) ? { ...e, name: rn(e.name) } : e
        case 'binop':
          return { ...e, a: rE(e.a), b: rE(e.b) }
        case 'compare':
          return { ...e, a: rE(e.a), b: rE(e.b) }
        case 'logical':
          return { ...e, a: rE(e.a), b: rE(e.b) }
        case 'unop':
          return { ...e, a: rE(e.a) }
        case 'call':
          return { ...e, args: e.args.map(rE) }
        case 'construct':
          return { ...e, args: e.args.map(rE) }
        case 'member':
          return { ...e, base: rE(e.base) }
        case 'index':
          return { ...e, base: rE(e.base), idx: rE(e.idx) }
        case 'select':
          return { ...e, cond: rE(e.cond), ifTrue: rE(e.ifTrue), ifFalse: rE(e.ifFalse) }
        case 'matchExpr':
          return {
            ...e,
            scrutinee: rE(e.scrutinee),
            cases: e.cases.map(([v, x]) => [v, rE(x)] as const),
            default: rE(e.default),
          }
        default:
          return e // lit / constref
      }
    }
    const rS = (s: Stmt): Stmt => {
      switch (s.s) {
        case 'let':
          return { ...s, name: rn(s.name), expr: rE(s.expr) }
        case 'var':
          return { ...s, name: rn(s.name), init: s.init !== undefined ? rE(s.init) : undefined }
        case 'assign':
          return { ...s, target: rE(s.target), expr: rE(s.expr) }
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
          return s // break / continue / discard / placeholder / raw
      }
    }
    return {
      ...f,
      params: f.params.map((p) => (map.has(p.name) ? { ...p, name: rn(p.name) } : p)),
      body: f.body.map(rS),
    }
  }
  const locallyClean = { ...m, funcs: m.funcs.map(rewriteFunc) }

  // #763 P6 — module-level surfaces the per-fn pass could not cover:
  // (a) BINDING names reach GLSL verbatim as UBO/texture identifiers; renaming
  //     one would desync the host's reflection-driven bind points → fail loud.
  for (const b of m.bindings) {
    if (GLSL_RESERVED.has(b.name)) {
      throw new UnsupportedFeatureError(
        `glsl-es300: binding '${b.name}' is a GLSL reserved word — renaming would break reflection-driven binding; pick another name`,
      )
    }
  }
  // (b) FN names: a helper named `texture`/`filter` emitted a reserved-word
  //     function declaration. Rename the declaration AND every call site.
  const fnRename = new Map<string, string>()
  const taken = new Set(locallyClean.funcs.map((f) => f.name))
  for (const f of locallyClean.funcs) {
    if (!GLSL_RESERVED.has(f.name)) continue
    let safe = f.name + '_'
    while (GLSL_RESERVED.has(safe) || taken.has(safe)) safe += '_'
    taken.add(safe)
    fnRename.set(f.name, safe)
  }
  if (fnRename.size === 0) return locallyClean
  const rcE = (e: Expr): Expr => {
    const base: Expr = e.op === 'call' && fnRename.has(e.fn) ? { ...e, fn: fnRename.get(e.fn)! } : e
    switch (base.op) {
      case 'binop':
        return { ...base, a: rcE(base.a), b: rcE(base.b) }
      case 'compare':
        return { ...base, a: rcE(base.a), b: rcE(base.b) }
      case 'logical':
        return { ...base, a: rcE(base.a), b: rcE(base.b) }
      case 'unop':
        return { ...base, a: rcE(base.a) }
      case 'call':
        return { ...base, args: base.args.map(rcE) }
      case 'construct':
        return { ...base, args: base.args.map(rcE) }
      case 'member':
        return { ...base, base: rcE(base.base) }
      case 'index':
        return { ...base, base: rcE(base.base), idx: rcE(base.idx) }
      case 'select':
        return {
          ...base,
          cond: rcE(base.cond),
          ifTrue: rcE(base.ifTrue),
          ifFalse: rcE(base.ifFalse),
        }
      case 'matchExpr':
        return {
          ...base,
          scrutinee: rcE(base.scrutinee),
          cases: base.cases.map(([v, x]) => [v, rcE(x)] as const),
          default: rcE(base.default),
        }
      default:
        return base
    }
  }
  const rcS = (s: Stmt): Stmt => {
    switch (s.s) {
      case 'let':
        return { ...s, expr: rcE(s.expr) }
      case 'var':
        return s.init !== undefined ? { ...s, init: rcE(s.init) } : s
      case 'assign':
        return { ...s, target: rcE(s.target), expr: rcE(s.expr) }
      case 'assignOp':
        return { ...s, target: rcE(s.target), expr: rcE(s.expr) }
      case 'return':
        return s.expr !== undefined ? { ...s, expr: rcE(s.expr) } : s
      case 'if':
        return {
          ...s,
          arms: s.arms.map((a) => ({ cond: rcE(a.cond), body: a.body.map(rcS) })),
          elseBody: s.elseBody?.map(rcS),
        }
      case 'for':
        return {
          ...s,
          init: rcS(s.init),
          cond: rcE(s.cond),
          update: rcS(s.update),
          body: s.body.map(rcS),
        }
      case 'switch':
        return {
          ...s,
          scrut: rcE(s.scrut),
          cases: s.cases.map((c) => ({ value: c.value, body: c.body.map(rcS) })),
          defaultBody: s.defaultBody?.map(rcS),
        }
      default:
        return s
    }
  }
  return {
    ...locallyClean,
    funcs: locallyClean.funcs.map((f) => ({
      ...f,
      name: fnRename.get(f.name) ?? f.name,
      body: f.body.map(rcS),
    })),
  }
}
