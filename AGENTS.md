<!-- Generated: 2026-05-22 | Updated: 2026-06-29 -->

# xgis

## Purpose
X-GIS is a domain-specific language and WebGPU rendering engine for GIS maps — "HTML/CSS for maps." A `.xgis` source file declares **what** data looks like (sources, layers, Tailwind-style utility classes, modifiers, functions, symbols); the compiler pipeline decides **how** to render it on the GPU, emitting optimized WGSL shaders, buffer layouts, and render strategies. The runtime is a full MapLibre-style WebGPU tile engine supporting 8 projection surfaces (Mercator, globe/ECEF, equirect, oblique-Mercator, azimuthal, stereographic, natural-earth, orthographic), a text/SDF/PBF glyph pipeline, sprite atlas, PMTiles/TileJSON/GeoJSON data sources, and a shader DSL that emits WGSL. WebGPU is the sole renderer; on an unsupported browser `WebGPUUnavailableError` is thrown, the `onWebGPUUnavailable()` host hook fires, and a default message is shown instead of a silent blank canvas. Ship-P0 hardening (branch `chore/ship-p0`) has landed SSRF guards + body/ingest size caps in `loader/`, `map.destroy()` lifecycle teardown, map lifecycle/camera events, and an accessibility baseline in `runtime/`.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Bun workspace root; workspaces: `shared`, `compiler`, `blueprint`, `shader-dsl`, `runtime`, `playground`, `site`. Scripts: `build` (all workspaces), `test` (vitest), `dev` (playground), `dev:site`, `test:pixel/perf/projection/e2e` (Playwright), `precheck`, `setup:hooks`. |
| `vitest.config.ts` | Vitest config covering `compiler/src/**`, `blueprint/src/**`, and `runtime/src/**` test files; sets a 30s timeout for full-pipeline tests that load `countries.geojson`. |
| `tsconfig.base.json` | Shared TypeScript compiler options (`ES2022`, `strict`, `noUnusedLocals/Parameters`, `@webgpu/types`); inherited by all packages. |
| `tsconfig.json` | Root project-reference file wiring `shared`, `compiler`, `blueprint`, `shader-dsl`, `runtime` for cross-package type checking. |
| `CLAUDE.md` | AI-agent behavioral contract: think before coding, simplicity first, surgical changes only, goal-driven execution with verifiable criteria. |
| `README.md` | Language overview with `.xgis` syntax examples, architecture summary, quick-start (`bun install && bun run dev`). |
| `DESIGN.md` | Design research and rationale (Korean prose + tables); covers MapLibre/Mapbox/Deck.gl/CesiumJS analysis, Paint Property Binder pattern, GPU interpolation strategy. |
| `ROADMAP.md` | 8-phase development roadmap (MVP → Core Language → Data Pipeline → Advanced Rendering → Compute → Application → Domain Standards → Ecosystem). |
| `SPEC.md` | `.xgvt` (X-GIS Vector Tile) binary format spec: 40-byte header, Morton-keyed tile index, property table, HTTP range-request access pattern. |
| `LICENSE` | MIT License, copyright 2026 X-GIS contributors. |
| `bun.lock` | Bun lockfile pinning all workspace dependencies. |
| `filter-gdp-iphone.png` | Demo screenshot showing GDP-filtered iPhone data on globe view. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `compiler/` | `.xgis` lexer → parser → AST → IR passes (lower, optimize, merge-layers) → codegen (ShaderVariant[], SceneCommands, binary); pure TypeScript, no GPU deps (see `compiler/AGENTS.md`) |
| `runtime/` | WebGPU engine: camera/projection math for 8 surfaces, GPU tile renderer, shader DSL emitting WGSL, SDF/PBF text pipeline, sprite atlas, PMTiles/TileJSON/GeoJSON sources + workers (see `runtime/AGENTS.md`) |
| `shared/` | Shared TypeScript types and utility modules consumed by both compiler and runtime (see `shared/AGENTS.md`) |
| `shader-dsl/` | `@xgis/shader-dsl` — zero-dep TypeScript shader DSL: author a shader once as a typed IR, emit it to WGSL + GLSL + a CPU f64 oracle over one shared tree-walk (closes GPU/CPU projection drift). Consumed by `runtime/` and `compiler/`; see `shader-dsl/AUTHORING.md` for the authoring guide (see `shader-dsl/AGENTS.md`) |
| `blueprint/` | Visual node-editor concept for `.xgis` pipeline authoring (see `blueprint/AGENTS.md`) |
| `playground/` | Vite dev app + Playwright e2e suites: pixel-match survey, perf, projection coverage (see `playground/AGENTS.md`) |
| `site/` | Astro-based documentation/marketing site (see `site/AGENTS.md`) |
| `docs/` | Architecture docs: C4 diagrams, module DAG, 8 ADRs, Mermaid UML, `COORDINATES.md` coordinate-convention contract (see `docs/AGENTS.md`) |
| `scripts/` | `precheck.ts` pre-push gate; Python cross-validation harness under `cross-validation/` (pyproj/mercantile/shapely, 20 tests pinning CPU projection math); render observation logs (see `scripts/AGENTS.md`) |
| `e2e/` | Top-level end-to-end test assets (see `e2e/AGENTS.md`) |
| `vscode-xgis/` | VS Code syntax-highlight extension for the `.xgis` language (see `vscode-xgis/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Bun monorepo. Install with `bun install`. Build all packages with `bun run build` (runs per-workspace `build`; also typechecks).
- `vitest` does **not** typecheck — always run `bun run build` before committing changes that touch type-bearing code (destructuring, generics, imports).
- TypeScript strict mode; pinned at `typescript@5.6.3`. `noUnusedLocals` and `noUnusedParameters` are enforced — remove any imports/vars that YOUR changes make unused.
- Follow `CLAUDE.md`: minimum code, surgical changes only, match existing style, surface assumptions before implementing.
- Zero new npm dependencies. No package version bumps unless explicitly requested.
- `.githooks/pre-push` is armed via `setup:hooks`; `bun run precheck` (or `precheck:smoke`) runs the pre-push gate manually.
- `shared/` must stay import-free from `compiler/` or `runtime/` — it is the common base, not a consumer.

### Testing Requirements
- `bun run test` — Vitest unit tests across compiler, blueprint, runtime (no GPU, no browser).
- `bun run build` — full typecheck gate; required before any PR.
- `bun run test:pixel` — Playwright pixel-match survey (real GPU, headed browser, `playground/`).
- `bun run test:perf` — Playwright interactive perf test (`_perf-bright-interactive.spec.ts`).
- `bun run test:projection` — Playwright projection-coverage suite.
- `bun run test:e2e` — all Playwright specs in `playground/`.
- CI runs under SwiftShader (no real GPU); render gates and globe/non-Mercator visual gates must be verified locally with a real GPU.
- Perf or tile-selection changes: gate commit-vs-revert on concrete E2E numbers (tile counts, p95/max ms) vs a Mercator control run.

### Common Patterns
- Compile pipeline: `.xgis` → Lexer → Parser → AST → `lower()` → IR (Scene) → `optimize()` → IR passes (e.g. `merge-layers`) → emit SceneCommands + `ShaderVariant[]` → Runtime GPU dispatch.
- Expression classification: constant (compile-time folded), zoom-dependent (CPU-interpolated each frame), per-feature-gpu (WGSL codegen path).
- Vector tiles: single MVT/PBF decode+compile pipeline; two upstreams — HTTP PMTiles archive and in-memory GeoJSON via embedded geojson-vt port. `earcut` tessellates in Mercator-projected tile coordinates so triangle edges match GPU rendering.
- Projections switch via GPU uniform with no re-tessellation. Every projection has paired CPU (TypeScript) + GPU (WGSL) implementations that must agree numerically; cross-validate with `scripts/cross-validation/`.
- Shader DSL emits WGSL at build time; hand-written `.wgsl` files are not committed — all shaders are DSL-generated.

## Dependencies

### Internal
- `playground` consumes `@xgis/compiler` + `@xgis/runtime`; `site` also adds `@xgis/blueprint`.
- `runtime` consumes `@xgis/compiler` output (SceneCommands, ShaderVariant[]).
- All packages inherit `tsconfig.base.json` and may import from `@xgis/shared`.

### External
- `earcut` — polygon triangulation (in-process, no worker).
- `monaco-editor` — in-browser `.xgis` editor (playground/site only).
- `@webgpu/types` — WebGPU TypeScript type definitions (dev).
- `typescript@5.6.3`, `vitest@^3.0.0` — dev toolchain.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

## Codebase Memory MCP

**MANDATORY: use Codebase Memory MCP graph tools FIRST — before reading files or making code changes.**

This rule applies to every request involving this codebase.

Always call `list_projects` first when you do not already know the project name, then use the `display_name` or exact `name` returned by that tool.

```json
// Step 0 — discover project names
mcp_codebase-memo_list_projects()

// Step 1 — use the project identifier returned above
mcp_codebase-memo_get_architecture({ "project": "<display_name>" })
```

### Workflow

1. Call `list_projects` to discover the correct project name.
2. Call `get_architecture(project)` to understand the codebase structure.
3. Use `search_graph` to find relevant symbols, `trace_call_path` for call chains.
4. Use `get_code_snippet` to read specific function implementations.
5. Only use `read_file` when you need exact raw content to edit a specific line.

### Available Tools (14 MCP tools)

**Indexing:**
- `index_repository(repo_path)` — Index a repository into the knowledge graph
- `list_projects` — List all indexed projects with node/edge counts
- `delete_project(project)` — Remove a project and all its graph data
- `index_status(project)` — Check indexing status

**Querying:**
- `search_graph(name_pattern, name_scope, label, file_pattern, exclude_file_pattern)` — Structured search by label, name/qualified_name, include/exclude file globs
- `trace_call_path(function_name, direction, depth)` — BFS call chain traversal
- `detect_changes(project)` — Map git diff to affected symbols + risk
- `query_graph(query)` — Execute Cypher-like graph queries (read-only)
- `get_graph_schema(project)` — Node/edge counts, relationship patterns
- `get_code_snippet(qualified_name)` — Read source code for a function
- `get_architecture(project)` — Codebase overview: languages, packages, routes, hotspots
- `search_code(pattern, project)` — Grep-like text search within indexed files
- `manage_adr(action)` — CRUD for Architecture Decision Records
- `ingest_traces(traces)` — Ingest runtime traces to validate HTTP edges
