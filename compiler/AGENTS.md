<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# @xgis/compiler

## Purpose
`@xgis/compiler` is the pure-TypeScript front-end of X-GIS: it turns a `.xgis` source string into GPU-ready render artifacts with **no GPU dependency**. The pipeline is Lexer → Parser → AST → `lower()` → IR (`Scene`) → `optimize()` (constant folding + expression classification + IR passes) → `emitCommands()` (SceneCommands for the runtime) and WGSL codegen (`ShaderVariant[]`, compute kernels, palettes). It also hosts the Mapbox/MapLibre style importer (`convert/`), the data-side vector tiler (`tiler/`, `tiler/geojsonvt/`, `input/`), the expression evaluator (`eval/`), value formatters (`format/`), and spec oracles. Everything here is deterministic and unit-testable in Node/Bun without a browser or `navigator.gpu`.

## Key Files
| File | Description |
|------|-------------|
| `src/index.ts` | Public package surface — re-exports Lexer, Parser, `lower`, `optimize`, `emitCommands`, codegen, tiler, convert, eval, format, schema. The canonical map of what the package offers. |
| `src/earcut.d.ts` | Ambient module declaration for the untyped `earcut` triangulation dep. |
| `package.json` | `@xgis/compiler`; `main`/`exports` point at `src/index.ts` (TS consumed directly). Deps: `@mapbox/vector-tile`, `pbf`. Dev: maplibre style-spec, `geojson-vt`, `vt-pbf`. |
| `tsconfig.json` | Per-package TS project config (`tsc --build`). |
| `bench-geojson-vt-encode.ts` | Standalone bench (`bun run`) timing geojson-vt + vt-pbf encode cost on the e2e fixtures; upper-bounds the MVT-pipeline-insertion option. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | All compiler source (see `src/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- This package is GPU-free by contract. Never import `@webgpu/types` or `navigator.gpu` here — WGSL is emitted as **strings**, not compiled.
- The compile pipeline order is load-bearing: `lower` produces the IR `Scene`, the IR pass manager + `optimize` transform it, `emitCommands` bridges to the runtime, and codegen reads the optimized `Scene`. Don't reorder stages.
- Three expression execution classes drive most design decisions: `constant` (folded at compile time), `zoom-dependent` (CPU-interpolated per frame via uniforms/palette), and `per-feature-gpu` / `per-feature-cpu` (WGSL codegen or storage-buffer upload). See `src/ir/classify.ts`.

### Testing Requirements
- `bun run test` (from repo root or this package) runs Vitest. Tests are colocated as `*.test.ts` beside source AND batched in `src/__tests__/` (~200 spec/coverage/regression files — that dir is excluded from AGENTS.md generation).
- Vitest does NOT typecheck. Run `bun run build` (`tsc --build`) before committing changes that touch test destructuring/locals or exported types.
- Fuzz tests (`*-fuzz.test.ts`) exist for lexer, parser, evaluator, clip, simplify, geodesic, mvt-decoder, colors, tile-key, and dsfun precision — keep them green when touching those modules.

### Common Patterns
- Modules are split into single-concern siblings that import "downward" only (e.g. `convert/utils.ts` is imported by everyone, imports nothing back).
- Files open with a `// ═══ Title ═══` banner comment describing role + plan phase.
- Pure functions over classes (Lexer/Parser are the main classes); `Scene → Scene` for IR passes.

## Dependencies

### Internal
- Consumed by `@xgis/runtime`, `playground`, `site`, `blueprint` (the schema).

### External
- `@mapbox/vector-tile`, `pbf` (MVT decode). Dev/port-reference: `@maplibre/maplibre-gl-style-spec`, `geojson-vt`, `vt-pbf`, `earcut`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
