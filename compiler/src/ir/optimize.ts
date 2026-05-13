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

  // foldTrivialStopsPass intentionally NOT integrated here. It's
  // standalone-tested in passes/ and registered for future use, but
  // even the .integration.test.ts proving resolver-level equivalence
  // wasn't enough — wiring the pass into this flow yields an
  // INTERMITTENT spike on Bright Tokyo (4/5 runs land at 8.6 % as
  // expected, 5th spikes to 10.3 % past the 9.67 % gate). The fold
  // itself fires ZERO times on the OFM fixtures (per
  // fold-stats.test.ts), so the divergence must be tile-load timing
  // or Vite HMR rather than the fold's output. Need a more
  // deterministic parity harness before re-attempting integration —
  // until then a flaky gate is worse than a missing optimisation
  // that already does nothing for production.
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
