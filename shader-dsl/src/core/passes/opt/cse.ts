// ═══ Shader DSL — common-subexpression elimination (Optimization context) ═══
//
// Hoists a compound subexpression that occurs >= 2x and depends ONLY on fn
// inputs (params / consts / bindings — no local `let`) into a single `let` at the
// fn top, replacing each occurrence with a varref. This is a PASS over the IR,
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

import type { Expr, Stmt, ModuleDecl, FuncDecl } from '../../ir'
import {
  keyOf,
  isCompound,
  eachExpr,
  mapChildren,
  forEachTopExpr,
  mapStmtTop,
  bodyHasRaw,
  collectLocals,
  collectMutatedRoots,
  refsLocal,
} from './expr-utils'

// Trivial navigation — a member/swizzle/index chain bottoming out at a leaf
// (`u.proj_params.x`, `fill_color.rgb`) — is as cheap inlined as bound, so a shared
// `let` for it is pure overhead (and bloats the WGSL). Only hoist exprs that actually
// COMPUTE: at least one binop / unop / compare / logical / call / construct / select.
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

function cseFn(f: FuncDecl): FuncDecl {
  if (bodyHasRaw(f.body)) return f
  // Non-invariant names: function locals AND any mutated name (incl. a read_write
  // binding written in this fn). A read of a mutated name is not safely shareable.
  const noHoist = new Set<string>()
  collectLocals(f.body, noHoist)
  collectMutatedRoots(f.body, noHoist)

  // Count occurrences of every compound, input-only subexpression.
  const counts = new Map<string, number>()
  const exemplar = new Map<string, Expr>()
  for (const s of f.body) {
    forEachTopExpr(s, (e) => {
      if (!isCompound(e) || !isWorthHoisting(e) || refsLocal(e, noHoist)) return
      const k = keyOf(e)
      counts.set(k, (counts.get(k) ?? 0) + 1)
      if (!exemplar.has(k)) exemplar.set(k, e)
    })
  }
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

  // Assign a temp per maximal key; build the hoisted lets + replacement map.
  const temp = new Map<string, string>()
  const lets: Stmt[] = []
  maximal.forEach((k, i) => {
    const name = `_cse${base + i}`
    temp.set(k, name)
    lets.push({ s: 'let', name, expr: exemplar.get(k)! })
  })

  const replace = (e: Expr): Expr => {
    const t = temp.get(keyOf(e))
    if (t !== undefined) return { op: 'varref', type: e.type, name: t }
    return mapChildren(e, replace)
  }
  const newBody = f.body.map((s) => mapStmtTop(s, replace))
  return { ...f, body: [...lets, ...newBody] }
}

/** Hoist repeated input-only subexpressions to shared temps. Pure (module -> module). */
export function cse(m: ModuleDecl): ModuleDecl {
  return { ...m, funcs: m.funcs.map(cseFn) }
}
