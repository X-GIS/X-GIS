<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# convert

## Purpose
The Mapbox/MapLibre style importer: converts a Mapbox v8 style JSON into xgis source (utility-class strings + source/layer declarations) that the rest of the compiler then lowers and renders. It is split into single-concern siblings — sources, layers, paint properties, expressions/filters, colors — coordinated by `mapbox-to-xgis.ts`. It also carries the authoritative spec-coverage table (what the converter does and doesn't handle) and a preprocessor that splits `match`-on-color fill layers into per-color sublayers.

## Key Files
| File | Description |
|------|-------------|
| `mapbox-to-xgis.ts` | Top-level entry `convertMapboxStyle(style, opts)`. Orchestrates the sibling converters; keeps itself a single page by delegating each concern. |
| `sources.ts` | Converts Mapbox `sources` (geojson/vector/raster) → xgis sources; optionally stashes inline GeoJSON into a collector the importer auto-pushes via `setSourceData`. |
| `layers.ts` | Per-layer conversion incl. literal-array unwrapping (`["literal", […]]`) for symbol numeric-tuple knobs (text-offset, icon-offset, …). |
| `paint.ts` | Mapbox `paint` properties → xgis utility-class array; one `add*` helper per supported property. |
| `expressions.ts` | Mapbox expression + legacy filter → xgis expression conversion (handles both v1 expression and legacy filter generations). |
| `colors.ts` | Mapbox color value → xgis color fragment (hex passthrough, rgb/hsl, named colors). |
| `expand-color-match.ts` | Preprocessor splitting a `fill-color: ["match", …]` layer into one filtered sublayer per unique constant color (+ a NOT-IN fallback). |
| `spec-coverage.ts` | `MAPBOX_COVERAGE` table — single source of truth for converter capability; rendered by the site, validated by drift tests. |
| `types.ts` | The Mapbox-spec subset the converter understands (`MapboxStyle`/`MapboxLayer`/`MapboxSource` + root camera fields). |
| `utils.ts` | Tiny string-shaping helpers (id sanitization, numeric formatting) imported by every other module here, never the reverse. |

## For AI Agents

### Working In This Directory
- Dependency direction is intentional: everyone imports `utils.ts`; `utils.ts` imports nothing back. Keep that DAG when adding helpers.
- Adding converter support for a property means a new `add*` helper in `paint.ts` (or layer/source handler) AND a matching entry in `spec-coverage.ts` — the drift test fails if the table and the code disagree.
- Mapbox v8 frequently wraps arrays in `["literal", …]`; `layers.ts` already has the unwrap helper. Reuse it rather than re-checking shapes.

### Testing Requirements
- Colocated `font-name-parse.test.ts`. Heavy `src/__tests__/` coverage: `mapbox-convert.test.ts`, `mapbox-spec-conformance.test.ts`, `mapbox-roundtrip-coverage.test.ts`, `openfreemap-convert.test.ts`, `maplibre-demotiles-convert.test.ts`, `spec-coverage-drift.test.ts`, plus dozens of per-property `*-coverage.test.ts` / `*-warn-coverage.test.ts` files. Converters must isolate per-layer/source throws (see `*-throw-isolation-coverage.test.ts`).

### Common Patterns
- Each converter pushes zero-or-more utility strings onto an `out` array. Unsupported properties emit a once-per-kind warning rather than throwing; malformed input is tolerated and isolated.

## Dependencies

### Internal
- Imports `tokens/colors`, `spec/oracle`, `parser/`, `format/`; output feeds `ir/lower`.

### External
- Dev-only reference: `@maplibre/maplibre-gl-style-spec` (in tests).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
