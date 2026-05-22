<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# debug

## Purpose
CPU-only dry-run models of the tile pipeline, used to debug "empty screen at high pitch / over-zoom" without touching WebGPU, the real tile loaders, or the cache. The predictor answers a single frame's frustum demand; the simulator extends that to a sequence of frames, modelling the runtime constraints (bounded GPU cache LRU, per-frame upload budget) that shape what actually ends up visible.

## Key Files
| File | Description |
|------|-------------|
| `tile-pipeline-predictor.ts` | One-frame CPU dry-run of tile selection given camera + source `maxLevel` + canvas size — predicts how many tiles `visibleTilesFrustum` wants, with no GPU/loader/cache. |
| `tile-pipeline-simulator.ts` | Multi-frame CPU model of cache + upload throughput — simulates `MAX_GPU_TILES≈512` LRU, `MAX_UPLOADS_PER_FRAME≈4`, and ancestor fallback to predict when tiles become visible across a frame sequence. |

## For AI Agents

### Working In This Directory
- These are diagnostic models, NOT the live pipeline. When the predictor/simulator and reality disagree, the model is the bug-finding tool — but the constants (`MAX_GPU_TILES`, `MAX_UPLOADS_PER_FRAME`) must be kept in sync with the real values in `engine/render/vector-tile-renderer.ts` or the model lies.
- Use these before assuming a render bug: confirm the frustum demand and cache/upload pacing first.

### Testing Requirements
- `tile-pipeline-predictor.test.ts`, `tile-pipeline-simulator.test.ts`. When VTR budget constants change, update the mirrored constants here and the tests.

### Common Patterns
- Pure CPU simulation over camera/source/canvas inputs. Mirrors live VTR constants — keep them aligned.

## Dependencies

### Internal
- `data/tile-select` / `loader/tiles-sse` (selection math), `engine/projection` (camera), `@xgis/compiler` (tile keys).

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
