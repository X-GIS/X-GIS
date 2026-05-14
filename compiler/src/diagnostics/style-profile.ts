// ═══════════════════════════════════════════════════════════════════
// Scene compile-time optimisation profile
// ═══════════════════════════════════════════════════════════════════
//
// Diagnostic that composes the analysis modules shipped across plan
// phases 0, 3, 4 into a single report users (and tooling) can read:
//
//   - PaintShape kind histogram + DepBits histogram (P0 deps)
//   - CSE redundancy (P0 step 3, analyzeCSE)
//   - Compute plan size + post-dedup kernel count (P4-6 dedup)
//   - Palette pool sizes (P3 storage textures)
//   - Match() arm-count distribution (P5 LUT eligibility)
//
// The profile is pure data, no GPU. Useful for:
//
//   - Style authors: "is my style hitting the GPU fast paths?"
//   - Regression: snapshot the profile in tests; a change that
//     unexpectedly inflates compute kernel count or shrinks palette
//     coverage flags itself.
//   - Documentation: ship as part of /diagnostic Playground panel
//     so users see how the optimiser is treating their input.
//
// What this module does NOT do:
//
//   - Allocate any GPU resources. The runtime side reads the same
//     report via the compiler index export.
//   - Mutate the scene. Pure read.

import type { Scene } from '../ir/render-node'
import type { Expr } from '../parser/ast'
import { analyzeCSE } from '../ir/passes/cse'
import { annotateDeps } from '../ir/passes/annotate-deps'
import { Dep, formatDeps, type DepBits } from '../ir/deps'
import { collectPalette } from '../codegen/palette'
import { planComputeKernels } from '../codegen/compute-plan'

/** Match-arm-count histogram bucket. Bands chosen to highlight the
 *  P5 LUT threshold (typically ≥16 arms). */
export interface MatchArmBand {
  /** Inclusive lower bound. */
  min: number
  /** Inclusive upper bound, or null for "and up". */
  max: number | null
  /** Number of match() expressions in this band. */
  count: number
}

export interface DepHistogramRow {
  bits: DepBits
  label: string
  count: number
}

export interface ComputePlanSummary {
  /** Total ComputePlanEntry count (per paint axis). */
  entries: number
  /** Unique ComputeKernel objects after WGSL fingerprint dedup
   *  (P4-6 compiler half). `entries - uniqueKernels` is the dedup
   *  win at runtime. */
  uniqueKernels: number
}

export interface CSESummary {
  totalNodes: number
  unique: number
  duplicates: number
  /** `(totalNodes - unique) / totalNodes` as a percentage in [0,100].
   *  Effectively the share of subtree visits that hit a duplicate. */
  redundancyPercent: number
  /** Top dedup candidates (canonical AST string + occurrence count),
   *  sorted by count descending. Capped at 8 for compactness. */
  topDuplicates: { key: string; count: number }[]
}

export interface PaletteSummary {
  colors: number
  scalars: number
  colorGradients: number
  scalarGradients: number
}

export interface StyleProfile {
  /** Number of RenderNodes in the Scene. */
  renderNodes: number
  /** DepBits → count across every annotated paint axis. */
  depHistogram: DepHistogramRow[]
  cse: CSESummary
  computePlan: ComputePlanSummary
  palette: PaletteSummary
  matchArmBands: MatchArmBand[]
}

const DEP_LABELS: Array<[DepBits, string]> = [
  [Dep.NONE, 'none'],
  [Dep.ZOOM, 'zoom'],
  [Dep.TIME, 'time'],
  [Dep.FEATURE, 'feature'],
  [Dep.ZOOM | Dep.TIME, 'zoom+time'],
  [Dep.ZOOM | Dep.FEATURE, 'zoom+feature'],
  [Dep.TIME | Dep.FEATURE, 'time+feature'],
  [Dep.ZOOM | Dep.TIME | Dep.FEATURE, 'zoom+time+feature'],
]

const MATCH_BANDS_DEF: Array<[number, number | null]> = [
  [1, 3],
  [4, 7],
  [8, 15],
  [16, 31],
  [32, null],
]

/** Build the profile from a Scene. Pure; runs the constituent analyses
 *  internally. Safe to call multiple times; each call rebuilds. */
export function getStyleProfile(scene: Scene): StyleProfile {
  const depsAnn = annotateDeps(scene)
  const cseReport = analyzeCSE(scene)
  const palette = collectPalette(scene)
  const plan = planComputeKernels(scene)

  // Dep histogram in stable bit-value order.
  const depHistogram: DepHistogramRow[] = DEP_LABELS.map(([bits, label]) => ({
    bits, label,
    count: depsAnn.histogram[String(bits)] ?? 0,
  })).filter(row => row.count > 0 || row.bits === Dep.NONE)

  // CSE summary.
  const uniqueCSE = cseReport.entries.length
  const totalCSE = cseReport.totalNodes
  const redundancy = totalCSE > 0
    ? Math.round(((totalCSE - uniqueCSE) / totalCSE) * 1000) / 10
    : 0
  const topDuplicates = cseReport.duplicates
    .slice(0, 8)
    .map(d => ({ key: d.key.length > 60 ? d.key.slice(0, 57) + '...' : d.key, count: d.count }))

  // Compute plan dedup count = unique kernel references.
  const uniqueKernels = new Set(plan.map(e => e.kernel)).size

  // Match() arm bands — walk every paint expression AST collecting
  // match.matchBlock.arms.length. We use the CSE walker's visited
  // ASTs implicitly via deps annotation, but here we want a raw
  // count not weighted by CSE — so re-walk dedicated for arm counts.
  const armCounts: number[] = []
  function walkAst(e: Expr): void {
    if (e.kind === 'FnCall'
      && e.callee.kind === 'Identifier'
      && e.callee.name === 'match'
      && e.matchBlock) {
      armCounts.push(e.matchBlock.arms.length)
    }
    if (e.kind === 'FnCall') {
      walkAst(e.callee)
      for (const a of e.args) walkAst(a)
      if (e.matchBlock) for (const arm of e.matchBlock.arms) walkAst(arm.value)
    } else if (e.kind === 'BinaryExpr') {
      walkAst(e.left); walkAst(e.right)
    } else if (e.kind === 'UnaryExpr') {
      walkAst(e.operand)
    } else if (e.kind === 'ConditionalExpr') {
      walkAst(e.condition); walkAst(e.thenExpr); walkAst(e.elseExpr)
    } else if (e.kind === 'PipeExpr') {
      walkAst(e.input)
      for (const t of e.transforms) walkAst(t)
    } else if (e.kind === 'ArrayLiteral') {
      for (const el of e.elements) walkAst(el)
    } else if (e.kind === 'ArrayAccess') {
      walkAst(e.array); walkAst(e.index)
    } else if (e.kind === 'FieldAccess') {
      if (e.object) walkAst(e.object)
    } else if (e.kind === 'MatchBlock') {
      for (const arm of e.arms) walkAst(arm.value)
    }
    // Leaf kinds (NumberLiteral, StringLiteral, ColorLiteral, BoolLiteral,
    // Identifier) have no children.
  }
  for (const node of scene.renderNodes) {
    if (node.fill.kind === 'data-driven') walkAst(node.fill.expr.ast as Expr)
    if (node.stroke.color.kind === 'data-driven') walkAst(node.stroke.color.expr.ast as Expr)
    if (node.opacity.kind === 'data-driven') walkAst(node.opacity.expr.ast as Expr)
    if (node.stroke.width.kind === 'data-driven') walkAst(node.stroke.width.expr.ast as Expr)
  }
  const matchArmBands: MatchArmBand[] = MATCH_BANDS_DEF.map(([min, max]) => ({
    min, max,
    count: armCounts.filter(c => c >= min && (max === null || c <= max)).length,
  }))

  return {
    renderNodes: scene.renderNodes.length,
    depHistogram,
    cse: {
      totalNodes: totalCSE,
      unique: uniqueCSE,
      duplicates: cseReport.duplicates.length,
      redundancyPercent: redundancy,
      topDuplicates,
    },
    computePlan: {
      entries: plan.length,
      uniqueKernels,
    },
    palette: {
      colors: palette.colors.length,
      scalars: palette.scalars.length,
      colorGradients: palette.colorGradients.length,
      scalarGradients: palette.scalarGradients.length,
    },
    matchArmBands,
  }
}

/** Pretty-print the profile as a single multi-line string. Useful
 *  for console.log / diagnostic panels / test snapshots. */
export function formatStyleProfile(p: StyleProfile): string {
  const lines: string[] = []
  lines.push(`Style profile — ${p.renderNodes} render node${p.renderNodes === 1 ? '' : 's'}`)
  lines.push('')
  lines.push(`Dep histogram (${p.depHistogram.reduce((s, r) => s + r.count, 0)} total entries):`)
  for (const row of p.depHistogram) {
    lines.push(`  ${row.label.padEnd(20)} ${row.count}`)
  }
  lines.push('')
  lines.push(`CSE: ${p.cse.unique}/${p.cse.totalNodes} unique nodes `
    + `(${p.cse.redundancyPercent}% redundancy, ${p.cse.duplicates} dup groups)`)
  if (p.cse.topDuplicates.length > 0) {
    lines.push(`  Top duplicates:`)
    for (const d of p.cse.topDuplicates) {
      lines.push(`    ${String(d.count).padStart(4)}× ${d.key}`)
    }
  }
  lines.push('')
  lines.push(`Compute plan: ${p.computePlan.entries} entries, `
    + `${p.computePlan.uniqueKernels} unique kernels `
    + `(${p.computePlan.entries - p.computePlan.uniqueKernels} dedup wins)`)
  lines.push('')
  lines.push(`Palette: ${p.palette.colors} colors, `
    + `${p.palette.scalars} scalars, ${p.palette.colorGradients} gradients, `
    + `${p.palette.scalarGradients} scalar-gradients`)
  lines.push('')
  lines.push(`Match arm bands:`)
  for (const b of p.matchArmBands) {
    const range = b.max === null ? `${b.min}+` : `${b.min}..${b.max}`
    lines.push(`  ${range.padEnd(8)} ${b.count}`)
  }
  return lines.join('\n')
}

// Re-export Dep label helper so callers building custom views can
// label DepBits without re-importing from `../ir/deps`.
export { formatDeps }
