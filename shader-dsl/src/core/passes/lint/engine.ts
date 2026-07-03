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
import type { SourceLoc } from '../../diagnostics/error'
import { getLoc } from '../../diagnostics/loc'

export type Severity = 'error' | 'warning' | 'off'

export interface Diagnostic {
  readonly ruleId: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly fn?: string
  /** Optional stable diagnostic code (SD####), for tooling / doc links. */
  readonly code?: string
  /** Optional authored-source location, resolved from the reported node when
   *  source tracing was on at author time (see core/diagnostics/loc.ts). */
  readonly loc?: SourceLoc
  /** Optional one-line "how to fix it". */
  readonly hint?: string
}

/** What a rule is handed: the module under analysis, a `report` bound to this rule,
 *  and this rule's options (from LintConfig.options[ruleId]) — e.g. a threshold. */
export interface RuleContext {
  readonly module: ModuleDecl
  readonly options?: Readonly<Record<string, unknown>>
  /** Report a diagnostic. `node` (the offending Stmt/Expr/FuncDecl) lets the engine
   *  resolve a source `loc` via the authored-location side-table; `code`/`hint` enrich
   *  the diagnostic for `diagnose()`/`formatReport`. All optional — existing rules that
   *  pass only `{ fn }` (or nothing) are unaffected. */
  report(message: string, opts?: { fn?: string; node?: object; code?: string; hint?: string }): void
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
  /** Optional auto-fix: return a corrected module, or null if there is nothing to fix.
   *  Fixes change the emitted WGSL, so a caller applies them deliberately + re-verifies. */
  fix?(m: ModuleDecl): ModuleDecl | null
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
      walkExpr(e.a, onExpr)
      walkExpr(e.b, onExpr)
      break
    case 'unop':
      walkExpr(e.a, onExpr)
      break
    case 'call':
    case 'construct':
      for (const a of e.args) walkExpr(a, onExpr)
      break
    case 'member':
      walkExpr(e.base, onExpr)
      break
    case 'index':
      walkExpr(e.base, onExpr)
      walkExpr(e.idx, onExpr)
      break
    case 'select':
      walkExpr(e.cond, onExpr)
      walkExpr(e.ifTrue, onExpr)
      walkExpr(e.ifFalse, onExpr)
      break
    case 'matchExpr':
      walkExpr(e.scrutinee, onExpr)
      for (const [, v] of e.cases) walkExpr(v, onExpr)
      walkExpr(e.default, onExpr)
      break
    default:
      break // lit / constref / param / varref — leaves
  }
}

function walkStmt(s: Stmt, onStmt: (s: Stmt) => void, onExpr: (e: Expr) => void): void {
  onStmt(s)
  switch (s.s) {
    case 'let':
      walkExpr(s.expr, onExpr)
      break
    case 'var':
      if (s.init) walkExpr(s.init, onExpr)
      break
    case 'assign':
    case 'assignOp':
      walkExpr(s.target, onExpr)
      walkExpr(s.expr, onExpr)
      break
    case 'return':
      if (s.expr) walkExpr(s.expr, onExpr)
      break
    case 'if':
      for (const arm of s.arms) {
        walkExpr(arm.cond, onExpr)
        for (const b of arm.body) walkStmt(b, onStmt, onExpr)
      }
      if (s.elseBody) for (const b of s.elseBody) walkStmt(b, onStmt, onExpr)
      break
    case 'for':
      walkStmt(s.init, onStmt, onExpr)
      walkExpr(s.cond, onExpr)
      walkStmt(s.update, onStmt, onExpr)
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

/** Run every rule over the module in ONE traversal; collect RAW diagnostics (before
 *  per-fn lintDisable suppression). Order: module-level checks, then per-function (Func
 *  handlers, then a single Stmt/Expr walk) in declaration order — diagnostics are stable. */
function lintRaw(m: ModuleDecl, rules: readonly LintRule[], config?: LintConfig): Diagnostic[] {
  const diags: Diagnostic[] = []
  const active = rules.flatMap((r) => {
    const sev = config?.severity?.[r.id] ?? r.severity
    if (sev === 'off') return []
    const ctx: RuleContext = {
      module: m,
      options: config?.options?.[r.id],
      report: (message, opts) =>
        diags.push({
          ruleId: r.id,
          severity: sev,
          message,
          fn: opts?.fn,
          code: opts?.code,
          hint: opts?.hint,
          loc: opts?.node ? getLoc(opts.node) : undefined,
        }),
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
          (st) => {
            for (const v of active) v.Stmt?.(st, f)
          },
          (ex) => {
            for (const v of active) v.Expr?.(ex, f)
          },
        )
      }
    }
  }

  return diags
}

const suppressed = (m: ModuleDecl, d: Diagnostic): boolean => {
  if (!d.fn) return false
  return m.funcs.find((fn) => fn.name === d.fn)?.lintDisable?.includes(d.ruleId) ?? false
}

/** Run the ruleset and drop diagnostics a fn opts out of via `lintDisable`. */
export function lint(m: ModuleDecl, rules: readonly LintRule[], config?: LintConfig): Diagnostic[] {
  return lintRaw(m, rules, config).filter((d) => !suppressed(m, d))
}

export interface LintSummary {
  readonly total: number
  readonly errors: number
  readonly warnings: number
  readonly byRule: Readonly<Record<string, number>>
}

/** Counts by severity + by rule — a structured report for CI / dashboards. */
export function summarize(diags: readonly Diagnostic[]): LintSummary {
  const byRule: Record<string, number> = {}
  let errors = 0
  let warnings = 0
  for (const d of diags) {
    byRule[d.ruleId] = (byRule[d.ruleId] ?? 0) + 1
    if (d.severity === 'error') errors += 1
    else warnings += 1
  }
  return { total: diags.length, errors, warnings, byRule }
}

/** Flag `lintDisable` entries that never suppressed anything — a stale deviation to
 *  remove (cf. ESLint reportUnusedDisableDirectives). Keeps documented deviations honest. */
export function unusedDeviations(
  m: ModuleDecl,
  rules: readonly LintRule[],
  config?: LintConfig,
): Diagnostic[] {
  const fired = new Set(
    lintRaw(m, rules, config)
      .filter((d) => d.fn)
      .map((d) => `${d.fn} ${d.ruleId}`),
  )
  const out: Diagnostic[] = []
  for (const f of m.funcs) {
    for (const id of f.lintDisable ?? []) {
      if (!fired.has(`${f.name} ${id}`)) {
        out.push({
          ruleId: 'unused-lint-disable',
          severity: 'warning',
          message: `fn '${f.name}' disables '${id}' but it never fires — remove the deviation`,
          fn: f.name,
        })
      }
    }
  }
  return out
}

/** Human-readable one-line-per-diagnostic report (errors first). */
export function formatDiagnostics(diags: readonly Diagnostic[]): string {
  if (diags.length === 0) return 'no lint diagnostics'
  const order = { error: 0, warning: 1 } as const
  return [...diags]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .map((d) => `[${d.severity}] ${d.ruleId}${d.fn ? ` (fn ${d.fn})` : ''}: ${d.message}`)
    .join('\n')
}

/** Statement mapper for auto-fix rules — applies `f` to every statement (recursing into
 *  if / for / switch blocks); `f` returns a replacement Stmt or null to delete it. */
export function mapStmts(body: readonly Stmt[], f: (s: Stmt) => Stmt | null): Stmt[] {
  const out: Stmt[] = []
  for (const s of body) {
    const mapped = f(s)
    if (mapped === null) continue
    let cur = mapped
    if (cur.s === 'if') {
      cur = {
        ...cur,
        arms: cur.arms.map((a) => ({ cond: a.cond, body: mapStmts(a.body, f) })),
        elseBody: cur.elseBody ? mapStmts(cur.elseBody, f) : undefined,
      }
    } else if (cur.s === 'for') {
      cur = { ...cur, body: mapStmts(cur.body, f) }
    } else if (cur.s === 'switch') {
      cur = {
        ...cur,
        cases: cur.cases.map((c) => ({ value: c.value, body: mapStmts(c.body, f) })),
        defaultBody: cur.defaultBody ? mapStmts(cur.defaultBody, f) : undefined,
      }
    }
    out.push(cur)
  }
  return out
}

/** Apply every fixable rule's auto-fix, folding the module through each. Returns the
 *  fixed module + the ids of rules that changed something. Fixes alter the emitted WGSL,
 *  so the caller re-verifies (golden / GPU). */
export function applyFixes(
  m: ModuleDecl,
  rules: readonly LintRule[],
): { module: ModuleDecl; applied: string[] } {
  let cur = m
  const applied: string[] = []
  for (const r of rules) {
    if (!r.fix) continue
    const next = r.fix(cur)
    if (next) {
      cur = next
      applied.push(r.id)
    }
  }
  return { module: cur, applied }
}
