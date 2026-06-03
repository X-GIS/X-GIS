<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# format

## Purpose
Value formatting and text-template parsing for label fields in the X-GIS style compiler. Implements the `{<expr>:<spec>;<locale>}` mini-language used inside `.xgis` label strings (e.g. `"Lat: {lat:.4f}°N"`): `template-parser.ts` splits a raw string into literal/interpolation parts, `spec-parser.ts` decodes the format spec into a `FormatSpec` struct, and four typed formatters cover numbers, dates, and GIS-specific coordinate representations. `formatValue()` in `index.ts` is the single public dispatch point consumed by the template evaluator and IR lowering pass.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Barrel + `formatValue(value, spec)` dispatch — routes to the correct per-type formatter based on `spec.type`; coerces unknowns to number or `[lon,lat]` tuple; re-exports all parsers and formatters. |
| `spec-parser.ts` | Parses the spec portion of `{expr:spec;locale}` into a `FormatSpec`. Handles Python-format subset (`[fill][align][sign][#][0][width][grouping][.precision][type]`), strftime fast-path (leading `%`), GIS-type fast-path (`dms`/`dm`/`mgrs`/`utm`/`bearing`), and `;<locale>` BCP-47 tail. Exports `GIS_TYPES` set. |
| `template-parser.ts` | Splits a template string into `TemplatePart[]` (literal + interp). Tracks brace depth so nested `{}` in `match` expressions don't terminate early; recognises `:` as spec separator only at depth 0. `isBareExpressionTemplate` detects single bare-interp templates for IR short-circuit. |
| `number-formatter.ts` | Number formatting with two paths: locale `'C'` → deterministic ASCII (`toFixed`/`toPrecision`/manual grouping), other locale → `Intl.NumberFormat`. Exports `formatNumber`, `formatString`, `padOrTruncate`, and `applyGrouping`. Covers types `d f e E g G % n s`. |
| `datetime-formatter.ts` | Formats `Date`, ISO 8601 string, or Unix epoch (ms auto-detected by `> 1e12`). `'C'`/undefined locale → UTC-based deterministic ASCII; other locale → `Intl.DateTimeFormat`. Supports `%Y %y %m %d %H %M %S %j %s %a %A %b %B %p %Z %z %%`. |
| `gis-formatter.ts` | GIS coordinate formatters: `formatDMS` (degrees-minutes-seconds with optional N/S/E/W axis suffix), `formatDM` (degrees-decimal-minutes), `formatBearing` (zero-padded 3-digit `°`), and stub placeholders for `formatMGRS` / `formatUTM` (return `[MGRS pending impl]` / `[UTM pending impl]` — full WGS84 grid algorithm deferred to Batch 1c-2b). |

## For AI Agents

### Working In This Directory
- The `{expr:spec;locale}` shape is a cross-cutting contract: `template-parser.ts` produces it, `spec-parser.ts` decodes it, `eval/` resolves the expression, and `formatValue` renders it. Changing the shape requires updating all three layers simultaneously.
- `formatValue` is the only public dispatch — extend by adding a new `FormatSpec.type` variant and a matching formatter function; do not add alternative entry points.
- `formatMGRS` and `formatUTM` are intentional stubs. Do not remove the stub signatures; their type-correct presence allows the converter and IR pipeline to wire `mgrs`/`utm` specs without runtime failures while the full grid algorithm is pending.
- `spec-parser.ts` throws on invalid input; callers (template-parser, converter) are responsible for catching and surfacing warnings. Do not silently swallow errors inside the parser.
- The `'C'` locale is the regression-test target — `Intl` output drifts across browser CLDR versions. Any new formatter with a numeric or date path must implement a `'C'`-locale deterministic branch.

### Testing Requirements
Tests live in `compiler/src/__tests__/`, not co-located: `format-spec-parser.test.ts`, `format-template-parser.test.ts`, `format-dispatch.test.ts`, `format-expression-coverage.test.ts`, `string-format-builtins.test.ts`, `label-template.test.ts`. Run with `vitest` from the `compiler/` package root.

### Common Patterns
- Source files carry `// Batch 1c-2` / `// Batch 1c-3a` banner comments marking compiler batch provenance — preserve on edits.
- All formatter functions are pure `(value, spec) → string`; no side effects, no module-level state.
- Locale-aware paths fall back to a spec-driven ASCII path when `spec.locale` is `'C'` or `undefined`.

## Dependencies

### Internal
- Imports `FormatSpec` type from `../ir/render-node`.
- `template-parser.ts` imports `parseFormatSpec` from `./spec-parser`.
- Consumed by `ir/lower` (template wiring), `convert/` (label compilation), and re-exported from the package root `index.ts`.

### External
- None — uses only built-in `Intl.NumberFormat`, `Intl.DateTimeFormat`, and standard `Date` APIs.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
