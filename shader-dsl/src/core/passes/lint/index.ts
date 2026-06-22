// Shader DSL lint engine — public surface.
export {
  lint, formatDiagnostics,
  type LintRule, type RuleContext, type RuleVisitor, type Diagnostic, type Severity, type RuleCategory, type LintConfig,
} from './engine'
export { RULES } from './rules'
export { STRICT, LENIENT } from './presets'
