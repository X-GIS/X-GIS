// ═══ Shader DSL — shared IR analysis utilities (Optimization context) ═══
//
// The structural-key / traversal / scope helpers shared by the analysis passes
// (CSE, LICM, …). Kept in one place so the two passes cannot drift (duplicated
// traversal logic that must agree is this codebase's #1 bug archetype).

import type { Expr, Stmt, ShaderType } from '../../ir/index.js'
import { typeKey } from '../../ir/index.js'

/** `'i32'` / `'u32'` for an integer scalar or integer VECTOR type, else undefined.
 *
 *  The single test behind every rewrite that is sound on integers and unsound on floats.
 *  Both apply: `i * 0 -> 0` and `i - i -> 0` hold for every integer but not for a float
 *  (`NaN * 0` is `NaN`, `Inf - Inf` is `NaN`), and integer literal arithmetic WRAPS where
 *  float literal arithmetic does not. Shared by const-fold and algebraic so the two cannot
 *  disagree about what counts as an integer — the drift this module exists to prevent. */
export function intElemOf(t: ShaderType): 'i32' | 'u32' | undefined {
  if (t.kind === 'scalar') return t.scalar === 'i32' || t.scalar === 'u32' ? t.scalar : undefined
  if (t.kind === 'vec') return t.elem === 'i32' || t.elem === 'u32' ? t.elem : undefined
  return undefined
}

/** Wrap a folded integer into `elem`'s 32-bit range, the way the GPU (and C) does.
 *  JS `ToInt32` / `ToUint32` ARE the modulo-2^32 reduction, so this is exact for any finite
 *  input — measured against gcc 13.3 -O2: `2147483647 + 1` -> `-2147483648`,
 *  `0u - 1u` -> `4294967295`, `100000 * 100000` -> `1410065408`. */
export const wrapInt = (v: number, elem: 'i32' | 'u32'): number =>
  elem === 'u32' ? v >>> 0 : v | 0

/** A deterministic structural key — two structurally-equal exprs share a key. */
export function keyOf(e: Expr): string {
  switch (e.op) {
    case 'lit':
      return `L:${typeof e.value}:${String(e.value)}`
    case 'constref':
      return `C:${e.name}`
    case 'externref':
    case 'overrideref':
      return `O:${e.name}` // #923 — distinct from a const read (never CSE'd together)
    case 'param':
      return `P:${e.name}`
    case 'varref':
      return `V:${e.name}`
    case 'binop':
      return `(${keyOf(e.a)}${e.bop}${keyOf(e.b)})`
    case 'compare':
      return `(${keyOf(e.a)}${e.cop}${keyOf(e.b)})`
    case 'logical':
      return `(${keyOf(e.a)}${e.lop}${keyOf(e.b)})`
    case 'unop':
      return `(-${keyOf(e.a)})`
    case 'call':
      return `${e.fn}(${e.args.map(keyOf).join(',')})`
    case 'construct':
      return `${typeKey(e.type)}{${e.args.map(keyOf).join(',')}}`
    case 'member':
      return `${keyOf(e.base)}.${e.field}`
    case 'index':
      return `${keyOf(e.base)}[${keyOf(e.idx)}]`
    case 'select':
      return `S(${keyOf(e.cond)},${keyOf(e.ifTrue)},${keyOf(e.ifFalse)})`
    case 'matchExpr':
      return `M(${keyOf(e.scrutinee)};${e.cases.map(([n, v]) => `${n}:${keyOf(v)}`).join(',')};${keyOf(e.default)})`
  }
}

/** Compound = a non-leaf expr (worth hoisting / counting). */
export const isCompound = (e: Expr): boolean =>
  e.op !== 'lit' &&
  e.op !== 'constref' &&
  e.op !== 'overrideref' &&
  e.op !== 'externref' &&
  e.op !== 'param' &&
  e.op !== 'varref'

/** Visit `e` and every descendant (pre-order). */
export function eachExpr(e: Expr, visit: (e: Expr) => void): void {
  visit(e)
  switch (e.op) {
    case 'binop':
    case 'compare':
    case 'logical':
      eachExpr(e.a, visit)
      eachExpr(e.b, visit)
      break
    case 'unop':
      eachExpr(e.a, visit)
      break
    case 'call':
    case 'construct':
      for (const a of e.args) eachExpr(a, visit)
      break
    case 'member':
      eachExpr(e.base, visit)
      break
    case 'index':
      eachExpr(e.base, visit)
      eachExpr(e.idx, visit)
      break
    case 'select':
      eachExpr(e.cond, visit)
      eachExpr(e.ifTrue, visit)
      eachExpr(e.ifFalse, visit)
      break
    case 'matchExpr':
      eachExpr(e.scrutinee, visit)
      for (const [, v] of e.cases) eachExpr(v, visit)
      eachExpr(e.default, visit)
      break
    default:
      break
  }
}

/** Rebuild `e` with `f` applied to its direct children only (self untouched). */
export function mapChildren(e: Expr, f: (c: Expr) => Expr): Expr {
  switch (e.op) {
    case 'lit':
    case 'constref':
    case 'overrideref':
    case 'externref':
    case 'param':
    case 'varref':
      return e
    case 'binop':
      return { ...e, a: f(e.a), b: f(e.b) }
    case 'compare':
      return { ...e, a: f(e.a), b: f(e.b) }
    case 'logical':
      return { ...e, a: f(e.a), b: f(e.b) }
    case 'unop':
      return { ...e, a: f(e.a) }
    case 'call':
      return { ...e, args: e.args.map(f) }
    case 'construct':
      return { ...e, args: e.args.map(f) }
    case 'member':
      return { ...e, base: f(e.base) }
    case 'index':
      return { ...e, base: f(e.base), idx: f(e.idx) }
    case 'select':
      return { ...e, cond: f(e.cond), ifTrue: f(e.ifTrue), ifFalse: f(e.ifFalse) }
    case 'matchExpr':
      return {
        ...e,
        scrutinee: f(e.scrutinee),
        cases: e.cases.map(([n, v]) => [n, f(v)] as const),
        default: f(e.default),
      }
  }
}

/** Visit every top-level expr in a stmt (and its nested bodies' top-level exprs). */
export function forEachTopExpr(s: Stmt, visit: (e: Expr) => void): void {
  switch (s.s) {
    case 'let':
      eachExpr(s.expr, visit)
      break
    case 'var':
      if (s.init !== undefined) eachExpr(s.init, visit)
      break
    case 'assign':
    case 'assignOp':
      eachExpr(s.target, visit)
      eachExpr(s.expr, visit)
      break
    case 'return':
      if (s.expr !== undefined) eachExpr(s.expr, visit)
      break
    case 'if':
      for (const a of s.arms) {
        eachExpr(a.cond, visit)
        for (const b of a.body) forEachTopExpr(b, visit)
      }
      if (s.elseBody) for (const b of s.elseBody) forEachTopExpr(b, visit)
      break
    case 'for':
      forEachTopExpr(s.init, visit)
      eachExpr(s.cond, visit)
      forEachTopExpr(s.update, visit)
      for (const b of s.body) forEachTopExpr(b, visit)
      break
    case 'switch':
      eachExpr(s.scrut, visit)
      for (const c of s.cases) for (const b of c.body) forEachTopExpr(b, visit)
      if (s.defaultBody) for (const b of s.defaultBody) forEachTopExpr(b, visit)
      break
    default:
      break
  }
}

/** Apply `f` to each top-level expr of a stmt (f does its own recursion). */
export function mapStmtTop(s: Stmt, f: (e: Expr) => Expr): Stmt {
  switch (s.s) {
    case 'let':
      return { ...s, expr: f(s.expr) }
    case 'var':
      return s.init !== undefined ? { ...s, init: f(s.init) } : s
    case 'assign':
    case 'assignOp':
      return { ...s, target: f(s.target), expr: f(s.expr) }
    case 'return':
      return s.expr !== undefined ? { ...s, expr: f(s.expr) } : s
    case 'if':
      return {
        ...s,
        arms: s.arms.map((a) => ({ cond: f(a.cond), body: a.body.map((b) => mapStmtTop(b, f)) })),
        elseBody: s.elseBody?.map((b) => mapStmtTop(b, f)),
      }
    case 'for':
      return {
        ...s,
        init: mapStmtTop(s.init, f),
        cond: f(s.cond),
        update: mapStmtTop(s.update, f),
        body: s.body.map((b) => mapStmtTop(b, f)),
      }
    case 'switch':
      return {
        ...s,
        scrut: f(s.scrut),
        cases: s.cases.map((c) => ({ value: c.value, body: c.body.map((b) => mapStmtTop(b, f)) })),
        defaultBody: s.defaultBody?.map((b) => mapStmtTop(b, f)),
      }
    default:
      return s
  }
}

/** True iff any Stmt in `body` (recursively) is a raw WGSL Stmt. */
export function bodyHasRaw(body: readonly Stmt[]): boolean {
  for (const s of body) {
    if (s.s === 'raw') return true
    if (s.s === 'if') {
      if (s.arms.some((a) => bodyHasRaw(a.body))) return true
      if (s.elseBody && bodyHasRaw(s.elseBody)) return true
    } else if (s.s === 'for') {
      if (bodyHasRaw(s.body)) return true
    } else if (s.s === 'switch') {
      if (s.cases.some((c) => bodyHasRaw(c.body))) return true
      if (s.defaultBody && bodyHasRaw(s.defaultBody)) return true
    }
  }
  return false
}

/** Collect every function-local binding name (let / var / for-counter). */
export function collectLocals(body: readonly Stmt[], out: Set<string>): void {
  for (const s of body) {
    if (s.s === 'let' || s.s === 'var') out.add(s.name)
    else if (s.s === 'if') {
      for (const a of s.arms) collectLocals(a.body, out)
      if (s.elseBody) collectLocals(s.elseBody, out)
    } else if (s.s === 'for') {
      collectLocals([s.init], out)
      collectLocals(s.body, out)
    } else if (s.s === 'switch') {
      for (const c of s.cases) collectLocals(c.body, out)
      if (s.defaultBody) collectLocals(s.defaultBody, out)
    }
  }
}

/** True iff `e` references a local (a varref whose name is in `locals`). */
export function refsLocal(e: Expr, locals: ReadonlySet<string>): boolean {
  let yes = false
  eachExpr(e, (x) => {
    if (x.op === 'varref' && locals.has(x.name)) yes = true
  })
  return yes
}

/** The root varref name written by an assignment lvalue (`buf.v`/`arr[i]` -> `buf`/`arr`). */
function targetRoot(e: Expr): string | undefined {
  if (e.op === 'varref') return e.name
  if (e.op === 'member') return targetRoot(e.base)
  if (e.op === 'index') return targetRoot(e.base)
  return undefined
}

/** Is `e` worth binding to a temp when it repeats?
 *
 *  The base rule, shared by `cse`, `cse-local` and `gvn` (it lived as three
 *  byte-identical copies, each with a comment saying it mirrored the other two —
 *  exactly the drift §12's second-ratchet entry warns about): only an expression that
 *  COMPUTES earns a temp. A bare member / swizzle / index navigation is as cheap
 *  inlined as bound, so binding it would trade one addressing chain for another.
 *
 *  `loadRoots` widens that (#1886). "Navigation is free" is true of a local struct and
 *  FALSE of a resource: `buf[i].field` on a storage or uniform buffer is a MEMORY LOAD,
 *  and repeating it repeats the load. Pass the module's binding names and an `index`
 *  rooted at one of them counts as worth hoisting even with no arithmetic around it.
 *  Callers that omit `loadRoots` keep the old behaviour exactly.
 *
 *  Only `index` qualifies, not a bare `member` of a uniform (`layer.offset_m`): a
 *  scalar uniform field commonly lives in a register, and nothing measured says
 *  otherwise. The WRITE hazard needs no new machinery here — `collectMutatedRoots`
 *  below already carries a written `read_write` storage binding into the callers'
 *  mutation sets, which is what invalidates a hoist across a store.
 *
 *  MEASURED on the 87-source baked corpus, before vs after a real build + bake:
 *  index operations 774 -> 663 (-111), for +13 temp declarations. Call sites are
 *  unchanged — the wrong metric for this pass, kept only so a regression there
 *  would show.
 *
 *  The BYTE figure depends on whether the shader minifier has run, so quote it with
 *  its base or not at all. At this increment's own commit the artifacts grew 892,811
 *  -> 893,183 (+372) and the note here read "trades source bytes for memory traffic";
 *  the minifier landed right after and took the corpus to 709,556, where the same
 *  increment measures 709,556 -> 709,356 (-200). Sign-flipped, same -111 loads: the
 *  load count is the invariant this pass moves, the byte count is not.
 *
 *  Attribution was probed rather than assumed. Instrumenting this branch through the
 *  real bake reported 7438 accepted candidates over 80 distinct keys, rooted at
 *  `segments` (4976), `layer` (1932), `shapes`, `band_data`, `shape_segments`,
 *  `tint_data`, `u`, `feat_data` — every one a module binding, none a local. That
 *  check exists because the emitted artifact LOOKS otherwise: several new temps read
 *  `_licm0[_v17]`, a function-local copy. They are minted earlier in the same sweep,
 *  while the expression is still `layer.patterns[_v17]`; `licm` (which runs after the
 *  CSE family) then hoists the array and rewrites the base inside the temp. Reading
 *  the output alone would have accused this predicate of leaking. */
export function isWorthHoisting(e: Expr, loadRoots?: ReadonlySet<string>): boolean {
  let worth = false
  eachExpr(e, (x) => {
    if (
      x.op === 'binop' ||
      x.op === 'unop' ||
      x.op === 'compare' ||
      x.op === 'logical' ||
      x.op === 'call' ||
      x.op === 'construct' ||
      x.op === 'select' ||
      x.op === 'matchExpr'
    ) {
      worth = true
      return
    }
    if (loadRoots === undefined || x.op !== 'index') return
    const root = targetRoot(x.base)
    if (root !== undefined && loadRoots.has(root)) worth = true
  })
  return worth
}

/** Collect every name MUTATED by an assignment in `body` (the assign-target roots).
 *  A read of a mutated name — including a `read_write` storage binding — is NOT
 *  invariant, so CSE / LICM must exclude any expr that references one (else they
 *  hoist a changing value and rewrite the store target into an immutable temp). */
export function collectMutatedRoots(body: readonly Stmt[], out: Set<string>): void {
  for (const s of body) {
    if (s.s === 'assign' || s.s === 'assignOp') {
      const r = targetRoot(s.target)
      if (r !== undefined) out.add(r)
    } else if (s.s === 'if') {
      for (const a of s.arms) collectMutatedRoots(a.body, out)
      if (s.elseBody) collectMutatedRoots(s.elseBody, out)
    } else if (s.s === 'for') {
      collectMutatedRoots([s.init], out)
      collectMutatedRoots([s.update], out)
      collectMutatedRoots(s.body, out)
    } else if (s.s === 'switch') {
      for (const c of s.cases) collectMutatedRoots(c.body, out)
      if (s.defaultBody) collectMutatedRoots(s.defaultBody, out)
    }
  }
}
