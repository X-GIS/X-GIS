// ═══ Shader DSL — linear (multi-statement) function inlining ═══
//
// Extends `inlineFn` (single-return-EXPRESSION only) to SINGLE-EXIT helpers: a
// body that is any number of statements followed by exactly one trailing
// `return e`. `noise() { let i = …; let f = …; return mix(…) }` is the simplest
// shape; the prelude may also contain `if`/`for`/`switch`, because the lift
// splices it into the CALL SITE's own block, so a branch stays a branch and a
// loop stays a loop. `fp64-mandelbrot`'s `escape_f32`/`escape_f64` — vars, a
// bounded escape loop, one trailing return — are the reason that matters: they
// are the shader's actual algorithm, and leaving them standing while the generic
// df64 library was flattened defeated the point of an obfuscation pass.
// `preludeBlocker` lists what the prelude may NOT contain and why.
// ("LINEAR" survives in this file's and `inlineLinearAll`'s names for API
// stability; SINGLE-EXIT is the real condition.) Inlining such a body into an
// expression position is done by
// LIFTING: the helper's prelude statements (with its locals freshly renamed and
// its params bound to temps) are spliced into the caller's block immediately
// before the statement that contains the call, and the call is replaced by a
// varref to a temp holding the (substituted) return expression.
//
// WHY IT'S VALUE-SAFE. Shader code is pure — no I/O, no observable evaluation
// order. So hoisting a pure sub-expression's computation earlier in the same
// block (or ahead of an `if`/`switch` it fed) cannot change any result; at most
// it computes a value a branch won't use, which is unobservable. That is the
// whole license for this transform, and it's why the CONSERVATIVE exclusions
// below are the only ones needed. It is the obfuscation counterpart of a JS
// minifier's function inlining (`@xgis/shader-dsl/emit-prod`'s `inline()`).
//
// CONSERVATIVE EXCLUSIONS (leave the function; never inline unsoundly):
//   • body isn't single-exit, or its prelude holds a statement whose meaning moves
//     with it — early return, a `break`/`continue` that would bind to the caller's
//     loop, `discard` (impure), `raw` (unreadable). See `preludeBlocker`;
//   • a call site sits in a `for` init/cond/update — lifting it out would change
//     how many times it runs;
//   • a fn marked `opaque` (the df64 EFT library — see FuncDecl.opaque), entry
//     points, recursive fns — as in autoInline.
// Everything else — calls in let/var/assign/return exprs, `if` conditions,
// `switch` scrutinees, and inside any block body — is lifted within its own
// block, so conditional execution is preserved.
//
// INLINING OWES A CLEANUP (#1860). Copying a body to N call sites RE-CREATES the
// redundancy the optimizer had already removed: every value the helper derives
// from a shared argument is now computed once PER SITE, in the caller's own
// block, where nothing has run since. `transformIR` fires AFTER `lowerForBackend`
// has run its fixpoint, so without a cleanup that duplicated arithmetic reaches
// the GPU — measured on the example corpus, raw inlining spends 1859 IR ops where
// 1676 suffice (kaleidoscope −18%, domain-warp −14%). So `inlineLinearAll` ends by
// re-running the value-hoisting passes over what it produced (`CLEANUP` below).

import { stageOf } from '../ir/index.js'
import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../ir/index.js'
import { mapExpr } from './opt/ir-transform.js'
import { bodyHasRaw } from './opt/dce.js'
import { fixpoint, LEVEL_PASSES, type OptPass } from './opt/optimize.js'
import { inlineFn } from './inline.js'

const isEntry = (f: FuncDecl): boolean => stageOf(f) !== undefined

/** Why a prelude cannot be lifted, or undefined if it can.
 *
 *  `let`/`var`/`assign`/`assignOp` are the straight-line core. `if`/`for`/`switch`
 *  are admitted TOO: lifting splices the prelude into the call site's OWN block,
 *  so a branch stays a branch and a loop stays a loop — neither conditional nor
 *  repeated execution moves. What is refused is a statement whose MEANING depends
 *  on where it sits, or that is not pure:
 *
 *   • `return` — a second exit. The lift binds ONE trailing expression to a temp;
 *     an early return would have to become a flag plus a guarded remainder, which
 *     is a different transform (and would need a result `var` rather than a `let`).
 *   • `break` / `continue` NOT enclosed by the helper's own loop/switch. After
 *     lifting they would bind to whatever loop the CALLER happens to sit in —
 *     the one way a pure body can still change the caller's control flow.
 *   • `discard` — the purity argument above is what licenses the whole transform,
 *     and `discard` is the one statement that breaks it: WGSL `||`/`&&` short-
 *     circuit, so a call lifted out of a short-circuited operand would run a
 *     discard the original skipped. (`discard-cutout`'s helper is exactly this.)
 *   • `raw` — text this pass cannot read, so it cannot be renamed or reasoned about.
 *   • `placeholder` — not a real statement yet; refuse rather than guess. */
function preludeBlocker(
  stmts: readonly Stmt[],
  loopDepth: number,
  switchDepth: number,
): string | undefined {
  for (const s of stmts) {
    switch (s.s) {
      case 'let':
      case 'var':
      case 'assign':
      case 'assignOp':
        break
      case 'if': {
        for (const a of s.arms) {
          const b = preludeBlocker(a.body, loopDepth, switchDepth)
          if (b !== undefined) return b
        }
        const b = preludeBlocker(s.elseBody ?? [], loopDepth, switchDepth)
        if (b !== undefined) return b
        break
      }
      case 'for': {
        const b =
          preludeBlocker([s.init], loopDepth, switchDepth) ??
          preludeBlocker(s.body, loopDepth + 1, switchDepth)
        if (b !== undefined) return b
        break
      }
      case 'switch': {
        for (const c of s.cases) {
          const b = preludeBlocker(c.body, loopDepth, switchDepth + 1)
          if (b !== undefined) return b
        }
        const b = preludeBlocker(s.defaultBody ?? [], loopDepth, switchDepth + 1)
        if (b !== undefined) return b
        break
      }
      case 'return':
        return 'nested-return'
      case 'discard':
        return 'discard'
      case 'raw':
        return 'raw'
      case 'break':
        if (loopDepth === 0 && switchDepth === 0) return 'free-break'
        break
      case 'continue':
        if (loopDepth === 0) return 'free-continue'
        break
      default:
        return 'unknown-stmt'
    }
  }
  return undefined
}

/** A single-exit body split into its prelude (all statements but the trailing
 *  `return`) and that return's expression — or undefined if `f` isn't that shape.
 *  The prelude may contain control flow; see `preludeBlocker` for what it may not. */
function liftableBody(f: FuncDecl): { prelude: readonly Stmt[]; ret: Expr } | undefined {
  const body = f.body
  if (body.length === 0) return undefined
  const last = body[body.length - 1]!
  if (last.s !== 'return' || last.expr === undefined) return undefined
  const prelude = body.slice(0, -1)
  return preludeBlocker(prelude, 0, 0) === undefined ? { prelude, ret: last.expr } : undefined
}

/** Does any expression in `e` call `name`? */
function exprCallsName(e: Expr, name: string): boolean {
  let found = false
  mapExpr(e, (x) => {
    if (x.op === 'call' && x.fn === name) found = true
    return x
  })
  return found
}

/** Does statement `s` (its OWN exprs, not nested block bodies) call `name`? */
function stmtOwnExprCallsName(s: Stmt, name: string): boolean {
  switch (s.s) {
    case 'let':
      return exprCallsName(s.expr, name)
    case 'var':
      return s.init !== undefined && exprCallsName(s.init, name)
    case 'assign':
    case 'assignOp':
      return exprCallsName(s.target, name) || exprCallsName(s.expr, name)
    case 'return':
      return s.expr !== undefined && exprCallsName(s.expr, name)
    default:
      return false
  }
}

/** True if `name` is called anywhere in a `for` init/cond/update across the
 *  module — the one call-site position that isn't safely liftable. */
function calledInForHeader(m: ModuleDecl, name: string): boolean {
  let found = false
  const walk = (stmts: readonly Stmt[]): void => {
    for (const s of stmts) {
      if (s.s === 'for') {
        if (
          stmtOwnExprCallsName(s.init, name) ||
          exprCallsName(s.cond, name) ||
          stmtOwnExprCallsName(s.update, name)
        )
          found = true
        walk(s.body)
      } else if (s.s === 'if') {
        for (const a of s.arms) walk(a.body)
        if (s.elseBody) walk(s.elseBody)
      } else if (s.s === 'switch') {
        for (const c of s.cases) walk(c.body)
        if (s.defaultBody) walk(s.defaultBody)
      }
    }
  }
  for (const f of m.funcs) walk(f.body)
  return found
}

/** True if the whole module still contains a call to `name`. */
function moduleCallsName(m: ModuleDecl, name: string): boolean {
  return m.funcs.some((f) => f.body.some((s) => stmtDeepCallsName(s, name)))
}
function stmtDeepCallsName(s: Stmt, name: string): boolean {
  if (stmtOwnExprCallsName(s, name)) return true
  switch (s.s) {
    case 'if':
      return (
        s.arms.some(
          (a) => exprCallsName(a.cond, name) || a.body.some((b) => stmtDeepCallsName(b, name)),
        ) ||
        (s.elseBody?.some((b) => stmtDeepCallsName(b, name)) ?? false)
      )
    case 'for':
      return (
        stmtOwnExprCallsName(s.init, name) ||
        exprCallsName(s.cond, name) ||
        stmtOwnExprCallsName(s.update, name) ||
        s.body.some((b) => stmtDeepCallsName(b, name))
      )
    case 'switch':
      return (
        exprCallsName(s.scrut, name) ||
        s.cases.some((c) => c.body.some((b) => stmtDeepCallsName(b, name))) ||
        (s.defaultBody?.some((b) => stmtDeepCallsName(b, name)) ?? false)
      )
    default:
      return false
  }
}

/** Recursive: is `f` (single-return OR linear) a non-entry, non-df64,
 *  non-recursive, still-called helper safe to inline in every call position?
 *  `requireMultiStatement` gates the two passes so single-return goes through
 *  the simpler inlineFn first. */
function isInlinable(m: ModuleDecl, f: FuncDecl, requireMultiStatement: boolean): boolean {
  if (isEntry(f) || f.opaque === true) return false
  const lb = liftableBody(f)
  if (lb === undefined) return false
  if (requireMultiStatement !== lb.prelude.length > 0) return false
  // DEEP: a self-call inside the helper's own loop body is still recursion, and a
  // shallow check would let `inlineLinearAll` inline it into itself forever.
  if (exprCallsName(lb.ret, f.name) || lb.prelude.some((s) => stmtDeepCallsName(s, f.name)))
    return false // recursive
  if (!moduleCallsName(m, f.name)) return false // dead — leave to deadFnElim
  // multi-statement lifting is unsound only for for-header call sites.
  if (requireMultiStatement && calledInForHeader(m, f.name)) return false
  return true
}

/** Inline a linear single-exit helper at every (liftable) call site, splicing
 *  its prelude into each caller's block. `counter` is a run-global uniquifier so
 *  spliced local names never collide across inline instances (and the result is
 *  deterministic — required for the two GLSL stage emits to agree). */
export function inlineLinearFn(m: ModuleDecl, name: string, counter: { n: number }): ModuleDecl {
  const target = m.funcs.find((f) => f.name === name)
  const lb = target && liftableBody(target)
  if (!target || !lb) return m

  // Params actually referenced by the body — only those get an arg temp.
  const usedParams = new Set<string>()
  const probeParam = (e: Expr): void => {
    mapExpr(e, (x) => {
      if ((x.op === 'param' || x.op === 'varref') && target.params.some((p) => p.name === x.name))
        usedParams.add(x.name)
      return x
    })
  }
  // DEEP, not just the statement's own exprs: `escape_f32` reads `cx`/`cy` only
  // inside its loop body and `iters` only in the loop CONDITION. A shallow probe
  // leaves usedParams empty, no arg temp is bound, and `rw` then leaves the
  // `param` nodes standing in a caller that has no such parameter — a miscompile,
  // not a missed optimization.
  for (const s of lb.prelude) forEachStmtExprDeep(s, probeParam)
  probeParam(lb.ret)

  /** Replace every call to `name` in `e` with a fresh temp varref, pushing the
   *  inlined prelude + temp bindings into `lifted` (bottom-up: nested calls
   *  land first, preserving order). */
  const liftCalls = (e: Expr, lifted: Stmt[]): Expr =>
    mapExpr(e, (x) => {
      if (x.op !== 'call' || x.fn !== name) return x
      const p = `_inl${counter.n++}_`
      const subst = new Map<string, Expr>()
      target.params.forEach((param, i) => {
        if (!usedParams.has(param.name)) return
        const argTmp = `${p}a${i}`
        lifted.push({ s: 'let', name: argTmp, expr: x.args[i]! })
        subst.set(param.name, { op: 'varref', type: param.type, name: argTmp })
      })
      const localRen = new Map<string, string>()
      // `p` ends in `_` and optimizer locals start with `_` (`_cse0`, `_v0`) —
      // concatenating would form `__`, which GLSL ES reserves. Drop the local's
      // one leading underscore so the join stays a single separator.
      //
      // DEEP because `renameStmt` now descends, and the collector and the renamer
      // must walk the same tree: a `for`'s induction variable and a `let` inside a
      // branch are declarations the lift copies too.
      //
      // HONEST SCOPE — this is uniformity, NOT a miscompile guard, and the
      // difference is worth writing down because it looks like one. Severing the
      // nested collection entirely still passes every arm here: the builder hoists
      // `var` declarations to function top (so they were never nested), and a
      // nested `let` that two instances could collide over is copy-propagated away
      // by the O1 cleanup before it can. It DOES move emitted bytes corpus-wide, so
      // it is not inert — it just buys one invariant ("every declaration a lift
      // copies carries its instance prefix") rather than correctness.
      for (const name of declaredNamesDeep(lb.prelude))
        localRen.set(name, `${p}${name.replace(/^_/, '')}`)
      const rw = (ex: Expr): Expr =>
        mapExpr(ex, (y) => {
          if (y.op === 'param' || y.op === 'varref') {
            if (subst.has(y.name)) return subst.get(y.name)!
            if (localRen.has(y.name)) return { ...y, name: localRen.get(y.name)! }
          }
          return y
        })
      for (const st of lb.prelude) lifted.push(renameStmt(st, localRen, rw))
      const retTmp = `${p}ret`
      lifted.push({ s: 'let', name: retTmp, expr: rw(lb.ret) })
      return { op: 'varref', type: target.ret, name: retTmp }
    })

  const inlineInBlock = (stmts: readonly Stmt[]): Stmt[] => {
    const out: Stmt[] = []
    for (const s of stmts) {
      const lifted: Stmt[] = []
      const L = (e: Expr): Expr => liftCalls(e, lifted)
      let s2: Stmt
      switch (s.s) {
        case 'let':
          s2 = { ...s, expr: L(s.expr) }
          break
        case 'var':
          s2 = s.init !== undefined ? { ...s, init: L(s.init) } : s
          break
        case 'assign':
        case 'assignOp':
          s2 = { ...s, target: L(s.target), expr: L(s.expr) }
          break
        case 'return':
          s2 = s.expr !== undefined ? { ...s, expr: L(s.expr) } : s
          break
        case 'if':
          s2 = {
            ...s,
            arms: s.arms.map((a) => ({ cond: L(a.cond), body: inlineInBlock(a.body) })),
            elseBody: s.elseBody ? inlineInBlock(s.elseBody) : undefined,
          }
          break
        case 'for':
          // header never calls `name` (calledInForHeader gate); only the body can.
          s2 = { ...s, body: inlineInBlock(s.body) }
          break
        case 'switch':
          s2 = {
            ...s,
            scrut: L(s.scrut),
            cases: s.cases.map((c) => ({ ...c, body: inlineInBlock(c.body) })),
            defaultBody: s.defaultBody ? inlineInBlock(s.defaultBody) : undefined,
          }
          break
        default:
          s2 = s
      }
      out.push(...lifted, s2)
    }
    return out
  }

  const others = m.funcs
    .filter((f) => f !== target)
    .map((f): FuncDecl => ({ ...f, body: inlineInBlock(f.body) }))
  const stillCalled = others.some((f) => f.body.some((s) => stmtDeepCallsName(s, name)))
  return { ...m, funcs: stillCalled ? [target, ...others] : others }
}

/** Every expression in `s`, nested block bodies and loop headers INCLUDED. */
function forEachStmtExprDeep(s: Stmt, visit: (e: Expr) => void): void {
  forEachStmtExpr(s, visit)
  switch (s.s) {
    case 'if':
      for (const a of s.arms) {
        visit(a.cond)
        for (const b of a.body) forEachStmtExprDeep(b, visit)
      }
      for (const b of s.elseBody ?? []) forEachStmtExprDeep(b, visit)
      break
    case 'for':
      forEachStmtExprDeep(s.init, visit)
      visit(s.cond)
      forEachStmtExprDeep(s.update, visit)
      for (const b of s.body) forEachStmtExprDeep(b, visit)
      break
    case 'switch':
      visit(s.scrut)
      for (const c of s.cases) for (const b of c.body) forEachStmtExprDeep(b, visit)
      for (const b of s.defaultBody ?? []) forEachStmtExprDeep(b, visit)
      break
    default:
      break
  }
}

/** Every name a block DECLARES, nested bodies and `for` init included. Names are
 *  unique per function (the builder auto-names), so a flat set is exact. */
function declaredNamesDeep(stmts: readonly Stmt[]): Set<string> {
  const out = new Set<string>()
  const walk = (body: readonly Stmt[]): void => {
    for (const s of body) {
      if (s.s === 'let' || s.s === 'var') out.add(s.name)
      else if (s.s === 'if') {
        for (const a of s.arms) walk(a.body)
        walk(s.elseBody ?? [])
      } else if (s.s === 'for') {
        walk([s.init])
        walk(s.body)
      } else if (s.s === 'switch') {
        for (const c of s.cases) walk(c.body)
        walk(s.defaultBody ?? [])
      }
    }
  }
  walk(stmts)
  return out
}

/** Apply an expr rewrite to a statement's OWN expressions (not nested blocks). */
function forEachStmtExpr(s: Stmt, visit: (e: Expr) => void): void {
  switch (s.s) {
    case 'let':
      visit(s.expr)
      break
    case 'var':
      if (s.init !== undefined) visit(s.init)
      break
    case 'assign':
    case 'assignOp':
      visit(s.target)
      visit(s.expr)
      break
    case 'return':
      if (s.expr !== undefined) visit(s.expr)
      break
    default:
      break
  }
}

/** Rename a prelude statement's declared name (let/var) and rewrite its exprs,
 *  DESCENDING into nested block bodies and loop headers — the prelude may now
 *  contain control flow, and a nested declaration is a declaration. */
function renameStmt(s: Stmt, localRen: ReadonlyMap<string, string>, rw: (e: Expr) => Expr): Stmt {
  const sub = (body: readonly Stmt[]): Stmt[] => body.map((b) => renameStmt(b, localRen, rw))
  switch (s.s) {
    case 'let':
      return { s: 'let', name: localRen.get(s.name) ?? s.name, expr: rw(s.expr) }
    case 'var':
      return {
        s: 'var',
        name: localRen.get(s.name) ?? s.name,
        type: s.type,
        ...(s.init !== undefined ? { init: rw(s.init) } : {}),
      }
    case 'assign':
      return { ...s, target: rw(s.target), expr: rw(s.expr) }
    case 'assignOp':
      return { ...s, target: rw(s.target), expr: rw(s.expr) }
    case 'if':
      return {
        ...s,
        arms: s.arms.map((a) => ({ cond: rw(a.cond), body: sub(a.body) })),
        ...(s.elseBody !== undefined ? { elseBody: sub(s.elseBody) } : {}),
      }
    case 'for':
      return {
        ...s,
        init: renameStmt(s.init, localRen, rw),
        cond: rw(s.cond),
        update: renameStmt(s.update, localRen, rw),
        body: sub(s.body),
      }
    case 'switch':
      return {
        ...s,
        scrut: rw(s.scrut),
        cases: s.cases.map((c) => ({ ...c, body: sub(c.body) })),
        ...(s.defaultBody !== undefined ? { defaultBody: sub(s.defaultBody) } : {}),
      }
    default:
      return s
  }
}

/** The post-inline cleanup: re-hoist the values inlining duplicated (see the
 *  header). `gvn` inside O1 is the pass this specifically needs — a lifted prelude
 *  repeats ACROSS statements of one block and reads the caller's LOCALS, which is
 *  exactly the gap between fn-top `cse` (input-only) and statement-local
 *  `cse-local`; the rest of the tier propagates the copies gvn exposes and drops
 *  what that orphans.
 *
 *  O1 and not O2, because BIT-EXACTNESS is required here:
 *  `_emit-obfuscate-gate.spec.ts` asserts a plain emit and an
 *  `[inline(), ...obfuscate()]` emit draw BYTE-IDENTICAL frames on real Tint +
 *  ANGLE. `LEVEL_PASSES.O1` is this repo's named tier of value MOVERS — none
 *  changes which float ops execute — so no result can move by a ULP. The
 *  float-semantics passes O2 adds (`constFold`, `algebraicSimplify`, `licm`) are
 *  deliberately out, and cost nothing to omit: including them reaches the SAME op
 *  count on every example that inlines. */
const CLEANUP: readonly OptPass[] = LEVEL_PASSES.O1

/** Inline EVERY safely-inlinable helper — single-return via the proven inlineFn,
 *  then linear multi-statement via inlineLinearFn — until none remain, then clean
 *  up the duplication that created (`CLEANUP`). Pure (module -> module);
 *  `@xgis/shader-dsl/emit-prod`'s inline() plugin.
 *
 *  `counter` is the lift-temp uniquifier, and it defaults to a FRESH one — correct for a
 *  single call, and wrong for a SEQUENCE. A caller that inlines in several passes over the
 *  same module (force-inline.ts's budgeted path does, one helper at a time) must thread ONE
 *  counter through them all: otherwise every call restarts at `_inl0_`, two rounds bind the
 *  same temp name, and the module comes out with an unbound reference — `unbound _inl1_ret`
 *  from the CPU oracle, caught by the df64 known-answer arms rather than by anything static. */
export function inlineLinearAll(m: ModuleDecl, counter: { n: number } = { n: 0 }): ModuleDecl {
  if (m.funcs.some((f) => bodyHasRaw(f.body))) return m
  let cur = m
  // Each step removes exactly one helper, so the fn count bounds the loop.
  for (let i = 0; i <= m.funcs.length; i++) {
    const single = cur.funcs.find((f) => isInlinable(cur, f, false))
    if (single) {
      cur = inlineFn(cur, single.name)
      continue
    }
    const linear = cur.funcs.find((f) => isInlinable(cur, f, true))
    if (linear) {
      cur = inlineLinearFn(cur, linear.name, counter)
      continue
    }
    break
  }
  // Nothing inlined ⇒ nothing to clean up. `cur === m` is exact: both inliners
  // return the module UNCHANGED when they find no target, so identity holds iff
  // the loop broke on its first probe. Keeps inline() a true no-op on a module
  // with no inlinable helper, instead of silently re-optimizing it.
  return cur === m ? m : fixpoint(cur, CLEANUP)
}
