<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-23 -->

# scripts

## Purpose

One-off developer scripts run with `bun run scripts/<name>.ts` from inside `runtime/`. They verify external tile assets directly (header parse + per-tile probe) outside the render pipeline, used when debugging "empty screen / missing data" suspicions against a real PMTiles archive without involving the GPU or loader stack.

## Key Files

| File                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bake-shaders.ts`            | Build-time shader bake driver (`bun run bake:shaders`, #1678 / #1484). Configures the host seams exactly as the `XGISMap` constructor does (`configureProjections`, then `applyBodyOption`), emits every key in `map/src/shaders/baked/registry.ts`, and rewrites the four committed artifacts — one per (language, group): `baked-{glsl,wgsl}-{hillshade,rest}.generated.ts`. Deliberately thin: all logic lives in `map/src/shaders/baked/bake.ts` where `tsc --build` typechecks it and `baked-sync.test.ts` can import it. NOT part of `bun run build` — the artifact is committed, and regenerating it during the build would green its own gate. |
| `build-dts.ts`               | Post-build declaration bundler using rollup-plugin-dts; inlines @xgis/shared and @xgis/compiler types into a single dist/index.d.ts, resolving import-reference failures in consumers who lack those internal packages. Prepends WebGPU type reference banner for strict type-checking. Run after `vite build` via the `bun` runtime.                                                                                                                                                                                                                                                                                                                  |
| `inspect-firenze-pmtiles.ts` | Fetches the Firenze PMTiles archive header via `bytesToHeader` (from `pmtiles`) and probes individual tiles at the Florence center (lon 11.25, lat 43.77) across zooms 0–15 to confirm the archive contains data at the zoom levels the renderer requests. Accepts an optional URL argument; defaults to the public Protomaps ODbL Firenze archive. Prints header metadata (tile type, zoom range, bounds, compression), per-zoom tile XY coordinates, and a recommended demo URL.                                                                                                                                                                     |

## For AI Agents

### Working In This Directory

- Mostly standalone diagnostics; not imported by any runtime module. Those talk to the network and `pmtiles` directly — no GPU, no `XGISMap`, no loader SSRF guard applies. `bake-shaders.ts` is the exception: it imports `map/src` (the shader DSL + the bake logic) and WRITES generated files back into `map/src/shaders/baked/`.
- Use as a template when answering "does the source actually have this tile?" before assuming a render bug.
- `lonLatToTile` is a local Web Mercator XYZ helper — not shared with the runtime; keep them in sync if tile-address logic changes.

### Testing Requirements

- No automated tests. Verify by running `bun run scripts/<name>.ts` and reading the console output; non-zero exit code or an HTTP error line indicates failure.

### Common Patterns

- Read header → resolve tile address → range-fetch → decode → print. Pure diagnostics, no side effects.

## Dependencies

### Internal

- `bake-shaders.ts` → `@xgis/geo` (`PROJECTIONS`), `map/src/shaders/dsl/projections`, `map/src/body-consts`, `map/src/shaders/baked/bake` (+ its `registry`, which pulls in every shader-dsl emitter). Emit is only valid once those host seams are configured, which is why the script configures them first.
- The diagnostics (`inspect-firenze-pmtiles.ts`) use raw `pmtiles`, not the runtime loader.

### External

- `pmtiles` (`bytesToHeader`, `TileType`).
- `prettier` — `bake-shaders.ts` formats its generated output through the ROOT `node_modules/.bin/prettier` (declared in the root manifest, as `format`/`changelog` use it), so the committed bytes are already canonical and the pre-commit hook cannot re-write them.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
