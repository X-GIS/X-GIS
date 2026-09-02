import type { Stmt, FuncDecl } from '../../../ir/index.js'
import type { LintRule } from '../engine.js'

// Every DECLARATION site inside a body, nested scopes and `for` inits included. Only
// `let` / `var` bind a name; every other statement is walked for the bodies it carries.
function eachDecl(s: Stmt, onDecl: (name: string, s: Stmt) => void): void {
  switch (s.s) {
    case 'let':
    case 'var':
      onDecl(s.name, s)
      break
    case 'if':
      for (const arm of s.arms) for (const b of arm.body) eachDecl(b, onDecl)
      if (s.elseBody) for (const b of s.elseBody) eachDecl(b, onDecl)
      break
    case 'for':
      eachDecl(s.init, onDecl)
      eachDecl(s.update, onDecl)
      for (const b of s.body) eachDecl(b, onDecl)
      break
    case 'switch':
      for (const c of s.cases) for (const b of c.body) eachDecl(b, onDecl)
      if (s.defaultBody) for (const b of s.defaultBody) eachDecl(b, onDecl)
      break
    default:
      break // assign / assignOp / return / break / continue / discard / raw / placeholder
  }
}

/** Every name `f` declares more than once, in first-offending order, paired with the
 *  redeclaring statement (params count as the first declaration of their name).
 *
 *  Exported for the `fixpoint` premise assert (passes/opt/optimize.ts), which checks the
 *  same invariant on the POST-LOWERING module the optimizer actually sees. */
export function duplicateLocalNames(f: FuncDecl): Array<{ name: string; node: Stmt }> {
  const seen = new Set<string>(f.params.map((p) => p.name))
  const dups: Array<{ name: string; node: Stmt }> = []
  for (const s of f.body) {
    eachDecl(s, (name, node) => {
      if (seen.has(name)) dups.push({ name, node })
      else seen.add(name)
    })
  }
  return dups
}

/** No duplicate local name within one function — the premise five optimizer passes rest on.
 *
 *  The IR identifies a binding by its NAME ALONE: there is no scope id, and `const-prop`,
 *  `copy-prop`, `dead-branch`, `member-fold` and `inline-linear` each key a FUNCTION-WIDE flat
 *  map on it ("binding names are unique per fn" — const-prop.ts:10, copy-prop.ts:11,
 *  dead-branch.ts:12, member-fold.ts:129, inline-linear.ts:406). The builder guarantees that
 *  only for the names it AUTO-generates (`_v0`, `_v1`, … — builder.ts:133-139); an
 *  author-supplied name is taken verbatim, so two `b.let('t', …)` in one function collapse
 *  into one entry and the passes move a value across a scope boundary it may not cross.
 *
 *  "Shadowed" is meant in that flat-map sense, so this fires on all three shapes — a nested
 *  redeclaration, a redeclaration in a SIBLING block (which shadows nothing lexically yet
 *  collides in the map just the same), and a local that reuses a parameter's name. */
export const noShadowedLocal: LintRule = {
  id: 'no-shadowed-local',
  description:
    'a local name declared twice in one function (nested, sibling-scope or over a param) — the optimizer keys its flat per-function maps on names alone',
  severity: 'error',
  category: 'correctness',
  create: (ctx) => ({
    Func(f) {
      for (const { name, node } of duplicateLocalNames(f)) {
        ctx.report(
          `'${name}' is declared more than once in fn '${f.name}' — the optimizer's per-function maps are keyed on the name alone, so the two bindings collapse into one`,
          { fn: f.name, node, code: 'SD0112' },
        )
      }
    },
  }),
}
