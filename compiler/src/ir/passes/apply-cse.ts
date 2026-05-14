// ═══════════════════════════════════════════════════════════════════
// applyCSE — side-table annotation of duplicate subtrees
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 0 Step 3b (wild-finding-starlight). Turns the analysis
// produced by `analyzeCSE` into a downstream-consumable annotation:
// a WeakMap from `Expr` (by reference) to a dense integer `cseId`.
// Two Expr nodes whose canonical AST string is equal share the same
// `cseId`. Singletons (no duplicate) also receive an id so consumers
// can rely on "every visited Expr has an id" without null-checks.
//
// Why a side table and not an IR field:
//
//   - Pure compiler stage. The IR (`Scene` / `RenderNode`) keeps its
//     existing shape; consumers opt in by carrying a `CSEAnnotation`
//     parameter where they want dedup decisions. No widening of AST
//     `Expr` types, no consumer broken by the optional field.
//
//   - WeakMap keys by reference so renamed / re-created Expr nodes
//     in later passes don't keep stale ids. The annotation is
//     valid for the Scene it was built against; rebuilding is cheap.
//
//   - Cheap test surface — assertions read the side table directly
//     without poking into AST shapes.
//
// Future passes (not in this commit):
//
//   - `compute-plan.ts` can hash by `cseId` instead of WGSL string
//     equality, folding identical match() kernels on fill+stroke
//     into a single ComputeKernel.
//
//   - `shader-gen.ts` can replace its hand-rolled `matchArmsKey`
//     with `cseId` for the same dedup, removing string-compare
//     overhead from the variant cache.
//
//   - A later transformation pass can rewrite the IR so duplicate
//     subtrees share a SINGLE Expr reference (true CSE), at which
//     point this side table becomes the source of truth for the
//     rewrite mapping.
//
// What this module does NOT do:
//
//   - Mutate the Scene or IR. Output is pure data.
//   - Choose a representative Expr per id. The first occurrence in
//     walk order is conventionally id N; the report's `occurrences`
//     list preserves order so callers can pick `occurrences[0]` as
//     the canonical instance.
//   - Decide whether a consumer SHOULD dedup. The annotation just
//     surfaces identity; the consumer's policy lives at its own
//     layer.

import type { Expr } from '../../parser/ast'
import type { CSEReport } from './cse'
import { analyzeCSE } from './cse'
import type { Scene } from '../render-node'

/** Side-table mapping built from a CSEReport. */
export interface CSEAnnotation {
  /** `cseId` for an Expr looked up by reference. Returns undefined
   *  for Expr nodes that weren't visited (e.g. AST fragments outside
   *  the paint/filter/geometry walk). Consumers should treat
   *  undefined as "no dedup info" and fall back to one-off handling. */
  cseIdByExpr: WeakMap<Expr, number>
  /** Reverse lookup: id → canonical AST string. Lets diagnostics
   *  print "id 7 = F(class;~)" without re-canonicalising. */
  canonicalById: Map<number, string>
  /** Number of distinct ids assigned == number of unique canonical
   *  strings observed across the Scene. */
  uniqueCount: number
  /** Total Expr visits — equal to `report.totalNodes`. Diagnostic. */
  totalNodes: number
}

/** Build the annotation directly from a CSEReport. Pure — input is
 *  not modified. */
export function applyCSEFromReport(report: CSEReport): CSEAnnotation {
  const cseIdByExpr = new WeakMap<Expr, number>()
  const canonicalById = new Map<number, string>()
  // Stable, deterministic id assignment: sort by descending count
  // first (so the heaviest dedup candidates get the lowest ids,
  // useful when consumers cap "top-N dedups" by id range), then
  // fall back to canonical string for ties so the assignment is
  // reproducible across runs. The report already sorts by count
  // descending; ties break naturally on iteration order of the
  // underlying Map, which is insertion order — also deterministic.
  let nextId = 0
  for (const entry of report.entries) {
    const id = nextId++
    canonicalById.set(id, entry.key)
    for (const expr of entry.occurrences) {
      cseIdByExpr.set(expr, id)
    }
  }
  return {
    cseIdByExpr,
    canonicalById,
    uniqueCount: nextId,
    totalNodes: report.totalNodes,
  }
}

/** Convenience entry point: analyzeCSE + applyCSEFromReport in one
 *  call. Use this when you don't need the report separately. */
export function applyCSE(scene: Scene): CSEAnnotation {
  return applyCSEFromReport(analyzeCSE(scene))
}

/** Predicate — true iff two Expr nodes share a cseId. Returns false
 *  when either node lacks an entry in the annotation. Useful at
 *  consumer sites: "should I dedup this with that?" */
export function sameCSE(
  annotation: CSEAnnotation,
  a: Expr,
  b: Expr,
): boolean {
  const ia = annotation.cseIdByExpr.get(a)
  if (ia === undefined) return false
  const ib = annotation.cseIdByExpr.get(b)
  if (ib === undefined) return false
  return ia === ib
}
