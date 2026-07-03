# B3 — MapLibre GL JS / Mapbox GL JS Architecture: The Direct Peer

**Research question:** How does the closest peer to X-GIS (a ~100k+ LOC WebGPU/WebGL + TypeScript vector-map renderer) stay structurally sustainable over a decade, and which of its load-bearing patterns transfer to a WebGPU/TS web-map renderer aiming at 3D-tiles and 4D-city rendering?

**Why this peer is special vs. Blender/Unreal:** MapLibre GL JS _is_ the same shape of system as X-GIS — same language (TypeScript), same runtime (browser, single-threaded JS + Web Workers), same problem (tiled vector data → GPU). Unlike Blender/Unreal (native C/C++, OS threads, no tile streaming), most of MapLibre's structure transfers almost verbatim. The interesting question is therefore inverted: not "does this transfer?" but "where does X-GIS already diverge from this peer, and is it paying for it?"

Sources are cited inline. Primary sources used: the official `ARCHITECTURE.md`, the Mapbox/MapLibre source trees, the style-spec docs, core-dev PRs/wikis, and the DeepWiki structural index (an LLM-generated index _over the actual source_, used here for navigation and cross-checked against primary code where possible).

---

## 0. The one-paragraph thesis

MapLibre stays sustainable because it is built on **four orthogonal authorities that almost never need to know about each other**: (1) a **declarative style spec** (data vs. style separation), (2) a **Source/Layer split** that lets N layers share 1 data fetch, (3) an **Actor/Dispatcher worker boundary** that physically separates parse/tessellation from render, and (4) an **Evented + dirty-flag render loop** that makes "what changed → what to recompute → whether to draw" explicit and cheap. Each is a _contract_, not a _call graph_. That is the transferable lesson. ([ARCHITECTURE.md](https://github.com/maplibre/maplibre-gl-js/blob/main/ARCHITECTURE.md), [DeepWiki: Core Architecture](https://deepwiki.com/mapbox/mapbox-gl-js/2-core-architecture))

---

## 1. The Style Specification — data/style/render are three separate worlds

A Mapbox/MapLibre style is "a document that defines the visual appearance of a map: what data to draw, the order to draw it in, and how to style the data" — a **declarative JSON object validated against the v8 schema** before anything renders. Sources define _what data_; layers define _how to render it_; the renderer reads the document to decide what to fetch and how to draw. ([Mapbox Style Specification](https://docs.mapbox.com/style-spec/guides/), [DeepWiki: Style System](https://deepwiki.com/mapbox/mapbox-gl-js/2.2-style-specification))

The critical structural property: **the style is a serializable, validated, diffable data structure, not code.** This is why Mapbox Studio can author a map without touching the renderer, why `setStyle()` can diff old→new and apply only the delta (`_diffStyle`/`_updateDiff` in `map.ts`), and why a style is portable across the JS, native, and iOS renderers. The renderer is a _pure function of (style, camera, data)_.

**Transfer to X-GIS: HIGH, and this is the single most important finding.** X-GIS already has a compiler (`compiler/`) that ingests OFM/Mapbox-style JSON — so the front half (declarative input → IR) exists. The risk per the repo's own audits is that X-GIS's _authority is inverted_: the `PROJECTIONS` table and shader literals are pinned to scattered `gpu-shared` literals rather than the declarative source of truth being the one place truth lives (memory: "PROJECTIONS table authority INVERSION… common root of all audits"). MapLibre's discipline is that **the JSON spec is the only authority and everything downstream is derived**; X-GIS's recurring bugs trace to having _multiple_ authorities (style JSON, IR, projections-table, shader literals) that can drift. The lesson is not "adopt the style spec" (X-GIS already consumes it) — it is **"make the declarative spec the _sole_ authority and forbid parallel sources of truth."**

**Where a typical X-GIS-style renderer diverges and pays:** treating the style as a config bag read imperatively at many call sites, rather than as a validated immutable document with a single owner (the `Style` class). Once style values are copied into shader literals / projection tables / per-renderer constants, you have N authorities and the drift bugs the X-GIS memory log is full of.

---

## 2. The Source / Layer separation — N layers, 1 fetch

MapLibre "maintains a strict separation between data (Sources) and visualization (Layers), which allows multiple layers to reference a single source." ([DeepWiki: Sources & Layers](https://deepwiki.com/maplibre/maplibre-gl-js/3.1-sources-and-layers), [ARCHITECTURE.md](https://github.com/maplibre/maplibre-gl-js/blob/main/ARCHITECTURE.md))

The data path: `Source` → `SourceCache` (renamed `TileManager` in newer MapLibre) → Web Workers, which return `Bucket` objects of vertex/index buffers. `SourceCache`/`TileManager` "calculates the set of `OverscaledTileID`s required for the current camera transform" via `coveringTiles()`, manages the tile lifecycle (add/remove/reload by visibility), and holds an LRU `TileCache` that destroys oldest tiles past `_maxTileCacheSize`, "releasing their GPU memory (textures and buffers)." Inactive tiles are "held as parents/children for transitions" so a child can render its parent's data while loading. ([DeepWiki: Tile Management](https://deepwiki.com/maplibre/maplibre-gl-js/2.4-tile-management))

The key design move: **a `Bucket` is "the single point of knowledge about turning vector tiles into WebGL buffers,"** and is created per _family of style layers that share the same source-layer and layout properties_ — so two layers reading the same features at the same layout are tessellated **once**, not twice. ([ARCHITECTURE.md](https://github.com/maplibre/maplibre-gl-js/blob/main/ARCHITECTURE.md))

**Transfer to X-GIS: HIGH for the data-sharing principle; MEDIUM for the exact class shapes.** The "1 fetch / 1 tessellation feeds N layers" rule is renderer-agnostic and directly applicable. The cross-cutting X-GIS lesson is the _opposite_ failure mode flagged repeatedly in its memory: **"fragmented passes (bg/fill/line/label separate)"** and god-objects owning state. MapLibre's `Bucket` is the antidote — a single owner for "vector tile → GPU buffer" that the render pass merely _consumes_. X-GIS's `VTR` (5298–5608 LOC, the repo's flagged #1 debt) is the anti-`Bucket`: it concentrates knowledge that MapLibre deliberately splits across `WorkerTile` (orchestration), `Bucket` (geometry→buffer), and `ProgramConfiguration` (buffer→shader binding). **The transferable structure is the three-way split, not a monolith with a clean name.**

**4D-city note:** the Source/Layer/SourceCache shape extends cleanly to a _time_ dimension — a temporal source is "just" a source whose `coveringTiles`/cache key includes a time coordinate, and layers reference it unchanged. MapLibre's separation is what makes that additive rather than a rewrite. (Inference from the architecture; not a cited MapLibre feature.)

---

## 3. The Worker boundary — Actor / Dispatcher RPC

Heavy work is offloaded to Web Workers: `WorkerTile.parse()` "performs CPU-intensive tasks of decoding coordinates, handling label placement, and generating vertex buffers (tessellation)," and results return to the main thread via `postMessage` using **Transferable objects to avoid expensive memory copies.** ([DeepWiki: Tile Management](https://deepwiki.com/maplibre/maplibre-gl-js/2.4-tile-management), [DeepWiki: GeoJSON & Vector Data](https://deepwiki.com/maplibre/maplibre-gl-js/3.3-geojson-and-vector-data-visualization))

The RPC layer is two classes:

- **`Actor`** (`src/util/actor.ts`) — bidirectional, promise-shaped message passing between a thread and its peer; the unit that "sends layout tasks to Web Workers."
- **`Dispatcher`** (`src/util/dispatcher.ts`) — owns the _pool_ of workers and routes parse requests across them (load-balancing tile work).

Messages are moved across the boundary by a **`register`/`serialize`/`deserialize`** registry (`web_worker.ts` + the serialization util) so that rich typed objects (not just plain JSON) survive the thread hop. ([DeepWiki: Worker Architecture](https://deepwiki.com/maplibre/maplibre-gl-js/2.1-worker-architecture); class refs to `src/util/actor.ts`, `src/util/dispatcher.ts`, `src/util/web_worker.ts`)

The deserialization step on the main thread "creates a `Bucket` for each family of style layers" — i.e. **the worker returns ready-to-upload geometry; the main thread does no tessellation.** The rationale: "Offloading to workers separates I/O-bound tile parsing from the render thread, preventing frame drops during heavy tileset processing while maintaining 60fps rendering responsiveness." ([DeepWiki: Worker Architecture](https://deepwiki.com/maplibre/maplibre-gl-js/2.1-worker-architecture))

**Transfer to X-GIS: HIGH, with one WebGPU-specific caveat.** The Actor/Dispatcher pattern and the "workers produce GPU-ready buffers, main thread only uploads + draws" contract are runtime-identical for WebGPU (Web Workers + Transferables are the same in both APIs). X-GIS already does worker tile parsing per its memory notes (PriorityQueue, staging-buffer pool, parallel IR/GPU init), so the pattern is present. **The transferable discipline to enforce:** the worker boundary should be the _only_ place tessellation happens, and it should hand back transferable `ArrayBuffer`s, never live objects — otherwise you re-copy and lose the whole point. The one caveat: WebGPU `GPUBuffer` creation/mapping cannot happen in a worker without an `OffscreenCanvas`/device per worker; MapLibre (WebGL) returns CPU `ArrayBuffer`s and uploads on the main thread. X-GIS should keep the same split — **worker = CPU typed-array geometry; main thread = `device.queue.writeBuffer`** — rather than trying to be clever with cross-thread GPU resources.

**Anti-pattern MapLibre avoids:** doing tessellation/label-layout on the main thread "just for this one source type." Every source type (vector, GeoJSON) is forced through the worker. X-GIS's own audits show its dominant CPU hot path is the _label pipeline on the main thread_ (memory: "10.93ms dispatch… per-frame collision w/o off-screen cull") — exactly the work MapLibre pushes to the worker (`WorkerTile.parse` does label placement). This is a concrete place X-GIS diverges and pays.

---

## 4. The Event system — the `Evented` mixin + bubbling parent chain

`Evented` (`src/util/evented.ts`) is a mixin/base class inherited by `Map`, `Style`, and `Source` that provides `on`/`off`/`once`/`fire`/`listens`/`setEventedParent`. ([MapLibre Event System](https://deepwiki.com/maplibre/maplibre-gl-js/2.3-event-system), [Mapbox Events](https://docs.mapbox.com/mapbox-gl-js/api/events/))

Two structural choices make it load-bearing:

1. **The `_eventedParent` chain (event bubbling).** A `Source` sets its evented parent to `Style`, which sets its parent to `Map`. When a `Source` fires `data`/`sourcedata`, it bubbles up the chain so an app listening on `map.on('sourcedata', …)` hears it — "without direct dependencies" between the rendering internals and the public API. Lower-level components propagate state changes upward through an observable chain. ([DeepWiki: Event System](https://deepwiki.com/maplibre/maplibre-gl-js/2.3-event-system))

2. **Error events are special-cased to never silently drop.** If an `ErrorEvent` fires with no registered listener, instead of being swallowed the system does `console.error(event.error)`, "ensuring visibility of problems even without explicit handlers." ([Evented source summary](https://github.com/maplibre/maplibre-gl-js/blob/main/src/util/evented.ts))

`.once(type)` returns a **Promise** when called without a callback, and `.on()` returns a `Subscription` with `unsubscribe()` — modern ergonomics that make teardown explicit (important for `map.remove()` not leaking listeners). ([DeepWiki: Event System](https://deepwiki.com/maplibre/maplibre-gl-js/2.3-event-system))

The event taxonomy is small and stable: **lifecycle** (`load`, `render`, `idle`, `remove`, `error`), **data** (`dataloading`, `data`, `sourcedata`, `styledata`), **camera** (`movestart`/`move`/`moveend`, `zoomstart`/`zoom`/`zoomend`, `rotate`, `pitch`). ([DeepWiki: Event System](https://deepwiki.com/maplibre/maplibre-gl-js/2.3-event-system), [Mapbox Events](https://docs.mapbox.com/mapbox-gl-js/api/events/))

**Transfer to X-GIS: HIGH and this is a flagged X-GIS gap.** The X-GIS ship-readiness audit explicitly names "eventless API" and "no move/zoom events" as blockers (memory: "eventless API", "No move/zoom events"). MapLibre's `Evented` mixin + bubbling chain is the _exact_ missing piece, is ~200 lines of pure TypeScript, has zero WebGL/WebGPU coupling, and is therefore a near-free adoption. **Adopt it close to verbatim**, including:

- the bubbling `_eventedParent` chain (so `Source.fire('data')` reaches `map.on('data')` for free),
- the error-event special-case (the X-GIS memory log repeatedly shows swallowed validation rejections — see open task "un-swallow validation-error rejections"; MapLibre's pattern is the canonical fix),
- the `data`/`sourcedata`/`styledata`/`idle` events, because **the dirty-flag render loop (§5) needs `idle`/`render` to be observable to be testable**.

**Where X-GIS diverges and pays:** without a public event surface, an app cannot know when the map is settled, cannot drive sync'd overlays, and cannot be tested by "wait for `idle`." The render-verification-harness memory notes already hit this (harness paint-wait fragility, "fixtures 42→1"). `idle`/`render` events are the principled fix.

---

## 5. The render loop — `_render`, `_update`, and the three dirty flags

This is the heart of "how it stays cheap." `Map` declares three flags:

```ts
_styleDirty: boolean // style/layers changed → re-evaluate paint props
_sourcesDirty: boolean // tiles changed → re-pick covering tiles, upload
_placementDirty: boolean // symbol collision/placement needs another pass
```

([map.ts dirty-flag declarations](https://github.com/maplibre/maplibre-gl-js/blob/main/src/ui/map.ts))

`_update(updateStyle)` is the **single entry point that schedules a frame.** Every state change funnels through it. The constructor wires interactions to it explicitly:

```ts
this.on('move', () => this._update(false)) // camera moved, style clean
this.on('moveend', () => this._update(false))
this.on('zoom', () => this._update(true)) // zoom changes style eval
this.on('terrain', () => {
  this.painter.terrainFacilitator.depthDirty = true
  this._update(true)
})
```

`_update` sets the relevant dirty flag(s) and requests an animation frame (held via an `AbortController` `_frameRequest`, so it can be cancelled on `remove()` / `setStyle()`). ([map.ts constructor + _update](https://github.com/maplibre/maplibre-gl-js/blob/main/src/ui/map.ts))

Inside the frame, `_render` runs a **fixed ordered pipeline**, each stage gated by its flag:

1. If `_styleDirty`: `style.update(parameters)` re-evaluates zoom-dependent + transitioning paint properties.
2. If `_sourcesDirty`: each `SourceCache`/`TileManager` updates its covering-tile set and uploads new tiles.
3. **Symbol placement:** the `crossTileSymbolIndex` is updated and `placement` runs collision detection; if placement isn't converged it sets `_placementDirty` to force another frame (fade animations). ([DeepWiki: Core Architecture](https://deepwiki.com/mapbox/mapbox-gl-js/2-core-architecture); see §6 for `crossTileSymbolIndex`)
4. `painter.render(style, options)` walks `style._order` layer-by-layer issuing draw calls (§7).
5. Fire `render`. Then the **convergence check:** if `style.hasTransitions()` or `_sourcesDirty` or `_styleDirty` or `_placementDirty` remain set, call `triggerRepaint()` to schedule another frame; **otherwise fire `idle` and stop requesting frames.** ([Mark WebGL state dirty on Map._render() PR #7081](https://github.com/mapbox/mapbox-gl-js/pull/7081), [Stop render loop when idle issue #12625](https://github.com/mapbox/mapbox-gl-js/issues/12625), [map.loaded semantics issue #5052](https://github.com/mapbox/mapbox-gl-js/issues/5052))

The payoff: **MapLibre does not run a busy 60fps loop.** It renders exactly when something is dirty or animating, then goes idle. `map.loaded()` is literally "no pending source/tile/style loads or updates and the animation loop has finished." ([map.loaded issue #5052](https://github.com/mapbox/mapbox-gl-js/issues/5052), [styledata "not done loading" issue #9779](https://github.com/mapbox/mapbox-gl-js/issues/9779))

**Transfer to X-GIS: HIGH — this is the most architecturally valuable pattern to copy exactly.** Three reasons it transfers perfectly: it is pure CPU-side scheduling (zero WebGL/WebGPU coupling); it is the mechanism that makes the map _thermally cheap_ (X-GIS memory flags "adaptive-DPR DEAD CODE… cheapest fix" and high-pitch thermal — an idle loop is the real cheapest fix); and it makes the system _observable and testable_ via `idle`. X-GIS's render-verification-harness pain ("vite cache masks runtime mutation," paint-wait fragility) is partly because there is no principled "the frame is converged" signal. **Adopt: a single `_update()` funnel + named dirty flags (`_styleDirty`/`_sourcesDirty`/`_placementDirty` — or the X-GIS `DirtyDomains` authority already named in the Blender roadmap) + a convergence check that fires `idle` and stops.** Note: X-GIS already has a `_needsRender` notion (open task "re-arm `_needsRender`") — that is a _single_ dirty bit; MapLibre's lesson is that **one global dirty bit is too coarse** — splitting into style/sources/placement domains is what lets each stage skip cheaply and is what makes the "re-arm" bugs (glyph PBF landed but frame not re-requested) go away, because the landing callback sets the _specific_ domain dirty.

**WebGPU caveat:** PR #7081 ("Mark WebGL state as dirty on `Map._render()`") exists because WebGL is a global state machine and custom layers can corrupt it. WebGPU has no global state machine — render state lives in immutable `GPURenderPipeline`/`GPUBindGroup` objects bound per-pass. **So X-GIS does NOT need the WebGL-state-dirty machinery** — one of the few places the peer's complexity does _not_ transfer, and dropping it is correct, not a regression.

---

## 6. CrossTileSymbolIndex + Placement — the hardest sustainability problem, isolated

Tiled maps have a brutal labeling problem: "San Francisco" exists as a symbol in the z10 tile _and_ the z11 tile; when you cross zoom levels the label must not flicker/re-fade. The **`CrossTileSymbolIndex` is a global index of all symbols that identifies "duplicate" symbols across tiles of different zoom levels**, assigning them a stable cross-tile ID so fade state is tied to "collision time," not zoom level. It is a collection of `CrossTileSymbolLayerIndex` (duplicates only exist within one layer), each mapping integer-zoom → tile-coord → `TileLayerIndex`. New symbols start opacity `[0,0]`; a symbol sharing a cross-tile ID with an existing one inherits its opacity state (no re-fade). ([PR #6497 Global symbol query](https://github.com/mapbox/mapbox-gl-js/pull/6497), [Collision Detection wiki](https://github.com/mapbox/mapbox-gl-native/wiki/Collision-Detection), [PR #5150 Viewport collision detection](https://github.com/mapbox/mapbox-gl-js/pull/5150))

Collision is **viewport-global, not per-tile**: PR #5150 moved collision detection from tile-local to a single viewport-wide `Placement` pass precisely because per-tile collision produced wrong results at tile boundaries (issue #6548). `Placement` owns the per-frame collision grid and opacity animation; `CrossTileSymbolIndex` owns _identity across tiles/zooms_; `Tile` is "only responsible for latest data." ([PR #5150](https://github.com/mapbox/mapbox-gl-js/pull/5150), [issue #6548](https://github.com/mapbox/mapbox-gl-js/issues/6548))

**Transfer to X-GIS: HIGH in _requirement_, HIGH-value in _architecture lesson_.** Any tiled map that renders labels eventually needs cross-tile symbol identity and viewport-global collision — this is not WebGL-specific, it is a _map_ problem, so it transfers fully. The architectural lesson is the **clean three-way ownership split**: identity-across-tiles (`CrossTileSymbolIndex`), this-frame-collision (`Placement`), latest-data (`Tile`). X-GIS's memory is full of label bugs (CJK box-out, bilingual overlap, shield align, "per-frame collision w/o off-screen cull," "labels=ZERO at z14"). The recurring root is that X-GIS's label logic is **entangled with the per-frame render path and lacks a persistent cross-tile identity layer** — so every zoom cross is a fresh placement with no memory. **The most valuable single thing to copy from MapLibre is this ownership split**, and it is gated on having the §5 dirty-flag loop (placement needs `_placementDirty` to drive multi-frame fade convergence) and the §4 idle event (to know placement converged).

---

## 7. Painter / ProgramConfiguration — buffer↔shader binding as a contract

Rendering proceeds "style-layer by style-layer, in `Painter#renderPass()`," delegating to per-type `drawXxxx()` methods that fetch the shader program, set uniforms from style props, bind the bucket's buffers, and call `gl.drawElements()`. Layers render in `style._order` order. ([ARCHITECTURE.md](https://github.com/maplibre/maplibre-gl-js/blob/main/ARCHITECTURE.md), [DeepWiki: Core Architecture](https://deepwiki.com/mapbox/mapbox-gl-js/2-core-architecture))

**`ProgramConfiguration` is the contract between data-driven style and shaders.** It expands a `#pragma mapbox` in shader source into _either_ a uniform (for feature-constant props) _or_ an attribute + varying + local declaration (for data-driven props), and `Binders` precompute data-driven paint values at `tileZoom` and `tileZoom+1`, passing interpolation factors to the shader. This is how "color = interpolate(zoom, …, get('population'))" becomes real GPU code without a combinatorial shader explosion. ([ARCHITECTURE.md](https://github.com/maplibre/maplibre-gl-js/blob/main/ARCHITECTURE.md), [Expression Architecture wiki](https://github.com/mapbox/mapbox-gl-native/wiki/Expression-Architecture))

**Transfer to X-GIS: HIGH in _concept_, and X-GIS has independently reinvented it.** X-GIS's `shader-dsl` (a named authority in the Blender roadmap; the memory log has an entire "Shader DSL Phase 0–4" arc that DSL-emits every shader and deleted `renderer-shaders.ts`) is the direct analogue of `ProgramConfiguration` + the `#pragma mapbox` expansion. **This is a place X-GIS is _aligned_ with the peer and should keep going** — the DSL/codegen approach to "data-driven property → uniform-or-attribute" is exactly MapLibre's sustainability lever for avoiding hand-written shader variants. The transferable validation: MapLibre proves this pattern scales to 100k+ LOC and a decade. X-GIS's "byte-equal drift gate" (US-010) is even _stricter_ than MapLibre's testing here.

---

## 8. The expression system — compile once, evaluate per-feature

Style values can be **expressions** (JSON arrays, operator-first) for any paint/layout/filter property. They are "compiled once from JSON style-spec into an AST of `Expression` objects" by `ParsingContext`, with **strict type-checking at parse time** (assertions/coercions/implicit annotations), then evaluated per-feature via an `EvaluationContext` carrying `GlobalProperties` (zoom), `Feature`, and `FeatureState`. Three dependency classes — feature-constant, zoom-dependent, data-driven(composite) — determine the render-time code path. The property pipeline is `PropertyValue` (raw) → `PossiblyEvaluatedValue` (caches feature-constant results) → `Binders` (data-driven → shader). ([Expression Architecture wiki](https://github.com/mapbox/mapbox-gl-native/wiki/Expression-Architecture), [Style Spec: Expressions](https://docs.mapbox.com/style-spec/reference/expressions/), [DeepWiki: Style System](https://deepwiki.com/mapbox/mapbox-gl-js/2.2-style-specification))

Deliberate design constraints (the _anti-patterns avoided_):

- **Not Turing-complete** — "prevent unbounded evaluation costs." A style cannot hang the renderer.
- **Written form ≈ the AST** — keeps the spec inspectable/serializable/portable across renderers.
- **Type-checked at parse, not at render** — "catching errors early and enabling safe shader compilation." ([Expression Architecture wiki](https://github.com/mapbox/mapbox-gl-native/wiki/Expression-Architecture))

**Transfer to X-GIS: MEDIUM-HIGH, with a caveat about X-GIS's compile-time model.** X-GIS compiles styles ahead-of-time in its `compiler/` (IR, layer auto-merge) rather than evaluating a live expression AST per-feature at render time — a _legitimately different_ and arguably better choice for a renderer that controls its whole pipeline (it moves expression cost out of the frame entirely). So the verbatim `Expression`/`EvaluationContext` machinery does **not** need to transfer. What _does_ transfer is the **discipline**: (a) the declarative form must be **non-Turing-complete and bounded** (X-GIS already inherits this by consuming the Mapbox spec); (b) **type-check at compile time, not render time** — which X-GIS's IR/compiler is well-positioned to do and should; (c) feature-state (runtime per-feature mutation without re-fetching the tile) is a feature X-GIS will eventually need for interactivity and 4D — MapLibre's `FeatureState` separate from tile data is the pattern. **Caveat:** if X-GIS ever needs _runtime_ style mutation (data-driven values changing without recompiling), the AOT model fights it; MapLibre's live-AST model wins there. X-GIS's ship-readiness memo already decided to "cut style-mutation from v1," which is consistent — but the 5-year horizon (4D-city) will likely re-open it, and the live-expression model is the proven answer.

---

## 9. Request management / throttling

Tile requests are managed by `SourceCache`/`TileManager`: covering tiles are recomputed each `update()`; loading is bounded by the LRU cache and `_maxTileCacheSize`; parent/child tiles serve as fallbacks while a tile loads (so the screen is never blank during streaming). Newer MapLibre uses `AbortController` to **abort in-flight tile requests** when a tile leaves the covering set (the `_frameRequest: AbortController` in `map.ts` is the frame-level analogue). ([DeepWiki: Tile Management](https://deepwiki.com/maplibre/maplibre-gl-js/2.4-tile-management), [map.ts AbortController](https://github.com/maplibre/maplibre-gl-js/blob/main/src/ui/map.ts))

**Transfer to X-GIS: HIGH.** Abort-on-evict + parent/child fallback + LRU-by-bytes are all renderer-agnostic. X-GIS's memory already shows convergent evolution here (PriorityQueue, byte-aware arena eviction with hysteresis after the globe OOM, parent-fallback fixes, prewarm). The lesson: **MapLibre validates that tile budgeting must be _byte-aware_ and _abortable_** — exactly the GPUArena OOM root-cause X-GIS already hit ("eviction trigger = tile COUNT but arena = BYTES"). This is a place X-GIS _converged independently_ and the peer confirms the fix is correct.

---

## 10. How ~100k+ LOC stays sustainable — the meta-patterns

Stepping back, the structural invariants that keep the codebase maintainable for a decade:

1. **Contracts between subsystems, not call graphs.** Style↔renderer is a JSON document. Main↔worker is an Actor message + serialization registry. Data↔style is the Source/Layer split. Each boundary is _serializable_, which is what makes it testable, portable across three renderers (JS/native/iOS), and independently evolvable. ([ARCHITECTURE.md](https://github.com/maplibre/maplibre-gl-js/blob/main/ARCHITECTURE.md))
2. **Single owner per concern.** `Bucket` owns geometry→buffer. `ProgramConfiguration` owns buffer→shader. `CrossTileSymbolIndex` owns cross-tile identity. `SourceCache` owns tile lifecycle. `Style` owns the document. No god-objects spanning concerns. (This is the explicit _contrast_ with X-GIS's VTR/map.ts god-files in its own memory.)
3. **The spec is data, validated once.** Schema validation at the door (v8) means downstream code can trust its inputs. ([DeepWiki: Style System](https://deepwiki.com/mapbox/mapbox-gl-js/2.2-style-specification))
4. **The render loop is dirty-flag driven and idles.** Cheapness and observability come from the same mechanism (§5).
5. **Errors are never silent.** The Evented error special-case (§4).

**Governance/sustainability as architecture (the non-code part):** MapLibre exists _because_ the architecture was a clean, forkable contract-based system. When Mapbox closed GL JS v2 under a non-OSS license in Dec 2020, the community forked the last OSS version and merged competing forks into one project within ~a month, now governed by a multi-company group (MapTiler, Elastic, StadiaMaps, Microsoft, AWS funding, etc.) with paid maintainers. ([MapTiler: MapLibre fork](https://www.maptiler.com/news/2021/01/maplibre-mapbox-gl-open-source-fork/), [The New Stack: How a Fork Became a Thriving Project](https://thenewstack.io/maplibre-how-a-fork-became-a-thriving-open-source-project/), [WP Tavern: MapLibre official successor](https://wptavern.com/maplibre-launches-as-official-open-source-successor-to-mapbox-gl-js)). The architectural lesson for a 5-year horizon: **a system built as serializable contracts survives a governance discontinuity; a system built as an entangled call graph does not.** A clean Source/Layer/Worker/Style boundary is what made the fork _technically possible_.

---

## 11. Verdict — adopt / adapt / reject for X-GIS (WebGPU/TS, 3D-tiles, 4D)

| MapLibre pattern                                                                                   | Transfer         | X-GIS action                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declarative style spec as **sole** authority                                                       | HIGH             | **Adopt the discipline** — kill the authority-inversion (PROJECTIONS table / shader literals as parallel truth). X-GIS already consumes the spec; the fix is "one authority."                                                                 |
| Source/Layer split; 1 fetch→N layers                                                               | HIGH             | **Adopt principle.** Counter the "fragmented passes" + VTR god-file debt with a single `Bucket`-style owner of geom→buffer.                                                                                                                   |
| `Bucket` / `WorkerTile` / `ProgramConfiguration` three-way split                                   | HIGH             | **Adopt the split**, not a monolith. Decompose VTR along these seams.                                                                                                                                                                         |
| Actor / Dispatcher worker RPC; transferables                                                       | HIGH             | **Adopt.** Force ALL tessellation + **label placement** into the worker (X-GIS's main-thread label loop is its #1 CPU hot path — direct divergence cost). Keep GPU upload main-thread (WebGPU caveat).                                        |
| `Evented` mixin + bubbling + error-special-case                                                    | HIGH             | **Adopt near-verbatim.** Fixes X-GIS's flagged "eventless API," "no move/zoom events," and "swallowed validation rejections" in one ~200-LOC module.                                                                                          |
| Dirty-flag render loop (`_styleDirty`/`_sourcesDirty`/`_placementDirty`) + `_update` funnel + idle | HIGH             | **Adopt — highest-value pattern.** Split the single `_needsRender` bit into domains (the named `DirtyDomains` authority). Fixes thermal cost + re-arm bugs + harness paint-wait. Drop the WebGL-state-dirty machinery (not needed on WebGPU). |
| `CrossTileSymbolIndex` + viewport-global `Placement`                                               | HIGH             | **Adopt the ownership split** (identity / this-frame-collision / latest-data). Root fix for the recurring label-flicker/zoom-cross bugs. Gated on the dirty-flag loop.                                                                        |
| `shader-dsl` ≈ `ProgramConfiguration` codegen                                                      | HIGH (aligned)   | **Keep going** — X-GIS already converged here; the peer validates it scales 10 yrs.                                                                                                                                                           |
| Live expression AST, compiled once, eval per-feature                                               | MEDIUM           | **Adapt, don't copy.** X-GIS's AOT compiler is a valid different choice; copy the _discipline_ (bounded/non-Turing, type-check at compile). Revisit live-expressions + `FeatureState` for 4D interactivity.                                   |
| Byte-aware abortable tile budgeting                                                                | HIGH (converged) | **Keep** — X-GIS already fixed this post-OOM; peer confirms correctness.                                                                                                                                                                      |
| WebGL global-state-dirty handling                                                                  | N/A              | **Reject** — WebGPU has no global state machine; correctly absent.                                                                                                                                                                            |

**Where a typical X-GIS-style renderer diverges and pays (summary):** (1) multiple authorities for one truth (style/IR/projection-table/shader-literal drift); (2) main-thread label placement instead of worker; (3) a single coarse dirty bit instead of per-domain flags → re-arm bugs + a busy/thermal loop; (4) god-files (VTR/map.ts) instead of single-owner subsystems; (5) no public event surface → untestable convergence + fragile harness. Every one of these is something MapLibre's architecture deliberately prevents, and every one appears as a real, logged X-GIS bug.

---

### Source reliability note

Primary sources (official `ARCHITECTURE.md`, style-spec docs, core-dev PRs/wikis, the `evented.ts`/`map.ts`/`actor.ts` source files) were used for every load-bearing claim. DeepWiki pages are LLM-generated _over the actual MapLibre/Mapbox source_ and were used for structural navigation; where they assert specific class/method names (`Actor`, `Dispatcher`, `CrossTileSymbolIndex`, `ProgramConfiguration`, the dirty flags) those names are cross-confirmed by the primary `ARCHITECTURE.md`, the cited PRs, and/or the source files. The large source files (`map.ts` `_render` body) could not be fetched in full due to tool truncation; the render-loop sequence in §5 is reconstructed from `ARCHITECTURE.md`, the dirty-flag PRs (#7081, #12625, #5052, #9779), the constructor wiring visible in `map.ts`, and the DeepWiki structural index — the ordering is well-corroborated but individual line-level quotes of `_render` are not verbatim.
