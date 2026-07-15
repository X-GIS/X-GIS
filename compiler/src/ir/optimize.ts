// ═══ IR Optimization Pass ═══
// Classifies expressions and folds constants at compile time.
// Sits between lower() and emitCommands() in the pipeline.

import type { Scene, RenderNode, ColorValue, OpacityValue, SizeValue } from './render-node'
import { colorConstant, opacityConstant, sizeConstant, hexToRgba } from './render-node'
import { classifyExpr } from './classify'
import { constFold } from './const-fold'
import { PassManager } from './pass-manager'
import { mergeLayersPass } from './passes/merge-layers'
import { foldTrivialStopsPass } from './passes/fold-trivial-stops'
import { foldTrivialCasePass } from './passes/fold-trivial-case'
import { deadLayerElimPass } from './passes/dead-layer-elim'
import { deadSourceElimPass } from './passes/dead-source-elim'
import { cseAnnotatePass } from './passes/cse-annotate'
import { exprAnalyzePass } from './passes/expr-analyze'

/**
 * Optimize a Scene by classifying expressions and folding constants.
 * @param scene The IR scene from lower()
 */
export function optimize(scene: Scene): Scene {
  const optimized: Scene = {
    sources: scene.sources,
    renderNodes: scene.renderNodes.map((node) => optimizeNode(node)),
    symbols: scene.symbols,
  }

  // Scene-level IR transforms now flow through PassManager. The
  // manager topologically sorts by `dependencies`, producing the
  // execution order:
  //
  //   1. merge-layers       — collapse same-source-layer groups
  //                           into compound RenderNodes (~OSM six
  //                           landuse_* / five roads_* pattern).
  //   2. fold-trivial-stops — zoom-interpolated paint values whose
  //                           every stop carries the same payload
  //                           collapse to constant.
  //   3. fold-trivial-case  — match() expressions whose every arm
  //                           produces the same literal collapse
  //                           to that literal.
  //   4. dead-layer-elim    — drop RenderNodes that can never
  //                           produce a visible pixel (visible:
  //                           false, empty zoom range, no paint
  //                           surface).
  //   5. dead-source-elim   — drop SourceDefs that no surviving
  //                           RenderNode references (sources orphaned
  //                           by step 4 or by the iter-198 unused-
  //                           source convert-layer drop's IR sibling).
  //
  // Each pass has its own stats / unit / integration tests
  // (passes/*.test.ts) and is byte-stable against MapLibre parity
  // baselines.
  return runScenePipeline(optimized)
}

const PIPELINE = buildPipeline()
function buildPipeline(): PassManager {
  const pm = new PassManager()
  pm.register(mergeLayersPass)
  pm.register(foldTrivialStopsPass)
  pm.register(foldTrivialCasePass)
  // Phase B (iter 200) — LLVM-style fixpoint DCE. The two dead-elim
  // passes form a group that iterates until the Scene reference is
  // identity-stable. Today (with the existing fold-trivial-* passes)
  // one iteration is sufficient; the fixpoint loop costs ~one extra
  // identity check per pass per build. Future passes that can produce
  // newly-dead surface (Phase D transparent-fill drop, CSE rewrites
  // that prove a paint expression constant-transparent, …) will
  // automatically benefit — the loop catches them with zero extra
  // wiring beyond inclusion in the group's `passes[]` array. Cap = 4
  // (LLVM convention); a throw fires if a future pass oscillates.
  pm.registerGroup({
    name: 'dce-fixpoint',
    dependencies: ['fold-trivial-case'],
    passes: [deadLayerElimPass, deadSourceElimPass],
    maxIterations: 4,
  })
  // Phase C.1 (iter 201) — CSE annotation side-table. Attaches
  // `scene.cseAnnotation` for downstream consumers (compute-plan
  // kernel dedup is the first consumer, Phase C.2). Runs AFTER
  // dce-fixpoint so dead expressions aren't walked.
  pm.register(cseAnnotatePass)
  // iter-269 — per-Expr structural + purity metadata side-table.
  // Foundation for Tier 1 compiler advancement: WGSL match-arm
  // switch codegen, CSE purity gate, branch elimination. Runs after
  // cse-annotate so it walks the same post-dce Expr surface. Pure
  // analysis — Scene unchanged except for the optional side-table.
  pm.register(exprAnalyzePass)
  return pm
}

function runScenePipeline(scene: Scene): Scene {
  return PIPELINE.run(scene).scene
}

function optimizeNode(node: RenderNode): RenderNode {
  return {
    ...node,
    fill: optimizeColor(node.fill),
    // Preserve all stroke fields — only the color needs optimization.
    // (Historically this was `{ color, width }` which silently dropped
    // linecap/linejoin/miterlimit/dashArray/dashOffset/patterns added later.)
    stroke: {
      ...node.stroke,
      color: optimizeColor(node.stroke.color),
    },
    opacity: optimizeOpacity(node.opacity),
    size: optimizeSize(node.size),
  }
}

function optimizeColor(value: ColorValue): ColorValue {
  if (value.kind !== 'data-driven') return value

  const classification = classifyExpr(value.expr.ast)
  if (classification === 'constant') {
    const folded = constFold(value.expr.ast)
    if (folded !== null) {
      // Folded value could be a hex color string or a number
      if (typeof folded.value === 'string' && folded.value.startsWith('#')) {
        return colorConstant(...hexToRgba(folded.value))
      }
    }
  }

  // Attach classification for downstream use (shader codegen)
  return { ...value, expr: { ...value.expr, classification } }
}

function optimizeOpacity(value: OpacityValue): OpacityValue {
  if (value.kind !== 'data-driven') return value

  const classification = classifyExpr(value.expr.ast)
  if (classification === 'constant') {
    const folded = constFold(value.expr.ast)
    // Number.isFinite rejects NaN/Infinity that slip past typeof.
    // Pre-fix a constant-folded NaN opacity bound itself into the IR
    // as opacityConstant(NaN/100) = NaN; the downstream renderer
    // multiplied every fragment by NaN and the layer disappeared.
    if (folded !== null && typeof folded.value === 'number' && Number.isFinite(folded.value)) {
      return opacityConstant(folded.value <= 1 ? folded.value : folded.value / 100)
    }
  }

  return { ...value, expr: { ...value.expr, classification } }
}

function optimizeSize(value: SizeValue): SizeValue {
  if (value.kind !== 'data-driven') return value

  const classification = classifyExpr(value.expr.ast)
  if (classification === 'constant') {
    const folded = constFold(value.expr.ast)
    // Mirror of the opacity NaN guard above — sizeConstant(NaN)
    // bound itself into the IR as a NaN size and the vertex shader
    // expanded to a NaN-sized point (typically degenerate / off-
    // screen rather than visible).
    if (folded !== null && typeof folded.value === 'number' && Number.isFinite(folded.value)) {
      return sizeConstant(folded.value)
    }
  }

  return { ...value, expr: { ...value.expr, classification } }
}
