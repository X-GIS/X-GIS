# B4 — deck.gl + three.js: Layered GPU Rendering, Demand-Render, Resource Lifecycle

Research brief for the X-GIS 5-year architecture reckoning.
Topic: extract the composable-rendering and GPU-resource-lifecycle patterns from **deck.gl** (layered, reactive, luma.gl-backed) and **three.js** (scene-graph, demand-render, manual disposal) that a WebGPU + TypeScript web-map renderer should adopt — and, critically, which ones do **not** transfer.

These two are far more relevant to X-GIS than Blender/Unreal: both are **JS/TS, browser, WebGL/WebGPU** codebases. deck.gl in particular is a *geospatial GPU renderer in TypeScript on WebGPU* — i.e. X-GIS's direct architectural sibling. So the transfer bar is much lower here, and the warning is the reverse: where deck.gl/three.js made a mistake that bit them for years, X-GIS is on exactly the same terrain and should not repeat it.

Date: 2026-06-08. All claims cited inline.

---

## 0. Executive summary (the load-bearing findings)

1. **deck.gl's reactive layer model is the single most transferable idea here.** Layers are *cheap disposable descriptor objects* recreated every state change; the framework *diffs them by `id`* against the previous cycle and *moves the persistent GPU `state` object forward* onto the matched new descriptor, so GPU resources are only touched when something actually changed. This cleanly separates "what the map should show" (cheap, recomputed freely) from "GPU resources" (expensive, persistent, lifecycle-managed). [deck.gl using-layers](https://deck.gl/docs/developer-guide/using-layers), [deck.gl layer-lifecycle](https://deck.gl/docs/developer-guide/custom-layers/layer-lifecycle)
2. **A formal Layer lifecycle (`initializeState` / `shouldUpdateState` / `updateState` / `draw` / `getPickingInfo` / `finalizeState`) is the contract that makes the above safe.** GPU resources are created in `initializeState`, mutated in `updateState`, and *explicitly destroyed* in `finalizeState`. [deck.gl layer-lifecycle](https://deck.gl/docs/developer-guide/custom-layers/layer-lifecycle)
3. **`updateTriggers` + per-attribute invalidation is the partial-update discipline X-GIS lacks.** deck.gl never re-uploads a whole buffer when one accessor's input changed; it invalidates *only that attribute*, optionally only a `dataRange` sub-slice. This is exactly the invalidation-granularity problem on the X-GIS roadmap. [deck.gl performance](https://deck.gl/docs/developer-guide/performance), [deck.gl attribute-management](https://deck.gl/docs/developer-guide/custom-layers/attribute-management)
4. **three.js teaches demand-render the hard way: it is fragile.** `frameloop=demand` / `invalidate()` saves battery, but every async event (texture load, control damping, prop mutation outside the framework) is a *missed-frame footgun* unless you explicitly re-invalidate. The damping infinite-loop and the "texture loaded but screen is stale" bugs are the canonical traps. [three.js rendering-on-demand](https://threejs.org/manual/en/rendering-on-demand.html), [r3f rendering-only-when-needed](https://r3f.docs.pmnd.rs/advanced/scaling-performance)
5. **three.js's manual-disposal model is the anti-pattern to *partially* avoid.** three.js explicitly does NOT garbage-collect GPU resources — you must call `geometry.dispose()`, `material.dispose()`, `texture.dispose()`, `renderTarget.dispose()` by hand, and removing a mesh from the scene frees *nothing*. This has caused leaks for a decade. deck.gl's lifecycle-owned `finalizeState` is the better answer; X-GIS should own resource lifetimes via its own lifecycle, not push `dispose()` onto callers. [three.js how-to-dispose](https://threejs.org/manual/en/how-to-dispose-of-objects.html)
6. **luma.gl is the proof that a WebGPU-first portable GPU layer is viable in TS**, and its choices (Device-centric creation, immutable Textures + `AsyncTexture`, explicit `destroy()`, model resources on WebGPU's shape and emulate WebGL2 under it) are a directly reusable blueprint for X-GIS's own GPU-resource layer. [luma.gl api-guide](https://luma.gl/docs/api-guide), [luma.gl whats-new](https://github.com/visgl/luma.gl/blob/master/docs/whats-new.md), [luma.gl webgpu-vs-webgl](https://luma.gl/docs/api-guide/background/webgpu-vs-webgl)

---

## 1. deck.gl — the reactive layer model

### 1.1 Layers are descriptors, not resources

deck.gl's foundational decision: the application **recreates the entire layer list on every state change**, and that is *cheap on purpose*.

> "In a reactive application, a complete UI description is 're-rendered' every time something in the application state changes (in the case of a deck.gl application, a new list of layers is created whenever something changes)." — [deck.gl using-layers](https://deck.gl/docs/developer-guide/using-layers)

> "The trick is that layers are just descriptor objects that are very cheap to instantiate... Internally, the new layers are efficiently matched against existing layers so that no updates are performed unless actually needed." — [deck.gl using-layers](https://deck.gl/docs/developer-guide/using-layers)

The expensive part — the actual GPU resources — is **moved forward** between descriptor instances:

> "All calculated state (WebGL2/WebGPU 'programs', 'vertex attributes' etc) are stored in a state object and this state object is moved forward to the newly matched layer on every render cycle." — [deck.gl using-layers](https://deck.gl/docs/developer-guide/using-layers)

> "This is very similar to how React works where every render cycle generates a new tree of ReactElement instances, so the model is proven." — [deck.gl using-layers](https://deck.gl/docs/developer-guide/using-layers)

The mental model deck.gl documents: **layer descriptors ≈ React elements; the internal matched layers ≈ DOM nodes.** Creating descriptors is cheap; mutating the internal GPU "DOM" is expensive and done only on diff. [deck.gl FAQ](https://github.com/visgl/deck.gl/blob/master/docs/faq.md)

### 1.2 The matching/diff mechanism (by `id`)

Layers are matched across render cycles **by their `id`**. [deck.gl layer-lifecycle](https://deck.gl/docs/developer-guide/custom-layers/layer-lifecycle)

- **New `id`, no previous match → Initialization.** `initializeState()` runs once, then `updateState()` once before first render.
- **Same `id`, new props → Update.** The old layer's `state` becomes the new descriptor's `state`; `shouldUpdateState()` then `updateState()` run.
- **Previous `id` absent in new cycle → Finalization.** `finalizeState()` runs to release resources.

Default prop comparison is **shallow equality**, which is why the model is cheap and why mutating data in place silently fails to register (see §1.5 footgun). [deck.gl using-layers](https://deck.gl/docs/developer-guide/using-layers), [deck.gl attribute-management](https://deck.gl/docs/developer-guide/custom-layers/attribute-management)

### 1.3 The Layer lifecycle contract

From the [deck.gl layer-lifecycle](https://deck.gl/docs/developer-guide/custom-layers/layer-lifecycle) doc, the methods and their responsibilities:

| Method | Phase | Responsibility |
|---|---|---|
| `initializeState()` | init (once) | The one mandatory method. Create the GPU `Model` and register dynamic attributes via the `AttributeManager`. Resources created here. |
| `shouldUpdateState({changeFlags})` | update gate | Decide whether to run `updateState`. Default reacts to prop/data changes, *ignores viewport changes* (a deliberate cheapness choice). |
| `updateState({props,oldProps,changeFlags})` | update | Invalidate attributes (`attributeManager.invalidate(...)`), push uniforms (`model.shaderInputs.setProps(...)`). Runs on init and on every matched-prop change. By default a `props.data` change invalidates *all* attributes. |
| `draw({uniforms})` | render (per frame) | Issue the GPU draw (`model.render`). For composite layers, `renderLayers()` emits sublayers instead. |
| `getPickingInfo({info})` | picking | Picking reuses `draw()` into an off-screen buffer with special uniforms; this turns the picked id into the info object passed to `onHover`/`onClick`. |
| `finalizeState()` | finalize | "A good time to destroy non-shared GPU resources directly, rather than waiting for the garbage collector to do it." Called just before the `state` reference is released. |

Two structural ideas worth lifting wholesale:
- **Composite vs primitive layers.** A composite layer implements `renderLayers()` and decomposes into primitive sublayers; primitives implement `draw()`. This is how deck.gl keeps a `GeoJsonLayer` (composite) built out of `PolygonLayer`/`PathLayer`/`PointLayer` (primitives) without a god-object. [deck.gl primitive-layers](https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/custom-layers/primitive-layers.md)
- **Picking is the same pipeline, re-parameterized.** Not a separate code path — `draw()` into a picking target with picking uniforms. [deck.gl layer-lifecycle](https://deck.gl/docs/developer-guide/custom-layers/layer-lifecycle)

### 1.4 AttributeManager — the partial-update engine

The single most useful low-level pattern for X-GIS's invalidation work. The register → invalidate → update loop:

> "the app will call `AttributeManager.invalidate()`. Finally before it renders, it calls `AttributeManager.update()` to ensure that attributes are automatically rebuilt if anything has been invalidated." — [deck.gl attribute-management](https://deck.gl/docs/developer-guide/custom-layers/attribute-management)

Key properties:
- **Per-attribute invalidation, not per-buffer-blowaway.** Attributes are invalidated individually; only invalidated ones are rebuilt on `update()`. [deck.gl attribute-management](https://deck.gl/docs/developer-guide/custom-layers/attribute-management)
- **Partial range updates.** `AttributeManager` supports a `dataRange` `{startRow, endRow}` so you can recompute and re-upload only a slice of a large buffer. "Start (included) and end (excluded) are indices into the data array." [deck.gl attribute-manager API](https://github.com/visgl/deck.gl/blob/master/docs/api-reference/core/attribute-manager.md)
- **Decoupling of data description from GPU resource.** Accessors describe *how to read a value from a datum*; update functions fill typed arrays that become the GPU buffer. The buffer persists; only the contents that changed are rewritten. Applications can even supply pre-generated buffers directly for "ultimate performance and control of updates, as well as potential sharing of buffers between layers." [deck.gl attribute-management](https://deck.gl/docs/developer-guide/custom-layers/attribute-management)

### 1.5 The deck.gl cost model & footguns

From the [deck.gl performance](https://deck.gl/docs/developer-guide/performance) guide:

- **`updateTriggers` = invalidate only what changed.** "This tells deck.gl to recalculate radius when `year` changes" — instead of recomputing every attribute or recreating the layer. Use this rather than tearing down and rebuilding. [deck.gl performance](https://deck.gl/docs/developer-guide/performance)
- **Constant props are nearly free; accessor functions are expensive.** `getFillColor: [255,0,0,128]` is a cheap uniform; `getFillColor: d => [...]` builds an N-sized typed array and calls the function per datum. Prefer constants + uniform-driven animation. [deck.gl performance](https://deck.gl/docs/developer-guide/performance)
- **Full data updates are the expensive case.** "data update (where the data object is shallowly changed and `dataComparator` returns false) is expensive, requiring all attributes to be recalculated." [deck.gl performance](https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/performance.md)
- **Binary / pre-packed attributes bypass the CPU entirely.** For heavy datasets, pass typed arrays with a known buffer layout and skip accessor evaluation — "the maximum performance possible in terms of data throughput." When binary, `dataComparator`/`_dataDiff` have no effect. [deck.gl performance](https://deck.gl/docs/developer-guide/performance)
- **FOOTGUN — never recreate a layer to hide it.** "Removing a layer will lose all of its internal states, including generated buffers. If the layer is added back later, all the GPU resources need to be regenerated again." Use the `visible` prop to hide cheaply. [deck.gl performance](https://deck.gl/docs/developer-guide/performance)
- **FOOTGUN — shallow compare misses in-place mutation.** "property change detection uses shallow compare, which means that mutating an element inside a buffer or a mutable data array does not register as a property change." You must bump `updateTriggers`/replace the reference. [deck.gl attribute-management](https://deck.gl/docs/developer-guide/custom-layers/attribute-management)

### 1.6 luma.gl — the GPU abstraction beneath

deck.gl renders through [luma.gl](https://luma.gl/docs), a **WebGPU-and-WebGL2 portable GPU toolkit** that "aims to provide... a low abstraction API that remains conceptually close to the WebGPU and WebGL APIs." This is the closest existing analogue to X-GIS's own GPU layer. Its decisions:

- **WebGPU-first; WebGL2 emulated under it.** luma.gl explicitly "adopted WebGPU's conceptual model, requiring breaking API changes," because "WebGPU... represents the future of GPU programming on the Web" and "was designed to embrace... Vulkan, Metal, and DX12." WebGL2 is the legacy backend bent to fit the WebGPU shape — not the other way round. [luma.gl webgpu-vs-webgl](https://luma.gl/docs/api-guide/background/webgpu-vs-webgl)
- **Device-centric resource creation.** Apps create a `Device`; the installed adapter (`@luma.gl/webgl` or `@luma.gl/webgpu`) decides the backend; `Buffer`/`Texture`/`Shader`/`RenderPipeline`/`RenderPass` are created *through* the device. [luma.gl api-guide](https://luma.gl/docs/api-guide)
- **Immutable textures + a separate mutable `AsyncTexture`.** "Textures are now immutable, however a new `AsyncTexture` class offers a higher-level, mutable texture API." This is precisely the WebGPU-shaped constraint (immutable resource descriptors) with an ergonomic async wrapper for the common "image arrives later" map case. [luma.gl whats-new](https://github.com/visgl/luma.gl/blob/master/docs/whats-new.md)
- **Explicit `destroy()` to free GPU memory.** "You can free up any GPU resources associated with a texture immediately instead of waiting for garbage collection." [luma.gl whats-new](https://github.com/visgl/luma.gl/blob/master/docs/whats-new.md)
- **`bufferLayout` at pipeline creation time.** WebGPU requires buffer interleaving be declared up front; luma.gl introduced a `PipelineProps.bufferLayout` concept to model this portably. [luma.gl webgpu-vs-webgl](https://luma.gl/docs/api-guide/background/webgpu-vs-webgl)
- **Layered API: Core (device/memory/passes) → Shader (modular shader composition) → Engine (`Model`, `AnimationLoop`, transforms).** [luma.gl api-guide](https://luma.gl/docs/api-guide)

---

## 2. three.js — scene-graph, demand-render, manual disposal

### 2.1 Demand rendering (`invalidate()` / `frameloop=demand`)

For a map viewer (not a game) three.js explicitly recommends **rendering only when something changes** to save battery/thermals — the same conclusion X-GIS reached with `_needsRender`. [three.js rendering-on-demand](https://threejs.org/manual/en/rendering-on-demand.html)

The canonical pattern: drop the continuous `requestAnimationFrame` loop; call `render()` once; re-render on `controls` `change` and `window` `resize`:

```javascript
controls.addEventListener('change', render);
window.addEventListener('resize', render);
```
[three.js rendering-on-demand](https://threejs.org/manual/en/rendering-on-demand.html)

In react-three-fiber the same idea is the `frameloop="demand"` mode: "render only when necessary, saving battery and keeping noisy fans in check," and you trigger a frame imperatively with **`invalidate()`** which "lines up one single frame for execution." [r3f scaling-performance](https://r3f.docs.pmnd.rs/advanced/scaling-performance)

### 2.2 The demand-render footguns (directly relevant to X-GIS's `_needsRender`)

These are the exact bugs X-GIS's invalidation phase is wrestling with, documented from the other side:

- **Damping infinite loop.** With `enableDamping`, calling `render` directly from the `change` event loops forever: "The controls will send us a `change` event and call `render`, `render` will call `controls.update`. `controls.update` will send another `change` event." Fix: a **`renderRequested` flag** + `requestAnimationFrame`, so multiple requests coalesce into one frame. [three.js rendering-on-demand](https://threejs.org/manual/en/rendering-on-demand.html)

  ```javascript
  let renderRequested = false;
  function requestRenderIfNotRequested() {
    if (!renderRequested) { renderRequested = true; requestAnimationFrame(render); }
  }
  ```

- **Async resource load does NOT auto-invalidate.** A texture that finishes loading sets `texture.needsUpdate = true` — but in demand mode *nothing re-renders*, so the screen is stale until the next user interaction. There is "no built-in API on `Texture` to detect when a texture is loaded," forcing workarounds. The general r3f warning: "if anything in the tree mutates props, then React cannot be aware of it and the display would be stale." [three.js Texture load events forum](https://discourse.threejs.org/t/load-events-for-texture/38533), [r3f scaling-performance](https://r3f.docs.pmnd.rs/advanced/scaling-performance)
  - **This is exactly the X-GIS glyph-PBF / tile-landed case**: any async arrival (tile decoded, glyph atlas updated, sprite loaded) MUST re-arm the render flag, or the frame is dropped. The class of bug is structural to demand-render, not incidental.

- **Animations need a pre-emptive invalidate.** Tweens/eased camera moves must call `invalidate()` *before* the animation starts (and keep the flag alive each frame), because demand mode won't tick on its own. [three.js Tween-on-demand forum](https://discourse.threejs.org/t/how-do-i-render-a-tween-animation-using-on-demand-rendering-instead-of-a-render-loop/19868)

### 2.3 Manual GPU-resource disposal — three.js's long-standing wart

three.js makes the application responsible for freeing every GPU resource, by design and by limitation:

> "*three.js* does not know the lifetime or scope of user-created entities like geometries or materials. This is the responsibility of the application." — [three.js how-to-dispose](https://threejs.org/manual/en/how-to-dispose-of-objects.html)

> "*three.js* creates for specific objects like geometries or materials WebGL related entities like buffers or shader programs... these objects are **not released automatically**." — [three.js how-to-dispose](https://threejs.org/manual/en/how-to-dispose-of-objects.html)

What must be disposed by hand, and what it frees:
- `BufferGeometry.dispose()` → per-attribute `WebGLBuffer`s
- `Material.dispose()` → shader programs (only freed when *all* sharing materials are disposed)
- `Texture.dispose()` → `WebGLTexture` (and you must *separately* call `ImageBitmap.close()` — three.js cannot, since it "has no way of knowing if the image bitmap is used elsewhere")
- `WebGLRenderTarget.dispose()` → `WebGLFramebuffer` + `WebGLRenderbuffer`
[three.js how-to-dispose](https://threejs.org/manual/en/how-to-dispose-of-objects.html)

The trap that has leaked memory for years:

> "Does removing a mesh from the scene also dispose its geometry and material? **No, you have to explicitly dispose the geometry and material via *dispose()*.**" — [three.js how-to-dispose](https://threejs.org/manual/en/how-to-dispose-of-objects.html)

Recommended pattern (traverse-and-dispose at level/scene switch), and leak tracking via `renderer.info.memory` (counts textures/geometries/programs). Note the documented sharp edge: shared resources must not be double-disposed, and some internal resources legitimately persist in `renderer.info` after a full traversal (envMap/background/environment). [three.js how-to-dispose](https://threejs.org/manual/en/how-to-dispose-of-objects.html)

**Verdict on this pattern: it is the cautionary tale, not the model.** Pushing `dispose()` onto callers is the root of three.js's perennial leak threads ([issue #12447](https://github.com/mrdoob/three.js/issues/12447), [forum: when to dispose](https://discourse.threejs.org/t/when-to-dispose-how-to-completely-clean-up-a-three-js-scene/1549)). deck.gl's lifecycle-owned `finalizeState` — where the *framework* destroys resources when a layer leaves the diff — is the strictly better design and is what X-GIS should emulate.

---

## 3. Transfer assessment for X-GIS (WebGPU + TS web-map renderer)

Skeptical, per-pattern. ✅ adopt / ⚠️ adapt / ❌ reject.

| # | Pattern (source) | Transfers? | Why / why not for X-GIS |
|---|---|---|---|
| 1 | **Reactive layer descriptors, diffed by `id`, persistent `state` moved forward** (deck.gl) | ✅ **Adopt** — highest value | Same language (TS), same domain (geospatial GPU), proven at deck.gl's scale. Cleanly splits "scene description" (cheap) from "GPU resources" (persistent). X-GIS's per-frame layer/draw construction is the same problem; a stable `id`-keyed diff is the principled fix for the "recreate vs reuse GPU buffer" churn the memory notes flag repeatedly. |
| 2 | **Formal Layer lifecycle: init/shouldUpdate/update/draw/pick/finalize** (deck.gl) | ✅ **Adopt** | This is the contract that makes #1 safe and makes resource ownership explicit. `finalizeState` (framework destroys resources on removal) is the answer to leaks. X-GIS's god-files (vtr 5298, render-loop history) are exactly what a per-layer lifecycle decomposes. |
| 3 | **Per-attribute invalidation + `dataRange` partial buffer updates** (deck.gl AttributeManager) | ✅ **Adopt** | Directly addresses the invalidation-granularity work in flight. Re-uploading whole tile buffers on a small change is the kind of waste this eliminates. WebGPU `queue.writeBuffer` supports sub-range writes, so the mechanism ports cleanly. |
| 4 | **`updateTriggers` cost discipline: constants/uniforms cheap, accessors expensive, binary bypasses CPU** (deck.gl) | ✅ **Adopt** | Map data is large; pre-packed/binary attributes and uniform-driven animation (vs per-vertex CPU work) is exactly how X-GIS should drive dash animation, color ramps, zoom-interp. Aligns with the existing "animate via uniforms, not per-vertex" memory notes. |
| 5 | **`visible` toggle instead of remove/re-add to hide a layer** (deck.gl) | ✅ **Adopt** | Cheap, avoids GPU-resource regeneration. Trivially applicable to layer/source visibility in a map style. |
| 6 | **Picking = the same draw pipeline re-parameterized into an off-screen buffer** (deck.gl) | ⚠️ **Adapt** | The *architecture* transfers (one pipeline, picking uniforms, id-encoded target) and is cleaner than a separate pick path. But the memory notes record a real X-GIS picking channel-swap bug (#152) — adopting deck.gl's "single pipeline, picking variant" discipline would have prevented divergence between render and pick. Adapt the structure; X-GIS's encoding stays its own. |
| 7 | **Demand-render with an explicit invalidate flag + RAF coalescing** (three.js / r3f) | ✅ **Adopt (already partially have it)** | X-GIS already runs `_needsRender`. three.js validates the approach for map viewers AND documents the exact failure modes: damping loops, async-load staleness. Adopt the **`requestRenderIfNotRequested` coalescing flag** discipline verbatim. |
| 8 | **"Every async arrival must re-invalidate" rule** (three.js texture-load footgun) | ✅ **Adopt as an invariant** | This *is* the X-GIS glyph-PBF / tile-landed bug class (task 1.2 "re-arm `_needsRender`"). Make it a structural rule: every tile-decode/glyph-atlas/sprite/data-load completion handler ends by arming the render flag. Add a test that fails if an async producer lands without invalidation. |
| 9 | **luma.gl: WebGPU-first Device → Buffer/Texture/Pipeline/Pass; WebGL2 emulated under WebGPU shape** (luma.gl) | ✅ **Adopt as blueprint** | X-GIS is WebGPU-native, so this is even cleaner — no WebGL2 legacy to bend around. The *layering* (Core device/passes → shader composition → engine `Model`) and Device-centric creation are a ready-made structure for X-GIS's GPU layer. |
| 10 | **Immutable textures + `AsyncTexture` wrapper + explicit `destroy()`** (luma.gl) | ✅ **Adopt** | Matches WebGPU's immutable-descriptor reality. `AsyncTexture` is the ergonomic answer to "tile image arrives later," and pairs with #8 (arrival → invalidate). Explicit `destroy()` owned by the *lifecycle* (not the caller) avoids three.js's leak trap. |
| 11 | **three.js manual caller-driven `dispose()` (remove ≠ free)** (three.js) | ❌ **Reject** | The cautionary tale. Pushing GPU-resource freeing onto callers caused a decade of leaks. X-GIS should own lifetimes via the layer lifecycle (#2) + `finalizeState`-style framework teardown + reference counting for shared atlases — never "the app must remember to dispose." |
| 12 | **three.js mutable global scene-graph as the source of truth** (three.js) | ❌ **Reject (prefer deck.gl's reactive model)** | A retained mutable scene graph (`scene.add/remove`, in-place mutation) is what makes three.js demand-render and disposal fragile (props mutate without the framework knowing → stale frame / leak). The deck.gl reactive recompute-and-diff model (#1) is the better fit for a *style-driven* map where the scene is a function of (style, viewport, data). |

### Anti-patterns these engines deliberately avoid (and X-GIS should too)

- **deck.gl avoids per-frame GPU mutation.** It diffs cheap descriptors and only touches GPU state on a real change — *never* rebuilds buffers every frame. [deck.gl using-layers](https://deck.gl/docs/developer-guide/using-layers)
- **deck.gl avoids full-buffer reupload for partial data changes** via per-attribute invalidation + `dataRange`. [deck.gl performance](https://deck.gl/docs/developer-guide/performance)
- **deck.gl avoids destroy-to-hide**; uses `visible`. [deck.gl performance](https://deck.gl/docs/developer-guide/performance)
- **three.js avoids a continuous RAF loop for non-game/static scenes** (demand-render for battery/thermals). [three.js rendering-on-demand](https://threejs.org/manual/en/rendering-on-demand.html)
- **luma.gl avoids designing for WebGL2 and porting up**; it designs for WebGPU and emulates WebGL2 underneath, accepting breaking changes rather than locking into the older model. [luma.gl webgpu-vs-webgl](https://luma.gl/docs/api-guide/background/webgpu-vs-webgl)
- **Both avoid a god-renderer**: deck.gl via composite→primitive layer decomposition + per-layer lifecycle; luma.gl via the Core/Shader/Engine layering. The direct contrast with X-GIS's flagged god-files (vtr 5298 LOC) makes this the most architecturally pointed lesson.

### Where transfer is genuinely limited (be skeptical)

- **three.js's retained scene graph** is a *worse* fit than deck.gl's reactive model for a style-driven map; don't import its mutation-centric ergonomics just because it's popular. Its main positive contribution to X-GIS is the **demand-render footgun catalogue**, not its architecture.
- **deck.gl assumes a host map (or its own `Deck`) owns the camera/projection.** X-GIS owns its own projection table + ECEF pipeline; deck.gl's `@deck.gl/geo-layers` projection assumptions do not transfer — only the *layer/attribute/lifecycle* machinery does, not its geospatial-math choices.
- **The reactive "recreate everything every change" model assumes shallow-compare-friendly props.** X-GIS's large binary tile buffers must follow deck.gl's own escape hatch (binary attributes + explicit `updateTriggers`), or the shallow-compare model will either over- or under-invalidate (the §1.5 footgun). Adopt the model *with* its documented binary-data discipline, not the naive form.

---

## 4. Concrete recommendations for the 5-year decision

1. **Make "layer as cheap descriptor + `id`-keyed diff + persistent GPU `state` moved forward" the core rendering contract.** This is the deck.gl model and it is the right backbone for a style-driven WebGPU map. It directly attacks the recurring "recreate vs reuse buffer" churn in the memory log. [deck.gl using-layers](https://deck.gl/docs/developer-guide/using-layers)
2. **Define a formal per-layer lifecycle** (`initialize/shouldUpdate/update/draw/pick/finalize`) and make the **framework own resource teardown** in `finalize`. Never adopt three.js's caller-driven `dispose()`. This is the decomposition path out of the god-files. [deck.gl layer-lifecycle](https://deck.gl/docs/developer-guide/custom-layers/layer-lifecycle), [three.js how-to-dispose](https://threejs.org/manual/en/how-to-dispose-of-objects.html)
3. **Build an AttributeManager-equivalent** with per-attribute invalidation, `dataRange` partial `writeBuffer`, `updateTriggers`, and a binary/pre-packed fast path. This is the principled fix for invalidation granularity. [deck.gl attribute-management](https://deck.gl/docs/developer-guide/custom-layers/attribute-management), [deck.gl performance](https://deck.gl/docs/developer-guide/performance)
4. **Codify the demand-render invariant**: a single coalescing render flag (three.js `requestRenderIfNotRequested` pattern), and *every* async producer (tile decode, glyph atlas, sprite, data load) MUST arm it on completion. Add a regression test for the "async lands without invalidation → dropped frame" class (the glyph-PBF / tile-landed bugs). [three.js rendering-on-demand](https://threejs.org/manual/en/rendering-on-demand.html)
5. **Model the GPU layer on luma.gl's shape** — Device-centric creation, immutable textures + an `AsyncTexture`-style wrapper for late-arriving tile imagery, explicit lifecycle-owned `destroy()`, WebGPU-native (X-GIS has the luxury of *no* WebGL2 legacy to emulate). [luma.gl api-guide](https://luma.gl/docs/api-guide), [luma.gl whats-new](https://github.com/visgl/luma.gl/blob/master/docs/whats-new.md)

---

## Sources

- deck.gl — Using Layers (reactive model): https://deck.gl/docs/developer-guide/using-layers
- deck.gl — Layer Lifecycle: https://deck.gl/docs/developer-guide/custom-layers/layer-lifecycle
- deck.gl — Layer Lifecycle (source md): https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/custom-layers/layer-lifecycle.md
- deck.gl — Primitive Layers: https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/custom-layers/primitive-layers.md
- deck.gl — Attribute Management: https://deck.gl/docs/developer-guide/custom-layers/attribute-management
- deck.gl — AttributeManager API (dataRange): https://github.com/visgl/deck.gl/blob/master/docs/api-reference/core/attribute-manager.md
- deck.gl — Performance Optimization: https://deck.gl/docs/developer-guide/performance
- deck.gl — Performance (source md): https://github.com/visgl/deck.gl/blob/master/docs/developer-guide/performance.md
- deck.gl — FAQ (descriptors vs DOM analogy): https://github.com/visgl/deck.gl/blob/master/docs/faq.md
- luma.gl — API Guide / Overview: https://luma.gl/docs/api-guide
- luma.gl — Overview: https://luma.gl/docs
- luma.gl — What's New (immutable Texture, AsyncTexture, destroy): https://github.com/visgl/luma.gl/blob/master/docs/whats-new.md
- luma.gl — WebGPU vs WebGL: https://luma.gl/docs/api-guide/background/webgpu-vs-webgl
- three.js — Rendering on Demand: https://threejs.org/manual/en/rendering-on-demand.html
- three.js — How to Dispose of Objects: https://threejs.org/manual/en/how-to-dispose-of-objects.html
- three.js — Material.dispose docs: https://threejs.org/docs/#api/en/materials/Material.dispose
- three.js — leak issue #12447: https://github.com/mrdoob/three.js/issues/12447
- three.js forum — Load events for Texture: https://discourse.threejs.org/t/load-events-for-texture/38533
- three.js forum — When to dispose / clean up a scene: https://discourse.threejs.org/t/when-to-dispose-how-to-completely-clean-up-a-three-js-scene/1549
- three.js forum — Tween with on-demand rendering: https://discourse.threejs.org/t/how-do-i-render-a-tween-animation-using-on-demand-rendering-instead-of-a-render-loop/19868
- react-three-fiber — Scaling performance (frameloop=demand, invalidate): https://r3f.docs.pmnd.rs/advanced/scaling-performance
- react-three-fiber — Rendering only when needed: https://gracious-keller-98ef35.netlify.app/docs/recipes/rendering-only-when-needed/
