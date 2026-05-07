// ═══ IR Layer Merge Pass ═══
//
// Detects and merges contiguous RenderNodes that share a source layer
// and differ only in `filter:` + `fill:` + `stroke color:`. The OSM-
// style demo's six `landuse_*` and five `roads_*` blocks are the
// canonical case — each layer produces its own draw per tile, so a
// 13-layer style turns into 13× the draw count for the same 4 unique
// tile-source-layer pairs. Mapbox / MapLibre stylesheets use the same
// authoring pattern; without auto-merge every style author hits a 4-
// 13× draw-call inflation that scales nowhere.
//
// What this pass produces: ONE compound RenderNode per detected
// group, with the fill / stroke colour replaced by a synthesized
// `match(.field) { value -> colour … }` AST. The compound's filter
// is the OR of every member's filter, so the worker's pre-bucket
// (filter-eval.ts) still sees ONE slice for the whole group with
// only matching features. The match expression then dispatches the
// per-feature colour at fragment time via the existing categorical
// / match infrastructure (shader-gen.ts already compiles
// `match(.field)` into a WGSL switch chain).
//
// Mergeability rules (intersection of every member):
//   * same `sourceRef`
//   * same `sourceLayer`
//   * `extrude.kind === 'none'` everywhere
//   * `fill.kind === 'constant'` everywhere
//   * `stroke.color.kind === 'constant'` everywhere AND same width
//   * `opacity` constant 1 everywhere (else blend semantics differ)
//   * `filter` is a chain of `.field == "literal"` clauses joined by
//     `||`, AND every member uses the SAME field name. The literal
//     can be a string or number — both pattern-match against `match`
//     arms. A member with `filter: null` cannot merge (would need a
//     `_` arm and we'd lose the discard).
//
// Anything outside these rules: pass-through. The merge never
// converts a faithful render into a different visual; if any
// constraint fails, the original list is preserved verbatim.

import type * as AST from '../parser/ast'
import type { Scene, RenderNode, ColorValue, DataExpr } from './render-node'

interface FilterAnalysis {
  field: string
  values: string[]
}

/** Returns null when the filter doesn't match the merge contract.
 *  Otherwise the field name and the list of equality-tested literal
 *  values whose ANY-of would re-create the original boolean. */
function analyzeFilter(filter: DataExpr | null): FilterAnalysis | null {
  if (!filter) return null
  const ast = filter.ast as AST.Expr
  const values: string[] = []
  let field: string | null = null

  // Recursive walk over `||`-joined `.field == LITERAL` comparisons.
  const visit = (node: AST.Expr): boolean => {
    if (node.kind === 'BinaryExpr' && node.op === '||') {
      return visit(node.left) && visit(node.right)
    }
    if (node.kind === 'BinaryExpr' && node.op === '==') {
      const f = extractField(node.left) ?? extractField(node.right)
      const v = extractLiteral(node.right) ?? extractLiteral(node.left)
      if (f === null || v === null) return false
      if (field === null) field = f
      else if (field !== f) return false
      values.push(v)
      return true
    }
    return false
  }

  if (!visit(ast)) return null
  if (field === null || values.length === 0) return null
  return { field, values }
}

function extractField(expr: AST.Expr): string | null {
  if (expr.kind === 'FieldAccess') return expr.field
  return null
}

function extractLiteral(expr: AST.Expr): string | null {
  if (expr.kind === 'StringLiteral') return expr.value
  if (expr.kind === 'NumberLiteral') return String(expr.value)
  return null
}

/** True when the two stroke definitions are byte-for-byte equivalent
 *  in everything we care about for merging — width, linecap/linejoin,
 *  miterlimit, dash array, offsets, patterns. Stroke COLOUR can
 *  differ; that's what the synthesized match handles. */
function strokesShapeEqual(a: RenderNode['stroke'], b: RenderNode['stroke']): boolean {
  if (a.width !== b.width) return false
  if (a.linecap !== b.linecap) return false
  if (a.linejoin !== b.linejoin) return false
  if (a.miterlimit !== b.miterlimit) return false
  if (a.dashOffset !== b.dashOffset) return false
  if (a.offset !== b.offset) return false
  if (a.align !== b.align) return false
  if ((a.dashArray?.length ?? 0) !== (b.dashArray?.length ?? 0)) return false
  if (a.dashArray && b.dashArray) {
    for (let i = 0; i < a.dashArray.length; i++) {
      if (a.dashArray[i] !== b.dashArray[i]) return false
    }
  }
  if ((a.patterns?.length ?? 0) !== (b.patterns?.length ?? 0)) return false
  if (a.patterns && b.patterns) {
    for (let i = 0; i < a.patterns.length; i++) {
      const p = a.patterns[i]; const q = b.patterns[i]
      if (p.shape !== q.shape || p.spacing !== q.spacing || p.size !== q.size) return false
    }
  }
  return true
}

function isMergeableNode(n: RenderNode): boolean {
  if (n.extrude.kind !== 'none') return false
  if (n.fill.kind !== 'constant' && n.fill.kind !== 'none') return false
  if (n.stroke.color.kind !== 'constant' && n.stroke.color.kind !== 'none') return false
  if (n.opacity.kind !== 'constant') return false
  if (n.opacity.value < 0.999) return false
  if (n.geometry !== null) return false
  if (n.animationMeta !== undefined) return false
  if (n.shape.kind !== 'none') return false  // points handled separately
  return true
}

function canExtendGroup(first: RenderNode, candidate: RenderNode): boolean {
  if (first.sourceRef !== candidate.sourceRef) return false
  if (first.sourceLayer !== candidate.sourceLayer) return false
  if (first.projection !== candidate.projection) return false
  if (first.visible !== candidate.visible) return false
  if (first.pointerEvents !== candidate.pointerEvents) return false
  if (!strokesShapeEqual(first.stroke, candidate.stroke)) return false
  if (first.opacity.kind === 'constant'
      && candidate.opacity.kind === 'constant'
      && first.opacity.value !== candidate.opacity.value) return false
  return true
}

/** Build a synthesized `match(.field) { value -> colour, ... , _ ->
 *  none-color }` expression for the merged group. */
function buildMatchAst(
  field: string,
  arms: Array<{ pattern: string; rgba: [number, number, number, number] }>,
): AST.Expr {
  // Default arm — colour none. Won't be reached for non-matching
  // features because the compound `filter` excludes them at the
  // worker pre-bucket stage; but match() requires a default.
  const defaultArm: AST.MatchArm = {
    pattern: '_',
    value: { kind: 'ColorLiteral', value: '#00000000' } as AST.Expr,
  }
  const matchArms: AST.MatchArm[] = arms.map(a => ({
    pattern: a.pattern,
    value: {
      kind: 'ColorLiteral',
      value: rgbaToHex(a.rgba),
    } as AST.Expr,
  }))
  matchArms.push(defaultArm)

  const matchBlock: AST.MatchBlock = {
    kind: 'MatchBlock',
    arms: matchArms,
  }

  const fieldAccess: AST.Expr = {
    kind: 'FieldAccess',
    object: { kind: 'Identifier', name: '' } as AST.Expr,
    field,
  } as unknown as AST.Expr

  const fnCall: AST.Expr = {
    kind: 'FnCall',
    callee: { kind: 'Identifier', name: 'match' } as AST.Expr,
    args: [fieldAccess],
    matchBlock,
  } as unknown as AST.Expr

  return fnCall
}

function rgbaToHex(rgba: [number, number, number, number]): string {
  const r = Math.round(rgba[0] * 255).toString(16).padStart(2, '0')
  const g = Math.round(rgba[1] * 255).toString(16).padStart(2, '0')
  const b = Math.round(rgba[2] * 255).toString(16).padStart(2, '0')
  const a = Math.round(rgba[3] * 255).toString(16).padStart(2, '0')
  return `#${r}${g}${b}${a}`
}

/** Build the OR-chain filter that re-creates the union of the group's
 *  members. Pre-bucket evaluates this on CPU at decode time so the
 *  worker's slice contains only features matching at least one
 *  member's filter. */
function buildOrFilter(field: string, allValues: string[]): AST.Expr {
  // Build .field == v0 || .field == v1 || ...
  const fieldAccess = (): AST.Expr => ({
    kind: 'FieldAccess',
    object: { kind: 'Identifier', name: '' } as AST.Expr,
    field,
  } as unknown as AST.Expr)
  const literalOf = (v: string): AST.Expr => {
    // Numeric values in the filter were stringified at extraction
    // time; if it round-trips through Number cleanly, emit a
    // NumberLiteral so == compares numerics correctly.
    const n = Number(v)
    if (Number.isFinite(n) && String(n) === v) {
      return { kind: 'NumberLiteral', value: n } as AST.Expr
    }
    return { kind: 'StringLiteral', value: v } as AST.Expr
  }
  let acc: AST.Expr = {
    kind: 'BinaryExpr',
    op: '==',
    left: fieldAccess(),
    right: literalOf(allValues[0]),
  } as unknown as AST.Expr
  for (let i = 1; i < allValues.length; i++) {
    acc = {
      kind: 'BinaryExpr',
      op: '||',
      left: acc,
      right: {
        kind: 'BinaryExpr',
        op: '==',
        left: fieldAccess(),
        right: literalOf(allValues[i]),
      } as unknown as AST.Expr,
    } as unknown as AST.Expr
  }
  return acc
}

/** The pass entry point. Walks `scene.renderNodes` once, accumulating
 *  contiguous mergeable groups; emits a single compound node for any
 *  group of size ≥ 2 and passes everything else through verbatim. */
export function mergeLayers(scene: Scene): Scene {
  const nodes = scene.renderNodes
  const out: RenderNode[] = []

  let i = 0
  while (i < nodes.length) {
    const first = nodes[i]
    if (!isMergeableNode(first)) {
      out.push(first)
      i++
      continue
    }
    const firstFilter = analyzeFilter(first.filter)
    if (!firstFilter) {
      out.push(first)
      i++
      continue
    }

    // Greedy contiguous extension.
    const group: { node: RenderNode; filter: FilterAnalysis }[] = [
      { node: first, filter: firstFilter },
    ]
    let j = i + 1
    while (j < nodes.length) {
      const c = nodes[j]
      if (!isMergeableNode(c)) break
      if (!canExtendGroup(first, c)) break
      const cf = analyzeFilter(c.filter)
      if (!cf) break
      if (cf.field !== firstFilter.field) break
      group.push({ node: c, filter: cf })
      j++
    }

    if (group.length < 2) {
      out.push(first)
      i++
      continue
    }

    // Synthesize the compound. Build per-(value → colour) arms from
    // every group member so a feature gets the colour of the FIRST
    // member whose filter matched it (declaration order preserved
    // by the arm-emission order).
    const fillArms: Array<{ pattern: string; rgba: [number, number, number, number] }> = []
    const strokeArms: Array<{ pattern: string; rgba: [number, number, number, number] }> = []
    let strokeNeeded = false
    let fillNeeded = false
    const seenFillValues = new Set<string>()
    const seenStrokeValues = new Set<string>()
    for (const { node, filter } of group) {
      const fillRgba = node.fill.kind === 'constant' ? node.fill.rgba : null
      const strokeRgba = node.stroke.color.kind === 'constant' ? node.stroke.color.rgba : null
      for (const v of filter.values) {
        if (fillRgba && !seenFillValues.has(v)) {
          fillArms.push({ pattern: v, rgba: fillRgba })
          seenFillValues.add(v)
          fillNeeded = true
        }
        if (strokeRgba && !seenStrokeValues.has(v)) {
          strokeArms.push({ pattern: v, rgba: strokeRgba })
          seenStrokeValues.add(v)
          strokeNeeded = true
        }
      }
    }

    const allValues = [...new Set(group.flatMap(g => g.filter.values))]
    const orFilter: AST.Expr = buildOrFilter(firstFilter.field, allValues)

    const compoundFill: ColorValue = fillNeeded
      ? { kind: 'data-driven', expr: { ast: buildMatchAst(firstFilter.field, fillArms) } as DataExpr }
      : { kind: 'none' }
    const compoundStrokeColor: ColorValue = strokeNeeded
      ? { kind: 'data-driven', expr: { ast: buildMatchAst(firstFilter.field, strokeArms) } as DataExpr }
      : { kind: 'none' }

    const compound: RenderNode = {
      ...first,
      // Name reflects the merge so debug tooling / inspector shows
      // it for what it is.
      name: `${first.sourceLayer ?? first.sourceRef}__merged_${group.length}`,
      fill: compoundFill,
      stroke: { ...first.stroke, color: compoundStrokeColor },
      filter: { ast: orFilter } as DataExpr,
    }
    out.push(compound)
    i = j
  }

  return { ...scene, renderNodes: out }
}
