<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# engine

## Purpose
The rendering engine core. `XGISMap` (`map.ts`) is the entry point that wires everything: it compiles `.xgis` source (Lexer→Parser→lower→optimize→emitCommands), loads sources, fits the camera, and drives the per-frame loop over the renderers. This dir holds the DOM-inspired layer API, the AST interpreter that turns show commands into render state, the per-tile resolution decision logic, pointer event dispatch, stats/diagnostics, color-ramp LUTs, graticule generation, and the feature-id resolver — plus the heavy subsystems in subdirectories (projections, GPU context, renderers, text/icon stages, shaders).

## Key Files
| File | Description |
|------|-------------|
| `map.ts` | `XGISMap` — top-level orchestrator. Compile pipeline, source load, camera fit, per-frame render loop, public Mapbox-style camera/style API. |
| `layer.ts` | `XGISLayer` + typed `.style` proxy (DOM-inspired: `getLayer` ≈ `getElementById`). `LayerIdRegistry` for the RG32Uint pick texture (R=featureId, G=(instanceId<<16)|layerId). |
| `interpreter.ts` | AST interpreter → `ShowCommand`s. Uses the nullable runtime `hexToRgba` (returns null on invalid hex, not opaque black). |
| `controller.ts` | Projection-aware camera controllers (pan/zoom/rotate/pitch input handling). |
| `tile-decision.ts` | `classifyTile` — pure function returning ONE explicit `TileDecision` per visible tile (replaces the VTR loop's implicit `if…continue` cascade that caused two regressions). |
| `event-dispatcher.ts` | Bridges pointer events → `pickAt` → per-layer `XGISFeatureEvent`; owns hover (layerId,featureId) state for mouseenter/leave. ~1-frame async readback latency. |
| `id-resolver.ts` | Stable feature-id resolver for pushed data (`feature.id` → `properties.id` → array index) so picking/updates survive retiles. |
| `feature-helpers.ts` | Pure GeoJSON/hex helpers shared by map load + VTR (color parsing). |
| `show-source-maps.ts` | Derives per-source attach-time config (extrude/stroke/label/filter) from compiled shows so workers skip emitting unused per-feature data. |
| `diagnostics.ts` | `inspectMapPipeline` / `captureMapSnapshot` / `replayMapSnapshot` — e2e snapshot+replay surface. |
| `stats.ts` | `StatsTracker` / `StatsPanel` — per-frame fps/draws/tris/tiles metrics. |
| `debug-flags.ts` | Page-load URL debug toggles (`?debug=`, mirrors `?safe`/`?gpuprof`/`?picking`). |
| `color-ramp.ts` | 256×1 RGBA ramp LUT textures (viridis etc.) for data-driven color. |
| `graticule.ts` | Lat/lon grid line generation (DSFUN stride-6, major/minor) in the no-tile frame. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `projection/` | Camera + 7 projections (CPU) + true-3D globe + WGSL mirror (see `projection/AGENTS.md`). |
| `gpu/` | WebGPU device/context, shared constants, compute dispatcher, frame/uniform/staging buffer management (see `gpu/AGENTS.md`). |
| `render/` | All draw-call renderers (vector-tile, line, point, raster, background) + compute-paint glue + scheduling (see `render/AGENTS.md`). |
| `shaders/` | Shared WGSL string blocks (projection, log-depth, SDF) (see `shaders/AGENTS.md`). |
| `text/` | SDF text pipeline: shaping, collision, atlas, rasterizers (see `text/AGENTS.md`). |
| `sprite/` | Sprite/icon atlas + icon renderer + stage (see `sprite/AGENTS.md`). |
| `_cache/` | Structural-key / versioned-state / bundle-cache-key primitives (see `_cache/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- `map.ts` is the orchestrator — keep its run sequence flat (preprocess → loadAll → cameraFit → rebuildLayers); push detail into helper modules (`show-source-maps.ts`, `feature-helpers.ts`).
- Picking is RG32Uint; layerId lives in the high bits of G. When adding layer/feature identity, route through `id-resolver.ts` so ids survive retiles.
- Debug flags are page-load only (they affect pipeline construction) — don't make them runtime-mutable.

### Testing Requirements
- Large colocated suite (`map-*.test.ts`, `tile-decision*.test.ts`, `id-resolver.test.ts`, `interpreter-*`, hex/color validation). Add a `map-*.test.ts` for new public camera/style API and a `tile-decision` case for new per-tile branches.

### Common Patterns
- Pure-function extraction from orchestrators for testability (`tile-decision`, `feature-helpers`, `show-source-maps`).
- Nullable `hexToRgba` for validation paths; never silently render invalid hex as black.

## Dependencies

### Internal
- `@xgis/compiler` (full compile pipeline + `evaluate`), `loader/`, `data/`, all `engine/` subdirs.

### External
- `@webgpu/types`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
