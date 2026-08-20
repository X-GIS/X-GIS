// ═══ Shader DSL — cross-statement global value numbering (GVN) ═══
//
// Completes the CSE family. `cse` hoists fn-top INPUT-ONLY repeats; `cse-local`
// hoists repeats WITHIN A SINGLE statement that touch a local/var. The gap
// (#627): a subexpression that touches a local/var and repeats ACROSS statements
// in the same block — e.g.
//
//   let a = hash(cell + g);      // statement i
//   ...
//   let b = hash(cell + g) * 2;  // statement j   (cell/g are locals)
//
// SAFE only with reassignment-awareness. This pass is deliberately conservative:
// it works one STRAIGHT-LINE block at a time (nested if/for/switch bodies are
// each their own block, recursed independently — no cross-block dominance), and
// it hoists a repeat to a single `let` before its FIRST occurrence ONLY when:
//   • the key is COMPOUND, worth-hoisting (computes), and touches a local/var
//     (input-only repeats are already cse's job — this is its complement),
//   • EVERY occurrence is unconditionally evaluated (never under a `&&`/`||` RHS,
//     a `select` branch, or a `matchExpr` arm — same guard as cse-local), AND
//   • NO statement in the span [first, last) mutates ANY root the expr reads
//     (assignment target root, a read_write store, or a same-name redeclaration).
//     This is the reassignment check: `r = f(r); y = f(r)` mutates `r` at the
//     first statement, so the two `f(r)` differ → not numbered together.
//
// Bit-exact (pure dedup — no float arithmetic changes), so no f32 differential
// gate is needed; pinned by oracle value-equality like cse / cse-local.
//
// WIRED into DEFAULT_PASSES and O1 (#1865). It sat available-but-unwired for a
// long time because turning it on changes production WGSL bytes and every
// byte-stable snapshot has to be regenerated; the measurement settled it — 208 of
// 6008 IR ops across the production modules, concentrated in the two per-fragment
// hot paths (line 1546 -> 1465, hillshade 657 -> 613). Being pure dedup it is in
// O1 too: the re-bake moved bytes, never pixels.

import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../../ir/index.js'
import {
  keyOf,
  isCompound,
  eachExpr,
  mapChildren,
  bodyHasRaw,
  collectLocals,
  collectMutatedRoots,
  refsLocal,
  isWorthHoisting,
} from './expr-utils.js'

/** The varref / param root names an expression reads. */
function rootsOf(e: Expr): Set<string> {
  const out = new Set<string>()
  eachExpr(e, (x) => {
    if (x.op === 'varref' || x.op === 'param') out.add(x.name)
  })
  return out
}

/** The exprs of a statement this block evaluates UNCONDITIONALLY (never the lvalue
 *  target).
 *
 *  An `if`'s FIRST arm condition belongs here (#1886): it runs on every path through
 *  this block, exactly like a `let` initialiser, so binding a repeat inside it to a
 *  temp placed before the statement adds no work on any path. It used to be absent —
 *  `default: []` covered every control-flow statement under the note "handled by
 *  recursion", which is true of the BODIES and false of the CONDITIONS. `cse`
 *  (../cse.ts, the input-only half of the family) has always walked `a.cond` and
 *  `s.scrut`; this is the same traversal for the local-touching half.
 *
 *  WORTH 6 CALL SITES ON ITS OWN — measured, not estimated: over the 87-source baked
 *  corpus, before vs after a real build + bake, raw call sites went 12239 -> 12233.
 *  The value is as the PREREQUISITE for cross-block dominance (#1886), where 144 of
 *  the 241 remaining repeats sit: the outer occurrence that dominates an inner
 *  recompute is usually the `if` condition, so until it is tallied there is no outer
 *  temp for the inner block to reuse. Do not quote a bigger number for this pass
 *  alone — the issue's opening figures came from a corpus that had 12 unrelated
 *  files in it and are corrected in its comments.
 *
 *  DELIBERATELY still absent, each because the expr is NOT evaluated once per
 *  execution of this block:
 *    • `arms[1..]` — an `else if` runs only when every earlier arm failed, so a temp
 *      before the `if` would compute it on paths the authored code does not. Same
 *      rule the `cond` flag in `tally` already applies to a `&&`/`||` RHS.
 *    • `for` cond/init/update — re-evaluated per iteration; lifting one is loop
 *      invariance, which is licm's job and needs a proof gvn does not have.
 *    • `switch` scrut — unconditional, so it is sound to add, but the whole
 *      production corpus has 26 `switch` headers against 2363 `if`s; it is left out
 *      rather than shipped on an argument instead of a measurement. */
function valueExprs(s: Stmt): readonly Expr[] {
  switch (s.s) {
    case 'let':
      return [s.expr]
    case 'var':
      return s.init !== undefined ? [s.init] : []
    case 'assign':
    case 'assignOp':
      return [s.expr]
    case 'return':
      return s.expr !== undefined ? [s.expr] : []
    case 'if':
      return s.arms.length > 0 ? [s.arms[0]!.cond] : []
    default:
      return [] // for / switch / break / continue / discard — see the note above
  }
}

/** Rewrite the unconditionally-evaluated exprs of a statement (lvalue target
 *  untouched). Mirrors `valueExprs` exactly — a condition that is tallied but not
 *  rewritten would mint a temp and leave the original recomputing beside it, so the
 *  two must name the same set. The arm BODIES are already GVN'd as their own blocks
 *  by `recurseBlocks` and are carried over as-is. */
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
    case 'if': {
      const [first, ...rest] = s.arms
      return first === undefined ? s : { ...s, arms: [{ ...first, cond: f(first.cond) }, ...rest] }
    }
    default:
      return s
  }
}

/** Names mutated by ONE statement: assignment-target roots (recursing into nested
 *  bodies, so an intervening if/for that writes a root is caught) PLUS a let/var's
 *  own declared name (a same-name redeclaration invalidates an earlier numbering). */
function mutatedBy(s: Stmt): Set<string> {
  const out = new Set<string>()
  collectMutatedRoots([s], out)
  if (s.s === 'let' || s.s === 'var') out.add(s.name)
  return out
}

interface Occur {
  stmts: Set<number> // distinct statement indices with an UNCONDITIONAL occurrence
  exemplar: Expr
}

// Walk a value expr, recording unconditional compound/worth/local-touching keys at
// statement `idx`; any key seen under a guard (cond=true) is excluded outright.
function tally(
  e: Expr,
  idx: number,
  cond: boolean,
  localSet: ReadonlySet<string>,
  occ: Map<string, Occur>,
  condKeys: Set<string>,
  loadRoots: ReadonlySet<string>,
): void {
  if (isCompound(e) && isWorthHoisting(e, loadRoots) && refsLocal(e, localSet)) {
    const k = keyOf(e)
    if (cond) {
      condKeys.add(k)
    } else {
      const o = occ.get(k)
      if (o) o.stmts.add(idx)
      else occ.set(k, { stmts: new Set([idx]), exemplar: e })
    }
  }
  switch (e.op) {
    case 'logical':
      tally(e.a, idx, cond, localSet, occ, condKeys, loadRoots)
      tally(e.b, idx, true, localSet, occ, condKeys, loadRoots)
      break
    case 'select':
      tally(e.cond, idx, cond, localSet, occ, condKeys, loadRoots)
      tally(e.ifTrue, idx, true, localSet, occ, condKeys, loadRoots)
      tally(e.ifFalse, idx, true, localSet, occ, condKeys, loadRoots)
      break
    case 'matchExpr':
      tally(e.scrutinee, idx, cond, localSet, occ, condKeys, loadRoots)
      for (const [, v] of e.cases) tally(v, idx, true, localSet, occ, condKeys, loadRoots)
      tally(e.default, idx, true, localSet, occ, condKeys, loadRoots)
      break
    case 'binop':
    case 'compare':
      tally(e.a, idx, cond, localSet, occ, condKeys, loadRoots)
      tally(e.b, idx, cond, localSet, occ, condKeys, loadRoots)
      break
    case 'unop':
      tally(e.a, idx, cond, localSet, occ, condKeys, loadRoots)
      break
    case 'call':
    case 'construct':
      for (const a of e.args) tally(a, idx, cond, localSet, occ, condKeys, loadRoots)
      break
    case 'member':
      tally(e.base, idx, cond, localSet, occ, condKeys, loadRoots)
      break
    case 'index':
      tally(e.base, idx, cond, localSet, occ, condKeys, loadRoots)
      tally(e.idx, idx, cond, localSet, occ, condKeys, loadRoots)
      break
    default:
      break // leaf
  }
}

/** A value an ENCLOSING block already bound to a temp, offered to nested blocks.
 *  `roots` travels with it so a mutation can retire it without re-deriving them. */
interface Avail {
  readonly name: string
  readonly roots: ReadonlySet<string>
}

/** The entries of `live` a nested statement may still trust.
 *
 *  `mutatedBy` recurses into nested bodies, so one filter covers every way the value
 *  could have moved on by the time the inner occurrence runs: an assignment anywhere
 *  inside the statement, and a `let`/`var` that SHADOWS a root (its own name is added
 *  to the set), which would silently make the inner expression a different one.
 *
 *  Applied to `if` as well as `for`, though only a loop strictly needs it: a loop's
 *  back edge means iteration 2 reads what iteration 1 wrote, so a temp bound before
 *  the loop is stale from the second pass on. Being equally conservative about an
 *  `if` costs one filter and removes a whole class of reasoning about which arm ran. */
function availableIn(s: Stmt, live: ReadonlyMap<string, Avail>): Map<string, Avail> {
  if (live.size === 0) return new Map()
  const mut = mutatedBy(s)
  const out = new Map<string, Avail>()
  for (const [k, a] of live) {
    let hit = false
    for (const r of a.roots) if (mut.has(r)) hit = true
    if (!hit) out.set(k, a)
  }
  return out
}

/** GVN one straight-line block: its OWN statements, then each nested block with the
 *  temps this one has bound so far in scope (#1886).
 *
 *  Nested blocks used to be numbered FIRST and in isolation, so a value the enclosing
 *  block had already computed was recomputed from scratch inside an `if`. Handing the
 *  binding down is free by construction — the outer `let` is evaluated on every path
 *  that reaches the inner block, so the inner read replaces work rather than adding
 *  it. That also makes it sound for a GUARDED inner occurrence, which minting a fresh
 *  temp never is: nothing new is computed, the value is simply already there. */
function gvnBlock(
  body: readonly Stmt[],
  localSet: ReadonlySet<string>,
  next: { n: number },
  loadRoots: ReadonlySet<string>,
  env: ReadonlyMap<string, Avail> = new Map(),
): Stmt[] {
  // 1. Tally cross-statement candidates over this block's value exprs. Recursion now
  //    happens in step 7 instead, so the temps minted here are in scope for it;
  //    `valueExprs` reads only this block's own statements, which recursion never
  //    rewrites, so nothing is lost by tallying before it.
  const rec = body
  const occ = new Map<string, Occur>()
  const condKeys = new Set<string>()
  rec.forEach((s, idx) => {
    for (const e of valueExprs(s)) tally(e, idx, false, localSet, occ, condKeys, loadRoots)
  })

  // 3. Keep keys that occur unconditionally in >= 2 distinct statements.
  //    No early return when empty: a block that mints nothing must still recurse, and
  //    with `env` it may now be the block that USES an enclosing temp.
  let cands = [...occ.entries()].filter(([k, o]) => !condKeys.has(k) && o.stmts.size >= 2)

  // 4. Maximal only — drop a key nested inside another candidate's exemplar (the outer
  //    temp subsumes it; a later fixpoint pass picks up any standalone inner repeat).
  const candSet = new Set(cands.map(([k]) => k))
  const nested = new Set<string>()
  for (const [, o] of cands) {
    eachExpr(o.exemplar, (sub) => {
      if (sub === o.exemplar) return
      const sk = keyOf(sub)
      if (candSet.has(sk)) nested.add(sk)
    })
  }
  cands = cands.filter(([k]) => !nested.has(k))

  // 5. Reassignment check: drop a key if any statement in [first, last) mutates a root it reads.
  const safe = cands.filter(([, o]) => {
    const idxs = [...o.stmts].sort((a, b) => a - b)
    const first = idxs[0]!,
      last = idxs[idxs.length - 1]!
    const roots = rootsOf(o.exemplar)
    for (let m = first; m < last; m++) {
      const mut = mutatedBy(rec[m]!)
      for (const r of roots) if (mut.has(r)) return false
    }
    return true
  })

  // 6. Assign a temp per safe key + record where its `let` lands (before its first stmt).
  const insertBefore = new Map<number, Array<{ name: string; expr: Expr }>>()
  for (const [, o] of safe) {
    const first = Math.min(...o.stmts)
    const lets = insertBefore.get(first) ?? []
    lets.push({ name: `_gv${next.n++}`, expr: o.exemplar })
    insertBefore.set(first, lets)
  }

  // 7. ONE ordered walk: splice each `let` in, rewrite the statement against everything
  //    bound so far (this block's temps plus the enclosing ones `env` handed down),
  //    recurse into nested blocks with that same set, then retire whatever the
  //    statement moved on from. Order matters: a temp minted AT idx is live for
  //    statement idx itself — which is how an `if` whose condition holds the first
  //    occurrence can offer it to its own arms.
  const live = new Map<string, Avail>(env)
  const out: Stmt[] = []
  rec.forEach((s, idx) => {
    for (const l of insertBefore.get(idx) ?? []) {
      out.push({ s: 'let', name: l.name, expr: l.expr })
      live.set(keyOf(l.expr), { name: l.name, roots: rootsOf(l.expr) })
    }
    const replace = (e: Expr): Expr => {
      const a = live.get(keyOf(e))
      if (a !== undefined) return { op: 'varref', type: e.type, name: a.name }
      return mapChildren(e, replace)
    }
    // The RHS of an assign is evaluated BEFORE the write, so rewriting statement idx
    // against the pre-statement `live` is right; the retirement below is for idx+1 on.
    out.push(
      mapStmtValue(recurseBlocks(s, localSet, next, loadRoots, availableIn(s, live)), replace),
    )
    const mut = mutatedBy(s)
    if (mut.size > 0)
      for (const [k, a] of [...live]) {
        for (const r of a.roots)
          if (mut.has(r)) {
            live.delete(k)
            break
          }
      }
  })
  return out
}

// Rebuild a control-flow statement with each nested body GVN'd as its own block,
// carrying `env` — the enclosing bindings that survive this statement's own writes.
function recurseBlocks(
  s: Stmt,
  localSet: ReadonlySet<string>,
  next: { n: number },
  loadRoots: ReadonlySet<string>,
  env: ReadonlyMap<string, Avail>,
): Stmt {
  switch (s.s) {
    case 'if':
      return {
        ...s,
        arms: s.arms.map((a) => ({
          cond: a.cond,
          body: gvnBlock(a.body, localSet, next, loadRoots, env),
        })),
        elseBody: s.elseBody ? gvnBlock(s.elseBody, localSet, next, loadRoots, env) : undefined,
      }
    case 'for':
      return { ...s, body: gvnBlock(s.body, localSet, next, loadRoots, env) }
    case 'switch':
      return {
        ...s,
        cases: s.cases.map((c) => ({
          value: c.value,
          body: gvnBlock(c.body, localSet, next, loadRoots, env),
        })),
        defaultBody: s.defaultBody
          ? gvnBlock(s.defaultBody, localSet, next, loadRoots, env)
          : undefined,
      }
    default:
      return s
  }
}

function gvnFn(f: FuncDecl, loadRoots: ReadonlySet<string>): FuncDecl {
  if (bodyHasRaw(f.body)) return f // raw WGSL is opaque
  const localSet = new Set<string>()
  collectLocals(f.body, localSet)
  collectMutatedRoots(f.body, localSet)
  // Seed past any existing `_gvN` so a second fixpoint pass can't redeclare `_gv0`.
  let base = 0
  for (const n of localSet) {
    const mm = /^_gv(\d+)$/.exec(n)
    if (mm) base = Math.max(base, Number(mm[1]) + 1)
  }
  return { ...f, body: gvnBlock(f.body, localSet, { n: base }, loadRoots) }
}

/** Cross-statement value numbering of local-touching repeats. Pure (module → module). */
export function gvn(m: ModuleDecl): ModuleDecl {
  // Indexing one of these is a memory load, not free addressing (#1886).
  const loadRoots = new Set(m.bindings.map((b) => b.name))
  return { ...m, funcs: m.funcs.map((f) => gvnFn(f, loadRoots)) }
}
