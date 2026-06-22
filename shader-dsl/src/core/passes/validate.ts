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
import { RULES } from './lint/rules'

export class ValidationError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ValidationError' }
}

/** Run the lint ruleset and return all diagnostics (errors + warnings). Does not
 *  throw — callers that want the full report (e.g. a static-analysis test) use this. */
export function lintModule(m: ModuleDecl, config?: LintConfig): Diagnostic[] {
  return lint(m, RULES, config)
}

/** Validate an authored module. Throws ValidationError on the first error-severity
 *  diagnostic; returns silently otherwise (and never mutates — emit stays byte-identical). */
export function validate(m: ModuleDecl): void {
  const err = lint(m, RULES).find((d) => d.severity === 'error')
  if (err) throw new ValidationError(err.message)
}
