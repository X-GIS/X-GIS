<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# sdf

## Purpose
Signed-distance-field generation and glyph atlas management for the text pipeline. Glyphs are rasterised (Canvas2D or sourced from MapLibre PBF), converted to SDF via an exact distance transform, and placed into a GPU atlas through an LRU slot manager. The host orchestrates "where does each glyph go" (`AtlasState`) + "what does it look like" (`GlyphRasterizer`/`PbfRasterizer`) and exposes a dirty-queue the GPU wrapper drains into `writeTexture` calls.

## Key Files
| File | Description |
|------|-------------|
| `glyph-atlas-host.ts` | Orchestration: wires `AtlasState` (slot placement) + `GlyphRasterizer` (appearance) + a dirty-queue protocol the GPU wrapper drains. No GPU deps — fully testable. |
| `atlas-state.ts` | Pure LRU slot manager — decides WHERE a glyph goes in the atlas; never touches a pixel. |
| `glyph-rasterizer.ts` | `(fontKey, codepoint)` → SDF bitmap + layout metrics (advance, bearing) via Canvas2D. |
| `distance-transform.ts` | Felzenszwalb & Huttenlocher exact O(N) 1D distance transform (rows then columns) → SDF. Same algorithm as tiny-sdf. |
| `glyph-atlas-gpu.ts` | GPU edge: holds the R8 atlas texture(s), drains `consumeDirty()` into `writeTexture`. Tiny — orchestration is in the host. |
| `pbf-rasterizer.ts` | Wraps a fallback rasterizer (Canvas2D) with a chain of `GlyphProvider`s; first sync hit wins, misses schedule background load + run fallback so the frame never blanks, `onLanded` invalidates the slot. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `pbf/` | MapLibre PBF glyph fetch/decode/cache + providers + PBF→atlas-slot bridge (see `pbf/AGENTS.md`). |

## For AI Agents

### Working In This Directory
- SDF byte-slope encoding was unified to `255/radius` across Canvas2D + PBF/TinySDF with a single `haloK=3` — keep all sources on the same encoding or shader AA becomes meaningless and Hangul strokes go uneven.
- The host is GPU-free by design (testable); only `glyph-atlas-gpu.ts` touches the device. Don't leak GPU types into the host or `atlas-state`.
- Atlas slot eviction WITHIN a frame previously broke shaped arrays (bilingual aliasing bug) — the fix preloads strings before shaping loops. Preserve preload-before-shape ordering.
- PBF rasteriser is a synchronous chain with async background fill: never block the frame waiting for a provider; fall back and invalidate on land.

### Testing Requirements
- `glyph-atlas-host.test.ts`, `glyph-atlas-host-invalidate.test.ts`, `atlas-state.test.ts`, `distance-transform.test.ts`, `glyph-rasterizer.test.ts`, `pbf-rasterizer.test.ts`, `pbf-rasterizer-chain.test.ts`, `pbf-glyph-bearingy.test.ts`. Add a bearingY + SDF-encoding case for rasteriser changes.

### Common Patterns
- Host(orchestrate) / state(placement) / rasterizer(appearance) / gpu(upload) separation. Dirty-queue → writeTexture. Provider chain with sync-hit-or-fallback.

## Dependencies

### Internal
- `engine/gpu` (atlas texture upload), `engine/gpu/frame-arena`.

### External
- `@webgpu/types`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
