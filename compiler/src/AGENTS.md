<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# compiler/src

## Purpose
The root of the compiler source tree. `index.ts` is the only public entry point — it re-exports the curated surface of every subdirectory (lexer, parser, IR, codegen, eval, format, convert, tiler, module, schema, etc.). The actual pipeline stages live in the subdirectories below; this level mostly aggregates them and declares the one ambient type the package needs.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Public package barrel. Every export the runtime / playground / site consume is listed here: `Lexer`, `Parser`, AST types, `lower`, `optimize`, `emitCommands`, `evaluate`, codegen (`ShaderVariant`, palette, compute-*), tiler (`compileGeoJSONToTiles`, clip, simplify, geodesic), `convertMapboxStyle`, schema, format. Read this first to find where anything is. |
| `earcut.d.ts` | Ambient `declare module 'earcut'` for the untyped triangulation dependency. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `lexer/` | Tokenizer + token/keyword/unit tables (see `lexer/AGENTS.md`). |
| `parser/` | Recursive-descent parser + AST node types (see `parser/AGENTS.md`). |
| `ir/` | AST→IR lowering, optimize, classify, const-fold, deps, emit-commands, PropertyShape (see `ir/AGENTS.md`). |
| `ir/passes/` | Individual `Scene → Scene` IR optimization passes (CSE, dead-code, fold, merge-layers) (see `ir/passes/AGENTS.md`). |
| `codegen/` | WGSL shader-variant + compute-kernel + palette emitters (see `codegen/AGENTS.md`). |
| `eval/` | Compile-time / runtime AST expression evaluator + reserved keys (see `eval/AGENTS.md`). |
| `convert/` | Mapbox/MapLibre style → xgis source importer (see `convert/AGENTS.md`). |
| `tiler/` | GeoJSON → GPU-ready tile pyramid; clip, simplify, geodesic, encoding (see `tiler/AGENTS.md`). |
| `tiler/geojsonvt/` | 1:1 TypeScript port of mapbox/geojson-vt + MVT encoder (see `tiler/geojsonvt/AGENTS.md`). |
| `input/` | MVT (.pbf) tile decoder feeding the tiler pipeline (see `input/AGENTS.md`). |
| `format/` | Value formatters + format-spec / text-template parsers (see `format/AGENTS.md`). |
| `module/` | `import` statement resolver (see `module/AGENTS.md`). |
| `schema/` | Declarative language-construct schema for the blueprint editor (see `schema/AGENTS.md`). |
| `spec/` | Mapbox spec oracle + zero-value semantics (see `spec/AGENTS.md`). |
| `tokens/` | Tailwind color-token palette resolver (see `tokens/AGENTS.md`). |
| `binary/` | `.xgb` compiled-binary serialize/deserialize (see `binary/AGENTS.md`). |
| `diagnostics/` | Compile-time scene optimization profile report (see `diagnostics/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- When adding a new public symbol, export it from `index.ts` — consumers import from `@xgis/compiler`, never deep paths (the one exception is `@xgis/compiler/tiler/geodesic`, declared in `package.json` exports).
- Keep `index.ts` grouped by subsystem (it already is: lexer/parser → binary → ir → eval → format → codegen → tiler → input → convert → diagnostics → passes → schema).

### Testing Requirements
- Spec/coverage/regression tests live in `src/__tests__/` (excluded from this doc tree). Subsystem-specific unit tests are colocated in each subdir.

### Common Patterns
- Type-only re-exports use `export type { ... }`; value+type splits are explicit.

## Dependencies

### Internal
- `index.ts` imports from every subdirectory.

### External
- None directly at this level (subdirs pull `pbf`, `@mapbox/vector-tile`, `earcut`).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
