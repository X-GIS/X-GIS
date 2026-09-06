// ═══ Expression walkers — the single authority for "what are an Expr's children" ═══
//
// Row 11 of the duplication audit (docs/plans/2026-09-05-code-duplication-audit.md,
// #2534). The AST child enumeration was written out four times — twice as a
// rewriter (`ir/fn-inline.ts`, `ir/resolve-inputs.ts`) and twice as a visitor
// (`ir/passes/cse.ts`, `ir/passes/expr-analyze.ts`) — alongside two copies of
// the statement-level rewriter and two of the Scene paint-surface driver. A
// new `AST.Expr` kind had to be added to every one of them; missing one is a
// silent no-op, not a compile error.
//
// There are deliberately TWO child walkers here, not one, because the
// rewriters and the analyses need different child SETS and folding them
// would be a behaviour change, not a refactor:
//
//   mapExprChildren    An `Identifier` in CALLEE position is held fixed — a
//                      function name is not a value (the rule stated in
//                      `expr/substitute.ts`), and `resolve-inputs` would
//                      otherwise rewrite `foo(x)`'s callee into an `InputRef`
//                      when a declared input happens to be named `foo`.
//                      `ObjectLiteral` values ARE rewritten: a rewriter must
//                      not drop a subtree.
//
//   forEachExprChild   The callee IS visited — it is a node the CSE report
//                      counts and `expr-analyze` stamps. `ObjectLiteral` is
//                      treated as a leaf, exactly as both analyses have
//                      always treated it; descending into it would change
//                      every `CSEReport` and every `ExprMeta`.
//
// `mapExprChildren`'s switch has no `default`, so its `AST.Expr` return type
// makes a new kind a TYPE error rather than a silent hole. `forEachExprChild`
// returns void and cannot get that for free — `walk-expr.test.ts` supplies it
// with a `Record<AST.Expr['kind'], …>` case table that fails to compile until
// a new kind is added there too.

import type * as AST from '../parser/ast'
import type { Scene, ColorValue, DataExpr, ConditionalBranch } from './render-node'
import type { PropertyShape } from './property-types'

/** Structurally rewrite every child expression of `expr` (shallow clone).
 *  Returns `expr` itself when it has no child to rewrite, so an unchanged
 *  subtree keeps its node identity. */
export function mapExprChildren(expr: AST.Expr, f: (e: AST.Expr) => AST.Expr): AST.Expr {
  switch (expr.kind) {
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'ColorLiteral':
    case 'BoolLiteral':
    case 'Identifier':
    case 'InputRef':
      return expr
    case 'FieldAccess':
      return expr.object ? { ...expr, object: f(expr.object) } : expr
    case 'FnCall':
      return {
        ...expr,
        callee: expr.callee.kind === 'Identifier' ? expr.callee : f(expr.callee),
        args: expr.args.map(f),
        ...(expr.matchBlock
          ? {
              matchBlock: {
                ...expr.matchBlock,
                arms: expr.matchBlock.arms.map((a) => ({ pattern: a.pattern, value: f(a.value) })),
              },
            }
          : {}),
      }
    case 'BinaryExpr':
      return { ...expr, left: f(expr.left), right: f(expr.right) }
    case 'UnaryExpr':
      return { ...expr, operand: f(expr.operand) }
    case 'ConditionalExpr':
      return {
        ...expr,
        condition: f(expr.condition),
        thenExpr: f(expr.thenExpr),
        elseExpr: f(expr.elseExpr),
      }
    case 'ArrayLiteral':
      return { ...expr, elements: expr.elements.map(f) }
    case 'ObjectLiteral':
      return {
        ...expr,
        properties: expr.properties.map((p) => ({ key: p.key, value: f(p.value) })),
      }
    case 'ArrayAccess':
      return { ...expr, array: f(expr.array), index: f(expr.index) }
    case 'MatchBlock':
      return { ...expr, arms: expr.arms.map((a) => ({ pattern: a.pattern, value: f(a.value) })) }
  }
}

/** Visit every child expression of `expr`, in evaluation order. The analysis
 *  child set — see the header for how it differs from `mapExprChildren`. */
export function forEachExprChild(expr: AST.Expr, f: (e: AST.Expr) => void): void {
  switch (expr.kind) {
    case 'FieldAccess':
      if (expr.object) f(expr.object)
      return
    case 'FnCall':
      f(expr.callee)
      for (const a of expr.args) f(a)
      if (expr.matchBlock) for (const arm of expr.matchBlock.arms) f(arm.value)
      return
    case 'BinaryExpr':
      f(expr.left)
      f(expr.right)
      return
    case 'UnaryExpr':
      f(expr.operand)
      return
    case 'ConditionalExpr':
      f(expr.condition)
      f(expr.thenExpr)
      f(expr.elseExpr)
      return
    case 'ArrayLiteral':
      for (const el of expr.elements) f(el)
      return
    case 'ArrayAccess':
      f(expr.array)
      f(expr.index)
      return
    case 'MatchBlock':
      for (const arm of expr.arms) f(arm.value)
      return
    // Leaves for this walker: NumberLiteral, StringLiteral, ColorLiteral,
    // BoolLiteral, Identifier, InputRef — and ObjectLiteral, per the header.
    default:
      return
  }
}

/** Rewrite every expression a statement carries, in source order. `f` also
 *  receives the line the expression was authored on (`fn-inline` reports
 *  diagnostics against it; `resolve-inputs` ignores it).
 *
 *  `FnStatement` is NOT handled: `fn-inline` leaves declarations alone
 *  (bodies are resolved at the call sites through its memo), so a caller
 *  that does need to rewrite a body handles that kind before delegating. */
export function mapStatementExprs(
  s: AST.Statement,
  f: (e: AST.Expr, line: number) => AST.Expr,
): AST.Statement {
  const mapLines = (lines: AST.UtilityLine[]): AST.UtilityLine[] =>
    lines.map((line) => ({
      ...line,
      items: line.items.map((item) => ({
        ...item,
        binding: item.binding ? f(item.binding, line.line) : null,
        ...(item.args ? { args: item.args.map((a) => f(a, line.line)) } : {}),
      })),
    }))
  const mapProps = (props: AST.BlockProperty[]): AST.BlockProperty[] =>
    props.map((p) => ({ ...p, value: f(p.value, p.line) }))

  switch (s.kind) {
    case 'SourceStatement':
      return { ...s, properties: mapProps(s.properties) }
    case 'LayerStatement':
      return {
        ...s,
        properties: mapProps(s.properties),
        utilities: mapLines(s.utilities),
        // #1538 — a stage-block body is an ordinary expression, so it is
        // rewritten like anywhere else.
        ...(s.stages
          ? { stages: s.stages.map((st) => ({ ...st, body: f(st.body, st.line) })) }
          : {}),
      }
    case 'BackgroundStatement':
      return { ...s, utilities: mapLines(s.utilities) }
    case 'PresetStatement':
      return { ...s, properties: mapProps(s.properties), utilities: mapLines(s.utilities) }
    case 'KeyframesStatement':
      return {
        ...s,
        frames: s.frames.map((fr) => ({
          ...fr,
          utilities: fr.utilities.map((item) => ({
            ...item,
            binding: item.binding ? f(item.binding, fr.line) : null,
          })),
        })),
      }
    // FnStatement (see above) plus StructStatement / ImportStatement /
    // SymbolStatement / InputStatement / TerrainStatement, which carry no
    // rewritable expression.
    default:
      return s
  }
}

/** Visit every ROOT expression on a Scene's paint / filter / geometry
 *  surfaces, in render-node order. Descend with `forEachExprChild`. */
export function forEachSceneExpr(scene: Scene, visit: (e: AST.Expr) => void): void {
  const visitDataExpr = (e: DataExpr | null | undefined): void => {
    if (!e) return
    visit(e.ast as AST.Expr)
  }

  const visitColorValue = (v: ColorValue): void => {
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

  const visitPropertyShape = <T>(shape: PropertyShape<T>): void => {
    if (shape.kind === 'data-driven') visitDataExpr(shape.expr)
  }

  for (const node of scene.renderNodes) {
    visitColorValue(node.fill)
    visitColorValue(node.stroke.color)
    visitDataExpr((node.stroke as { colorExpr?: DataExpr }).colorExpr)
    visitPropertyShape(node.stroke.width)
    visitPropertyShape(node.opacity)
    // SizeValue is a separate union (different kind names than
    // PropertyShape) but the data-driven variant carries a DataExpr.
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
}
