<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# debug

## Purpose
CPU-only dry-run models of the tile pipeline used to debug "empty screen / flicker at high pitch or over-zoom" without touching WebGPU, tile loaders, or the live cache. The predictor answers a single frame's frustum demand; the simulator extends that to a sequence of frames, modelling the runtime constraints (bounded GPU cache LRU, per-frame upload budget) that shape what actually ends up visible.

## Key Files
| File | Description |
|------|-------------|
| `tile-pipeline-predictor.ts` | One-frame CPU dry-run of tile selection given camera + source `maxLevel` + canvas size. Exports `predictTilePipeline` and `SUB_TILE_BUDGET_PER_FRAME=2`. Reports `visibleTiles`, `overzoomLevels`, `parentTiles`, `coldConvergenceFrames`, and `cacheCapacityCheck` (with `saturated` flag when the frustum hit `MAX_FRUSTUM_TILES`). |
| `tile-pipeline-simulator.ts` | Multi-frame CPU model of cache + upload throughput. Simulates a FIFO upload queue draining at `uploadBudgetPerFrame` (default 4, matches `MAX_UPLOADS_PER_FRAME` desktop in `vector-tile-renderer-helpers.ts`) against a bounded LRU cache (`cacheSize` default 512 — **note**: real desktop cap is now 256 in `vector-tile-renderer-helpers.ts:16`; pass `cacheSize:256` for accurate results). Also exports `makePitchSweep` to build pitch-ramp trajectories. |

## For AI Agents

### Working In This Directory
- These are diagnostic models, NOT the live pipeline. When predictor/simulator and reality disagree, the model is the bug-finding tool — but the constants must stay in sync with the real values in `engine/render/vector-tile-renderer-helpers.ts`.
- **GPU tile cap is now tiered**: desktop `MAX_GPU_TILES_DESKTOP=256`, mobile `MAX_GPU_TILES_MOBILE=64` (exported via `getMaxGpuTiles()`). The simulator's default `cacheSize=512` is stale — pass `{cacheSize:256}` for desktop scenarios.
- **Upload budget is also tiered**: `MAX_UPLOADS_PER_FRAME=4` desktop, `1` mobile (via `uploadBudgetFor()`). Pass `{uploadBudgetPerFrame:1}` to simulate mobile.
- `MAX_FRUSTUM_TILES` is dynamic (capped at 300 desktop / varies by canvas); the `saturated` flag in `cacheCapacityCheck` signals when the frustum clipped its output — `fitsIn*` verdicts understate true demand when saturated.
- Use predictor before assuming a render bug: confirm frustum demand and cache/upload pacing first.

### Testing Requirements
- `tile-pipeline-predictor.test.ts`, `tile-pipeline-simulator.test.ts`. When VTR budget constants in `vector-tile-renderer-helpers.ts` change, update the mirrored constants here and the tests.

### Common Patterns
- Pure CPU simulation over camera/source/canvas inputs. Mirrors live VTR constants — keep them aligned.
- `makePitchSweep` builds a camera trajectory array; feed directly into `simulateTilePipeline` to reproduce flicker scenarios.

## Dependencies

### Internal
- `data/tile-select` (frustum selection via `visibleTilesFrustum`), `engine/projection/camera` + `engine/projection/projection` (Camera + mercator proj), `@xgis/compiler` (tile keys via `predictTilePipeline` import chain).

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
