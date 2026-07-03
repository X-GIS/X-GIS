<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-06-03 -->

# sdf

## Purpose

Signed-distance-field generation and glyph atlas management for the text pipeline. Glyphs are rasterised via Canvas2D (or sourced from a MapLibre PBF glyph server), converted to SDF via a Felzenszwalb-Huttenlocher exact distance transform, and placed into a multi-page GPU atlas through an LRU slot manager. The layer is split into a GPU-free host (`GlyphAtlasHost` + `AtlasState` + rasterizers) and a thin GPU edge (`GlyphAtlasGPU`); the host drains into `writeTexture` calls once per frame via a dirty queue. PBF glyph loading is handled by `PbfRasterizer` over a provider chain in `pbf/`.

## Key Files

| File                    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `glyph-atlas-host.ts`   | Orchestration layer: wires `AtlasState` (slot placement) + a `GlyphRasterizer` + dirty/eviction queues. GPU-free by design. Exposes `ensure`, `ensureString`, `preloadString`, `hasAllGlyphs`, `invalidate`, `prewarm`. Holds multi-level caches (`infoCache`, `stringInfoCache`, `preloadedAtGen`, `hasAllGlyphsAtGen`) keyed by a monotonic `_generation` counter that bumps on every slot eviction — prevents cross-frame and mid-frame slot aliasing.                                                                                        |
| `atlas-state.ts`        | Pure LRU slot manager: decides WHERE each glyph goes across multi-page square atlas pages. Uses `Map` insertion-order as LRU; keys are packed numeric `fontId<<28\|codepoint<<7\|sdfRadius` (perf fix, iter-129, eliminates per-call string allocation). Returns `EnsureResult` with `created` + optional `evictedKey` so the host can propagate evictions.                                                                                                                                                                                      |
| `glyph-rasterizer.ts`   | Three rasterizer implementations all satisfying `GlyphRasterizer`: `Canvas2DRasterizer` (full SDF via fillText + computeSDF), `Canvas2DMetricsRasterizer` (metrics-only fast path for the PBF wait window — ~250× cheaper, blank SDF), `MockRasterizer` (deterministic disc SDF for tests/headless). Exports `FONT_KEY_SENTINEL` + `parseFontKey` for sentinel-encoded `style\|weight\|family` fontKeys from text-stage. Factory functions `createRasterizer` / `createMetricsRasterizer` detect OffscreenCanvas / HTMLCanvasElement / headless. |
| `distance-transform.ts` | `computeSDF(alpha, w, h, radius)` — Felzenszwalb-Huttenlocher 2D exact DT producing a tiny-sdf-compatible SDF byte encoding (192 = edge, slope = 255/radius bytes per px). TinySDF-style gamma-corrected continuous alpha seeding (iter-115; matches MapLibre localGlyphRasterizer byte-for-byte). Module-level scratch buffers (`_dt_*`, `_sdf_*`) grow-once, never reallocate — eliminates 6.5 MB GC pressure per 100-glyph cold-start burst.                                                                                                  |
| `glyph-atlas-gpu.ts`    | GPU edge: holds R8Unorm atlas `GPUTexture` pages, creates a shared linear/clamp sampler, drains `consumeDirty()` into `device.queue.writeTexture` per frame via `flush()`. `addPage()` allocates new pages lazily as the host grows. Tiny — all orchestration stays in the host.                                                                                                                                                                                                                                                                 |
| `pbf-rasterizer.ts`     | `PbfRasterizer`: synchronous provider chain wrapper — first sync `get()` hit wins; on miss, all async-capable providers schedule a background load and the fallback rasterizer runs so no frame blanks. On land, calls `onLanded` → host `invalidate` → next frame upgrades the slot silently. Exports `deriveFontstack` (reconstructs MapLibre fontstack name from sentinel fontKey, handling default-weight italic edge case) and `splitUserFamilies` (strips engine-injected CJK fallback families).                                          |

## Subdirectories

| Directory | Purpose                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pbf/`    | MapLibre PBF glyph fetch/decode/cache + `GlyphProvider` interface + `InlineGlyphProvider` + `pbf-to-slot` conversion (see `pbf/AGENTS.md`). |

## For AI Agents

### Working In This Directory

- SDF byte-slope encoding is unified to `255/radius` across Canvas2D and PBF (iter-114/115). Keep all rasterizer paths on this same convention or the shader AA half-width diverges between local and PBF-sourced glyphs (root cause of Hangul stroke unevenness pre-fix).
- The host is GPU-free by design; only `glyph-atlas-gpu.ts` touches `GPUDevice`. Do not let GPU types leak into `GlyphAtlasHost` or `AtlasState`.
- `preloadString` MUST be called for all pending labels BEFORE any `ensureString` shape loop. Interleaving `ensure` calls with held `GlyphInfo[]` references causes mid-frame slot aliasing (the "Pyongy시ng" / "South 민국ea" corruption class, iter-175). The `_generation` counter + `stringInfoCache` envelope catches post-eviction reads as clean misses.
- `invalidate()` keeps the existing slot — it marks the glyph stale so the next `ensure` call re-rasterises in place. This is the PBF upgrade path; vertex buffers referencing the slot remain valid across the upgrade.
- `bearingY` fix in `PbfRasterizer`: some OFM fontstacks ship Latin glyphs with negative PBF `top` (ascender-relative instead of baseline-relative). When `bearingY < 0`, the rasterizer recovers the true ascent from a Canvas2D `measureText` call rescaled to the 24-px PBF reference. Do not remove this without verifying bilingual vertical layout.
- `distanceTransform2D` reuses module-level scratch buffers that grow once and never shrink. Do not allocate per-call buffers inside that function.
- Atlas keys use numeric encoding `fontId * 0x10000000 + codepoint * 0x80 + sdfRadius` (53-bit safe); `AtlasState` and `GlyphAtlasHost` each maintain their own lazy `fontKey→fontId` interning maps — they must stay structurally identical.

### Testing Requirements

- `glyph-atlas-host.test.ts`, `glyph-atlas-host-invalidate.test.ts`, `atlas-state.test.ts`, `distance-transform.test.ts`, `glyph-rasterizer.test.ts`, `pbf-rasterizer.test.ts`, `pbf-rasterizer-chain.test.ts`, `pbf-glyph-bearingy.test.ts`. Add a `bearingY` + SDF-encoding case for any rasterizer change. The `pbf-glyph-bearingy` suite specifically pins the bilingual vertical-collapse fix.

### Common Patterns

- Host (orchestrate) / state (slot placement) / rasterizer (SDF appearance) / GPU (upload) separation.
- Dirty queue → `flush()` → `writeTexture`. Provider chain: sync-hit-or-schedule-async-then-fallback.
- Generation-tagged caches: always read `_generation` AFTER the `ensure` loop, store post-loop value.

## Dependencies

### Internal

- `engine/gpu` (atlas `GPUTexture` + `writeTexture` in `glyph-atlas-gpu.ts`).

### External

- `@webgpu/types` (GPUDevice, GPUTexture, GPUSampler types).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
