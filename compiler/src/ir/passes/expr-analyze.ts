// ═══════════════════════════════════════════════════════════════════
// expr-analyze — per-Expr structural + purity metadata pass
// ═══════════════════════════════════════════════════════════════════
//
// iter-269 (compiler advancement Tier 1). Walks every Expr reachable
// from a Scene's paint / filter / geometry surfaces and computes a
// metadata side-table (WeakMap<Expr, ExprMeta>) carrying structural
// + dataflow facts that downstream optimisers and codegen consume:
//
//   - `depth`         AST depth (leaf = 1).
//   - `matchArmCount` Number of arms iff Expr is a MatchBlock or an
//                     FnCall hosting one; 0 otherwise. Lets the
//                     WGSL match codegen pick switch vs select chain.
//   - `allArmsConst`  True iff Expr is a MatchBlock whose every arm
//                     value is a literal. Enables const-LUT codegen.
//   - `idempotent`    Pure under repeated evaluation (no random(),
//                     no time-now(), no atlas-state-read, …). All
//                     known X-GIS builtins are pure today, so this
//                     defaults true; the field is here so a future
//                     non-pure fn marker can flip it without breaking
//                     downstream cache assumptions.
//   - `hasFieldAccess` Touches feature data (FieldAccess node). The
//                     CSE-safe-across-tile-but-not-across-feature
//                     boundary.
//   - `hasMatch`      Contains at least one MatchBlock anywhere.
//                     Branch-elimination passes skip Exprs lacking
//                     this flag.
//   - `hasFnCall`     Contains at least one FnCall. Used by purity
//                     proofs that can short-circuit when no calls
//                     exist (leaf-only Exprs are trivially pure).
//
// Why a SEPARATE pass from cse-annotate / annotate-deps:
//
//   - cse-annotate computes canonical-string IDs. Structural
//     metadata is independent of identity.
//   - annotate-deps computes the {ZOOM, FEATURE, TIME, NONE}
//     coarse-grained dependency bitset at PropertyShape granularity.
//     Per-Expr structural facts are finer-grained and apply at AST
//     node level, not paint surface level.
//   - Three separate WeakMap-keyed annotations let the PassManager
//     order them independently; future passes that need only one
//     of the three don't pay the walk cost of the others.
//
// Consumers (planned, not in this commit — iter-270+):
//
//   - `compiler/src/codegen/wgsl-expr.ts` MatchBlock case — switch
//     statement codegen when `matchArmCount <= 16 && allArmsConst`.
//     Replaces nested select() chain with O(1) jump table.
//   - `compiler/src/ir/passes/apply-cse.ts` — skip CSE deduping for
//     Exprs with `idempotent === false` (future non-pure fn).
//   - Profile-guided opt (long-term): runtime feedback ranks
//     hottest Exprs by cseId; the analysis surface gives
//     specialisation hints (which match arms dominate evaluation).
//
// What this module does NOT do:
//
//   - Mutate the Scene or IR. Pure data output (Scene with
//     `exprAnalysis?: ExprAnalysis` field set on the returned copy).
//   - Compute value ranges or monotonicity. Those need a separate
//     interval-domain pass on top of constfold and are out of scope.
//   - Detect side effects in builtin calls. The MVP assumes all
//     X-GIS builtins are pure.

import type { IRPass } from '../pass-manager'
import type { Scene, ColorValue, DataExpr, ConditionalBranch } from '../render-node'
import type { PropertyShape } from '../property-types'
import type { Expr } from '../../parser/ast'

/** Per-Expr metadata. Optional fields mean "not derivable from this
 *  Expr alone" — consumers fall back to safe-default behaviour. */
export interface ExprMeta {
  /** AST depth — leaves are 1, each level of nesting adds 1. */
  depth: number
  /** Number of arms iff this Expr is a MatchBlock or an FnCall
   *  hosting a MatchBlock; 0 for non-match Exprs. */
  matchArmCount: number
  /** True iff Expr is a MatchBlock whose every arm value is a
   *  literal (NumberLiteral / StringLiteral / ColorLiteral /
   *  BoolLiteral). Codegen uses this to emit a const lookup table. */
  allArmsConst: boolean
  /** Pure under repeat evaluation. All known builtins today are
   *  pure; this is reserved for future non-pure fn markers. */
  idempotent: boolean
  /** Touches feature data via FieldAccess anywhere in the subtree. */
  hasFieldAccess: boolean
  /** Contains at least one MatchBlock anywhere in the subtree. */
  hasMatch: boolean
  /** Contains at least one FnCall anywhere in the subtree. */
  hasFnCall: boolean
}

/** Side-table annotation built by `analyzeExprs`. WeakMap-keyed by
 *  Expr reference; nodes outside the paint / filter / geometry walk
 *  return undefined (treat as "no analysis info"). */
export interface ExprAnalysis {
  metaByExpr: WeakMap<Expr, ExprMeta>
  /** Total Expr visits — diagnostic. */
  totalNodes: number
}

/** Pure analysis walker. Recurses every Expr reachable from the
 *  Scene's paint / filter / geometry surfaces and accumulates per-
 *  node metadata. Input not mutated. */
export function analyzeExprs(scene: Scene): ExprAnalysis {
  const metaByExpr = new WeakMap<Expr, ExprMeta>()
  let totalNodes = 0

  function visit(e: Expr): ExprMeta {
    totalNodes++
    // Leaf metadata defaults. Each branch below mutates depth +
    // propagates aggregate flags up.
    let depth = 1
    let matchArmCount = 0
    let allArmsConst = false
    let hasFieldAccess = false
    let hasMatch = false
    let hasFnCall = false
    const childMetas: ExprMeta[] = []

    switch (e.kind) {
      case 'FieldAccess':
        hasFieldAccess = true
        if (e.object) childMetas.push(visit(e.object))
        break
      case 'FnCall':
        hasFnCall = true
        childMetas.push(visit(e.callee))
        for (const a of e.args) childMetas.push(visit(a))
        if (e.matchBlock) {
          hasMatch = true
          matchArmCount = e.matchBlock.arms.length
          // allArmsConst only meaningful when ALL arms are literals.
          allArmsConst = e.matchBlock.arms.every((arm) => isLiteral(arm.value))
          for (const arm of e.matchBlock.arms) {
            childMetas.push(visit(arm.value))
          }
        }
        break
      case 'BinaryExpr':
        childMetas.push(visit(e.left), visit(e.right))
        break
      case 'UnaryExpr':
        childMetas.push(visit(e.operand))
        break
      case 'ConditionalExpr':
        childMetas.push(visit(e.condition), visit(e.thenExpr), visit(e.elseExpr))
        break
      case 'ArrayLiteral':
        for (const el of e.elements) childMetas.push(visit(el))
        break
      case 'ArrayAccess':
        childMetas.push(visit(e.array), visit(e.index))
        break
      case 'MatchBlock':
        hasMatch = true
        matchArmCount = e.arms.length
        allArmsConst = e.arms.every((arm) => isLiteral(arm.value))
        for (const arm of e.arms) childMetas.push(visit(arm.value))
        break
      // Leaves — NumberLiteral, StringLiteral, ColorLiteral,
      // BoolLiteral, Identifier — no children, no flag changes.
      default:
        break
    }

    // Propagate up: depth = 1 + max(child depths); flag union.
    for (const cm of childMetas) {
      if (cm.depth + 1 > depth) depth = cm.depth + 1
      if (cm.hasFieldAccess) hasFieldAccess = true
      if (cm.hasMatch) hasMatch = true
      if (cm.hasFnCall) hasFnCall = true
    }

    const meta: ExprMeta = {
      depth,
      matchArmCount,
      allArmsConst,
      // All builtins pure today. Future non-pure fn registration will
      // override this from inside the FnCall branch.
      idempotent: true,
      hasFieldAccess,
      hasMatch,
      hasFnCall,
    }
    metaByExpr.set(e, meta)
    return meta
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
        visitDataExpr(v.expr)
        return
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

  return { metaByExpr, totalNodes }
}

/** True iff the Expr is a primitive literal (NumberLiteral /
 *  StringLiteral / ColorLiteral / BoolLiteral). Used by
 *  `allArmsConst` to detect const-LUT eligibility on MatchBlocks. */
function isLiteral(e: Expr): boolean {
  return (
    e.kind === 'NumberLiteral' ||
    e.kind === 'StringLiteral' ||
    e.kind === 'ColorLiteral' ||
    e.kind === 'BoolLiteral'
  )
}

/** PassManager-compatible IR pass. Reads `scene` (does not mutate),
 *  returns a new Scene with the `exprAnalysis` side-table attached.
 *  Runs AFTER `cse-annotate` so the analysis surface is the same
 *  set of Exprs that survived dead-elim and got CSE-annotated. */
export const exprAnalyzePass: IRPass = {
  name: 'expr-analyze',
  dependencies: ['cse-annotate'],
  run(scene: Scene): Scene {
    const exprAnalysis = analyzeExprs(scene)
    return { ...scene, exprAnalysis }
  },
}
