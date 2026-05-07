// ═══ Extrude expression mini-evaluator ════════════════════════════
//
// Recognises the subset of compiler AST nodes the `extrude:` style
// keyword commonly produces:
//
//   extrude: 50                                 NumberLiteral
//   extrude: .height                            FieldAccess (implicit)
//   extrude: .levels * 3.5                      BinaryExpr *
//   extrude: .levels * 3.5 + .min_height        BinaryExpr + (nested)
//
// The compiler's full `evaluate()` covers more shapes (FnCall, Pipe,
// MatchBlock, …) but importing it into the MVT worker would pull the
// whole parser/lexer/codegen module graph along, bloating the worker
// bundle and slowing first-tile decode. The compile-time `extrude:`
// surface stays restricted to numeric literals, field accesses, and
// arithmetic for now — matching what's actually useful for building
// height calculations from MVT properties.
//
// Anything outside the supported set returns null → the upload path
// falls back to the layer's default fallback height.

export type ExtrudeAst = unknown // serialized AST node, structurally typed inside

interface MiniNode {
  kind: string
}
interface NumberLiteral extends MiniNode { kind: 'NumberLiteral'; value: number }
interface FieldAccess extends MiniNode { kind: 'FieldAccess'; object: unknown; field: string }
interface BinaryExpr extends MiniNode { kind: 'BinaryExpr'; op: string; left: MiniNode; right: MiniNode }

/** Evaluate an extrude AST against a feature property bag. Returns a
 *  number when the expression resolves to one, null otherwise (caller
 *  treats null as "use fallback"). */
export function evalExtrudeExpr(node: ExtrudeAst, props: Record<string, unknown>): number | null {
  if (!node || typeof node !== 'object') return null
  const n = node as MiniNode
  switch (n.kind) {
    case 'NumberLiteral': {
      const v = (n as NumberLiteral).value
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    }
    case 'FieldAccess': {
      const fa = n as FieldAccess
      if (fa.object !== null) return null
      const v = props[fa.field]
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    }
    case 'BinaryExpr': {
      const be = n as BinaryExpr
      const lv = evalExtrudeExpr(be.left, props)
      const rv = evalExtrudeExpr(be.right, props)
      if (lv === null || rv === null) return null
      switch (be.op) {
        case '+': return lv + rv
        case '-': return lv - rv
        case '*': return lv * rv
        case '/': return rv === 0 ? null : lv / rv
        default: return null
      }
    }
    default:
      return null
  }
}
