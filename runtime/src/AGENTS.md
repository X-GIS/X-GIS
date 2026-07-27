<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-07-27 -->

# src

## Purpose

Source root of `@xgis/runtime`, the monorepo's one published package. It is a **publication
layer, not an implementation**: the barrel (`index.ts`) re-exports `@xgis/map`,
`@xgis/data`, `@xgis/geo` and `@xgis/rhi-webgpu`; `capabilities.ts` + `capabilities/`
declare what the renderer honours; `web/component.ts` wraps `XGISMap` as `<xgis-map>`.
That is the whole of the source — ~1.8k LOC across 19 files.

> **The rest of this tree is TESTS.** `engine/`, `data/`, `loader/`, `diagnostics/`,
> `__tests__/` and `__test-support__/` contain 259 `*.test.ts` and no source. Despite the
> name, `engine/**` tests `@xgis/map` (not `@xgis/engine`) — it is the pre-extraction
> layout, kept until the corpus is relocated to the packages it tests. **Do not add new
> tests here**; colocate them with their subject in `map/src` / `data/src` / `engine/src`.

## Key Files

| File                        | Description                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`                  | Public barrel — `XGISMap`, `Camera`, `MapRendererContent`, `FrameRenderer`, `Marker`/`Popup`, `StatsPanel`/`StatsTracker`, color-ramp helpers (`@xgis/map`); `loadGeoJSON`/sources/polar caps (`@xgis/data`); projection factories (`@xgis/geo`); `ComputeDispatcher` (`@xgis/rhi-webgpu`); the capability table; `XGISMapElement`. The ONLY import surface for `playground/` and `site/`. |
| `capabilities.ts`           | `RUNTIME_CAPABILITIES` — per `(layerType, property, variant)` flags of what the renderer honours vs silently drops/degrades. Variants: `constant`, `zoom-interp`, `data-driven`. `runtimeGaps()` returns the unsupported subset.                                                                                                                                                           |
| `capabilities.test.ts`      | Unit test for the capability lookup API. Lives at the top level of `src/`, not under `__tests__/`. Keep it there.                                                                                                                                                                                                                                                                          |
| `vite-shims.ts`             | Ambient `declare module '*?worker'` shim for Vite's worker-query import suffix. Kept as `.ts` (not `.d.ts`) because `.gitignore` excludes `runtime/src/**/*.d.ts` as build artifacts.                                                                                                                                                                                                      |
| `earcut.d.ts`               | Hand-authored ambient type declaration for `earcut` (the package bundles no types). Do not delete.                                                                                                                                                                                                                                                                                         |
| `test-setup-projections.ts` | The ROOT Vitest `setupFiles` entry (`vitest.config.ts`): calls `configureProjections(PROJECTIONS)` so every suite in the monorepo can reach the projection emit / CPU-projection path.                                                                                                                                                                                                     |

## Subdirectories

| Directory           | Purpose                                                                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capabilities/`     | Per-layer-type capability descriptors (`background.ts`, `circle.ts`, `fill.ts`, `fill-extrusion.ts`, `heatmap.ts`, `line.ts`, `raster.ts`, `symbol.ts`, `types.ts`) spread into the table by `capabilities.ts`. |
| `web/`              | `XGISMapElement` / `registerXGISElement` — the `<xgis-map>` custom element (see `web/AGENTS.md`).                                                                                                               |
| `engine/`           | **Tests only** — the `@xgis/map` render/projection/text/sprite suites (226 files), plus the `architecture-invariants.test.ts` ratchet.                                                                          |
| `data/`, `loader/`  | **Tests only** — `@xgis/data` tile-catalog / selection / source-backend suites.                                                                                                                                 |
| `diagnostics/`      | **Tests only** — the render-trace suite.                                                                                                                                                                        |
| `__tests__/`        | Cross-cutting integration tests (cross-validation fixture, spec-coverage drift, EPSG cross-val, WebGPU-stub smoke).                                                                                             |
| `__test-support__/` | `webgpu-stub.ts` — the shared WebGPU mock used across the suite.                                                                                                                                                |

## For AI Agents

### Working In This Directory

- **Implementation does not live here.** A renderer / camera / tile / projection change
  belongs to `@xgis/map`, `@xgis/data` or `@xgis/geo`. Edits here should be limited to the
  barrel, `capabilities/`, and `web/component.ts`.
- Any new paint/layout property support must add a matching row to the per-layer-type
  descriptor under `capabilities/` (e.g. `capabilities/circle.ts`) — NOT the assembler
  `capabilities.ts`, which just spreads them. Splitting by layer type keeps independent
  axes in different files so they never conflict. `__tests__/spec-coverage-runtime-drift.test.ts`
  fails on missing or stale entries.
- New public symbols must be added to `index.ts`; `playground/` and `site/` import
  exclusively from `@xgis/runtime`, never via deep paths.
- `vite-shims.ts` must stay a `.ts` file — `.gitignore` excludes `*.d.ts` in this tree.
- `earcut.d.ts` is hand-authored; do not delete it.

### Testing Requirements

- `__tests__/spec-coverage-runtime-drift.test.ts` — gates `capabilities.ts` against the
  compiler's spec-coverage list; must pass after any capability change.
- `__tests__/gap-matrix-freshness.test.ts` — detects stale gap-matrix entries.
- `__tests__/cross-validation.test.ts` — pins CPU projection/tile math to
  `cross-validation.fixture.json` (generated by the pyproj/mercantile/shapely harness
  under `scripts/cross-validation/`).
- `__tests__/epsg-reprojection-crossval.test.ts` — cross-validates EPSG reprojection.
- `engine/architecture-invariants.test.ts` — the LOC / package-DAG / projType ratchet. It
  is the SECOND LOC authority alongside `map/src/loc-ceiling-ratchet.test.ts`; growing a
  tracked file means updating both.
- Run `bun run build` before pushing — vitest does not typecheck, the build does.

### Common Patterns

- Capability variant values are exactly `'constant' | 'zoom-interp' | 'data-driven'`. Set
  `supported: false` only when the runtime drops/degrades input, and always add a `note`.
- Tests reach their subject through the package barrel (`@xgis/map`, `@xgis/data`), never
  a relative path across the package boundary.

## Dependencies

### Internal

- `@xgis/map`, `@xgis/data`, `@xgis/geo`, `@xgis/rhi-webgpu` — re-exported by the barrel.
- `@xgis/compiler` — type imports for the IR/style types used by the capability table.

### External

- `earcut` — polygon tessellation (bundled consumers).
- `@webgpu/types` — WebGPU TypeScript type definitions.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
