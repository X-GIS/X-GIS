# Audit ② — Tile pipeline & GPU resource/memory lifecycle

_Deep-research synthesis, 2026-06-08. Direct file:line audit of the X-GIS tile/GPU pipeline merged with WebGPU-lifecycle and map-renderer cache-management research. Part of the 10-audit series. Claims cited inline; confidence/caveats carried from verification._

---

## TL;DR

The tile/memory subsystem is **mostly well-managed** — arena free-lists, LRU eviction with stableKey protection + byte hysteresis, deferred buffer retirement, and a `_destroyed` guard on async uploads are all correct. The real risks are three: **(1) a genuine GPU-texture leak** — glyph atlas pages grow via `createTexture` with **no shrink path** until map teardown; **(2) cache thrash** — visible-tile selection isn't bounded to the cache, so at high altitude the working set exceeds `MAX_GPU_TILES` and tiles re-upload every frame; and **(3) orphaned GPU resources** on style/variant change (per-tile feature buffers, compute handles) that only free on eventual eviction. The web research gives the governing principles: WebGPU's GC **cannot see GPU memory**, so explicit `.destroy()` on eviction is mandatory; and map caches must be **~5× the viewport-tile count**, not 1×, to avoid LRU thrash.

---

## A. Architecture (as audited)

Fetch → MVT decode (worker pool) → GPU upload (per-frame budget) → indexed draw → LRU eviction post-submit. GPU resources: shared 64 MB polygon vertex/index **arenas** (free-list alloc, `arena.free()` reclaim), per-tile line/feature/z buffers, multi-page **glyph atlas** + single-page **sprite atlas**, resized render targets, a growable **uniform ring** (deferred one-frame retire). GPU tile cache: nested `Map<sourceLayer, Map<tileKey, GPUTile>>`, cap **256 desktop / 64 mobile** (`vector-tile-renderer-helpers.ts`), LRU on `lastUsedFrame` with count **and** byte-pressure (75%→60% hysteresis) eviction, stale-upload cancellation against `activeKeys`.

## B. Findings (file:line, severity)

### B1 — Glyph atlas pages: unbounded growth, no reclaim (**real GPU leak**, MEDIUM)

`glyph-atlas-gpu.ts:63-71` `addPage()` calls `device.createTexture()` on demand as `pageCount` rises; the host evicts individual glyph _slots_ (LRU) but **never shrinks the pages array** — only `destroy()` at teardown frees them [audit B1]. Each page is `pageSize²·1B` (R8); a long-lived tab loading many fonts/scripts (multilingual UI) accumulates 100+ pages = tens of MB never reclaimed mid-session.
**Why it bites:** WebGPU's **GC lives in the content process and cannot see GPU-process memory** — a `GPUTexture` wrapper is ~150 bytes pinning up to 1 GB, so it never triggers JS memory pressure and is never collected promptly [W3C explainer]; "applications… without the explicit `.destroy()` call… would quickly run out of GPU memory" [W3C explainer]. **Fix:** add a `shrinkPages(n)` that `copyTextureToTexture` survivors into a smaller texture then `.destroy()`s the old — the spec-consistent atlas-shrink pattern [MDN copyTextureToTexture; wgpu#964] — triggered when glyph count drops below a fraction of the page high-water mark.

### B2 — Visible-tile selection not bounded to cache → thrash (MEDIUM-HIGH)

`vector-tile-renderer.ts:850-878`: `visibleTilesFrustum()` is computed _before_ the cap check; if it returns 300 keys but the cap is 256, eviction drops ~44 tiles every frame, which are still "visible" next frame → re-fetch/re-upload churn ("loading shimmer" 5-10 s at high altitude/wide FOV) [audit B6].
**Why it bites (the governing law):** when the working set exceeds cache capacity, LRU degrades toward a **zero-hit-rate thrash** [Belady/working-set theory, UT/Cornell]. This is exactly why **MapLibre sizes its cache at `maxTileCacheZoomLevels(=5) × viewport-tiles`** and **deck.gl at literal `5×` viewport tiles** — the multiplier is headroom for the visible set _plus_ retained parents/children [MapLibre MapOptions docs; deck.gl TileLayer docs]. A canonical Mapbox thrash bug (a `get()` that mutated recency purged a parent so the next `get` missed and reloaded) shows how easily retention turns into reload [mapbox-gl-js#4210]. **Fix:** either cap selection to the cache budget (already the subject of the camera-tile-injection mitigation for high-pitch) **or** raise `MAX_GPU_TILES` toward a multiple of the worst-case visible count, and retain parents rather than evict-then-reload.

### B3 — Orphaned GPU resources on style/variant change (MEDIUM)

- **Per-tile feature buffer** (`vector-tile-renderer.ts:1573`): `createBuffer` on every decode; if a tile is **re-decoded before eviction** (style/filter change) the old buffer isn't destroyed until eventual eviction (`:5269`) — a transient leak [audit B4]. **Fix:** `cached.featureDataBuffer?.destroy()` before realloc.
- **Compute layer handles** (`:2275` vs eviction `:5275`): on variant swap the old `ComputeLayerHandle`s persist in `computeHandlesByTile` and **keep dispatching obsolete kernels** every frame until tiles fall out of cache [audit B8]. **Fix:** clear handles built against the old variant on swap.

### B4 — Lower-severity

Sprite-atlas `_cachedView` replaced without destroying the old view on reload (`sprite-atlas-gpu.ts:73-76`, LOW-MED, fragile not active) [audit B2]; debug-overdraw view churn per frame (`render-targets.ts:179`, LOW, debug only) [audit B3]; bind-group rebuild walks all cached tiles on uniform-ring grow (`:679`, LOW-MED perf jank) [audit B7]; arena-compaction-vs-async-upload race guarded only by `uploadQueue.activeCount()` (`:5374`, MEDIUM, single point of failure) [audit B5].

## C. What's robust (positive controls)

Arena free-list O(1) reclaim when drained (`:5218`); LRU eviction with stableKey protection + count/byte hysteresis; uniform-ring deferred retire (`uniform-ring.ts:121`); the **`_destroyed=true`-before-clearing-queue** guard so in-flight async uploads skip their submit (`:1289`); render-target textures destroyed before resize realloc (`render-targets.ts:85`); point-renderer deferred buffer destroy (`point-renderer.ts:308`); atlas `destroy()` clears all pages at teardown. These match the spec's prescribed discipline — explicit, deterministic free rather than GC-finalizer cleanup [W3C explainer].

## D. Memory budgeting note

There is **no WebGPU API to query a total GPU memory budget** — bounding resident memory is entirely the app's job via pool + LRU-evict + explicit `.destroy()`, with `pushErrorScope('out-of-memory')` around `createBuffer/createTexture` as the **only** feedback signal [W3C ErrorHandling]. Severe OOM can surface as **device-loss** rather than a catchable error, and the recovery contract is to restart from `requestAdapter` [W3C ErrorHandling] — see Audit ⑧ (error handling / device-loss). For per-frame updates, `writeBuffer()` is the safe default; adopt a mapped staging-ring only if profiling shows buffer writes are the bottleneck [toji.dev].

## E. Top fixes (ranked)

1. **Glyph atlas page reclaim** (B1) — the one true GPU leak; bites long-lived multilingual sessions.
2. **Bound selection / right-size the tile cache** (B2) — kills the high-altitude thrash; the 5×-viewport sizing rule is the target.
3. **Destroy-on-realloc + variant-swap handle cleanup** (B3) — cheap, removes transient leaks and wasted compute dispatches.
4. Add a `pushErrorScope('out-of-memory')` wrapper on the large allocations so OOM is observable rather than a silent device-loss.

---

## Sources

**Codebase audit (file:line):** `glyph-atlas-gpu.ts:63-71` (page growth), `glyph-atlas-host.ts` (slot LRU), `sprite-atlas-gpu.ts:73-76`, `render-targets.ts:85,179`, `vector-tile-renderer.ts:679,850-878,1573,2275,5218,5269,5275,5363-5377` (arena/cache/feature-buffer/compute), `vector-tile-renderer-helpers.ts:51-55` (MAX_GPU_TILES), `uniform-ring.ts:121`, `point-renderer.ts:308`.
**WebGPU lifecycle:** W3C Explainer (GC can't see GPU memory; 150 B pins 1 GB; explicit destroy) https://gpuweb.github.io/gpuweb/explainer/ [high]; W3C ErrorHandling (OOM scope, device-loss) https://github.com/gpuweb/gpuweb/blob/main/design/ErrorHandling.md [high]; W3C BufferOperations (map/unmap, destroy implies unmap) [high]; toji.dev buffer-uploads (writeBuffer default, staging-ring tradeoff) https://toji.dev/webgpu-best-practices/buffer-uploads.html [high]; MDN copyTextureToTexture + wgpu#964 (atlas grow→copy→destroy) [med-high]; greggman/webgpu-memory [high].
**Tile cache:** MapLibre MapOptions (`maxTileCacheZoomLevels=5`, viewport×zoom sizing) https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/MapOptions/ [high]; deck.gl TileLayer (`5×` viewport, `maxRequests`/abort) https://deck.gl/docs/api-reference/geo-layers/tile-layer [high]; Mapbox findLoadedParent retention PR#4595 + thrash bug PR#4210 [high]; Belady/LRU + working-set thrash (UT isca16, Cornell cs4410) [high theory, med map-corollary]; OpenLayers 256 default [med]; MapLibre deepwiki tile-management [med].

_Confidence: the codebase audit (direct read) and W3C/toji/MapLibre/deck.gl primary docs are load-bearing. The map-specific thrash corollary is inferred from general LRU theory + the cross-engine 5× convention. Exact MapLibre source variable names are search-summary-sourced (GitHub blocked direct fetch)._
