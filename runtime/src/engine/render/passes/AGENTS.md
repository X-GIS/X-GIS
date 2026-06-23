<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-23 -->

# passes

## Purpose
Contains the fixed linear render-pass chain that structures every GPU frame in X-GIS. Each file implements the `RenderPass` interface (defined in `pass.ts`) and represents one bucket of the pipeline: background → opaque → OIT → translucent → points → labels → overdraw-compose. All passes are stateless singletons — no per-frame allocation — that receive a `FrameContext` + `SceneView` + `PassHost` (the owning map's renderer view) and emit `GPURenderPassEncoder` commands. These objects were extracted verbatim from inline `passScope` blocks in `RenderLoop.render` during the engine redesign; behaviour is byte-identical to the original inline code.

## Key Files

| File | Description |
|---|---|
| `pass.ts` | Defines the `RenderPass` interface (`label`, `shouldRun`, `execute`) and the `PassHost` type alias used by all passes to reach renderers, camera, and map state. |
| `pass-hosts.ts` | Defines segmented per-pass / per-concern role views (`BackgroundPassHost`, `OpaquePassHost`, `OitPassHost`, `TranslucentPassHost`, `PointsPassHost`, `LabelPassHost`, `HeatmapPassHost`) as `Pick<XGISMap>` types, replacing the monolithic flat `RenderLoopHost` to reduce serialization collisions and make host types per-role and maintainable. |
| `background-pass.ts` | Bucket 0: clears the whole-viewport colour target each frame using `backgroundClearValue()` — a pure, unit-testable function that picks the clear colour by projection kind (flat/cylindrical → style background colour; disc/globe → pure-black space; overdraw mode → `a:0` accumulator zero). Never claims `resolveTarget`; never clears depth/stencil (those are bucket-1 concerns). |
| `opaque-pass.ts` | Bucket 1: iterates `scene.opaqueGroups`, emitting one sub-pass per group. The first sub-pass loads colour (background pass owns the clear), clears depth/stencil/pick attachments, and runs the raster renderer + legacy MapRenderer. Each sub-pass renders its group's tile shows in two phases — 2D ground fills first, then 3D extruded fills — to maintain correct cross-tile depth ordering at pitch. Manages the `resolveTarget` chain and the `?debug=overdraw` pipeline override. |
| `oit-pass.ts` | Bucket 1.5: McGuire-Bavoil order-independent transparency for translucent extruded fills. Accumulates into `oitAccumTexture` / `oitRevealageTexture` MRT pair (depth-load from opaque, no depth-write), then composites the recovered colour onto the main target via a fullscreen oversized-triangle draw. Gated off when `scene.hasOit` is false or `?debug=overdraw`. |
| `translucent-pass.ts` | Bucket 2: for each translucent-stroke show, renders strokes into `LineRenderer`'s offscreen MAX-blend target, then composites at the show's resolved opacity onto the main colour target. Runs after all opaque buckets so strokes always paint on top. Gated off when `scene.hasTranslucent` is false or `?debug=overdraw`. |
| `points-pass.ts` | Bucket 3: renders `pointRenderer.layers` (GeoJSON direct-layer point sources). Loads the opaque depth so billboards on the far side of a pitched or globe surface are occluded; depth-test enabled, depth-write disabled. Tile-sourced points draw inline in opaque bucket through VTR, not here. Gated off when `scene.hasPoints` is false or `?debug=overdraw`. |
| `label-pass.ts` | Bucket 4: the largest pass (~1000 LOC). Resolves per-feature label and icon work for all `ShowCommand.label` entries and imperative `map.addOverlay` overlays. Owns world-copy iteration, the flat-vs-ECEF label projector fork (matching the geometry MVP), point and line/curve label placement, per-feature expression evaluation (with a `WeakMap` cache keyed on props + zoom bucket), cross-tile duplicate suppression, icon dispatch to `IconStage`, and the final `text-overlay` sub-pass flush. Also sets `ctx.visibleWorldCopies` for downstream consumers. |
| `heatmap-pass.ts` | Bucket 5 (Phase R): renders direct-layer (GeoJSON-source) heatmap layers as a 3-pass GPU pipeline (accumulate density → separable Gaussian blur → colour-ramp compose). Runs after label pass (avoids MSAA resolve-ownership hazard) and composes onto the resolved swapchain. Lazily ensures heatmap targets per frame; gated off when `scene.hasHeatmap` is false or `?debug=overdraw`. |
| `overdraw-compose-pass.ts` | Debug-only bucket: reads the `r16float` fragment-count accumulator and colourmap-composites it to the swapchain. Active only when `DEBUG_OVERDRAW` is set at build time; runs last so it writes the final swapchain attachment. |

## For AI Agents

### Working In This Directory
- **Passes are stateless.** No instance fields. Per-frame state lives in `FrameContext` or `SceneView`; cross-frame state belongs on the `PassHost` (map).
- **`shouldRun` is the only guard.** The `RenderLoop` calls `shouldRun` before `execute`; passes must not re-check scene conditions redundantly inside `execute` except for truly exceptional paths.
- **Colour clear ownership is strict.** `background-pass.ts` owns the colour target clear (bucket 0); `opaque-pass.ts` always uses `loadOp: 'load'`. Do not add a `clearValue` + `loadOp: 'clear'` to any colour attachment in opaque or later passes.
- **Depth persistence contract.** Depth is stored (`depthStoreOp: 'store'`) by the last opaque sub-pass when `scene.hasPoints || scene.hasOit`; the points and OIT passes load it (`depthLoadOp: 'load'`). Breaking this chain causes billboards or translucent buildings to ignore opaque foreground occlusion.
- **`resolveOwner` chain.** MSAA resolve (`resolveTarget: ctx.screenView`) belongs to exactly one pass per frame, determined by `scene.resolveOwner` in `SceneView`. Assigning `resolveTarget` in the wrong pass produces a WebGPU validation error.
- **`?debug=overdraw` disables most passes.** `translucent`, `oit`, `points`, and `labels` all gate off; only `background`, `opaque` (with overdraw pipeline override), and `overdraw-compose` run. The accumulator clear (`a:0`) must come from `background-pass`; do not re-introduce it in `opaque-pass`.
- **Label projector fork must stay in lockstep with the geometry MVP.** `label-pass.ts` selects flat vs ECEF projector using `!globeMode && !isGlobeProj(projType)` — the same test `getViewForProjection` uses. If you change the geometry MVP selection, update the label projector fork to match.
- **Do not split hot loops** in `label-pass.ts` without profiling; the per-feature dispatch loop is already perf-marked (`encoder.label-dispatch.*`).

### Testing Requirements
- `background-pass-clear-value.test.ts` — unit tests for `backgroundClearValue()` covering all 8 projection types, overdraw mode, and the structural invariant that `opaque-pass.ts` uses `loadOp: 'load'`. Run with `vitest`.
- `synthetic-earth-surface-overdraw.test.ts` — structural + unit tests verifying that `SyntheticEarthSurfaceBackend` produces a valid `BackendTileResult`, routes through the non-extruded opaque path, and that the overdraw pipeline override in `opaque-pass.ts` applies unconditionally. Run with `vitest`.
- GPU/render behaviour (correct pass ordering, MSAA resolve, depth persistence) is not covered by unit tests here — it requires the playground e2e suite or a local headed GPU run against the render-verification harness (`feat/render-verification-harness`).

### Common Patterns
- **Singleton export:** every pass file ends with `export const xPass: RenderPass = new XPass()`.
- **`ctx.passScope(label, fn)`** wraps every `encoder.beginRenderPass` call for GPU timeline labelling.
- **`DEBUG_OVERDRAW` import from `../../debug-flags`** is the build-time gate for all debug paths; evaluate it at `shouldRun` time, not inside `execute`.
- **Verbatim relocation comments** at the top of each file document what inline block was extracted and what mechanical substitutions were made (`this.host.X` → `host.X`); preserve these for future readers.

## Dependencies

### Internal
- `../frame-context` — `FrameContext`: per-frame GPU resources (encoder, textures, projection scalars, MSAA views)
- `../scene-view` — `SceneView`: pre-computed per-frame scene summary (opaque groups, OIT/translucent/points flags, resolveOwner)
- `../../render-loop` — `RenderLoopHost`: typed Pick of the map exposing renderers, camera, and GPU context
- `../../debug-flags` — `DEBUG_OVERDRAW` build-time constant
- `../../projection/projections-table` — `worldBandForProjType`, `isGlobeProj` (projection classification)
- `../../shader-dsl/shaders/cpu-projections` — `projMercatorCpu` (clamped CPU Mercator mirror for label anchors)
- `../../render-loop-helpers` — `makeLabelProjectors`, `resolveLabelEffectiveDef`
- `../../text/text-stage`, `../../sprite/icon-stage` — glyph/SDF and icon atlas flush
- `@xgis/compiler` — `evaluate`, `makeEvalProps`, `resolveColor` (per-feature expression evaluation)

### External
- No npm runtime dependencies beyond the monorepo. Test files use `vitest` and Node's `node:fs`/`node:path` for structural source-text assertions.

<!-- MANUAL: notes below this line are preserved on regeneration -->
