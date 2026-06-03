# X-GIS Ship-Readiness — Synthesized Production Plan

**Date:** 2026-06-03
**Branch audited:** `feat/render-verification-harness`
**Bar:** maplibre-gl as a publishable, embeddable npm library
**Scope:** Read-only synthesis of 8 dimension audits (packaging, lifecycle-leaks, security-input, webgpu-reach, api-stability, stability-crash, a11y, perf-thermal), cross-checked against source.

---

## 1. Overall Verdict

**NOT SHIPPABLE as a MapLibre-style npm library. Multiple independent hard blockers; not "one fix away" — it is a closed bun monorepo, not a package.**

The single biggest blocker is **packaging**: every package is `private: true` and `main`/`exports` point at raw TypeScript (`./src/index.ts`) with unresolvable `workspace:*` deps and a phantom `earcut`. `npm install @xgis/runtime` is *impossible today* and would ship raw `.ts` even if forced. Until that is fixed, **none of the other dimensions can be exercised by a real consumer** — which is the only reason packaging outranks the WebGPU-only reach gap and the open OOM crash.

Three blocker-class problems are independent (fixing one does not help the others):
1. **Packaging** — cannot be installed/imported at all.
2. **WebGPU-only, no fallback** — even once installed, ~25-30% of a consumer's users get a blank map vs MapLibre's ~96-98% WebGL2 reach. Strategic bet, not a bug.
3. **Zero accessibility** — hard WCAG 2.1 A/AA blocker for any public-web embedder (EN 301 549 / Section 508).

Plus one open **crash** (globe z13 PMTiles OOM, PR #218 unmerged) and a wide-open **SSRF surface** on the highest-volume fetch paths.

The engine internals are genuinely good (unified ECEF projection, solid GPU-memory teardown in `device.destroy()`, a correct-and-hardened SSRF primitive, real input OOM budgets). The gap is almost entirely at the **library boundary**: packaging, browser reach, a11y, event/query API shape, and finishing the wiring of guards that already exist.

---

## 2. P0 Blockers — must fix before ANY ship

Ranked by **(likelihood on a default mercator web map) × (severity)**. A "default mercator web map" = a 3rd party who `npm install`s X-GIS, drops it in a React/Vue app, and feeds it a style + a GeoJSON or PMTiles source.

| # | Dimension | Blocker | Evidence | Fix | Effort |
|---|-----------|---------|----------|-----|--------|
| P0-1 | packaging | **Cannot be published or imported.** All 5 packages `private:true`; `main`/`exports` = raw `./src/index.ts`; `@xgis/compiler`/`@xgis/shared` are `workspace:*` (unresolvable on npm); `earcut` imported by runtime+compiler but declared only in **root** `package.json:28` (phantom). `dist/index.js` exists but is a 1.2K orphan nothing references; runtime has **no `build` script** so `bun run build` skips it. | runtime/package.json:4-15; compiler/package.json:4; shared/package.json:4; root package.json:28; `git tag` empty | Drop `private`; add a real bundler build (tsup/esbuild) emitting ESM+`.d.ts` with deps externalized **or** compiler/shared inlined; point `main`/`module`/`types`/`exports` at `dist`; move `earcut` into runtime+compiler deps; replace `workspace:*` with published semver or bundle. | **L** |
| P0-2 | packaging / legal | **No LICENSE despite README "MIT".** No `LICENSE` file, no `license` field in any package.json → legally "all rights reserved." Blocks adoption at any company that vets dep licenses. | No `LICENSE` at root; README.md:201-203 claims MIT | Add `LICENSE` + `"license":"MIT"` to each published package. | **S** |
| P0-3 | stability-crash | **Globe z13 multi-layer PMTiles → renderer-process crash.** Arena bumpPtr is monotonic; `reclaimIfDrained` needs `liveBytes===0` (impossible with protected stableKeys) → alloc throws every frame → forceEvict/retry storm → tab dies. Reproduced 2× real-GPU. Fix **PR #218 is OPEN/unmerged** on this branch (verified: state=OPEN, mergeable). | gpu-arena.ts:278-284; vector-tile-renderer.ts:818-828,1841-1854; PR #218 | **Merge PR #218** (safe-window compaction; reviewed sound, 50/50 arena + 4/4 pixel green). Then bound consecutive compaction deferrals under sustained async upload. | **S** (merge) |
| P0-4 | webgpu-reach | **WebGPU-only, no WebGL2 fallback + no default fallback UI.** `initGPU` throws `WebGPUUnavailableError`; no `getContext('webgl2')` anywhere in `runtime/src` (verified 0 matches). If host forgets the optional `onWebGPUUnavailable` hook, end-users get a **silent blank canvas**. ~70-75% reach vs MapLibre ~96-98%. | gpu.ts:135-144,181; map.ts:1691-1696,2352-2357 | **Strategic decision required (see §6).** Minimum-to-ship: built-in default fallback message rendered via 2D context when no host hook is set (~30-50 LOC) + a documented browser-support matrix + `browserslist`. WebGL2 backend is L-XL and likely out of v1 scope. | **S** (degrade UI) / **L-XL** (fallback) |
| P0-5 | security-input | **SSRF guard not applied to tile / TileJSON / PMTiles / style URLs.** `assertSafeRemoteUrl` is correct and hardened (IPv6/NAT64/6to4/decimal bypasses covered) but wired into only **2 sites** (sprite-atlas-host.ts:149, glyph-pbf-cache.ts — verified 2 occurrences). Tile XYZ, TileJSON manifest, `new PMTiles(url)`, and `.xgis`/style loads fetch host-supplied URLs verbatim → attacker style can probe `169.254.169.254` / internal hosts from the victim origin. | safety.ts:131; vector-tile-loader.ts:98,446,502; map.ts:1527 | Route every remote fetch through `assertSafeRemoteUrl` (degrade-to-failed like sprite/glyph). Validate PMTiles URL before `new PMTiles()` since the lib fetches internally. | **M** |
| P0-6 | security-input | **Decompression-bomb + unbounded-body holes.** PMTiles archive tiles arrive already-decompressed from the pmtiles lib, bypassing the 8MB `readBodyCapped` cap; TileJSON `.json()`, `.xgb` `arrayBuffer()`/`.json()`, `.xgis` `.text()` are uncapped; public `loadGeoJSON()` + `updateFeature()` skip `assertIngestBudget`. A hostile archive/collection OOMs the tab. (Aligns with the same arena pressure as P0-3.) | vector-tile-loader.ts:256-268,504; map.ts:2369,2407,2410; loader/geojson.ts:32,46 | Length-check `resp.data` vs `MAX_TILE_BYTES` at the archive boundary; wrap the unbounded reads in `readBodyCapped`; call `assertIngestBudget` in `loadGeoJSON`/`.xgb` path; add a per-tile vertex ceiling in `decodeMvtTile`. | **M** |
| P0-7 | a11y | **Zero accessibility — keyboard- and screen-reader-inaccessible.** No `tabIndex`, no `role`/`aria-label`, no keyboard pan/zoom/rotate (0 keydown listeners), no focus ring, no live region (verified: 0 matches for tabindex/aria/role across `runtime/src`). Hard WCAG 2.1 SC 1.1.1 / 2.1.1 (Level A) failure. | map.ts:500; controller.ts:488-493; (grep: 0 a11y matches) | Set `canvas.tabIndex=0`; add `role='region'`+`aria-label`; add keydown handler (arrows=pan, +/-=zoom, Shift=fast, Esc=reset); add `:focus-visible` outline. (Live-region + reduced-motion → P1.) | **M** |
| P0-8 | api-stability | **No map lifecycle/camera events.** Event system supports ONLY 7 feature pointer events (click/mouseenter/mouseleave/mousemove/pointerdown/pointerup/wheel). `map.on('load'|'moveend'|'zoom'|'idle')` — the MapLibre integration backbone — **silently never fires** (no error). Breaks data-load gating, URL-sync, analytics invisibly. | layer.ts:301-303; map.ts:2650-2674 | Emit a map-level event bus from camera controller + render loop: at minimum `load`, `move`/`moveend`, `zoom`/`zoomend`, `idle`. Widen the type union. | **M** |

> **Why these and not others:** P0-1/2 gate literally everything (no install → nothing else reachable). P0-3 is the one confirmed tab-crash on a realistic data source. P0-4 is the reach make-or-break. P0-5/6 are exploitable by the *normal* MapLibre pattern (user-supplied style/source URLs). P0-7 is a legal/compliance hard-stop for public web. P0-8 silently breaks the most common integration code. `easeTo/flyTo`=jumpTo, `queryRenderedFeatures` absent, and the `XGISMap(canvas)` constructor shape are **high but P1** — they degrade or require a rewrite rather than crash/blank/leak/expose.

---

## 3. P1 — needed for a credible GA / 1.0

| Dimension | Item | Evidence | Effort |
|-----------|------|----------|--------|
| api-stability | **Constructor + style shape incompatible with MapLibre.** `new XGISMap(canvas)` + `map.run(xgisSource, baseUrl)` with a custom `.xgis` DSL vs `new Map({container, style, center, zoom})` + JSON style. Either add a `{container, style}` adapter that compiles JSON→IR, or drop "MapLibre-style" framing and document the bespoke API honestly. | map.ts:500; map-types.ts:90 | L (adapter) / S (re-frame) |
| api-stability | **`easeTo`/`flyTo` are silent `jumpTo` aliases** — accept `duration`/`easing`/`curve` and ignore them. Implement rAF transitions; emit move/moveend. | camera-controller.ts:230-235 | M |
| api-stability | **No `queryRenderedFeatures`.** Picking is async, ID-only `pickAt`. No `querySourceFeatures`/`getStyle`/`getSource`/`setFilter`/`setLayoutProperty`. Add sync `queryRenderedFeatures(point|bbox): Feature[]` (reuse `buildFeatureForEvent`). | map.ts:938,1457 | M |
| lifecycle-leaks | **destroy() is GPU-complete but data/worker/raster-incomplete.** `device.destroy()` frees all GPU (good). But `teardownSource` never calls source `detach()`/`detachBackend()` (in-flight PMTiles fetches + AbortControllers leak); `RasterRenderer` has no `destroy()` (fetch controllers leak); 3 page-shared worker pools never terminated; `PanZoomController` leaks its `contextmenu` listener (controller.ts:181 not in cleanup 495-502) on the host-owned canvas. Repeated SPA mount/unmount accumulates. | map.ts:2739-2746,2757-2805; raster-renderer.ts:41; controller.ts:181,495-502 | M |
| lifecycle-leaks | **`QUALITY` is a global mutable singleton** → `mapA.setQuality()` mutates `mapB`'s DPR/MSAA/picking. Breaks multi-instance (a library must support N maps/page). Move into per-map state. | quality.ts:239-248; map.ts:839-841 | L (many read-sites) |
| stability-crash | **A single frame exception permanently kills the map.** `renderLoop` catch sets `running=false` and never reschedules rAF; no `onRenderError` hook, no per-tile isolation (verified map.ts:2421-2430). Scope the try/catch per-pass/per-tile or keep the loop alive + fire a host hook. | map.ts:2429 | M |
| stability-crash | **Worker crash mid-compile → compile Promise never settles** (silent dead source / host hang). `error` listener only `console.error`s; doesn't reject pending jobs. | geojson-compile-pool.ts:147-149; mvt-worker-pool.ts:161 | S |
| webgpu-reach | **Device-lost has no built-in recovery.** Render loop just `return`s on `deviceLost` (frozen canvas); all re-init pushed onto host. Add opt-in bounded-retry re-init from retained scene state. | gpu.ts:204-213; render-loop.ts:124 | M-L |
| stability-crash / render | **Inline-GeoJSON POINT features render 0 ink when mixed with poly/line.** Confirmed visually + flagged OPEN in the harness (`_render-verify-oracle-b.spec.ts:512-522`); amber excluded from `requireInk` so the gate stays green. Common case (POIs+boundaries in one FeatureCollection) silently loses all points. | _render-verify-oracle-b.spec.ts:512-522; .omc/shots/render-verify/* | M |
| perf-thermal | **Label dispatch loop runs every frame on a static camera** (~10.9ms = 73% of frame at z13). Skip-replay (Phase L.1) is instrumented but not implemented. Plus per-polyline `Float32Array.slice()` allocation in the curved-label hot path (GC stutter) and no off-screen pre-cull before the O(N²) collision pass. | label-pass.ts:239-259,763-764; text-collision.ts:83-150 | M |
| a11y | **No attribution control** (legal gap for OSM/OpenFreeMap) + **no live-region viewport announcements** + **prefers-reduced-motion** not wired (latent until animation lands). | grep: 0 attribution matches; map.ts:642 | M |
| packaging | **Orphaned dist ships ~57% test files / 11MB**; no `files` allowlist, no `sideEffects:false`, missing `module`/`types`/`repository`/`keywords`/`engines`/`browserslist`. Fixed by the P0-1 build rework but enumerate here. | runtime/dist (258/449 .test.js) | S-M |
| packaging / docs | **Root README actively misleads** — claims "Canvas 2D fallback" (doesn't exist) and "3 packages" (5+). Erodes trust at first contact. | README.md:29,130-142 vs runtime/README.md:15-22 | S |

---

## 4. P2 — post-launch / nice-to-have

| Dimension | Item | Effort |
|-----------|------|--------|
| api-stability | Runtime style mutation (`setStyle`/`addLayer`/`removeLayer`/`addSource`/`addImage` are warn-once no-ops; `setPaintProperty` non-spec boolean-return, ~7 props). Keep loud stubs; build incremental IR-patch later. | L |
| api-stability | Semver/stability posture: still 0.0.1, no CHANGELOG/changesets, deep internals (Camera/MapRenderer/ComputeDispatcher) re-exported with no `@public`/`@internal`. Adopt changesets; define a stable surface; move internals behind `/internal`. | S-M |
| perf-thermal | adaptive-DPR is implemented but **opt-in with `interactionDpr:null` default** → inert for all consumers. Set a sensible default on high-DPR devices or document the opt-in. | S |
| perf-thermal | High-pitch drag p95 ~62ms (label pipeline on main thread). Phase L.1 skip-replay is the lever; secondary = move polyline projection to a worker. | M-L |
| perf-thermal | `proj4` (~180KB) unconditional synchronous import on critical path; move behind dynamic `import()` inside `reprojectFeatureCollection`. | S |
| lifecycle-leaks | Pending flush rAF handle not cancelled in destroy() (inert via `_destroyed` guard, latent footgun). | S |
| stability / perf | GPUArena no intra-session compaction (bumpPtr pins ~66MB over long mixed-zoom sessions); Phase 6a.5 defrag. Partly addressed by PR #218. | M |
| a11y | `XGISMapOptions` a11y config surface (`accessibilityLabel`, `keyboard`, `attribution`). | S |
| webgpu-reach | Documented/enforced browser-support matrix (SUPPORTED-BROWSERS.md) + iOS float32-filterable caveat. | S |
| security-input | Per-tile vertex/feature ceiling in `decodeMvtTile` as defense-in-depth (subsumed by P0-6). | S |

---

## 5. Recommended Ordered Next Steps

1. **Merge PR #218** (eliminates the one confirmed tab-crash; work is done, green, mergeable). — *P0-3*
2. **Add LICENSE + `license` field** (trivial legal unblock). — *P0-2*
3. **Finish SSRF wiring** — route tile/TileJSON/PMTiles/style fetches through `assertSafeRemoteUrl`; cap the archive/`.xgb`/`.xgis`/TileJSON bodies; budget `loadGeoJSON`. The primitives exist; this is finishing wiring, not redesign. — *P0-5, P0-6*
4. **Stand up the real build + package boundary** — bundler (tsup/esbuild) → ESM+`.d.ts`, externalize/inline compiler+shared, drop `private`, fix `exports`/`main`/`types`/`files`, relocate `earcut`. This is the largest single piece and gates a real `npm install`. — *P0-1*
5. **Make the WebGPU-unavailable path non-silent** — default 2D-context fallback message when no host hook + publish the browser matrix + `browserslist`. Decide the strategic reach question (§6) **before** marketing as a MapLibre replacement. — *P0-4*
6. **Baseline a11y** — tabIndex, role/aria-label, keyboard pan/zoom, focus ring. — *P0-7*
7. **Emit map lifecycle events** (`load`/`move`/`moveend`/`zoom`/`zoomend`/`idle`). — *P0-8*
8. **Add the create→destroy→recreate + 2-instance e2e gate** — this single test catches the destroy() data/worker/raster leaks AND the QUALITY cross-talk; finish destroy() (source detach, raster destroy, contextmenu cleanup, per-map QUALITY) against it. — *P1*
9. **Real animation** (`easeTo`/`flyTo`) + **`queryRenderedFeatures`** — the remaining MapLibre-integration backbone. — *P1*
10. **Implement Phase L.1 label skip-replay** + fix the inline-POINT 0-ink bug — perf + a confirmed silent data-loss render bug. — *P1*

---

## 6. Strategic Calls

### 6a. WebGPU-only browser reach — THE decision

Three options:

- **Ship WebGPU-only + graceful-degrade (recommended for v1).** Keep the WebGPU bet (it is *why* the compute/storage-buffer architecture exists — see WEBGPU_ROADMAP.md), but (1) ship a **default fallback UI** so unsupported browsers see a message not a blank canvas, (2) **publish and enforce a browser-support matrix** + `browserslist`, and (3) **stop positioning as a drop-in MapLibre replacement** — position as a *modern/WebGPU* renderer. This is honest, low-effort, and ships. Accept ~70-75% reach as the product's stated envelope. The graceful-degrade + matrix is **mandatory**; without it this is a blocker. With it, WebGPU-only is a *defensible product choice*, not a defect.
- **Invest in a WebGL2 fallback (L-XL, defer past v1).** This is the only path to true MapLibre reach parity, but it is a second renderer backend — a multi-month effort that likely forces compromises on the compute path. Do NOT block v1 on it; track as a post-1.0 reach initiative if market data demands it.
- **Gate behind feature-detection only (insufficient alone).** Feature-detection already half-exists (`onWebGPUUnavailable`); shipping *only* that, with the silent-blank default, is the current state and is the blocker. Detection is necessary but not sufficient — it must come with the default fallback UI.

**Call:** Ship WebGPU-only **with** default-fallback + browser matrix + honest positioning. Treat WebGL2 as explicitly out of v1 scope.

### 6b. Freeze the public API surface NOW

The barrel re-exports deep internals (Camera, MapRenderer, ComputeDispatcher, VectorTileLoader). The planned VTR/map.ts god-file decomposition will be a *silent breaking change* for anyone who imported them. **Before 1.0:** define the stable surface = `XGISMap` + web component + public types; mark everything else `@internal` or move behind a `/internal` subpath; adopt changesets. Freeze before you publish, not after.

### 6c. What to CUT for v1

- **CUT runtime style mutation** (`addLayer`/`removeLayer`/`setStyle`/`addSource`/`addImage`). Keep the loud warn-once stubs (already implemented). Document the compile-time-IR model as the *intended* workflow. Real incremental IR-patch is post-1.0.
- **CUT the WebGL2 fallback** (per 6a) — out of v1 scope, behind a documented matrix.
- **CUT real `flyTo` curve fidelity** if needed — ship `easeTo` (linear/eased rAF) for v1, defer the MapLibre fly-curve. But do NOT ship them as silent `jumpTo` aliases; either animate or document the alias loudly.
- **CUT blueprint/site/playground from the published surface** — publish only runtime (+ its compiler/shared deps bundled or versioned).
- **DO NOT cut:** a11y baseline, SSRF wiring, the OOM fix, lifecycle events, LICENSE. Those are the difference between "library" and "demo."

### 6d. Honesty as an asset

The runtime/README and inline comments are unusually candid about every gap (no Canvas2D path, jumpTo aliasing, ID-only picking, shared worker pool). That honesty is a real asset — preserve it, but **reconcile the root README** (which contradicts it) before publishing, or it becomes a liability at first contact.

---

## Per-Dimension Verdicts (one line each)

| Dimension | Verdict | One-line |
|-----------|---------|----------|
| packaging | **blocker** | Closed monorepo; private + raw-TS main + workspace:* + phantom earcut + no LICENSE → `npm install` impossible. |
| api-stability | **blocker** | Incompatible constructor/style + no lifecycle events + no queryRenderedFeatures + easeTo/flyTo=jumpTo; not a MapLibre drop-in. |
| webgpu-reach | **blocker** | WebGPU-only, no fallback, no default fallback UI, no browser matrix → ~70-75% reach + silent blank. |
| a11y | **blocker** | Zero a11y: no tabIndex/role/aria/keyboard/focus/attribution → hard WCAG A/AA fail. |
| security-input | **risky** | Correct, hardened guards exist but wired into only 2 of ~6+ ingest sites; tile/manifest/archive/style SSRF + decompression-bomb holes open. |
| stability-crash | **risky** | Happy path stable; one open tab-crash (PR #218), frame-exception kills map, worker-crash hangs source. |
| lifecycle-leaks | **risky** | GPU teardown solid; data/worker/raster/listener teardown incomplete + global QUALITY breaks multi-instance. |
| perf-thermal | **risky** | adaptive-DPR fixed; label loop runs every static frame + per-frame allocs + no published bundle/proj4 on critical path. |

**Net: 4 blocker + 4 risky. No dimension is "ready." The blockers are at the library boundary; the engine is sound.**
