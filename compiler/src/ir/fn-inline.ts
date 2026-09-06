// ═══ User-fn inlining (#1535) ═══
// Rewrites every call to a user-declared `fn` into the fn's body with
// arguments substituted for parameters — at lower time, before anything
// evaluates or classifies an expression. The evaluator, the classifier,
// and the WGSL codegen therefore never see a user-fn call: a body built
// from GPU-safe builtins rides the per-feature-gpu path through the
// EXISTING classify/astToNode machinery unchanged, and Gate B (the
// shader-codegen SRP ratchet) is satisfied trivially — only AST is
// produced here, never shader text.
//
// v1 semantics (spec §2.10):
//   • bodies are expression-bodied (one `return <expr>`, parser-enforced);
//   • the call graph must be acyclic — self/mutual recursion is X-GIS0015;
//   • call arity must match the declaration — X-GIS0016 at the call site
//     (the call is left unrewritten so lowering stays total);
//   • a body's bare identifiers must be its params or `zoom`/`pitch` —
//     X-GIS0017 (feature data is explicit `.field`, never captured).

import type * as AST from '../parser/ast'
import type { Diagnostic } from '../diagnostics/diagnostic'
import { FN_RECURSION, FN_ARITY, FN_FREE_IDENTIFIER } from '../diagnostics/diagnostic'
import { substituteIdentifiers } from '../expr/substitute'
import { mapExprChildren, mapStatementExprs } from './walk-expr'

/**
 * Inline every user-fn call in `program`. Returns a NEW program (input
 * statements are never mutated); with no `fn` declarations the input is
 * returned as-is. Diagnostics are pushed onto the shared lower channel.
 */
export function inlineUserFns(program: AST.Program, diagnostics: Diagnostic[]): AST.Program {
  const fns = new Map<string, AST.FnStatement>()
  for (const s of program.body) {
    if (s.kind === 'FnStatement') fns.set(s.name, s)
  }
  if (fns.size === 0) return program

  for (const fn of fns.values()) validateBodyIdentifiers(fn, diagnostics)
  const cyclic = detectCycles(fns, diagnostics)

  // Memo of fully-inlined bodies (every nested user-fn call resolved).
  // Cyclic fns are excluded — their calls are left unrewritten.
  const resolved = new Map<string, AST.Expr>()
  const resolveBody = (name: string): AST.Expr | null => {
    if (cyclic.has(name)) return null
    const memo = resolved.get(name)
    if (memo) return memo
    const fn = fns.get(name)
    if (!fn) return null
    const body = rewrite(fn.body, fn.line)
    resolved.set(name, body)
    return body
  }

  /** Rewrite one expression: user-fn calls become substituted bodies. */
  const rewrite = (expr: AST.Expr, line: number): AST.Expr => {
    if (expr.kind === 'FnCall' && expr.callee.kind === 'Identifier' && fns.has(expr.callee.name)) {
      const name = expr.callee.name
      const fn = fns.get(name)!
      const args = expr.args.map((a) => rewrite(a, line))
      if (args.length !== fn.params.length) {
        diagnostics.push({
          code: FN_ARITY,
          severity: 'error',
          span: { line, col: 1 },
          message:
            `fn \`${name}\` expects ${fn.params.length} argument` +
            `${fn.params.length === 1 ? '' : 's'} (${fn.params.join(', ')}), ` +
            `but got ${args.length}.`,
          help: `Call it as \`${name}(${fn.params.join(', ')})\`.`,
        })
        return expr
      }
      const body = resolveBody(name)
      if (!body) return expr // cyclic — already reported
      const bindings = new Map<string, AST.Expr>()
      fn.params.forEach((p, i) => bindings.set(p, args[i]!))
      return substituteIdentifiers(body, bindings)
    }
    // Not a user-fn call: clone-with-recursion via the shared walker over
    // an empty binding map would NOT recurse into user-fn calls, so walk
    // children explicitly here.
    return mapExprChildren(expr, (child) => rewrite(child, line))
  }

  const body = program.body.map((s): AST.Statement => mapStatementExprs(s, rewrite))
  return { kind: 'Program', body }
}

/** X-GIS0017 — bare identifiers in a body must be params or camera refs.
 *  Callee-position identifiers are exempt (they name functions). */
function validateBodyIdentifiers(fn: AST.FnStatement, diagnostics: Diagnostic[]): void {
  // `zoom` / `pitch` are the camera identifiers the evaluator resolves
  // via the `$`-sigil reserved keys (eval/reserved-keys.ts).
  const allowed = new Set([...fn.params, 'zoom', 'pitch'])
  const walk = (expr: AST.Expr): void => {
    if (expr.kind === 'Identifier') {
      if (!allowed.has(expr.name)) {
        diagnostics.push({
          code: FN_FREE_IDENTIFIER,
          severity: 'error',
          span: { line: fn.line, col: 1 },
          message:
            `fn \`${fn.name}\`: bare identifier \`${expr.name}\` is not a parameter. ` +
            `Bodies may reference their params and \`zoom\`/\`pitch\` only.`,
          help: `Feature data must be explicit: use \`.${expr.name}\` (field access) or add \`${expr.name}\` to the parameter list.`,
        })
      }
      return
    }
    mapExprChildren(expr, (child) => {
      walk(child)
      return child
    })
  }
  walk(fn.body)
}

/** X-GIS0015 — DFS over the user-fn call graph; every fn on a cycle is
 *  reported once and returned so the inliner can skip it. */
function detectCycles(fns: Map<string, AST.FnStatement>, diagnostics: Diagnostic[]): Set<string> {
  const callees = new Map<string, string[]>()
  for (const fn of fns.values()) {
    const out: string[] = []
    const walk = (expr: AST.Expr): void => {
      if (
        expr.kind === 'FnCall' &&
        expr.callee.kind === 'Identifier' &&
        fns.has(expr.callee.name)
      ) {
        out.push(expr.callee.name)
      }
      mapExprChildren(expr, (child) => {
        walk(child)
        return child
      })
    }
    walk(fn.body)
    callees.set(fn.name, out)
  }

  const cyclic = new Set<string>()
  const visiting = new Set<string>()
  const done = new Set<string>()
  const dfs = (name: string, stack: string[]): void => {
    if (done.has(name)) return
    if (visiting.has(name)) {
      const start = stack.indexOf(name)
      for (const member of stack.slice(start)) cyclic.add(member)
      return
    }
    visiting.add(name)
    for (const next of callees.get(name) ?? []) dfs(next, [...stack, name])
    visiting.delete(name)
    done.add(name)
  }
  for (const name of fns.keys()) dfs(name, [])

  for (const name of cyclic) {
    const fn = fns.get(name)!
    diagnostics.push({
      code: FN_RECURSION,
      severity: 'error',
      span: { line: fn.line, col: 1 },
      message: `fn \`${name}\` is recursive (directly or mutually) — user-fn bodies must form an acyclic call graph.`,
      help: `Compile-time inlining cannot terminate on a cycle; restructure with \`?:\` / \`match\` instead of recursion.`,
    })
  }
  return cyclic
}
