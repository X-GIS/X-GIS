# Design Proposal — VectorTileRenderer decomposition by state-ownership

> **STATUS: DESIGN PROPOSAL — NOT YET IMPLEMENTED.**
> This document proposes a behavior-preserving structural decomposition of
> the engine's #1 architectural debt: the god-object `VectorTileRenderer`
> (`runtime/src/engine/render/vector-tile-renderer.ts`, 5608 LOC, ~174
> top-level methods). It is a *map of where the work would go*, grounded in
> the actual fields and methods read out of the file — not a refactor that
> has happened. No production code is changed by writing this.
>
> Cross-links: [MODULES.md](../MODULES.md) §4 (god-object list),
> [class-render-subsystem.md](../diagrams/class-render-subsystem.md),
> [sequence-frame-render.md](../diagrams/sequence-frame-render.md),
> [sequence-tile-lifecycle.md](../diagrams/sequence-tile-lifecycle.md),
> [ADR-0001](../../adr/0001-ecef-tile-pipeline.md) (uniform byte layout),
> [ADR-0003](../../adr/0003-shader-dsl-single-emit.md) (byte-drift gate),
> [ADR-0004](../../adr/0004-verification-gate-strategy.md) (the gates this
> decomposition must keep green), [ADR-0006](../../adr/0006-world-copy-rendering.md).

---

## 1. Why this is the right lever (and what it is NOT)

The user's quality bar: *kill god-objects by extracting **ownership**, not
code — a god class is unclear state-ownership; define who owns each piece of
state.* The prior decomposition review
(`project_godfile_decomposition_review_2026_05_30`) reached the same root and
named the lever explicitly: **composition (inject a state collaborator) is the
dominant fix for every god-object; inheritance is nowhere; mixins are exactly
one place (the `map.ts` Mapbox-API facade, not here).** VTR has *grown* +310
LOC since that review while staying monolithic, so the lever is unchanged and
the debt is now larger.

The **precedent already exists in this same file**. Two state slices have
*already* been lifted out of VTR into owned collaborators with narrow
interfaces and a callback for the policy that has to stay with the caller:

- `UniformRing` (`render/uniform-ring.ts`) — owns the growable ring buffer +
  CPU staging mirror + dirty-range flush, including the iter-348 mid-pass-grow
  fix. VTR holds it as `private uniformRing: UniformRing | null`
  (`vector-tile-renderer.ts:372`) and passes the bind-group-rebuild policy in
  via the `onGrow` callback (`:649`). The byte *layout* stayed with VTR; only
  the *buffer lifecycle* moved.
- `PrefetchScheduler` (`render/prefetch-scheduler.ts`) — owns the
  previous-frame camera snapshot + the two speculative-prefetch routes. VTR
  holds `private readonly prefetchScheduler = new PrefetchScheduler()`
  (`:206`) and forwards once per frame via `pumpPrefetch` (`:909`), handing it
  the frame-tile-cache shape as the only contract.

The render *passes* were likewise lifted from `XGISMap.renderFrame` into
`RenderLoop` + `render/passes/*` (stateless singletons). So the codebase has a
proven pattern for both "extract owned state into a collaborator" and "extract
orchestration into stateless objects." **This proposal applies that same
pattern to the remaining VTR state clusters.** It is not a new architecture; it
is finishing one already in motion.

What this is **not**: it is not a ≤500-LOC line-count chase. Per the review's
caveats, a blind ratchet *hurts* — it would split hot loops and the
intentionally-cohesive uniform layout. The ratchet is a *consequence* of moving
ownership, applied as "grandfather + shrink-only," not the goal.

---

## 2. Current-state inventory (grounded)

The class header asserts a narrow contract — *"This class manages GPU buffers,
bind groups, and draw calls only"* (`:2-4`). The 5608-line reality is the gap
between that contract and the accreted state. Below is the actual private state,
grouped by the cluster that owns/mutates it. Every field cites its declaration
line; every method cites where it is defined.

### Cluster A — GPU tile cache + arena/buffer memory
| State (field) | Line | Mutated by |
|---|---|---|
| `gpuCache: Map<string, Map<number, GPUTile>>` | `:131` | upload, evict, rebuild, destroy |
| `_gpuCacheCount` | `:135` | `_releaseTileSlots`, upload |
| `_tileUploadEpoch` | `:143` | `doUploadTile*` (per-tile `uploadEpoch` stamp) |
| `polyVertexArena` / `polyIndexArena` / `zBufferArena` | `:479 :498 :515` | `getOrCreate*Arena`, evict, destroy |
| `_bufferPool` + `_BUFFER_POOL_CAP_PER_BUCKET` | `:217 :218` | `acquireBuffer`/`releaseBuffer` (`:224 :231`) |

Methods: `evictGPUTiles` (`:5392`), `_releaseTileSlots` (`:5514`),
`forceEvictBytes` (`:5565`), `getOrCreatePolyVertexArena`/`...Index` (`:482 :501`),
`getLayerCache`/`getOrCreateLayerCache` (`:154 :157`), the eviction half of
`destroy` (`:1632-1652`), `getCacheSize` (`:1564`). Cap/water-mark constants
already live in `vector-tile-renderer-helpers.ts` (`getMaxGpuTiles`,
`ARENA_HIGH_WATER`/`LOW_WATER`).

### Cluster B — Upload queue + tile-decode→GPU pipeline
| State (field) | Line | Mutated by |
|---|---|---|
| `uploadQueue: PriorityQueue` / `uploadItemData` | `:941 :942` | `uploadTile`, `cancelStaleUploads`, queue callbacks |
| `_uploadsThisFrame` / `_heldUploads` / `_heldUploadIds` / `_heldUploadKeys` | `:1001-1014` | `uploadTile`, `resetUploadFrameCap`, `cancelStaleUploads` |
| `_distMemo` / `_distMemoCamX/Y` / `_installedPriorityFns` | `:952 :953 :963` | `_distSqStable` (`:965`), beginFrame |
| `stagingPool: StagingBufferPool` | `:524` | `doUploadTileAsync` |

Methods: `uploadTile` (`:2004`), `doUploadTile` (`:2160`), `doUploadTileAsync`
(`:2525`), `drainPendingUploads`, `resetUploadFrameCap` (`:2050`),
`cancelStaleUploads` (`:2104`), `_allocPolyPair` (`:2146`), `hasPendingUploads`
/ `getPendingUploadCount` (`:1025 :1030`). This cluster *allocates from* Cluster
A's arenas and *writes into* Cluster A's `gpuCache` — that is the one hard
seam (see §5 hazards).

### Cluster C — Uniform ring + bind groups + pipeline registry
| State (field) | Line | Mutated by |
|---|---|---|
| `uniformRing: UniformRing` (already a collaborator) | `:372` | `ensureUniformRing` (`:647`), beginFrame, renderTileKeys |
| `uniformDataBuf` / `uniformF32` / `uniformU32` | `:302 :303 :307` | renderTileKeys per-tile pack |
| `tileBgDefault` / `tileBgFeature` | `:374 :376` | `rebuildTileBindGroups` (`:653`) |
| `baseBindGroupLayout` / `featureBindGroupLayout` | `:310 :387` | setters |
| palette/sprite: `paletteColorAtlasView` / `paletteSampler` / `spriteAtlasView` | `:633 :634 :645` | `setPaletteResources`/`setSpriteAtlasView` |
| fill pipeline pairs (extruded/ground/pattern/OIT) | `:435-447 :555 :565` | the `set*Pipelines` setters (`:530-575`) |

Methods: `ensureUniformRing` (`:647`), `rebuildTileBindGroups` (`:653`),
`rebuildPerTileFeatureBindGroups` (`:713`), `allocUniformSlot`/`stageUniformSlot`/
`flushUniformStaging` (`:1052 :1059 :1069`), all `set*Pipelines` (`:530-575`),
`setBindGroupLayout` (`:587`), `setPaletteResources`/`setSpriteAtlasView`. The
*byte layout* (`uniformF32[19..58]`) is written inline in `renderTileKeys` and
is order-sensitive — see §5.

### Cluster D — Feature data + compute paint
| State (field) | Line | Mutated by |
|---|---|---|
| `featureDataBuffer` | `:386` | `buildFeatureDataBuffer` |
| `latestVariantFields` / `latestVariantCategoryOrder` / `latestVariant` / `latestComputePlan` / `latestRenderNodeIndex` | `:395 :396 :402 :403 :404` | `buildFeatureDataBuffer`, `setComputePlan` |
| `computeHandlesByTile: Map<string, ComputeLayerHandle>` | `:409` | `buildPerTileFeatureData`, evict, destroy |
| `computeDispatcher: ComputeDispatcher` | `:413` | lazy-init on compute attach |

Methods: `buildFeatureDataBuffer` (`:1722`), `buildPerTileFeatureData`
(`:1850`), `dispatchComputePass` (`:614`), `setComputePlan` (`:601`),
`hasFeatureData` (`:1560`). `ComputeLayerHandle` is already its own class
(`render/compute-layer-handle.ts`); this cluster is the *factory + lifetime
owner* of those handles.

### Cluster E — Tile selection + frame readiness
| State (field) | Line | Mutated by |
|---|---|---|
| `_frameTileCache` (memoized `visibleTilesFrustum` + derived arrays) | `:757` | render (populate), beginFrame (invalidate via frameId) |
| `stableKeys` | `:177` | render (protection set), read by evict + labels |
| `_hysteresisZ` / `_czPendingAdvance` | `:168 :176` | render (currentZ derivation) |
| `lastZoom` / `lastZoom`-fed slot | `:163` | render |
| `_lastCamSnap` / `_lastCamMoveAt` | `:200 :201` | render (idle detection) |
| `prefetchScheduler` (already a collaborator) | `:206` | `pumpPrefetch` |
| `_frameClassifyMemo` / `_scratchProtectedKeys` + tile-decision scratch | `:1696 :253` | render, evict |

Methods: the tile-selection block at the top of `render` (`:2982-...`),
`pumpPrefetch` (`:909`), `getLastDecisionCounts` (`:1048`). Depends on
`tile-decision.ts`, `tile-select.ts`, `tiles-sse.ts`, `globe.ts` — already
external modules; the *state* (the per-frame cache + hysteresis) is what lives
on VTR.

### Cluster F — Label feature extraction (CPU)
| State (field) | Line | Mutated by |
|---|---|---|
| `_labelKeyScratch` | `:179` | `forEachLabelFeature` |
| `_lineLabelRunsCache` (+ `LINE_LABEL_RUNS_CACHE_MAX`) | `:188 :191` | `forEachLineLabelPolyline` |
| `_scratchBestByFeatId` / `_scratchOrderedFeatEntries` / `_scratchBestLineLabel` | `:260 :264 :269` | the forEach* family |
| `_frameArena: FrameArena` | `:295` | `forEachLineLabelPolyline` (call-scope typed arrays) |

Methods: `forEachLabelFeature` (`:1127`), `forEachLineLabelFeature` (`:1294`),
`forEachLineLabelPolyline` (`:1389`), `getPropertyTable` (`:1114`),
`getBounds`/`hasData` (`:1110 :1106`). Critically these **read** `this.source`
+ `this.stableKeys` + `this._frameTileCache.neededKeys` and the source's tile
data; they touch **no GPU state**. This is the cleanest seam in the file (see
§4 sequence).

### Cluster G — Per-frame draw stats / diagnostics
| State (field) | Line | Mutated by |
|---|---|---|
| `renderedDraws: Map` | `:416` | renderTileKeys (dedup + counts) |
| `_frameTilesVisible` / `_frameDrawCalls` / `_frameTriangles` / `_frameLines` / `_frameVertices` / `_frameDrawnByZoom` / `_frameGlobeTilesSelected` | `:1667-1684` | renderTileKeys, render |
| `_missedTiles` / `tileDropWarnings` / `_lastDecisionCounts` | `:427 :426 :1019` | render/renderTileKeys |
| trace stash `lastTraceSlice` / `lastTracePhase` | `:421 :422` | render, renderTileKeys |

Methods: `getDrawStats` (`:1698`), `getBundleStats` (`:1716`),
`getTileLoadDiagnostic` (`:1600`), `getCacheSize` (`:1564`). Pure read-out
surface; the *writes* are interleaved in the hot loop and must stay there (§5).

### The coordinator core that must stay together
`render` (`:2821`), `renderTileKeys` (`:4888`), `recordTileFill` (`:4855`),
`beginFrame` (`:794`), `endFrame`. These are the per-frame orchestration + hot
loop. They *read across all clusters* — this is precisely why VTR is a god
object, and precisely what becomes the thin coordinator.

---

## 3. Target owner classes

Eight owners (six new + the two already extracted), each owning a **disjoint**
slice of VTR's current fields, with a narrow interface. VTR keeps the
coordinator core and becomes the wiring hub that holds one of each.

| Owner | Owns (fields) | Narrow interface (verbs) | Source cluster |
|---|---|---|---|
| `GpuTileStore` | `gpuCache`, `_gpuCacheCount`, the 3 arenas, `_bufferPool`, `_tileUploadEpoch` | `get(slot,key)`, `getOrCreateLayer(slot)`, `evictToBudget(stableKeys)`, `forceEvictBytes(arena,n)`, `releaseTile(slot,key)`, `acquireBuffer`/`releaseBuffer`, `count()`, `destroy()` | A |
| `TileUploader` | `uploadQueue`, `uploadItemData`, `_uploads*`/`_held*`, `_distMemo*`, `stagingPool` | `enqueue(key,data,slot)`, `drain(budget)`, `cancelStale(activeKeys)`, `resetFrameCap()`, `pending()` | B |
| `UniformRing` *(exists)* | ring buffer + staging mirror + dirty flush | `ensure`, `resetSlot`, `allocSlot`, `stageSlot`, `flush`, `takeRetired`, `destroy` | C |
| `BindGroupRegistry` | `tileBg*`, layouts, palette/sprite views, the fill-pipeline pairs | `setPipelines*`, `setPalette`, `setSprite`, `rebuild()`, `fillBgFor(layout)`, `pipelineFor(mode,cached)` | C |
| `FeatureDataBinder` | `featureDataBuffer`, `latestVariant*`, `computeHandlesByTile`, `computeDispatcher` | `captureVariant(v,layout,idx)`, `buildPerTile(props,key,slot)`, `dispatch(encoder)`, `setPlan`, `destroy()` | D |
| `TileSelectionCache` | `_frameTileCache`, `stableKeys`, `_hysteresisZ`, `_czPendingAdvance`, `_lastCamSnap`, classify memo | `selectForFrame(camera,projType,...)→{tiles,neededKeys,worldOff,...}`, `stableKeys()`, `invalidate(frameId)` | E |
| `LabelFeatureSource` | `_labelKeyScratch`, `_lineLabelRunsCache`, label scratch, `_frameArena` | `forEachLabel(slice,fn)`, `forEachLineLabel(slice,fn)`, `forEachLineLabelPolyline(slice,fn)`, `resetArena()` | F |
| `FrameDrawStats` | `renderedDraws`, the `_frame*` accumulators, `_missedTiles`, trace stash | `reset()`, `recordDraw(...)`, `recordMiss()`, `snapshot()` | G |

### Coordinator shape after extraction
`VectorTileRenderer` keeps: `device`, `source`, `currentProjection`, the
per-show paint scalars it stamps into the uniform (`cachedFillColor`,
`currentOpacity`, `currentPickId`, `currentExtrude*`, `logDepthFc`, `lastZoom`,
the per-show flags), and the orchestration methods `render`, `renderTileKeys`,
`recordTileFill`, `beginFrame`, `endFrame`. It **holds one of each owner** and
wires them: `render` asks `TileSelectionCache` for the visible set, asks
`TileUploader` to drain (which allocates from `GpuTileStore` and writes its
`gpuCache`), then `renderTileKeys` reads `GpuTileStore.get()`, packs the uniform
into `UniformRing` slots, resolves bind groups via `BindGroupRegistry`, and
records into `FrameDrawStats`. The per-tile **byte pack stays inline in
`renderTileKeys`** — the coordinator owns the layout; the owners own the
buffers and lifetimes. Target: VTR drops from 5608 to roughly 1500–2000 LOC of
*coordination + hot loop*, with the rest distributed across owners that are each
independently testable.

```mermaid
classDiagram
    direction TB
    class VectorTileRenderer {
        <<thin coordinator + hot loop>>
        -device: GPUDevice
        -source: TileCatalog
        -cachedFillColor / currentOpacity / currentPickId
        -logDepthFc / lastZoom / currentExtrude*
        +render(pass, camera, projType, show, ...) void
        -renderTileKeys(keys, ...) void  %% HOT LOOP — packs uniformF32 inline
        -recordTileFill(...) drawIndexed
        +beginFrame(frameId) void
        +endFrame() void
    }
    class GpuTileStore {
        -gpuCache / _gpuCacheCount
        -polyVertexArena / polyIndexArena / zBufferArena
        -_bufferPool / _tileUploadEpoch
        +get(slot,key) GPUTile
        +evictToBudget(stableKeys) void
        +forceEvictBytes(arena,n) bool
        +releaseTile(slot,key) bytes
    }
    class TileUploader {
        -uploadQueue / uploadItemData
        -_uploadsThisFrame / _heldUploads
        -_distMemo / stagingPool
        +enqueue(key,data,slot) void
        +drain(budget) void
        +cancelStale(activeKeys) void
    }
    class UniformRing {
        <<already extracted>>
        +allocSlot() / stageSlot() / flush()
    }
    class BindGroupRegistry {
        -tileBgDefault / tileBgFeature
        -layouts / palette / sprite views
        -fillPipeline{Extruded,Ground,Pattern,OIT}
        +rebuild() void
        +fillBgFor(layout) GPUBindGroup
        +pipelineFor(mode,cached) GPURenderPipeline
    }
    class FeatureDataBinder {
        -featureDataBuffer / latestVariant*
        -computeHandlesByTile / computeDispatcher
        +captureVariant(v,layout,idx) void
        +buildPerTile(props,key,slot) void
        +dispatch(encoder) void
    }
    class TileSelectionCache {
        -_frameTileCache / stableKeys
        -_hysteresisZ / _czPendingAdvance
        +selectForFrame(camera,projType,...) Selection
        +invalidate(frameId) void
    }
    class LabelFeatureSource {
        -_lineLabelRunsCache / _frameArena
        +forEachLabel(slice,fn) void
        +forEachLineLabelPolyline(slice,fn) void
    }
    class FrameDrawStats {
        -renderedDraws / _frame* accumulators
        +recordDraw(...) void
        +snapshot() DrawStats
    }
    class PrefetchScheduler {
        <<already extracted>>
        +pump(...) void
    }

    VectorTileRenderer *-- GpuTileStore
    VectorTileRenderer *-- TileUploader
    VectorTileRenderer *-- UniformRing
    VectorTileRenderer *-- BindGroupRegistry
    VectorTileRenderer *-- FeatureDataBinder
    VectorTileRenderer *-- TileSelectionCache
    VectorTileRenderer *-- LabelFeatureSource
    VectorTileRenderer *-- FrameDrawStats
    VectorTileRenderer *-- PrefetchScheduler
    TileUploader ..> GpuTileStore : alloc arena + write gpuCache
    BindGroupRegistry ..> FeatureDataBinder : per-tile featureBindGroup rebuild on ring grow
    UniformRing ..> BindGroupRegistry : onGrow callback rebuilds bind groups
```

---

## 4. Extraction sequence (lowest-risk / most-independent first)

Ordered so each step is independently verifiable by a **named existing gate**
(ADR-0004), touches the fewest fields shared with the hot loop, and never moves
two coupled clusters at once. The review's directive — *"hard god-objects LAST,
one at a time, render-gate + warm-harness"* — is respected: the GPU-memory core
(A/B/C-byte-pack) is sequenced last.

**Step 1 — `LabelFeatureSource` (Cluster F).** Cleanest seam: the forEach*
methods touch zero GPU state, only `this.source` + `stableKeys` +
`_frameTileCache.neededKeys`. Move the scratch + `_lineLabelRunsCache` +
`_frameArena`; VTR forwards the three reads. *Verify:* `_label-anchor-parity`
(sub-pixel `ry` residual) and `_projection-label-onscreen` (Tier-2 local) — the
position gates ADR-0004 §"pixel-match is non-gating for labels" mandates;
plus `merc-high-pitch-drag-perf.test.ts` so the line-label-runs cache hoist
doesn't regress.

**Step 2 — `FrameDrawStats` (Cluster G).** Pure read-out accessors +
accumulator writes. Move the `_frame*` fields + `renderedDraws`; `renderTileKeys`
calls `stats.recordDraw(...)` instead of mutating fields inline. *Verify:*
`vitest` (the `getDrawStats`/`getTileLoadDiagnostic` consumers) + the
`_draw-order-trace.spec.ts` e2e for the trace stash. Risk: the `renderedDraws`
**dedup key** is correctness-load-bearing (Korea fill-drop bug, `:4978-4982`) —
keep the dedup `.has()`/`.set()` calls in the hot loop, expose only the counters.

**Step 3 — `TileSelectionCache` (Cluster E).** `_frameTileCache` is already a
self-contained memo object (`:757`); lift it + hysteresis state behind
`selectForFrame()`. `PrefetchScheduler` already consumes the cache shape, so the
contract exists. *Verify:* `_zoom-transition-blank-tiles.spec.ts` +
`_zoom-transition-flicker.spec.ts` (hysteresis/readiness) +
`_world-copies-projection-gate.spec.ts` (worldOff derivation) +
`_prefetch-cancelled.spec.ts`.

**Step 4 — `FeatureDataBinder` (Cluster D).** `ComputeLayerHandle` is already a
class; this owner is its factory + lifetime. The seam is moderate: it
*writes into* tiles' `featureBindGroup` and is rebuilt on ring grow. Keep the
ring-grow rebuild as a callback the binder registers (same `onGrow` pattern as
UniformRing). *Verify:* `_fixture-picking.spec.ts`, `_filter-gdp-z-fighting.spec.ts`,
`tile-compute-resources.test.ts`, `compute-layer-handle.test.ts`, and the OFM
Bright `landuse class` match render (pixel-survey local).

**Step 5 — `BindGroupRegistry` (Cluster C, non-layout half).** Move the
`tileBg*` + layouts + palette/sprite views + fill-pipeline pairs + `rebuild`.
The uniform *byte buffer* (`uniformF32`/`uniformDataBuf`) does **not** move (it
is read inline by the hot loop). This is the trickiest because `renderTileKeys`
re-resolves `fillBg`/`currentTileBg` after `allocUniformSlot` may have grown the ring (`:5190`);
the registry must expose `fillBgFor(layout)` cheaply. *Verify:*
`_picking-ortho-bindgroup.spec.ts`, `_wgsl-compile-gate` (CI), `uniform-ring.test.ts`,
`line-renderer-layer-ring.test.ts`, and the polygon-variant byte gate below.

**Step 6 — `GpuTileStore` (Cluster A) + `TileUploader` (Cluster B) together,
last.** These two share the hardest seam (uploader allocates arenas + writes
`gpuCache`); the review flags exactly this as the XL state-inversion to do last
with a warm harness. Extract `GpuTileStore` first (cache + arenas + eviction),
then point `TileUploader` at its `acquireSlot`/`alloc` interface. *Verify, in
order:* `gpu-arena.test.ts` (unchanged arena semantics) → `_dequant-parity` +
`_vs-clip-parity` (CI compute, byte path) →
**`shader-dsl/shaders/polygon-variant-diff.test.ts`** (the byte-drift gate;
must stay byte-identical) → `_pmtiles-rapid-zoom-leak.spec.ts` +
`_pmtiles-stress-leak.spec.ts` + `_globe-arena-pressure` + `map-destroy.test.ts`
(eviction + teardown) → full pixel-survey + screenshot-eyeball loop on a real
GPU. This is the only step that should ship on its own PR with a warm-harness
perf comparison vs the Mercator control (per `feedback_perf_numeric_verification`).

**Throughout:** `_render-verify.spec.ts`, `_invariant-check.spec.ts`, the
`renderers-stub-construction.test.ts` constructor wiring, and `bun run build`
(tsc — vitest does not typecheck, per `feedback_run_build_before_push`) gate
every step. Each step is one PR; CI's `test` + `render-gate` jobs run on push.

---

## 5. Hazards — what MUST NOT move or split

These are the performance/correctness-critical structures. Splitting them is how
a behavior-preserving refactor becomes a regression.

1. **The per-tile uniform byte pack inside `renderTileKeys` (`:4996-5174`).**
   `uniformF32[19..58]` and `uniformU32[36]` are written at fixed float
   offsets that the WGSL `Uniforms` struct reads by position (ADR-0001). The
   comment at `:299-301` is explicit: *out-of-bounds typed-array writes are
   silent no-ops in JS, so a mismatch here = shader reads garbage.* This pack
   must stay **inline in the hot loop, in order**, owned by the coordinator.
   `BindGroupRegistry` owns the ring *buffer*; it does **not** own the byte
   layout. The polygon-variant byte-drift gate
   (`polygon-variant-diff.test.ts`) pins this.

2. **The `renderTileKeys` per-tile loop structure + two-pass fill/stroke
   ordering (`:4968-5378`).** Fills draw in pass 1; strokes are queued into
   `strokeQueue` and emitted in pass 2 *after every fill has written depth*
   (`:5346`). Inverting or interleaving this re-introduces the outline-clobber
   bug documented at `:5317-5326`. The `renderedDraws` dedup key
   (`drawKey`, `:4979`) must stay — folding it away re-opens the Korea
   fill-drop bug (`:4974-4977`). Do not split fill and stroke into different
   owners.

3. **The uniform-ring mid-pass grow + bind-group rebuild coupling.** When
   `allocUniformSlot` grows the ring, `tileBgDefault`/`tileBgFeature` **and**
   every per-tile `featureBindGroup` are rebuilt against the new buffer
   (`:688-702`, `rebuildPerTileFeatureBindGroups` `:713`). This is the iter-348
   + iter-349 stale-colour fix ("land flashes water-blue at high pitch"). The
   `UniformRing.onGrow` callback wiring (`:649`) must remain the single rebuild
   trigger; `BindGroupRegistry` and `FeatureDataBinder` must both register
   against it, not poll.

4. **Per-frame draw ORDER across passes (the bucket scheduler contract).**
   Opaque → OIT → translucent-strokes → points → labels is fixed for correct
   alpha compositing (sequence-frame-render.md §"Why this order is fixed"). The
   2D-fills-then-3D-extruded sub-phasing within opaque is also load-bearing for
   high-pitch/globe depth. Decomposition must not reorder `render` phase
   dispatch; owners are invoked *within* the existing order.

5. **Arena free/alloc ORDER + the OOM Lane-B safety net.** `_releaseTileSlots`
   does `arena.free → releaseBuffer → destroy` in a fixed order (`:5520-5552`),
   and `_allocPolyPair` frees the vertex slot if the index alloc throws so a
   failed pair never leaks (`:2146-2158`). `doUploadTile`'s outer try/catch
   degrades any throw to skip-this-tile (`:2164-2175`). Moving this into
   `GpuTileStore`/`TileUploader` must preserve the exact order and the
   orphan-leak guards — `gpu-arena.test.ts` + the pmtiles-leak e2e pin it.

6. **The hoisted hot-path scratch collections (`:249-295`).** `_scratch*`
   Sets/Maps + `_frameArena` are deliberately instance-level and `.clear()`'d
   per use to keep them out of the GC nursery (iter-236/243/252/254 perf work).
   When their owning method moves to a new class, the scratch must move *with
   it* and stay instance-level on that class — do not reallocate per call.
   `merc-high-pitch-drag-perf.test.ts` is the regression guard.

7. **`_distSqStable` priority closure (`:965`) + the `LEVEL_OFFSET` Cesium
   replace-refinement tiebreak.** The upload priority is not pure distance — the
   `tz * 1e16` term forces shallow zooms to win (ancestor-fetch ordering,
   `:976-988`). Moving the queue into `TileUploader` must carry this exact
   priority function, not "simplify" to distance-only.

---

## 6. Grounding audit — what was actually read

Every "X owns Y" claim above traces to a field/method read out of the file,
not inferred:

- VTR field declarations + comments: `vector-tile-renderer.ts:110-466` (state
  block), `:633-746` (palette/sprite/frame-id/frame-tile-cache),
  `:928-1019` (upload-queue state), `:1661-1696` (frame-stat accumulators).
- Hot loop + byte pack: `render` `:2821-3060` (read), `renderTileKeys`
  `:4888-5383` (full read — the `uniformF32[19..58]` writes, two-pass stroke
  defer, dedup key), `recordTileFill` `:4855-4878`.
- Memory paths: `doUploadTile` `:2160-2265`, `uploadTile` `:2004-2046`,
  `_allocPolyPair` `:2146-2158`, `cancelStaleUploads` `:2104-2136`,
  `evictGPUTiles` `:5392-5503`, `_releaseTileSlots` `:5514-5555`, `destroy`
  `:1624-1659`.
- Feature/compute: `buildFeatureDataBuffer` `:1722-1836`, `buildPerTileFeatureData`
  head `:1850`, `dispatchComputePass` `:614-622`.
- Labels: `forEachLabelFeature` `:1127-1186` (read; confirmed GPU-state-free),
  `pumpPrefetch` `:909-926`.
- Already-extracted collaborators (the precedent): `uniform-ring.ts:1-144`,
  `prefetch-scheduler.ts:1-117`; helpers `vector-tile-renderer-helpers.ts:1-82`,
  types `vector-tile-renderer-types.ts:1-100`.
- Gates: ADR-0004 (`0004-verification-gate-strategy.md`) for the Tier-1/Tier-2
  gate names; `polygon-variant-diff.test.ts` (located) for the byte gate;
  e2e spec names verified present under `playground/e2e/`.
- Prior decomposition review: `project_godfile_decomposition_review_2026_05_30`
  (composition lever, W4-last directive, ≤500-hurts caveats, label
  position-gates).

---

## 7. Risks & honest tradeoffs

- **Step 6 is genuinely risky and cannot be fully CI-gated.** Per ADR-0004, the
  GPU-memory/byte path's *correctness* (pixel-match, leak behavior, globe arena
  pressure) only validates on a real GPU locally + the screenshot-eyeball loop.
  CI catches WGSL compile + compute-parity drift but not a rasterized
  regression. This step must ship alone, with the warm-harness numeric perf
  comparison, and must not be batched with other steps.
- **Indirection cost on the hot path.** Today `renderTileKeys` reads `this.field`
  directly. Routing reads through `this.store.get()` / `this.stats.recordDraw()`
  adds a property hop per tile per frame (up to ~270 tiles × ~80 shows). V8
  should inline monomorphic owner calls, but this is a *measure-don't-assume*
  point — the `merc-high-pitch-drag-perf` + `_perf-scenarios` harness must
  confirm no p95 regression before each hot-loop-adjacent step (5, 6) merges.
  If it regresses, the answer is to keep that read inline in the coordinator,
  not to ship a slower loop.
- **The A↔B seam may not cleanly separate.** `TileUploader` and `GpuTileStore`
  are coupled by design (allocate-then-record). If a clean interface forces
  awkward back-references, the honest outcome is to merge them into one
  `TileResidency` owner rather than manufacture a false boundary — extracting
  *one* coherent owner is still a large win over the monolith.
- **Eight owners is a ceiling, not a quota.** If Step-1 through Step-5 already
  collapse VTR to a readable coordinator + hot loop, stopping before Step 6 is
  legitimate. The goal is clear ownership, not a target class count.
- **This proposal changes no behavior and is itself unverified as code** — it
  is a design. The first executable artifact should be Step 1 on its own
  branch, green on the named gates, reviewed in a separate pass (not
  self-approved).
