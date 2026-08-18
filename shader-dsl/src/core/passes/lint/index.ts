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
} from './engine.js'
export { RULES } from './rules/index.js'
export { STRICT, LENIENT } from './presets.js'
