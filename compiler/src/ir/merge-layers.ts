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
/** Returns null when the filter doesn't match the "default-arm
 *  absorption" contract — `&&`-chain of `.field != LITERAL` on a
 *  single field. The OSM-style demo's `landuse_other` block is the
 *  canonical case: `filter: .kind != "park" && .kind != "forest"
 *  && ... && .kind != "industrial"`. When the value set EQUALS the
 *  union of an adjacent compound's `||`-chain values, the
 *  `!=`-layer covers exactly the features the compound doesn't, so
 *  it can fold into the compound's `_` default arm. */
function analyzeNotFilter(filter: DataExpr | null): FilterAnalysis | null {
  if (!filter) return null
  const ast = filter.ast as AST.Expr
  const values: string[] = []
  let field: string | null = null
  const visit = (node: AST.Expr): boolean => {
    if (node.kind === 'BinaryExpr' && node.op === '&&') {
      return visit(node.left) && visit(node.right)
    }
    if (node.kind === 'BinaryExpr' && node.op === '!=') {
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

function setEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  for (const v of b) if (!set.has(v)) return false
  return true
}

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

/** True when the two stroke definitions agree on everything that's
 *  NOT individually dispatchable per feature — linecap, linejoin,
 *  miterlimit, dash, offsets, patterns. Width and colour CAN differ;
 *  the synthesized match handles those. */
function strokesShapeEqual(a: RenderNode['stroke'], b: RenderNode['stroke']): boolean {
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

function strokeColorsEqual(a: RenderNode['stroke'], b: RenderNode['stroke']): boolean {
  if (a.color.kind !== b.color.kind) return false
  if (a.color.kind === 'none' && b.color.kind === 'none') return true
  if (a.color.kind === 'constant' && b.color.kind === 'constant') {
    const ar = a.color.rgba; const br = b.color.rgba
    return ar[0] === br[0] && ar[1] === br[1] && ar[2] === br[2] && ar[3] === br[3]
  }
  return false
}

function canExtendGroup(first: RenderNode, candidate: RenderNode): boolean {
  if (first.sourceRef !== candidate.sourceRef) return false
  if (first.sourceLayer !== candidate.sourceLayer) return false
  if (first.projection !== candidate.projection) return false
  if (first.visible !== candidate.visible) return false
  if (first.pointerEvents !== candidate.pointerEvents) return false
  if (!strokesShapeEqual(first.stroke, candidate.stroke)) return false
  // Stroke colour difference IS folded structurally — same pattern
  // as the per-feature stroke width: the worker evaluates a
  // synthesised match() AST per feature, packs RGBA8 into a u32, and
  // writes it into the line segment buffer's `color_packed` slot.
  // The line shader unpacks it and uses it when alpha > 0,
  // otherwise falls through to layer.color. Avoids the LineRenderer
  // needing a feature-data binding (the polygon variant pipeline's
  // path) while still getting per-feature stroke colour.
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
  /** Override for the `_` default arm. When the merge pass absorbs
   *  a complementary `&&`-chain `!=` layer (e.g. `landuse_other`),
   *  its fill / stroke colour becomes the default. Without it the
   *  default is alpha=0 — equivalent to "discard" since the line /
   *  fill SDF threshold drops fragments with alpha < 0.005. */
  defaultRgba?: [number, number, number, number] | null,
): AST.Expr {
  const defaultHex = defaultRgba ? rgbaToHex(defaultRgba) : '#00000000'
  const defaultArm: AST.MatchArm = {
    pattern: '_',
    value: { kind: 'ColorLiteral', value: defaultHex } as AST.Expr,
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

  // `object: null` is the AST shape for implicit `.field` access
  // (evaluator's evaluateFieldAccess routes a non-null object
  // through `evaluate(object) → look up [field]` which fails for a
  // synthetic empty-name identifier; null means "look up `field`
  // directly on the feature props bag", which is what we want).
  const fieldAccess: AST.Expr = {
    kind: 'FieldAccess',
    object: null,
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

/** Synthesize `match(.field) { value -> N, ..., _ -> 0 }` for
 *  per-feature stroke width. Resolved by the worker at decode time
 *  and written into the line segment buffer's per-segment width
 *  slot; the line shader picks segment.width_px over the layer
 *  uniform when non-zero. The default arm returns 0 so unmatched
 *  features (defensive — the compound's filter already excludes
 *  them) fall back to layer width without rendering at zero. */
function buildWidthMatchAst(
  field: string,
  arms: Array<{ pattern: string; width: number }>,
  /** Override for the `_` default arm's width. Used when the merge
   *  pass absorbs an `&&`-chain `!=` default-arm layer (the
   *  `landuse_other` pattern). 0 = "no override" sentinel. */
  defaultWidth: number | null = null,
): AST.Expr {
  const matchArms: AST.MatchArm[] = arms.map(a => ({
    pattern: a.pattern,
    value: { kind: 'NumberLiteral', value: a.width } as AST.Expr,
  }))
  matchArms.push({
    pattern: '_',
    value: { kind: 'NumberLiteral', value: defaultWidth ?? 0 } as AST.Expr,
  })
  const matchBlock: AST.MatchBlock = { kind: 'MatchBlock', arms: matchArms }
  // `object: null` is the AST shape for implicit `.field` access
  // (evaluator's evaluateFieldAccess routes a non-null object
  // through `evaluate(object) → look up [field]` which fails for a
  // synthetic empty-name identifier; null means "look up `field`
  // directly on the feature props bag", which is what we want).
  const fieldAccess: AST.Expr = {
    kind: 'FieldAccess',
    object: null,
    field,
  } as unknown as AST.Expr
  return {
    kind: 'FnCall',
    callee: { kind: 'Identifier', name: 'match' } as AST.Expr,
    args: [fieldAccess],
    matchBlock,
  } as unknown as AST.Expr
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
    object: null,
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

    // Default-arm absorption: after the contiguous `||`-chain group
    // is built, check whether the NEXT layer is the complementary
    // `&&`-chain on the same field with the same value set. That's
    // the OSM-style `landuse_other` pattern — `filter: .kind !=
    // park && .kind != grass && ... && .kind != industrial` covers
    // exactly the kinds the compound's || values DON'T. We can fold
    // it as the compound's `_` default arm AND drop the compound's
    // filter so all source-layer features reach the shader (the
    // match() then dispatches to either an explicit value arm or
    // the default).
    let defaultArmNode: RenderNode | null = null
    if (j < nodes.length) {
      const cand = nodes[j]
      if (cand.sourceRef === first.sourceRef
          && cand.sourceLayer === first.sourceLayer
          && cand.extrude.kind === 'none'
          && cand.opacity.kind === 'constant' && cand.opacity.value >= 0.999
          && cand.geometry === null
          && cand.shape.kind === 'none') {
        const notFilter = analyzeNotFilter(cand.filter)
        if (notFilter && notFilter.field === firstFilter.field) {
          const allCompoundValues = [...new Set(group.flatMap(g => g.filter.values))]
          if (setEqual(notFilter.values, allCompoundValues)) {
            defaultArmNode = cand
            j++
          }
        }
      }
    }

    // Synthesize the compound. Build per-(value → colour / width) arms
    // from every group member so a feature gets the styling of the
    // FIRST member whose filter matched it (declaration order
    // preserved by the arm-emission order).
    const fillArms: Array<{ pattern: string; rgba: [number, number, number, number] }> = []
    const strokeArms: Array<{ pattern: string; rgba: [number, number, number, number] }> = []
    const widthArms: Array<{ pattern: string; width: number }> = []
    let strokeNeeded = false
    let fillNeeded = false
    const seenFillValues = new Set<string>()
    const seenStrokeValues = new Set<string>()
    const seenWidthValues = new Set<string>()
    let widthsAllEqual = true
    const firstWidth = group[0].node.stroke.width
    for (const { node, filter } of group) {
      if (node.stroke.width !== firstWidth) widthsAllEqual = false
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
        if (!seenWidthValues.has(v)) {
          widthArms.push({ pattern: v, width: node.stroke.width })
          seenWidthValues.add(v)
        }
      }
    }

    const allValues = [...new Set(group.flatMap(g => g.filter.values))]
    // When a default-arm node was absorbed, the compound covers
    // EVERY feature in the source layer (the explicit ||-values
    // PLUS everything else); drop the filter entirely so the
    // worker's pre-bucket sees all features. Without absorption,
    // keep the OR-filter so unmatched features stay out of the
    // slice (the synthesized `_ -> #00000000` arm would render
    // them transparent but they'd still consume vertex / fragment
    // bandwidth).
    const orFilter: AST.Expr | null = defaultArmNode
      ? null
      : buildOrFilter(firstFilter.field, allValues)

    // Default arm contribution from the absorbed `&&`-chain layer.
    // The default colour resolves to `#00000000` (alpha=0 = "no
    // colour") when the absorbed layer doesn't have a fill /
    // stroke; the match-arm chain in shader-gen turns alpha=0
    // arms into a discard-equivalent path (low-alpha SDF threshold
    // already covers it).
    const defaultFillRgba = defaultArmNode?.fill.kind === 'constant'
      ? defaultArmNode.fill.rgba
      : null
    const defaultStrokeRgba = defaultArmNode?.stroke.color.kind === 'constant'
      ? defaultArmNode.stroke.color.rgba
      : null
    const defaultWidth = defaultArmNode?.stroke.width

    const compoundFill: ColorValue = fillNeeded || defaultFillRgba
      ? {
          kind: 'data-driven',
          expr: {
            ast: buildMatchAst(firstFilter.field, fillArms, defaultFillRgba),
          } as DataExpr,
        }
      : { kind: 'none' }
    // Stroke colour: when every member shares the colour, keep it as
    // a plain constant (no AST work). When they differ, leave the
    // shader-side ColorValue at the FIRST member's constant (acts
    // as the "no override" fallback in the line shader) and stash
    // the match() AST on `colorExpr` so the worker bakes per-feature
    // RGBA8 into the segment buffer at decode time. This sidesteps
    // the LineRenderer's lack of a feature-data binding — the
    // shader doesn't have to read `feat_data[...]`, just unpack the
    // segment's pre-resolved `color_packed`.
    // Stroke colour: per-feature dispatch baked into segment buffer
    // when group members differ, OR when the absorbed default arm's
    // stroke colour differs from the group's.
    const allStrokeColorsSame = group.every(g =>
      strokeColorsEqual(group[0].node.stroke, g.node.stroke),
    )
    const defaultStrokeMatchesGroup = defaultStrokeRgba == null
      || (group[0].node.stroke.color.kind === 'constant'
          && group[0].node.stroke.color.rgba[0] === defaultStrokeRgba[0]
          && group[0].node.stroke.color.rgba[1] === defaultStrokeRgba[1]
          && group[0].node.stroke.color.rgba[2] === defaultStrokeRgba[2]
          && group[0].node.stroke.color.rgba[3] === defaultStrokeRgba[3])
    const strokeColorBakeNeeded = strokeNeeded
      && (!allStrokeColorsSame || !defaultStrokeMatchesGroup)
    const compoundStrokeColor: ColorValue = !strokeNeeded && !defaultStrokeRgba
      ? { kind: 'none' }
      : group[0].node.stroke.color
    const compoundStrokeColorExpr = !strokeColorBakeNeeded
      ? undefined
      : { ast: buildMatchAst(firstFilter.field, strokeArms, defaultStrokeRgba) } as DataExpr

    // Per-feature width baking when EITHER group widths differ OR
    // the absorbed default arm's width differs from the group's.
    const widthBakeNeeded = !widthsAllEqual
      || (defaultWidth !== undefined && defaultWidth !== firstWidth)
    const compound: RenderNode = {
      ...first,
      name: `${first.sourceLayer ?? first.sourceRef}__merged_${group.length}${defaultArmNode ? '+1default' : ''}`,
      fill: compoundFill,
      stroke: {
        ...first.stroke,
        color: compoundStrokeColor,
        widthExpr: !widthBakeNeeded
          ? undefined
          : {
              ast: buildWidthMatchAst(
                firstFilter.field,
                widthArms,
                defaultWidth ?? null,
              ),
            } as DataExpr,
        colorExpr: compoundStrokeColorExpr,
      },
      // When a default arm absorbed: drop the filter so all
      // source-layer features reach the slice. Without absorption:
      // keep the OR-filter so unmatched features stay out.
      filter: orFilter ? { ast: orFilter } as DataExpr : null,
    }
    // Dev-mode visibility into the merge. Triggered ONLY when the
    // host environment defines `__XGIS_MERGE_LOG = true` (set by
    // playground vite config in dev, off in prod). Lets a contributor
    // confirm at-a-glance which xgis layers actually folded without
    // grepping IR snapshots. Production deployments stay silent.
    const env = (globalThis as { __XGIS_MERGE_LOG?: boolean })
    if (env.__XGIS_MERGE_LOG) {
      const memberNames = group.map(g => g.node.name).join(', ')
      const widthInfo = widthsAllEqual ? 'same-width' : 'per-feature width'
      const colorInfo = !strokeNeeded
        ? 'no-stroke'
        : compoundStrokeColorExpr ? 'per-feature stroke' : 'shared stroke'
      // eslint-disable-next-line no-console
      console.log(
        `[xgis merge] ${compound.name}: folded ${group.length} layers `
        + `(${memberNames}) — ${widthInfo}, ${colorInfo}`,
      )
    }
    out.push(compound)
    i = j
  }

  return { ...scene, renderNodes: out }
}
