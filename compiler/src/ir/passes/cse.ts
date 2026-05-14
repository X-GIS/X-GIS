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

import type { Scene, ColorValue, DataExpr, ConditionalBranch } from '../render-node'
import type { PropertyShape } from '../property-types'
import type { Expr } from '../../parser/ast'
import { canonicalExpr } from '../cse-hash'

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
    if (!arr) { arr = []; buckets.set(key, arr) }
    arr.push(e)
    visitChildren(e)
  }

  function visitChildren(e: Expr): void {
    switch (e.kind) {
      case 'FieldAccess':
        if (e.object) visit(e.object)
        return
      case 'FnCall':
        visit(e.callee)
        for (const a of e.args) visit(a)
        if (e.matchBlock) for (const arm of e.matchBlock.arms) visit(arm.value)
        return
      case 'BinaryExpr':
        visit(e.left); visit(e.right); return
      case 'UnaryExpr':
        visit(e.operand); return
      case 'PipeExpr':
        visit(e.input)
        for (const t of e.transforms) visit(t)
        return
      case 'ConditionalExpr':
        visit(e.condition); visit(e.thenExpr); visit(e.elseExpr); return
      case 'ArrayLiteral':
        for (const el of e.elements) visit(el); return
      case 'ArrayAccess':
        visit(e.array); visit(e.index); return
      case 'MatchBlock':
        for (const arm of e.arms) visit(arm.value); return
      // Leaf kinds: NumberLiteral, StringLiteral, ColorLiteral,
      // BoolLiteral, Identifier — no children to visit.
      default: return
    }
  }

  function visitDataExpr(e: DataExpr | null | undefined): void {
    if (!e) return
    visit(e.ast as Expr)
  }

  function visitColorValue(v: ColorValue): void {
    switch (v.kind) {
      case 'none':
      case 'constant':
      case 'zoom-interpolated':
      case 'time-interpolated':
        return
      case 'data-driven':
        visitDataExpr(v.expr); return
      case 'conditional':
        for (const br of v.branches as ConditionalBranch<ColorValue>[]) {
          visitColorValue(br.value)
        }
        visitColorValue(v.fallback)
        return
    }
  }

  function visitPropertyShape<T>(shape: PropertyShape<T>): void {
    if (shape.kind === 'data-driven') visitDataExpr(shape.expr)
  }

  for (const node of scene.renderNodes) {
    visitColorValue(node.fill)
    visitColorValue(node.stroke.color)
    visitDataExpr((node.stroke as { colorExpr?: DataExpr }).colorExpr)
    visitPropertyShape(node.stroke.width)
    visitPropertyShape(node.opacity)
    // SizeValue is a separate union (different kind names than
    // PropertyShape) but the data-driven variant carries a DataExpr.
    if (node.size.kind === 'data-driven') visitDataExpr(node.size.expr)
    visitDataExpr(node.filter)
    visitDataExpr(node.geometry)
    if (node.extrude?.kind === 'feature') {
      visitDataExpr((node.extrude as { expr?: DataExpr }).expr)
    }
    if (node.extrudeBase?.kind === 'feature') {
      visitDataExpr((node.extrudeBase as { expr?: DataExpr }).expr)
    }
  }

  const entries: CSEEntry[] = []
  for (const [key, occurrences] of buckets) {
    entries.push({ key, occurrences, count: occurrences.length })
  }
  // Sort descending by count so the largest dedup opportunities
  // surface first in diagnostics.
  entries.sort((a, b) => b.count - a.count)
  const duplicates = entries.filter(e => e.count > 1)

  return { entries, duplicates, totalNodes }
}

/** Convenience predicate — true when the Scene has at least one
 *  duplicate subtree. Lets callers gate "is CSE worth running"
 *  without iterating the report. */
export function hasCSEOpportunities(scene: Scene): boolean {
  return analyzeCSE(scene).duplicates.length > 0
}
