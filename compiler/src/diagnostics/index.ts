export {
  getStyleProfile,
  formatStyleProfile,
  type StyleProfile,
  type DepHistogramRow,
  type CSESummary,
  type ComputePlanSummary,
  type PaletteSummary,
  type MatchArmBand,
} from './style-profile'

// The unified spanned diagnostics channel (#1065) — the single authority
// for the `Diagnostic` shape shared by lexer/parser/lower/converter.
export {
  type Diagnostic,
  type Span,
  type Severity,
  PARSER_SYNTAX_ERROR,
  CONVERTER_WARNING,
  warningDiagnostic,
  diagnosticMessages,
  ParseError,
  DiagnosticCollector,
} from './diagnostic'
