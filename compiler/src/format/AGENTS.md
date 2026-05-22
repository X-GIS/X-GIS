<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# format

## Purpose
Value formatting + text-template parsing for label fields. Resolves the `{<expr>:<spec>;<locale>}` mini-language used inside label strings (e.g. `"Lat: {lat:.4f}°N"`): a template parser splits literals from interpolations, a spec parser parses the format spec, and per-type formatters render numbers, dates, and GIS-specific values (DMS/DM coordinates, bearings). `formatValue()` is the single dispatch entry; the IR lowering pass re-parses the embedded expression source via `parser/parseExpressionString`.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Barrel + `formatValue(value, spec)` dispatch — routes to the right per-type formatter based on the parsed spec. Re-exports the parsers + formatters. |
| `spec-parser.ts` | Parses the spec portion of `{<expr>:<spec>;<locale>}` into a structured `FormatSpec`. |
| `template-parser.ts` | Splits a text-template string into a flat `TextPart[]` (literal + expression sections); `isBareExpressionTemplate` detects single-expr templates. |
| `number-formatter.ts` | Number formatting (two paths: spec-driven + locale `Intl.NumberFormat`). |
| `datetime-formatter.ts` | Date formatting accepting `Date`, ISO 8601 string, or Unix epoch (ms/s). |
| `gis-formatter.ts` | GIS-specific formats: `formatDMS`, `formatDM`, `formatBearing` (degrees-minutes-seconds, bearing). |

## For AI Agents

### Working In This Directory
- The template grammar is shared with `parser/`: interpolation expression sources are re-parsed by `parseExpressionString`, then evaluated by `eval/evaluate`, then formatted here. Keep the `{expr:spec;locale}` shape stable across all three.
- `formatValue` is the only public dispatch — add new format types behind it (a new `FormatSpec` kind + formatter), not as separate entry points.

### Testing Requirements
- `src/__tests__/format-spec-parser.test.ts`, `format-template-parser.test.ts`, `format-dispatch.test.ts`, `format-expression-coverage.test.ts`, `string-format-builtins.test.ts`, `label-template.test.ts`. No colocated tests in this dir.

### Common Patterns
- Banner comments tag "Batch 1c-2/1c-3a". Formatters are pure `(value, spec) → string`; locale-aware paths fall back to a spec-driven path.

## Dependencies

### Internal
- Imports `parser/` (expression re-parse) + `eval/`; consumed by `ir/lower`, `convert/`, and re-exported from `index.ts`.

### External
- None (uses built-in `Intl`).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
