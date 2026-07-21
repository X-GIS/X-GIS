// ═══ AST → IR Lowering: unknown-function validation (#1066) ═══
//
// Walks every expression in the parsed program and rejects any `FnCall`
// whose callee is not a known function. Before this pass, an unrecognised
// callee flowed straight to `callBuiltin`'s `default` branch, which
// returned `args[0]` — so a typo like `sqrrt(.x)` silently evaluated to
// `.x` and rendered plausible-but-wrong output.
//
// The valid callee set is CLOSED and comes from three single authorities:
//   1. `BUILTIN_FN_NAMES` — the exact set `callBuiltin` dispatches
//      (eval/evaluator-helpers.ts). Imported, never re-listed.
//   2. `NON_BUILTIN_CALLEES` — the legal callees handled OUTSIDE
//      callBuiltin (evaluator special forms + colour/codegen forms +
//      the `load` source loader), each traced to its stage below.
//   3. `import`ed names collected from the program (the sole program-side
//      callables since #1072 pruned the `fn` keyword).
//
// Diagnostics flow through the unified #1065 channel as `X-GIS0012` errors,
// carrying a nearest-name `help` suggestion. Callee positions that the
// evaluator ignores (a non-identifier callee never reaches callBuiltin) are
// skipped. A wrong callee inside a value the runtime never evaluates is
// impossible to author in a DataExpr, so walking the whole program is both
// complete and false-positive-free once the closed set above is honoured.

import type * as AST from '../parser/ast'
import type { Diagnostic } from '../diagnostics/diagnostic'
import { UNKNOWN_FUNCTION } from '../diagnostics/diagnostic'
import { BUILTIN_FN_NAMES } from '../eval/evaluator-helpers'

/** Legal callee names handled OUTSIDE `callBuiltin`. A call to one of
 *  these is valid even though it is absent from `BUILTIN_FN_NAMES`. Each
 *  name is traced to the stage that gives it meaning, so the set stays
 *  auditable and closed. Exported so the validation test can prove — from
 *  this one authority, not a hand-copied list — that every special form
 *  still passes. */
export const NON_BUILTIN_CALLEES: ReadonlySet<string> = new Set([
  // Evaluator special forms — intercepted in eval/evaluator.ts
  // (evaluateFnCall) BEFORE callBuiltin: they need the live feature
  // props bag or the parser-attached matchBlock.
  'get',
  'properties',
  'match',
  // NB: the rgb / rgba / hsl / hsla colour constructors are NOT here —
  // they are genuine `callBuiltin` builtins (eval/evaluator-helpers.ts
  // BUILTIN_FN_NAMES), the per-feature-CPU path a data-driven
  // `["rgb", ["get","r"], …]` classifies to. Constant forms still
  // hex-encode at convert time (tokens/colors.ts) and the GPU
  // reconstruction path (codegen/shader-gen-helpers.ts) handles the
  // constant CSS form; both are orthogonal to callee validation.
  // Data-driven DSL forms — intercepted by codegen/shader-gen.ts and
  // rendered on the GPU (categorical → auto-palette, gradient → ramp).
  'categorical',
  'gradient',
  // Feature-property presence accessor — recognised by the WGSL codegen
  // (codegen/wgsl-expr.ts). The Mapbox converter lowers `["has", k]` to
  // `.k != null`, but a hand-authored `has(.k)` is still a legal callee.
  'has',
  // Structural source loader — interpreted by ir/lower.ts
  // (lowerLetAsSource); never evaluated.
  'load',
])

/** Names offered as "did you mean …" suggestions — the full known-callee
 *  universe minus user fns (a suggestion should point at a real builtin). */
const KNOWN_NAMES: readonly string[] = [...BUILTIN_FN_NAMES, ...NON_BUILTIN_CALLEES]

/**
 * Validate every `FnCall` callee in `program`, pushing an `X-GIS0012`
 * error diagnostic for each unknown name. `program` is the parsed AST
 * (post import-resolution), so any `import`ed callable names are present
 * as `ImportStatement`s. Mutates `diagnostics` in place — the same array lower()
 * already threads through every stage.
 */
export function validateFnCalls(program: AST.Program, diagnostics: Diagnostic[]): void {
  const declared = collectDeclaredNames(program)
  walkStatements(program.body, diagnostics, declared)
}

/** Every name a call may legally resolve to besides the builtins: the
 *  `import`ed names (a call could target one of them). The `fn` keyword
 *  and the imperative `if`/`for` statement forms were pruned by #1072, so
 *  imports (top-level only) are now the sole non-builtin callable source. */
function collectDeclaredNames(program: AST.Program): Set<string> {
  const names = new Set<string>()
  for (const s of program.body) {
    if (s.kind === 'ImportStatement') {
      for (const n of s.names) names.add(n)
    }
  }
  return names
}

function walkStatements(
  stmts: readonly AST.Statement[],
  diagnostics: Diagnostic[],
  declared: ReadonlySet<string>,
): void {
  for (const s of stmts) {
    switch (s.kind) {
      case 'SourceStatement':
        for (const p of s.properties) walkExpr(p.value, p.line, diagnostics, declared)
        break
      case 'LayerStatement':
        for (const p of s.properties) walkExpr(p.value, p.line, diagnostics, declared)
        walkUtilityLines(s.utilities, diagnostics, declared)
        break
      case 'BackgroundStatement':
        walkUtilityLines(s.utilities, diagnostics, declared)
        break
      case 'PresetStatement':
        walkUtilityLines(s.utilities, diagnostics, declared)
        break
      case 'KeyframesStatement':
        for (const f of s.frames) walkUtilityItems(f.utilities, f.line, diagnostics, declared)
        break
      // ImportStatement / SymbolStatement / StyleStatement carry no
      // evaluated expressions (module names, path strings, CSS-like
      // string values) — nothing to validate.
    }
  }
}

function walkUtilityLines(
  lines: readonly AST.UtilityLine[],
  diagnostics: Diagnostic[],
  declared: ReadonlySet<string>,
): void {
  for (const line of lines) walkUtilityItems(line.items, line.line, diagnostics, declared)
}

function walkUtilityItems(
  items: readonly AST.UtilityItem[],
  line: number,
  diagnostics: Diagnostic[],
  declared: ReadonlySet<string>,
): void {
  for (const item of items) {
    if (item.binding) walkExpr(item.binding, line, diagnostics, declared)
  }
}

function walkExpr(
  expr: AST.Expr,
  line: number,
  diagnostics: Diagnostic[],
  declared: ReadonlySet<string>,
): void {
  switch (expr.kind) {
    case 'FnCall':
      validateCallee(expr.callee, line, diagnostics, declared)
      for (const a of expr.args) walkExpr(a, line, diagnostics, declared)
      if (expr.matchBlock) {
        for (const arm of expr.matchBlock.arms) walkExpr(arm.value, line, diagnostics, declared)
      }
      break
    case 'BinaryExpr':
      walkExpr(expr.left, line, diagnostics, declared)
      walkExpr(expr.right, line, diagnostics, declared)
      break
    case 'UnaryExpr':
      walkExpr(expr.operand, line, diagnostics, declared)
      break
    case 'ConditionalExpr':
      walkExpr(expr.condition, line, diagnostics, declared)
      walkExpr(expr.thenExpr, line, diagnostics, declared)
      walkExpr(expr.elseExpr, line, diagnostics, declared)
      break
    case 'ArrayLiteral':
      for (const el of expr.elements) walkExpr(el, line, diagnostics, declared)
      break
    case 'ArrayAccess':
      walkExpr(expr.array, line, diagnostics, declared)
      walkExpr(expr.index, line, diagnostics, declared)
      break
    case 'ObjectLiteral':
      for (const p of expr.properties) walkExpr(p.value, line, diagnostics, declared)
      break
    case 'FieldAccess':
      if (expr.object) walkExpr(expr.object, line, diagnostics, declared)
      break
    case 'MatchBlock':
      for (const arm of expr.arms) walkExpr(arm.value, line, diagnostics, declared)
      break
    // Leaf kinds (NumberLiteral / StringLiteral / ColorLiteral /
    // BoolLiteral / Identifier) have no child expressions.
  }
}

function validateCallee(
  callee: AST.Expr,
  line: number,
  diagnostics: Diagnostic[],
  declared: ReadonlySet<string>,
): void {
  // A non-identifier callee never reaches callBuiltin (the evaluator
  // returns null for it), so there is nothing to be unknown.
  if (callee.kind !== 'Identifier') return
  const name = callee.name
  if (BUILTIN_FN_NAMES.has(name) || NON_BUILTIN_CALLEES.has(name) || declared.has(name)) return

  const suggestion = nearestName(name)
  diagnostics.push({
    code: UNKNOWN_FUNCTION,
    severity: 'error',
    span: { line, col: 1 },
    message: `Unknown function \`${name}\`.`,
    help: suggestion
      ? `Did you mean \`${suggestion}\`?`
      : `\`${name}\` is not a built-in or a declared \`fn\`.`,
  })
}

/** Nearest known callee by Levenshtein distance, or null when the closest
 *  match is too far to be a plausible typo (a distant match is noise). */
function nearestName(name: string): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const cand of KNOWN_NAMES) {
    const d = levenshtein(name, cand)
    if (d < bestDist) {
      bestDist = d
      best = cand
    }
  }
  // Suggest only for small edits: ≤ 2 for names long enough that 2 edits
  // still share most characters, else ≤ 1. Keeps `sqrrt`→`sqrt` (1) while
  // dropping a wild `frobnicate` that happens to sit 2 away from a short
  // builtin.
  const threshold = name.length >= 4 ? 2 : 1
  return best !== null && bestDist <= threshold ? best : null
}

/** Classic two-row Levenshtein edit distance. */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1)
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[n]
}
