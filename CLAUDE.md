# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is X-GIS

A domain-specific language (DSL) and WebGPU rendering engine for GIS maps. The language is declarative — `source` defines data, `layer` renders with Tailwind-style utility classes. Think HTML/CSS but for maps. Legacy `let`/`show` syntax is also supported.

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
bun compiler/src/cli/compile.ts compile examples/hello.xgis -o out.xgb   # Compile to binary
bun compiler/src/cli/compile.ts parse examples/hello.xgis                 # Print AST
bun compiler/src/cli/compile.ts ir examples/hello-v2.xgis                 # Print IR (debug)
```

## Monorepo Structure

Three packages via Bun workspaces (`compiler/`, `runtime/`, `playground/`):

- **@xgis/compiler** — Pure TypeScript language toolchain. No GPU or runtime deps. Lexer → Parser → AST → IR → Binary (.xgb) format. Includes Tailwind color palette and utility resolver.
- **@xgis/runtime** — WebGPU rendering engine. Depends on `@xgis/compiler`. Interprets AST into GPU render commands, handles data loading (GeoJSON tessellation, raster tiles), camera, projections, and interaction.
- **@xgis/playground** — Vite app for testing. Depends on both compiler and runtime.

Dependency flow: `compiler` ← `runtime` ← `playground`

## Compilation Pipeline

Two syntax modes, both producing the same IR:

```
New syntax:  .xgis → Lexer → Parser → AST (source/layer) → Lower → IR (Scene) → EmitCommands → SceneCommands → WebGPU
Legacy:      .xgis → Lexer → Parser → AST (let/show)     → Lower → IR (Scene) → EmitCommands → SceneCommands → WebGPU
```

The IR layer (`compiler/src/ir/`) sits between AST and runtime:
- `render-node.ts` — IR types (Scene, RenderNode, ColorValue, etc.)
- `lower.ts` — AST → IR lowering (handles both syntax modes)
- `emit-commands.ts` — IR → SceneCommands bridge for runtime
- `utility-resolver.ts` — Tailwind utility name → rendering properties

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
6. If it produces render output: extend `compiler/src/ir/lower.ts` to generate IR, and `emit-commands.ts` if new command types are needed
7. For new utility classes: extend `compiler/src/ir/utility-resolver.ts` and add colors to `compiler/src/tokens/colors.ts`

## Key Conventions

- TypeScript strict mode, ES2022 target, ESNext modules
- Tests use Vitest, located at `{compiler,runtime}/src/__tests__/*.test.ts`
- GeoJSON polygons are triangulated CPU-side using `earcut`, with edge subdivision (>3 degrees) for projection accuracy
- The `<xgis-map>` custom element (`runtime/src/web/component.ts`) is the public web API
