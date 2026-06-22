// ═══ Shader DSL — lint rule engine ═══
//
// A scalable static-analysis framework: rules are self-contained units registered
// in a list, and the engine runs them all in ONE traversal of the module. Each rule
// declares handlers for the node kinds it cares about (Module / Func / Stmt / Expr);
// the engine walks the IR ONCE and dispatches every node to the interested rules.
// Cost is O(nodes × rules-that-handle-that-node), not O(nodes × all-rules) — so the
// framework holds up as the ruleset grows to hundreds. Adding a rule is O(1): write a
// LintRule, push it into the registry (rules.ts).

import type { ModuleDecl, FuncDecl, Stmt, Expr } from '../../ir'

export type Severity = 'error' | 'warning' | 'off'

export interface Diagnostic {
  readonly ruleId: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly fn?: string
}

/** What a rule is handed: the module under analysis, a `report` bound to this rule,
 *  and this rule's options (from LintConfig.options[ruleId]) — e.g. a threshold. */
export interface RuleContext {
  readonly module: ModuleDecl
  readonly options?: Readonly<Record<string, unknown>>
  report(message: string, opts?: { fn?: string }): void
}

/** A rule's per-node handlers. Implement only the kinds you care about; the engine
 *  calls them during the single shared traversal. */
export interface RuleVisitor {
  Module?(m: ModuleDecl): void
  Func?(f: FuncDecl): void
  Stmt?(s: Stmt, fn: FuncDecl): void
  Expr?(e: Expr, fn: FuncDecl): void
}

export type RuleCategory = 'correctness' | 'style' | 'perf'

export interface LintRule {
  readonly id: string
  readonly description: string
  /** Default severity; overridable per-run via LintConfig. */
  readonly severity: 'error' | 'warning'
  /** Grouping for presets / reporting (default 'correctness'). */
  readonly category?: RuleCategory
  create(ctx: RuleContext): RuleVisitor
}

export interface LintConfig {
  /** Per-rule severity override (e.g. demote a rule to 'warning' or 'off'). */
  readonly severity?: Readonly<Record<string, Severity>>
  /** Per-rule options, keyed by rule id (e.g. `{ 'param-count': { max: 8 } }`). */
  readonly options?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

// ── Single-pass IR traversal (depth-first; statements then their sub-expressions) ──

function walkExpr(e: Expr, onExpr: (e: Expr) => void): void {
  onExpr(e)
  switch (e.op) {
    case 'binop':
    case 'compare':
    case 'logical':
      walkExpr(e.a, onExpr); walkExpr(e.b, onExpr); break
    case 'unop':
      walkExpr(e.a, onExpr); break
    case 'call':
    case 'construct':
      for (const a of e.args) walkExpr(a, onExpr); break
    case 'member':
      walkExpr(e.base, onExpr); break
    case 'index':
      walkExpr(e.base, onExpr); walkExpr(e.idx, onExpr); break
    case 'select':
      walkExpr(e.cond, onExpr); walkExpr(e.ifTrue, onExpr); walkExpr(e.ifFalse, onExpr); break
    case 'matchExpr':
      walkExpr(e.scrutinee, onExpr)
      for (const [, v] of e.cases) walkExpr(v, onExpr)
      walkExpr(e.default, onExpr); break
    default:
      break // lit / constref / param / varref — leaves
  }
}

function walkStmt(s: Stmt, onStmt: (s: Stmt) => void, onExpr: (e: Expr) => void): void {
  onStmt(s)
  switch (s.s) {
    case 'let': walkExpr(s.expr, onExpr); break
    case 'var': if (s.init) walkExpr(s.init, onExpr); break
    case 'assign':
    case 'assignOp':
      walkExpr(s.target, onExpr); walkExpr(s.expr, onExpr); break
    case 'return': if (s.expr) walkExpr(s.expr, onExpr); break
    case 'if':
      for (const arm of s.arms) { walkExpr(arm.cond, onExpr); for (const b of arm.body) walkStmt(b, onStmt, onExpr) }
      if (s.elseBody) for (const b of s.elseBody) walkStmt(b, onStmt, onExpr)
      break
    case 'for':
      walkStmt(s.init, onStmt, onExpr); walkExpr(s.cond, onExpr); walkStmt(s.update, onStmt, onExpr)
      for (const b of s.body) walkStmt(b, onStmt, onExpr)
      break
    case 'switch':
      walkExpr(s.scrut, onExpr)
      for (const c of s.cases) for (const b of c.body) walkStmt(b, onStmt, onExpr)
      if (s.defaultBody) for (const b of s.defaultBody) walkStmt(b, onStmt, onExpr)
      break
    default:
      break // break / continue / discard / raw / placeholder — leaves
  }
}

/** Run every rule over the module in ONE traversal; collect diagnostics. Rules set
 *  to 'off' are skipped. Order: module-level checks, then per-function (Func handlers,
 *  then a single Stmt/Expr walk) in declaration order — so diagnostics are stable. */
export function lint(m: ModuleDecl, rules: readonly LintRule[], config?: LintConfig): Diagnostic[] {
  const diags: Diagnostic[] = []
  const active = rules.flatMap((r) => {
    const sev = config?.severity?.[r.id] ?? r.severity
    if (sev === 'off') return []
    const ctx: RuleContext = {
      module: m,
      options: config?.options?.[r.id],
      report: (message, opts) => diags.push({ ruleId: r.id, severity: sev, message, fn: opts?.fn }),
    }
    return [r.create(ctx)]
  })

  for (const v of active) v.Module?.(m)

  const needsBodyWalk = active.some((v) => v.Stmt || v.Expr)
  for (const f of m.funcs) {
    for (const v of active) v.Func?.(f)
    if (needsBodyWalk) {
      for (const s of f.body) {
        walkStmt(
          s,
          (st) => { for (const v of active) v.Stmt?.(st, f) },
          (ex) => { for (const v of active) v.Expr?.(ex, f) },
        )
      }
    }
  }

  // Documented deviations — drop diagnostics a fn opts out of via `lintDisable`.
  const byName = new Map(m.funcs.map((f) => [f.name, f]))
  return diags.filter((d) => !(d.fn && byName.get(d.fn)?.lintDisable?.includes(d.ruleId)))
}
