// ═══ Shader DSL — unified diagnostics report ═══
//
// `diagnose(m, opts?)` is the single "what's wrong with this module?" entry: it runs the
// lint ruleset and (optionally) a NON-throwing capability check against a backend, then
// returns one structured report. Unlike `validate()` (which throws on the first emit-time
// gate) and `assertCaps()` (which throws on the first missing cap), `diagnose()` collects
// everything so an author sees lint + capability problems together. `formatReport()` renders
// it as an ESLint/Rust-style block — code, severity, fn, file:line:col (when traced), hint.
//
// It composes the existing infra (lint / summarize / requiredCaps) — no re-implementation,
// and it runs over the AUTHORED module (before lowering), so reported `loc`s resolve.

import type { ModuleDecl } from '../ir'
import type { Backend } from '../backend'
import {
  lint,
  summarize,
  type Diagnostic,
  type LintSummary,
  type LintConfig,
} from '../passes/lint/engine'
import { RULES, CORE_RULES } from '../passes/lint/rules'
import { requiredCaps } from '../passes/required-caps'
import { formatLoc } from './error'

export interface DiagnoseOptions {
  /** Which ruleset to run — 'all' (full RULES, default) or 'core' (emit-time CORE_RULES). */
  readonly rules?: 'core' | 'all'
  /** When given, also report any capability the backend cannot cover (non-throwing). */
  readonly backend?: Backend
  /** Per-rule severity / options overrides, forwarded to the lint engine. */
  readonly config?: LintConfig
}

export interface DiagnosticReport {
  readonly diagnostics: readonly Diagnostic[]
  readonly summary: LintSummary
}

/** Run the lint ruleset (+ optional backend capability check) over an authored module and
 *  collect every diagnostic into one report. Never throws. */
export function diagnose(m: ModuleDecl, opts?: DiagnoseOptions): DiagnosticReport {
  const rules = opts?.rules === 'core' ? CORE_RULES : RULES
  const diagnostics: Diagnostic[] = [...lint(m, rules, opts?.config)]

  if (opts?.backend) {
    const req = requiredCaps(m)
    if (!opts.backend.caps.covers(req)) {
      const missing = opts.backend.caps.missing(req)
      diagnostics.push({
        ruleId: 'unsupported-capability',
        severity: 'error',
        code: 'SD0030',
        message: `backend '${opts.backend.id}' cannot emit this module — missing capabilities: ${missing.join(', ')}`,
      })
    }
  }

  return { diagnostics, summary: summarize(diagnostics) }
}

const SEVERITY_ORDER = { error: 0, warning: 1 } as const

/** Render a DiagnosticReport as a human-readable, severity-sorted block report. */
export function formatReport(report: DiagnosticReport): string {
  const { diagnostics, summary } = report
  if (diagnostics.length === 0) return 'no diagnostics'

  const blocks = [...diagnostics]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .map((d) => {
      const code = d.code ? `[${d.code}]` : ''
      const fn = d.fn ? `  (fn ${d.fn})` : ''
      const lines = [`${d.severity}${code} ${d.ruleId}${fn}`]
      if (d.loc) lines.push(`  --> ${formatLoc(d.loc)}`)
      lines.push(`  ${d.message}`)
      if (d.hint) lines.push(`  hint: ${d.hint}`)
      return lines.join('\n')
    })

  const footer = `${summary.errors} error${summary.errors === 1 ? '' : 's'}, ${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}`
  return [...blocks, footer].join('\n\n')
}
