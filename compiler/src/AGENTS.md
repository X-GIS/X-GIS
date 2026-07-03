<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-29 -->

# compiler/src

## Purpose

Root of the compiler source tree. `index.ts` is the sole public entry point for the `@xgis/compiler` package — it re-exports the curated public surface of every subdirectory: lexer, parser, IR lowering/optimization/emit, expression evaluator, format pipeline, codegen (WGSL shader variants + GPU compute kernels + palette), vector tiler, MVT decoder, Mapbox/MapLibre style converter, binary serializer, diagnostics profiler, and language schema. The subdirectories hold all implementation; this level only aggregates them and declares one ambient module type.

## Key Files

| File                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`          | Public package barrel (~100 lines). Re-exports every symbol consumers need: `Lexer`/`Parser`/AST types, `lower`/`optimize`/`emitCommands`, IR types (`Scene`, `RenderNode`, `PropertyShape`), `evaluate`/`makeEvalProps`/reserved keys, format helpers (`formatValue`, `parseFormatSpec`, `parseTextTemplate`), codegen (`ShaderVariant`, `collectPalette`, compute-gen/plan/output-binding/variant/variant-merge/variant-build, `paint-routing`, node-type helpers), tiler (`compileGeoJSONToTiles`, ECEF packers, `clipPolygonToRect`, `simplify`, `interpolateGreatCircle`, vertex-format, dequant-mirror), `decodeMvtTile`, `convertMapboxStyle`/`MAPBOX_COVERAGE`, `getStyleProfile`, CSE/deps analysis passes, and `LANGUAGE_SCHEMA`. Read this first to locate any symbol. The barrel now re-exports via per-area sub-barrels (`./lexer`, `./parser`, `./ir`, `./eval`, `./module`, `./codegen`, `./tiler`, `./input`, `./convert`, `./diagnostics`, `./schema`, `./binary`, `./tokens` — each its own `index.ts`) plus a curated `./format` re-export; a new public symbol goes in its AREA sub-barrel and flows up automatically (the set-identical export contract is pinned by a drift check). |
| `tiler/earcut.d.ts` | Ambient `declare module 'earcut'` for the untyped polygon-triangulation dependency used by the tiler (lives under `tiler/`, the sole consumer).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Subdirectories

| Directory      | Purpose                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `binary/`      | `.xgb` compiled-binary serialize/deserialize (see `binary/AGENTS.md`)                                                                                                          |
| `codegen/`     | WGSL shader-variant + compute-kernel (gen/plan/output-binding/variant/merge/build) + palette emitters + paint-routing + node-type DSL (see `codegen/AGENTS.md`)                |
| `convert/`     | Mapbox/MapLibre style → xgis importer + spec-coverage table (see `convert/AGENTS.md`)                                                                                          |
| `diagnostics/` | Compile-time scene optimization profile report (see `diagnostics/AGENTS.md`)                                                                                                   |
| `eval/`        | Compile-time/runtime AST expression evaluator, reserved-keys, evaluator-helpers (see `eval/AGENTS.md`)                                                                         |
| `format/`      | Value formatters + format-spec / text-template parsers (see `format/AGENTS.md`)                                                                                                |
| `input/`       | MVT (.pbf) tile decoder (see `input/AGENTS.md`)                                                                                                                                |
| `ir/`          | AST→IR lowering, optimize, classify, const-fold, deps, emit-commands, PropertyShape, utility-resolver, and IR passes (CSE, dead-code, fold, merge-layers) (see `ir/AGENTS.md`) |
| `lexer/`       | Tokenizer + token/keyword/unit tables (see `lexer/AGENTS.md`)                                                                                                                  |
| `module/`      | `import` statement resolver (see `module/AGENTS.md`)                                                                                                                           |
| `parser/`      | Recursive-descent parser + AST node types (see `parser/AGENTS.md`)                                                                                                             |
| `schema/`      | Declarative language-construct schema for the blueprint editor (see `schema/AGENTS.md`)                                                                                        |
| `spec/`        | Mapbox spec oracle + zero-value semantics (see `spec/AGENTS.md`)                                                                                                               |
| `tiler/`       | GeoJSON → GPU-ready tile pyramid; ECEF vertex packers, clip, simplify, geodesic, encoding, vertex-format, dequant-mirror, geojson-vt port (see `tiler/AGENTS.md`)              |
| `tokens/`      | Tailwind color-token palette resolver (see `tokens/AGENTS.md`)                                                                                                                 |

`__tests__/` holds regression, fixture-sweep, spec-conformance, and cross-subsystem integration tests (including fixtures in `__tests__/fixtures/`). Not enumerated here.

## For AI Agents

### Working In This Directory

- Any new public symbol must be exported from `index.ts` — all consumers import from `@xgis/compiler`, never from deep paths (sole exception: `@xgis/compiler/tiler/geodesic`, declared in `package.json#exports`).
- Keep `index.ts` grouped by subsystem in its existing order: lexer/parser → binary → ir → eval → format → codegen → tiler → input → convert → diagnostics → passes → schema. Do not reorder sections.
- The ambient `earcut.d.ts` lives in `tiler/` (its sole consumer); do not remove it without checking resolution scope.
- Run `bun run build` (not just vitest) before any PR — vitest does not typecheck; the build will catch type errors in `index.ts` re-exports.

### Testing Requirements

- Cross-subsystem and regression tests: `src/__tests__/` (60+ test files). Run with `vitest` from the compiler package root.
- Subsystem unit tests are colocated in each subdirectory (e.g., `codegen/compute-gen.test.ts`, `ir/deps.test.ts`).
- Fixture-sweep tests (`__tests__/fixture-sweep.test.ts`) run the full compiler pipeline over real OFM style fixtures in `__tests__/fixtures/`.

### Common Patterns

- Type-only re-exports use `export type { ... }`; value+type splits are always explicit.
- New codegen symbols follow the existing grouping inside `index.ts`: compute-* exports are clustered together after palette.

## Dependencies

### Internal

- `index.ts` imports from every subdirectory in this tree; no cross-package imports at this level.

### External

- None directly at this level. Subdirs pull `pbf`, `@mapbox/vector-tile` (input/), `earcut` (tiler/), and `@xgis/shader-dsl` (codegen/ routes shader/compute emission through its IR Nodes).

<!-- MANUAL: notes below this line are preserved on regeneration -->
