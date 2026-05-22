<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# diagnostics

## Purpose
Captures the INTENT a frame submits to the GPU — every layer's resolved paint state, every label's resolved text/color/halo, every tile-LOD decision — as a structured `FrameTrace` JSON. Part of the "X-GIS as a compiler" plan: the trace is the observable, diffable record of what the renderer decided each frame, used to localise visual divergences (vs MapLibre, across projections, across builds) without re-deriving state from GPU buffers.

## Key Files
| File | Description |
|------|-------------|
| `render-trace.ts` | `FrameTrace` capture — records resolved per-layer paint, per-label resolved text/color/halo, and per-tile LOD decisions into structured JSON for inspection/replay. |

## For AI Agents

### Working In This Directory
- This records resolved render state — it must read the SAME `ResolvedShow` / paint-shape-resolve outputs the renderers consume, not re-evaluate expressions independently, or the trace and the picture diverge.
- The trace is a debugging contract for divergence localisation; keep field names stable so cross-build diffs stay meaningful.

### Testing Requirements
- `render-trace.test.ts`. Add a field-coverage case when extending the trace shape.

### Common Patterns
- Structured-JSON snapshot of per-frame intent (paint + labels + LOD), keyed for diffing.

## Dependencies

### Internal
- `engine/render` (`ResolvedShow`, paint-shape-resolve outputs), `@xgis/compiler` types.

### External
- None.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
