// ═══════════════════════════════════════════════════════════════════
// Format PARSE barrel (compile-time half)
// ═══════════════════════════════════════════════════════════════════
//
// The compiler owns the COMPILE-TIME half of the text-format pipeline:
// parsing a `{<expr>:<spec>;<locale>}` template into IR (a `TextPart`
// carrying a `FormatSpec`). `spec-parser.ts` decodes the spec string;
// `template-parser.ts` splits the raw template into literal/interp
// parts. Both are consumed by `ir/lower` at compile time.
//
// The RUNTIME half — applying a `FormatSpec` to a per-feature value to
// produce the display string (`formatValue` + the number/date/GIS
// formatters) — RELOCATED to @xgis/map in #1001 (map/src/text/
// format-value.ts + map/src/text/formatters/), co-located with the sole
// consumer (text-resolver.ts). The style compiler stays content-blind:
// it emits the FormatSpec, it does not know how to render coordinates.

export { parseFormatSpec, GIS_TYPES } from './spec-parser'
export { parseTextTemplate, isBareExpressionTemplate } from './template-parser'
export type { TemplatePart, TemplateLiteral, TemplateInterp } from './template-parser'
