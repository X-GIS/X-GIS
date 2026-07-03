// Shader DSL lint engine — public surface.
export {
  lint,
  formatDiagnostics,
  summarize,
  unusedDeviations,
  applyFixes,
  mapStmts,
  type LintRule,
  type RuleContext,
  type RuleVisitor,
  type Diagnostic,
  type Severity,
  type RuleCategory,
  type LintConfig,
  type LintSummary,
} from './engine'
export { RULES } from './rules'
export { STRICT, LENIENT } from './presets'
