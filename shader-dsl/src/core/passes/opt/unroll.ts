// ═══ Shader DSL — small fixed-count loop unrolling (Optimization context) ═══
//
// unrollLoops(module) replaces a `for` loop with a COMPILE-TIME-CONSTANT trip
// count by its N straight-line iterations: each copy has the induction variable
// substituted with its per-iteration literal, and its body-declared locals
// alpha-renamed (`_u{k}_name`) so the flattened statements never redeclare a name
// — the same uniquifier inline-linear.ts uses when it lifts a helper's prelude.
// Addresses the "loop optimization: no unroll for small fixed-count loops" gap of
// #627 (licm was the only loop pass). Pure (module -> module).
//
// SMALL ONLY. Blind unrolling bloats (a big body copied many times), so — in the
// same node-count unit auto-inline's exprCost uses — a loop unrolls iff its trip
// count is <= MAX_TRIP AND trip x body-node-cost <= MAX_UNROLLED_NODES. Anything
// larger stays a loop. Nested loops unroll inner-first, so the outer budget sees
// the already-expanded body.
//
// INTEGER induction only (i32 / u32). A constant trip count is exact for an integer
// counter on every target; an f32 counter's last-iteration inclusion (and `!=`
// termination) can differ between this f64 oracle and real f32 hardware — the
// codebase's worst bug class — so f32 loops are left to a future pass gated by the
// real-GPU differential, not decided by this f32-blind one.
//
// SKIPS (leave the loop; never unroll unsoundly):
//   • non-constant init / bound / step, or a trip count that doesn't terminate
//     within the small-loop cap → not a provable fixed-count loop;
//   • the induction var is reassigned or shadowed anywhere in the body → its
//     per-iteration literal would be wrong;
//   • a break / continue that targets THIS loop (one nested in an inner `for` is
//     that loop's, and fine) → no loop remains to carry it;
//   • an unconditional top-level return / discard → the loop runs <= 1 time, so the
//     later copies would be statically-unreachable code;
//   • a raw WGSL Stmt in the fn → opaque (same bail as licm / gvn).
//
// Bit-exact for integer counters (pure duplication + literal substitution — no
// float arithmetic is introduced), so no f32 differential gate is needed; pinned by
// oracle value-equality like cse / gvn / licm.
//
// Available-but-unwired, like inlineFn / deadFnElim / autoInline / gvn: NOT in
// DEFAULT_PASSES (unrolling changes production WGSL bytes → the byte-stable
// shared-prelude golden snapshots would need regenerating, a maintainer call).

import type { CmpOp, Expr, Stmt, ModuleDecl, FuncDecl, ShaderType } from '../../ir'
import { mapExpr, mapStmt } from './ir-transform'
import { bodyHasRaw, collectLocals, collectMutatedRoots, forEachTopExpr } from './expr-utils'

type ForStmt = Extract<Stmt, { s: 'for' }>

// "Small": at most MAX_TRIP iterations, and the unrolled body (trip x node-cost)
// under MAX_UNROLLED_NODES — the growth budget. SIM_CAP bounds the trip-count
// simulation so a loop whose counter never reaches its bound is rejected outright,
// not enumerated forever (MAX_TRIP already bails long before it, in practice).
const MAX_TRIP = 8
const MAX_UNROLLED_NODES = 64
const SIM_CAP = 1024

/** A plain numeric constant — a literal, or a negated literal (`unop` = negate). */
function constNum(e: Expr): number | undefined {
  if (e.op === 'lit' && typeof e.value === 'number') return e.value
  if (e.op === 'unop' && e.a.op === 'lit' && typeof e.a.value === 'number') return -e.a.value
  return undefined
}

const isVar = (e: Expr, name: string): boolean => e.op === 'varref' && e.name === name

/** `a <cop> b` restated as `b <flip> a` — for a cond with the counter on the right. */
function flipCmp(cop: CmpOp): CmpOp {
  switch (cop) {
    case '<':
      return '>'
    case '>':
      return '<'
    case '<=':
      return '>='
    case '>=':
      return '<='
    default:
      return cop // == / != are symmetric
  }
}

function cmpHolds(cop: CmpOp, v: number, bound: number): boolean {
  switch (cop) {
    case '<':
      return v < bound
    case '>':
      return v > bound
    case '<=':
      return v <= bound
    case '>=':
      return v >= bound
    case '==':
      return v === bound
    case '!=':
      return v !== bound
  }
}

/** The counter compare `i <cop> bound` (normalised so `i` is on the left), or
 *  undefined if `cond` isn't a comparison of the counter against a constant. */
function readCond(cond: Expr, name: string): { cop: CmpOp; bound: number } | undefined {
  if (cond.op !== 'compare') return undefined
  if (isVar(cond.a, name)) {
    const bound = constNum(cond.b)
    return bound === undefined ? undefined : { cop: cond.cop, bound }
  }
  if (isVar(cond.b, name)) {
    const bound = constNum(cond.a)
    return bound === undefined ? undefined : { cop: flipCmp(cond.cop), bound }
  }
  return undefined
}

/** The signed per-iteration step of `name` from `i = i + c` / `i = c + i` /
 *  `i = i - c` / `i += c` / `i -= c`, or undefined if `update` isn't that shape. */
function readStep(update: Stmt, name: string): number | undefined {
  if (update.s === 'assignOp') {
    if (!isVar(update.target, name)) return undefined
    const c = constNum(update.expr)
    if (c === undefined) return undefined
    if (update.bop === '+') return c
    if (update.bop === '-') return -c
    return undefined
  }
  if (update.s === 'assign') {
    if (!isVar(update.target, name)) return undefined
    const e = update.expr
    if (e.op !== 'binop') return undefined
    if (e.bop === '+') {
      if (isVar(e.a, name)) return constNum(e.b)
      if (isVar(e.b, name)) return constNum(e.a)
      return undefined
    }
    if (e.bop === '-' && isVar(e.a, name)) {
      const c = constNum(e.b)
      return c === undefined ? undefined : -c
    }
    return undefined
  }
  return undefined
}

interface LoopInfo {
  name: string
  type: ShaderType
  seq: readonly number[]
}

/** Prove `s` a small integer fixed-count loop and return its induction var name +
 *  type + the exact sequence of counter values, or undefined if unprovable / big. */
function analyzeLoop(s: ForStmt): LoopInfo | undefined {
  if (s.init.s !== 'var' || s.init.init === undefined) return undefined
  const type = s.init.type
  // Integer counter only — an f32 trip count can diverge on real f32 hardware.
  if (!(type.kind === 'scalar' && (type.scalar === 'i32' || type.scalar === 'u32')))
    return undefined
  const name = s.init.name
  const start = constNum(s.init.init)
  if (start === undefined) return undefined
  const cond = readCond(s.cond, name)
  if (cond === undefined) return undefined
  const step = readStep(s.update, name)
  if (step === undefined || step === 0) return undefined

  // Simulate in the counter type's modular RANGE, not unbounded JS. A value that
  // leaves [lo, hi] wraps on i32 / u32 hardware — a u32 counter stepping below 0
  // becomes 0xffffffff, making `i >= 0u` an infinite loop the JS sim would instead
  // exit at −1 and "unroll" to a finite body. Reject such a loop rather than emit an
  // unsound trip count; this is what keeps the header's "exact for an integer counter
  // on every target" true.
  const lo = type.scalar === 'u32' ? 0 : -0x80000000
  const hi = type.scalar === 'u32' ? 0xffffffff : 0x7fffffff

  const seq: number[] = []
  let v = start
  for (let guard = 0; guard < SIM_CAP; guard++) {
    if (v < lo || v > hi) return undefined // would wrap on hardware — the JS sim diverges
    if (!cmpHolds(cond.cop, v, cond.bound)) return { name, type, seq }
    seq.push(v)
    if (seq.length > MAX_TRIP) return undefined // not "small"
    v += step
  }
  return undefined // never terminated within the cap
}

/** A break / continue that belongs to THIS loop (one inside a nested `for` is that
 *  loop's — we don't descend into it). Conservatively also treats a switch-bound
 *  `break` as escaping (we descend into switch / if): the safe side skips a loop we
 *  could have unrolled, never unrolls one we shouldn't. */
function hasEscapingBreakContinue(body: readonly Stmt[]): boolean {
  for (const s of body) {
    if (s.s === 'break' || s.s === 'continue') return true
    if (s.s === 'if') {
      if (s.arms.some((a) => hasEscapingBreakContinue(a.body))) return true
      if (s.elseBody && hasEscapingBreakContinue(s.elseBody)) return true
    } else if (s.s === 'switch') {
      if (s.cases.some((c) => hasEscapingBreakContinue(c.body))) return true
      if (s.defaultBody && hasEscapingBreakContinue(s.defaultBody)) return true
    }
    // 'for' — a nested loop captures its own break / continue; do not descend.
  }
  return false
}

/** The induction literal can be substituted everywhere and the copies concatenated
 *  iff the body neither redefines the counter nor carries loop-level control flow. */
function bodyIsUnrollable(body: readonly Stmt[], name: string): boolean {
  const clobbered = new Set<string>()
  collectLocals(body, clobbered) // a shadowing `let i` / nested `for i`
  collectMutatedRoots(body, clobbered) // an `i = …` reassignment
  if (clobbered.has(name)) return false
  // An unconditional top-level return / discard runs the loop <= 1x; the later
  // copies would be unreachable. (A return / discard nested in an `if` is
  // reachable when the branch isn't taken — allowed.)
  if (body.some((s) => s.s === 'return' || s.s === 'discard')) return false
  if (hasEscapingBreakContinue(body)) return false
  return true
}

/** Expression-node count of a body — the growth-budget unit (auto-inline exprCost).
 *  forEachTopExpr already descends nested bodies, so an inner (already-unrolled)
 *  loop is counted, which is what bounds nested expansion. */
function bodyNodeCost(body: readonly Stmt[]): number {
  let n = 0
  for (const s of body)
    forEachTopExpr(s, () => {
      n++
    })
  return n
}

/** Rename every body-declared name (both its declaration and its references) via
 *  `ren`; references to names NOT in `ren` (params, outer accumulators, the counter
 *  itself) pass through untouched. */
function renameLocals(s: Stmt, ren: ReadonlyMap<string, string>): Stmt {
  const R = (e: Expr): Expr =>
    mapExpr(e, (x) =>
      (x.op === 'varref' || x.op === 'param') && ren.has(x.name)
        ? { ...x, name: ren.get(x.name)! }
        : x,
    )
  const nm = (name: string): string => ren.get(name) ?? name
  switch (s.s) {
    case 'let':
      return { s: 'let', name: nm(s.name), expr: R(s.expr) }
    case 'var':
      return s.init !== undefined
        ? { s: 'var', name: nm(s.name), type: s.type, init: R(s.init) }
        : { s: 'var', name: nm(s.name), type: s.type }
    case 'assign':
    case 'assignOp':
      return { ...s, target: R(s.target), expr: R(s.expr) }
    case 'return':
      return s.expr !== undefined ? { ...s, expr: R(s.expr) } : s
    case 'if':
      return {
        ...s,
        arms: s.arms.map((a) => ({
          cond: R(a.cond),
          body: a.body.map((b) => renameLocals(b, ren)),
        })),
        elseBody: s.elseBody?.map((b) => renameLocals(b, ren)),
      }
    case 'for':
      return {
        ...s,
        init: renameLocals(s.init, ren),
        cond: R(s.cond),
        update: renameLocals(s.update, ren),
        body: s.body.map((b) => renameLocals(b, ren)),
      }
    case 'switch':
      return {
        ...s,
        scrut: R(s.scrut),
        cases: s.cases.map((c) => ({
          value: c.value,
          body: c.body.map((b) => renameLocals(b, ren)),
        })),
        defaultBody: s.defaultBody?.map((b) => renameLocals(b, ren)),
      }
    default:
      return s // break / continue / discard / placeholder / raw — no names / sub-exprs
  }
}

/** Replace the counter `name` with its per-iteration literal everywhere in `s`. */
function substCounter(s: Stmt, name: string, lit: Expr): Stmt {
  return mapStmt(s, (e) => (e.op === 'varref' && e.name === name ? lit : e))
}

/** Unroll a fixed-count loop into its concatenated iterations, or undefined if the
 *  loop isn't a small provable fixed-count loop this pass can flatten safely. */
function tryUnroll(s: ForStmt, counter: { n: number }): Stmt[] | undefined {
  const info = analyzeLoop(s)
  if (info === undefined) return undefined
  if (!bodyIsUnrollable(s.body, info.name)) return undefined
  if (info.seq.length * bodyNodeCost(s.body) > MAX_UNROLLED_NODES) return undefined

  const locals = new Set<string>()
  collectLocals(s.body, locals)
  const out: Stmt[] = []
  for (const v of info.seq) {
    const suf = counter.n++
    const ren = new Map<string, string>()
    // Strip one leading underscore so `_u{suf}_` + `_cse0` doesn't form the GLSL-ES
    // reserved `__` join (same guard inline-linear.ts uses).
    for (const local of locals) ren.set(local, `_u${suf}_${local.replace(/^_/, '')}`)
    const lit: Expr = { op: 'lit', type: info.type, value: v }
    for (const st of s.body) {
      const renamed = ren.size > 0 ? renameLocals(st, ren) : st
      out.push(substCounter(renamed, info.name, lit))
    }
  }
  return out
}

/** Rebuild a block, unrolling each fixed-count `for` (inner loops first) and
 *  recursing through `if` / `switch` bodies. */
function unrollBlock(body: readonly Stmt[], counter: { n: number }): Stmt[] {
  const out: Stmt[] = []
  for (const s of body) {
    if (s.s === 'for') {
      const loop: ForStmt = { ...s, body: unrollBlock(s.body, counter) } // inner-first
      const copies = tryUnroll(loop, counter)
      if (copies !== undefined) out.push(...copies)
      else out.push(loop)
    } else if (s.s === 'if') {
      out.push({
        ...s,
        arms: s.arms.map((a) => ({ cond: a.cond, body: unrollBlock(a.body, counter) })),
        elseBody: s.elseBody ? unrollBlock(s.elseBody, counter) : undefined,
      })
    } else if (s.s === 'switch') {
      out.push({
        ...s,
        cases: s.cases.map((c) => ({ value: c.value, body: unrollBlock(c.body, counter) })),
        defaultBody: s.defaultBody ? unrollBlock(s.defaultBody, counter) : undefined,
      })
    } else {
      out.push(s)
    }
  }
  return out
}

/** The next fresh `_u{k}_` suffix for `body` — past any suffix an EARLIER unroll pass
 *  already emitted. unrollLoops re-runs on the optimize()->emitModule() fixpoint (an
 *  enabling pass such as constProp can expose a newly-unrollable loop between runs), so
 *  a per-call reset to 0 would re-mint a `_u0_` that redeclares the first pass's
 *  flattened copy in the same fn scope — a naga / tint error the oracle's value-equality
 *  gate cannot see. Same guard cse.ts applies to its `_cseN` temps. */
function seedSuffix(body: readonly Stmt[]): number {
  const names = new Set<string>()
  collectLocals(body, names)
  let n = 0
  for (const name of names) {
    const mm = /^_u(\d+)_/.exec(name)
    if (mm) n = Math.max(n, Number(mm[1]) + 1)
  }
  return n
}

/** Unroll small fixed-count loops throughout a module. Pure (module -> module). */
export function unrollLoops(m: ModuleDecl): ModuleDecl {
  return {
    ...m,
    funcs: m.funcs.map((f): FuncDecl =>
      // A raw WGSL stmt is opaque (it may reference the counter textually) — bail
      // the whole fn, exactly as licm / gvn do.
      bodyHasRaw(f.body) ? f : { ...f, body: unrollBlock(f.body, { n: seedSuffix(f.body) }) },
    ),
  }
}
