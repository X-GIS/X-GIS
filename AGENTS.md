<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# xgis

## Purpose
X-GIS is a domain-specific language and WebGPU rendering engine for GIS maps — "HTML/CSS for maps." A `.xgis` source declares **what** data looks like (sources, layers, Tailwind-style utility classes, presets, functions, symbols); the compiler decides **how** to render it on the GPU, emitting optimized WGSL shaders, buffer layouts, and render strategies. WebGPU is the primary renderer with a Canvas 2D fallback. Seven map projections are baked into the shaders with dual CPU+GPU implementations.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Bun workspace root; workspaces: compiler, blueprint, runtime, playground, site. Scripts: build, test, dev, test:pixel/perf/projection/e2e, precheck. |
| `tsconfig.base.json` | Shared TypeScript config inherited by all packages. |
| `vitest.config.ts` | Vitest unit-test runner config (`bun run test`). |
| `README.md` | Language overview, architecture diagram, vector-tile pipeline, projections. |
| `DESIGN.md` | Design rationale. |
| `ROADMAP.md` | Planned work. |
| `SPEC.md` | Language / behavior spec. |
| `CLAUDE.md` | Behavioral guidelines for AI agents working in this repo (think before coding, simplicity, surgical changes, goal-driven). |
| `bun.lock` | Bun lockfile. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `compiler/` | Lexer → parser → IR → optimizer → WGSL codegen. Pure TypeScript, no GPU deps (see `compiler/AGENTS.md`). |
| `runtime/` | WebGPU renderers (vector, raster tiles, globe), Canvas 2D fallback, camera, interaction, tile pipeline (see `runtime/AGENTS.md`). |
| `blueprint/` | Blueprint / visual node-editor work (see `blueprint/AGENTS.md`). |
| `playground/` | Vite dev app + Playwright e2e (pixel-match survey, perf, projection coverage) (see `playground/AGENTS.md`). |
| `site/` | Marketing / docs site (see `site/AGENTS.md`). |
| `docs/` | Project documentation, incl. COORDINATES.md coordinate-convention contract (see `docs/AGENTS.md`). |
| `scripts/` | Build/precheck scripts + Python cross-validation harness pinning CPU math to pyproj/mercantile/shapely (see `scripts/AGENTS.md`). |
| `e2e/` | Top-level end-to-end test assets (see `e2e/AGENTS.md`). |
| `vscode-xgis/` | VS Code extension for the `.xgis` language (see `vscode-xgis/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- Bun monorepo. Install with `bun install`. Build all with `bun run build` (per-workspace `build`).
- TypeScript strict; target version pinned at `typescript@5.6.3`.
- Follow `CLAUDE.md`: minimum code, surgical changes, match existing style, surface assumptions before implementing.
- Avoid adding npm dependencies — prefer hand-written code over polyfills. Don't bump package versions unless asked.

### Testing Requirements
- `bun run test` — Vitest unit tests (does NOT typecheck).
- `bun run build` — typechecks; run before commits that change test destructuring/locals.
- `bun run test:pixel` / `test:perf` / `test:projection` / `test:e2e` — Playwright suites in `playground/`.
- Perf/tile-selection changes: gate commit-vs-revert on concrete E2E numbers (tiles, p95/max ms) vs mercator control.

### Common Patterns
- Compile pipeline: `.xgis` → Lexer → Parser → AST → `lower()` → IR (Scene) → `optimize()` → emit SceneCommands + codegen ShaderVariant[] → Runtime (GPU/Canvas2D).
- Expression classification: constant (folded), zoom-dependent (CPU-interpolated per frame), per-feature-gpu (WGSL codegen).
- Vector tiles: single MVT/PBF decode+compile pipeline, two upstreams (HTTP PMTiles archive vs in-memory GeoJSON via geojson-vt port). **earcut runs in Mercator-projected coordinates** so triangle edges match GPU rendering.
- Projections switch instantly via GPU uniform — no re-tessellation. Each projection has paired CPU + GPU (WGSL) implementations that must agree.

## Dependencies

### Internal
- `playground` and `site` consume `@xgis/compiler` + `@xgis/runtime`.
- `runtime` consumes `@xgis/compiler` output (SceneCommands, ShaderVariant).

### External
- `earcut` — polygon triangulation.
- `monaco-editor` — in-browser `.xgis` editor.
- `@webgpu/types`, `typescript`, `vitest` (dev).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
