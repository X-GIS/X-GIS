<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# text

## Purpose
The SDF text/label pipeline. From a layer's `LabelDef` and a feature's properties it resolves the display string, shapes it (wrap, letter-spacing, transform, bilingual line stacking), runs greedy bbox collision for placement, rasterises glyphs to an SDF atlas, and emits one textured quad per glyph through a WebGPU pipeline that does SDF threshold + halo. `TextStage` is the single-call orchestration over the four subsystems (resolver, atlas host, atlas GPU, renderer). The SDF generation + glyph sourcing (Canvas2D rasteriser and MapLibre PBF glyphs) live in `sdf/`.

## Key Files
| File | Description |
|------|-------------|
| `text-stage.ts` | Single-call orchestration over GlyphAtlasHost + GlyphAtlasGPU + TextRenderer + collision. Per-frame label compositing. |
| `text-stage-helpers.ts` | Pure (GPU-free) helpers: `applyTextTransform` (uppercase/lowercase/none, CJK pass-through), wrap/justify math — importable without the GPU pipeline. |
| `text-renderer.ts` | Standalone WebGPU SDF text pipeline — one textured quad per glyph, SDF threshold + optional halo, anchors pre-projected to screen pixels. |
| `text-resolver.ts` | IR `TextValue` + feature props → display string (`text-field` expression resolution). |
| `text-collision.ts` | Greedy axis-aligned bbox collision; first-claimer wins. Mapbox `allow-overlap`/`ignore-placement` semantics. |
| `sdf-shape.ts` | SVG-path → GPU-storage-buffer SDF shapes; fragment computes SDF live (no atlas) — used for vector shield/marker shapes. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `sdf/` | SDF generation, glyph atlas (host + GPU), Canvas2D rasterizer, PBF glyph chain (see `sdf/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- Vertical placement of bilingual labels is a documented USER-visible weak spot: PBF latin glyphs carry NEGATIVE bearingY (`g.top` ≈ −9..−13) while CJK/Canvas2D are POSITIVE (≈ +20); mixing them can collapse line 2 into line 1. Test with the bilingual repro before touching shaping/`setDraws`.
- Label layout re-running every frame (even when content is unchanged) is a known drag-jank source — the wrap cache key should be camera-independent; preserve that.
- Halo width/edge parity with MapLibre has been proven bit-identical — residual label "chunkiness" is raster-size/AA, not a width bug. Don't tune halo width to fix smoothness.
- Anchors are pre-projected to screen pixels by the caller; the stage works in pixel space.

### Testing Requirements
- Large suite: `text-stage.test.ts`, `text-wrap.test.ts`, `text-collision.test.ts`, `text-resolver.test.ts`, `text-vertical.test.ts`, `text-layout-edge.test.ts`, `bilingual-*` repro tests, `curved-bilingual-strip.test.ts`, `line-label-collision.test.ts`, `font-typography.test.ts`, `halo-uniforms.test.ts`, atlas-state/distance-transform/glyph-rasterizer tests. Add a bilingual + collision case for shaping changes.

### Common Patterns
- Stage = resolve → shape/wrap → collide → rasterise → quad. GPU-free helpers split out for testing. SDF threshold + halo in the fragment shader.

## Dependencies

### Internal
- `engine/gpu`, `engine/shaders/sdf`, `engine/gpu/frame-arena` (scratch), `@xgis/compiler` (`LabelDef`, `TextValue`), `@chenglou/pretext`.

### External
- `@chenglou/pretext` (text layout), `@webgpu/types`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
