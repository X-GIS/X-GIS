<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# convert

## Purpose
The Mapbox/MapLibre style importer: converts a Mapbox v8 style JSON into xgis source (utility-class strings + source/layer declarations) that the rest of the compiler lowers and renders. `mapbox-to-xgis.ts` orchestrates single-concern siblings — sources, layers, paint properties, expressions/filters, colors — each backed by a companion `-helpers.ts` or `-types.ts` that carries extracted pure helpers and type declarations so the main modules stay focused on pipeline logic. Also includes a preprocessor (`expand-color-match.ts`) that splits `match`-on-color fill layers into per-color sublayers, an authoritative spec-coverage table, and the Mapbox font-name parser.

## Key Files
| File | Description |
|------|-------------|
| `mapbox-to-xgis.ts` | Top-level entry `convertMapboxStyle(style, opts)` — THIN orchestrator (Tier-C5 split). Validation pre-walks live in `validate-sources.ts` / `validate-layers.ts`; the background-layer converter body in `convert-background-layer.ts`. Calls them in a fixed order; the `warnings[]` append order is part of the contract (conversion-notes tests pin it). |
| `validate-sources.ts` / `validate-layers.ts` | Pure style-validation pre-walks lifted out of `convertMapboxStyle` (zoom ranges, id collisions, source-layer / source-ref checks) — return their warnings; no conversion side effects. |
| `convert-background-layer.ts` | The background-layer converter body lifted out of `mapbox-to-xgis.ts` (`convertBackgroundLayer`); holds the `background-*` paint references. |
| `sources.ts` | Converts Mapbox `sources` (geojson/vector/raster) → xgis sources; stashes inline GeoJSON into a collector for `setSourceData` auto-push. |
| `layers.ts` | Per-layer conversion incl. symbol-placement step expansion (splits one Mapbox layer into zoom-range sublayers for road shields), delegating to `layers-helpers.ts`. |
| `layers-helpers.ts` | Pure helpers extracted from `layers.ts`: `unwrapLiteralTuple`, `unwrapLiteralScalar`, `applyAlphaMultiplier`, `safePropsBag`, `isOmittedValue`, `parseMapboxFontName`, `textFieldToXgisExpr`, `parseSymbolPlacementStep`. None close over module state. |
| `layers-types.ts` | `SymbolLayerOverrides` interface — internal type for zoom-step symbol-placement expansion; not part of the public export surface. |
| `paint.ts` | Thin per-layer-type dispatcher (Tier-A registry split). Delegates each group to a per-type emitter module — `paint-fill.ts` / `paint-line.ts` / `paint-fill-extrusion.ts` / `paint-raster.ts` (each exporting its `add*` emitters) — and shared math to `paint-helpers.ts`. A new property's `add*` goes in the matching per-type module, NOT here. |
| `expr-registry.ts` (+ `expr-arithmetic.ts` / `expr-logic.ts` / `expr-lookup.ts` / `expr-string.ts` / `expr-interpolate.ts` / `expr-match.ts`) | Per-cluster expression handler registry (Tier-A split of `exprToXgis`). `expressions.ts` is the thin dispatcher over `Map<op, handler>` and keeps the central `_exprDepth` recursion guard; a new operator goes in the matching cluster module + the registry. |
| `layer-converters/` | Per-layer-type converter registry (Tier-A split of `convertLayer`): `line.ts` / `circle.ts` / `symbol.ts` / `generic.ts` self-register via `registerLayerConverter()`; `layers.ts` is the thin dispatcher. A new layer type registers its converter here. |
| `paint-helpers.ts` | Pure helpers extracted from `paint.ts`: `unwrapStopLiteral`, `isOmitted`, `interpolateZoomStops` (handles legacy v0/v1 stops + modern interpolate + cubic-bezier dense resampling + interpolate-lab/hcl LCh densification), `interpolateZoomCall`, `unwrapLiteralNumeric`, `cssBezierEase`. |
| `paint-types.ts` | `InterpolateZoomShape` interface — shared between `paint.ts` and `paint-helpers.ts` for the zoom-stop extraction return type. |
| `expressions.ts` | Mapbox expression + legacy filter → xgis expression conversion; handles both v1 expression and legacy filter generations. |
| `expressions-helpers.ts` | Pure helpers extracted from `expressions.ts`: `substituteVars` (recursive `let`-binding substitution with circular-ref guard for flattening `let`/`var` nodes before tree-walk). |
| `colors.ts` | Mapbox color value → xgis color fragment (hex passthrough, rgb/hsl, named colors). |
| `expand-color-match.ts` | Preprocessor splitting a `fill-color: ["match", …]` layer into one filtered sublayer per unique constant color plus a NOT-IN fallback. |
| `spec-coverage.ts` | Thin ASSEMBLER for the `MAPBOX_COVERAGE` table — single source of truth for converter capability; rendered by the site, validated by drift tests. It spreads one descriptor file per section from `spec-coverage/` (`top-level.ts`, `paint-fill.ts`, `expressions.ts`, …) into the section tree; the public surface (`MAPBOX_COVERAGE`, `flattenCoverage`, the `Coverage*` types) is unchanged. |
| `spec-coverage/` | Per-section coverage descriptors — one `const` array of `CoverageEntry` per Mapbox-spec section (top-level / source-types / layer-types / layer-common / layout-fill-line / layout-symbol / paint-* / expressions / filters), plus `types.ts` (the `CoverageEntry` / `CoverageSection` / `CoverageStatus` / `CoverageImpact` declarations). New coverage rows go HERE, in the matching section file. |
| `types.ts` | Mapbox-spec subset the converter understands: `MapboxStyle`, `MapboxLayer`, `MapboxSource`, root camera fields. |
| `utils.ts` | Tiny string-shaping helpers (id sanitization, numeric formatting). Imported by every other module here; imports nothing back. |

## For AI Agents

### Working In This Directory
- Dependency direction is intentional: `utils.ts` imports nothing in this package; every `*-helpers.ts` is pure (no module-level mutable state, no side effects). Keep that DAG when adding helpers.
- The split into `foo.ts` + `foo-helpers.ts` + `foo-types.ts` is the current decomposition pattern — new pure helpers belong in the `-helpers.ts` sibling, new internal types in the `-types.ts` sibling.
- Adding converter support for a property requires a new `add*` helper in the matching per-layer-type emitter module (`paint-fill.ts` / `paint-line.ts` / `paint-fill-extrusion.ts` / `paint-raster.ts`), a new operator in the matching `expr-*` cluster + `expr-registry.ts`, or a converter under `layer-converters/` — NOT the now-thin dispatchers `paint.ts` / `expressions.ts` / `layers.ts` — AND a matching entry in the per-section descriptor under `spec-coverage/` (e.g. `spec-coverage/paint-circle.ts`, `spec-coverage/layout-symbol.ts`) — NOT the assembler `spec-coverage.ts`, which only spreads the descriptors into the `MAPBOX_COVERAGE` tree. Splitting the table by section keeps independent parity axes that touch different sections in different files, so they never conflict and can be implemented in parallel (worktree fan-out). The drift test fails if the table and the code disagree.
- Mapbox v8 frequently wraps scalars and arrays in `["literal", …]`; multiple `unwrap*` helpers exist across the `-helpers.ts` files. Reuse the appropriate one rather than adding new inline checks.
- `interpolateZoomStops` in `paint-helpers.ts` handles legacy v0/v1 object-stops, modern `interpolate`, `interpolate-lab`, `interpolate-hcl`, and `cubic-bezier` (compile-time dense resampling). Extend there, not inline in `paint.ts`.
- `parseSymbolPlacementStep` in `layers-helpers.ts` expands `["step", ["zoom"], …]` on `symbol-placement` into zoom-range segments; OFM Bright highway shields depend on this path.

### Testing Requirements
- Colocated `font-name-parse.test.ts` covers `parseMapboxFontName`.
- Heavy `src/__tests__/` coverage: `mapbox-convert.test.ts`, `mapbox-spec-conformance.test.ts`, `mapbox-roundtrip-coverage.test.ts`, `openfreemap-convert.test.ts`, `maplibre-demotiles-convert.test.ts`, `spec-coverage-drift.test.ts`, plus per-property `*-coverage.test.ts` / `*-warn-coverage.test.ts` files. Converters must isolate per-layer/source throws (see `*-throw-isolation-coverage.test.ts`).

### Common Patterns
- Each converter pushes zero-or-more utility strings onto an `out` array. Unsupported properties emit a once-per-kind warning rather than throwing; malformed input is tolerated and isolated.
- `isOmitted` / `isOmittedValue` guards (both in paint and layers helpers) handle bare `null`, `undefined`, and any depth of `["literal", null]` wrap — always gate property reads through these before passing to `exprToXgis`.

## Dependencies

### Internal
- Imports `tokens/colors` (for Lab/LCh densification in `paint-helpers.ts`), `spec/oracle`, `parser/`, `format/`; output feeds `ir/lower`.

### External
- Dev-only reference: `@maplibre/maplibre-gl-style-spec` (in tests).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
