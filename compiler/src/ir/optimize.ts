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
import { mergeLayers } from './merge-layers'

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
  // Merge contiguous same-source-layer RenderNodes that differ only
  // in `filter:` + `fill:` + `stroke colour`. Reduces the per-tile
  // draw fanout from N (one per xgis layer) to 1 (one compound layer
  // with a `match()` dispatch on the shared filter field) for the
  // OSM-style six-`landuse_*` / five-`roads_*` pattern.
  return mergeLayers(optimized)

  // Note: foldTrivialStopsPass remains standalone-tested but
  // intentionally NOT integrated here. The pass's
  // .integration.test.ts pins runtime equivalence at the
  // resolveNumberShape / resolveColorShape level — every show
  // command's resolved scalars/RGBA match before vs after across
  // 11 sample zooms. Yet enabling the pass in this flow
  // CONSISTENTLY regresses Bright Tokyo parity by 1.5 pts
  // (8.79 % → 10.3-10.4 % across 3 back-to-back runs), so some
  // downstream consumer branches on `shape.kind` directly rather
  // than going through the resolver. Likely culprits to audit
  // before the next integration attempt:
  //   - The MVT worker's "bake into feature buffer" decision
  //     (compile time)
  //   - Shader-gen variant selection that emits different WGSL
  //     for `kind: 'zoom-interpolated'` vs `kind: 'constant'`
  //   - hasZoomOrTime checks in bucket-scheduler (Phase 4c
  //     removed most of them but trace recorder may still branch)
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
    if (folded !== null && typeof folded.value === 'number') {
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
    if (folded !== null && typeof folded.value === 'number') {
      return sizeConstant(folded.value)
    }
  }

  return { ...value, expr: { ...value.expr, classification } }
}
