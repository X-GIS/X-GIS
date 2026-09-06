// ═══ `input` declaration resolution (#1539) ═══
//
// Rewrites every bare `Identifier` naming a declared `input` into a
// distinct `InputRef` node — BEFORE anything else in the front-passes
// pipeline runs (validateFnCalls, inlineUserFns, classify, codegen).
// Mirrors ir/fn-inline.ts's shape: a pre-classify AST rewrite, not a
// symbol table threaded through every downstream consumer. Because
// `InputRef` is a distinct `Expr.kind`, every exhaustive switch over
// `Expr` elsewhere in the compiler is forced (by TypeScript, where the
// switch is exhaustiveness-checked — and by explicit audit where it
// isn't, e.g. classify.ts's `default` arm) to handle it deliberately
// instead of silently falling through the generic per-feature-field path
// — the `zoom` trap (wgsl-expr.ts's bare-Identifier fallback silently
// compiles an unrecognised name to the literal 0.0) cannot recur here.
//
// Slot assignment: each declared input gets a fixed index into the
// map/src reserved uniform pool for its type (`input_f32_0..7`,
// `input_color_0..3`), assigned deterministically by declaration order,
// independently per type. The pool sizes below are the LANGUAGE limit and
// the single authority: map/src/shaders/dsl/polygon.ts's reserved
// `input_f32_N` / `input_color_N` fields are pinned against these exact
// constants (imported via @xgis/compiler, never mirrored), so the two
// cannot drift.

import type * as AST from '../parser/ast'
import type { Diagnostic } from '../diagnostics/diagnostic'
import { INPUT_DUPLICATE, INPUT_UNUSED, INPUT_POOL_EXHAUSTED } from '../diagnostics/diagnostic'
import { mapExprChildren, mapStatementExprs } from './walk-expr'

/** Reserved GPU uniform-pool sizes — see file header. */
export const INPUT_F32_POOL_SIZE = 8
export const INPUT_COLOR_POOL_SIZE = 4

/** One resolved `input` declaration — name, type, its assigned slot in the
 *  map/src reserved uniform pool for that type, and the compile-time
 *  default. Re-exported via `render-node.ts`'s `Scene.inputs` field. */
export interface ResolvedInputInfo {
  name: string
  type: AST.InputType
  slot: number
  default: AST.NumberLiteral | AST.ColorLiteral
  line: number
}

/**
 * Resolve every `input` declaration + reference in `program`. Returns a
 * NEW program (input statements are never mutated) plus the resolved
 * input table (for emit-commands.ts to surface as `SceneCommands.inputs`).
 * With no `InputStatement`s, the input program is returned as-is.
 */
export function resolveInputs(
  program: AST.Program,
  diagnostics: Diagnostic[],
): { program: AST.Program; inputs: ResolvedInputInfo[] } {
  const declOrder = program.body.filter((s): s is AST.InputStatement => s.kind === 'InputStatement')
  if (declOrder.length === 0) return { program, inputs: [] }

  const table = new Map<string, ResolvedInputInfo>()
  let f32Count = 0
  let colorCount = 0
  for (const decl of declOrder) {
    if (table.has(decl.name)) {
      diagnostics.push({
        code: INPUT_DUPLICATE,
        severity: 'error',
        span: { line: decl.line, col: 1 },
        message: `\`input ${decl.name}\` is declared more than once.`,
        help: `Each input name must be unique across the whole program.`,
      })
      continue
    }
    const poolSize = decl.type === 'f32' ? INPUT_F32_POOL_SIZE : INPUT_COLOR_POOL_SIZE
    const slot = decl.type === 'f32' ? f32Count : colorCount
    if (slot >= poolSize) {
      diagnostics.push({
        code: INPUT_POOL_EXHAUSTED,
        severity: 'error',
        span: { line: decl.line, col: 1 },
        message:
          `\`input ${decl.name}\` exceeds the reserved \`${decl.type}\` input pool ` +
          `(${poolSize} slots — ${slot + 1} declared).`,
        help: `Reduce the number of \`${decl.type}\`-typed inputs, or raise INPUT_${decl.type === 'f32' ? 'F32' : 'COLOR'}_POOL_SIZE (and the matching reserved uniform fields in map's polygon struct).`,
      })
      continue
    }
    if (decl.type === 'f32') f32Count++
    else colorCount++
    table.set(decl.name, {
      name: decl.name,
      type: decl.type,
      slot,
      default: decl.default,
      line: decl.line,
    })
  }

  const referenced = new Set<string>()

  const resolve = (expr: AST.Expr): AST.Expr => {
    if (expr.kind === 'Identifier' && table.has(expr.name)) {
      const decl = table.get(expr.name)!
      referenced.add(decl.name)
      return {
        kind: 'InputRef',
        name: decl.name,
        type: decl.type,
        slot: decl.slot,
        default: decl.default,
      }
    }
    return mapExprChildren(expr, resolve)
  }

  const body = program.body.map((s): AST.Statement =>
    // Unlike fn-inline.ts (which leaves `FnStatement` untouched — inlining
    // happens at call sites via a separate memo), THIS pass must resolve
    // inputs inside fn bodies directly: it runs BEFORE inlineUserFns, so if
    // a bare `input` identifier inside a fn body isn't rewritten here,
    // inlineUserFns's X-GIS0017 free-identifier check would wrongly reject
    // it (that check only allows params + zoom/pitch, and doesn't know
    // about input names). Every other statement kind is the shared shape.
    s.kind === 'FnStatement' ? { ...s, body: resolve(s.body) } : mapStatementExprs(s, resolve),
  )

  for (const decl of table.values()) {
    if (referenced.has(decl.name)) continue
    diagnostics.push({
      code: INPUT_UNUSED,
      severity: 'warn',
      span: { line: decl.line, col: 1 },
      message: `\`input ${decl.name}\` is declared but never referenced by any expression in this program.`,
      help:
        `This is not necessarily a mistake — a host may still call ` +
        `\`map.setInput('${decl.name}', …)\` regardless of whether the current ` +
        `style visibly uses it.`,
    })
  }

  return { program: { kind: 'Program', body }, inputs: [...table.values()] }
}
