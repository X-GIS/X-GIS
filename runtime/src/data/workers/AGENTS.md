<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-03 -->

# workers

## Purpose
Web Worker threads and their main-thread pool wrappers that run the heavy tile-decode/compile pipeline off the main thread. Three distinct pipelines live here: (1) MVT decode → per-`_layer` group → `decomposeFeatures` + `compileSingleTile` + `buildLineSegments` × 2 for PMTiles/TileJSON sources; (2) GeoJSON earcut compile (`decomposeFeatures` + `compileGeoJSONToTiles`) for inline GeoJSON sources; (3) stateful geojsonvt + MVT-encode worker that backs the virtual-PMTiles path. The main thread pays only the structured-clone in and the zero-copy `ArrayBuffer` transfer back — never the earcut or MVT-decode cost. All pools expose `getShared*()` singletons and are prewarmed at map bootstrap to overlap worker-spawn latency with PMTiles metadata round-trips.

## Key Files

| File | Description |
|------|-------------|
| `mvt-worker.ts` | MVT compile worker. Receives raw `bytes + z/x/y + showSlices descriptor`. Decodes with `decodeMvtTile`, groups by `_layer`, then calls `emitSlice` per `(sliceKey, sourceLayer, filter)` triple. Also bakes per-feature stroke widths (`extractFeatureWidths`, `$zoom`-injected via `makeEvalProps`), stroke colours (`extractFeatureColors`, RGBA8 → little-endian u32 for `unpack4x8unorm`), and extrude heights/bases into the transferred buffers. Supports a legacy "one slice per MVT layer" fallback when `showSlices` is absent. |
| `mvt-worker-pool.ts` | Round-robin `MvtWorkerPool` (2–6 workers, capped at 2 on mobile-width viewports). Buffers worker results in a `resolveQueue` and drains at most 4 per rAF tick (`MAX_RESOLVES_PER_FRAME`) to prevent a 138–200 ms hitch on LOD transitions. Wraps transferred `ArrayBuffer`s into typed-array views (`Float32Array`/`Uint32Array`) at drain time. Exposes `getSharedMvtPool()` singleton and `prewarmMvtWorkerPool()`. Diagnostic counters (`totalResolved`, `totalDrains`, `maxDrainSize`, `totalDrainMs`) are polled by perf specs via `globalThis.__XGIS_MVT_POOL`. |
| `geojson-compile-worker.ts` | GeoJSON compile worker and its shared logic. `runCompile()` is exported so both the worker entry-point and the pool's sync fallback share identical code. Serializes every `CompiledTile` typed array into `ArrayBuffer` for transfer; the receiver rebuilds `Float32Array`/`Uint32Array` views. `IdResolverMode` enum bridges the non-clonable id-resolver function across the boundary. Gates worker listener registration on `DedicatedWorkerGlobalScope` detection so the module can be imported safely in vitest. |
| `geojson-compile-pool.ts` | `GeoJSONCompilePool` class + `getSharedGeoJSONCompilePool()` singleton. 1–4 workers (half of `hardwareConcurrency`, capped at 4 — GeoJSON compile is one-shot per source, not per-tile). Falls back to main-thread `runCompile` when `new Worker()` throws (`workersUnavailable` latch). `deserializeResponse` and `serializedTileToLive` both reconstruct live `CompiledTile` objects from the transferred `ArrayBuffer`s. |
| `geojson-tiling-worker.ts` | Stateful geojsonvt + `encodeMVT` worker. Maintains a `Map<string, GeoJSONVT>` of named source indexes; `set-source` builds the index, `get-tile` slices it and MVT-encodes the result. Returns an empty `Uint8Array` (not an error) when the tile has no features. Morton `tileKey` echoed back in every response for main-thread routing without re-deriving `(z, x, y)`. |
| `geojson-tiling-pool.ts` | Single-worker main-thread wrapper for the tiling worker. Lazy spawn via `getWorker()`; crashed worker resets `_worker = null` and rejects all outstanding promises. Exports `setSource`, `getTile`, and `disposeGeoJSONTilingPool` (test cleanup). Uses `taskId` counter + `pendingSetSource`/`pendingGetTile` maps for in-flight routing. |

## For AI Agents

### Working In This Directory
- Worker files are bundled separately by Vite (`?worker` imports in the pool files). Keep worker-side imports WebGPU-free and minimal — only `@xgis/compiler` pipeline functions, `core/line-segment-build`, and `data/eval` pure helpers.
- All returned typed-array buffers must be marked Transferable. Never return a view into a buffer you also retain — `postMessage` with transfer detaches it. The `transferables` list must include every `ArrayBuffer` whose `.byteLength > 0`.
- Per-feature stroke width expressions require `$zoom` injected via `makeEvalProps` (not a raw `{ zoom: tileZoom }` bag). Without the reserved key the evaluator returns `undefined`, `toNumber(null)` → 0, and every width entry is silently dropped.
- Per-feature colour expressions accept all four CSS hex forms (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`). Short forms must be expanded before packing. Alpha = 0 is the "no override" sentinel so the WGSL `unpack4x8unorm` shader falls back to the layer-uniform colour.
- The MVT pool drains at most 4 resolves per rAF tick. Do not call `job.resolve()` directly in the message handler — push to `resolveQueue` first, then `scheduleResolveDrain`. Breaking this causes single-frame hitches on LOD transitions.
- The GeoJSON compile pool must provide a sync fallback (`compileSync` via `runCompile`) so vitest/SSR environments (where `new Worker()` throws) still work. The `workersUnavailable` latch prevents retrying a failed spawn on every call.
- MVT and GeoJSON compile paths use the same `@xgis/compiler` functions (`decomposeFeatures`, `compileSingleTile`/`compileGeoJSONToTiles`). Keep them aligned — a bug fix in one almost certainly applies to the other.

### Testing Requirements
- `geojson-compile-worker.test.ts` covers the compile worker and pool (transfer correctness, sync fallback, `IdResolverMode`). No dedicated `mvt-worker.test.ts` exists at this level; MVT pool behaviour is exercised through consumer integration tests in `data/` and the perf spec `_perf-bright-transition-profile.spec.ts` which polls `globalThis.__XGIS_MVT_POOL`.
- Run `bun run build` (not just `vitest`) before pushing — vitest does not typecheck; build errors in worker message-protocol types only surface at compile time.

### Common Patterns
- Tagged `{ kind: '...' }` wire protocol on both directions. `taskId: number` correlates every request to its response in the pending map.
- Slices keyed `(tileKey, sliceKey)` — `sliceKey` equals `layerName` in the legacy path and the compound show key in the `showSlices` path.
- Lazy singleton pools via a module-level `let sharedPool: … | null = null` + a `getShared*()` accessor. The MVT pool also exposes `prewarmMvtWorkerPool()` for eager spawn at map bootstrap.
- Diagnostic counters on `MvtWorkerPool` (`totalResolved`, `totalDrains`, `maxDrainSize`, `totalDrainMs`) are cheap integer writes, never read in production, and polled by perf specs only.

## Dependencies

### Internal
- `@xgis/compiler` — `decodeMvtTile`, `decomposeFeatures`, `compileSingleTile`, `compileGeoJSONToTiles`, `evaluate`, `makeEvalProps`, `geojsonvt`, `encodeMVT`, `GeoJSONVT`, `GeoJSONVTOptions`, `RingPolygon`, various compiled-tile types.
- `../../core/line-segment-build` — `buildLineSegments` (called in MVT worker to pre-build outline + line segment buffers off-thread).
- `../../data/eval/extrude-eval` — `evalExtrudeExpr` (per-feature extrude height/base resolution).
- `../../data/eval/filter-eval` — `evalFilterExpr` (per-`showSlice` feature filter in MVT worker).
- `../../engine/id-resolver` — `toU32Id` (GeoJSON compile worker id-resolver).
- `../../loader/geojson` — `GeoJSONFeature`, `GeoJSONFeatureCollection` types.

### External
- No additional npm dependencies beyond `@xgis/compiler` (which bundles geojsonvt + vt-pbf). The tiling worker uses `geojsonvt` and `encodeMVT` exclusively through the compiler package re-export.

<!-- MANUAL: notes below this line are preserved on regeneration -->
