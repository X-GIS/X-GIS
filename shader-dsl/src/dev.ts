// ═══ @xgis/shader-dsl/dev — development / analysis tooling surface ═══
//
// Everything here is DEV-TIME machinery: linting, diagnostics reports, optimizer
// measurement, source tracing, and pipeline-introspection helpers. None of it is
// needed to AUTHOR or EMIT a shader (that is the main barrel), and none of it has
// production consumers — keeping it off the main entry keeps the authoring surface
// honest about what a shader author actually needs (#740 R2b).
//
// Import as `@xgis/shader-dsl/dev`.

// Lint engine front-ends + result formatters. (validate()/ValidationError — the
// EMIT-time gate — stay on the main barrel; this is the opt-in analysis surface.
// The `Diagnostic` result type also stays on the main barrel: ValidationError
// exposes `.diagnostics` there.)
export { lintModule } from './core/passes/validate'
export {
  summarize,
  formatDiagnostics,
  type LintSummary,
  type Severity,
  type LintConfig,
} from './core/passes/lint/engine'
export { checkSingleExit } from './core/passes/single-exit'
export { requiredCaps, assertCaps } from './core/passes/required-caps'

// Unified diagnose()/formatReport() report + the error-code catalogue + coded-error
// authoring helpers. (ShaderDslError itself stays on the main barrel — it is the
// public base class of ValidationError.)
export {
  diagnose,
  formatReport,
  type DiagnoseOptions,
  type DiagnosticReport,
} from './core/diagnostics/report'
export { CODES, type ErrorCode, type ErrorCodeDef } from './core/diagnostics/codes'
export { dslError, formatLoc, type SourceLoc } from './core/diagnostics/error'

// Opt-in authored-source tracing (off by default, never on the emit path).
export { setSourceTracing, isSourceTracing } from './core/diagnostics/loc'

// Optimizer measurement (A/B the optimizer on op-count + source size).
export {
  emitSize,
  countOps,
  optimizerReport,
  type EmitSize,
  type OpCount,
  type OptimizerReport,
} from './core/measure'

// Optimizer pass surface for A/B and pass-level tests (#763 D3 — the former
// `core/passes/opt/index` deep-path consumers; the `./core/*` wildcard subpath
// that reached it bypassed the main//dev split and enabled partial-graph loads).
export { optimize, fixpoint, DEFAULT_PASSES, constFold } from './core/passes/opt/index'

// Pipeline introspection siblings of emitModule (byte-identical `.code`).
export { lowerForBackend, emitModuleWithReflection } from './core/emit'
