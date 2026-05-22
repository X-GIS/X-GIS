<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# sprite

## Purpose
Sprite/icon rendering — the icon counterpart to the SDF text pipeline. Fetches a Mapbox/MapLibre style's `sprite` JSON+PNG atlas, exposes per-icon UV/size lookups, uploads the atlas to a single GPU texture, and renders icon quads (POI markers, highway shields) with a WebGPU pipeline that mixes raster and SDF sprites in one batch. `IconStage` orchestrates per-frame add→prepare→render, mirroring `TextStage`.

## Key Files
| File | Description |
|------|-------------|
| `sprite-atlas-host.ts` | Fetches `${sprite}.json` + `${sprite}.png`, exposes per-icon `{x,y,width,height,pixelRatio?,sdf?}` UV lookups to the pipeline. |
| `sprite-atlas-gpu.ts` | Uploads the atlas PNG to one GPU texture (single-page); binds cached texture+sampler on subsequent frames. Mirror of `GlyphAtlasGPU`. |
| `icon-renderer.ts` | WebGPU pipeline for sprite icons. Screen-pixel quad → NDC (same convention as text-renderer); fragment does straight raster sample OR fwidth SDF-AA path; per-vertex `sdf` flag lets one batch mix both, SDF sprites tinted by `icon-color`. |
| `icon-stage.ts` | Per-frame orchestration over `SpriteAtlasHost` + GPU upload + `IconRenderer` (`addIcon` ×N → `prepare` → `render`). Mirrors `TextStage`. `getDumpedIcons` debug accessor. |

## For AI Agents

### Working In This Directory
- The icon stage mirrors the text stage's add→prepare→render contract — keep them structurally parallel so fixes transfer.
- SDF sprites take the same fwidth-AA path as SDF text and are tinted per-vertex; raster sprites are straight alpha blend. The per-vertex `sdf` flag is what lets a single draw batch both — don't split into two pipelines.
- Highway shields combine an icon (box) here with text from `engine/text` placed on top; text-vs-box alignment is a fixed-but-fragile area (see project memory) — verify both halves together.
- Anchors arrive already projected to screen pixels by the caller, same as text.

### Testing Requirements
- `icon-paired-position.test.ts`, `icon-stage-missing-names.test.ts`, `sprite-atlas-host.test.ts`. Cover missing-icon-name fallback and atlas UV correctness for new sprite features.

### Common Patterns
- Single-page atlas, one upload per atlas-load transition. Screen-pixel quad → NDC. Stage = add/prepare/render lifecycle.

## Dependencies

### Internal
- `engine/gpu` (context, shared blend, sample count), `engine/shaders/sdf`, shares conventions with `engine/text`.

### External
- `@webgpu/types`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
