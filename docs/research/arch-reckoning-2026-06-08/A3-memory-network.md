# A3 — Memory lifecycle + network/tile concurrency & backpressure

Adversarial audit, 2026-06-08. Axis: GPU/tile memory leaks + eviction policy + `map.destroy()` + network concurrency caps / backpressure / cancellation / worker-pool crash recovery.

Every claim below is FACT (read in code, file:line) unless tagged **[INFER]**. Verdicts are cold; positives get one line.

---

## Verdict: 3 / 5 (5-year sustainability, this axis)

The memory + network machinery is **better than the owner fears in the area he named, and worse than he knows in an area he didn't.** Tile fetches — the obvious flood vector — are genuinely capped, queued, prioritized, and cancellable. But **two non-tile fetch paths (glyph-PBF and sprite) have ZERO concurrency cap and no cancellation**, the **glyph atlas GPU texture leaks monotonically** for the life of the tab, and **worker pools never respawn after a crash** — one worker error permanently degrades or kills the decode pipeline with no recovery. A `map.destroy()` exists and is unusually thorough on GPU/DOM, but **leaks the shared worker fleet by design**. The bones are good; three sharp edges keep this from being trustworthy on a long-lived desktop session.

---

## 1. The owner's explicit fear: "excessive network traffic at once could harm desktop stability"

### 1.1 Tile fetches — CAPPED, QUEUED, PRIORITIZED, CANCELLABLE (the good news)

A fast pan/zoom **cannot** flood the network with *tile* requests. Three independent gates:

- **Catalog-level cap** (`tile-catalog.ts:962-965`): `requestTiles` breaks the loop once `loadingTiles.size >= maxConcurrentLoads()`. `maxConcurrentLoads()` = **32 desktop / 8 mobile** (`tile-types.ts:207-210`).
- **Per-backend cap** (`pmtiles-backend.ts:181`): every `loadTile` sets `fetchQueue.maxJobs = maxInflight()` = **16 desktop / 4 mobile** (`pmtiles-backend-helpers.ts:137-140`). The `PriorityQueue` (`core/priority-queue.ts:181-213`) only dispatches `maxJobs - currJobs` callbacks per drain — a hard concurrency ceiling on actual `fetch()` calls.
- **Priority + cancellation**: `setFetchPriority` installs a distance-to-camera comparator (`tile-catalog.ts:896-902`); `cancelStale` (`tile-catalog.ts:913-953` → `pmtiles-backend.ts:295-347`) drops queued-but-undispatched fetches (`fetchQueue.removeByFilter`), `ac.abort()`s in-flight ones (`:328-331`), and discards already-downloaded-but-uncompiled bytes (`:333-346`) for any key no longer in the active set. AbortController per key is real (`:208-209`, `:258`).

This is a textbook NASA-AMMOS-style priority queue with backpressure (the loading slot is reserved at *enqueue* time, `:184`, so prefetch sees queued tiles as in-flight). **This part is genuinely well-built — the owner's fear is unfounded for tiles.**

Raster (image) tiles have their own independent cap: `MAX_CONCURRENT_LOADS = 6` (`raster-renderer.ts:24`) + per-key AbortController + zoom-change abort of distant LODs (`:182-192`, `:227-230`). Also fine.

### 1.2 Glyph-PBF fetches — NO CAP, NO QUEUE, NO ABORT (**real flood risk**, HIGH)

`glyph-pbf-cache.ts:108` fires `this.fetchFn(url)` **directly**, with no queue, no concurrency ceiling, and no AbortController. The ONLY throttle is per-range dedup: a `(fontstack, rangeStart)` already in `loading`/`loaded`/`failed` state is skipped (`:83-90`).

Why this is a real flood vector and not theoretical: panning into a region with many scripts (CJK + Cyrillic + Arabic + Latin + Greek…) touches many distinct 256-codepoint ranges *and* multiple fontstacks in the same frame. Each first-touch range fires an **immediate, unthrottled** `fetch()`. A multilingual world view can trip dozens of simultaneous glyph-PBF requests in one frame with **no ceiling** — exactly the "excessive network traffic at once" the owner named. There is also **no cancellation**: once fired, a glyph fetch runs to completion even if the camera leaves; unlike tiles, there is no `AbortController` and no `cancelStale` path. Failures are session-permanent (`:119-123`, no retry), so the flood is at least self-limiting *after* first resolution — but the first-touch burst is uncapped.

**Fix:** route glyph-PBF fetches through the same `PriorityQueue` (or any N-concurrent semaphore) the tile path uses; add an AbortController so a range no longer needed gets cancelled.

### 1.3 Sprite fetches — uncapped but low-cardinality (LOW)

`sprite-atlas-host.ts:158-167` fetches `${spriteUrl}{suffix}.json` + `.png` with SSRF guard + `readBodyCapped`. No concurrency queue, but there is exactly **one** sprite sheet per style (1 json + 1 png), so cardinality is ~2 requests total — not a flood vector. Correct size-cap discipline (`MAX_SPRITE_JSON_BYTES`). Acceptable as-is.

---

## 2. GPU / tile memory lifecycle

### 2.1 Arena (polygon vertex/index) — ROBUST (positive control)

`gpu-arena.ts` is the strongest module on this axis. Byte-exact free-list keyed by `align4(size)` (`:173`, `:227-234`) so reuse can never overrun a neighbour; O(1) alloc/free; `liveUsedBytes` is the correct eviction loop-termination signal (falls on `free()`) vs `usedBytes`/`bumpPtr` as the overflow trigger (`:179-193` — the distinction is documented and correct); `reclaimIfDrained()` (`:331-337`) and `compact()` (`:370-405`) handle the bump-pointer-monotonicity fragmentation problem with a correct ping-pong-to-fresh-buffer + caller-destroys-old-after-submit contract. `destroy()` frees the buffer (`:299-304`). This matches the MEMORY.md note on byte-aware eviction (OOM fix PR #193). **No issues found.**

### 2.2 Glyph atlas GPU pages — MONOTONIC TEXTURE LEAK (**verified**, MEDIUM)

Audit ②'s B1 claim ("glyph atlas pages never shrink") is **CONFIRMED in code**:

- `glyph-atlas-gpu.ts:63-71` `addPage()` calls `device.createTexture()` and pushes to `this.pages`; `flush()` grows pages to match host (`:83`) but there is **no `shrinkPages` / no `copyTextureToTexture` survivor-repack / no per-page `.destroy()` except at teardown** (`:106-109` `destroy()` is the only `tex.destroy()` site).
- The host side (`atlas-state.ts:191-211`) `allocatePage()` only ever **increments** `pageCountInternal`; `ensure()` evicts individual *slots* via LRU (`:139-153`) but **never frees a page**. `pageCountInternal` has no decrement anywhere in the file.

Consequence: a long-lived multilingual tab that transiently displays many scripts grows the atlas to its high-water-mark page count and **holds every page texture until `map.destroy()`**. Each page is `pageSize²·1B` (R8). Because WebGPU's GC cannot see GPU-process memory **[INFER, per W3C explainer cited in audit ②]**, the ~150-byte `GPUTexture` wrappers never trigger JS memory pressure, so this is invisible to normal profiling and never self-corrects mid-session. This is a true leak, not churn.

**Fix:** the audit's prescription is right — `shrinkPages(n)` that `copyTextureToTexture` survivors into a smaller texture then `.destroy()`s the old, gated on glyph count dropping below a fraction of the page high-water mark.

### 2.3 Catalog CPU tile cache — byte-aware, hysteresis, skeleton-protected (mostly good)

Eviction is **byte-based, not count-based** (the owner's likely worry): `_cachedBytes` is maintained by `setSlice`/`deleteCacheEntry` (`tile-catalog.ts:157-176`), enforced against `maxCachedBytes()` = **200 MB desktop / 100 MB mobile** (`tile-types.ts:151-160`); `MAX_CACHED_TILES = 256` is a secondary count safety-net (`:136`, `:141-143`). Skeleton keys (`_skeletonKeys`, `:123`) and a TTL evict-shield (`_evictShield`, 2 s, `:797-804`) protect just-prefetched / fallback-anchor tiles from being evicted-then-immediately-refetched.

Caveat worth flagging: `sizeOfTileData` (`:131-150`) **intentionally omits** `prebuiltLineSegments`/`prebuiltOutlineSegments` because VTR nulls them post-upload — the comment documents a real prior bug (263 MB false-positive eviction). The accounting is therefore a deliberate *under*-count by ~20% on dense tiles **[INFER on the exact %; the 20% figure is from the in-code comment, not re-measured]**. Net effect: byte cap fires slightly later than nominal. Acceptable, documented.

This is the right policy. The audit ②'s B2 thrash concern (visible set > cache cap at high altitude → re-upload every frame) is a *GPU-tile-cache* (`MAX_GPU_TILES` in VTR, not read here) issue, out of this file's scope; I cannot confirm/deny it from `tile-catalog.ts` alone.

### 2.4 `map.destroy()` — thorough on GPU/DOM, LEAKS WORKERS (MEDIUM)

`map.ts:3215-3271` exists and is unusually disciplined:
- Clears interaction-idle timer (`:3221-3224`), detaches pointer controller (`:3229`), removes keyboard a11y listener (`:3235-3238`) — the listener-leak class is handled.
- Tears down per-source renderers (`:3241` → `teardownSource` → `renderer.destroy()`), text/icon stages (`:3244-3247`), palettes (`:3254-3259`), and crucially `ctx.device.destroy()` (`:3266`) which frees EVERY remaining GPU buffer/texture/pipeline on the per-map device in one call. `_destroyed` latch (`:3216`) + guards on the async-upload path so in-flight uploads skip a torn-down map.

**The gap:** the shared MVT worker pool (`getSharedMvtPool`) and GeoJSON compile pool (`getSharedGeoJSONCompilePool`) are **NOT terminated** by `destroy()`. `map.ts:3211-3212` documents this is intentional ("shared … intentionally NOT terminated"). For a single-map page this is benign. But for an SPA that creates/destroys maps (route changes, dashboards), **every destroyed map leaves its worker fleet (2-6 MVT workers + 1-4 GeoJSON workers) alive**, and `destroy()` does not even drop the per-backend `abortControllers`/`fetchQueue` (those die with the backend via `teardownSource` → `renderer.destroy()`, which I did not trace to a `pool.dispose()`). `MvtWorkerPool.dispose()` and `GeoJSONCompilePool.dispose()` **exist** (`mvt-worker-pool.ts:271-278`, `geojson-compile-pool.ts:220-227`) but are wired only to test cleanup. **[INFER]** On repeated map creation this is a worker + memory leak.

**Fix:** ref-count the shared pools and `dispose()` when the last map is destroyed, or make pools per-map.

---

## 3. Worker-pool crash recovery — NO RESPAWN (**real**, MEDIUM-HIGH)

The owner asked specifically: "Do worker pools restart on crash?" **No. None of the three pools respawn a crashed worker.**

- **MVT pool** (`mvt-worker-pool.ts:161-169`): the `error` handler logs, then **rejects every outstanding job and `pending.clear()`s** — but never calls `new MvtWorker()` to replace the dead worker, and never removes the dead worker from `this.workers`. Round-robin dispatch (`:255-256`) keeps `postMessage`-ing to the **dead worker's slot** every Nth tile forever. Result: after one worker crash, ~1/N of all tile compiles silently never resolve (they post to a dead worker that never replies; they aren't even in `pending` long enough to be rejected because the crash already cleared `pending`). The pipeline degrades permanently with no recovery path.
- **GeoJSON compile pool** (`geojson-compile-pool.ts:147-149`): `error` handler **only `console.error`s** — does not reject pending, does not respawn. A crashed compile worker leaves its in-flight `compile()` promise **hung forever** (no reject, no timeout).
- **GeoJSON tiling pool** (`geojson-tiling-pool.ts:47-56`): `error` handler rejects pending and sets `_worker = null` — so the **next** call lazily respawns via `getWorker()`. This one *does* recover, but only on the next request and at the cost of all in-flight work. It's the least-bad of the three.

There is **no health check, no auto-restart, no circuit breaker, no per-job timeout** anywhere. A single GPU-process or OOM-induced worker crash (plausible under the very network/decode pressure the owner worries about — see the iPhone forced-refresh note in `pmtiles-backend-helpers.ts:124-128`) degrades the decode pipeline with no self-heal until full page reload.

**Fix:** on `error`, remove the dead worker from `this.workers`, spawn a replacement, and re-dispatch (or reject-and-let-catalog-re-request) its in-flight jobs; add a per-job timeout so the GeoJSON-compile hang is bounded.

---

## 4. Async-landing re-arm (cross-cut with Audit ①, in-scope for "stale render after load")

Audit ① (`2026-06-audit-async-concurrency.md`) is correct and directly relevant: glyph-PBF `onLanded` → `GlyphAtlasHost.invalidate()` (`glyph-atlas-host.ts:251-261`) marks the glyph stale and drops the cached `GlyphInfo`, but **nothing re-arms `map._needsRender`** — a settled frame keeps showing stale/missing glyphs until the camera moves. This is **already on the team's task list** (Step 1.2). The epoch/generation guard machinery it relies on (`_generation` bump on eviction, `:143`, `:192`) is correct (positive control). I confirm the invalidate path in code; the missing re-arm is the live bug.

---

## 5. Scorecard

| Concern | State | Evidence |
|---|---|---|
| Tile fetch concurrency cap | GOOD (32/8 catalog, 16/4 backend) | `tile-types.ts:207`, `pmtiles-backend-helpers.ts:137` |
| Tile fetch priority + abort + backpressure | GOOD | `pmtiles-backend.ts:181,208,295-347`; `priority-queue.ts:181` |
| Glyph-PBF fetch cap / abort | **MISSING** | `glyph-pbf-cache.ts:108` (raw fetch, dedup-only) |
| Sprite fetch cap | N/A (cardinality ~2) | `sprite-atlas-host.ts:158` |
| Arena memory lifecycle | GOOD (byte-exact, compact, destroy) | `gpu-arena.ts:216,331,370,299` |
| Glyph atlas GPU page reclaim | **LEAK (no shrink)** | `glyph-atlas-gpu.ts:63-71`; `atlas-state.ts:191-211` |
| Catalog cache eviction | GOOD (byte-aware + hysteresis + skeleton) | `tile-catalog.ts:157,797`; `tile-types.ts:151` |
| `map.destroy()` GPU/DOM | GOOD | `map.ts:3215-3271` |
| `map.destroy()` worker teardown | **LEAK (shared pools survive)** | `map.ts:3211-3212`; pools' `dispose()` test-only |
| Worker crash respawn | **MISSING (2 of 3 pools)** | `mvt-worker-pool.ts:161`; `geojson-compile-pool.ts:147` |
| Async-landing re-arm | MISSING (known, Step 1.2) | `glyph-atlas-host.ts:251`; Audit ① |

## 6. Top fixes (ranked by risk to the owner's stated concern)

1. **Throttle glyph-PBF fetches** (§1.2) — the one uncapped flood path that matches the owner's exact fear; route through a concurrency-limited queue + add AbortController.
2. **Worker-pool crash respawn + per-job timeout** (§3) — under the same network/decode pressure, one worker crash silently breaks ~1/N of decodes (MVT) or hangs forever (GeoJSON-compile) with no recovery.
3. **Glyph atlas page shrink** (§2.2) — the one true monotonic GPU leak; invisible to JS profiling, bites long-lived multilingual sessions.
4. **Ref-count + dispose shared worker pools on last `map.destroy()`** (§2.4) — SPA map churn leaks the worker fleet.
