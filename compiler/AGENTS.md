<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-29 -->

# compiler

## Purpose

`@xgis/compiler` is the pure-TypeScript front-end of X-GIS: it converts a `.xgis` style source string into GPU-ready render artifacts with no GPU dependency. The pipeline runs Lexer → Parser → AST → `lower()` → IR (`Scene`) → `optimize()` (constant folding, expression classification, IR passes: CSE, dead-code, merge-layers, dep annotation) → `emitCommands()` (SceneCommands for the runtime) and WGSL codegen (`ShaderVariant[]`, compute kernels via `compute-gen`/`compute-plan`/`compute-output-binding`/`compute-variant*`, palettes). It also hosts the Mapbox/MapLibre style importer (`src/convert/`), the data-side vector tiler (`src/tiler/`, including embedded geojson-vt 4.0.2, ECEF/DSFUN packers, geodesic helpers, simplify, clip, polygon/vertex formats, and dequant mirror), the expression evaluator (`src/eval/`), value formatters (`src/format/`), the MVT/PBF tile decoder (`src/input/`), binary scene serialization (`src/binary/`), color token resolution (`src/tokens/`), the style diagnostics profiler (`src/diagnostics/`), spec oracles (`src/spec/`), and the schema oracle (`src/schema/`). Everything is deterministic and unit-testable in Node/Bun without a browser or `navigator.gpu`.

## Key Files

| File                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`               | Public package barrel — re-exports every public symbol: `Lexer`, `Parser`, `lower`, `optimize`, `emitCommands`, all IR types, full codegen suite (ShaderVariant, wgslRaw, collectPalette, compute kernel emitters/planner/output-binding/variant builders), tiler (`compileGeoJSONToTiles`, ECEF/DSFUN packers, geodesic, simplify, clip, geojsonvt, encodeMVT, polygon/vertex formats, dequant), `decodeMvtTile`, `convertMapboxStyle`, `MAPBOX_COVERAGE`, IR analysis (`analyzeCSE`, `annotateDeps`, `Dep`), `LANGUAGE_SCHEMA`, `resolveColor`, `getStyleProfile`. Canonical map of all package exports. |
| `src/tiler/earcut.d.ts`      | Ambient module declaration for the untyped `earcut` polygon-triangulation dep (used by the tiler in Mercator-projected coordinate space).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `bench-geojson-vt-encode.ts` | Standalone benchmark (`bun run`) timing geojson-vt + vt-pbf encode cost on e2e fixtures; upper-bounds the MVT-pipeline-insertion option.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `package.json`               | `@xgis/compiler` workspace package (`private: true`, `type: module`); `exports` map `.` → `src/index.ts` and `./tiler/geodesic` → `src/tiler/geodesic.ts`. Runtime deps: `@mapbox/vector-tile`, `pbf`, `@xgis/shader-dsl`, `@xgis/shared`. Dev: `@maplibre/maplibre-gl-style-spec`, `geojson-vt`, `vt-pbf`.                                                                                                                                                                                                                                                                                                |
| `tsconfig.json`              | Per-package TypeScript project config (`tsc --build`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `README.md`                  | Package-level documentation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Subdirectories

| Directory | Purpose                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/`    | All compiler source: lexer, parser, IR, codegen, tiler, convert, eval, format, input, binary, tokens, schema, diagnostics, spec oracle, module resolver (see `src/AGENTS.md`). |

## For AI Agents

### Working In This Directory

- **GPU-free by contract.** Never import `@webgpu/types` or `navigator.gpu` here — WGSL is emitted as strings, never compiled.
- **Pipeline order is load-bearing.** `lower()` produces the IR `Scene`; IR pass manager + `optimize()` transform it; `emitCommands()` bridges to the runtime; codegen reads the optimized `Scene`. Do not reorder stages.
- Three expression execution classes drive most design decisions: `constant` (folded at compile time), `zoom-dependent` (CPU-interpolated per frame via uniforms/palette), and `per-feature-gpu`/`per-feature-cpu` (WGSL codegen or storage-buffer upload). See `src/ir/classify.ts`.
- `earcut` runs intentionally in **Mercator-projected coordinates** so CPU triangulation edges match GPU rendering (lon/lat-straight edges curve in Mercator — running earcut in lon/lat produces fill artefacts at coastlines). The ambient `earcut.d.ts` lives in `src/tiler/` for the tiler's direct use.
- All public symbols must be exported through `src/index.ts`; the only permitted deep-path export is `@xgis/compiler/tiler/geodesic` (declared in `package.json` `exports`).
- `vitest` does **not** typecheck. Run `bun run build` (`tsc --build`) before committing any change that touches exported types or test-local destructuring.
- The compute codegen suite (`compute-gen`, `compute-plan`, `compute-output-binding`, `compute-variant`, `compute-variant-merge`, `compute-variant-build`) handles GPU compute kernels for per-feature paint evaluation — changes here ripple into runtime shader dispatch.

### Testing Requirements

- `bun run test` (Vitest) from this package or repo root. Tests live as `*.test.ts` colocated beside source **and** batched in `src/__tests__/` (~200 spec/coverage/regression files — enumeration excluded per AGENTS.md rules; `__snapshots__`/`__fixtures__` internals likewise excluded).
- Fuzz tests (`*-fuzz.test.ts`) exist for lexer, parser, evaluator, clip, simplify, geodesic, mvt-decoder, colors, tile-key, DSFUN precision, ecef-line-segment, ecef-point, and ecef-precision — keep them green when touching those modules.
- The `src/spec/oracle.ts` + `oracle.test.ts` are the Mapbox expression spec conformance oracle; `src/__tests__/mapbox-spec-conformance.test.ts` and `spec-coverage-completeness.test.ts` gate coverage regressions.

### Common Patterns

- Modules split into single-concern siblings that import "downward" only (e.g. `convert/utils.ts` is used by everyone, imports nothing back).
- Source files open with a `// ═══ Title ═══` banner comment describing the file's role and plan phase.
- Pure functions over classes; `Scene → Scene` for all IR passes. `Lexer` and `Parser` are the main class exceptions.

## Dependencies

### Internal

- Imports `@xgis/shared` (shared types/utils) and `@xgis/shader-dsl` (codegen routes shader/compute emission through its IR Nodes).
- Consumed by `@xgis/runtime`, `playground`, `site`, and `blueprint` (schema).

### External

- **Runtime:** `@mapbox/vector-tile`, `pbf` (MVT/PBF decode).
- **Dev / port reference:** `@maplibre/maplibre-gl-style-spec` (spec oracle), `geojson-vt`, `vt-pbf`, `earcut` (ambient-typed only via `src/tiler/earcut.d.ts`).

<!-- MANUAL: notes below this line are preserved on regeneration -->
