# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is X-GIS

A domain-specific language (DSL) and WebGPU rendering engine for GIS maps. The language is declarative — `let` binds data sources, `show` renders layers with style properties. Think HTML/CSS but for maps.

## Commands

```bash
bun install              # Install dependencies
bun run build            # Build all packages (tsc --build)
bun run test             # Run all tests (vitest run, exits after)
bun run dev              # Start playground dev server (Vite, localhost:5173)
```

Single test file:
```bash
bunx vitest run compiler/src/__tests__/lexer.test.ts
```

Compiler CLI:
```bash
bun --cwd compiler run compile examples/hello.xgis -o out.xgb   # Compile to binary
bun --cwd compiler run compile parse examples/hello.xgis         # Print AST
```

## Monorepo Structure

Three packages via Bun workspaces (`compiler/`, `runtime/`, `playground/`):

- **@xgis/compiler** — Pure TypeScript language toolchain. No GPU or runtime deps. Lexer → Parser → AST → Binary (.xgb) format.
- **@xgis/runtime** — WebGPU rendering engine. Depends on `@xgis/compiler`. Interprets AST into GPU render commands, handles data loading (GeoJSON tessellation, raster tiles), camera, projections, and interaction.
- **@xgis/playground** — Vite app for testing. Depends on both compiler and runtime.

Dependency flow: `compiler` ← `runtime` ← `playground`

## Compilation Pipeline

```
.xgis source → Lexer (tokens) → Parser (AST) → Interpreter (LoadCommand + ShowCommand) → MapRenderer (WGSL shaders) → WebGPU
```

## Rendering Architecture

Three renderers coexist in `runtime/src/engine/`:

- **MapRenderer** (`renderer.ts`) — Vector polygons/lines via WebGPU. Projection math is baked into WGSL shaders (not texture-based). Style properties (fill, stroke, opacity) come from AST show blocks.
- **RasterRenderer** (`raster-renderer.ts`) — Tile-based raster maps ({z}/{x}/{y} URL templates).
- **GlobeRenderer** (`globe-renderer.ts`) — 2-pass: renders flat map to offscreen texture, then maps it onto an icosphere mesh.

**XGISMap** (`map.ts`) is the main orchestrator — it parses source, initializes GPU, loads data, and delegates to the appropriate renderer.

## Projection System

Every projection has dual implementations: CPU (TypeScript in `projection.ts`) for bounds/tessellation and GPU (WGSL embedded in shader strings in `renderer.ts`) for rendering. Adding a projection requires updating both. Projection switching is dynamic via GPU uniform — no re-tessellation needed.

Supported: Mercator, Equirectangular, Natural Earth, Orthographic, Azimuthal Equidistant, Stereographic, Oblique Mercator.

## Adding Language Features

1. Add token type to `compiler/src/lexer/tokens.ts` (keyword map, TokenType enum)
2. Implement scanning in `compiler/src/lexer/lexer.ts`
3. Add AST node type in `compiler/src/parser/ast.ts`
4. Implement parsing in `compiler/src/parser/parser.ts`
5. Add tests in `compiler/src/__tests__/`
6. If it produces render output: extend `runtime/src/engine/interpreter.ts` to emit new commands

## Key Conventions

- TypeScript strict mode, ES2022 target, ESNext modules
- Tests use Vitest, located at `{compiler,runtime}/src/__tests__/*.test.ts`
- GeoJSON polygons are triangulated CPU-side using `earcut`, with edge subdivision (>3 degrees) for projection accuracy
- The `<xgis-map>` custom element (`runtime/src/web/component.ts`) is the public web API
