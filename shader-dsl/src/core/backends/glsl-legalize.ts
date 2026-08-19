// ═══ Shader DSL — GLSL ES 3.00 legalisation: no discarding call inside a struct ctor ═══
//
// ANGLE's D3D11 backend MISCOMPILES a GLSL ES 3.00 fragment shader whose STRUCT
// constructor argument contains a call to a function that (transitively) executes
// `discard`. It is silent: `COMPILE_STATUS` and `LINK_STATUS` both report success and
// the program dies at the FIRST DRAW. #1840's repro table pins the shape exactly —
// cases A (`return Out(inner(v));`), D (a nested struct ctor) and G (a multi-field ctor
// with one offending argument) FAIL, while B (`vec4 c = inner(v); return Out(c);`),
// C/E (a VECTOR constructor around the same call) and F (the call as a plain statement
// value) PASS. B is the fix: a NAMED LOCAL for the argument, which is all this pass
// synthesises.
//
// WHY THE DSL EMITS THE BAD SHAPE AT ALL: a single-use authored `const` never exists as
// an IR statement (CSE materialises a temp only at ≥2 uses), so a discarding call
// written once is born inline in the `construct` argument and emit.ts spells
// `StructName(call(...))`.
//
// GLSL-LOCAL, deliberately. WGSL/Tint compile the same shape correctly, and the WGSL
// golden corpus is byte-gated — a shared pass would churn those bytes for a bug that
// does not exist on that target. So this lives beside glsl-sanitize.ts and is called
// from ONE choke point (lowerForGlsl), which covers emitGlslModule / emitGlslFragment /
// emitGlslStages and nothing else.
//
// PLACEMENT — AFTER the optimizer fixpoint, before sanitize/mangle. Nothing downstream
// can undo the hoist: `copyProp` propagates only copies of leaf values and never a call
// RHS (a call may have side effects and duplicating it would duplicate the discard), and
// `dce` keeps any `let` that is read. Running it after `lowerComputeToFragment` also
// matters — that lowering MINTS `{s:'discard'}` (glsl.ts, the bounds-guard early-out),
// so the analysis below sees those discards too.
//
// TRANSITIVITY IS MANDATORY, not a nicety. The opt-in `inline()` plugin (emit-prod)
// runs in the IR plugin stage, which is AFTER this pass, and substitutes single-return
// wrappers at their call sites. A non-transitive analysis would wave `S(wrapper(x))`
// through, and `inline()` would then rebuild `S(discardingFn(x))` — in PRODUCTION builds
// only. `transitivelyDiscardingFns` is the single authority for the predicate so that
// cannot happen.
//
// DOCUMENTED UNDER-FIXES (each fails toward the status quo, never toward a wrong value):
//   • GUARDED positions are left untouched — a `select` arm, a `logical` (`&&`/`||`)
//     operand, and loop/branch headers. GLSL spells `select` as a short-circuiting
//     TERNARY, so hoisting an arm would turn a conditional discard into an unconditional
//     one: a correctness regression strictly worse than the bug. A struct ctor nested
//     inside such a position therefore keeps its inline call. (The `logical` LHS is in
//     fact unconditional and could be processed; the whole node is skipped instead,
//     because one rule is easier to keep true than two.)
//   • Functions carrying a `raw` statement are skipped whole (the repo-wide convention —
//     raw text is opaque to every IR walk, so neither the discard seed nor the call
//     edges are trustworthy there).
//   • A callee that is not a module function — an intrinsic, an `externFn`, a df64
//     helper — simply misses the name map and counts as NON-discarding. None of them
//     can execute `discard` today.
//
// ORTHOGONAL, PRE-EXISTING, NOT ADDRESSED HERE: WGSL's `select` evaluates BOTH arms
// while the GLSL ternary short-circuits, so a side-effecting arm already means something
// different on the two targets. That asymmetry predates this pass and is untouched by it.

import type { ModuleDecl, FuncDecl, Expr, Stmt } from '../ir/index.js'
import { collectFnRefs } from '../ir/collect-refs.js'
import { bodyHasRaw, collectLocals } from '../passes/opt/expr-utils.js'

/** True iff `body` — nested if/for/switch blocks included — contains a `discard`. */
function bodyHasDiscard(body: readonly Stmt[]): boolean {
  for (const s of body) {
    if (s.s === 'discard') return true
    if (s.s === 'if') {
      if (s.arms.some((a) => bodyHasDiscard(a.body))) return true
      if (s.elseBody && bodyHasDiscard(s.elseBody)) return true
    } else if (s.s === 'for') {
      if (bodyHasDiscard(s.body)) return true
    } else if (s.s === 'switch') {
      if (s.cases.some((c) => bodyHasDiscard(c.body))) return true
      if (s.defaultBody && bodyHasDiscard(s.defaultBody)) return true
    }
  }
  return false
}

/** The names of every module function that can execute a `discard` — directly or through
 *  any call chain. THE authority for the predicate (see the header's transitivity note).
 *
 *  Fixed point over the call graph: seed with the functions whose own body holds a
 *  `discard`, then repeatedly admit any function calling one already admitted. Call edges
 *  are resolved by NAME against `m.funcs` — never through `Expr.declRef`, which nodes.ts
 *  documents as a collection-time convenience that pass rewrites drop freely. A callee
 *  with no entry in that map (intrinsic / extern / df64) counts as non-discarding.
 *
 *  A `raw`-carrying function is NOT excluded here — its IR-visible discards and call edges
 *  still count, so a caller of one can still be legalised. Only the REWRITE skips raw (see
 *  `hoistDiscardingCtorArgs`): what raw text adds is invisible either way, and dropping the
 *  visible half too would only shrink the set. */
export function transitivelyDiscardingFns(m: ModuleDecl): ReadonlySet<string> {
  const byName = new Map(m.funcs.map((f) => [f.name, f]))
  const callsOf = new Map(m.funcs.map((f) => [f.name, collectFnRefs(f).calls]))
  const discarding = new Set<string>()
  for (const f of m.funcs) if (bodyHasDiscard(f.body)) discarding.add(f.name)
  let grew = true
  while (grew) {
    grew = false
    for (const f of m.funcs) {
      if (discarding.has(f.name)) continue
      for (const callee of callsOf.get(f.name) ?? []) {
        if (!byName.has(callee) || !discarding.has(callee)) continue
        discarding.add(f.name)
        grew = true
        break
      }
    }
  }
  return discarding
}

/** True iff `e` calls a transitively-discarding function anywhere in its subtree. Walks
 *  guarded operands too: the QUESTION is whether the argument carries the offending call,
 *  and hoisting the whole argument moves its guard along with it. */
function callsDiscarding(e: Expr, discarding: ReadonlySet<string>): boolean {
  if (e.op === 'call' && discarding.has(e.fn)) return true
  switch (e.op) {
    case 'binop':
    case 'compare':
    case 'logical':
      return callsDiscarding(e.a, discarding) || callsDiscarding(e.b, discarding)
    case 'unop':
      return callsDiscarding(e.a, discarding)
    case 'call':
    case 'construct':
      return e.args.some((a) => callsDiscarding(a, discarding))
    case 'member':
      return callsDiscarding(e.base, discarding)
    case 'index':
      return callsDiscarding(e.base, discarding) || callsDiscarding(e.idx, discarding)
    case 'select':
      return (
        callsDiscarding(e.cond, discarding) ||
        callsDiscarding(e.ifTrue, discarding) ||
        callsDiscarding(e.ifFalse, discarding)
      )
    case 'matchExpr':
      return (
        callsDiscarding(e.scrutinee, discarding) ||
        e.cases.some(([, v]) => callsDiscarding(v, discarding)) ||
        callsDiscarding(e.default, discarding)
      )
    default:
      return false // lit / constref / overrideref / externref / param / varref
  }
}

/** Rewrite the value side of a simple statement (an lvalue `target` is never a value). */
function mapStmtValue(s: Stmt, f: (e: Expr) => Expr): Stmt {
  switch (s.s) {
    case 'let':
      return { ...s, expr: f(s.expr) }
    case 'var':
      return s.init !== undefined ? { ...s, init: f(s.init) } : s
    case 'assign':
    case 'assignOp':
      return { ...s, expr: f(s.expr) }
    case 'return':
      return s.expr !== undefined ? { ...s, expr: f(s.expr) } : s
    default:
      return s
  }
}

function hoistFn(f: FuncDecl, discarding: ReadonlySet<string>): FuncDecl {
  if (bodyHasRaw(f.body)) return f
  const refs = collectFnRefs(f)
  if (![...refs.calls].some((c) => discarding.has(c))) return f

  // Seed the temp index past any existing `_dhN` param/local so a re-run cannot redeclare
  // `_dh0` (same idiom as cse.ts / cse-local.ts). ONE leading underscore — GLSL ES reserves
  // the double one.
  const names = new Set<string>(f.params.map((p) => p.name))
  collectLocals(f.body, names)
  let base = 0
  for (const n of names) {
    const mm = /^_dh(\d+)$/.exec(n)
    if (mm) base = Math.max(base, Number(mm[1]) + 1)
  }
  const next = { n: base }

  // BOTTOM-UP: children are rewritten before their parent, so a nested `Out(Inner(g(x)))`
  // hoists only the INNERMOST offending argument and the outer ctor then holds a temp, not
  // a call. Guarded operands (select arms, logical operands, matchExpr arms) are returned
  // untouched — see the header's under-fix note.
  const rewrite = (e: Expr, pending: Stmt[]): Expr => {
    const r = ((): Expr => {
      switch (e.op) {
        case 'binop':
        case 'compare':
          return { ...e, a: rewrite(e.a, pending), b: rewrite(e.b, pending) }
        case 'unop':
          return { ...e, a: rewrite(e.a, pending) }
        case 'call':
          return { ...e, args: e.args.map((a) => rewrite(a, pending)) }
        case 'construct':
          return { ...e, args: e.args.map((a) => rewrite(a, pending)) }
        case 'member':
          return { ...e, base: rewrite(e.base, pending) }
        case 'index':
          return { ...e, base: rewrite(e.base, pending), idx: rewrite(e.idx, pending) }
        default:
          return e // leaf, or a GUARDED node (logical / select / matchExpr) left whole
      }
    })()
    if (r.op !== 'construct' || r.type.kind !== 'struct') return r
    return {
      ...r,
      args: r.args.map((a) => {
        if (!callsDiscarding(a, discarding)) return a
        const name = `_dh${next.n++}`
        pending.push({ s: 'let', name, expr: a })
        return { op: 'varref', type: a.type, name }
      }),
    }
  }

  // Each block is its own splice context: a statement inside a branch is unconditional
  // WITHIN that branch, so its temp belongs in the branch, immediately before it.
  const processBody = (body: readonly Stmt[]): Stmt[] => {
    const out: Stmt[] = []
    for (const s of body) {
      const rec = recurseBlocks(s)
      const pending: Stmt[] = []
      const stmt = mapStmtValue(rec, (e) => rewrite(e, pending))
      out.push(...pending, stmt)
    }
    return out
  }

  // Control-flow HEADERS (if arm conds, for init/cond/update, switch scrut) are not value
  // positions this pass may splice before — only the nested bodies are processed.
  const recurseBlocks = (s: Stmt): Stmt => {
    switch (s.s) {
      case 'if':
        return {
          ...s,
          arms: s.arms.map((a) => ({ cond: a.cond, body: processBody(a.body) })),
          elseBody: s.elseBody ? processBody(s.elseBody) : undefined,
        }
      case 'for':
        return { ...s, body: processBody(s.body) }
      case 'switch':
        return {
          ...s,
          cases: s.cases.map((c) => ({ value: c.value, body: processBody(c.body) })),
          defaultBody: s.defaultBody ? processBody(s.defaultBody) : undefined,
        }
      default:
        return s
    }
  }

  return { ...f, body: processBody(f.body) }
}

/** Bind every struct-constructor argument that carries a transitively-discarding call to a
 *  fresh `_dhN` local declared immediately before its statement, and pass the local to the
 *  constructor instead (#1840). Pure (module → module); IDENTITY for a module in which
 *  nothing discards, so a discard-free module emits byte-for-byte what it always did. */
export function hoistDiscardingCtorArgs(m: ModuleDecl): ModuleDecl {
  const discarding = transitivelyDiscardingFns(m)
  if (discarding.size === 0) return m
  return { ...m, funcs: m.funcs.map((f) => hoistFn(f, discarding)) }
}
