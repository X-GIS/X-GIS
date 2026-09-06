// ═══ Shader DSL — shared IR analysis utilities (Optimization context) ═══
//
// The structural-key / traversal / scope helpers shared by the analysis passes
// (CSE, LICM, …). Kept in one place so the two passes cannot drift (duplicated
// traversal logic that must agree is this codebase's #1 bug archetype).

import type { Expr, Stmt, ShaderType } from '../../ir/index.js'
import { typeKey } from '../../ir/index.js'
import { eachExpr, eachStmtExpr, mapStmtExpr } from '../../ir/visit.js'

// The IR walkers moved to `core/ir/visit.ts` — `core/ir` cannot import from
// `passes/opt`, and the builder / fp64 / GLSL backends need them too (ADR-0013:
// IR walkers live in core/ir). Re-exported here so the analysis passes keep ONE
// import surface; a NEW walker belongs in visit.ts, not in this file.
export { eachExpr, mapChildren } from '../../ir/visit.js'

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

/** Memo for {@link keyOf}, keyed on the Expr OBJECT (#2465).
 *
 *  Sound because the IR is immutable: every field of every `Expr` arm is `readonly`
 *  (`ir/nodes.ts`), and a pass that rewrites builds a NEW node rather than editing one — so
 *  one object's key can never change. A `WeakMap`, so the entries die with the nodes a pass
 *  discards; nothing here retains IR.
 *
 *  Verified rather than argued: a temporary build that recomputed the key on EVERY call and
 *  threw on any disagreement with the memo ran the full suite — 1352 files / 12,405 tests —
 *  with zero disagreements. Should a pass ever start mutating a node in place, that is the
 *  premise to re-establish before trusting this.
 *
 *  Module-scope state is deliberate and dual-instance-safe (unlike the #763 D2 counter): two
 *  copies of this module would each keep their own memo and compute identical keys, since
 *  the memo caches a pure function of its key.
 *
 *  WHY it is worth having: `keyOf` is called per EXPRESSION NODE by four passes and re-run
 *  every fixpoint iteration — 254,232 calls in one `line` emit, against 776 `collectLocals`
 *  and 8,256 `collectMutatedRoots` calls in the same emit. Interleaved A/B/A/B on one machine,
 *  each figure the median of 3 emits: optimize 230.7 / 242.2 ms -> 182.3 / 153.5, gvn
 *  58.7 / 60.8 -> 40.7 / 38.1. Emitted bytes unchanged (goldens + `bake:shaders`). */
const keyMemo = new WeakMap<Expr, string>()

/** A deterministic structural key — two structurally-equal exprs share a key. */
export function keyOf(e: Expr): string {
  const memo = keyMemo.get(e)
  if (memo !== undefined) return memo
  const k = keyOfUncached(e)
  keyMemo.set(e, k)
  return k
}

function keyOfUncached(e: Expr): string {
  switch (e.op) {
    case 'lit':
      // The TYPE is part of a literal's identity, and it is the ONE expr whose type nothing
      // else in the key implies (a param / varref carries its own single type per function;
      // an operator's type follows its operands). Keying on `typeof e.value` alone made
      // `u32(-1.0)` and `u32(-1)` share a key — a conversion whose meaning depends on its
      // ARGUMENT type: float→u32 saturates to 0, int→u32 reinterprets the bits as
      // 4294967295. CSE then hoisted one and rewrote the other to it, in the emitted WGSL
      // and GLSL alike. `-0` is spelled apart from `0` for the same reason: `x + -0.0` and
      // `x + 0.0` differ when x is -0.0. Found by the #2406 generated-program differential.
      return `L:${typeKey(e.type)}:${Object.is(e.value, -0) ? '-0' : String(e.value)}`
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

/** The unconditionally-evaluated VALUE positions of a statement, rewritten through `f`
 *  (the lvalue TARGET is not one, and the nested block bodies are their own blocks).
 *  Shared by `cse-local` and `gvn`, which must name exactly the same set as their
 *  `valueExprs`: a position that is tallied but not rewritten mints a temp and leaves
 *  the original recomputing beside it. `glsl-legalize` keeps its OWN version — it also
 *  rewrites the target's INDEX subexpressions, a different set on purpose. */
export function mapStmtValue(s: Stmt, f: (e: Expr) => Expr): Stmt {
  switch (s.s) {
    case 'assign':
    case 'assignOp':
      // The lvalue TARGET is not a value position — only the right-hand side.
      return { ...s, expr: f(s.expr) }
    case 'if': {
      // Arm 0 only: every later arm is an `else if`, reached only when the earlier
      // conditions were false, so hoisting one would evaluate it unconditionally.
      const [first, ...rest] = s.arms
      return first === undefined ? s : { ...s, arms: [{ ...first, cond: f(first.cond) }, ...rest] }
    }
    case 'let':
    case 'var':
    case 'return':
      // These hold nothing BUT value positions and no nested body, so the shared
      // statement rewrite is exactly right for them.
      return mapStmtExpr(s, f)
    default:
      // `for` / `switch` headers run per-iteration or guard a block — not value
      // positions here — and the Expr-less kinds have nothing to rewrite.
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

/** Collect every `let` binding in `body` — nested bodies included — whose bound
 *  expression `accepts` admits, keyed by binding name.
 *
 *  SCOPE — one FLAT map per function, no block scoping. Binding names are unique per
 *  fn (the builder auto-names, and a name bound in one branch cannot be referenced
 *  from a sibling — the oracle's flat-env note, oracle.ts), exactly as DCE / LICM
 *  already assume. A name that is EVER an assignment target is the caller's to
 *  exclude: `accepts` receives the name for that reason.
 *
 *  The descent is the traversal SoT's (`eachStmtExpr` open recursion, visit.ts), not
 *  a fourth hand-written `if`/`for`/`switch` ladder — which is the point. The three
 *  substitution passes that share this each wrote that ladder out, and all three had
 *  drifted from the walker in the SAME position: a `for`'s update Stmt. Inert today
 *  (every `for` update the builder and the random-IR generator emit is an `assign`,
 *  builder.ts:317-331, random-ir.ts:424 — and an `assign` has no nested body), so
 *  routing through the SoT changes no output; it removes the way it could.
 */
export function collectLets<T extends Expr>(
  body: readonly Stmt[],
  accepts: (name: string, e: Expr) => e is T,
): Map<string, T> {
  const out = new Map<string, T>()
  const walk = (s: Stmt): void => {
    if (s.s === 'let' && accepts(s.name, s.expr)) out.set(s.name, s.expr)
    eachStmtExpr(s, () => {}, walk)
  }
  for (const s of body) walk(s)
  return out
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
