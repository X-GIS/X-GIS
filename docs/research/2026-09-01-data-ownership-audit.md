# Data-Ownership Audit — and the 5-Year Ownership Model

**Date:** 2026-09-01 · **Issue:** #2241 · **Status:** audit complete; direction proposed, no code changed.

The owner asked whether the codebase lacks a data-ownership concept (reference counting
and the like). This document is the full audit — every subsystem, adversarially
verified — and the recommended ownership architecture for the next 5+ years.

**TL;DR.** There is exactly **one reference count** in the engine, and it governs a
drain-cap flag, not a resource. Lifetime is managed by **seven ad-hoc substitutes**,
each added after a paid-for incident, plus a device-destroy backstop that makes
full teardown sound while leaving **mid-session partial lifecycles** (source/style
swap, eviction, remount) as the real exposure — which is exactly where this audit's
9 live defects and 12 latent hazards sit. The fix is not engine-wide refcounting; it
is promoting the disciplines the newest code already discovered (always-on liveness
ledgers, generation validation, fenced retirement, leak gates) into the default, and
adding **explicit pins** at the few true async-hold points where today a timer guesses.

---

## 1. Method

- **Mechanical sweeps** (this session, primary evidence): all 62 lifecycle methods
  (`destroy|dispose|destroyAll|destroyGpu|detach|releaseAll`) enumerated and their
  reachability grep-verified; RHI create/destroy symmetry counted; resource-holder
  inventory (70 prod files hold GPU-handle-typed fields, ~30 private resource `Map`s,
  7 `AbortController` owners); refcount/`Symbol.dispose` census.
- **Five subsystem passes** (parallel sub-audits): data package + in-flight fetch;
  coverage/compute/offscreen targets; text/label/sprite; RHI + engine primitives;
  map orchestration + vector render path. Each produced an owner inventory and
  hazard findings with `file:line` evidence.
- **Adversarial verification:** every finding published here as CONFIRMED had its
  decisive lines re-read in this session (construction-style proof for the
  headliners); agent-only claims stay labeled PLAUSIBLE. Two graph-suggested
  "orphan destroy" claims were **refuted** this way (`FeatureDataBinder.destroy`
  is called at `vector-tile-renderer.ts:2375`; `ComputeLayerRegistry.destroyAll`
  at `renderer.ts:742`).
- **Instrument caveat (recorded per §12):** the code-graph's in-degree is unusable
  for reachability here — optional-chained calls (`?.destroy()`) index as zero
  inbound (e.g. `StatsPanel.destroy`, called at `map.ts:2224,5313`, shows in=0).
  Every negative claim below is grep-verified, not graph-trusted.

## 2. The ownership model as it exists today

**The one refcount:** `MvtWorkerPool._coldStartBurstRefcount`
(`data/src/workers/mvt-worker-pool.ts:131-176`) — invented the moment two maps truly
shared one module singleton, governing a drain-cap _flag_; hand-balanced from 5+
`map.ts` sites whose comments worry about leak and double-underflow
(`map.ts:3385,4377,4403,5156-5159,5393`), with a clamp-at-0 for safety.
`Symbol.dispose`/`Disposable`: zero adoption.

Everywhere else, seven substitutes, each an incident scar:

| #   | Substitute                                                                     | Where                                                                                                                                                                                                                                    | Incident that created it                                                                                             |
| --- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | Per-frame protected-set snapshots (`stableKeys`/`protectedKeys`/`visibleKeys`) | every eviction path (`tile-eviction-policy.ts:96`, `gpu-tile-store.ts:468`, `raster-cache-budget.ts:184-206`)                                                                                                                            | OOM from blanket ancestor protection (`_pmtiles-stress-leak`)                                                        |
| 2   | TTL guess-shields                                                              | 2 s evict shield (`tile-eviction-policy.ts:46-54`); 12-frame prefetch age (`tile-catalog.ts:1113-1116`); 30 s/10 s keep-warm deadlines (`tile-catalog.ts:79`, `tile-retry.ts:189`)                                                       | both directions paid: 5 s TTL → 296 MB heap on iPhone; too short → infinite refetch (`_zoom-transition-blank-tiles`) |
| 3   | Permanent pins (skeleton keys)                                                 | `tile-eviction-policy.ts:20-33`                                                                                                                                                                                                          | fast-pan white flash (sound design; mirrors Cesium root retention)                                                   |
| 4   | Deferred-destroy retire queues, post-submit drain                              | 3 private queues in `gpu-tile-store.ts:663-676,940-947`; `_retiredBakes` (drape); `TilePointCache.retired`; ring `takeRetired`                                                                                                           | `[Buffer "line-segments"] used in submit while destroyed`                                                            |
| 5   | Generation/epoch validation                                                    | `GPUTile.uploadEpoch` (`vector-tile-renderer-types.ts:105-114`); glyph `_generation` (`glyph-atlas-host.ts:154-163,488-495`); `packedSkew` (#2165); `bindGroupEpoch`; `satisfies`-typed bundle key (`_cache/bundle-cache-key.ts:53-144`) | iter-167/168 label corruption; #2165 dead witness                                                                    |
| 6   | Manual invalidation handshakes                                                 | `consumeEvictions()` pull (`glyph-atlas-host.ts:513-518`); `draper?.dropTexture` at every texture destroy (`raster-cache-budget.ts:199-201` + 4 drape sites)                                                                             | #1419 destroyed-texture-in-submit                                                                                    |
| 7   | Hand-maintained teardown checklists                                            | `XGISMap.destroy()` 112 lines (`map.ts:5225-5337`), nearly every block carrying its leak's issue number (#246 #1153 #1167 #1260 #1263 #1268 #1304 #1404 #1569)                                                                           | each block = one incident                                                                                            |

**The backstop that changes the picture:** whole-device teardown reclaims wholesale —
`WebGl2Device.destroy()` = liveness latch + `WEBGL_lose_context` dropping every GL
resource (`rhi-webgl2.ts:1451-1458`), WebGPU `device.destroy()` likewise, invoked as
the keystone of `_releaseGpuResources` (`map.ts:5207`). Consequence: **no true orphan
leak at full teardown** among the 62 lifecycle methods. The fragile regime is
mid-session partial lifecycles — source swap, style re-run, eviction, device-loss
reinit — and the incident ledger (#1570 remount, per-`setSourceData` staging leak,
#1632 per-swap point slots, #1567 globalThis pin) sits entirely in that regime.

**Discipline is converging, but by incident, not by design.** The visible evolution:
`GpuBufferPool.release()` (no guard at all, `gpu-buffer-pool.ts:77-92`) →
`GPUArena.free()` (DEV-only double-free/size-mismatch throw, #783,
`gpu-arena.ts:203-210,318-334`) → `UniformSlotArena.free()` (**always-on** throw on
non-live free, `uniform-slot-arena.ts:85-91`) → `TileUniformArena` (#2042: a leak
gate asserting live slots ⊆ live tiles, `tile-uniform-arena.ts:223-233`). The newest
allocator already knows the right default; the older 90 % never inherited it.

**Disposal category lives in comments, not types.** `GPUTile`
(`vector-tile-renderer-types.ts:16-115`) mixes five disciplines in one struct —
arena ranges (free offset+len, never destroy), pooled buffers (release), retire-queue
buffers (defer), RHI-owned handles, null sentinels — distinguishable only by reading
comments. #1607 (destroy responsibility as a per-call-site backend discriminant;
after a refactor the raster cache **never shed a byte again**) is what a
mis-remembered category costs.

## 3. Owner inventory (condensed)

Reachability roots: `XGISMap.destroy()` / `_teardownForReinit()` →
`_releaseGpuResources` → per-subsystem destroys → `ctx.rhi.destroy()` keystone.
"device" = reclaimed only by device destroy; "page" = deliberate page lifetime.

| Owner                                                 | Owns                                                                                                  | Destroyed via                                      | Eviction + protection                                 | Liveness guard                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| `TileCatalog`                                         | TileDataCache, in-flight ledger, backends, shields, prewarm pump                                      | `teardownSources` → both roots                     | LRU + byte cap; protectedKeys ∪ skeleton ∪ 2 s shield | `_destroyed` latch at `acceptResult` only (#1570)     |
| `TileDataCache`/`TileEvictionPolicy`                  | CPU tile bytes + accounting                                                                           | with catalog (GC)                                  | policy in eviction class                              | byte-drift + replacement-invariant audits (flagged)   |
| `VectorTileLoader` (`defaultLoader` singleton)        | PMTiles/TileJSON archive caches                                                                       | **nothing** (page; clear API is test-only)         | none                                                  | —                                                     |
| worker pools ×3 (module singletons)                   | worker fleets, job maps                                                                               | **nothing** (page; disposes exist, test-only)      | drain caps                                            | burst refcount; #1572 B/C/D                           |
| `VectorTileRenderer`                                  | store, coordinator, staging pool, bundle cache, binder, arenas, drape, fillRhi pin, point-slot prefix | `teardownSources` (order-contracted, `:2343-2398`) | per-frame maintenance                                 | `_destroyed`-first + identity guards                  |
| `GpuTileStore`                                        | gpuCache, 3 GPUArenas, GpuBufferPool, 3 retire queues                                                 | VTR.destroy                                        | count+byte hysteresis, OOM lane, stableKeys           | arena DEV guards; futility latches                    |
| `GpuBufferPool`                                       | pooled per-tile GPUBuffers                                                                            | store.destroy                                      | 16 per bucket + 16 MB                                 | **none** (F-2)                                        |
| `UploadCoordinator`                                   | queues; transient claims on arenas/pool/staging                                                       | VTR.destroy (first)                                | cancelStale                                           | `_destroyed` + buffer-identity at suspension boundary |
| Raster/Hillshade renderers                            | texture caches, inflight ledgers, drapers                                                             | destroy = abort only; textures via device          | shared byte budget; visible exempt                    | none post-destroy (A-F13)                             |
| `CoverageRenderer` + flow/heatmap targets             | region textures/LUTs, ping-pong targets                                                               | `dispose()` ← both roots (#1569 fixed)             | region LRU budget; frame-redeclared consumers         | idempotent; device-identity self-heal (#737)          |
| `FeatureDataBinder`/`ComputeLayerHandle`              | per-tile compute buffer trios                                                                         | store release-hook fan-out; VTR.destroy            | rides tile eviction                                   | destroy no-op latch on trio                           |
| Text: `TextStage`/`GlyphAtlasHost`/GPU                | atlas page, slots, memo caches, holdover                                                              | `_releaseGpuResources` (#1404 fixed; "host last")  | slot LRU + 4096-capped memos                          | `_generation` everywhere **except holdover** (F-1)    |
| Sprite: `IconStage`/hosts/atlases                     | sprite bitmaps, shelf atlas                                                                           | stage.destroy (GPU half); host = GC (no `close()`) | none — append-only, no evict                          | idempotent double-destroy                             |
| RHI WebGPU                                            | device, mip caches, staging pool, bundle cache, GPUTimer                                              | `rhi.destroy()`; staging terminal latch            | tier caps / 1024 bundles                              | staging `disposed`; GPUTimer.dispose dead API         |
| RHI WebGL2                                            | GL objects, offscreen FBO, lifecycle latch                                                            | `loseContext` wholesale                            | —                                                     | latch on createBuffer/Texture **only** (D-4)          |
| Engine `Material`/rings/slot arenas                   | pipelines, pool slots, ring buffers                                                                   | owner rebuild/destroy (#1578 gated)                | —                                                     | `_destroyed` idempotent; slot arena always-on throw   |
| Legacy `MapRendererContent`/`FrameRenderer`/graticule | layer buffers, uniform ring, pipeline caches                                                          | **no destroy methods** — device backstop           | rebuild lockstep gate                                 | —                                                     |
| page tier (documented)                                | GC-owned RhiView/BindGroup(Layout)/encoders/bundles                                                   | GC                                                 | —                                                     | documented + pinned by `rhi-destroy.test.ts`          |

Dead lifecycle surface (inventory noise, do not build on): `FrameUniform` class
(never instantiated; already listed "delete or adopt" in
`docs/research/2026-06-25-incomplete-work-inventory.md:79`), `GPUTimer.dispose()`
(zero callers, stale self-contract), `ComputeLayerRegistry.detach()` (zero prod
callers; header claims a caller that does not exist), `GpuTileStore.zBufferArena`
(never created; all consumers null-guard).

## 4. Verified findings

Verdicts: **CONFIRMED** = decisive lines re-read this session, failure derivable by
construction. **PLAUSIBLE** = structurally supported, needs a runtime probe.
(dormant) = unreachable until a named switch arms it.

### 4.1 Live defects

- **F-1 · CONFIRMED · Fade-holdover use-after-evict window (visual corruption).**
  Order inside one `TextStage.prepare`: evictions drain + holdover clear
  (`text-stage.ts:931-940`) → preload can itself evict under slot pressure
  (`:972-979`; iter-273 comment admits it) → holdover emit pushes stored clones with
  **no generation check** (`:2078-2090`; `holdover-reproject.ts` has zero generation
  refs) → flush uploads the slot's new tenant → stale UV baked. Same-prepare
  evictions drain only next prepare, so a fading label renders another label's glyph
  for up to the fade window (~300 ms) + S16 replays. Trigger: >4096 unique
  codepoints live (dense CJK) + active fade-outs. Fix = the codebase's own idiom:
  tag holdover entries with `_generation`, compare at emit (the `_layoutCache`
  already does exactly this at `:1247`). This is the last unprotected consumer in
  the atlas-slot table — every other consumer validates or is cleared.
- **F-2 · CONFIRMED · Dead-pool re-park leak (`GpuBufferPool`).** `release()` has no
  disposed latch (`gpu-buffer-pool.ts:77-92`). VTR.destroy order: coordinator
  `_destroyed` set (`:2352`) … `_pool.destroy()` (`gpu-tile-store.ts:998`). An async
  upload suspended across that teardown resumes, takes the bail path
  (`upload-coordinator.ts:803-811`) → `cleanupLineBuffers()` (`:539-545`) →
  `store.releaseBuffer()` → live GPUBuffers parked in the destroyed pool, which no
  acquire or destroy ever visits again → leaked until device death. The sibling
  `StagingBufferPool` got the terminal latch for **exactly this shape** (#1153 P2 R1;
  the ordering comment at VTR `:2354-2360` narrates it); this pool was missed.
  Scope: per `setSourceData` swap with line geometry in flight; GPU bytes exert no
  JS GC pressure.
- **F-3 · CONFIRMED · Orphaned per-tile feature buffer on palette-unwired return.**
  `buildPerTileFeatureData` creates + writes the buffer, then the palette guard
  returns null **without destroying it** (`feature-data-binder.ts:437-450`); caller
  records `featureDataBuffer: null` → unreachable until device destroy. The guard
  belongs before the create (its own comment says the path is reachable during
  setup).
- **F-4 · CONFIRMED · Template re-arm leaves stale imagery.** `setUrlTemplate` clears
  `failedTiles` on URL change but not `tileCache` (`raster-renderer.ts:362-366`;
  keys are z/x/y, no URL) — a same-map template change serves the old source's
  pixels on key collision, and visible tiles are eviction-exempt so it never
  self-heals. Hillshade twin identical. Adjacent inconsistency: in multi-raster
  scenes the template is last-source-wins (`map.ts:3572`) while `_rasterShow` is
  first-source-wins (`:3598`).
- **F-5 · CONFIRMED (code-fact) · Coverage playback reads bypass the abort spine.**
  `planOneRegion`/`readRegionsAtGroup` call `readCoverageRange(entry.url,…)`
  directly (`coverage-source.ts:692,706`) while every other rung goes through
  `deps.guardedFetch` (`:282,337,393,776`) — so `_coverageAbort.cancelAll()`
  (`map.ts:5145`, the #1570 fix) cannot stop an in-flight forecast-step/interpolation
  read; it streams to completion across destroy/reinit.
- **F-6 · CONFIRMED · `pending` orphan on sync postMessage throw.**
  `pending.set(taskId,…)` then bare `postMessage(…,[bytes])`
  (`mvt-worker-pool.ts:~408-430`): a synchronous throw (detached buffer) rejects the
  promise (slot released) but nothing deletes the entry — `pendingCount` drifts
  forever. Low severity; one try/catch.
- **F-7 · CONFIRMED · WebGL2 compile/link failure leaks GL objects.** `compile()`
  throws on COMPILE_STATUS without `deleteShader` (`rhi-webgl2.ts:267-279`); link
  failure leaves program + both shaders (`:1338-1340`). Asymmetric with the
  try/finally discipline `dispatchComputeToR32UI` already has.
- **F-8 · CONFIRMED (transient, self-correcting) · Detached backend's late result
  lands.** `acceptResult` never checks `backend ∈ this.backends`
  (`tile-catalog.ts:404-415`); a reseed's in-flight compile writes the old data
  (stale flash), then the refresh queue re-issues and replaces.
- **F-9 · minor · Doc rot:** `vector-tile-loader.ts:15-16` documents a class
  (`XGVTBinarySource`) and method (`loadFromURL`) that do not exist.

### 4.2 Latent / dormant hazards

- **F-10 · chain CONFIRMED, dormant · Supersede compute-handle key-collision UAF.**
  `applyReplacedTiles`: `uploadSync(replace)` → `buildPerTileFeatureData` **reuses**
  the handle at `${key}:${sourceLayer}` (`feature-data-binder.ts:470-477`) and binds
  its buffers into the new tile's bind group; the very next line releases the
  superseded tile → hook → `releaseTile(sameKey)` **destroys that handle**
  (`:516-522`, via `gpu-tile-store.ts:684`, VTR `:2538-2542`). The new tile's bind
  group then references destroyed buffers. Armed the day any variant carries
  `computeBindings` (none does today — `renderer.ts:740-741`). Root cause: a
  by-key-shared resource with a generation-blind release hook.
- **F-11 · CONFIRMED asymmetry, dormant · Mid-render hook destroy.** On
  `forceEvictBytes`, `featureDataBuffer`/segment buffers are **retired**
  (`gpu-tile-store.ts:669-676`) but the compute trio behind the same bind group is
  destroyed **immediately** via the hook (`:684`); the retire rationale applies
  verbatim. (Comment drift: ":684's 'Stays AFTER featureDataBuffer.destroy()'" — it
  is a retire now.)
- **F-12 · PLAUSIBLE · `resetForReupload` is the async-upload guard's blind spot.**
  `reset()` keeps the same arena `rhiBuffer` (`gpu-tile-store.ts:354-362`), so the
  suspension-boundary identity check (`upload-coordinator.ts:805-806`) passes and
  `_destroyed` is false: a stale-offset submit can overwrite a re-allocated range,
  and the captured inner map is orphaned (permanent `_gpuCacheCount` +1 — enabled by
  the count increment living in the coordinator, `:873`, split from `cache.set`).
  Today's five `setLineRenderer` call sites all precede upload start; the API's
  contract gap is the risk.
- **F-13 · PLAUSIBLE · #1570 liveness latch partial coverage (WebGL2).**
  `assertLive` guards `createBuffer`/`createTexture` only; sampler/pipeline/
  bind-group creation on a stale device is unguarded — the latch's own comment
  demands "every ALLOCATING entry point".
- **F-14 · PLAUSIBLE · `Material.poolSlot` resurrection.** No `_destroyed` check
  (`material.ts:193-205`); a draw through a destroyed Material re-creates slot
  buffers that the idempotent second `destroy()` (`:229`) then never reclaims.
- **F-15 · PLAUSIBLE · Staging slot loss windows.** Post-borrow region of
  `asyncWriteBuffer` has no try/catch (`staging-buffer-pool.ts:276-285`);
  `awaitWrites`' `Promise.all` reject strands resolved siblings' slots and the
  dispatch catch backstop never calls `sink.releaseAll()`
  (`upload-coordinator.ts:195-200,886-902`).
- **F-16 · PLAUSIBLE (recorded) · Bundle-key theory edges.** `setFillRhi` swaps
  pipeline objects without bundle invalidation (label-as-identity, currently
  unreachable); 32-bit structural key hash collision would replay a wrong bundle —
  `structural-key.ts:39-42` itself warns against this exact consumer shape.
- **F-17 · PLAUSIBLE · Reinit asymmetry.** `_teardownForReinit` skips
  `featureUpdateQueue.destroy()` (only full destroy calls it, `map.ts:5246`), and
  `featureIndex` is cleared only by `setSourceData` — a re-run scene re-declaring
  the same legacy-FC source name can take ghost patches / pin the old
  FeatureCollection.
- **F-18 · PLAUSIBLE (low) · Raster/hillshade post-destroy landings.** destroy =
  abort only; an already-resolved load's `.then` still caches + evicts after
  destroy (device backstop absorbs the GPU side).
- **F-19 · hygiene · `SpriteAtlasHost` has no destroy; `ImageBitmap.close()` is
  called nowhere** — decoded bitmaps + an atlas-sized readback OffscreenCanvas ride
  to GC. Asymmetric with #1404's resolution for the glyph host.
- **F-20 · design debt · Host-atlas replace strands dead texels** (append-only
  shelf, `host-atlas-packer.ts:60-66`; `removeImage` keeps the rect) — long-session
  fragmentation of the single 1024² page, warn+skip on exhaustion; retained icon
  batches draw the old rect until the next repack trigger (no notification channel).
- **F-21 · design constraint · The `GlyphShaper` seam** (`retained-text-packer.ts:58-66`,
  unwired today) will add a second `ensureString`/`consumeDirty` consumer and bake
  slot UVs into long-lived storage — it must ship as `{glyphs, generation}` + a
  repack trigger, or it recreates F-1 at bake scale and starves the drain-once
  channels (F-1's table shows the correct multi-consumer shape already in-tree: the
  PBF cache's **additive** callback registry).

### 4.3 Design-lifetime debts (the 5-year list)

- **D-1 · Page-permanent archive caches.** `defaultLoader`'s `archiveCache`/
  `tileJsonCache` (`vector-tile-loader.ts:586-587,806`) hold live PMTiles instances;
  clear API is test-only, zero prod callers; source teardown cannot reach them.
  Unbounded under rotating-URL usage (time-series archives).
- **D-2 · No last-map protocol for shared singletons.** Worker pools' disposes are
  test-only; geojson pools document the intent, `MvtWorkerPool` does not. Dead
  compile workers are permanent attrition (`deadWorkers` cleared only in dispose,
  `:245,264,460`) while the sibling tiling pool respawns + replays (#1572 D) — one
  family, three lifetime policies.
- **D-3 · Wall-clock where signals exist.** The 2 s shield's endpoints are both
  explicit events (result landed → key adopted into protectedKeys); the 12-frame
  prefetch age and the 30 s/10 s keep-warm deadlines trace to `safeFetch` having no
  timeout — a hung fetch pins its concurrency slot for the session
  (`tile-retry.ts:197-199` admits it).
- **D-4 · Cross-owner in-place mutation.** The upload path nulls cache-owned
  `prebuilt*` **and `polygons`** (`upload-coordinator.ts:883-886`); sub-tile
  generation needs `parent.polygons` for arc-continuous dashes and falls back to the
  "dash bug recurs" path when absent (`sub-tile-generator.ts:~396-408`) — over-zoom
  dash quality now depends on whether the parent uploaded first. (The accounting
  half already bit once: 497a2c1 "263 MB for 2 tiles".)
- **D-5 · Monotonic index growth as a load-bearing contract.** Synthetic XGVTIndex
  entries only grow (`tile-catalog.ts:85-86,438-453`; zero `entryByHash` deletion
  paths) because `indexGeneration = size`; bounding it needs a new invalidation
  design, not a cap.
- **D-6 · The protection contract is a caller habit.** Eviction safety rests on
  "`protectedKeys ⊇ selected`" (VTR `:1888-1892`) asserted nowhere in the catalog;
  a second consumer that memoizes by `contentGeneration` cannot detect eviction
  (deliberate: eviction does not bump it, `tile-catalog.ts:88-96`).
- **D-7 · Struct-level ownership is comment-encoded** (`GPUTile`, §2) and budget
  authority is scattered (~20 files declare independent caps).
- **D-8 · Guard levels are generational strata**, not policy: no-guard pool →
  DEV-only arena → always-on slot arena → leak-gated tile arena (§2).

## 5. What is already right (build on these)

The audit found real strengths — the target model in §7 is mostly "make these the
default" rather than new invention:

1. **`_destroyed`-first teardown + suspension-boundary identity guards**
   (`upload-coordinator.ts:803-823`, VTR `:2343-2360`) — the async-race matrix for
   uploads is fully guarded except F-12's reset case, including bidirectional
   compaction defense (`gpu-tile-store.ts:825-843`).
2. **Retire/post-submit discipline** in five mirrors (store ×3, drape bakes, point
   cache, ring drop-refs) — a hand-rolled frame fence that works.
3. **The generation/epoch family** — `uploadEpoch`, glyph `_generation` + post-loop
   read, `packedSkew`, `bindGroupEpoch`, and the `satisfies`-typed bundle key whose
   invalidation sweep this audit checked edge-by-edge and found **complete**.
4. **Leak gates that assert conservation:** `liveSlots === liveTiles`
   (`tile-uniform-arena.ts:223-233`), byte-drift audit, Cesium replacement-invariant
   audit, quality-flip draper-release behavioral + path-key gates (#1578),
   `rhi-destroy.test.ts` pinning per-backend destroy semantics.
5. **Single-authority teardown seams:** `abortLoadingTiles`, the coverage
   stop-block + `CoverageReadCancellation` controller-swap (#1569/#1570),
   `catalog.onDestroy` binding process-global worker indexes to catalog lifetime
   (#1353), `disposeOrphanedBoot` (#1577).
6. **Frame-redeclared consumer lifetime** (flow renderer prunes to what this frame
   declares — eviction propagation with no notification protocol at all), and the
   **additive callback registry** (PBF cache) as the correct multi-consumer shape.
7. **Atomic supersede swap** (#1371) with OOM re-arm; **bounded negative caches**
   quartet; **device-identity self-heal** (#737); **documented GC tier** with tests.

## 6. Benchmarks — what mature engines actually do

| Engine     | Model                                                                                                                             | What transfers to X-GIS                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cesium     | explicit `destroy()` + `isDestroyed()` throw-on-use; documented "you construct it, you destroy it"; permanent root-tile retention | the throw-on-use-after-destroy discipline (F-14 is its absence); ownership documented per class. Cesium does **not** refcount the engine.                      |
| three.js   | `dispose()` + dispose **events** — the renderer subscribes to deallocate its GPU mirror                                           | push-registration instead of per-site manual notify: the answer to substitute #6 (`dropTexture`, `consumeEvictions`)                                           |
| Unreal RHI | refcounted RHI resources + a **deferred-deletion queue fenced by frame index**                                                    | the fence-queue is substitute #4 done once, engine-wide; the refcount tier exists for D3D interop that JS/WebGPU does not have                                 |
| wgpu       | Rust ownership + internal submission-index tracker; user `destroy()` is safe anytime, deferred internally                         | "destroy is always safe; the engine defers" as the RHI contract — callers stop reasoning about submit timing                                                   |
| Godot      | RID handles + RenderingDevice dependency tracking (parent frees dependents)                                                       | the ownership-tree teardown (§7 P-2)                                                                                                                           |
| MapLibre   | per-frame retained-tile snapshot (`_updateRetainedTiles`) + a small `Tile.uses` count for dual membership (active set ↔ LRU)      | validates X-GIS's snapshot model as competitive baseline; the small count exists only where two containers share a tile — X-GIS's analogue is the pin (§7 P-5) |

Conclusion: no mature engine in this space runs engine-wide refcounting in a GC
language; all of them have (a) one fenced deferred-destruction service, (b) a
validation or notification story for shared resources, (c) explicit ownership
documentation. X-GIS has (a) hand-rolled ×5, (b) half-adopted, (c) implicit.

## 7. The 5-year target model

**"Single-owner tree + fenced retirement + validated borrows + explicit pins."**
Eight principles, each grounded in findings above:

- **P-1 Every resource has exactly one owner; transfer is explicit.** Owners form a
  per-map tree rooted at `XGISMap`, plus a _documented_ page tier (worker pools,
  `defaultLoader`, GC-owned RHI types — the tier already documented for RHI becomes
  the norm for all of it, with D-1/D-2 given last-map or budget policies).
  Cross-owner reach-ins become `take*()` APIs on the owner (closes D-4's class).
- **P-2 Destruction is structural, not chronological.** Attach-time registration
  (a `DisposeBag` per owner) replaces the hand-mirrored 112-line checklist;
  `_destroyed` idempotency becomes standard (today 2 of 62). Reinit = destroy of a
  designated subtree, killing destroy/reinit asymmetries (F-17) by construction.
- **P-3 One frame-fenced retirement service.** The five retire mirrors merge into a
  single engine-level `RetireQueue` drained in the post-submit window; every
  render-bound destroy goes through it (closes F-11's asymmetry; gives
  raster/hillshade textures a real fence instead of the visible-exempt heuristic).
  Inline destroy remains legal only at whole-device teardown. Long-term this is
  also the wgpu-style RHI contract: `destroy*` is always safe, deferral is internal.
- **P-4 Borrows are validated, not counted, on hot paths.** Every cross-frame cache
  entry that references a mutable resource carries a generation validated at use
  (closes F-1; constrains F-21's seam; the bundle key already models it). Validation
  has no unbalanced-pair failure mode, which is why it beats refcounts here.
- **P-5 Counts only at pinning boundaries — as pin objects, not integers.** Where a
  holder must _prevent_ reclamation across an async gap (not merely detect it
  after): in-flight uploads (today: structural pinning via not-yet-cached keys —
  keep), prefetch→adoption (today: the 2 s TTL — replace with a pin released on
  adoption, backstopped by TTL), sub-tile generation's parent hold, compute-handle
  exports (F-10's cure: the release hook frees the _pin_, generation-checked, not
  the keyed handle), cross-map singletons (D-2's last-map release). Pins are objects
  with mandatory release and a quiesce leak gate (`livePins === 0`).
- **P-6 Allocators and pools enforce liveness always-on.** `UniformSlotArena`'s
  throw-on-non-live-free becomes the floor: GPUArena prod guards (Set of live
  offsets — the DEV map exists), `GpuBufferPool` leased-set + terminal latch
  (closes F-2 and the double-release aliasing class), `Material.poolSlot`
  destroyed-throw (F-14), staging release-membership check.
- **P-7 Conservation gates as ratchets.** (a) RHI create↔destroy symmetry test;
  (b) per-owner leak gates (live X ⊆ live Y) wherever a cache owns GPU bytes;
  (c) teardown-reachability ratchet: every lifecycle method reachable from a root
  or on the documented page-tier list (kills dead APIs like `GPUTimer.dispose`
  drifting silently); (d) the existing byte/replacement audits stay. Gates are what
  make the model hold for five years of new contributors.
- **P-8 Async work carries its owner.** Every fetch/worker/mapAsync chain holds
  {AbortSignal from the owner's spine, liveness re-check at every resume point};
  late results are dropped _and their resources freed_. The catalog latch +
  coordinator guards are the template; F-5's direct reads and F-13's partial latch
  are the gaps to close; error paths return their claims (F-3, F-6, F-7, F-15).

### Rejected alternatives (recorded with reasons — do not re-propose)

- **Engine-wide Cesium/COM-style refcounting.** The dominant access pattern is
  per-frame residency + budget eviction, where snapshot protection is
  allocation-free and already correct; a global refcount adds an unbalanced-pair
  and cycle bug class plus hot-path traffic, and no benchmarked engine does it in a
  GC language. Refcount-shaped state is confined to P-5 pins.
- **`using`/`Symbol.dispose` as the core mechanism.** Scope-bound disposal cannot
  express collection-resident, budget-evicted lifetimes. Adopt opportunistically
  for transients (encoders, staging borrows) and optionally alias `destroy()` on
  leaf owners for ecosystem interop — never as the model.
- **WeakRef/FinalizationRegistry-driven reclamation.** GPU bytes exert no JS GC
  pressure (the "iOS staircase", VTR `:2358`); VRAM budgets cannot wait for GC.
  Acceptable only as a DEV leak _detector_ (warn when a GPU-holding object is
  collected undestroyed), never as the reclamation path.
- **A single global ResourceManager registry.** Two-authorities drift (§12
  second-ratchet class); budgets are per-domain and belong to their owners. The
  tree + gates give the global view without a second authority.

## 8. Phased rollout

Each phase independently landable, no big-bang; every guard ships with a
fail-before test; §5 render gates on any release-path PR.

| Phase                               | Content                                                                                                                                                                                                                                       | Closes                                         | Verification                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **P0 — guards & gates** (pure adds) | always-on GPUArena prod guard; `GpuBufferPool` leased-set + terminal latch; `Material.poolSlot` throw; staging membership check; RHI symmetry ratchet; teardown-reachability ratchet + page-tier list; DEV FinalizationRegistry leak detector | F-2, F-14, pool-aliasing class, dead-API drift | fail-before: double-release → throw; release-after-dispose → destroy; ratchets red on synthetic violation |
| **P1 — one RetireQueue**            | merge the five retire mirrors; route raster/hillshade texture eviction through it; `destroy*` documented as always-safe                                                                                                                       | F-11; visible-exempt heuristic; comment drift  | existing render gates + a mid-render-evict stress spec                                                    |
| **P2 — quick defect burn-down**     | F-1 holdover generation tag; F-3 guard-before-create; F-4 cache flush on template change; F-5 route through `guardedFetch`; F-6/F-7 error-path returns; F-8 membership check                                                                  | F-1,3,4,5,6,7,8                                | per-fix fail-before tests (F-1's: pressure + fade → emit dropped)                                         |
| **P3 — typed disposal categories**  | branded `ArenaRange` vs owned handles in `GPUTile`-class structs; `take*()` consume APIs on TileData (prebuilt/polygons)                                                                                                                      | D-4, D-7, #1607 class                          | tsc; behavior-preserving; byte audits stay green                                                          |
| **P4 — pins**                       | pin objects at the async-hold points; 2 s shield → pin+TTL-backstop; compute-handle release via generation-checked pin; last-map release for singletons (or documented page policy)                                                           | F-10, D-1, D-2, D-3, D-6                       | quiesce gates: live pins = 0, retire queue drained, pool bytes ≤ cap                                      |
| **P5 — DisposeBag teardown**        | attach-time registration for map/reinit subtrees; reinit = subtree destroy                                                                                                                                                                    | F-17; the 112-line checklist class             | destroy/reinit parity test (every registered child dropped)                                               |

Sequencing rationale: P0/P1 are the highest safety-per-line and unblock nothing;
P2 pays down user-visible defects using only existing idioms; P3–P5 are the
structural spine and can proceed issue-by-issue (§9.5: one issue per shippable
unit, each with its gate).

## 9. Appendix — provenance

Mechanical sweeps and all CONFIRMED verdicts were verified in-session against the
working tree at `8f9bbfd` (branch `claude/data-ownership-reference-count-9bdu2o`,
even with `origin/main` at audit time). Subsystem passes: data package;
coverage/compute/targets; text/label/sprite; RHI/engine; map/VTR orchestration.
Related prior art: #782 (RHI asymmetry, fixed by #939), #1404, #1570, #1578, #1607,
#2042, #2165; CLAUDE.md §12 lessons ledger. Issue #2241 tracks this audit;
implementation phases should be filed as their own issues per CLAUDE.md §9.5.
