// ═══ fold-trivial-case ═══
//
// IR optimisation pass: a `match()` expression where every arm
// produces the SAME literal value is functionally constant — the
// per-feature dispatch returns the same answer regardless of input.
// Fold it.
//
// Scope: only the top-level AST of paint-property `data-driven`
// values, and only when:
//
//   - the AST is a `FnCall` with a non-empty `matchBlock`, AND
//   - every arm's `value` AST is the SAME literal (deeply-equal
//     `ColorLiteral`, `NumberLiteral`, or `BoolLiteral`).
//
// Why "top-level AST only": the existing `constFold` already
// handles arithmetic / function-call constant folding. A match
// nested inside arithmetic (e.g. `match(.x, ...) * 2`) would land
// in BinaryExpr territory — out of scope until measured. The plan
// allowed for "fold-trivial-case" as a defensive completion of
// fold-trivial-stops, and case-stats.test.ts shows zero trivial
// cases in OFM Bright / Liberty / Positron after the
// expand-color-match preprocessor pre-splits them, so the pass
// here is documentation as much as code.
//
// What it does NOT touch:
//
//   - `ConditionalExpr` / ternary `a ? b : c` — `classifyExpr`
//     already folds when condition is constant via constFold's
//     handling. Ternary with all-equal branches is the same fold
//     in theory but observed zero times.
//   - Match expressions inside arithmetic / pipes / nested calls.
//   - Match arms where the value AST is structurally equal but not
//     a primitive literal (e.g. `interpolate(zoom, ...)`) — the
//     fold would need to construct a `zoom-interpolated`
//     PropertyShape, which is more machinery than current need.

import type { IRPass } from '../pass-manager'
import type {
  Scene, RenderNode,
  ColorValue, OpacityValue, SizeValue, StrokeValue, StrokeWidthValue,
} from '../render-node'
import { colorConstant, opacityConstant, sizeConstant, hexToRgba } from '../render-node'
import type * as AST from '../../parser/ast'

/** True when both arms produce the same literal AST. We compare on
 *  literal nodes only — anything else returns false (conservative). */
function literalArmsEqual(a: AST.Expr, b: AST.Expr): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'ColorLiteral' && b.kind === 'ColorLiteral') {
    return a.value === b.value
  }
  if (a.kind === 'NumberLiteral' && b.kind === 'NumberLiteral') {
    // unit must also match — `12px` and `12em` are different values.
    return a.value === b.value && (a.unit ?? null) === (b.unit ?? null)
  }
  if (a.kind === 'BoolLiteral' && b.kind === 'BoolLiteral') {
    return a.value === b.value
  }
  // StringLiteral added so a match() whose arms all return the same
  // hex via JSON.stringify'd path (e.g. user-authored `"#abc"`) folds
  // to a constant the same way ColorLiteral does. Mirror of the
  // lower.ts StringLiteral-hex acceptance in extractInterpolate
  // ZoomColorStops (3d91486).
  if (a.kind === 'StringLiteral' && b.kind === 'StringLiteral') {
    return a.value === b.value
  }
  return false
}

/** Return the FnCall's matchBlock when every arm has the SAME
 *  literal value, else null. */
function commonLiteralArm(ast: AST.Expr): AST.Expr | null {
  if (ast.kind !== 'FnCall' || !ast.matchBlock) return null
  const arms = ast.matchBlock.arms
  if (arms.length === 0) return null
  const first = arms[0]!.value
  for (let i = 1; i < arms.length; i++) {
    if (!literalArmsEqual(first, arms[i]!.value)) return null
  }
  return first
}

function foldColor(value: ColorValue): ColorValue {
  if (value.kind !== 'data-driven') return value
  const lit = commonLiteralArm(value.expr.ast)
  if (lit === null) return value
  if (lit.kind === 'ColorLiteral') return colorConstant(...hexToRgba(lit.value))
  // StringLiteral hex (`"#abc"`) folds the same way — match arms
  // built via the JSON.stringify'd converter path can carry hex
  // strings as StringLiterals rather than the bare-hex ColorLiteral.
  if (lit.kind === 'StringLiteral' && /^#[0-9a-fA-F]{3,8}$/.test(lit.value)) {
    return colorConstant(...hexToRgba(lit.value))
  }
  return value
}

function foldOpacity(value: OpacityValue): OpacityValue {
  if (value.kind !== 'data-driven') return value
  const lit = commonLiteralArm(value.expr.ast)
  if (lit === null || lit.kind !== 'NumberLiteral') return value
  // Mapbox-style 0-100 percentage normalisation matches optimize.ts.
  return opacityConstant(lit.value <= 1 ? lit.value : lit.value / 100)
}

function foldSize(value: SizeValue): SizeValue {
  if (value.kind !== 'data-driven') return value
  const lit = commonLiteralArm(value.expr.ast)
  if (lit === null || lit.kind !== 'NumberLiteral') return value
  return sizeConstant(lit.value, lit.unit ?? null)
}

function foldStrokeWidth(value: StrokeWidthValue): StrokeWidthValue {
  if (value.kind !== 'data-driven') return value
  const lit = commonLiteralArm(value.expr.ast)
  if (lit === null || lit.kind !== 'NumberLiteral') return value
  return { kind: 'constant', value: lit.value }
}

function foldStroke(stroke: StrokeValue): StrokeValue {
  const color = foldColor(stroke.color)
  const width = foldStrokeWidth(stroke.width)
  if (color === stroke.color && width === stroke.width) return stroke
  return { ...stroke, color, width }
}

function foldRenderNode(node: RenderNode): RenderNode {
  const fill = foldColor(node.fill)
  const stroke = foldStroke(node.stroke)
  const opacity = foldOpacity(node.opacity)
  const size = foldSize(node.size)
  if (
    fill === node.fill && stroke === node.stroke
    && opacity === node.opacity && size === node.size
  ) return node
  return { ...node, fill, stroke, opacity, size }
}

export const foldTrivialCasePass: IRPass = {
  name: 'fold-trivial-case',
  // After merge-layers because merge may introduce synthesised
  // match() expressions on stroke colour for compound layers — we
  // want a chance to fold those when all variants agree. After
  // fold-trivial-stops only so the PassManager has a deterministic
  // execution order (no semantic dependency between the two folds).
  dependencies: ['merge-layers', 'fold-trivial-stops'],
  run(scene: Scene): Scene {
    const folded = scene.renderNodes.map(foldRenderNode)
    const changed = folded.some((n, i) => n !== scene.renderNodes[i])
    return changed ? { ...scene, renderNodes: folded } : scene
  },
}
