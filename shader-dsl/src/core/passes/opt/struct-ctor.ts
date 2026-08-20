// ═══ Shader DSL — write-once struct local → constructor (Optimization context) ═══
//
// Collapses the shape an ioStruct body authors with `Out.var()` + field assigns +
// `return o.$`:
//
//   var _v1: VsOut;                       →   return VsOut(
//   _v1.pos = vec4(_v0, 0.0, 1.0);        →     vec4(_v0, 0.0, 1.0),
//   _v1.uv  = vec2(…);                    →     vec2(…));
//   return _v1;
//
// The local is a value being assembled, not a variable: every field is written once
// and nothing reads the aggregate before the return, so the constructor says the same
// thing with no storage. This is an IR fact, not a spelling one — the mutable-`var`
// shape reaches BOTH writers identically (see the `var out: FragmentOutput` in any
// emitted WGSL), which is why it is fixed here rather than in a backend. WGSL gets the
// shorter return; GLSL additionally stops emitting the struct at all, because its
// entry writer scatters a CONSTRUCTOR exit field-by-field (#1867) and the type then
// has no spelling left for the decl to be needed by.
//
// VALUE-SAFE by construction: the field expressions are carried over verbatim and in
// order, and a constructor evaluates its arguments in the same order the assignments
// ran. No expression moves across anything — see the contiguity rule below, which is
// what makes that claim hold rather than merely be likely.
//
// CONSERVATIVE EXCLUSIONS (each is a real shape in this repo, not a hypothetical):
//   • a MUTATED aggregate — `out.color.w = out.color.w * …` reads the field back, so
//     the polygon fragment entries keep their `var` (a nested member target is the
//     tell, and it disqualifies);
//   • a partially-written aggregate — a ctor must supply every field;
//   • a `raw` body, whose text can touch the local invisibly, as in every other pass.

import type { Expr, Stmt, ModuleDecl, FuncDecl, StructDecl } from '../../ir/index.js'
import { bodyHasRaw } from './expr-utils.js'
import { mapExpr } from './ir-transform.js'

/** Does any expression in `s` (nested blocks included) mention `name`? */
function mentions(stmts: readonly Stmt[], name: string): boolean {
  let found = false
  const see = (e: Expr): Expr => {
    if ((e.op === 'varref' || e.op === 'param') && e.name === name) found = true
    return e
  }
  const walk = (list: readonly Stmt[]): void => {
    for (const s of list) {
      switch (s.s) {
        case 'if':
          for (const a of s.arms) {
            mapExpr(a.cond, see)
            walk(a.body)
          }
          if (s.elseBody) walk(s.elseBody)
          break
        case 'for':
          walk([s.init])
          mapExpr(s.cond, see)
          walk([s.update])
          walk(s.body)
          break
        case 'switch':
          mapExpr(s.scrut, see)
          for (const c of s.cases) walk(c.body)
          if (s.defaultBody) walk(s.defaultBody)
          break
        case 'let':
          mapExpr(s.expr, see)
          break
        case 'var':
          if (s.init !== undefined) mapExpr(s.init, see)
          break
        case 'assign':
        case 'assignOp':
          mapExpr(s.target, see)
          mapExpr(s.expr, see)
          break
        case 'return':
          if (s.expr !== undefined) mapExpr(s.expr, see)
          break
        default:
          break
      }
    }
  }
  walk(stmts)
  return found
}

/** `name`'s field if `e` is exactly `<name>.<field>` — not a deeper path, which would
 *  mean the aggregate is being read back rather than assembled. */
function directField(e: Expr, name: string): string | undefined {
  if (e.op !== 'member') return undefined
  const b = e.base
  if ((b.op !== 'varref' && b.op !== 'param') || b.name !== name) return undefined
  return e.field
}

/** Rewrite one fn, or return it unchanged. */
function collapseFn(f: FuncDecl, structs: ReadonlyMap<string, StructDecl>): FuncDecl {
  if (bodyHasRaw(f.body)) return f
  const body = f.body
  const last = body[body.length - 1]
  if (last?.s !== 'return' || last.expr === undefined) return f
  const ret = last.expr
  if (ret.op !== 'varref' && ret.op !== 'param') return f
  const name = ret.name

  const decl = structs.get(ret.type.kind === 'struct' ? ret.type.name : '')
  if (decl === undefined || decl.fields.length === 0) return f

  // Walk BACK from the return over a contiguous run of `<name>.<field> = expr`. Contiguity
  // is what makes the value claim hold with no dataflow analysis: nothing but these
  // assignments separates a field's expression from the constructor that will hold it,
  // and none of them writes anything an expression here reads (the aggregate is proven
  // read-free below).
  const byField = new Map<string, Expr>()
  let i = body.length - 2
  for (; i >= 0; i--) {
    const s = body[i]!
    if (s.s !== 'assign') break
    const fld = directField(s.target, name)
    if (fld === undefined || byField.has(fld)) break
    byField.set(fld, s.expr)
  }
  if (byField.size !== decl.fields.length) return f // partial — a ctor needs every field
  if (!decl.fields.every((sf) => byField.has(sf.name))) return f

  // The declaration must be an uninitialised `var` of that struct, and nothing outside
  // the run may mention the local — a single read would make this a real variable.
  const declAt = body.findIndex((s) => s.s === 'var' && s.name === name)
  if (declAt < 0 || declAt >= i + 1) return f
  const d = body[declAt]!
  if (d.s !== 'var' || d.init !== undefined) return f
  const outside = [...body.slice(0, declAt), ...body.slice(declAt + 1, i + 1)]
  if (mentions(outside, name)) return f

  const args = decl.fields.map((sf) => byField.get(sf.name)!)
  return {
    ...f,
    body: [
      ...body.slice(0, declAt),
      ...body.slice(declAt + 1, i + 1),
      { s: 'return', expr: { op: 'construct', type: ret.type, args } },
    ],
  }
}

/** Collapse every write-once struct local that is only ever assembled and returned. */
export function structCtor(m: ModuleDecl): ModuleDecl {
  const structs = new Map(m.structs.map((s) => [s.name, s]))
  if (structs.size === 0) return m
  return { ...m, funcs: m.funcs.map((f) => collapseFn(f, structs)) }
}
