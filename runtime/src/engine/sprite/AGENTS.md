<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-03 -->

# sprite

## Purpose
Sprite/icon rendering — the icon counterpart to the SDF text pipeline. Implements the full Mapbox/MapLibre sprite protocol: fetches `${spriteUrl}.json` + `${spriteUrl}.png` (with `@2x` high-DPR fallback), exposes per-icon UV/size lookups, uploads the atlas to a single WebGPU texture, and renders icon quads (POI markers, highway shields, fill-pattern colour sampling) via a dedicated render pipeline. Raster and SDF sprites are batched together in one draw call using a per-vertex `sdf` flag. `IconStage` is the per-frame orchestrator (`addIcon` → `prepare` → `render`), mirroring `TextStage` in `engine/text`. SSRF guards and body-size caps are applied at fetch time (32 MB PNG / 16 MB JSON ceilings).

## Key Files

| File | Description |
|------|-------------|
| `sprite-atlas-host.ts` | Fetches `${spriteUrl}.json` + `${spriteUrl}.png`; applies `assertSafeRemoteUrl` SSRF guard + `readBodyCapped` size caps before loading. Exposes `SpriteInfo` UV/size lookups via sync `get()` after `whenReady()`. `getSpriteCenterColor()` does OffscreenCanvas centre-pixel readback (lazy, cached) used by fill-pattern Stage 1 to derive a flat fill colour. Degrades silently to `status:'failed'` on SSRF rejection, 404, or body-size overrun. |
| `sprite-atlas-gpu.ts` | Wraps `SpriteAtlasHost` with a WebGPU texture upload (`rgba8unorm`, linear+clamp-to-edge sampler). `ensure()` is idempotent — first call uploads, subsequent calls return the cached handle. `getView()` returns a cached `GPUTextureView` (iter-183 fill-pattern Stage 2); caller pushes the view into `VectorTileRenderer` via `setSpriteAtlasView`. `size()` returns `{width,height}` of the loaded image, `{0,0}` when not ready. |
| `icon-vertex-format.ts` | Single source of truth for the icon quad vertex layout (`ICON_FORMAT`): `pos_px` (vec2), `uv` (vec2), `opacity` (f32), `tint` (vec3), `sdf` (f32) — stride 36 bytes. Both the GPU buffer layout and the CPU packer in `icon-renderer.ts` derive from this via `vertexField(ICON_FORMAT, …)` to prevent slot drift. |
| `icon-renderer.ts` | Low-level WebGPU pipeline: screen-pixel quads → NDC, atlas texture sample. Fragment selects raster vs SDF path via per-vertex `sdf` float; SDF sprites use `fwidth`-based AA and accept `icon-color` tint. Uses a grow-but-never-shrink `Float32Array` scratch (iter-234) with 1.5× hysteresis to avoid per-frame allocations. Exposes diagnostic properties (`firstVertexSample`, `lastVertexBBox`, `lastAtlasSize`, `lastDrawViewport`, `bboxDiagnosticEnabled`) for debug tooling; `destroy()` tears down GPU buffers. |
| `icon-stage.ts` | Per-frame orchestrator over `SpriteAtlasHost` + `SpriteAtlasGPU` + `IconRenderer`. Paired-symbol collision (iter-112): icons whose `pairKey` matched a text-label collision-reject are silently dropped before `prepare()`. Exposes `getMissingIconNames()` / `getDispatchedIconNames()` diagnostics, `getLastDrawIconCount()` (vertex-buffer-derived), `getLastDrawSample()` (firstVertex + atlasSize + vertexBBox + drawViewport), `_iconDump` per-frame placement capture, and `_iconDebugHook` for test harnesses. `destroy()` delegates to renderer + GPU. |

## For AI Agents

### Working In This Directory
- The add→prepare→render lifecycle mirrors `TextStage` exactly — keep the two structurally parallel so fixes transfer across both.
- One batch mixes raster and SDF quads via the per-vertex `sdf` float. Never split into two pipelines or two draw calls — that is a deliberate design choice.
- Highway shields pair an icon from this dir with text from `engine/text`; text-vs-box vertical alignment is historically fragile (shield text floats above box). Verify both halves together using `setIconDumpEnabled` + `setLabelDebugHook` to collect anchor coordinates.
- Anchors arrive already in physical screen pixels (the caller projects lon/lat → screen px). The renderer does only px → NDC; it does not touch projection.
- `SpriteAtlasHost` degrades to `status:'failed'` silently on SSRF guard rejection, 404, or body-size overrun. Downstream renderers no-op cleanly.
- Paired-symbol collision: call `setDroppedPairKeys()` on `IconStage` AFTER `TextStage.prepare()` and BEFORE `IconStage.prepare()` each frame. The order is load-bearing.
- `SpriteAtlasGPU.getView()` caches the `GPUTextureView` by texture identity. If atlas hot-swap is ever needed, null `bindGroup` in `IconRenderer` AND the cached view + texture in `SpriteAtlasGPU`.
- Call `IconStage.destroy()` on map teardown — it chains to `IconRenderer.destroy()` (GPU buffer release) and `SpriteAtlasGPU.destroy()` (texture release).
- `bboxDiagnosticEnabled` on `IconRenderer` defaults false; the O(vertexCount) bbox loop is gated behind it. Flip only when the inspector panel actually reads `lastVertexBBox`.

### Testing Requirements
- Unit tests: `sprite-atlas-host.test.ts` (metadata parse, DPR fallback, 404/SSRF state transitions, `whenReady`), `icon-stage-missing-names.test.ts` (missing-name diagnostic), `icon-vertex-layout.test.ts` (stride/slot constants derived from `ICON_FORMAT`), `icon-paired-position.test.ts` (text-icon anchor alignment via debug hook).
- Tests stub `createImageBitmap` and use a mock `fetch` — no real network or GPU device required.
- No dedicated snapshot tests; visual correctness falls under the playground e2e matrix and the render-verification harness in `playground/`.

### Common Patterns
- Single-page atlas, one upload per atlas-load transition (`ensure()` is idempotent).
- Vertex format defined once in `icon-vertex-format.ts`; packer and layout both call `vertexField(ICON_FORMAT, …)` to read offsets — never hardcode slot numbers.
- `getSpriteCenterColor()` uses lazy OffscreenCanvas readback with a `_centerColorCache` map; returns `null` rather than throwing on any failure.
- SSRF guard (`assertSafeRemoteUrl`) and body cap (`readBodyCapped`) applied at the outermost fetch boundary — same pattern as `GlyphPbfCache` and PMTiles loaders.

## Dependencies

### Internal
- `engine/safety` — `assertSafeRemoteUrl`, `readBodyCapped` (SSRF + size-bomb guards)
- `engine/shaders/dsl` — `emitIconWgsl()` (icon WGSL shader emitted from the DSL)
- `engine/render/vertex-buffer-layout` — `toVertexBufferLayout()` (converts `VertexFormat` to `GPUVertexBufferLayout`)
- `@xgis/compiler` — `buildFormat`, `vertexField` (vertex format DSL)
- Shares conventions with `engine/text` (`TextStage` lifecycle, SDF AA, paired-symbol collision)

### External
- `@webgpu/types` (ambient WebGPU type definitions)

<!-- MANUAL: notes below this line are preserved on regeneration -->
