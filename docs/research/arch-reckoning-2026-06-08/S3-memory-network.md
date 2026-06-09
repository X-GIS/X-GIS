# S3 — Memory lifecycle + network concurrency/backpressure: the COLD verdict

**Theme:** GPU/tile memory lifecycle + network concurrency / backpressure / cancellation / worker-pool crash recovery (the "excessive network traffic could harm desktop stability" fear).
**Evidence base:** A3 (first-hand code, file:line), B3 (MapLibre — direct peer), B4 (deck.gl/three.js/luma.gl — same-stack siblings), B5 (DOD/refactor/testing/backpressure principles).
**Date:** 2026-06-09.

---

## 1. COLD VERDICT (1 paragraph): CONDITIONALLY SUSTAINABLE — the spine is right, three leaks are not

This axis is **sustainable as-is for the 5-year / 3D-tiles / 4D goal in its load-bearing parts, but NOT trustworthy on a long-lived desktop session until three named defects are closed** — and the owner's stated fear is aimed at the wrong target. The *tile* fetch path — the obvious flood vector — is already a textbook bounded-concurrency, priority-queued, abort-on-intent, byte-aware-eviction subsystem (A3 §1.1, §2.1, §2.3), which is **exactly the five-invariant scheduler B5 §(e) and B3 §9 prescribe**, and the GPUArena is the strongest module on the axis (A3 §2.1). So the owner's "network flood" fear is *unfounded for tiles*. What is NOT sustainable is the set of paths the owner did not name and the references say will bite hardest over a decade: (a) **glyph-PBF and sprite fetches have zero concurrency cap and no cancellation** (A3 §1.2) — a real, uncapped first-touch burst on a multilingual view, the precise thing B5 §(e) and B3 §9 say a tile client must never do; (b) the **glyph atlas GPU texture leaks monotonically** for the tab's life with no shrink/repack (A3 §2.2), an instance of the three.js "remove ≠ free / caller must dispose" anti-pattern B4 §2.3 explicitly tells X-GIS to reject; (c) **worker pools never respawn after a crash** (A3 §3), violating the deck.gl/luma.gl lesson that the *framework*, not the caller, owns resource lifetime and recovery (B4 §2-3). None of these is architectural rot — each is a localized contract gap on an otherwise sound spine. The verdict is therefore **3/5 and rising**: keep the spine, close three holes, and this axis carries the 4D load.

---

## 2. ROOT CAUSES (not symptoms)

The three live defects (glyph flood, atlas leak, no worker respawn) and the SPA worker leak are **four symptoms of two root causes**:

### Root cause R1 — "lifecycle ownership is per-subsystem and inconsistent; there is no single contract that says *who frees what, when, and who recovers from failure*."

The tile path got a *full* lifecycle (enqueue-reserves-slot → priority → abort-on-evict → byte-aware evict → `device.destroy()`) because it was hardened under the globe-OOM crash (MEMORY: PR #193). Every **other** resource-producing path was built ad-hoc and got only the slice of lifecycle its author happened to need:
- glyph-PBF got dedup but **no queue/abort** (A3 §1.2) — half a lifecycle;
- the glyph atlas got per-slot LRU but **no page reclaim** (A3 §2.2, `atlas-state.ts` `pageCountInternal` only ever increments) — half a lifecycle;
- the worker pools got error-logging but **no respawn/timeout** (A3 §3) — no failure lifecycle;
- the shared pools got a `dispose()` that exists but is **wired only to test cleanup** (A3 §2.4) — a lifecycle method with no production caller.

This is **precisely the failure mode B4 §2.3 names as three.js's decade-long wart**: "removing a mesh from the scene frees *nothing* — the caller must remember to `dispose()`." X-GIS has the same shape: the *framework* does not own teardown/recovery uniformly, so each subsystem leaks in the exact dimension its author forgot. B4's prescribed cure (deck.gl `finalizeState` — the framework destroys resources when a layer leaves the diff; luma.gl explicit lifecycle-owned `destroy()`) is the structural answer, and B4 §3 #11 explicitly tags caller-driven dispose as ❌ **reject**.

### Root cause R2 — "the producer→consumer contract is one-directional: producers land data but nothing re-arms the render, and nothing bounds the producers as a class."

The async-landing re-arm gap (A3 §4: glyph `onLanded` → `invalidate()` but `_needsRender` is never re-set) and the glyph flood (A3 §1.2) are the **same missing contract** seen from two sides. B4 §2.2 and §3 #8 name this as *structural to demand-render*, not incidental: "every async arrival (texture/tile/glyph/sprite load) MUST re-invalidate, or the frame is dropped" — and the symmetric rule "every async *producer* must be bounded by the same concurrency discipline as tiles." X-GIS has a *single coarse* `_needsRender` bit (MEMORY: "re-arm `_needsRender`"); B3 §5 is blunt that **one global dirty bit is too coarse** and that splitting into per-domain dirty flags is what makes the re-arm bugs disappear, because the landing callback sets the *specific* domain dirty. The flood and the stale-frame are the two faces of "producers are not first-class citizens of the scheduler."

**What is NOT a root cause (kill these hypotheses):** tile-fetch flooding (capped, A3 §1.1), arena fragmentation/OOM (solved, A3 §2.1), count-vs-byte eviction (byte-aware with hysteresis, A3 §2.3), `map.destroy()` GPU/DOM leaks (thorough, A3 §2.4). The owner's named fear is **already fixed**; do not re-spend budget there.

---

## 3. TARGET STATE (what "good" looks like, grounded in the references)

"Good" is **one uniform resource+request lifecycle, owned by the framework, applied to every producer — not just tiles.** Concretely, grounded in what the peers actually do:

1. **One bounded, abortable, priority-queued request scheduler for ALL network producers** (tiles, glyph-PBF, sprite, future 3D-tiles), not one per type. This is B5 §(e)'s five invariants — bounded concurrency / SSE-or-distance priority / abort-on-intent / gesture-throttle / dedup — and B3 §9's "byte-aware, abortable" budgeting, applied uniformly. The tile path already *is* this (A3 §1.1); the target is to route glyph/sprite through the *same* `PriorityQueue` + `AbortController` (A3's own §1.2 fix). 3D-tiles makes this non-optional: B5 §(e) notes 3D-tiles fetches are "larger and hierarchical, so SSE-driven priority + abort-on-camera-change becomes the *dominant* perf lever, not an optimization."

2. **Framework-owned GPU resource lifetime with reclaim, never caller-driven dispose.** Every GPU resource (atlas pages included) lives under a lifecycle that the framework tears down — the deck.gl `finalizeState` model (B4 §3 #2, #11), the luma.gl explicit lifecycle-owned `destroy()` + `AsyncTexture` for late-arriving imagery (B4 §1.6, §3 #10). For the atlas specifically: a `shrinkPages(n)` that `copyTextureToTexture` survivors into a smaller texture then `.destroy()`s the old (A3 §2.2's prescription), gated on glyph count dropping below a fraction of the page high-water mark — i.e. the atlas gets the **same byte-aware, hysteresis-shrinking** discipline the tile cache already has (A3 §2.3). The arena (A3 §2.1) is the *positive control* — its compact/reclaim/destroy contract is already exactly this; the target is to make every other GPU pool match it.

3. **Failure is part of the lifecycle: pools self-heal.** B4's core lesson (deck.gl/luma.gl: the framework owns the resource, including its death) means a worker crash is a *recoverable lifecycle transition*, not a permanent degrade. Good = on `error`: remove dead worker, spawn replacement, re-dispatch (or reject-and-let-catalog-re-request) in-flight jobs, plus a per-job timeout so a hung compile is bounded (A3 §3 fix). The GeoJSON *tiling* pool already does the least-bad version (lazy respawn via `_worker = null`, A3 §3) — promote that to all three with eager respawn.

4. **Per-domain dirty flags + universal re-arm invariant.** B3 §5's `_styleDirty`/`_sourcesDirty`/`_placementDirty` split (the named `DirtyDomains` authority in the Blender roadmap), so a glyph-PBF landing sets the *glyph/source* domain dirty and the convergence check re-requests a frame; plus B4 §3 #8's invariant — *every* async producer ends its completion handler by arming the render flag, **with a regression test that fails if a producer lands without invalidation.**

The synthesis B5 closes with names this exactly: "the tile scheduler is a first-class subsystem with five testable invariants — and it *grows* in importance under 3D-tiles/4D." Target state is to make that true for **all** producers and **all** GPU pools, not just the tile happy-path.

---

## 4. RECOMMENDATIONS (ranked; each with rationale / evidence / risk / blast-radius)

### R1 — Route glyph-PBF (and sprite) through the tile path's `PriorityQueue` + add `AbortController`
- **Rationale:** The single uncapped flood path that matches the owner's literal fear. A multilingual world view trips dozens of simultaneous unthrottled `fetch()`es in one frame (A3 §1.2), and once fired they run to completion even after the camera leaves (no abort). This is the exact anti-pattern B5 §(e) and B3 §9 say a tile client must never have; the tile path already proves the fix works in-repo.
- **Evidence:** A3 §1.2 (`glyph-pbf-cache.ts:108` raw fetch, dedup-only), A3 §1.1 (the queue to reuse: `pmtiles-backend.ts:181`, `core/priority-queue.ts:181`), B5 §(e), B3 §9.
- **Risk:** LOW. The queue and AbortController patterns already exist and are battle-tested on tiles; this is reuse, not new infra. Minor risk of over-throttling first-paint glyphs (mitigate: give glyph-PBF its own modest concurrency lane, not the tile budget).
- **Blast-radius:** SMALL — `glyph-pbf-cache.ts` + a shared queue handle; no change to atlas/render/worker code.

### R2 — Add worker-pool crash respawn + per-job timeout to all three pools
- **Rationale:** Under the very network/decode pressure the owner fears, one worker crash silently breaks ~1/N of MVT decodes forever (round-robin keeps posting to the dead slot) or hangs a GeoJSON-compile promise forever (A3 §3). No health check, no circuit breaker, no timeout exists. B4's framework-owns-lifetime lesson makes failure a recoverable transition, not a permanent degrade.
- **Evidence:** A3 §3 (`mvt-worker-pool.ts:161` rejects+clears but never respawns; `geojson-compile-pool.ts:147` only `console.error`s; `geojson-tiling-pool.ts:47` is the least-bad model to copy), B4 §2.3 / §3 #11 (framework owns lifecycle incl. teardown), B4 §3 #2 (`finalizeState` ownership).
- **Risk:** MEDIUM. Respawn logic can mask a deterministic crash loop (a poison tile that crashes every replacement). Mitigate with a respawn-rate circuit breaker (N crashes/window → surface an error event, stop respawning) — and per B3 §4 the error must be *surfaced, never swallowed*.
- **Blast-radius:** MEDIUM — three pool files; touches the decode pipeline's hot path but behind the existing pool API.

### R3 — Implement atlas `shrinkPages()` with byte-aware hysteresis (stop the monotonic GPU leak)
- **Rationale:** The one true monotonic GPU leak on the axis — invisible to JS profiling (WebGPU GC can't see GPU-process memory), never self-corrects mid-session, bites long-lived multilingual desktop tabs (A3 §2.2). It is exactly the three.js "remove ≠ free" trap B4 §2.3 says to reject; the tile cache (A3 §2.3) and arena (A3 §2.1) already prove the byte-aware-hysteresis-reclaim pattern in-repo.
- **Evidence:** A3 §2.2 (`glyph-atlas-gpu.ts:63-71` add-only, only `destroy()` site is teardown; `atlas-state.ts:191-211` `pageCountInternal` increment-only), A3 §2.1/§2.3 (the reclaim pattern to mirror), B4 §2.3 / §3 #10-11 (lifecycle-owned `destroy()`, reject caller-dispose).
- **Risk:** MEDIUM. `copyTextureToTexture` survivor-repack must be epoch/generation-guarded so an in-flight glyph upload doesn't write to a destroyed page; A3 §4 notes the `_generation` guard machinery already exists (positive control) — reuse it. Repack mid-session could cause a one-frame glyph flash if mis-sequenced.
- **Blast-radius:** MEDIUM — `glyph-atlas-gpu.ts` + `atlas-state.ts`; isolated to the label/glyph subsystem.

### R4 — Ref-count and dispose shared worker pools on last `map.destroy()`
- **Rationale:** `map.destroy()` is thorough on GPU/DOM (A3 §2.4) but *intentionally* leaves the shared MVT + GeoJSON pools alive. Benign for one map; for an SPA that creates/destroys maps (dashboards, route changes) **every destroyed map leaks 2-6 MVT + 1-4 GeoJSON workers**. The `dispose()` methods already exist but are test-only-wired.
- **Evidence:** A3 §2.4 (`map.ts:3211-3212` "intentionally NOT terminated"; `mvt-worker-pool.ts:271-278`, `geojson-compile-pool.ts:220-227` `dispose()` exist), B4 §3 #11 (framework owns teardown), B5 §(b) Rule-of-Three (ref-count is the *concrete* fix, not a new abstraction layer).
- **Risk:** LOW-MEDIUM. Ref-counting a global must be correct under concurrent map create/destroy; an off-by-one disposes a pool another map still uses. Mitigate: simple atomic ref-count incremented at pool-acquire, dispose at zero.
- **Blast-radius:** SMALL-MEDIUM — pool acquisition sites + `map.destroy()`; does not touch render/fetch.

### R5 — Split `_needsRender` into per-domain dirty flags + add a "producer-landed-without-invalidation" regression test
- **Rationale:** The async-landing re-arm gap (A3 §4: glyph invalidate doesn't re-arm `_needsRender`, settled frame shows stale glyphs) and the whole producer→consumer contract gap (root cause R2) are fixed structurally by per-domain flags. B3 §5 is explicit that one coarse dirty bit *causes* this bug class and per-domain flags *eliminate* it; B4 §3 #8 makes "every async producer re-invalidates" a *tested* invariant.
- **Evidence:** A3 §4 (`glyph-atlas-host.ts:251-261` invalidate without re-arm; `_generation` guard is correct positive control), B3 §5 (`_styleDirty`/`_sourcesDirty`/`_placementDirty`, "one global dirty bit is too coarse"), B4 §2.2 / §3 #7-8 (demand-render footguns; `requestRenderIfNotRequested` coalescing; arrival→invalidate invariant + regression test).
- **Risk:** MEDIUM-HIGH (blast-radius risk, not correctness). Touches the render-loop scheduling spine; this is a render-path change and per **B5 §(c)** must go through Branch-by-Abstraction with a golden-master image matrix locked *first*, migrating one producer at a time, never a big-bang. The named `DirtyDomains` authority in the Blender roadmap is the intended seam.
- **Blast-radius:** LARGE — render loop + every producer's landing callback. Do this **last**, behind the golden-master gate, after R1-R4 de-risk the producers individually.

---

## 5. UNCERTAINTIES & DISAGREEMENTS (explicit)

1. **Two A3 claims are tagged [INFER], not verified in code, and I inherit that uncertainty:** (a) the SPA shared-pool leak's *practical severity* (A3 §2.4 — `dispose()` existence is confirmed, but A3 did not trace `teardownSource` → a `pool.dispose()` call, so whether the per-backend fetchQueue/abortControllers also leak is unconfirmed); (b) the glyph-atlas leak being invisible to JS profiling rests on the W3C-explainer claim that WebGPU GC can't see GPU-process memory (A3 §2.2 [INFER]). Both are plausible and B4 §2.3 corroborates the *mechanism* (manual GPU disposal, GC blindness to GPU memory is the documented three.js reality), but the exact X-GIS severity is not pixel-confirmed. **Recommend a quick `device`-level memory-counter probe before sizing R3/R4.**

2. **B3 vs A3 on dedup — no conflict, but worth noting the asymmetry.** B5 §(e) and B3 §9 list "dedup repeated requests" as a *core* invariant; A3 confirms glyph-PBF *does* dedup (`:83-90`) even though it lacks a cap. So the glyph path has the cheap invariant (dedup) but not the expensive ones (cap/abort). This is mild evidence for R1 being lower-risk than it looks — the hardest part (dedup) is done.

3. **Disagreement on sprite urgency.** A3 §1.3 rates sprite-fetch uncapped-ness as LOW (cardinality ~2 per style). B5 §(e) would still list it as a scheduler invariant violation. I side with A3: cardinality ~2 means it is not a flood vector *today*. **But** if the 3D-tiles/4D direction introduces multiple/streamed sprite sources (e.g. per-layer or time-varying icon sets), sprite cardinality rises and it must fold into R1's unified scheduler. Flag, don't fix now.

4. **The DOD/ECS axis (B5 §a) is largely orthogonal to this theme and I did not lean on it** — it bears on the *vertex-packing* hot path, not on memory-lifecycle/network. The one relevant carry-over: B5's "GPU buffers are SoA/packed by nature" confirms the arena's byte-exact packed-buffer design (A3 §2.1) is the *correct* DOD zone-1 shape, reinforcing "the arena is the model, make other pools match it."

5. **Unverifiable from this evidence set:** the GPU-tile-cache thrash concern (visible set > `MAX_GPU_TILES` at high altitude → re-upload every frame) is explicitly *out of A3's scope* (A3 §2.3 — `MAX_GPU_TILES` lives in VTR, not read). I cannot confirm or deny it. If real, it is a *memory-churn* (not leak) issue and would interact with the 3D-tiles SSE-priority work; flag for a VTR-scoped audit.

---

### Bottom line
The spine (tile scheduler + arena + `map.destroy()` GPU/DOM) is **already what the references prescribe** — the owner's network-flood fear is fixed for tiles. The axis is held back by **two root causes** (non-uniform lifecycle ownership R1; one-directional producer contract R2) surfacing as four localized defects. Close R1-R4 (low-to-medium blast-radius, mostly reusing in-repo patterns), then do R5 last behind a golden-master gate. With those, this axis carries the 5-year / 3D-tiles / 4D load.
