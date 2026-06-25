<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-23 -->

# text

## Purpose
The SDF text/label pipeline for X-GIS. Given a layer's `LabelDef` and a feature's property bag, this dir resolves the display string, shapes and wraps it (Knuth-Plass wrap, letter-spacing, bilingual line stacking, text-transform, variable-anchor offsets), runs greedy axis-aligned bbox collision for placement, rasterises glyphs to a multi-page SDF atlas, and emits one textured quad per glyph through a WebGPU pipeline that performs SDF threshold + optional halo. `TextStage` is the single-call orchestration over all four subsystems (resolver, atlas host, atlas GPU, renderer). SDF generation, glyph sourcing (Canvas2D + MapLibre PBF), and the GPU atlas upload layer live in the `sdf/` subdirectory. The `sdf/pbf/` sub-subdirectory handles the full MapLibre glyph-PBF fetch/decode/cache chain.

## Key Files
| File | Description |
|------|-------------|
| `text-stage.ts` | Single-call orchestration: `addLabel()` per frame, then `render(pass, viewport)`. Drives GlyphAtlasHost (slot LRU + rasterise dispatch), GlyphAtlasGPU (R8 upload), TextRenderer (WGSL pipeline + quads), collision, and resolveText. Holds the 1024-entry FNV-1a wrap-result LRU cache. Coordinate frame: screen pixels in; projection is the caller's responsibility. |
| `text-stage-types.ts` | Structural types extracted from `text-stage.ts` to keep it importable without pulling in GPU types: `WrappedLineRange`, `KPBreak`, `MlVerticalLayout` (per-line baseline + block bbox), `TextStageOptions` (slotSize/pageSize/rasterFontSize/sdfRadius/dpr/glyphsUrl/inlineGlyphs/glyphProviders/fontTypography), `PendingLabel`, `PendingLineLabel`. |
| `text-stage-helpers.ts` | Pure (GPU-free) helpers: `resolveTypography` (per-font letter-spacing/line-height overrides), `applyTextTransform` (upper/lower/none, CJK pass-through), `evaluateVariableOffsetEm` / `variableAnchorOffsetEm` (port of MapLibre variable-anchor push logic in em units), `stripCurveLineExtraScripts`, `LabelAnchor` type. |
| `text-renderer.ts` | Standalone WebGPU SDF text pipeline. Consumes `GlyphInfo[]` from the atlas host + screen-pixel anchor, emits 6-vertex quads. Shader (emitted via `emitTextWgsl()`) does SDF threshold + halo; AA width is analytic per glyph size. Uniform ring: one 64-B pack per draw at 256-B stride; per-frame `FrameArena` for vertex scratch. |
| `text-renderer-types.ts` | `TextDraw` interface: anchor (screen px), `GlyphInfo[]`, fontSize, rasterFontSize, color, optional halo (color/width/blur), letterSpacingPx, rotateRad, `glyphOffsets` (Float32Array for multiline CPU layout), `glyphRotations` (per-glyph CW radians for text-along-curve). |
| `text-vertex-format.ts` | Single-source-of-truth `TEXT_FORMAT` (`VertexFormat`): `pos_px` (float32x2, loc 0) + `uv` (float32x2, loc 1), stride 16. Both the GPU buffer layout and the glyph packer derive from this — they cannot drift. |
| `text-resolver.ts` | IR `TextValue` + feature props → display string. Handles `kind:'expr'` (evaluate AST) and `kind:'template'` (fold literal + interp parts). Injects cameraZoom + geometry-type + featureId into the eval context; returns empty string on null/undefined (matches Mapbox `text-field: null` skip). |
| `text-collision.ts` | Greedy axis-aligned bbox collision. First claimer wins; stable `symbol-sort-key` ordering (lower wins); `allowOverlap`/`ignorePlacement` semantics mirror Mapbox exactly. Variable-anchor: tries each candidate bbox in priority order. Along-line `minLineSpacingPx` suppresses crowded same-road labels via `lineId`+`anchorDistancePx`. |
| `text-wrap.ts` | Knuth-Plass line breaking over shaped glyph advances, with module-level 1024-entry LRU wrap-result cache (cache key: FNV-1a hash of glyph sequence + font + size + letter-spacing + maxWidth). Exports `wrapWithKnuthPlass()` and CJK ideograph utilities (`cjkBucketFor()`, `hasCjkIdeograph()`, `codePointIsIdeographic()`); cache survives across TextStage instances and camera zoom drift. |
| `text-stage-diagnostics.ts` | Bounded observability for the text pipeline: dispatched label texts (256 entry set), submitted vs. drawn label counters (pre- vs. post-collision), z0 halo normalisation probe (fontSize / rasterFontSize / haloWidth / normalized), and live glyph-placement dump (x/y offsets per label when filter is set). All methods are side-channels; zero influence on renders. |
| `sdf-shape.ts` | SVG path → GPU storage-buffer SDF shapes. Parses M/L/C/Q/Z commands into `SegmentData` (48 B, kind 0/1/2 for line/quadratic/cubic). Fragment shader computes SDF live from the storage buffer — no atlas slot needed. Used for vector shield outlines and marker shapes. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `sdf/` | SDF generation, glyph atlas host + GPU upload layer, Canvas2D rasterizer, PBF rasterizer chain (see `sdf/AGENTS.md`). |

The `sdf/pbf/` sub-subdirectory (under `sdf/`) handles MapLibre PBF glyph fetch/decode/cache/inline — see `sdf/pbf/AGENTS.md`. Test files (`*.test.ts`) are co-located throughout; `__profile__` internals are excluded from listings.

## For AI Agents

### Working In This Directory
- **Projection is the caller's responsibility.** `TextStage` and `TextRenderer` operate entirely in screen pixels. Do not add projection logic here; it would break screen-space uses (HUD, scale bar).
- **Bilingual vertical collapse is a documented hazard.** PBF latin glyphs carry NEGATIVE `bearingY` (≈ −9..−13) while CJK/Canvas2D are POSITIVE (≈ +20). Any change to shaping, `setDraws`, or glyph metrics must be validated against the `bilingual-label-placement-repro.test.ts` + `bilingual-prepare-scatter.test.ts` + `curved-bilingual-strip.test.ts` suite.
- **Wrap cache key must remain camera-independent.** The 1024-entry LRU hash in `text-stage.ts` uses FNV-1a over glyph-sequence + font + size + letter-spacing + maxWidth. Adding camera/zoom into the key destroys its value and reintroduces the per-frame re-wrap jank.
- **`TEXT_FORMAT` is the single source of truth for the vertex layout.** Never hard-code the `pos_px`/`uv` offsets or stride in `text-renderer.ts` — always derive them via `vertexField(TEXT_FORMAT, ...)`.
- **Halo width/edge parity with MapLibre is proven bit-identical** — residual label softness is a raster-size issue, not a width bug. Do not change halo width to fix visual smoothness.
- **`sdf-shape.ts` is atlas-free by design.** It uses GPU storage buffers + live fragment SDF to avoid consuming atlas slots for non-glyph shapes.

### Testing Requirements
Run with `vitest` (no GPU — all text-layer tests are CPU/pure). Relevant test files co-located here:
`text-stage.test.ts`, `text-resolver.test.ts`, `text-collision.test.ts`, `text-wrap.test.ts`, `text-vertical.test.ts`, `text-layout-edge.test.ts`, `font-typography.test.ts`, `halo-uniforms.test.ts`, `text-vertex-layout.test.ts`, `line-label-collision.test.ts`, `cjk-minification-box.test.ts`, `bilingual-label-placement-repro.test.ts`, `bilingual-prepare-scatter.test.ts`, `curved-bilingual-strip.test.ts`, `sdf-shape-registry.test.ts`, `glyph-rasterizer.test.ts`, `distance-transform.test.ts`, `glyph-atlas-host.test.ts`, `glyph-atlas-host-invalidate.test.ts`, `atlas-state.test.ts`. For shaping or metrics changes also run the full `sdf/` and `sdf/pbf/` test suites.

### Common Patterns
- Pipeline stage: resolve → shape/wrap (LRU-cached) → collide (greedy bbox) → rasterise (SDF atlas) → quad emit (WebGPU).
- GPU-free helpers and types are split into separate files (`text-stage-helpers.ts`, `text-stage-types.ts`, `text-renderer-types.ts`) so tests can import them without a GPU context.
- SDF threshold + analytic AA + halo in the fragment shader; all display-size scaling via SDF threshold, not texture scaling.
- `FrameArena` for large per-frame scratch allocations (vertex buffer, baseline arrays) to avoid per-frame GC pressure.

## Dependencies

### Internal
- `engine/gpu` (device, `FrameArena`, uniform ring)
- `engine/shaders/dsl` (`emitTextWgsl`, `vertexField`, `buildFormat`)
- `engine/render/vertex-buffer-layout` (`toVertexBufferLayout`)
- `engine/__profile__` (alloc counter, perf marks — never ship-critical)
- `@xgis/compiler` (`LabelDef`, `TextValue`, `evaluate`, `formatValue`, `makeEvalProps`, `vertexField`, `buildFormat`)

### External
- `@webgpu/types`

<!-- MANUAL: notes below this line are preserved on regeneration -->
