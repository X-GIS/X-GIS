<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# diagnostics

## Purpose
Holds the render-trace subsystem — a zero-cost structured capture of every frame's GPU intent: resolved per-layer paint (fill/stroke colour, opacity, dash, AA width), per-label text/colour/halo/placement/collision state, and the tile-LOD decision. Produces `FrameTrace` JSON consumed by two paths: vitest invariant tests that assert on resolved values without firing a WebGPU pass, and Playwright e2e specs that capture a live frame's trace alongside screenshots. Part of the "X-GIS as a compiler" design: the trace is the diffable record of renderer decisions, used to localise visual regressions vs MapLibre, across projections, and across builds — upstream of pixel noise.

## Key Files
| File | Description |
|------|-------------|
| `render-trace.ts` | Defines `FrameTrace`, `TraceLayer`, `TraceLabel`, `TraceTileLOD`, `CameraTraceSnapshot` types; `RenderTraceRecorder` interface (four record methods + `snapshot()`); `InMemoryTraceRecorder` class (accumulates per-frame, resets on `snapshot()`); `createTraceRecorder()` factory. Production cost is zero — every emit site guards on `traceRecorder !== null`, V8 branch-predicts the null check away; `--define:__DEV_TRACE__=false` enables dead-code elimination at build time. |

## For AI Agents

### Working In This Directory
- `TraceLayer`, `TraceLabel`, `TraceTileLOD` field names are a cross-build diff contract — rename only with a migration note. Downstream vitest snapshots break on field renames.
- The recorder must consume the SAME `ResolvedShow` / paint-shape-resolve outputs the renderers consume — do not re-evaluate style expressions independently here or trace and picture will diverge.
- `InMemoryTraceRecorder.snapshot()` resets all internal state; callers driving multi-frame replays rely on this being idempotent.
- `TraceLayer.dashArrayMeters` is in Mercator metres (already scaled by mpp × line-width); `TraceLabel.halo.width` is pre-DPR CSS px — keep these units stable.
- Components that carry a `traceRecorder?: RenderTraceRecorder` field: VTR, LineRenderer, TextStage, bucket-scheduler. All are optional/null in production.

### Testing Requirements
- `render-trace.test.ts` covers: empty-trace baseline, camera record, tile-LOD record, layer accumulation order, label accumulation order, snapshot-reset reuse, and factory function. Add a field-coverage case for any new field added to `FrameTrace` or its sub-types before merging.

### Common Patterns
- Consumers: `const rec = createTraceRecorder(); map.setTraceRecorder(rec);` — no need to import the class.
- Extend via new `record*` methods on the `RenderTraceRecorder` interface; keep the interface small — only add a method when a concrete invariant test needs it.

## Dependencies

### Internal
- `engine/render` — `ResolvedShow` and paint-shape-resolve outputs that `TraceLayer` values mirror.
- `@xgis/compiler` types (layer/label identity strings).

### External
- None.
