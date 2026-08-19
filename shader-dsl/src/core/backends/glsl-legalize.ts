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
// PLACEMENT — LAST in the GLSL IR chain (glsl.ts `lowerForGlsl`): after the optimizer
// fixpoint, after `sanitizeReservedIdents`, after `lowerHostLooseBlocks`, and after
// `applyIRPlugins`. The module this pass returns IS the module `assembleGlsl` spells, so
// the guarantee below holds over the FINAL IR BY CONSTRUCTION: there is no later
// transformation that could reintroduce the fatal shape — not a third-party
// `EmitPlugin.transformIR`, not the opt-in `inline()`. Running last also keeps the older
// reasons intact: `lowerComputeToFragment` MINTS `{s:'discard'}` (glsl.ts, the bounds-guard
// early-out) and `fp64Lower`/`lowerModule` rewrite whole expression trees — all of them are
// upstream, so the analysis sees the discards and the ctors they actually leave behind.
//
// The `_dhN` names are safe at this position. `mangleModule` (emit-prod) mints base-52
// LETTERS-ONLY identifiers and `sanitizeReservedIdents` only ever suffixes a GLSL reserved
// word, so neither can produce a `_dhN`; `hoistFn` additionally seeds its counter past any
// pre-existing `_dhN` param/local. Determinism is unchanged: the module is lowered ONCE per
// emit and `emitGlslStages` shares that single lowering across both stages, so the two
// stages agree on every shared name.
//
// TRANSITIVITY IS STILL MANDATORY. `inline()` now runs BEFORE this pass, but it inlines
// only what it can — control-flow bodies, the df64 library, entry points and recursive fns
// are all left intact — so every wrapper it declines to inline still reaches assembly as a
// call, and in a plugin-free build EVERY wrapper does. A non-transitive analysis would wave
// `S(wrapper(x))` through in exactly those cases. `transitivelyDiscardingFns` is the single
// authority for the predicate.
//
// THE INVARIANT: after legalization, no unconditionally-evaluated struct-constructor
// argument contains a (transitively) discarding call — with ONE carve-out, a `for` header's
// `cond`/`update`, which is excluded not for being guarded but for being evaluated REPEATEDLY
// (see the second under-fix below).
//
// DOCUMENTED UNDER-FIXES (each fails toward the status quo, never toward a wrong value):
//   • CONDITIONALLY-EVALUATED positions are left untouched, and that is now exactly one
//     list: an `else if` condition (`arms[i>=1]`, reached only when every prior condition was
//     false), a `select` ARM, and the RHS of a `logical` (`&&`/`||`). Each runs only when
//     something upstream of it decided so, so hoisting one before the enclosing statement
//     would turn a conditional discard into an unconditional one: a correctness regression
//     strictly worse than the bug. A struct ctor nested inside one of them therefore keeps
//     its inline call. Their unconditional siblings — arm 0's condition, the `select` COND,
//     the `logical` LHS — are all legalised, which is why those three do NOT appear here.
//   • A `for` header's `cond`/`update` is excluded for a DIFFERENT reason: not guarding, but
//     REPEATED evaluation. Both run once per iteration, so hoisting either before the loop
//     would collapse N evaluations into one — wrong independent of any discard, and wrong in
//     a way the discard bug does not justify. This is the one place the fatal shape can
//     survive legalization, and it is not reachable from any in-repo shader: of the 39 `for`
//     headers across the three baked GLSL artifacts, none contains a struct constructor (an
//     uppercase-named call is the only spelling one has in emitted GLSL). The `for` INIT —
//     which runs exactly once, before the loop — IS legalised.
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

/** Rewrite the r-value subexpressions INSIDE an assignment target. An lvalue is never a value
 *  — `f` is NOT applied to the target as a whole, because replacing a `varref`/`member` chain
 *  with a temp would stop it being assignable — but an index chain's `idx` operands ARE
 *  ordinary r-values, evaluated once and unconditionally when the assignment executes, so
 *  hoisting one before the statement is evaluation-order-identical (every expression here is
 *  pure but for the discard signal). Walks the chain: `member` recurses into its base only,
 *  `index` recurses into its base AND rewrites its `idx`; the root (varref/param) is left. */
function mapTargetIndices(t: Expr, f: (e: Expr) => Expr): Expr {
  switch (t.op) {
    case 'member':
      return { ...t, base: mapTargetIndices(t.base, f) }
    case 'index':
      return { ...t, base: mapTargetIndices(t.base, f), idx: f(t.idx) }
    default:
      return t // the chain's root — a varref or a param
  }
}

/** Rewrite every UNCONDITIONALLY-evaluated value position of one statement (an lvalue
 *  `target` is never a value, but its INDEX subexpressions are — see `mapTargetIndices`).
 *  "Unconditional" is relative to the statement executing at all: whenever this statement
 *  runs, each position below is evaluated exactly once, so a temp spliced immediately BEFORE
 *  the statement is evaluation-order-identical. Control-flow headers are included where —
 *  and only where — that holds. */
function mapStmtValue(s: Stmt, f: (e: Expr) => Expr): Stmt {
  switch (s.s) {
    case 'let':
      return { ...s, expr: f(s.expr) }
    case 'var':
      return s.init !== undefined ? { ...s, init: f(s.init) } : s
    case 'assign':
    case 'assignOp':
      // Target first, then the value — both hoist before the statement, and this is the
      // left-to-right reading order. Which fires first only matters when BOTH sides discard,
      // and GLSL leaves an assignment's operand order unspecified anyway.
      return { ...s, target: mapTargetIndices(s.target, f), expr: f(s.expr) }
    case 'return':
      return s.expr !== undefined ? { ...s, expr: f(s.expr) } : s
    case 'if':
      // ONLY arm 0. Its condition is evaluated whenever the `if` executes. Every later arm
      // is an `else if`, reached only when all prior conditions were false — hoisting one
      // before the `if` would evaluate it unconditionally, so those are left inline.
      return s.arms.length === 0
        ? s
        : { ...s, arms: s.arms.map((a, i) => (i === 0 ? { ...a, cond: f(a.cond) } : a)) }
    case 'switch':
      // The scrutinee is evaluated whenever the `switch` executes.
      return { ...s, scrut: f(s.scrut) }
    case 'for':
      // The INIT statement only: a var/assign executed exactly once, before the loop, so a
      // hoist before the `for` is evaluation-order-identical. `cond` and `update` run PER
      // ITERATION — hoisting out of either would collapse N evaluations into one before the
      // loop, which is wrong regardless of any discard, so both are left inline.
      return { ...s, init: mapStmtValue(s.init, f) }
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
  // a call. `rewrite` is only ever ENTERED from an unconditional position (mapStmtValue) and
  // only ever descends into unconditional children, so every node it reaches is evaluated
  // exactly once whenever its statement runs — which is what makes a temp spliced before the
  // statement evaluation-order-identical. The GUARDED halves below are where it stops.
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
        case 'logical':
          // `&&`/`||` are HALF unconditional: the LHS is evaluated whenever the node is, the
          // RHS only when the LHS did not short-circuit. Descend the LHS, leave the RHS whole.
          return { ...e, a: rewrite(e.a, pending), b: e.b }
        case 'select':
          // Same split, spelled as a GLSL ternary: the condition is evaluated whenever the
          // node is, each arm only when chosen. Descend the cond, leave both arms whole.
          return { ...e, cond: rewrite(e.cond, pending), ifTrue: e.ifTrue, ifFalse: e.ifFalse }
        default:
          return e // leaf, or a matchExpr (never present post-`lowerModule`) left whole
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

  // The nested-BODY half of a control-flow statement. Composes with `mapStmtValue`, which
  // owns the HEADER half: `processBody` runs this first and then maps the value positions
  // of the result, so an `if` gets both its arm bodies processed here and its arm-0
  // condition rewritten there, with the condition's temps threading into the OUTER pending
  // list (they must land before the `if`, not inside an arm).
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
