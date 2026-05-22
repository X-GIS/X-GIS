<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# workers

## Purpose
Web Worker threads + their main-thread pool wrappers that run the heavy tile pipeline off the main thread: MVT decode/decompose/compile/line-segment-build, GeoJSON decompose+compile (earcut), and the geojsonvt tiling that backs the virtual-PMTiles path. The main thread pays only the structured-clone in and the zero-copy typed-array transfer back — never the earcut/compile cost.

## Key Files
| File | Description |
|------|-------------|
| `mvt-worker.ts` | MVT compile worker. `bytes → decodeMvtTile → groupBy(_layer)`; per layer `decomposeFeatures → compileSingleTile → buildLineSegments ×2`. Emits per-MVT-layer slices with Transferable buffers. |
| `mvt-worker-pool.ts` | Round-robin dispatch across N MVT workers. Stores each slice under `(key, layerName)` so one source serves multiple `sourceLayer`-filtered passes. Defines `MvtCompileSlice` (wrapped TypedArray views). |
| `geojson-compile-worker.ts` | Runs `decomposeFeatures` + `compileGeoJSONToTiles` (earcut + line-segment build) for inline GeoJSON; returns Transferable buffers. |
| `geojson-compile-pool.ts` | Shared per-page pool, round-robin, lazy spawn, sync fallback when `new Worker()` is unavailable (SSR/vitest). |
| `geojson-tiling-worker.ts` | Stateful geojsonvt + MVT-encode worker — retains one index per source name, services per-tile `get-tile` requests; echoes the Morton `tileKey` back for routing. |
| `geojson-tiling-pool.ts` | Single-worker main-thread wrapper: `setSource(name, geojson, opts)`, `getTile(name, z, x, y, key)` (empty `Uint8Array` = no features). |

## For AI Agents

### Working In This Directory
- Worker files are bundled separately (`?worker` imports). Keep their imports WebGPU-free and minimal — only `@xgis/compiler` pipeline functions and `core/`/`data/eval` pure helpers.
- All returned buffers must be marked Transferable (zero-copy). Don't return live views into a buffer you also keep — transfer detaches it.
- Pools must provide a synchronous fallback path so vitest/SSR (no `Worker`) still works.
- The MVT and GeoJSON compile paths use the SAME compiler functions; keep them aligned so both inherit fixes.

### Testing Requirements
- `mvt-worker.test.ts` (worker-pool spec lives in `mvt-worker-pool.ts`'s consumers), `geojson-compile-worker.test.ts`. Validate Transferable correctness + the sync fallback.

### Common Patterns
- Wire protocol = tagged `{ kind: ... }` messages. Per-MVT-layer slices keyed `(key, layerName)`. Morton `tileKey` round-tripped for response routing.

## Dependencies

### Internal
- `@xgis/compiler` (`decodeMvtTile`, `decomposeFeatures`, `compileSingleTile`/`compileGeoJSONToTiles`, geojson-vt port), `core/line-segment-build`, `data/eval`.

### External
- `geojson-vt`, `vt-pbf` (in the tiling worker).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
