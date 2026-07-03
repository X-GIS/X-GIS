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
// Available-but-unwired, like inlineFn / deadFnElim / autoInline: NOT in
// DEFAULT_PASSES (it would change production WGSL bytes -> the byte-stable
// shared-prelude golden snapshots would need regenerating, a maintainer call).

import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../../ir'
import {
  keyOf,
  isCompound,
  eachExpr,
  mapChildren,
  bodyHasRaw,
  collectLocals,
  collectMutatedRoots,
  refsLocal,
} from './expr-utils'

// Only number exprs that COMPUTE — a bare member/swizzle/index navigation is as
// cheap inlined as bound (mirrors cse / cse-local isWorthHoisting).
function isWorthHoisting(e: Expr): boolean {
  let computes = false
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
    )
      computes = true
  })
  return computes
}

/** The varref / param root names an expression reads. */
function rootsOf(e: Expr): Set<string> {
  const out = new Set<string>()
  eachExpr(e, (x) => {
    if (x.op === 'varref' || x.op === 'param') out.add(x.name)
  })
  return out
}

/** The value-carrying exprs of a SIMPLE statement (never the lvalue target). */
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
    default:
      return [] // control-flow / break / continue / discard — handled by recursion
  }
}

/** Rewrite only the value side of a simple statement (lvalue target untouched). */
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
): void {
  if (isCompound(e) && isWorthHoisting(e) && refsLocal(e, localSet)) {
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
      tally(e.a, idx, cond, localSet, occ, condKeys)
      tally(e.b, idx, true, localSet, occ, condKeys)
      break
    case 'select':
      tally(e.cond, idx, cond, localSet, occ, condKeys)
      tally(e.ifTrue, idx, true, localSet, occ, condKeys)
      tally(e.ifFalse, idx, true, localSet, occ, condKeys)
      break
    case 'matchExpr':
      tally(e.scrutinee, idx, cond, localSet, occ, condKeys)
      for (const [, v] of e.cases) tally(v, idx, true, localSet, occ, condKeys)
      tally(e.default, idx, true, localSet, occ, condKeys)
      break
    case 'binop':
    case 'compare':
      tally(e.a, idx, cond, localSet, occ, condKeys)
      tally(e.b, idx, cond, localSet, occ, condKeys)
      break
    case 'unop':
      tally(e.a, idx, cond, localSet, occ, condKeys)
      break
    case 'call':
    case 'construct':
      for (const a of e.args) tally(a, idx, cond, localSet, occ, condKeys)
      break
    case 'member':
      tally(e.base, idx, cond, localSet, occ, condKeys)
      break
    case 'index':
      tally(e.base, idx, cond, localSet, occ, condKeys)
      tally(e.idx, idx, cond, localSet, occ, condKeys)
      break
    default:
      break // leaf
  }
}

// GVN one straight-line block (its OWN statements; nested blocks are recursed first).
function gvnBlock(
  body: readonly Stmt[],
  localSet: ReadonlySet<string>,
  next: { n: number },
): Stmt[] {
  // 1. Recurse into nested blocks first (inner blocks get their own numbering).
  const rec = body.map((s) => recurseBlocks(s, localSet, next))

  // 2. Tally cross-statement candidates over this block's value exprs.
  const occ = new Map<string, Occur>()
  const condKeys = new Set<string>()
  rec.forEach((s, idx) => {
    for (const e of valueExprs(s)) tally(e, idx, false, localSet, occ, condKeys)
  })

  // 3. Keep keys that occur unconditionally in >= 2 distinct statements.
  let cands = [...occ.entries()].filter(([k, o]) => !condKeys.has(k) && o.stmts.size >= 2)
  if (cands.length === 0) return rec

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
  if (safe.length === 0) return rec

  // 6. Assign a temp per safe key + record where its `let` lands (before its first stmt).
  const temp = new Map<string, string>()
  const insertBefore = new Map<number, Stmt[]>()
  for (const [k, o] of safe) {
    const name = `_gv${next.n++}`
    temp.set(k, name)
    const first = Math.min(...o.stmts)
    const lets = insertBefore.get(first) ?? []
    lets.push({ s: 'let', name, expr: o.exemplar })
    insertBefore.set(first, lets)
  }

  // 7. Replace occurrences (all are unconditional — condKeys excluded) + splice in the lets.
  const replace = (e: Expr): Expr => {
    const nm = temp.get(keyOf(e))
    if (nm !== undefined) return { op: 'varref', type: e.type, name: nm }
    return mapChildren(e, replace)
  }
  const out: Stmt[] = []
  rec.forEach((s, idx) => {
    const lets = insertBefore.get(idx)
    if (lets) out.push(...lets)
    out.push(mapStmtValue(s, replace))
  })
  return out
}

// Rebuild a control-flow statement with each nested body GVN'd as its own block.
function recurseBlocks(s: Stmt, localSet: ReadonlySet<string>, next: { n: number }): Stmt {
  switch (s.s) {
    case 'if':
      return {
        ...s,
        arms: s.arms.map((a) => ({ cond: a.cond, body: gvnBlock(a.body, localSet, next) })),
        elseBody: s.elseBody ? gvnBlock(s.elseBody, localSet, next) : undefined,
      }
    case 'for':
      return { ...s, body: gvnBlock(s.body, localSet, next) }
    case 'switch':
      return {
        ...s,
        cases: s.cases.map((c) => ({ value: c.value, body: gvnBlock(c.body, localSet, next) })),
        defaultBody: s.defaultBody ? gvnBlock(s.defaultBody, localSet, next) : undefined,
      }
    default:
      return s
  }
}

function gvnFn(f: FuncDecl): FuncDecl {
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
  return { ...f, body: gvnBlock(f.body, localSet, { n: base }) }
}

/** Cross-statement value numbering of local-touching repeats. Pure (module → module). */
export function gvn(m: ModuleDecl): ModuleDecl {
  return { ...m, funcs: m.funcs.map(gvnFn) }
}
