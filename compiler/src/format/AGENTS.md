<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-07-12 -->

# format

## Purpose

Compile-time PARSE half of the text-format pipeline for label fields in the X-GIS style compiler. Implements the parse side of the `{<expr>:<spec>;<locale>}` mini-language used inside `.xgis` label strings (e.g. `"Lat: {lat:.4f}°N"`): `template-parser.ts` splits a raw string into literal/interpolation parts, and `spec-parser.ts` decodes the format spec into a `FormatSpec` struct (the IR type defined in `../ir/render-node`). Both are consumed by `ir/lower` at compile time to build the `TextPart` IR.

The RUNTIME APPLY half — `formatValue()` plus the number/date/GIS formatters that turn a `FormatSpec` + a per-feature value into the display string — relocated to `@xgis/map` in #1001 (`map/src/text/format-value.ts` + `map/src/text/formatters/`), co-located with its sole consumer, `text-resolver.ts`. The style compiler stays content-blind: it EMITS the `FormatSpec`, it does not know how to render coordinates.

## Key Files

| File                 | Description                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`           | Parse barrel — re-exports `parseFormatSpec` / `GIS_TYPES` (spec-parser) and `parseTextTemplate` / `isBareExpressionTemplate` / the `TemplatePart` types (template-parser). No value-apply dispatch (that is `@xgis/map`).                                                                                           |
| `spec-parser.ts`     | Parses the spec portion of `{expr:spec;locale}` into a `FormatSpec`. Handles Python-format subset (`[fill][align][sign][#][0][width][grouping][.precision][type]`), strftime fast-path (leading `%`), GIS-type fast-path (`dms`/`dm`/`mgrs`/`utm`/`bearing`), and `;<locale>` BCP-47 tail. Exports `GIS_TYPES` set. |
| `template-parser.ts` | Splits a template string into `TemplatePart[]` (literal + interp). Tracks brace depth so nested `{}` in `match` expressions don't terminate early; recognises `:` as spec separator only at depth 0. `isBareExpressionTemplate` detects single bare-interp templates for IR short-circuit.                          |

## For AI Agents

### Working In This Directory

- The `{expr:spec;locale}` shape is a cross-cutting contract: `template-parser.ts` produces the parts, `spec-parser.ts` decodes the spec, `ir/lower` wires them into `TextPart` IR, and the runtime `formatValue` (`@xgis/map`) renders. Changing the shape requires updating all layers simultaneously — including the map-side apply.
- This directory is PARSE-only by charter (#1001 content-blindness closeout). Do NOT add value-formatting / coordinate-rendering here; that belongs in `@xgis/map` (`map/src/text/format-value.ts` + `formatters/`). Adding a `formatDMS`/`'lat'`/`'mercator'` marker here fails the content-blindness ratchet.
- `spec-parser.ts` throws on invalid input; callers (template-parser, converter) are responsible for catching and surfacing warnings. Do not silently swallow errors inside the parser.

### Testing Requirements

Parse tests live in `compiler/src/__tests__/`, not co-located: `format-spec-parser.test.ts`, `format-template-parser.test.ts`. Run with `vitest` from the `compiler/` package root. The apply-side tests (`format-dispatch.test.ts`, `gis-formatter-*.test.ts`) moved with the formatters to `@xgis/map` (`map/src/text/`).

### Common Patterns

- Source files carry `// Batch 1c-2` / `// Batch 1c-3a` banner comments marking compiler batch provenance — preserve on edits.
- Parse functions are pure `(string) → struct`; no side effects, no module-level state.

## Dependencies

### Internal

- Imports the `FormatSpec` type from `../ir/render-node`.
- `template-parser.ts` imports `parseFormatSpec` from `./spec-parser`.
- Consumed by `ir/lower` (template wiring) and re-exported from the package root `index.ts`.

### External

- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
