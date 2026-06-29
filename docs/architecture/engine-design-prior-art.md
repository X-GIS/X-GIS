# @xgis/engine — prior-art benchmark & design re-adjudication

> Companion to [`render-graph-pass-scheduler.md`](./render-graph-pass-scheduler.md) (the design under
> review) and [`engine-content-split.md`](./engine-content-split.md) (the charter). This doc
> benchmarks the proposed `@xgis/engine` (RHI + render-graph/pass-scheduler + content boundary +
> shader IR) against six real engines and **re-adjudicates the one open architectural question** —
> flat ordered pass list vs topological frame-graph DAG — with sourced evidence.
>
> **Scope of this doc:** prior-art synthesis + concrete revision recommendations. It lands **no
> code**. It promotes the §9#1 "open question" in the design doc to a **decided choice** and lists the
> exact edits that decision justifies (§7 below).
>
> **Sourcing discipline (per the project's "ground every claim" rule).** Every architectural claim
> carries a `[confidence — source]` tag. Sources are the engine's own docs (Unreal RDG, Unity
> RenderGraph, Godot internal-rendering, three.js Backend/TSL, Filament FrameGraph, bgfx, wgpu-hal)
> and the seminal talks (O'Donnell, *FrameGraph: Extensible Rendering Architecture in Frostbite*, GDC
> 2017). Where a claim rests on **general WebGPU/platform knowledge** not confirmable from an
> engine doc, it is marked **[GENERAL KNOWLEDGE]** explicitly and is NOT presented as engine-sourced
> fact. The WebGPU-sandbox premises that drive the central verdict (no app-placed heaps, no
> app-recorded barriers, single queue) are of this kind and are flagged every time they are load-bearing.

---

## 1. Comparative matrix

Six engines × six axes. One terse, sourced cell each. `Conf` = confidence (H/M/L). The two right-hand
columns are the load-bearing comparators for X-GIS: **three.js+TSL** (the only *same-shape* peer — a
web, 2-backend, WebGPU-default/WebGL2-fallback renderer with a node-graph shader IR) and **bgfx+wgpu**
(the two mature RHI poles X-GIS's `rhi.ts` sits between).

### 1.1 RHI abstraction shape

| Engine | Shape | Conf — source |
|---|---|---|
| **Unreal RDG/RHI** | Two layers: `FDynamicRHI` (per-backend device, ref-counted opaque handles) **+** deferred `FRHICommandList` (queue of `FRHICommand` structs translated on a separate **RHI thread**). Recording decoupled from submission for parallelism. | H — UE5.8 RHI docs + Parallel Rendering Overview |
| **Unity SRP** | Native C++ `GfxDevice` (not exposed to C# at all) under backend-neutral handles (`CommandBuffer`/`RTHandle`). Recording surface **split by pass kind**: `RasterGraphContext` / `ComputeGraphContext` + an `AddUnsafePass` escape hatch. | H — DeepWiki RenderGraph + render-graph-write/unsafe-pass docs |
| **Godot 4 RD** | Three layers: `RenderingServer` (content) → `RenderingDevice` (a Vulkan-flavoured RHI **"at a similar level of abstraction to WebGPU"**) → `RenderingDeviceDriver` (per-backend). Resources are RIDs, freed manually. GL is a **separate renderer outside RD entirely**. | H — internal_rendering_architecture; class_RenderingDevice |
| **three.js (common)** | Abstract `Backend` subclassed by `WebGPUBackend`/`WebGLBackend`. Backend **owns the backend-side GPU objects** (`create*/update*/destroy*`) but makes **no scheduling/ordering decisions**: `Renderer` decides what/order/bindings; Backend only translates `create*/update*/draw/compute/copy`. Per-pass state in a `RenderContext` passed through, not backend globals. | H — Backend.html.md (verbatim) |
| **Frostbite/Filament FG** | A frame-graph is **not** an RHI — it sits one layer above and *assumes* an RHI (typed transient creation from a descriptor, explicit state transitions, placed/heap resources for aliasing). Filament's FG sits on its `backend` driver. | H — O'Donnell GDC2017; DeepWiki/google/filament |
| **bgfx + wgpu** | Two poles. **bgfx**: opaque `uint16` handles, internal barrier/state tracking, `uint64` packed render state. **wgpu-hal**: per-backend `Api` trait + object-safe `Dyn*` family; caller **must record explicit barriers** (`transition_buffers/textures`). | H — bgfx.html; wgpu-hal lib.rs |
| **→ X-GIS `rhi.ts`** | Mirrors **WebGPU** = *above* the barrier layer (auto barriers, never in the surface), branded opaque handles, semantic usage strings. = wgpu-hal's `Dyn*` layer **without** the typed `Api` layer. Correct altitude for 2 backends. | H — read of rhi.ts:16-313 + the two HAL docs |

### 1.2 Render-graph model — flat list vs DAG

| Engine | Model | Conf — source |
|---|---|---|
| **Unreal RDG** | **True topological DAG.** Passes declare resource roles via shader-parameter structs; compiler auto-derives edges/barriers/lifetimes, culls, overlaps async-compute. Setup→Compile→Execute. | H — UE5.8 RDG docs |
| **Unity RenderGraph** | **Explicit DAG**, but **executes surviving passes in declaration order** — compiler only culls + merges + aliases. Imperative path is now "Compatibility Mode", **being removed**. | H — render-graph-fundamentals; compatibility-mode manual |
| **Godot RD** | Renderer authors a **flat imperative stream**; `RenderingDeviceGraph` sits *underneath* as an auto resource-dependency tracker that topo-sorts into parallel "levels" + inserts barriers. **60–80% fewer barriers.** Migrated *off* the prior hand-barrier model. | H — godotengine.org acyclic-graph article + PR #84976 |
| **three.js** | **No frame-graph.** Main render = sorted opaque/transmissive/transparent buckets + `renderOrder`. Post-processing = a coarse hand-wired pass-output node graph — no barriers, no aliasing, no culling. | H — WebGLRenderLists; TSL pass/MRT docs |
| **Frostbite/Filament** | The canonical 3-phase DAG (setup/compile/execute) with cull-by-refcount, topo-sort, lifetime+aliasing, barrier derivation, async-compute levels. Overkill for a **fixed ~3-4-pass pipeline**; pays off as the pass set **grows/changes** (no fixed numeric break-even in source). | H — O'Donnell GDC2017; DeepSpark (fixed 3-4 = wasted complexity); themaister.net (aliasing payoff = VRAM/barrier cost, no pass count) |
| **bgfx** | **No frame-graph.** Numbered `ViewId`s (target+clear+sort), `setViewOrder` reorder array, per-draw sortkey. Shipped flat for **10+ years**. | H — bgfx.html setView* |
| **→ X-GIS** | Flat ordered `PassDef[]` + declared `PassIo` roles. **Richer than bgfx/three.js** (they declare no reads/writes), **simpler than RDG/Unity** (no compiler). The decision under review (§3). | H — render-graph-pass-scheduler.md §3 |

### 1.3 Resource lifetime / aliasing

| Engine | Model | Conf — source |
|---|---|---|
| **Unreal RDG** | 3 classes: **transient** (graph-owned, lifetime-confined, aliased via a transient allocator — DX12-era ~50% save), **imported** (tracked, **never aliased** even when lifetime is known — self-acknowledged limit), **pooled** (cross-frame `FRDGPool` fallback). | H — UE RDG docs; M — staticJPL on 50% |
| **Unity** | Transient (no cross-frame persistence; allocated before first write, freed after last read, **memory reused/aliased**), imported (backbuffer/history, never aliased), persistent (imported each frame). Headline: "allocate for actual frame, not worst case." | H — render-graph-benefits/fundamentals |
| **Godot** | RD = manual `free_rid`, no pooling. Pooling lives one layer up in `RenderSceneBuffersRD.create_texture(name,…)` = **named, lazily-allocated, viewport-scoped textures cached by string**, rebuilt only on config (size/MSAA) change. **Transient aliasing still future work.** | H — RenderSceneBuffersRD docs + acyclic-graph article |
| **three.js** | Per-object GPU state cached by JS object (WeakMap), version-invalidated, lazily created, destroyed on dispose/GC. **No transient aliasing**; post-processing pools intermediates ad hoc. | M-H — Backend create/update/destroy + general common/ knowledge |
| **Frostbite/Filament** | RAISON D'ÊTRE: transient (devirtualized just-in-time, aliased on non-overlapping lifetime, ~40-50% VRAM), imported (`fg.import`, never allocated/freed), swapchain (cull anchor). Aliasing is a memory/throughput **tradeoff, not free** — can *increase* barriers. | H — O'Donnell; themaister.net; DeepWiki |
| **bgfx + wgpu** | bgfx: caller-explicit destroy, **engine defers free until GPU retires the frame** (double/triple-buffer); `allocTransient*` scratch. wgpu-hal: explicit + **fence-gated** — `submit` TAKES a caller-owned `signal_fence: (&mut Fence, FenceValue)`; public `Queue::submit` returns a `SubmissionIndex` for later `poll`/`on_submitted_work_done`. Per-frame `acquire_texture`. | H — bgfx model; wgpu-hal lib.rs Queue::submit |
| **→ X-GIS** | `GPUArena` (byte-aware eviction) + uniform ring + a named-transient `TransientTarget` (pooled). = Godot's named-pooled tier. **Lacks** transient aliasing (correctly — §3) and **lacks a destroy + completion-fence in the RHI itself** (§4 gap). | H — read of rhi.ts + project memory |

### 1.4 Pass dependency declaration

| Engine | Mechanism | Conf — source |
|---|---|---|
| **Unreal RDG** | Typed shader-parameter struct members (`SHADER_PARAMETER_RDG_TEXTURE/_SRV/_UAV`, `RENDER_TARGET_BINDING_SLOTS`). Compiler reads byte offsets/types via `FShaderParametersMetadata`. **Same struct binds the shader AND declares graph access** (unified). | H — UE RDG docs |
| **Unity** | Builder calls `UseTexture/UseBuffer/UseRendererList/SetRenderAttachment`. Dependency direction (RAW/WAR) via **handle versioning** (index<<16 \| version; version++ on write). | H — DeepWiki |
| **Godot** | **Nothing declared by the author** — the graph *observes* per-resource last-write/all-prior-reads as the flat command stream is logged; **texture layout change counts as a write-like dep**. | H — acyclic-graph article |
| **three.js** | No formal reads/writes. Post-processing wires output texture node → input node by hand. | H — TSL docs |
| **Frostbite/Filament** | `builder.create/read/write` in a setup lambda run at build time; **write mints a new resource version** so RAW edges fall out automatically. Execute lambda stored, not run. | H — O'Donnell; Filament DependencyGraph |
| **bgfx** | None — view target+clear+sort only; order is the `setViewOrder` array. | H — bgfx.html |
| **→ X-GIS** | Declared `PassIo`: `colorDomain`, `clearsColor`, `clearsDepthStencilPick`, `readsDepth/writesDepth`, `resolve` (3-state), `creates/reads/writes` named transients. **Declared metadata, asserted not consumed in Phase A.** | H — render-graph-pass-scheduler.md §3.2 |

### 1.5 Content/engine boundary (register/inject mechanism)

| Engine | Mechanism | Conf — source |
|---|---|---|
| **Unreal RDG** | `GraphBuilder.AddPass(params, lambda)` — engine learns DECLARED roles in the param struct, stores the draw lambda opaque. RenderCore never imports content. Boundary enforced at **runtime** (`GetRHI()` outside a declaring lambda asserts). | H — UE RDG docs |
| **Unity** | `ScriptableRendererFeature.AddRenderPasses → EnqueuePass(ScriptableRenderPass)`; the pass's `RecordRenderGraph` declares resources. Enforced by **package layering** — `core` never depends on URP/HDRP. | H — render-graph-write-render-pass; package structure |
| **Godot** | `CompositorEffect` subclass + `effect_callback_type` (stage key) + `_render_callback(type, render_data)`. Docs frame it explicitly as **dependency injection**. Caveat: callback runs **on the render thread → must self-synchronize**. | H — compositor.html |
| **three.js** | `NodeLibrary` (engine-owned, **content-populated** class→node lookup; swap via `renderer.library`). Engine processes only `Node` + abstract `Material`; never imports a concrete material. **No projection DI** — coordinate system is backend-baked (a leak X-GIS must NOT copy). | H — StandardNodeLibrary/Renderer.library docs |
| **Frostbite/Filament** | Inherently content-blind: opaque execute closures + `fg.import` for externals + generic `FrameGraphId<T>` handles. Zero import edges into content. | H — DeepWiki/google/filament |
| **bgfx + wgpu** | The **gold standard**: "bring your own engine" — knows handles/programs/views, zero scene concept. Neither owns the render loop, so neither even needs a register surface (the app feeds handles in). | H — bgfx/wgpu API shape |
| **→ X-GIS** | `configureProjections` (data push, throws if read before set) + `registerRenderer(RendererDef)` + `registerPass(PassDef)`. **Because the scheduler lives INSIDE the engine** (unlike bgfx/wgpu), X-GIS *must* add the inversion surface to match bgfx's blindness. Enforced at **build time** (arch-ratchet, import-count == 0) — surpasses UE/Godot's runtime asserts. | H — render-graph-pass-scheduler.md §5, §8.5 |

### 1.6 Shader IR abstraction

| Engine | Model | Conf — source |
|---|---|---|
| **Unreal** | USF/USH (HLSL superset) cross-compiled per backend (DXC + ShaderConductor → SPIR-V/MSL/DXIL). **Unifies** shader-binding reflection with the RDG dependency metadata (one parameter struct). | H — RDG docs name FShaderParametersMetadata; M — toolchain naming |
| **Unity** | HLSL in ShaderLab cross-compiled per backend (HLSLcc), OR node-based ShaderGraph (emits HLSL). **No single neutral IR** at the RenderGraph layer; the graph is shader-agnostic. | H — agnostic graph; M — cross-compiler internals |
| **Godot** | **SPIR-V is the neutral IR** (binary standard), reflected at runtime for uniform-set layouts; cross-compiled to MSL/DXIL by the driver. | H — class_RenderingDevice (shader_create_from_spirv + reflection) |
| **three.js TSL** | `NodeBuilder` base + `WGSLNodeBuilder`/`GLSLNodeBuilder` emitters — **one node graph → WGSL or GLSL ES**. Automatic **common-subexpression elimination** (positionWorld computed once). **`CodeNode` raw-shader escape hatch** (language:'wgsl'\|'glsl'). | H — docs/TSL.md |
| **Frostbite/Filament** | Out of scope for the frame-graph — graph schedules passes, shaders live in the pass's execute lambda + a separate material compiler (`matc`). **Orthogonal layers.** | H — DeepWiki |
| **bgfx + wgpu** | bgfx: offline `shaderc` → per-backend bytecode, named uniforms, no graph. wgpu: **WGSL is the portable source-of-truth; `naga` validates/reflects/translates** WGSL↔SPIR-V↔MSL↔GLSL. | H — bgfx; H model / M naga API |
| **→ X-GIS `@xgis/shader-dsl`** | TS DSL → emits **WGSL + GLSL** at build time; bind-layout/uniform-slot via `reflect()` (`polygonUniformSlots()` SoT, never hand-packed). = TSL's `NodeBuilder`+per-backend-emitter shape, = wgpu's naga-analogue single-source reflection. | H — render-graph-pass-scheduler.md §6.1; project memory |

---

## 2. Durable patterns — the decisions that lasted, for a 5-year library

These are the patterns that **independently recurred** across ≥3 of the six engines and survived
multiple major versions. For a 5-year library these are **load-bearing**: treat them as constraints,
not options. Each is tagged with where X-GIS already complies (✓), partially complies (~), or has a
gap (✗).

1. **Declare resource access; never hand-author barriers or edges.** RDG, Unity, Godot, and Frostbite
   all converged on *passes declare what they read/write* and the engine derives transitions/ordering.
   The declaration is the durable asset; the scheduler that consumes it is replaceable. `[H — RDG +
   Unity + Godot + O'Donnell, four independent convergences]`
   **X-GIS: ~** — `PassIo` declares roles, but in Phase A they are *asserted, not consumed* (the
   bodies still self-compute resolve/depth). The durable requirement is that they become the **single
   source of truth** at Phase B and are never bypassed thereafter.

2. **Separate DECLARATION from SCHEDULING/EXECUTION.** RDG's setup→compile→execute, Unity's
   `RecordRenderGraph` vs `SetRenderFunc`, Frostbite's stored execute lambda. This is what lets you
   keep author-ordered submission while a later phase culls/merges/reorders. `[H — O'Donnell + Unity +
   RDG]`
   **X-GIS: ✓** (by design) — the §3.3 `preFrame/runPasses/postFrame` split and the §7.1 Phase-A vs
   Phase-B distinction are exactly this. Keep the **record-vs-execute** discipline (lesson 3).

3. **Execute bodies are side-effect-free command-recording only — no captured mutable state.** Unity
   *directs* (strongly recommends, not hard-enforced) `static` lambdas in `SetRenderFunc` and routes all
   data through an explicit `PassData` struct, precisely because captured references break under
   deferred/reordered execution (captured GC allocations are warned against). RDG/Filament
   stored lambdas are pure recorders. `[H — Unity static-lambda mandate; O'Donnell]`
   **X-GIS: ✗ (latent)** — pass bodies today reach content off `SceneView` and read mutable
   `MapRenderer` state. The §4 `RenderNode` inversion must **forbid the execute closure from capturing
   renderer state**; otherwise the moment any reorder/cull is added, Unity's stale-data bug class
   returns. **Add this as an explicit rule in the design doc** (§7 revision R7).

4. **Virtual/handle resources until execute; never bind real GPU objects at registration.** RDG
   `FRDGTextureRef`, Unity versioned `TextureHandle`, Filament `FrameGraphId<T>`. The indirection is
   what enables culling/aliasing/parallel recording later. `[H — RDG + Unity + Filament]`
   **X-GIS: ~** — `TransientTarget` is named/opaque (good), but `SceneView` carries **live
   `GPURenderPipeline` handles** (§4.5) — a real-object leak that blocks future reordering. Option A
   (§4.5) closes it.

5. **Content plugs in via an engine-owned, content-populated registry/lambda + reflected metadata —
   one-way dependency, enforced structurally.** Unity package layering, three.js `NodeLibrary`, RDG
   AddPass, Godot CompositorEffect, Filament closures. The engine introspects a declared descriptor;
   it never imports content semantics. `[H — all six]`
   **X-GIS: ~→✓** — `registerProjection/Renderer/Pass` is the correct shape and X-GIS goes **further
   than every reference** by enforcing zero-import at **build time** (arch-ratchet §8.5) rather than
   UE/Godot's runtime asserts. The gap is the three residual channels (§5).

6. **Keep a debuggable LINEAR fallback ("turn the magic off").** RDG ImmediateMode / `r.RHICmdBypass`;
   bgfx is inherently linear; Godot can disable transient resources. Any scheduler must be bisectable.
   `[H — UE docs; bgfx]`
   **X-GIS: ✓ (free)** — the flat list **is** the linear mode. This is a genuine advantage of starting
   flat: X-GIS never has to *build* an immediate-mode escape hatch. Plus the `?forcegl2` backend pin
   (three.js `forceWebGL` precedent) for parity bisection. `[H — WebGPURenderer~Options]`

7. **One backend-neutral shader IR + N hand-written emitters; quarantine per-backend knowledge to the
   emitter; ship a raw-shader escape hatch.** TSL `NodeBuilder`→WGSL/GLSL with `CodeNode`; wgpu naga;
   Godot SPIR-V. The twin-emitter maintenance tax is the **accepted, unavoidable price** of true
   backend neutrality — there is no shortcut. `[H — TSL; wgpu; three.js confirms the tax]`
   **X-GIS: ~** — `@xgis/shader-dsl` is the right shape; the gaps are an **explicit `CodeNode`-style
   escape hatch** and a **guaranteed CSE property** (§6).

8. **Reflection is the single authority for bind/uniform layout — never hand-maintained.** wgpu naga,
   Godot SPIR-V reflection, RDG parameter-struct reflection. The device pipeline can never drift from
   the shader. `[H — wgpu; Godot; RDG]`
   **X-GIS: ✓** — `polygonUniformSlots()` is already the reflected SoT (§6.1); the 256-byte narrative is
   stale. Keep every layout IR-derived.

9. **A first-class, queryable CAPABILITIES struct — fail-close on DATA, not on a backend name.** bgfx
   exposes ~40 `BGFX_CAPS_*` bools; wgpu `hasFeature`; three.js `Backend.hasFeature/hasCompatibility`.
   gate the **device-runtime-variable** caps on data. `[H — bgfx; three.js; wgpu]`
   **X-GIS: ~** — `rhi.ts` has a typed `backend` union (correct for the 2 **static** backend facts, e.g.
   WebGL2-never-has-compute); only one site string-matches it (`gpu.ts:353`). The targeted add is a
   small `RhiCaps` for the genuinely runtime-variable caps only (float-renderable, max sizes, timestamp)
   — NOT bgfx's 40-cap matrix (§4 G1). Right-sized, not "highest-value".

10. **The content-blind seam is a REWRITE, not a refactor — and the two-stacks-coexist period is real.**
    three.js could not retrofit `Backend` onto legacy `WebGLRenderer`; it built a parallel stack and
    still ships both. Unity is *deleting* its imperative path and forced a downstream pass rewrite.
    `[H — three.js two-renderer; Unity compatibility-mode]`
    **X-GIS: ✓ (right call)** — carving `@xgis/engine` cleanly (vs bolting an RHI onto the monolith) is
    correct, but **budget for the coexistence period** and get the `PassIo`/`RenderNode` contract right
    *early* (Unity's migration cost is the cautionary tale).

---

## 3. THE DECISION — flat ordered list vs frame-graph DAG (re-adjudicated)

The design doc (§3, §9#1) chose **flat + declared roles** and deferred the DAG as an open question.
**This benchmark study promotes that to a decided choice and sharpens it.**

### Verdict

> **(a) KEEP the flat ordered `PassDef[]` with declared `PassIo` roles for v1 — but harden the
> declarations so the model is a STRICT SUPERSET of what a future DAG would consume, and add the ONE
> graph benefit reachable cheaply on WebGPU: reorder-safety by edge-validation.**
>
> This is option (a) executed to the standard of option (c)'s end-state — *flat now, non-breaking
> graph-compilable later* — **without building any compiler now**. Reject option (b) (a minimal
> frame-graph with an aliasing/barrier compile pass) for v1: its two headline outputs are unreachable
> or already-free on X-GIS's platform.

### Why — the evidence, weighted

**The most load-bearing comparator agrees: three.js.** The single closest peer — a production,
multi-year, 2-backend (WebGPU+WebGL2) **web** renderer with a node-graph shader IR — ships **no
frame-graph at all**: sorted buckets for the main render, a hand-wired pass-output graph for
post-processing, and *no* declared reads/writes anywhere. `[H — WebGLRenderLists; TSL pass docs]`
X-GIS's flat list **with** declared `PassIo` roles is therefore **strictly more structured than
three.js**, not a shortcut. If the closest-shaped engine in the industry never needed the DAG, the
burden of proof is on adding one — and CLAUDE.md §2 ("no speculative flexibility / no configurability
that wasn't requested") puts a thumb firmly on that scale.

**bgfx independently confirms durability.** A cross-backend rendering library shipped a flat,
numbered-view scheduler (target+clear+sort, explicit reorder array) for **10+ years** with no DAG,
no transient aliasing, no declared read/write graph. `[H — bgfx.html]` Two mature, shipping,
content-blind renderers (three.js, bgfx) prove the flat model is a *durable* 5-year architecture, not
a corner cut.

**The DAG engines win on problems X-GIS does not have.** RDG, Unity, Frostbite, Filament all adopt a
DAG — but the sourced condition is a **growing/changing pass set** with **explicit-API heaps** and
**async compute queues** `[H — DeepSpark: a fixed 3-4-pass pipeline is "wasted complexity"; themaister.net:
aliasing "matters MOST for async compute, cross-frame deps, memory-constrained heavy-transient
scenarios" — no numeric pass-count break-even is given in either source]`. X-GIS has a **fixed
~8-bucket set**, **single-queue**
WebGPU/WebGL2, and **no app-placed heaps**. The two headline DAG payoffs are therefore unreachable or
free:
- **Transient memory aliasing (~40-50% VRAM):** requires app-controlled placed/heap resources (D3D12
  placed resources / Vulkan heaps). **WebGPU and WebGL2 expose neither** `[GENERAL KNOWLEDGE — not
  from a frame-graph source; flagged]`. The most X-GIS can do is **pool** same-descriptor textures
  across non-overlapping passes (Godot's named-pool model, §1.3), which the flat `creates/reads/writes`
  vocabulary already enables. Building an aliasing compiler would harvest savings the platform
  withholds. Note Godot, a mature engine on Vulkan/D3D12 *with* heaps, **still hasn't shipped transient
  aliasing** `[H — acyclic-graph article lists it as future work]` — strong evidence to defer.
- **Minimal-barrier scheduling (Godot's 60-80% win):** that win is *Vulkan-specific* — Godot's
  `RenderingDeviceGraph` sits **below** the barrier layer and inserts `vkCmdPipelineBarrier` itself.
  **WebGPU owns barriers/transitions internally** `[GENERAL KNOWLEDGE — flagged]`, so X-GIS's RHI sits
  **above** that layer (like three.js's Backend, unlike Godot's RD). The barrier-derivation that
  justifies Godot's graph is **already done for X-GIS by the platform, for free**. This is the single
  most important altitude distinction in this whole study: *Godot's headline lesson does not transfer,
  because X-GIS is not at Godot's altitude.*

**But the cautionary tales are real and must be honored.** Unity **migrated *away* from** the
flat/imperative model and is **deleting** it — its verdict was that the imperative path "does not
scale." `[H — compatibility-mode manual]` The crucial nuance: what Unity abandoned was a flat list
**with manual RT allocation and NO complete declared roles**. Unity even *executes in declaration
order anyway* `[H — render-graph-fundamentals]` — it only culls/merges/aliases from the declarations.
So Unity's lesson is **not** "you need a DAG"; it is **"a flat list is only safe if it carries
complete, honest, validated declarations."** Godot's lesson is parallel: it migrated off **manual
barrier masks + future-knowledge requirements**, not off flat *authoring* — the renderer still records
a flat stream. `[H — acyclic-graph article]`

**Synthesis: the danger is under-declaration, not flatness.** Every engine that abandoned a flat model
abandoned an *under-declared* one. X-GIS's flat list is safe **iff** the declarations are complete and
validated — which is exactly the design doc's own honest worry (§1.3: "in the additive phase `io` is
asserted, not consumed"). So the verdict's teeth are in **hardening the declarations**, not in adding
a scheduler.

### The one DAG benefit X-GIS should take now — reorder-safety by edge-validation

Frostbite/Filament's **resource versioning** (a write mints a new version; read-after-write edges fall
out automatically) `[H — O'Donnell; Filament]` yields one benefit reachable at **near-zero cost** on
WebGPU and worth taking: **a reordered `registerPass()` call cannot silently corrupt the frame.** A
flat array's correctness is "whatever order the array is in" — a git merge that reorders two
`registerPass` entries, or a content author inserting a bucket, can silently break clear-ownership or
the resolve barrier. The cheap fix is **not** a topological scheduler; it is **validating the declared
edges** against the registered order at startup (the design doc's §8.2 contract test is already 80% of
this) and at runtime asserting the resolve-barrier ordering (§3.2 step 4 already does this). Promote
this from "assert" to a **named invariant**: *the engine derives pass validity from declared `io`
edges, and refuses to run an order that violates them* — reorder-safety without a DAG.

### What this verdict is NOT

It is **not** a staged commitment to build a DAG "later." It is: *ship flat+roles; make the role
vocabulary complete enough that IF a fourth coupling ever appears that roles can't express, the
upgrade to a derived schedule is additive, not a content rewrite.* The trigger to revisit is concrete
and **measured**, not aspirational: (i) async-compute throughput becomes a profiled need (largely N/A
on single-queue WebGPU), or (ii) transient RT memory pressure becomes a measured problem, or (iii) a
coupling appears that `colorDomain/readsDepth/writesDepth/resolve/creates/reads/writes` genuinely
cannot encode. Until one of those is *measured*, CLAUDE.md §2 forbids the compiler.

---

## 4. RHI — is `rhi.ts` 5-year-stable? Concrete gaps

X-GIS sits at the **right altitude**: WebGPU-shaped, above the barrier layer — validated by Godot
("RD at a similar level of abstraction to WebGPU" `[H]`) and three.js (`Backend` mirrors WebGPU). The
contract is sound. Benchmarking against bgfx/wgpu/RDG/Godot surfaces a few primitives those mature
poles carry that `rhi.ts` lacks today — but **`rhi.ts`'s own charter is "deliberately minimal; grow it
ONLY as later primitives need … so it never becomes a speculative god"** (`rhi.ts:8-11`), and CLAUDE.md
§2 forbids speculative flexibility. So these are **anticipated extension points to record, NOT v1
freeze-blockers** — add each additively **when a concrete need is measured**, exactly as every prior RHI
primitive (dynamic offsets, vbuf sub-range, MRT, compute) was added story-by-story. The table below is
deliberately re-scoped from an earlier "settle before freeze" framing that contradicted X-GIS's own
grow-only discipline.

| # | Gap | Evidence it's load-bearing | Recommendation |
|---|---|---|---|
| **G1** | Content fail-closes by **string-matching the backend** (`backend:'webgpu'\|'webgl2'`). Note: only **one** production site does this (`gpu.ts:353`), and `backend`'s stated purpose is a TEST assertion (`rhi.ts:272-275`). | bgfx ships ~40 `BGFX_CAPS_*` — but bgfx spans an N-backend × N-GPU matrix; X-GIS knows its **2 backends at compile time**. `[H — bgfx; M — applicability]` | **Add a `RhiCaps` struct ONLY for genuinely device-runtime-variable caps** (`canRenderFloat`=EXT_color_buffer_float, `maxTextureSize`, `maxColorAttachments`, `hasTimestampQuery`). KEEP the typed `backend` union for a backend's **technique** choice (native compute vs fragment-GPGPU) — NOT as a feature gate. ⚠ Do NOT treat "WebGL2 has no compute/MRT" as a static fact: WebGL2 **has MRT** (`gl.drawBuffers`) and **implements compute** via fragment-GPGPU (feature-parity mandate, design §7.3). The backend union picks *how*, never *whether*. Do **not** cargo-cult bgfx's 40 caps. |
| **G2** | `RhiCommandEncoder.finish()` is fire-and-forget; no submit/completion token in the RHI (`rhi.ts:206-207,247-250,259-313`). | wgpu-hal `submit` signals a caller-owned fence; bgfx `frame()` returns a sync number. `[H]` | **Likely NOT needed.** X-GIS **already** does async GPU readback fence-free via WebGPU `buffer.mapAsync` (`interaction-controller.ts:166`, a ring hides latency) — the "first readback forces a breaking change" forcing-function **already occurred and did not break**. Re-scope to: expose `queue.onSubmittedWorkDone` through the RHI **only if** GPU-timer / arena-retirement later needs a submit-keyed signal. Not a freeze-blocker. |
| **G3** | No `destroy*`/free in the RHI; lifetime lives entirely in `GPUArena`. | bgfx **learned** to make destruction explicit-but-deferred (freed after the frame's GPU work retires). `[H]` | **Defer (additive when measured).** Works while everything is arena-pooled. Add explicit-but-DEFERRED `destroy*` **when a concrete non-arena resource must be freed** — documented extension point, not v1 work. |
| **G4** | Swapchain + encoder are OPTIONAL device methods that THROW on WebGL2 (`beginScreenPass?`/`endScreenPass?`/`createCommandEncoder?`, `rhi.ts:286-313`). | wgpu keeps `Surface` a **separate object** with `acquire_texture`. `[H]` | **The one worth doing earlier** (P1 already touches it): promote to a real `Surface`/swapchain resource so the lifecycle is not optional-throwing. Still additive — fold into the P1 RhiCommandEncoder flip, not a separate freeze gate. |

**Shapes X-GIS correctly does NOT need (rejections, with rationale):**

- **Caller-recorded barriers** (wgpu-hal `transition_*`): too low for a WebGPU mirror. WebGPU owns
  barriers. Keep them out of the surface. `[H — wgpu-hal; the right altitude]`
- **Deferred `FRHICommand` translation / RHI-thread** (Unreal): solves multi-queue native-API
  parallelism X-GIS does not have on single-threaded JS + single-queue WebGPU. `[H — UE docs +
  GENERAL KNOWLEDGE on WebGPU, flagged]`
- **Packed `uint64` render state** (bgfx `setState`): X-GIS's typed `RhiPipelineDesc` (named
  blend/depth/stencil/bias) is *more* maintainable/validatable over 5 years. Do **not** regress to bit-packing. `[H]`
- **Fixed-size scheduling identity** (bgfx's 256-`ViewId` cap): X-GIS's string buckets + numeric
  `order` correctly avoid it. `[M — bgfx ViewId]`

**Known future breaking point to document, not fix now:** mirroring WebGPU's automatic barriers
**boxes out async-compute/multi-queue overlap** — a compute prepass cannot overlap graphics on a
separate timeline, because WebGPU has no app barriers and no multi-queue. wgpu-hal exposes explicit
barriers *precisely* to allow that overlap. The day X-GIS wants async-compute throughput, the
automatic model can't express it without adding a barrier/timeline concept. This is a **platform
ceiling, not a flaw** — record it in §7.3 of the design doc as a deferred, N/A-on-WebGPU item.
`[H — wgpu-hal single-queue note + GENERAL KNOWLEDGE on WebGPU, flagged]`

**Verdict:** the `rhi.ts` *contract altitude* is 5-year-stable, and so is the *surface* — its
grow-only charter (`rhi.ts:8-11`) is itself the correct 5-year posture, vindicated by this study.
G1-G4 are **anticipated extension points, not freeze-blockers**: G1 scoped to runtime-variable caps
only (keep the typed backend union for static facts), G2 likely unneeded (readback already works
fence-free via `mapAsync`), G3 deferred until a non-arena free is measured, G4 folded into the P1
swapchain work. Record them as documented extension points so the first real need is a known additive
step — but do **not** pre-build them. This is the right-sizing the "5-year library" bar actually
demands: minimal-and-growable beats gold-plated-and-speculative (CLAUDE.md §2).

---

## 5. Content/engine boundary — confirm or improve the zero-coupling mechanism

**Confirmed: the `registerProjection/registerRenderer/registerPass` + DI shape is exactly how every
real engine keeps content out of core.** It is vindicated five times over:

- **Unity** `ScriptableRendererFeature.AddRenderPasses → EnqueuePass` + **package layering** (`core`
  never depends on URP/HDRP). `[H]`
- **three.js** `NodeLibrary` (engine-owned, content-populated, swappable class→node table). `[H]`
- **Godot** `CompositorEffect` stage-keyed callback, *explicitly documented as dependency injection*. `[H]`
- **Unreal** `AddPass`-lambda + reflected parameter struct. `[H]`
- **Filament/Frostbite** opaque execute closures + `fg.import` + generic `FrameGraphId<T>`. `[H]`

X-GIS's three register surfaces are the same family, and X-GIS **improves on all of them in one
respect**: it enforces zero-import at **build time** via an arch-ratchet (design §8.5, import-count
== 0), where UE and Godot enforce only at **runtime** (`GetRHI()` asserts; render-thread discipline).
That is the correct, stronger bet for a 5-year library. Keep it.

**Three improvements the prior art demands:**

1. **Specify the execution/threading contract of an injected pass — not just its resource roles.**
   Godot's CompositorEffect callback runs **on the render thread and must self-synchronize** (their
   own docs hand-roll a Mutex). `[H — compositor docs]` Unity **directs static lambdas** (strong
   recommendation, not enforced) with all data through an explicit `PassData` struct to prevent
   stale-reference bugs under deferred execution.
   `[H]` X-GIS's `registerPass`/`RenderNode` contract today specifies *what a pass touches* but not
   *when/in-what-context its execute runs and what it may capture*. **Add to the design doc:** the
   execute closure is a **pure command recorder that MUST NOT capture mutable renderer state**; all
   per-frame data arrives via `FrameContext` + `SceneView` + the resolved `RenderNode`. This is
   lesson 3 made into a contract clause. (Single-threaded JS makes the *threading* part trivial today,
   but the *no-capture* part is what keeps any future reorder/cull safe.)

2. **Close the three residual content channels — `PassHost` inversion alone is necessary-not-sufficient
   (the design doc is already honest about this; the prior art says don't defer it).** bgfx/wgpu prove
   content **never reaches back through engine frame state**: the engine sees only opaque handle/draw
   streams. `[H]` X-GIS's three leaks (design §1.3, §4.5, §8.5 table) — `MapRenderer` god-object,
   `SceneView`-carried `GPURenderPipeline` handles, and `FrameContext.{projType,centerLon,centerLat}`
   — are each a place content reaches back. **Recommendation, grounded in bgfx discipline:** adopt
   **Option A (§4.5)** for opaque/OIT (the dominant draws) as part of the §4 inversion, *not* "a
   separate task" — the engine should see only generic `DrawItem` streams (bgfx `submit` model), never
   a content-typed `GPURenderPipeline` off `SceneView`. Leaving it deferred risks the engine→content
   == 0 gate never actually reaching 0.

3. **Keep projection injected as an opaque token — do NOT copy three.js's backend-baked coordinate
   system.** three.js bakes coordinate convention into the Backend (`WebGLCoordinateSystem` vs
   `WebGPUCoordinateSystem`). `[H]` For a generic 3D engine that's fine; for a GIS renderer it would
   **leak projection (a content concern) into the engine** and break the shader-dsl-grade bar.
   X-GIS's `configureProjections` DI is a **stronger** content-blindness guarantee than three.js
   offers — and the design doc's §9#3 correctly flags that the *current* `FrameContext.{projType,
   centerLon,centerLat}` **degrees** violate this and must become an opaque token the engine never
   interprets. Confirmed: that is the right direction; raw degrees on `FrameContext` fail §8.5.

**Net:** the mechanism is correct and ahead of the field on enforcement. The work is *completing* it
(close the three channels, Option A) and *specifying the execute contract* (no-capture rule), not
redesigning it.

---

## 6. Shader IR — is a neutral IR emitting WGSL+GLSL the right 5-year bet?

**Yes — decisively, and the most load-bearing comparator (TSL) proves it.** A backend-neutral IR with
N hand-written emitters is the convergent answer across the field:

- **three.js TSL:** `NodeBuilder` base → `WGSLNodeBuilder`/`GLSLNodeBuilder` — **the exact shape**:
  one node graph → WGSL or GLSL ES, same source proven to emit both. `[H — docs/TSL.md]`
- **wgpu/naga:** WGSL source-of-truth, naga validates/reflects/translates to every backend. `[H model]`
- **Godot:** SPIR-V neutral IR + runtime reflection. `[H]`

X-GIS's `@xgis/shader-dsl` (TS DSL → WGSL+GLSL, `reflect()`-derived layouts) is squarely on this line.
The **twin-emitter maintenance tax** (every feature implemented twice, can silently diverge) is
**confirmed by three.js as the unavoidable, accepted price** of true backend neutrality — there is no
shortcut `[H — WGSL/GLSLNodeBuilder are separate classes]`. The project memory already records this
tax (compiler hand-copies shader-dsl IR/emit). The mitigation the field uses is **reactive**
(example/test suites catch divergence); X-GIS's **byte/parity gates across backends** are the
*proactive* version and a genuine improvement — keep them.

**What TSL does that `@xgis/shader-dsl` should adopt (two concrete additions):**

1. **A raw-shader escape hatch — `CodeNode` (language:'wgsl'|'glsl').** `[H — TSL.html.md]` TSL does
   **not** force 100% of shaders through the graph; it lets a hand-written backend-specific snippet be
   embedded as a node from day one. **Durable lesson:** a 5-year graph-shader system that *cannot*
   embed a hand-written snippet will be abandoned the first time a node can't express something.
   `@xgis/shader-dsl` should ship an explicit, blessed escape hatch — quarantined to a node type, so
   it's auditable — rather than forcing every future exotic shader through the IR or around it.

2. **Guarantee common-subexpression elimination as a PROPERTY, not a later optimization pass.** TSL's
   node graph dedups shared subexpressions automatically ("positionWorld computed once regardless of
   how many components use it") — a correctness+perf dividend you get *for free* by authoring as a
   graph rather than strings. `[H — TSL intro]` Project memory shows X-GIS already has a compile-time
   optimizer (const/copy-prop, CSE, dead-branch, fixpoint). **Recommendation:** make CSE a
   *guaranteed* property of the DSL's emit (oracle-gated, as the memory notes it already is), not a
   bolt-on — so shared-subexpression dedup is a contract, not an optimization that might regress.

**One deliberate divergence from wgpu to keep:** wgpu mandates a *single* source (WGSL) and translates
internally via naga; X-GIS's `RhiPipelineDesc` carries **both** `code` (WGSL) and optional
`vsCode`/`fsCode` (split GLSL ES), pushing dual-emit up to shader-dsl. `[H — rhi.ts:83-94]` This is
**defensible and probably necessary**: GLSL ES 3.00's single-`main()`-per-compilation-unit genuinely
differs structurally from WGSL's multi-entry module, so a naga-style "translate one source at the RHI"
would force the GLSL split anyway. The portability burden correctly lives in shader-dsl, not the RHI.
Accept this divergence; it is not a flaw. `[H on the divergence; M on long-term optimality]`

**Could X-GIS adopt UE's unification (one struct binds the shader AND declares pass graph access)?**
`[H — RDG metadata reuse]` Tempting, and project memory shows `reflect()` already drives uniform
std140 layout. The synthesis idea: have `reflect()` *also* emit the resource-access roles that feed
`PassIo`, mirroring RDG's single-source-of-truth. **Recommendation: note it as a future
consideration, do not build it for v1** `[M — synthesis, grounded in RDG + memory]`. X-GIS's `PassIo`
roles are *render-target/attachment* roles (colorDomain, resolve, depth), which a *fragment*-shader
reflection does not naturally produce; the fusion is real but the payoff is small at 8 passes, and
CLAUDE.md §2 disfavors it absent a measured need. Keep shader-IR and render-graph **orthogonal**
(Filament's explicit separation — the graph never inspects shader bodies) until a measured need
appears.

---

## 7. Concrete revisions to `render-graph-pass-scheduler.md`

Specific, sourced edits the prior art justifies. Each names the target section and the change.

- **R1 — Promote §9#1 from open question to DECIDED.** Replace the §9#1 "Open … Recommendation: ship
  the flat+roles model … defer the DAG" text with a **Decision** block citing this doc: *flat + roles
  is the decided v1 architecture, validated by three.js (same 2-backend web case, no frame-graph) and
  bgfx (10+ years flat); the DAG is rejected for v1 because its two headline payoffs (transient
  aliasing, minimal-barrier scheduling) are unreachable/free on single-queue WebGPU.* Move the
  revisit-trigger (a 4th inexpressible coupling, OR measured async-compute / RT-memory pressure) into
  the Decision as the explicit, **measured** condition. `[H — three.js; bgfx; O'Donnell break-even]`

- **R2 — Add a "reorder-safety" STARTUP ASSERTION to §3 (new §3.4 or fold into §3.2).** A startup
  assertion over the declared edges (resolve-barrier ordering, single clear-owner, depth feed-forward)
  so a reordered `registerPass()`/git-merge cannot silently corrupt the frame. **Explicitly scope it:
  this is a one-time startup CHECK, NOT a topological scheduler and NOT a per-frame cost** — the threat
  model is a same-team `@xgis/map` reordering 8 fixed buckets, not a third-party plugin surface, and the
  §8.2 contract test already covers ~80%. Ground the *principle* in Frostbite/Filament resource
  versioning (read-after-write is an edge, not an array index) but do NOT read "derives validity from
  edges" as license to build edge-resolution machinery. Promote from ad-hoc "assert" to a **named
  invariant**, nothing more. `[H — O'Donnell; Filament]`

- **R3 — Add an RHI extension-points note (extend §7.3 or new §7.4) — as DOCUMENTED, NOT v1 work.**
  Record G1 **scoped `RhiCaps`** (runtime-variable caps only — `canRenderFloat`/`maxTextureSize`/
  `maxColorAttachments`/`hasTimestampQuery`; KEEP the typed `backend` union for static structural
  facts), G2 **likely-unneeded completion fence** (readback already works fence-free via `mapAsync`,
  `interaction-controller.ts:166`), G3 **deferred `destroy*`** (add when a non-arena free is measured),
  G4 **fold swapchain into the P1 work**. Frame all four as **grow-when-measured extension points per
  `rhi.ts:8-11`'s charter**, NOT "settle before freeze" (that framing contradicted X-GIS's own grow-only
  discipline + CLAUDE.md §2). `[H — bgfx; wgpu-hal; rhi.ts:8-11]`

- **R4 — Strengthen the §6.1 reflection-SoT note with the field precedent.** Add that wgpu (naga),
  Godot (SPIR-V), and UE (FShaderParametersMetadata) all make reflection the single layout authority —
  X-GIS's `polygonUniformSlots()` is the same convergent pattern, so "treat polygon uniform layout as
  engine-injected-from-content-DSL" is industry-standard, not a local hack. `[H — wgpu; Godot; RDG]`

- **R5 — Add a "shader-dsl escape hatch + CSE lock" note (new §6.5 or in §6).** Per TSL: a blessed
  raw-shader `CodeNode`-style escape hatch — **but for X-GIS it MUST carry BOTH a `wgsl` and a `glsl`
  body (or fail the build / fail-close WebGL2)**, because a single-language snippet silently leaves the
  other required backend with no shader and breaks the 2-backend contract (`rhi.ts:83-94` makes dual
  source structural). State the **preferred** mitigation is to **grow the DSL** (memory shows builtins
  are already grown this way), with the dual-body escape hatch as the auditable last resort — NOT a
  single-language hatch. For CSE: project memory shows an oracle-gated CSE optimizer **already exists**,
  so the action is **confirm + lock it as a regression-gated contract**, not build it new. Note the
  WGSL-single-source vs GLSL-split divergence as deliberate (GLSL ES single-`main` forces it).
  `[H — TSL.html.md; rhi.ts:83-94; project memory on CSE]`

- **R6 — Upgrade §5/§4 with the "execute contract" clause (the no-capture rule).** Add to the
  `registerPass`/`RenderNode` contract: *the `execute` closure is a pure command recorder and MUST NOT
  capture mutable renderer state; all per-frame data arrives via `FrameContext` + `SceneView` +
  resolved `RenderNode`.* Ground in Unity's mandated-static-lambda + explicit-`PassData` and Godot's
  render-thread self-sync requirement — both prove captured state breaks under any future
  deferred/reordered execution. `[H — Unity; Godot]`

- **R7 — Harden §4.5 from "recommendation" to "v1 requirement" for opaque/OIT.** The prior art (bgfx:
  content never reaches back through engine frame state; the engine sees only opaque `DrawItem`
  streams) makes Option A the standard, not a preference. Change §4.5's "Recommendation: Option A …
  not punted to a separate task" into a **v1 acceptance item** for opaque/OIT, since otherwise the
  §8.5 engine→content == 0 gate cannot reach 0 (the `SceneView`-carried `GPURenderPipeline` is a live
  content-object leak that also blocks any future reorder, lesson 4). `[H — bgfx; wgpu]`

- **R8 — Add a "durable patterns compliance" callout (new short §10 or appendix).** A one-line
  scorecard mapping the §2 durable patterns to X-GIS status (✓/~/✗) so future editors see at a glance
  which load-bearing patterns are satisfied and which (G1 caps ✗, no-capture rule ✗-latent,
  §4.5 Option A ~) remain. Keeps the 5-year bar visible.

- **R9 — Cross-link this doc.** Add to the design doc's header block (after the `engine-content-split`
  / `package-responsibilities` links): *"Benchmarked against six engines in
  [`engine-design-prior-art.md`](./engine-design-prior-art.md); §9#1 (flat vs DAG) is decided there."*
  (This edit is applied — see the design doc header.)

**Net:** the prior art does not overturn a single core decision in the design doc — it **confirms**
the flat-list, the content-blind DI boundary, the reflection SoT, and the WGSL+GLSL shader IR, and it
turns the one deferred open question into a defensible decided choice. What it *adds* is a short list
of completeness items (R2 reorder-safety, R3 four RHI primitives, R5 escape hatch, R6 no-capture
clause, R7 Option A) that are cheap now and breaking-or-abandonment-risk later — exactly the "5-year
library, not a minimal shortcut" bar the charter demands.

---

## Appendix — source ledger & confidence

All engine claims trace to the prior-art research compiled for this study (engine docs + GDC/source
citations inline above). **Confidence convention:** `H` = stated verbatim or directly in an engine
doc / talk; `M` = inferred from an engine doc plus general knowledge (toolchain naming, internal
class names); `L` = existence-confirmed only (e.g. the jotunstudios "rebuttal of render graphs"
critique — DNS-failed fetch, flagged Low in source). **[GENERAL KNOWLEDGE]** marks the three
load-bearing WebGPU-platform premises that drive the §3 verdict — *no app-placed heaps, no app-recorded
barriers, single queue* — which are **not** from a frame-graph source and are deliberately flagged
every place they carry weight. The verdict's robustness rests on these being true of WebGPU/WebGL2; if
a future WebGPU revision exposes heaps or multi-queue, §3's revisit-trigger (ii) fires.
