// ═══ Shader DSL — common-subexpression elimination (Optimization context) ═══
//
// Hoists a compound subexpression that occurs >= 2x and depends ONLY on fn
// inputs (params / consts / bindings — no local `let`) into a single `let`,
// replacing each occurrence with a varref. This is a PASS over the IR,
// not an authoring change (the critic's "hash-consing rebuilds authoring" risk
// does not apply — `new Node(...)` is untouched).
//
// This is the auto-cache that lets authors write plain inline expressions instead of
// hand `Let` bindings: a value reused N times is emitted ONCE here. Hoists the MAXIMAL
// repeated expr (the outermost — `sqrt(dot(p,p))`, not just the inner `dot(p,p)`), so a
// single temp subsumes the whole shared value the author would have bound by hand. The
// maximal set never nests itself, so there is no replacement-ordering interaction; a fn
// containing a raw Stmt is skipped (raw WGSL is opaque). Correctness is pinned by oracle
// value-equality. (Input-only is still the safe boundary: a repeat reading a MUTATED root
// is excluded — its value changes, so it is not shareable.)
//
// PLACEMENT — the `let` goes at the SHALLOWEST POINT THAT STILL DOMINATES EVERY USE,
// not at the fn top (#hillshade-perf). Dedup is a source-level win; running the value
// is a per-invocation COST, and a temp parked at the fn top is paid by every invocation
// even when all its uses sit inside one mutually-exclusive branch. A 5-way method
// dispatch (fs_hillshade) fn-top-hoisted this way makes every fragment execute all five
// methods' math — measured: `basic`, `standard` and `multidirectional` cost the SAME,
// and deleting the dispatch cut hillshade's fragment cost ~52%. So each temp is bound at
// the top of the innermost placement block containing all its uses, immediately before
// the first statement that uses it (later placement is never worse — it also lets an
// early `discard` skip the work). A `for` body is NEVER a placement block: a let inside
// a loop re-evaluates per iteration, strictly worse than the enclosing block, so a `for`
// is attributed whole to the statement it sits at (LICM owns loop-invariant motion).
// Every hoisted expr is input-only, so it is valid anywhere in the fn — placement can
// only trade WHERE it runs, never WHETHER its value is the same.

import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../../ir/index.js'
import { eachStmtExpr, mapStmtExpr } from '../../ir/visit.js'
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

/** Where one occurrence of a subexpression lives: the placement BLOCK (a path of
 *  `${stmtIndex}#${childBlockId}` steps from the fn body) and the index, within that
 *  block, of the statement containing it. */
interface Occurrence {
  readonly bp: readonly string[]
  readonly idx: number
}

/** Visit every expr node in `body`, tagged with its placement block + block-level
 *  statement index. `if` arms / `else` / `switch` cases are nested placement blocks;
 *  an arm's CONDITION belongs to the ENCLOSING block (that is where it is evaluated).
 *  A `for` is not descended into — its whole subtree reports at the `for` itself, so
 *  nothing is ever placed inside a loop. */
function eachOccurrence(
  body: readonly Stmt[],
  bp: readonly string[],
  visit: (e: Expr, bp: readonly string[], idx: number) => void,
): void {
  body.forEach((s, idx) => {
    const node = (e: Expr) => visit(e, bp, idx)
    switch (s.s) {
      case 'if':
        s.arms.forEach((a, ai) => {
          eachExpr(a.cond, node)
          eachOccurrence(a.body, [...bp, `${idx}#a${ai}`], visit)
        })
        if (s.elseBody) eachOccurrence(s.elseBody, [...bp, `${idx}#e`], visit)
        break
      case 'switch':
        eachExpr(s.scrut, node)
        s.cases.forEach((c, ci) => eachOccurrence(c.body, [...bp, `${idx}#c${ci}`], visit))
        if (s.defaultBody) eachOccurrence(s.defaultBody, [...bp, `${idx}#d`], visit)
        break
      default:
        // eachStmtExpr walks the nested bodies too (`for`), and eachExpr the
        // descendants of every Expr it hands back.
        eachStmtExpr(s, (e) => eachExpr(e, node))
        break
    }
  })
}

/** The shallowest block dominating every occurrence, and the earliest statement index
 *  in it that leads to one — the insertion point. The common block is the longest
 *  common prefix of the occurrence block-paths; an occurrence deeper than that prefix
 *  contributes the statement index encoded in its next path step. */
function placementOf(list: readonly Occurrence[]): { bp: readonly string[]; idx: number } {
  let bp = list[0]!.bp
  for (const o of list) {
    let n = 0
    while (n < bp.length && n < o.bp.length && bp[n] === o.bp[n]) n++
    bp = bp.slice(0, n)
  }
  let idx = Number.POSITIVE_INFINITY
  for (const o of list) {
    const own = o.bp.length === bp.length ? o.idx : Number(o.bp[bp.length]!.split('#')[0])
    if (own < idx) idx = own
  }
  return { bp, idx }
}

function cseFn(f: FuncDecl): FuncDecl {
  if (bodyHasRaw(f.body)) return f
  // Non-invariant names: function locals AND any mutated name (incl. a read_write
  // binding written in this fn). A read of a mutated name is not safely shareable.
  const noHoist = new Set<string>()
  collectLocals(f.body, noHoist)
  collectMutatedRoots(f.body, noHoist)

  // Count occurrences of every compound, input-only subexpression — and record WHERE
  // each one occurs, so the temp can be bound at their common block instead of fn top.
  const counts = new Map<string, number>()
  const exemplar = new Map<string, Expr>()
  const sites = new Map<string, Occurrence[]>()
  eachOccurrence(f.body, [], (e, bp, idx) => {
    if (!isCompound(e) || !isWorthHoisting(e) || refsLocal(e, noHoist)) return
    const k = keyOf(e)
    counts.set(k, (counts.get(k) ?? 0) + 1)
    if (!exemplar.has(k)) exemplar.set(k, e)
    const at = sites.get(k)
    if (at) at.push({ bp, idx })
    else sites.set(k, [{ bp, idx }])
  })
  const repeated = new Set<string>([...counts].filter(([, n]) => n >= 2).map(([k]) => k))
  if (repeated.size === 0) return f

  // Keep only the MAXIMAL repeated exprs — those NOT nested inside another repeated
  // expr. Hoisting the outermost (e.g. `sqrt(dot(p,p))`) binds the whole shared value
  // the developer would have bound by hand, and its replacement subsumes every inner
  // repeat in one temp (vs the inner-only hoist that left `sqrt(_cse0)` repeated). The
  // maximal set never nests itself, so there is still no replacement-ordering interaction,
  // and every member is input-only (refsLocal filtered) so fn-top placement stays valid.
  const nestedInside = new Set<string>()
  for (const k of repeated) {
    eachExpr(exemplar.get(k)!, (sub) => {
      if (sub === exemplar.get(k)) return
      const sk = keyOf(sub)
      if (repeated.has(sk)) nestedInside.add(sk)
    })
  }
  const maximal = [...repeated].filter((k) => !nestedInside.has(k))
  if (maximal.length === 0) return f

  // Seed the temp index past any existing `_cseN` binding so a SECOND cse pass
  // cannot redeclare `_cse0`. cse runs TWICE on the optimize()->emitModule() path
  // (optimize includes cse; the WGSL backend's emit-time `optimize` is cse again),
  // and the maximal-only filter can leave a nested repeat un-hoisted when it ALSO
  // occurs standalone — the next pass then hoists it, and a per-call counter reset
  // would emit a colliding `let _cse0`. (noHoist already holds every local, incl.
  // the prior pass's _cseN, via collectLocals.)
  let base = 0
  for (const n of noHoist) {
    const mm = /^_cse(\d+)$/.exec(n)
    if (mm) base = Math.max(base, Number(mm[1]) + 1)
  }

  // Assign a temp per maximal key and file its `let` under the block + statement index
  // that dominates every use (see PLACEMENT in the header).
  const temp = new Map<string, string>()
  const plan = new Map<string, Map<number, Stmt[]>>()
  maximal.forEach((k, i) => {
    const name = `_cse${base + i}`
    temp.set(k, name)
    const { bp, idx } = placementOf(sites.get(k)!)
    const blockKey = bp.join('|')
    let byIdx = plan.get(blockKey)
    if (!byIdx) plan.set(blockKey, (byIdx = new Map()))
    const at = byIdx.get(idx)
    const stmt: Stmt = { s: 'let', name, expr: exemplar.get(k)! }
    if (at) at.push(stmt)
    else byIdx.set(idx, [stmt])
  })

  const replace = (e: Expr): Expr => {
    const t = temp.get(keyOf(e))
    if (t !== undefined) return { op: 'varref', type: e.type, name: t }
    return mapChildren(e, replace)
  }

  // Rebuild the body, splicing each block's planned lets in before the statement they
  // were filed against. Block paths are constructed IDENTICALLY to eachOccurrence's.
  const rewriteBlock = (body: readonly Stmt[], bp: readonly string[]): Stmt[] => {
    const byIdx = plan.get(bp.join('|'))
    const out: Stmt[] = []
    body.forEach((s, idx) => {
      const lets = byIdx?.get(idx)
      if (lets) out.push(...lets)
      out.push(rewriteStmt(s, bp, idx))
    })
    return out
  }
  const rewriteStmt = (s: Stmt, bp: readonly string[], idx: number): Stmt => {
    switch (s.s) {
      case 'if':
        return {
          ...s,
          arms: s.arms.map((a, ai) => ({
            cond: replace(a.cond),
            body: rewriteBlock(a.body, [...bp, `${idx}#a${ai}`]),
          })),
          elseBody: s.elseBody ? rewriteBlock(s.elseBody, [...bp, `${idx}#e`]) : undefined,
        }
      case 'switch':
        return {
          ...s,
          scrut: replace(s.scrut),
          cases: s.cases.map((c, ci) => ({
            value: c.value,
            body: rewriteBlock(c.body, [...bp, `${idx}#c${ci}`]),
          })),
          defaultBody: s.defaultBody ? rewriteBlock(s.defaultBody, [...bp, `${idx}#d`]) : undefined,
        }
      default:
        // `for` included: mapStmtExpr replaces through its whole subtree, which is
        // exactly right — nothing was placed inside it.
        return mapStmtExpr(s, replace)
    }
  }
  return { ...f, body: rewriteBlock(f.body, []) }
}

/** Hoist repeated input-only subexpressions to shared temps. Pure (module -> module). */
export function cse(m: ModuleDecl): ModuleDecl {
  return { ...m, funcs: m.funcs.map(cseFn) }
}
