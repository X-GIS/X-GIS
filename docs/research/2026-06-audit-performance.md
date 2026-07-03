# Audit ⑨ — Performance / frame budget / pacing

_Deep-research synthesis, 2026-06-08. File:line audit of the X-GIS render-loop/budget/batching merged with GPU frame-budget and map-renderer performance research. Part of the 10-audit series. Claims cited inline._

---

## TL;DR

The performance architecture is genuinely **sophisticated and well-instrumented** — a hybrid per-frame compile/upload budget (count floor + time ceiling), a demand-driven rAF loop with invalidation coalescing, **render-bundle caching at a 97.6% hit rate** (the textbook CPU-bound mitigation), 4-tier bind groups separated by update frequency, shared arenas that keep bundle buffer refs stable, a staging-buffer pool, and opt-in GPU timestamp profiling. The risks are **concentrated synchronous stalls**, not diffuse slowness: (1) **mobile `buildLineSegments` runs on the render thread** (HIGH — thermal throttle, forced refresh); (2) **high-pitch compile-budget convergence lag** (~60+ frames to fill a 273-tile frustum because the 4-compile/8-subtile budget is conservative and there's no compile worker pool); (3) **uniform-ring mid-frame grow** fires two `writeBuffer`s. Plus a per-frame O(N²) collision pass (mitigated) and **no automated frame-budget enforcement** (perf-marks are diagnostic only).

---

## A. Architecture (as audited)

**Budget:** hybrid count-floor + time-ceiling — 4 heavy compiles guaranteed + 8 light sub-tile clips under a ~6 ms wall-clock ceiling, hard cap 128/frame (`tile-catalog.ts:454-538`); device-adaptive upload (desktop 4 tiles/frame, mobile 1). **Loop:** demand-driven rAF; `_needsRender` coalesces invalidations; continues while tiles missed / uploads pending / rasters in-flight (`render-loop.ts`). **Batching:** `GPURenderBundle` cache, **97.6% steady-state hit rate**, 1024-entry LRU, replays thousands of draws in one `executeBundles()` — the correct fix since "render bundles only help when CPU-bound" [toji, high]. **Bind tiers:** 0 constants (device-life) / 1 camera (per-frame) / 2 tile (dynamic offset) / 3 feature (per-tile) — frequency-separated exactly as recommended [toji bind-groups, high]. **Memory:** staging-buffer pool (mapAsync + copyBufferToBuffer, SwiftShader fallback to `writeBuffer`), GPU arena with byte hysteresis, CPU frame arena. **Timing:** opt-in `?gpuprof=1` timestamp-query segments + 7-phase perf-marks.

## B. Findings (file:line, when it bites, severity)

### B1 — Mobile `buildLineSegments` synchronous on the render thread — HIGH

`vector-tile-renderer-helpers.ts:60-68` builds line segments **synchronously during upload** for XGVT-binary tiles on mobile (the PMTiles worker path bypasses it). On a mobile zoom-out over dense road tiles this spikes the render thread → **thermal throttle + forced refresh** (`mobile-zoom-out-load.spec.ts`) [audit #1]. The reference is unambiguous: parse/tessellate tiles **off the main thread** into GPU-ready buffers — "Bucket is the single point of knowledge about turning vector tiles into WebGL buffers," done on workers [Mapbox ARCHITECTURE.md, high]. **Fix:** move line-segment build to a worker pool (the PMTiles path already proves the pattern).

### B2 — High-pitch compile-budget convergence lag — MEDIUM-HIGH

At z≈10.3 / pitch 84° a cold load pulls ~273 frustum tiles; the 4-compile + 8-subtile budget takes **60+ frames (~1 s)** to converge, visible as tile dropout during pan (`tile-catalog.ts:493-496`; target ≤20 frames in `tile-pitch-throughput.test.ts`) [audit #11]. The design intent (no single-frame spike) is correct — Mapbox likewise uploads only **1–2 tiles/frame** because a single 512² tile upload is ~7.5 ms [mapbox-gl-js#7405, high] — but X-GIS lacks a **compile worker pool** to parallelize, so the only lever is the (conservative) serial budget. Raising the floor risks a single-frame spike; the real fix is parallel compilation. Cross-ref: the tile-coverage audit (high-pitch selection is _mitigated_ via camera-tile injection, but _convergence speed_ is this separate issue).

### B3 — Uniform-ring mid-frame grow → 2 writeBuffers — MEDIUM-HIGH

At high pitch (270+ visible tiles) the per-tile uniform draws exceed ring capacity; the grow path writes the old buffer (iter-348 fix for stale colors) **then** creates a new one — two `writeBuffer`s + an allocation mid-frame (`uniform-ring.ts:104-135`) [audit #3,#12]. **Fix:** pre-size the ring to a `MAX_GPU_TILES` estimate (256 desktop / 64 mobile) so the grow rarely fires. (Cross-ref Audit ②.)

### B4 — Per-frame O(N²) collision, no pauseable placement — LOW-MEDIUM

`text-collision.ts:83-150` scans all prior placed labels per candidate (~90K compares at 300 labels), **synchronously every frame** [audit #4]. It's mitigated (sort-key + same-line early-exit) and CPU-side, but the reference engines **spread label placement across frames** via pauseable/incremental placement (`PauseablePlacement#continuePlacement` yields mid-placement) so label-heavy scenes don't stall one frame [mapbox-gl-js#12351, med-high]. X-GIS has **no pauseable placement** (same structural gap noted in Audit ④). Worth it only if label-heavy frames show up in profiles.

### B5 — No automated frame-budget enforcement; timing gotchas — LOW-MEDIUM

perf-marks measure 7 phases but **nothing enforces a budget** — a frame can overrun with only diagnostic signal (`render-loop.ts:515`) [audit #13,#15]. And GPU timestamp-query is **quantized to 100 µs in production** (full precision needs Chrome dev flags), so any pass under 100 µs reads as 0 [Chrome WebGPU-120, high] — worth noting for anyone reading `?gpuprof=1` output. Also confirm pipeline creation uses `createRenderPipelineAsync` to avoid shader-compile-at-draw stalls (the sync variant can block GPU execution on compilation [MDN, high]); first-paint compile of the 27 pipelines is a known stutter class (Mapbox saw ~100 ms first-frame from program introspection [mapbox-gl-js#9384, high]).

## C. What's robust

Bundle cache (97.6% hit, lazy encode, LRU cap) — the correct CPU-bound fix; demand loop with `_needsRender` backpressure (avoids unconditional 60 Hz); 4-tier frequency-separated bind groups; hybrid budget (floor prevents heavy-compile starvation, ceiling prevents light-compile throttling); staging-buffer pool with SwiftShader fallback; GPU-arena byte hysteresis (75→60%) + ancestor protection; frame arena (collapses 665→348 KB churn — matters because GC pauses are a top WebGL jank source [MDN, med-high]); prefetch suppressed during interaction; 3-ring timestamp readback hiding mapAsync latency. This is a mature perf system; the gaps are specific stalls, not the design.

## D. Top fixes (ranked)

1. **Move mobile `buildLineSegments` to a worker** (B1) — the one HIGH, user-felt (thermal) stall; the PMTiles path is the template.
2. **Compile worker pool** for high-pitch convergence (B2) — parallelize the budget instead of widening the serial one.
3. **Pre-size the uniform ring** (B3) — cheap; removes the mid-frame 2-write grow at high pitch.
4. **(Optional)** pauseable label placement (B4) if profiles show label-heavy stalls; add a frame-budget tripwire so overruns surface (B5).

---

## Sources

**Codebase audit (file:line):** `tile-catalog.ts:454-538,493-496` (budget), `render-loop.ts:136,515,652` (loop, perf-marks, rAF), `vector-tile-renderer-helpers.ts:60-68` (mobile line build), `uniform-ring.ts:104-135` (grow), `text-collision.ts:83-150` (O(N²)), `bundle-cache.ts:120-171` (97.6% hit, LRU), `bind-tiers.ts`, `staging-buffer-pool.ts:92-94`, `gpu-arena.ts`, `frame-arena.ts`, `gpu-timer.ts`, tests `tile-pitch-throughput.test.ts`, `mobile-zoom-out-load.spec.ts`, `perf-scenarios.spec.ts`.
**Frame-budget research:** web.dev rendering performance (16.6 ms, <15 ms rAF, jank) https://web.dev/articles/speed-rendering [high]; toji render-bundles (only help CPU-bound) + bind-groups (frequency separation) https://toji.dev/webgpu-best-practices/render-bundles.html [high]; webgpufundamentals optimization/timing (state-change cost, timestamp workflow) [high]; Chrome WebGPU-120 (timestamp 100 µs quantization) [high]; MDN createRenderPipelineAsync (sync compile stall) [high].
**Map-perf research:** Mapbox ARCHITECTURE.md (Bucket, off-thread tessellation) [high]; mapbox-gl-js#7405 (7.5 ms tile upload, 1-2/frame) [high]; Mapbox perf doc (render = const + sources + layers) [high]; pauseable placement #12351 [med-high]; #9384 (100 ms first-frame compile) [high]; deck.gl performance (draw-call minimization, instancing, buffer-recalc dominant) [high]; MDN WebGL best-practices (GC pauses) [med-high].

_Confidence: the codebase audit (direct read) and toji/web.dev/Mapbox/deck.gl primary sources are load-bearing. Hardware-specific numbers (7.5 ms upload, 100 ms compile, 60-frame convergence) are order-of-magnitude, device-dependent._
