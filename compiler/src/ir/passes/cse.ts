// ═══════════════════════════════════════════════════════════════════
// CSE analysis pass — find duplicate subtrees across a Scene
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 0 Step 3 (wild-finding-starlight) actual pass. Walks
// every `RenderNode`'s paint expressions + filter expressions,
// groups them by their canonical AST string (see ../cse-hash.ts),
// and returns the duplicate subset.
//
// Why analysis-first vs straight transformation:
//
//   - The transformation rewrites the IR to share node references.
//     That's tightly coupled to the downstream consumer (P4 compute
//     material evaluator, shader-gen's variant cache key, etc.).
//     The analysis can land NOW and surface optimisation opportunities
//     without committing to a specific rewrite shape.
//
//   - Tests + diagnostics get a stable interface: `analyzeCSE(scene)`
//     returns a `CSEReport` that's pure data, easy to assert on.
//     Future passes consume this report instead of re-walking.
//
//   - Real-world styles (OFM Bright, OFM Liberty) have only a handful
//     of duplicate subtrees — typically `get('class')` referenced in
//     a layer's fill match() AND its stroke match(). The report
//     quantifies whether CSE is worth the implementation cost on a
//     given style before any actual rewrite work.
//
// Future passes (not in this commit):
//
//   - `applyCSE(scene, report)` — rewrites the IR so duplicate
//     subtrees share a `cseId` annotation. P4's compute material
//     evaluator emits one kernel slot per unique `cseId` instead of
//     one per fill/stroke axis.
//
//   - Shader-gen integration: replace the hand-rolled `matchArmsKey`
//     with a hash drawn from the CSEReport.

import type { Scene } from '../render-node'
import type { Expr } from '../../parser/ast'
import { canonicalExpr } from '../cse-hash'
import { forEachExprChild, forEachSceneExpr } from '../walk-expr'

/** One entry per unique canonical-string seen during the walk. */
export interface CSEEntry {
  /** Canonical AST string (the dedup key). */
  key: string
  /** Every Expr node that produced this key. Order = walk order
   *  (deterministic — depth-first over scene.renderNodes). */
  occurrences: Expr[]
  /** Convenience — `occurrences.length`. */
  count: number
}

/** Analysis output. `entries` lists every unique subtree; `duplicates`
 *  is the subset with `count > 1` — actual CSE candidates. */
export interface CSEReport {
  entries: CSEEntry[]
  duplicates: CSEEntry[]
  /** Total number of AST nodes visited across the whole Scene
   *  (counts every nested subtree, NOT just the top-level expressions
   *  attached to render nodes). Diagnostic + sanity check. */
  totalNodes: number
}

/** Walk the Scene, collect canonical-string occurrences for every
 *  AST subtree reachable from a paint property or filter, and return
 *  the dedup report. Pure — input is not mutated. */
export function analyzeCSE(scene: Scene): CSEReport {
  const buckets = new Map<string, Expr[]>()
  let totalNodes = 0

  function visit(e: Expr): void {
    totalNodes++
    const key = canonicalExpr(e)
    let arr = buckets.get(key)
    if (!arr) {
      arr = []
      buckets.set(key, arr)
    }
    arr.push(e)
    forEachExprChild(e, visit)
  }

  forEachSceneExpr(scene, visit)

  const entries: CSEEntry[] = []
  for (const [key, occurrences] of buckets) {
    entries.push({ key, occurrences, count: occurrences.length })
  }
  // Sort descending by count so the largest dedup opportunities
  // surface first in diagnostics.
  entries.sort((a, b) => b.count - a.count)
  const duplicates = entries.filter((e) => e.count > 1)

  return { entries, duplicates, totalNodes }
}

/** Convenience predicate — true when the Scene has at least one
 *  duplicate subtree. Lets callers gate "is CSE worth running"
 *  without iterating the report. */
export function hasCSEOpportunities(scene: Scene): boolean {
  return analyzeCSE(scene).duplicates.length > 0
}
