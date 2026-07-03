# A2 — Data flow + state ownership + event structure

Adversarial architecture audit. Axis: who owns/mutates camera/view/scene/style state; coherence of the dirty-domain invalidation system; the event surface; and whether data flow is unidirectional or a web of back-references.

Every claim below is `file:line` verified unless tagged **[INFERENCE]**. Paths relative to `D:/X-GIS/`.

**Verdict: 2 / 5** on 5-year sustainability for this axis. The state model is a single god-object (`XGISMap`) holding ~39+ private fields plus a long tail of package-internal fields exposed by reference to satellite controllers, with **4 redundant copies of camera state** kept as signature caches, an invalidation system that is **wired but inert** (7 of 8 dirty domains tagged and never consumed), and an event/camera-control surface that is partly a façade (`easeTo`/`flyTo` are `jumpTo` stubs). It is not collapsing — it renders — but the "single source of truth" the design comments claim does not exist in the data flow.

---

## 1. State ownership — one god-object, by-reference satellites

### FACT — `XGISMap` is the state god-object

- `runtime/src/engine/map.ts` is **3431 LOC** (`wc -l`). It holds **39 fields matched by a `private` regex** (Grep count, `map.ts`) plus a large set of **no-modifier package-internal fields** deliberately relaxed from `private` so satellite classes can read them by reference. The render path alone reaches **30+ distinct map members** — enumerated verbatim in the `RenderLoopHost` `Pick<XGISMap, …>` type at `render-loop.ts:47-102` (≈55 member names listed).
- Distinct state responsibilities co-located on this one class (each is a separate concern): camera ownership (`camera` field, `map.ts:123`), renderer handles (`lineRenderer`/`textStage`/`iconStage`/`rasterRenderer`/`pointRenderer`), source registries (`vtSources`/`rawDatasets`/`vectorTileShows`/`showCommands`), label dispatch caches (`_prevLabelDispatchSig`, `_labelDispatchHits/Misses`, `map.ts:337-339`), the idle-skip signature (`_lastSig*`, `map.ts:419-425`), the event signature (`_evtSig*`, `map.ts:2751-2755`), flicker telemetry (`_flickerLog`, `map.ts:373`), animation clock (`_startTime`/`_elapsedMs`, `map.ts:379-380`), lifecycle flags (`_loaded`/`_loadFired`/`_destroyed`/`_running`/`_interacting`), and the dirty/op subsystem (`_dirty`/`_ops`, `map.ts:411-412`). That is **~10 unrelated responsibilities on one class**.

### FACT — "decomposition" is relocation, not decoupling

The three satellite controllers do not own state — they borrow the map's state by reference and reach back in:

- `interaction-controller.ts:84-110`: the pick/hit-test cluster holds `camera`, `layerIds`, `xgisLayers`, `rawDatasets`, `_featureIndex` **as the same instances by reference**, and reads `ctx`/`pickTexture`/`projectionName`/`vectorTileShows` through injected accessors "read fresh." The file header (`interaction-controller.ts:13-26`) explicitly states "BEHAVIOR + PUBLIC API IDENTICAL — every method below is moved verbatim from map.ts; only the dependency wiring changed."
- `camera-controller.ts:4-15`: owns only 2 fields (`_maxBounds`, `_cameraExplicitlyPositioned`); everything else is "moved verbatim from map.ts."
- `render-loop.ts:1-16`: "Extracted VERBATIM from `XGISMap.renderFrame`… This is a RELOCATION, not a decoupling." It holds the owning map and reaches its members through a typed `host` view; the only mechanical change was `this.X → this.host.X`.

**[INFERENCE]** These extractions reduced the line count of `map.ts` but did not reduce coupling: the satellites are still hard-bound to the map's internal field layout. A field rename on `XGISMap` propagates into the `Pick<>` host type and every `host.X` call site. The render-pass layer makes this concrete: passes reach back into the host **89 times** via `host.X` (Grep over `render/passes/`), 49 of them in `label-pass.ts` alone.

### FACT — camera state is duplicated into 4 parallel signature caches

The "single source of truth" is the `Camera` instance, but its scalar state is mirrored into **four independent shadow copies**, each hand-maintained:

1. **Idle-skip cache** — `_lastSigZoom/CX/CY/Bearing/Pitch/W/H` (`map.ts:419-425`), written at end of every frame in `render-loop.ts:630-637`, read in `shouldRenderThisFrame()` (`map.ts:2822-2828`).
2. **Event cache** — `_evtSigCX/CY/Zoom/Bearing/Pitch` (`map.ts:2751-2755`), deliberately "Kept separate from `_lastSig*`" (`map.ts:2748-2750`), diffed in `_processCameraEvents()` (`map.ts:2769-2797`).
3. **MVP matrix cache** — `_cacheCx/Cy/Zoom/Bearing/Pitch/Cap/Far/W/H/Dpr` (`camera.ts:209-218`) plus a **second** ECEF copy `_ecefCacheCx/Cy/Zoom/Bearing/Pitch/Far/W/H/Dpr` (`camera.ts:194-202`).
4. **Label-dispatch signature** — `_prevLabelDispatchSig` string (`map.ts:337`).

That is **the same five camera scalars compared against four-to-five different stored snapshots** in different files. Total signature-field surface: Grep for `_lastSig|_evtSig|_cacheCx|_ecefCacheCx|_prevLabelDispatchSig` hits **35 lines in `map.ts`, 9 in `camera.ts`, 15 in `render-loop.ts`**. Each cache has its own invalidation discipline, and the comments admit the fragility: `audit ⑩` flags "MVP-cache fragility if a future public `centerX` setter is added" (`2026-06-audit-input-camera-picking.md:38`). **[INFERENCE]** This is the classic manual-memoization trap — correctness depends on every camera mutation site remembering to either go through the right path or let the cache's by-value comparator catch it; the four caches do not share a generation counter, so they can disagree mid-frame.

### FACT — the camera has a _second_, deliberately-divergent source of truth for latitude

`centerLatDeg` (`camera.ts:41`) and `centerY` are documented to be byte-identical for |lat|≤85.05 (`camera.ts:31-40`) — but `pan()` in globe mode **intentionally breaks** that: it writes `centerLatDeg = lat` past the pole limit (`camera.ts:836`) while clamping `centerY` to ±85.051129 (`camera.ts:837-838`). So above 85.05 there are two latitudes that disagree. The input audit independently flags this as B5: "`centerLatDeg` can be written to e.g. 87° while `centerY` is clamped to 85.051129°, violating the documented invariant… corrupting tile selection/unproject there" (`2026-06-audit-input-camera-picking.md:34-35`). This is a genuine **two-sources-of-truth-for-the-same-quantity** defect, not just a style smell.

---

## 2. Dirty-domain invalidation — coherent design, bolted-on and inert

### FACT — the design is clean in isolation

`state/dirty.ts` (49 LOC) is a tidy 8-domain bitset (`CAMERA/VIEWPORT/PROJECTION/STYLE/SOURCE/GEOMETRY/LABEL/CLOCK`, `dirty.ts:5-14`) with a correct `tag`/`consume`(read-and-clear)/`peek`/`any`/`clear` API (`dirty.ts:28-48`). `OperatorBus` (`ops/operator-bus.ts`, 27 LOC) records each mutation Op into a bounded log and tags domains (`operator-bus.ts:14-18`). Both are unit-tested (`dirty.test.ts`, `operator-bus.test.ts`, `map-dirty-tagging.test.ts`).

### FACT — but 7 of 8 domains are write-only; the system does not gate rendering

- The producer side is fully wired: ~15 `_ops.dispatch(..., DirtyDomain.X)` call sites across setters (`map.ts:515,547,758,765,766,854,909,913,918,920,921,927,1236,2969-3000`) and `invalidate()` tags **all 8 domains at once** (`map.ts:436`).
- The consumer side is **one domain**. The ONLY non-test `_dirty.consume(...)` in the engine is `consumeLabelDirty()` → `consume(DirtyDomain.LABEL)` (`map.ts:454`), read exactly once, in `label-pass.ts:271`. The other **seven domains (CAMERA/VIEWPORT/PROJECTION/STYLE/SOURCE/GEOMETRY/CLOCK) are tagged but never consumed** anywhere in production (Grep for `.consume(` across `engine/` returns only the LABEL call + test files).
- `dirty.ts:1-4` says so outright: _"At S3 this is a WRITE-ONLY back-compat wrapper over `XGISMap._needsRender`: edits tag domains, but no per-frame consumer reads it to skip yet, so behavior is unchanged."_ And `map.ts:442-446`: _"Still INERT: `shouldRenderThisFrame()` reads `_needsRender`, not `_dirty`, so output is byte-identical until a consumer reads the bitset."_

### FACT — the actual render gate is the old boolean + a hand-rolled camera diff

`shouldRenderThisFrame()` (`map.ts:2815-2829`) ignores the bitset entirely. It returns true on `_needsRender`, `_sceneHasAnimation`, `hasPendingSourceWork()`, or a **manual field-by-field camera/canvas diff** against `_lastSig*`. The granular per-domain skip the bitset was built to enable does not exist. The "S16 skip" the comments reference is a single coarse label-pass skip keyed on `consumeLabelDirty()` plus the pass's own camera/canvas/tile signature (`label-pass.ts:271-273`), not a domain-routed scheduler.

**Assessment: coherent design, bolted on.** The bitset + OperatorBus is a forward-looking S14/S16 scaffold (roadmap-staged per the comments) that today is pure overhead: every setter does _double_ bookkeeping — mutate the field AND set `_needsRender` AND push an Op AND tag domains — but only `_needsRender` and the `_lastSig*` diff actually drive a frame. The op-log is capped at 256 (`operator-bus.ts:10`) and read by nothing in production (`lastOp`/`depth` are "for tests / future undo," `operator-bus.ts:19-26`). **[INFERENCE]** This is infrastructure paid for but not yet earning — defensible as a staged migration, indefensible if it ships to v1 in this state, because it presents the _appearance_ of a domain-routed invalidation system to a future maintainer while the real control flow is the legacy boolean.

---

## 3. Event system — present, MapLibre-shaped, but partly a façade

### FACT — the event surface exists and is reasonably structured

- Map-level events: `XGISMapEventType = 'load' | 'idle' | 'movestart' | 'move' | 'moveend' | 'zoomstart' | 'zoom' | 'zoomend'` (`layer.ts:437-440`). Payload `XGISMapEvent` carries `center/zoom/bearing/pitch/timeStamp` (`layer.ts:447-473`). Registry `MapEventRegistry` supports `once`/`signal`/snapshot-dispatch (`layer.ts:485-511`).
- Feature events: `XGISFeatureEventType = 'click' | 'mouseenter' | 'mouseleave' | 'mousemove' | 'pointerdown' | 'pointerup' | 'wheel'` (`layer.ts:301-303`).
- The move/zoom/idle lifecycle is driven from a single vantage point — `_processCameraEvents()` (`map.ts:2767-2808`) runs every rAF tick **before** the skip gate (`map.ts:2724-2731`) so it catches both gesture-lane (controller mutates camera directly) and programmatic-lane (`jumpTo → invalidate`) changes uniformly. This is a clean, MapLibre-faithful design and is the one genuinely good part of this axis (one line: correct, single-source event emission off a camera diff).

### FACT — but the camera-control verbs behind the events are stubs

- `easeTo` and `flyTo` are **`jumpTo` aliases** — no interpolation: `camera-controller.ts:240-245` (`easeTo(opts){ this.jumpTo(...) }`, `flyTo(opts){ this.jumpTo(...) }`), the `duration`/`speed`/`curve`/`easing` params are accepted and discarded. `map.ts:904-914` confirms "X-GIS has no transition infra yet, so both alias to jumpTo (instant)." **Consequence for events:** an `easeTo({duration:2000})` fires `movestart`/`move`/`moveend` in a **single tick** instead of streaming `move` across the animation — any host relying on the event cadence (progress bars, lazy-load throttles) sees a jump, not a glide. This is exactly the "basic controls malfunction" class the owner reports: the API is present and typed, the behavior is a teleport.
- Style-mutation verbs (`setStyle`/`addLayer`/`removeLayer`/`addSource`/`addImage`) are **warn-once no-ops** (`map.ts:871-888`). That is a defensible deliberate non-feature (compile-time IR model), and it fails loudly — acceptable.

### FACT — the input layer is projection-blind, matching the documented audit

- `clientToLngLat` returns **Mercator-only** for the disc/globe families: it special-cases flat non-merc projTypes 1/2/6 via `unprojectToLonLat` (`interaction-controller.ts:277-279`), and for everything else falls through to `unprojectToZ0` then `if (this.getProjectionName() !== 'mercator') return null` (`interaction-controller.ts:287`). Disc (3/4/5) and globe (7) return null — picking coordinate-convert is unimplemented there, per the in-code comment "Other projections need a per-projection inverse — Phase 5 work" (`interaction-controller.ts:284-287`).
- The pick pass ignores layer visibility (`interaction-controller.ts:201-206` filters only the sentinel `0` and a _post-hoc_ `visible === false` check on the resolved layer, but the audit confirms the pick _render pass_ has no visibility gate: `2026-06-audit-input-camera-picking.md:22-23`, B1 MED-HIGH).
- Pinch-rotate has no hysteresis — `controller.ts:269-275` applies `camera.rotate(-delta)` for _any_ pinch-angle change; audit B4 (`…:31-32`) confirms finger jitter spuriously rotates during an intended pure zoom.
- High-pitch unproject returns null → fallback delta-pan that "jumps" (audit B3, `…:28-29`; the fallback path is `controller.ts:327-332`).

These corroborate the owner's "bugs that can't be seen from code alone": the math compiles and unit-tests pass, but the rendered/interactive behavior is wrong on non-Mercator surfaces and under gesture jitter.

---

## 4. Data flow direction — a web of back-references, not unidirectional

### FACT — the flow is bidirectional and re-entrant

There is no unidirectional store → view pipeline. Concretely:

- **Gesture lane writes camera directly, bypassing the op/dirty system.** `controller.ts` calls `camera.pan/rotate/zoomAt/pitch=` directly (`controller.ts:195,250,252,284,322,331`); these never touch `_ops` or `_dirty`. Only the _programmatic_ setters (`setCenter`/`setZoom`/`jumpTo`/…) dispatch ops. So there are **two parallel write paths to the same camera state**, only one of which feeds the invalidation bookkeeping. The render loop papers over this by diffing the camera by value every frame (`shouldRenderThisFrame`), which is _why_ the dirty bitset can stay inert — but it means the op-log is an incomplete record of mutations.
- **Render passes mutate map and source state.** `_resolveFillPatterns()` (`render-loop.ts:655-762`) writes back into `show.resolvedFillRgba`, `show.fillPatternUV`, `show.fillPatternRepeatM`, `show.resolvedStrokeRgba`, etc. (`render-loop.ts:696,712,723,740,752,759`) — the render path mutates the scene-command structs it is supposed to be consuming. The label pass calls back `host.markLabelDirty()` from an async resource-landed callback (`label-pass.ts:82`), re-arming a frame from inside rendering.
- **Frame state is pushed onto the camera from the render loop.** `render-loop.ts:165-171` writes `camera.azimuthalProjType`, `camera.globeMode`, `camera.projType` every frame; `render-loop.ts:180` writes `camera.maxZoom`; `render-loop.ts:189-205` mutates `camera.centerX/Y/zoom/bearing/pitch` (NaN-reset + clamp + wrap). So the render loop is also a camera _writer_, not just a reader.
- **89 `host.X` reach-backs** from render passes into the map (Grep, §1), and the satellites hold the map's collections by reference (§1). This is a star of mutable shared references centered on `XGISMap`, not a DAG.

**[INFERENCE]** The consequence for sustainability: because every actor (controller, render loop, passes, async callbacks) can write camera/scene state, and the only reliable convergence point is the per-frame by-value camera diff, adding any feature that needs _correct incremental invalidation_ (e.g. partial re-tessellation on style edit, the very thing the dirty bitset was built for) requires auditing every one of these write paths. The bitset can't be trusted to be complete because the gesture lane doesn't tag it.

---

## 5. What's genuinely good (one line each, with evidence)

- **Single-vantage event emission**: `_processCameraEvents()` correctly unifies gesture + programmatic camera changes off one diff, runs before the skip gate, MapLibre-faithful (`map.ts:2724-2808`).
- **Dirty bitset API is clean and tested** in isolation (`state/dirty.ts`, `dirty.test.ts`) — the design is fine; only its non-adoption is the problem.
- **Idempotent drag anchors**: `panToScreenAnchor` in absolute world coords is the correct perspective-correct pan primitive (`controller.ts:315-326`; audit C, `…:40-41`).
- **NaN-defensive camera clamps** every frame stop one bad assignment from locking the matrices into NaN (`render-loop.ts:189-198`).

---

## 6. Top sustainability risks (ranked)

1. **Four redundant camera-state caches with no shared generation counter** (`_lastSig*`, `_evtSig*`, `camera._cache*` + `_ecefCache*`, `_prevLabelDispatchSig`) — manual memoization that future setters will silently desync (already flagged for a hypothetical `centerX` setter, audit ⑩ B6). §1.
2. **Inert dirty/op subsystem** — double-bookkeeping on every setter that gates nothing; 7/8 domains write-only; presents a false "domain-routed invalidation" affordance over a legacy boolean. §2.
3. **`XGISMap` god-object (3431 LOC, ~10 responsibilities, ~55 members exposed by reference)** with "decomposition" that is relocation not decoupling — coupling unchanged, 89 `host.X` reach-backs. §1, §4.
4. **Two parallel camera-write paths** (gesture-direct vs op-dispatch) so the op-log/dirty record is structurally incomplete; convergence depends on a per-frame value diff. §4.
5. **Façade camera verbs** (`easeTo`/`flyTo` = `jumpTo`) break the move-event cadence and are the visible "basic controls malfunction." §3.
6. **Two-sources-of-truth for centre latitude** (`centerLatDeg` vs `mercatorYToLat(centerY)`) deliberately diverge past 85.05, corrupting near-pole tile-select/unproject (audit ⑩ B5). §1.
