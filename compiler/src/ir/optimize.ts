// ═══ IR Optimization Pass ═══
// Classifies expressions and folds constants at compile time.
// Sits between lower() and emitCommands() in the pipeline.

import type * as AST from '../parser/ast'
import type {
  Scene, RenderNode, ColorValue, OpacityValue, SizeValue,
} from './render-node'
import { colorConstant, opacityConstant, sizeConstant, hexToRgba } from './render-node'
import { classifyExpr, type FnEnv } from './classify'
import { constFold } from './const-fold'
import { PassManager } from './pass-manager'
import { mergeLayersPass } from './passes/merge-layers'
import { foldTrivialStopsPass } from './passes/fold-trivial-stops'
import { foldTrivialCasePass } from './passes/fold-trivial-case'
import { deadLayerElimPass } from './passes/dead-layer-elim'

/**
 * Optimize a Scene by classifying expressions and folding constants.
 * @param scene The IR scene from lower()
 * @param program The original AST program (needed to collect fn definitions)
 */
export function optimize(scene: Scene, program?: AST.Program): Scene {
  // Collect user-defined functions
  const fnEnv: FnEnv = new Map()
  if (program) {
    for (const stmt of program.body) {
      if (stmt.kind === 'FnStatement') {
        fnEnv.set(stmt.name, stmt)
      }
    }
  }

  const optimized: Scene = {
    sources: scene.sources,
    renderNodes: scene.renderNodes.map(node => optimizeNode(node, fnEnv)),
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
  pm.register(deadLayerElimPass)
  return pm
}

function runScenePipeline(scene: Scene): Scene {
  return PIPELINE.run(scene).scene
}

function optimizeNode(node: RenderNode, fnEnv: FnEnv): RenderNode {
  return {
    ...node,
    fill: optimizeColor(node.fill, fnEnv),
    // Preserve all stroke fields — only the color needs optimization.
    // (Historically this was `{ color, width }` which silently dropped
    // linecap/linejoin/miterlimit/dashArray/dashOffset/patterns added later.)
    stroke: {
      ...node.stroke,
      color: optimizeColor(node.stroke.color, fnEnv),
    },
    opacity: optimizeOpacity(node.opacity, fnEnv),
    size: optimizeSize(node.size, fnEnv),
  }
}

function optimizeColor(value: ColorValue, fnEnv: FnEnv): ColorValue {
  if (value.kind !== 'data-driven') return value

  const classification = classifyExpr(value.expr.ast, fnEnv)
  if (classification === 'constant') {
    const folded = constFold(value.expr.ast, fnEnv)
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

function optimizeOpacity(value: OpacityValue, fnEnv: FnEnv): OpacityValue {
  if (value.kind !== 'data-driven') return value

  const classification = classifyExpr(value.expr.ast, fnEnv)
  if (classification === 'constant') {
    const folded = constFold(value.expr.ast, fnEnv)
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

function optimizeSize(value: SizeValue, fnEnv: FnEnv): SizeValue {
  if (value.kind !== 'data-driven') return value

  const classification = classifyExpr(value.expr.ast, fnEnv)
  if (classification === 'constant') {
    const folded = constFold(value.expr.ast, fnEnv)
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
