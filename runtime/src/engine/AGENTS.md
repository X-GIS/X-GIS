<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-29 -->

# engine

## Purpose

The engine directory is the top-level orchestration layer of the X-GIS WebGPU runtime. It contains the public `XGISMap` class and all of its structural decomposition modules: the per-frame render loop, camera/viewport API, source ingest, pick/interaction query, layer model, tile-resolution logic, and security hardening. It wires together the six specialist subdirectories (`gpu`, `projection`, `render`, `text`, `sprite`, `shaders`) into a single coherent map lifecycle. `map.ts` (~180 KB) is the highest-level orchestrator and remains the primary integration surface despite ongoing decomposition into sibling modules via injected-callback delegation (`CameraController`, `SourceManager`, `InteractionController`, `RenderLoop`).

## Key Files

| File | Description |
|---|---|
| `map.ts` | `XGISMap` class — the public API entry point. Owns the GPU context, camera, render loop, source registries, layer stacks, and the `run()` / `destroy()` / `renderFrame()` lifecycle. Delegates to CameraController, SourceManager, InteractionController, and RenderLoop via injected-callback decomposition. ~180 KB; #1 LOC file in the engine. |
| `render-loop.ts` | `RenderLoop` — the per-frame GPU render method extracted verbatim from `XGISMap.renderFrame`. Iterates a content-registered, frozen-order `RenderNode[]` (background → opaque → OIT → translucent → points → labels → heatmap → overdraw-compose) via `FrameContext` + `SceneView`; the engine no longer names a pass or hands it a `PassHost` (P2-carve Step 4). Reaches the rest of map state for frame orchestration through a typed `RenderLoopHost` Pick (the remaining `import type ./map` residual, allowed by the Gate-2 ratchet). |
| `render/render-node.ts` | `RenderNode` — the content-blind contract (`label` / `shouldRun(scene)` / `execute(ctx, scene)`) the render loop schedules. Imports only `FrameContext` + `SceneView`; content (`render/passes/pass-chain.ts`) builds + registers the concrete chain. |
| `render-loop-helpers.ts` | Pure, side-effect-free helpers extracted from the render path: per-show label paint resolution, ECEF projection helpers, world-copy offset math for the non-Mercator periodic set. No `this`, no module state — every function takes explicit inputs and returns a value. |
| `camera-controller.ts` | `CameraController` — owns Mapbox-API-parity camera/viewport methods (`setCenter`, `setZoom`, `jumpTo`, `easeTo`, `flyTo`, `fitBounds`, `panBy`, `getBounds`, `getCameraState`). First structural decomposition of `XGISMap`. Wired via injected `invalidate` / `getCanvas` callbacks; owns `_maxBounds` and `_cameraExplicitlyPositioned`. |
| `source-manager.ts` | `SourceManager` — owns GeoJSON/tile source ingest methods (`_attachOneSource`, `setSourceData`, EPSG reprojection path, polar-cap ordering). Second structural decomposition. Shares the `rawDatasets`/`vtSources`/`sourceCRS` Maps by reference with the host map; uses injected callbacks for `invalidate`, `rebuildLayers`, `teardownSource`. |
| `feature-update-queue.ts` | `FeatureUpdateQueue` — owns pending per-feature geometry/property patches (coalesced to one rAF flush per source). Extracted from `XGISMap` (2026-06-18 runtime redesign); behavior is a verbatim relocation — same execution order, O(patches) lazy feature index, warn-once for tile-backed sources. |
| `interaction-controller.ts` | `InteractionController` — owns pick/hit-test/coord-convert query methods (`pickAt`, `clientToLngLat`, `buildFeatureForEvent`, `lookupFeatureProperties`). Third structural decomposition. Owns the `pickReadbackPool`; reads GPU pick texture and projection name via fresh injected accessors (lazily populated, not captured at construction). |
| `event-dispatcher.ts` | `EventDispatcher` — bridges controller pointer events to per-layer listener registries. Tracks previous-frame `(layerId, featureId)` for `mouseenter`/`mouseleave` semantics. Uses rAF-coalesced `pointermove`; pick readback is one frame round-trip (~16 ms) by WebGPU design. |
| `map-event-bus.ts` | `MapEventBus` — map-level event listener state + dispatch extracted from `XGISMap` (2026-06-19 runtime redesign). Owns lifecycle/camera event registries and per-rAF camera-signature diffs that drive movestart/move/moveend, zoomstart/zoom/zoomend, and idle. Behavior is verbatim relocation. |
| `controller.ts` | `PanZoomController` + `Controller` interface — projection-aware pan/zoom/rotate input handler attached to the canvas. Fires click/hover/pointerdown/up/leave callbacks via `ControllerEvents` for downstream dispatch. |
| `auto-resize.ts` | `attachAutoResize()` — attaches a ResizeObserver on the canvas container and a mediaQuery DPR-change chain, both funneling to the existing public `resize()` callback. The render loop's rAF cadence debounces; per-frame `resizeCanvas()` is the single place that reconfigures the swapchain. |
| `tile-decision.ts` | `classifyTile` pure function — computes a tagged-union `TileDecision` (primary / overzoom-parent / upload-needed / ancestor-fallback / fetch / miss) for each visible tile from cache snapshots. Side-effect-free; unit-testable without a GPU context. Replaces an implicit `if…continue` cascade that caused two separate regressions. |
| `layer.ts` | `XGISLayer` + `XGISLayerStyle` — DOM-inspired layer API (`map.getLayer('id').style.opacity = 0.5`). `LayerIdRegistry` assigns stable u16 IDs (ID 0 = "no layer" sentinel) for the RG32Uint pick texture (R=featureId, G=(instanceId<<16)|layerId). `ListenerRegistry`/`MapEventRegistry` back `layer.addEventListener`. |
| `safety.ts` | Untrusted-input hardening: `XGISError` / `XGISInputError` / `XGISSecurityError` taxonomy, `assertSafeRemoteUrl` (SSRF guard for sprite/glyph/tile URLs), `assertIngestBudget` (OOM guard for GeoJSON byte budget), `readBodyCapped` (fetch body cap). Zero engine dependencies by design. |
| `interpreter.ts` | Translates compiler AST `ShowCommand` arrays into runtime `SceneCommands` via `synthesizeConstantPaintShapes`. Uses the nullable runtime `hexToRgba` (returns `null` on invalid hex) rather than the compiler's always-returns-tuple version. |
| `diagnostics.ts` | `inspectMapPipeline` / `captureMapSnapshot` / `replayMapSnapshot` — structured debug helpers exposed via `window.__xgisMap` / `window.__xgisSnapshot` / `window.__xgisReplaySnapshot`. The snapshot/replay path is the Playwright e2e harness hook. |
| `stats.ts` | `StatsTracker` + `StatsPanel` — per-frame GPU metrics (fps, draw calls, triangles, tiles visible/loaded/cached, RenderBundle cache hit/miss rate, GPUArena eviction count). `RenderStats` is the public data shape. |
| `graticule.ts` | Builds zoom-adaptive lat/lon grid lines in ECEF-DSFUN stride-9 format (`[ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, feat_id, abs_lon, abs_lat]`, major/minor distinction). Lives in the "no-tile" frame with RTC=(0,0,0). |
| `map-types.ts` | Extracted type declarations: `VariantPipelines` (fill/line/ground/pick/no-pick pipeline matrix), `TextOverlayOptions`, `TextOverlayHandle`, `XGISFontResource`, `XGISMapOptions`, `FontTypographyMap`. Lets sibling helpers import types without pulling in the full orchestrator. |
| `synthetic-earth-surface-show.ts` | Wires the synthetic ECEF earth-surface mesh as a standard `ShowCommand` injected at the head of the opaque pass, replacing the deleted `BackgroundRenderer`. |
| `geojson-polar-cap-show.ts` | Per-source polar-cap installation (issue #360 F1): synthesizes dedicated TileCatalog + VectorTileRenderer for GeoJSON sources whose outer rings touch Mercator clamp boundaries. Prepends a cap ShowCommand whose fill matches the source's polygon fill. Idempotent per source; no-op on mercator-class projections. |
| `debug-flags.ts` | URL-query-string debug toggles (`?debug=overdraw`, etc.) read once at module load. Runtime mutation is unsupported — most flags affect pipeline construction and would require a full rebuild. |
| `map-geo-helpers.ts` | Stateless helpers for style compilation: `buildTypographyMap`, `registerFonts`, `asVectorTileKind`, `sceneHasAnyAnimation`, `computeGeoJSONBounds`. Extracted from `map.ts` to keep the orchestrator shorter. |
| `feature-helpers.ts` | `parseHexColor`, `hexToRgba`, `applyFilter`, `applyGeometry` — shared utilities for feature property access and color parsing used across map, layer, and interpreter. |
| `show-source-maps.ts` | Builds `ShowSourceMaps` — reverse-lookup tables from source name to the `ShowCommand` list driving it. Avoids repeated linear scans during the render path. |
| `id-resolver.ts` | `toU32Id`, `pointPatchToFeatureCollection` — resolves u32 pick IDs back to feature identity and supports the `PointPatch` correction workflow. |
| `log.ts` | `xlog` — thin console wrapper with a level gate. `setLogSink` lets tests redirect output. |
| `color-ramp.ts` | Builds linear color ramp arrays for palette-texture upload (fill-extrusion height shading and data-driven color scales). |

## Subdirectories

| Directory | Purpose |
|---|---|
| `_cache/` | Build-time bundle-cache key derivation: `bundle-cache-key.ts` + `structural-key.ts` compute deterministic cache keys for RenderBundle reuse. See `_cache/AGENTS.md`. |
| `gpu/` | WebGPU device init, GPUArena byte-aware allocator, staging-buffer pool, palette texture, bind-tier helpers, compute path (`compute.ts`), quality config. See `gpu/AGENTS.md`. |
| `projection/` | Camera matrix math for all 8 projection surfaces (Mercator, globe/ECEF, equirect, natural-earth, oblique-mercator, azimuthal, stereographic, orthographic), world-copy logic, log-depth. See `projection/AGENTS.md`. |
| `render/` | All render passes, VectorTileRenderer (~5600 LOC, #1 debt file), RasterRenderer, PointRenderer, LineRenderer, BundleCache, bucket scheduler, prefetch-scheduler, FrameContext, RenderTargets, SceneView, compute-path wire-up. See `render/AGENTS.md`. |
| `shaders/` | Static WGSL utility modules (`log-depth.ts`, `projection.ts` — TypeScript wrappers that emit WGSL snippets) plus the `dsl/` child: the TypeScript DSL that emits WGSL, CPU projection mirrors, and overdraw/SDF/log-depth shaders. See `shaders/AGENTS.md`. |
| `sprite/` | Sprite atlas host + GPU upload, IconStage. See `sprite/AGENTS.md`. |
| `text/` | SDF glyph atlas, PBF glyph provider, TextStage, text-wrap/collision, curved-label strip, distance transform. See `text/AGENTS.md`. |
| `state/` | `dirty.ts` — `DirtyDomains` invalidation bitset (roadmap S3). Currently a write-only back-compat wrapper over `XGISMap._needsRender`; granular consumer skips land later. No child AGENTS.md. |

The `__profile__/` and `__tests__/` dirs hold perf-mark instrumentation and coverage-only test fixtures — not enumerated individually.

## For AI Agents

### Working In This Directory

- `map.ts` `private` fields were relaxed to no-modifier (package-internal) so `RenderLoop`, `CameraController`, `SourceManager`, and `InteractionController` can reach them via typed `Pick`. Do not re-privatize those fields.
- The four structural decompositions are **behavior-identical relocations**, not decouplings. Every moved method is verbatim; the only mechanical change is `this.X` → `this.host.X`. Do not introduce new abstractions when adding to these modules.
- `safety.ts` has zero engine dependencies by design — keep it that way. All remote-URL and ingest-budget checks must go through `assertSafeRemoteUrl` / `assertIngestBudget`.
- `tile-decision.ts` is a pure function with no side effects. Keep it that way — decisions must be unit-testable without a GPU context.
- `map.ts` is ~180 KB and growing. Prefer extracting new public methods to a sibling module (following the CameraController/SourceManager pattern) unless they are genuinely core to the class.
- Run `bun run build` before committing — vitest does not typecheck, and type errors here break the entire runtime package.
- Injected accessors (`getCtx()`, `getPickTexture()`, `getProjectionName()`, `getVectorTileShows()`) must be called fresh each frame — these point at lazily-populated or reassignable values, never captured at construction.

### Testing Requirements

- Unit tests live alongside source as `*.test.ts` (`tile-decision.test.ts`, `map-camera-api.test.ts`, `safety.test.ts`, `map-destroy.test.ts`, `controller-interaction-gate.test.ts`, `safety-ssrf-integration.test.ts`, `continent-match-compute-mock.test.ts`).
- Characterization tests (`map-rebuild-layers.characterization.test.ts`, `map-render-frame.characterization.test.ts`) lock the full render-frame behavior against a mock GPU. Run these before touching `render-loop.ts` or `map.ts`.
- End-to-end render verification runs in `playground/` via Playwright with a real WebGPU context; `diagnostics.ts` snapshot/replay is the e2e harness hook.
- CI runs under SwiftShader (no real GPU) — WGSL compile/compute gates pass; globe/non-Mercator visual render gates are local-only.

### Common Patterns

- **Injected-callback decomposition**: sub-controllers receive `invalidate`, `getCanvas`, and similar callbacks as constructor parameters. Shared state Maps are passed by reference at construction; never re-assign them.
- **Tagged-union decisions**: `TileDecision` is the model — exhaustiveness-checked tagged unions for multi-branch logic, not `if/else` chains. Adding a new variant flags every unhandled consumer at compile time.
- **No silent color fallbacks**: `hexToRgba` returns `null` on invalid input; callers must null-check. The compiler's always-returns-tuple version is intentionally not used here.
- **ECEF-DSFUN stride 9** is the canonical vertex layout for line/graticule geometry: `[ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, feat_id, abs_lon, abs_lat]`.

## Dependencies

### Internal

- `@xgis/compiler` — lexer/parser/IR/codegen; `tileKey`, `tileKeyChildren`, `tileKeyParent`, `PaintShapes`, AST types, `emitCommands`, `evaluate`, `deserializeXGB`, `resolveImportsAsync`
- `../data/` — `TileCatalog`, tile-select, workers (GeoJSON compile pool), sources (SyntheticEarthSurfaceBackend)
- `../loader/` — `lonLatToMercator`, `GeoJSONFeatureCollection`, `vector-tile-loader`
- `./gpu/`, `./projection/`, `./render/`, `./text/`, `./sprite/`, `./shaders/` (incl. `./shaders/dsl/`) — all specialist subdirs

### External

- No third-party npm dependencies in this directory (zero-deps policy). All geometry math is hand-rolled or comes from `@xgis/compiler`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
