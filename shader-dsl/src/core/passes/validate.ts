// ═══ Shader DSL — module validation (lint engine front-end) ═══
//
// A pre-emit static check over an AUTHORED ModuleDecl, run at the TOP of emitModule /
// emitGlslModule / compileModule (BEFORE lowerModule). It runs the lint ruleset
// (passes/lint/rules.ts) over the module and throws ValidationError on the first
// error-severity diagnostic, so a structurally-invalid module surfaces at authoring
// time instead of as opaque WGSL the driver later rejects.
//
// The rules live in the lint engine (a registry + a single-traversal dispatcher) so
// the ruleset scales: add a rule there, no change here. SCOPE: only rules that
// PROVABLY hold for every shader — incl. the runtime-composed variants — are wired as
// 'error' (dup-name, binding-collision, all-paths-return, mixed-scalar, single-exit).
// Name-resolution rules stay deferred: the compiler/composer inject consts/uniforms as
// raw WGSL referenced by plain name, so a name rule cannot tell an injected name from a
// typo (it once broke the polygon VT variant on `OPACITY` at runtime).

import type { ModuleDecl } from '../ir'
import { lint, type Diagnostic, type LintConfig } from './lint/engine'
import { RULES, CORE_RULES } from './lint/rules'
import { ShaderDslError, formatLoc } from '../diagnostics/error'

/** Render every error diagnostic on its own line — `[SD####] (fn X) message @ file:line:col`
 *  — so an aggregated validation failure shows ALL problems, not just the first. */
function formatValidationMessage(diags: readonly Diagnostic[]): string {
  const head = `shader-dsl [SD0020]: module validation failed (${diags.length} error${diags.length === 1 ? '' : 's'}):`
  const lines = diags.map((d) => {
    const code = d.code ? `[${d.code}] ` : ''
    const fn = d.fn ? ` (fn ${d.fn})` : ''
    const at = d.loc ? ` @ ${formatLoc(d.loc)}` : ''
    return `  - ${code}${d.ruleId}${fn}: ${d.message}${at}`
  })
  return [head, ...lines].join('\n')
}

export class ValidationError extends ShaderDslError {
  /** Every error-severity diagnostic that caused the failure (not just the first). */
  readonly diagnostics: readonly Diagnostic[]
  constructor(diags: readonly Diagnostic[]) {
    super({ code: 'SD0020', message: formatValidationMessage(diags) })
    this.name = 'ValidationError'
    this.diagnostics = diags
  }
}

/** Run the lint ruleset and return all diagnostics (errors + warnings). Does not
 *  throw — callers that want the full report (e.g. a static-analysis test) use this. */
export function lintModule(m: ModuleDecl, config?: LintConfig): Diagnostic[] {
  return lint(m, RULES, config)
}

/** Validate an authored module at EMIT time. Runs only CORE_RULES — the structural
 *  invariants that hold for EVERY module, including runtime-composed variants and compute
 *  kernels (e.g. eval_match) that legitimately early-return. Throws ValidationError on the
 *  first error. The opinionated rules (single-exit, etc.) are LINT-ONLY: the shader
 *  static-analysis tests gate the shader modules via lintModule(), so an emit-time gate
 *  never false-flags non-shader code (cf. the OPACITY / single-exit-on-eval_match regressions). */
export function validate(m: ModuleDecl): void {
  const errors = lint(m, CORE_RULES).filter((d) => d.severity === 'error')
  if (errors.length) throw new ValidationError(errors)
}
