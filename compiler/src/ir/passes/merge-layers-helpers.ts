// ═══ IR Layer Merge Pass — pure helpers ═══
//
// Side-effect-free helper functions extracted verbatim from
// `merge-layers.ts`. No module state, no I/O — every function is a
// pure transform over its arguments. The stateful pass core
// (`mergeLayers`) imports these. Names are unchanged so call sites
// read identically.

import type * as AST from '../../parser/ast'
import type { RenderNode, DataExpr } from '../render-node'
import type { FilterAnalysis, FilterValue } from './merge-layers-types'

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
export function analyzeNotFilter(filter: DataExpr | null): FilterAnalysis | null {
  if (!filter) return null
  const ast = filter.ast as AST.Expr
  const values: FilterValue[] = []
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

/** Set equality by the stringified `raw` value. The merge contract
 *  for default-arm absorption only cares whether the `!=` chain
 *  excludes exactly the kinds the `||` chain includes — that's a
 *  string-keyed comparison (the match-arm dispatch is string-keyed
 *  too), so the literal TYPE tag is intentionally ignored here. */
/** De-duplicate FilterValues by their stringified `raw` key, keeping
 *  first-seen order and the first occurrence's `wasString` tag. A
 *  plain `new Set<FilterValue>()` would dedup by object identity (never
 *  collapses), so the union build needs an explicit raw-keyed pass. */
export function dedupByRaw(values: FilterValue[]): FilterValue[] {
  const seen = new Set<string>()
  const out: FilterValue[] = []
  for (const v of values) {
    if (seen.has(v.raw)) continue
    seen.add(v.raw)
    out.push(v)
  }
  return out
}

export function setEqual(a: FilterValue[], b: FilterValue[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a.map(v => v.raw))
  for (const v of b) if (!set.has(v.raw)) return false
  return true
}

export function analyzeFilter(filter: DataExpr | null): FilterAnalysis | null {
  if (!filter) return null
  const ast = filter.ast as AST.Expr
  const values: FilterValue[] = []
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

/** Extract the equality literal AND remember its source kind. A
 *  StringLiteral yields `wasString: true` so `buildOrFilter` re-emits
 *  it as a StringLiteral — preserving the strict-`===` match semantics
 *  the unmerged layer had. Pre-fix this returned a bare string for
 *  both and `buildOrFilter` re-guessed the type via `Number()`,
 *  silently converting `.class == "1"` into `.class == 1`. */
function extractLiteral(expr: AST.Expr): FilterValue | null {
  if (expr.kind === 'StringLiteral') return { raw: expr.value, wasString: true }
  if (expr.kind === 'NumberLiteral') return { raw: String(expr.value), wasString: false }
  return null
}

/** True when the two stroke definitions agree on everything that's
 *  NOT individually dispatchable per feature — linecap, linejoin,
 *  miterlimit, dash, offsets, patterns. Width and colour CAN differ;
 *  the synthesized match handles those. */
export function strokesShapeEqual(a: RenderNode['stroke'], b: RenderNode['stroke']): boolean {
  if (a.linecap !== b.linecap) return false
  if (a.linejoin !== b.linejoin) return false
  if (a.miterlimit !== b.miterlimit) return false
  if (a.dashOffset !== b.dashOffset) return false
  if (a.offset !== b.offset) return false
  if (a.align !== b.align) return false
  // Edge-feather width (Mapbox `paint.line-blur`) lives on the layer
  // uniform — there's no per-segment override slot for it. Members
  // that author different blur values must stay separate or the merge
  // would render one of them with the wrong feather radius.
  if ((a.blur ?? 0) !== (b.blur ?? 0)) return false
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
      // Every pattern attribute (shape / spacing+unit / size+unit /
      // offset+unit / startOffset / anchor) is layer-uniform — no
      // per-segment override slot exists. Pre-fix the check only
      // compared shape / spacing / size, so two layers differing in
      // pattern offset or anchor mode would fold into one and render
      // every absorbed kind with the FIRST member's placement.
      if (p.shape !== q.shape) return false
      if (p.spacing !== q.spacing) return false
      if ((p.spacingUnit ?? null) !== (q.spacingUnit ?? null)) return false
      if (p.size !== q.size) return false
      if ((p.sizeUnit ?? null) !== (q.sizeUnit ?? null)) return false
      if ((p.offset ?? 0) !== (q.offset ?? 0)) return false
      if ((p.offsetUnit ?? null) !== (q.offsetUnit ?? null)) return false
      if ((p.startOffset ?? 0) !== (q.startOffset ?? 0)) return false
      if ((p.anchor ?? 'repeat') !== (q.anchor ?? 'repeat')) return false
    }
  }
  return true
}

export function isMergeableNode(n: RenderNode): boolean {
  if (n.extrude.kind !== 'none') return false
  if (n.fill.kind !== 'constant' && n.fill.kind !== 'none') return false
  if (n.stroke.color.kind !== 'constant' && n.stroke.color.kind !== 'none') return false
  if (n.opacity.kind !== 'constant') return false
  if (n.opacity.value < 0.999) return false
  if (n.geometry !== null) return false
  if (n.animationMeta !== undefined) return false
  if (n.shape.kind !== 'none') return false  // points handled separately
  // Symbol layers carry per-layer label specs (text content + font +
  // size + halo + collision priority). The merge collapses N layers
  // into ONE compound — only the first layer's label survives, so
  // every absorbed label gets dropped from the render. Symbol layers
  // share source-layers all the time (place_label / poi_label /
  // road_label all read 'place' or 'transportation'), so without
  // this gate adjacent text layers were folding into a single
  // compound and labels disappeared from the map.
  if (n.label !== undefined) return false
  // The merge synthesises a per-feature `match(.class) { v -> N, … }`
  // AST baked into the segment buffer's width-override slot. Nodes
  // whose width is already zoom-stops / per-feature carry their own
  // mechanism — letting the merger collapse them to a constant would
  // discard that information. Skip them so they render unmerged.
  if (n.stroke.width.kind !== 'constant') return false
  // Stroke colour already carries a per-feature AST (e.g. user-authored
  // `paint.line-color: ["match", …]` lowered through the converter's
  // data-driven path). The merge would synthesise a UNION match across
  // group members and clobber the existing colorExpr — same data-loss
  // class as the strokeWidth bail above. Leave these unmerged.
  if (n.stroke.colorExpr !== undefined) return false
  return true
}

export function strokeColorsEqual(a: RenderNode['stroke'], b: RenderNode['stroke']): boolean {
  if (a.color.kind !== b.color.kind) return false
  if (a.color.kind === 'none' && b.color.kind === 'none') return true
  if (a.color.kind === 'constant' && b.color.kind === 'constant') {
    const ar = a.color.rgba; const br = b.color.rgba
    return ar[0] === br[0] && ar[1] === br[1] && ar[2] === br[2] && ar[3] === br[3]
  }
  return false
}

export function canExtendGroup(first: RenderNode, candidate: RenderNode): boolean {
  if (first.sourceRef !== candidate.sourceRef) return false
  if (first.sourceLayer !== candidate.sourceLayer) return false
  if (first.projection !== candidate.projection) return false
  if (first.visible !== candidate.visible) return false
  if (first.pointerEvents !== candidate.pointerEvents) return false
  // Zoom range must match — the merged node uses first.minzoom /
  // first.maxzoom (via `...first` spread at the compound build site),
  // so a candidate with a different range would inherit first's range
  // and either over-render at zooms it wasn't meant to (candidate's
  // minzoom > first.minzoom) or under-render (candidate's maxzoom <
  // first.maxzoom). OSM landuse styles where _residential authors
  // minzoom: 10 but _park authors minzoom: 8 must stay separate.
  if (first.minzoom !== candidate.minzoom) return false
  if (first.maxzoom !== candidate.maxzoom) return false
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
export function buildMatchAst(
  field: string,
  arms: Array<{ pattern: string; rgba: import('../property-types').RGBA }>,
  /** Override for the `_` default arm. When the merge pass absorbs
   *  a complementary `&&`-chain `!=` layer (e.g. `landuse_other`),
   *  its fill / stroke colour becomes the default. Without it the
   *  default is alpha=0 — equivalent to "discard" since the line /
   *  fill SDF threshold drops fragments with alpha < 0.005. */
  defaultRgba?: import('../property-types').RGBA | null,
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
export function buildWidthMatchAst(
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

function rgbaToHex(rgba: import('../property-types').RGBA): string {
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
export function buildOrFilter(field: string, allValues: FilterValue[]): AST.Expr {
  // Build .field == v0 || .field == v1 || ...
  const fieldAccess = (): AST.Expr => ({
    kind: 'FieldAccess',
    object: null,
    field,
  } as unknown as AST.Expr)
  const literalOf = (v: FilterValue): AST.Expr => {
    // Re-emit the SAME node kind the source filter used. A source
    // StringLiteral stays a StringLiteral (even when its text looks
    // numeric, e.g. "1"); a source NumberLiteral stays a
    // NumberLiteral. The evaluator's `==` is strict (`left ===
    // right`, evaluator.ts), so preserving the type keeps the merged
    // OR-filter matching exactly the features the unmerged layer did.
    if (v.wasString) {
      return { kind: 'StringLiteral', value: v.raw } as AST.Expr
    }
    return { kind: 'NumberLiteral', value: Number(v.raw) } as AST.Expr
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
