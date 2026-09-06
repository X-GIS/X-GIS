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

import type { ModuleDecl, FuncDecl, Expr, Stmt } from '../ir/index.js'
import { mapChildren, mapStmtExpr } from '../ir/visit.js'
import { UnsupportedFeatureError } from '../backend.js'

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
  'texture',
  // ── sampler types (GLSL ES 3.00 §3.7) ──
  // The float 2D/3D/Cube trio was all this list carried, which dates it to the ES 1.00
  // era. Every spelling below is a KEYWORD in ES 3.00, so a DSL local or param named
  // `usampler2D` emitted `float usampler2D = …` and died on the driver. The gate in
  // glsl.test.ts ties this set to what glslType() can actually declare, so a new texture
  // shape cannot reopen the gap (#1703).
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
    const rE = (e: Expr): Expr =>
      (e.op === 'param' || e.op === 'varref') && map.has(e.name)
        ? { ...e, name: rn(e.name) }
        : mapChildren(e, rE)
    // `let` / `var` also DECLARE a name, which the shared rewrite (Exprs only)
    // cannot reach — handle those two here and delegate the rest of the shape.
    const rS = (s: Stmt): Stmt => {
      switch (s.s) {
        case 'let':
          return { ...s, name: rn(s.name), expr: rE(s.expr) }
        case 'var':
          return {
            ...s,
            name: rn(s.name),
            ...(s.init !== undefined ? { init: rE(s.init) } : {}),
          }
        default:
          return mapStmtExpr(s, rE, rS)
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
  const rcE = (e: Expr): Expr =>
    mapChildren(e.op === 'call' && fnRename.has(e.fn) ? { ...e, fn: fnRename.get(e.fn)! } : e, rcE)
  const rcS = (s: Stmt): Stmt => mapStmtExpr(s, rcE)
  return {
    ...locallyClean,
    funcs: locallyClean.funcs.map((f) => ({
      ...f,
      name: fnRename.get(f.name) ?? f.name,
      body: f.body.map(rcS),
    })),
  }
}
