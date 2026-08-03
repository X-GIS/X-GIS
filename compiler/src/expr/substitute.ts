// ═══ Expression clone + identifier substitution ═══
// Shared AST rewriting used by parameterized presets (#1536) and, next,
// user-fn inlining (#1535). The walker deep-clones an expression tree,
// replacing every bare `Identifier` whose name is bound with a fresh
// clone of the bound expression — so no output node is ever shared with
// the input tree or between two substitution sites.
//
// Scope rules (deliberate, documented in the spec):
//   • Only bare `Identifier` nodes substitute. `.field` access
//     (`FieldAccess`) always keeps its feature-property meaning, even
//     when the field name equals a parameter name.
//   • An `Identifier` in CALLEE position never substitutes — function
//     names are not values in this language, so `scale(x)` keeps calling
//     the builtin even if a parameter is named `scale`.

import type * as AST from '../parser/ast'

const EMPTY: ReadonlyMap<string, AST.Expr> = new Map()

/** Deep-clone an expression tree (no substitution). */
export function cloneExpr(expr: AST.Expr): AST.Expr {
  return substituteIdentifiers(expr, EMPTY)
}

/** Deep-clone `expr`, replacing bound bare identifiers with fresh clones
 *  of their replacement expressions. */
export function substituteIdentifiers(
  expr: AST.Expr,
  bindings: ReadonlyMap<string, AST.Expr>,
): AST.Expr {
  switch (expr.kind) {
    case 'NumberLiteral':
    case 'StringLiteral':
    case 'ColorLiteral':
    case 'BoolLiteral':
      return { ...expr }
    case 'Identifier': {
      const bound = bindings.get(expr.name)
      // Clone the replacement per site so two call sites never share nodes.
      return bound ? cloneExpr(bound) : { ...expr }
    }
    case 'FieldAccess':
      return {
        ...expr,
        object: expr.object ? substituteIdentifiers(expr.object, bindings) : null,
      }
    case 'FnCall':
      return {
        ...expr,
        // Callee: an Identifier names a function, not a value — never
        // substitute it. Any other callee shape is an expression.
        callee:
          expr.callee.kind === 'Identifier'
            ? { ...expr.callee }
            : substituteIdentifiers(expr.callee, bindings),
        args: expr.args.map((a) => substituteIdentifiers(a, bindings)),
        ...(expr.matchBlock ? { matchBlock: substituteMatchBlock(expr.matchBlock, bindings) } : {}),
      }
    case 'BinaryExpr':
      return {
        ...expr,
        left: substituteIdentifiers(expr.left, bindings),
        right: substituteIdentifiers(expr.right, bindings),
      }
    case 'UnaryExpr':
      return { ...expr, operand: substituteIdentifiers(expr.operand, bindings) }
    case 'ConditionalExpr':
      return {
        ...expr,
        condition: substituteIdentifiers(expr.condition, bindings),
        thenExpr: substituteIdentifiers(expr.thenExpr, bindings),
        elseExpr: substituteIdentifiers(expr.elseExpr, bindings),
      }
    case 'ArrayLiteral':
      return { ...expr, elements: expr.elements.map((e) => substituteIdentifiers(e, bindings)) }
    case 'ObjectLiteral':
      return {
        ...expr,
        properties: expr.properties.map((p) => ({
          key: p.key,
          value: substituteIdentifiers(p.value, bindings),
        })),
      }
    case 'ArrayAccess':
      return {
        ...expr,
        array: substituteIdentifiers(expr.array, bindings),
        index: substituteIdentifiers(expr.index, bindings),
      }
    case 'MatchBlock':
      return substituteMatchBlock(expr, bindings)
  }
}

function substituteMatchBlock(
  block: AST.MatchBlock,
  bindings: ReadonlyMap<string, AST.Expr>,
): AST.MatchBlock {
  return {
    ...block,
    arms: block.arms.map((arm) => ({
      pattern: arm.pattern,
      value: substituteIdentifiers(arm.value, bindings),
    })),
  }
}
