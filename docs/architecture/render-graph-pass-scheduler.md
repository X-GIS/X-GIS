# The render-graph / data-driven pass scheduler — @xgis/engine "workflow engine"

> Authority design doc for turning the fixed linear render-pass chain in `RenderLoop.render`
> into a **data-driven render graph** — the "workflow engine" module of `@xgis/engine` per
> [`engine-content-split.md`](./engine-content-split.md) §2 (charter row "Render-graph (generic)"),
> §4 (`registerPass(PassDef)`), §6 (staged migration), §7 (risk #1, the #1 extraction blocker).
> Companion to [`package-responsibilities.md`](./package-responsibilities.md). **Benchmarked against
> six real engines (Unreal RDG · Unity RenderGraph · Godot RenderingDevice · three.js+TSL ·
> Frostbite/Filament FrameGraph · bgfx/wgpu) in
> [`engine-design-prior-art.md`](./engine-design-prior-art.md); the flat-vs-DAG question (§9#1) is
> decided there.**
> Benchmarked against six real engines (Unreal RDG, Unity RenderGraph, Godot RD, three.js+TSL,
> Frostbite/Filament FrameGraph, bgfx/wgpu) in
> [`engine-design-prior-art.md`](./engine-design-prior-art.md) — §9#1 below (flat ordered list vs
> frame-graph DAG) is **re-adjudicated and decided there** (verdict: keep flat+roles), and that doc
> lists concrete RHI/boundary/shader-IR revisions this design should absorb.
>
> **Status: DESIGN ONLY.** Zero code lands from this doc. P1 (flip every Draper default ON, all
> draws through the RHI) is **not done**; this doc respects the doc's P0 → P1 → P2 sequencing and
> calls out exactly what is additive-now versus gated. Every claim is grounded `file:line` against
> the tree at commit `544fe27d`. Where the older `engine-content-split.md` text is stale, this doc
> re-anchors and says so.

> ## ⛔ Hard acceptance bar: ZERO map coupling (shader-dsl grade)
> `@xgis/engine` must be **content-blind exactly like `@xgis/shader-dsl`** — it knows nothing about
> tiles, labels, named map projections, or any `@xgis/map` type. The standard is mechanical and
> non-negotiable: **the engine has ZERO import edges into content** (no `import` of `XGISMap`,
> `@xgis/map`, any renderer, or any map type — `import type` included is the stricter bar).
>
> How `@xgis/shader-dsl` already meets it (the template to copy): its *only* map coupling — the
> projection table — is **injected, not imported**. `configureProjections(PROJECTIONS)` pushes the
> data IN from content; the DSL never imports `PROJECTIONS` and never names a map type
> (`shaders/dsl/projections.ts:43-50`; verified: `shaders/dsl` has **no** `XGISMap` reference). That
> is **dependency inversion** — the same move every engine↔content touchpoint must make.
>
> **Therefore the whole design is judged by one gate:** after the carve, the engine→content import
> count is **0** (§8.5), enforced by an arch-ratchet like the existing downward-only-spine gate
> (`architecture-invariants.test.ts:633-685`). Inverting `PassHost` (§4) is **necessary but not
> sufficient** for this — three residual channels (§1.3) keep the engine entangled with content
> until they too are inverted. The doc below is honest about each; do not read "render-graph done" as
> "decoupling done".
>
> ### …and shaders are DSL-ONLY: NO hardcoded raw shader strings
> The engine's **only** shader interface is the typed `@xgis/shader-dsl` IR. **`@xgis/shader-dsl` is an
> ALLOWED (indeed mandatory) dependency** — the engine USES it to author any generic shader it owns
> (compose/blit/resolve, the compute kernel mechanics). What is **forbidden everywhere** (engine AND
> content) is a shader **hardcoded as a string literal / template literal** of WGSL or GLSL. Every
> shader is authored as DSL IR; the only place a shader becomes a string is the DSL's **emit output**,
> handed to the RHI (`RhiPipelineDesc.code`/`vsCode`/`fsCode`, `RhiComputePipelineDesc.code`) for the
> GPU driver. (`shader-dsl` is content-FREE — the luma.shadertools leaf — so depending on it does NOT
> breach the content-blind bar above; only `@xgis/map` imports do.)
> **Distinction:** authoring via the DSL and reflecting it (`reflect()`/emit) = **correct** (e.g.
> `gpu/frame-uniform.ts:53` `emitFrameUniformWgsl` is the engine using the DSL — NOT a violation).
> A **hardcoded** raw shader string (e.g. `gpu/compute.ts:105-117` `return \`@compute fn main(){…}\``,
> and `wgsl-expr.ts` string-building) = the **violation** — migrate it to DSL authoring. Gated in §8.5.

---

## 1. Purpose & scope

### 1.1 What "workflow engine" means here

The **workflow engine** is the generic, content-blind **render-graph / pass scheduler**: the
component of `@xgis/engine` that, given an ordered set of registered **pass definitions**
(`PassDef[]`) and a per-frame scene classification, decides *which passes run*, *in what order*,
*sharing which transient GPU targets*, and *who owns the MSAA resolve* — then drives each pass
through a uniform `shouldRun → execute` loop wrapped in per-pass error/timing scopes.

It replaces the hand-coded 8-step `if (…) pass.execute(…)` ladder in
`runtime/src/engine/render-loop.ts:452-481` with a **registry the loop iterates uniformly**:

```ts
for (const p of engine.orderedPasses())
  if (p.shouldRun(scene, frame)) engine.runPass(p, frame, scene)
```

(`shouldRun(scene, frame)` is the one signature used throughout — §3.1. The `DEBUG_OVERDRAW` mode it
reads off `frame` is today a build-time module constant imported per pass from `../../debug-flags`
(`oit-pass.ts:11`); the design moves it onto `frame` so the engine can gate on it without knowing its
meaning — that migration is part of Phase B, §7.1.)

The *order and identity of buckets* (background / opaque / oit / translucent / points / labels /
heatmap / overdraw-compose) become **@xgis/map configuration injected through `registerPass`**, not
engine code — exactly the inversion `engine-content-split.md` §2 calls for ("Pass *names* +
bucket *order* are content config injected through the register API, not engine code", §2:68).

This is the third register surface, alongside the two precedents:

| Register surface | Precedent (exists today) | This doc |
|---|---|---|
| `registerProjection` | `configureProjections(PROJECTIONS)` — `projections.ts:46` | §5.1 (generalize) |
| `registerRenderer` | `Material` / `DrawItem` / `executeItems` — `material.ts:83/130` | §5.2 |
| `registerPass` | **none — the gap this doc designs** | §3, §5.3 |

### 1.2 What it is NOT

- **NOT a geoprocessing / ETL / dataflow engine.** No spatial joins, no tile transforms, no
  feature pipelines. "Workflow" here is strictly the *GPU render-pass workflow* (the per-frame
  command-encoder schedule), never data processing.
- **NOT the blueprint visual node editor** (`blueprint/`, the Unreal-style style-authoring graph).
  The render graph is an internal engine scheduler with no UI, no serialization to disk, no user
  authoring. (It happens to share the word "node"; the contract-test *technique* in `blueprint/`
  is reused in §8, but nothing else.)
- **NOT a general dependency-DAG solver in v1.** The taxonomy below is a small, fixed, ordered
  bucket set with a handful of *known* cross-pass resource edges (depth, MSAA resolve, offscreen
  targets). v1 encodes those edges as **explicit declared metadata**, not as a topological-sort
  over arbitrary read/write sets. Whether to grow into a true DAG is an open question (§9).
- **NOT, in the additive phase, a rewrite of the pass bodies.** The first step (§7.1 Phase A)
  relocates each pass's `execute` body verbatim (it already is — `pass.ts:8-10` "Behaviour is
  byte-identical to the inline block"). But the *data-driven* step (§7.1 Phase B) **does** edit the
  bodies: it extracts the resolve-attach / depth-store / transient-alloc logic OUT of `execute` and
  INTO the engine scheduler so `io` actually drives scheduling. That step is byte-**diverging** and
  re-baselines the pixel-diff (§8.3). Do not conflate the two phases — see §1.3.

### 1.3 What v1 does NOT decouple (scope honesty)

Inverting `PassHost` (§4) and adding a flat `PassDef[]` is necessary but **not sufficient** to sever
engine↔content. Three residual content channels survive the `PassHost` inversion and are explicitly
**P2+** work, not closed by this design:

1. **`renderer` (`MapRenderer`) is a content god-object, not the engine.** `engine-content-split.md`
   §3:75 lists "renderer (legacy MapRenderer)" under **@xgis/map content**, alongside VTR/line/point.
   It exposes GIS fill/line/overdraw pipelines (`renderer.ts:122-124,143`) and a
   projection-parameterized `renderToPass(…projType,projCenterLon,projCenterLat…)` (`renderer.ts:785`).
   It cannot simply be "handed down as engine" — it must be **split** (RHI-driver core → engine;
   fill/line/raster/overdraw pipelines → a content `RendererDef`, §5.2) before P2. §2.2/§4.1 mark this.
2. **`SceneView` carries live content pipeline handles.** Even after `PassHost → RenderNode`, the
   pass bodies draw THROUGH content objects on the engine-owned `SceneView`:
   `scene.opaqueGroups[].shows[].{fp,lp,bgl,vtEntry}` (`bucket-scheduler.ts:51,66,68,361`) and
   `scene.oit[].vtEntry.renderer.render!` (`oit-pass.ts:60-69`). This **side channel** is a second
   engine→content coupling the `PassHost` inversion does not touch (§4.5).
3. **`FrameContext` carries map-projection scalars.** `projType` / `centerLon` / `centerLat`
   (`frame-context.ts:36-42`) are *projection identity* (RTC centre degrees, ±85 clamp), not generic
   4×4 engine math, yet they thread every content draw (`points-pass.ts:48`, `renderer.ts:785`). The
   "engine" handoff struct is laced with Mercator/projection content (§4.2, §9#3).

And one sequencing caveat that colours the whole plan: **in the additive phase, `io` is *asserted*
metadata, not a scheduler input.** The verbatim `execute` bodies still compute every coupling
themselves (`opaque-pass.ts:44-45` resolve, `:57` depth-store). The byte-identity gate (§8.1) passes
*regardless of whether any `io` field is correct*. `io` becomes load-bearing only after the Phase-B
centralization (§7.1) moves that logic into the engine. **So the additive adapter renames risk #1; it
removes it only at Phase B.**

---

## 2. Current state (grounded)

### 2.1 The fixed linear chain

`RenderLoop.render` runs one `{ }` block bracketed by per-renderer `beginFrame` (before) and
`endFrame` (after), inside which **eight passes execute in a hardcoded sequence**:

```
runtime/src/engine/render-loop.ts
  :231  renderer.dispatchComputePass(encoder, …)     // compute prepass (raw encoder)
  :238  per-VTR dispatchComputePass                  // VTR feature-data prepass
  :336  renderer/line/raster/point beginFrame        // uniform-ring cursor reset
  :364  per-VTR beginFrame / setLight / pumpPrefetch
  :450  if (scene.hasTranslucent) lineRenderer.ensureOffscreen(w,h)   // ⚠ LOOP allocates, not the pass
  :455  backgroundPass.execute(…)                     // bucket 0  — ALWAYS
  :458  opaquePass.execute(…)                         // bucket 1  — ALWAYS
  :461  if (oitPass.shouldRun) oitPass.execute(…)      // bucket 1.5
  :464  if (translucentPass.shouldRun) …              // bucket 2
  :467  if (pointsPass.shouldRun) …                    // bucket 3
  :470  labelPass.execute(…)                          // bucket 4  — ALWAYS
  :477  if (heatmapPass.shouldRun) …                   // bucket 5
  :481  if (overdrawComposePass.shouldRun) …           // debug
  :490  renderer.endFrame(); lineRenderer.endFrame()  // ring CPU-mirror flush
  :495  gpuTimer.resolveOnEncoder(encoder)
  :501  device.queue.submit([encoder.finish()])
```

The eight singletons are **hardcoded imports** at `render-loop.ts:30-37` and the sequence is
**hardcoded** at `:452-481`. `pass.ts:3-13` states this plainly: *"The render path is a fixed
linear chain of passes."* This is `engine-content-split.md` §7 risk #1, the #1 extraction blocker.

> **Re-anchor:** `engine-content-split.md` §4:98 / §7:156 cite `render-loop.ts:455-481`. The
> current line for the chain block is **`:452-481`** (background at `:455`). The substance is
> unchanged.

### 2.2 The `PassHost = Pick<XGISMap>` up-reach

Each pass's `execute(ctx, scene, host)` receives a `host` typed `PassHost`
(`pass.ts:46-65`), which is the **intersection of exactly 8 per-pass role views**
(`pass.ts:46-54`), each of which is literally a `Pick<XGISMap, …>` (`pass-hosts.ts:23-103`):

| Role view | `pass-hosts.ts` | Members | Engine-generic | Content-specific |
|---|---|---|---|---|
| `BackgroundPassHost` | :23-27 | 3 | — | `_backgroundColor`, `_backgroundColorShape`, `_backgroundOpacityShape` |
| `OpaquePassHost` | :30-38 | 7 | `camera`, `gpuTimer`, `_elapsedMs` | `renderer`†, `_rasterShow`, `pointRenderer`, `rasterRenderer` |
| `OitPassHost` | :41-45 | 3 | `camera`, `ctx` | `renderer`† (compose pipeline + VTR fill via SceneView, §4.5) |
| `TranslucentPassHost` | :48-52 | 3 | `camera` | `renderer`†, `lineRenderer` (nullable) |
| `PointsPassHost` | :55-58 | 2 | `camera` | `pointRenderer` |
| `LabelPassHost` | :62-89 | 26 | `camera`, `ctx` | **24 content members** (stages, glyph/sprite sources, data overlays, projection, dirty bookkeeping, dispatch memo, scratch sets, 2 debug hooks) |
| `OverdrawComposePassHost` | :92-95 | 2 | `ctx` | `renderer`† (overdraw-compose pipeline, §4.5) |
| `HeatmapPassHost` | :98-103 | 4 | `camera`, `ctx` | `renderer`†, `heatmapRenderer` (nullable) |

> **† `renderer` is NOT engine-generic.** It is `MapRenderer`, a **content** god-object per
> `engine-content-split.md` §3:75 (GIS fill/line/overdraw pipelines `renderer.ts:122-124,143`;
> projection-parameterized `renderToPass` `:785`). Earlier drafts mis-classified it as the engine
> "RHI-driver"; it must be **split** (RHI plumbing → engine; pipelines → content `RendererDef`)
> before P2 (§1.3, §4.1). The "pure engine" passes (OIT, overdraw-compose) are pure only of a
> *PassHost content member* — they still reach content through `renderer`† and `SceneView` (§4.5).

The composed `PassHost` (`pass.ts:46-54`) is **only these 8** — `SceneClassifyHost`
(`pass-hosts.ts:106-110`) and `FrameLoopHost` (`:115-136`) are joined into the wider
`RenderLoopHost` (`:141-152`) but are **not** part of `PassHost`. So the per-pass up-reach to
invert is exactly the union of those 8 role views.

**The engine-owned quartet** that recurs across passes and genuinely stays in `@xgis/engine` (never
in the content interface): `camera` (6 passes — but the *generic* 4×4 view only, see §9#3),
`ctx`/GPUContext (4), `gpuTimer` (1), and the engine frame-clock `_elapsedMs` (1). `renderer`
(`MapRenderer`, 5 passes) is the contested fifth — **content** until split (above). Every other
`PassHost` member is content (`pass-hosts.ts` per-row; map field defs `map.ts:184-207,472-497`).

### 2.3 Why order alone is not the contract

The visible bucket *order* is trivial to reproduce as a `PassDef[]`. The hard part is the
**cross-pass couplings** that array position cannot encode. The full inventory (each one is a
constraint the `PassDef` contract in §3 must carry):

1. **Split clear ownership.** Background owns the whole-viewport **colour** clear
   (`loadOp:'clear'` on `ctx.colorView`, *no* `resolveTarget` — "never the last colour writer",
   `background-pass.ts:86-95`); opaque's first sub-pass owns the **depth + stencil + pick** clears
   (`opaque-pass.ts:92-93,105,110-112`). Every later colour write is `loadOp:'load'`. So
   `background → opaque` is a hard ordering edge, and clear ownership crosses *two* passes — not a
   single "clear pass".

2. **Feed-forward depth store.** Opaque's last sub-pass STOREs depth instead of discarding it
   *only because* OIT and/or points will later `depthLoadOp:'load'` it:
   `persistDepth = !isLastOpaque || scene.hasPoints || scene.hasOit` (`opaque-pass.ts:57`,
   store at `:106`; consumed `oit-pass.ts:54-57`, `points-pass.ts:32-41`). **An earlier pass's
   store-vs-discard depends on whether later passes exist** — a backward read-edge over a shared
   depth attachment.

3. **Split, content-conditional MSAA resolve.** `opaque` / `translucent-composite` / `oit-compose`
   resolve *only* when `scene.resolveOwner` selects them (`opaque-pass.ts:44-45`,
   `translucent-pass.ts:26-27`, `oit-pass.ts:78`; owner priority `scene-view.ts:73-77`,
   points > composite > opaque). But **`points` and the `label` text-overlay sub-pass resolve
   UNCONDITIONALLY** on `ctx.useResolve`, ignoring `resolveOwner` (`points-pass.ts:28`,
   `label-pass.ts:1344`). So when labels exist, the label pass is the *de-facto* final resolver and
   the `resolveOwner`-gated resolve is a redundant (harmless) double-resolve. **A flat `PassDef[]`
   inferring "resolve if I am the last colour pass" would be WRONG.** Resolve ownership is a
   global, scene-derived attribute.

4. **Two render-target domains.** `heatmap` and `overdraw-compose` draw **directly to
   `ctx.screenView`** (the *resolved* single-sample swapchain, `loadOp:'load'`) — NOT the MSAA
   `colorView` (`heatmap-pass.ts:122-126`, `overdraw-compose-pass.ts:26-31`). They MUST run after
   all MSAA resolves (i.e. after labels) or the label-pass resolve would overwrite them
   (`scene-view.ts:69-72`). Array position cannot encode "after the resolve barrier"; this is
   `engine-content-split.md` §7 risk #1 made concrete.

5. **`DEBUG_OVERDRAW` is a whole-frame mode.** It re-purposes `colorView` into an r16float
   overdraw accumulator (`frame-context.ts:29-33`), flips ~5 gates off at once (oit / translucent /
   points / heatmap), SKIPs the text overlay (`label-pass.ts:1339`), and makes overdraw-compose the
   sole final pass reading `overdrawView` → `screenView` (`overdraw-compose-pass.ts:21-31`). Gates
   are **cross-cutting**, not independent per-pass booleans.

6. **Transient resource edges set up outside the passes.** `lineRenderer.ensureOffscreen(w,h)` is
   called by the **LOOP** at `render-loop.ts:450` (not by the translucent pass); OIT lazily
   allocates accum+revealage MRT inside the pass (`oit-pass.ts:26,36-48`); heatmap ping-pongs
   accum ↔ blur (`heatmap-pass.ts:60-132`). These are named transient targets with explicit
   read/write edges that a data-driven chain must declare.

7. **Per-pass diagnostic scope.** Every pass runs inside `ctx.passScope(label, fn)` — a per-pass
   GPU validation error scope + perf-mark pair (`render-loop.ts:260-274`), nested inside one
   frame-level `pushErrorScope('validation')` / `popErrorScope` (`:254`, `:531`). So `PassDef.label`
   is load-bearing for diagnostics, and the engine half owns the frame-level scope + submit.

8. **Lifecycle phases ≠ colour passes.** Compute dispatch must run after encoder creation but
   *before the first `beginRenderPass`* (`render-loop.ts:231,238-240`); `beginFrame` ring-resets
   run before any pass (`:336-345,364-379`); `endFrame` ring-flush + `gpuTimer.resolveOnEncoder` +
   `submit` run after all passes (`:490-495,501`). These are **engine-half lifecycle hooks, not
   PassDefs**.

---

## 3. The `PassDef` contract

`PassDef` generalizes the existing `RenderPass` interface (`pass.ts:57-65` — already
`label / shouldRun / execute`) by adding (a) a stable **bucket identity**, (b) an **ordering key**,
(c) explicit **resource declarations + dependency edges** for the couplings in §2.3, and (d) an
`execute` typed over a content-supplied **`RenderNode`** (§4), not `Pick<XGISMap>`.

> **Design stance (v1):** a **flat ordered list with declared resource roles**, not a topological
> DAG. The couplings in §2.3 are a *fixed, known, small* set; encoding them as declared metadata
> (which target domain, who owns the resolve, which shared attachments) is sufficient and far
> easier to test for byte-identity than a general scheduler. §9 keeps the DAG option open.

### 3.1 Identity, ordering, gating

```ts
// @xgis/engine — render/graph/pass-def.ts (proposed)

/** Stable bucket identity. The engine treats these as opaque strings; the SET
 *  and ORDER are @xgis/map config (registerPass call order), never engine code. */
export type PassBucket = string   // e.g. 'background' | 'opaque' | 'oit' | …

/** Which colour target a pass writes into. The TWO domains of §2.3.4. */
export type TargetDomain =
  | 'msaa'      // ctx.colorView (multisampled) — background/opaque/oit/translucent/points/label-text
  | 'resolved'  // ctx.screenView (resolved swapchain, loadOp:'load') — heatmap/overdraw-compose
  | 'offscreen' // a named transient (OIT accum, translucent MAX, heatmap accum/blur, overdraw accum)

export interface PassDef {
  /** Stable bucket identity (diagnostics label family + dependency keys). */
  readonly bucket: PassBucket
  /** Diagnostic label (the passScope key, render-loop.ts:260-274). Load-bearing. */
  readonly label: string
  /** Monotonic ordering key. Registration order is the default; an explicit
   *  numeric key lets @xgis/map insert a bucket without renumbering (the
   *  projType==array-index precedent, projections.ts:15-18). */
  readonly order: number

  /** Pure function of the per-frame scene (+ frame mode). The gate the inline
   *  `if (…)` used (background/opaque/labels return true unconditionally;
   *  oit/translucent/points/heatmap test scene flags & !DEBUG_OVERDRAW;
   *  overdraw-compose tests DEBUG_OVERDRAW). See §2.3.5 — mode is on the frame. */
  shouldRun(scene: SceneView, frame: FrameContext): boolean

  /** Static resource role declarations (the couplings of §2.3). */
  readonly io: PassIo

  /** Emit GPU commands. Typed over the engine FrameContext + scene + a
   *  content RenderNode resolved from the registry (NOT Pick<XGISMap>). */
  execute(ctx: FrameContext, scene: SceneView, node: RenderNode): void
}
```

`shouldRun` stays a pure predicate (matches every current gate — `background-pass.ts:65`
`return true`; `opaque-pass.ts:28`; `label-pass.ts:158`; `oit-pass.ts:19`; `translucent-pass.ts:19`;
`points-pass.ts:20`; `heatmap-pass.ts:30`; `overdraw-compose-pass.ts:19`). The `DEBUG_OVERDRAW`
mode (§2.3.5) is read off `frame`, not a per-pass flag — so a `PassDef` predicate can express both
"run unless overdraw" and "run only in overdraw" without the engine knowing the mode's meaning.

### 3.2 The resource / dependency declarations (`PassIo`)

This is what lifts the §2.3 couplings out of array position into **declared metadata**. It is the
core of "render-graph": the engine reads `io` to (a) attach the MSAA resolve target to the right
pass, (b) decide depth store-vs-discard, (c) order the resolved-domain passes after the resolve
barrier, and (d) allocate/alias the named transients.

> **When `io` is load-bearing.** The engine *consuming* `io` to make decisions (a)-(d) is the
> **Phase-B "centralization"** behaviour (§7.1) — it requires moving that logic OUT of the `execute`
> bodies, which is byte-**diverging**. In the additive **Phase A** the bodies still decide everything
> internally and `io` is only *asserted* by the contract test (§8.2). The list below describes the
> Phase-B scheduler; until then, treat `io` as validated documentation, not control flow (§1.3).
>
> **Granularity caveat (opaque).** `io.resolve` / `io.writesDepth` are **pass**-scoped, but opaque
> emits N internal `beginRenderPass` sub-passes and only its **terminal** sub-pass resolves
> (`isLastOpaque`, `opaque-pass.ts:44-45`) or decides depth store (`:57,106`). So `io` on the single
> opaque `PassDef` describes its *terminal sub-pass only*; the intra-opaque store/resolve decision
> stays inside `opaque.execute` until the sub-pass loop is itself modelled (§9#12). Engine-driven
> resolve/depth for opaque is blocked on that.

```ts
// @xgis/engine — render/graph/pass-def.ts (proposed)

/** A named transient render target the graph allocates & aliases (OIT accum+
 *  revealage, translucent MAX offscreen, heatmap accum/blur ping-pong, overdraw
 *  accumulator). Replaces the today-implicit ctx.rt.ensureOit / ensureHeatmap /
 *  lineRenderer.ensureOffscreen edges (§2.3.6). */
export interface TransientTarget {
  readonly name: string                       // 'oit.accum' | 'heatmap.accum' | 'translucent.max' | …
  readonly format: RhiTextureFormat
  readonly sampleCount: number
  /** Sized to the viewport unless a fixed/scaled size is given. */
  readonly size?: 'viewport' | { scale: number }
}

export interface PassIo {
  /** Which colour domain this pass's FINAL sub-pass writes (§2.3.4). The engine
   *  refuses to schedule a 'resolved'-domain pass before the resolve barrier. */
  readonly colorDomain: TargetDomain

  /** Does this pass CLEAR colour for the frame? Exactly ONE registered pass may
   *  (background). Encodes §2.3.1's "background clears colour". */
  readonly clearsColor?: boolean
  /** Does this pass CLEAR depth+stencil+pick? Exactly ONE may (opaque first
   *  sub-pass). Decouples colour-clear from depth-clear ownership (§2.3.1). */
  readonly clearsDepthStencilPick?: boolean

  /** This pass READS the shared depth attachment (depthLoadOp:'load'). The
   *  engine uses the UNION of readsDepth across the active pass set to decide
   *  whether the LAST depth-WRITER must store vs discard (§2.3.2). This is the
   *  backward edge that array order cannot express. */
  readonly readsDepth?: boolean
  /** This pass WRITES the shared depth attachment. */
  readonly writesDepth?: boolean

  /** This pass is ELIGIBLE to own the MSAA resolve when the scene's resolveOwner
   *  selects its bucket (opaque/composite/points), OR resolves UNCONDITIONALLY
   *  when present (points, label-text) — model both with a 3-state (§2.3.3). */
  readonly resolve?: 'owner-gated' | 'unconditional' | 'none'

  /** Named transients this pass allocates / reads / writes. The graph pools &
   *  aliases them; replaces ctx.rt.ensureOit/ensureHeatmap and the LOOP-level
   *  lineRenderer.ensureOffscreen (§2.3.6, render-loop.ts:450). */
  readonly creates?: ReadonlyArray<TransientTarget>
  readonly reads?: ReadonlyArray<string>     // transient names
  readonly writes?: ReadonlyArray<string>
}
```

How the engine consumes `PassIo` each frame (the scheduler core, ~replacing `render-loop.ts:450-481`):

1. Compute the **active set** = `passes.filter(p => p.shouldRun(scene, frame))`, in `order`.
2. **Resolve-owner resolution** (§2.3.3): the engine reads `scene.resolveOwner` — the **live source
   is `scene-view.ts:73-77`** (computed inline in `buildSceneView`); `planFrameSchedule`
   (`bucket-scheduler.ts:436-447`) computes a *structurally-duplicated* copy that `buildSceneView`
   does not call (a dup to reconcile, not the producer). The engine attaches the MSAA `resolveTarget`
   to the matching `resolve:'owner-gated'` pass, *plus* every `resolve:'unconditional'` pass
   (points/label-text) self-resolves. The redundant double-resolve is preserved byte-for-byte (it is
   harmless and current behaviour); collapsing it is an open question (§9), not a v1 change.
3. **Depth store decision** (§2.3.2): the last depth-**writing** `PassDef` STOREs iff any later
   active `PassDef` has `readsDepth` — the inter-pass union-of-`readsDepth` rule replacing the
   `scene.hasPoints || scene.hasOit` half of `opaque-pass.ts:57`. The **intra-opaque** `!isLastOpaque`
   half is sub-pass-granular and the engine has no visibility into opaque's internal loop, so it
   stays inside `opaque.execute` (granularity caveat above, §9#12). `io.writesDepth` is therefore
   *necessary but not sufficient* — do not delete the in-body `persistDepth`.
4. **Resolve barrier** (§2.3.4): `colorDomain:'resolved'` passes are scheduled only after the
   last `colorDomain:'msaa'` pass that resolves. The engine *asserts* this rather than inferring it,
   so a mis-registered heatmap-before-labels fails loudly instead of silently dropping the heatmap.
5. **Transient allocation** (§2.3.6): `creates`/`reads`/`writes` drive a pooled allocator
   (the existing `RenderTargets.ensureOit/ensureHeatmap` semantics — see open question in §9 about
   `ensure()` recreate-on-resize). `lineRenderer.ensureOffscreen` moves from the loop into the
   translucent `PassDef.io.creates`.
6. Drive each pass: `ctx.passScope(p.label, () => p.execute(ctx, scene, node))`
   (preserves `render-loop.ts:260-274`).

### 3.3 What stays a lifecycle hook (NOT a `PassDef`)

Per §2.3.8, the engine half keeps explicit pre/post-frame phases distinct from colour passes —
these are **not** PassDefs and **not** content-overridable:

```ts
// @xgis/engine — render/graph/frame-schedule.ts (proposed, engine-owned)
interface FrameLifecycle {
  preFrame(ctx: FrameContext): void   // createCommandEncoder; compute dispatch; ring-reset beginFrame
  runPasses(ctx, scene): void         // the §3.2 scheduler loop
  postFrame(ctx): void                // ring-flush endFrame; gpuTimer.resolveOnEncoder; submit
}
```

Compute dispatch (`render-loop.ts:231,238-240`) sits in `preFrame` *before the first
`beginRenderPass`*; this is also where compute dispatch routes per-backend — native compute on
WebGPU, fragment-shader GPGPU on WebGL2 (§7.3 parity mandate), behind one RHI contract. Never a
"refuse on WebGL2" gate.

---

## 4. The `RenderNode` content interface (inverting `PassHost`)

The inversion deletes `host: PassHost` (`Pick<XGISMap>`, §2.2) and replaces it with a
content-supplied **`RenderNode`** resolved from the registry by bucket id. The engine stops reaching
UP into `XGISMap` *by type*; instead each registered pass receives only the engine quintet (via
`FrameContext`) plus its own content node's draw methods.

### 4.1 The boundary, member by member

Every `PassHost` member maps to exactly one side:

| `PassHost` member | Goes to | Why / where |
|---|---|---|
| `camera`*, `ctx`, `gpuTimer`, `_elapsedMs` | **engine** (`FrameContext`) | The recurring quartet (§2.2). *`camera` only as the **generic 4×4** view — the Mercator-metre position is content (§9#3); the engine hands down the generic view, not `centerX/Y`. `_elapsedMs` is the engine frame clock handed down for content expression eval (§9#7). |
| `renderer` (`MapRenderer`) | **SPLIT** — engine RHI-driver + content pipelines | `engine-content-split.md` §3:75 = content. The encoder/pass plumbing → engine; the fill/line/raster/overdraw **pipelines** (`renderer.ts:122-124,143,785`) → a content `RendererDef` (§5.2). Not a clean hand-down (§1.3). |
| `_backgroundColor`, `_backgroundColorShape`, `_backgroundOpacityShape` | **content** (`BackgroundNode`) | Pure style output (`pass-hosts.ts:23-27`); the clear-colour is a content contribution. |
| **vector-tile fill/line draw** (the dominant opaque workload) | **content** (`OpaqueNode`) | `opaque-pass.ts:202-221` `cs.vtEntry.renderer.render(…cs.fp, cs.lp, cs.bgl…)` + `host.renderer.*` overdraw pipelines — reached via **`SceneView`**, NOT a `PassHost` member (§4.5). The original draft OMITTED this; it is the primary opaque content. |
| `_rasterShow`, `rasterRenderer`, `pointRenderer` | **content** (`OpaqueNode`) | `pass-hosts.ts:36`; raster + opaque-point draws. |
| `lineRenderer` | **content** (`TranslucentNode`) | `pass-hosts.ts:50`; nullable (the pass already tolerates absent content). |
| `pointRenderer` (again) | **content** (`PointsNode`) | `pass-hosts.ts:57`; reached by TWO passes — see §4.3. |
| `heatmapRenderer` | **content** (`HeatmapNode`) | `pass-hosts.ts:101`; nullable. |
| 24 label members (`textStage`, `iconStage`, glyph/sprite sources, `overlays`, `rawDatasets`, `showCommands`, `vtSources`, `projectionName`, dirty + dispatch-memo + scratch + 2 debug hooks) | **content** (`LabelNode`) | `pass-hosts.ts:62-89`; the entire label subsystem is one self-contained content node (engine supplies only `camera`+`ctx`). |
| OIT / overdraw-compose | **engine pass body + content compose pipeline** | They have **no `PassHost` content member**, but are **not** zero-content: OIT's fill sub-pass calls `cs.vtEntry.renderer.render!` (a VTR draw, `oit-pass.ts:60-69`) and both compose sub-passes use `host.renderer.{oitComposePipeline,overdrawComposeBindGroupLayout}` — **map shader graphs** (`engine-content-split.md` §3:78 = content). The pass *scheduling* is engine; the compose *pipeline* is content (§4.5). |

`projectionName` is a getter off `_viewport` (`map.ts:229`), reached by the label pass
(`pass-hosts.ts:83`) — so the `RenderNode` interface must tolerate **accessors**, not just fields;
the inverted interface is structural (§4.2).

### 4.2 The interface

```ts
// @xgis/engine — render/graph/render-node.ts (proposed)

/** What the engine hands DOWN to every pass (the quintet of §2.2). Already
 *  largely the FrameContext + SceneView pair; the inversion moves content
 *  renderers OUT of the host and the engine context carries only these. */
export interface FrameContext {
  readonly camera: Camera          // generic 4×4 view (engine math) — NOT the Mercator-metre map camera (§9#3)
  readonly rhi: RhiCommandEncoder  // P1-flipped encoder (today raw GPUCommandEncoder)
  readonly elapsedMs: number       // engine frame clock (handed down)
  readonly gpuTimer: GpuTimer | null
  // ── PROJECTION CONTENT laced through the "engine" struct (frame-context.ts:36-42) ──
  // These are NOT generic engine math; they are map-projection identity threaded into
  // every content draw (points-pass.ts:48, renderer.ts:785 renderToPass). They must
  // move onto the content draw signature OR be carried as an opaque projection token
  // the content interprets — UNRESOLVED (§9#3):
  readonly projType: number        // mercator … globe — map projection identity
  readonly centerLon: number       // RTC projection-centre degrees
  readonly centerLat: number       // clamped ±85
  // … the REST of the real type (frame-context.ts:21-77): device, screenView, colorView,
  //   w, h, dpr, frameCount, sampleCount, useResolve, visibleWorldCopies, rt, passScope, useRhi.
  //   visibleWorldCopies is WRITTEN by the label pass mid-frame and read earlier — an
  //   intra-frame data edge the io model does not yet cover (§9#13).
}

/** Marker base — a content render node the engine drives by bucket id. The
 *  engine knows ONLY this shape; @xgis/map supplies the concrete nodes. */
export interface RenderNode {
  readonly bucket: PassBucket
}

/** Each bucket's content slice = exactly the content members its PassHost
 *  up-reached, re-expressed as a node the pass draws THROUGH (no Pick<XGISMap>). */
export interface BackgroundNode extends RenderNode {
  clearColor(): readonly [number, number, number, number] | null   // from _background* shapes
}
export interface OpaqueNode extends RenderNode {
  drawRaster(ctx: FrameContext, scene: SceneView): void   // wraps rasterRenderer + _rasterShow
  drawVectorTiles(ctx: FrameContext, scene: SceneView): void   // the DOMINANT opaque draw —
    // wraps cs.vtEntry.renderer.render(…cs.fp,cs.lp,cs.bgl…) + overdraw pipelines (opaque-pass.ts:202-221)
  drawOpaquePoints(ctx: FrameContext, scene: SceneView): void   // wraps pointRenderer opaque sub-pass
}
export interface TranslucentNode extends RenderNode {
  drawTranslucent(ctx: FrameContext, scene: SceneView): void | null   // wraps lineRenderer (nullable)
}
export interface PointsNode extends RenderNode {
  drawPoints(ctx: FrameContext, scene: SceneView): void   // wraps pointRenderer direct-layer pass
}
export interface HeatmapNode extends RenderNode {
  accumulate(ctx, scene): void; blur(ctx): void; compose(ctx): void   // wraps heatmapRenderer 3-pass
}
export interface LabelNode extends RenderNode {
  // The entire label subsystem behind ONE node (24 content members → methods).
  dispatch(ctx: FrameContext, scene: SceneView): void
  readonly projectionName: string   // accessor — interface tolerates getters (map.ts:229)
}
```

The inversion is **mechanical per pass**: keep the same member *names* the role view already
narrowed, but source them from the node (`pass-hosts.ts` is `Pick<XGISMap>` keyed on member names,
`:23-103`). Each pass's `execute` re-types its `host` param from the `Pick` to its node type. The
8 narrowed role params already name each pass's minimal reach — *that minimal set IS its
`RenderNode` slice* (`pass.ts:64`).

### 4.3 One content node, multiple passes

`pointRenderer` is reached by **both** `OpaquePassHost` and `PointsPassHost`
(`pass-hosts.ts:36,57`). So the `RenderNode` contract must allow **one content node invoked by
multiple engine passes** — it is NOT `1 node = 1 pass`. The clean modelling: a single point content
node implements *both* `OpaqueNode.drawOpaquePoints` and `PointsNode.drawPoints`, and is registered
under both buckets (or the registry maps bucket → node and a node may answer to two buckets). This
must be settled before the interface freezes (§9 open question).

### 4.4 Where the engine STOPS reaching up

After inversion, the engine no longer narrows a `Pick<XGISMap>` and the per-pass `host` reference
becomes a **registry lookup by bucket id** — a string key into an engine-owned
`Map<PassBucket, RenderNode>` populated by `registerRenderer` / `registerPass` at construction time.
This closes the **`PassHost` channel** of risk #1 (`engine-content-split.md` §7:156-161).

**But it is NOT the whole severance** — and the original draft over-claimed here. Two content
channels survive `PassHost → RenderNode` (§4.5), and `MapRenderer` is still content-until-split
(§4.1). The honest statement: inverting `PassHost` removes the *typed* up-reach; full engine→content
decoupling additionally requires §4.5 and the `renderer` split.

The two **debug hooks** on `LabelPassHost` (`_pendingLabelDebugHook`, `_pendingTraceRecorder`,
`pass-hosts.ts:67-68`) are neither pure engine nor pure render content — they are diagnostic
instrumentation. They go onto the **content `LabelNode`** (they are label-subsystem internals), with
the engine exposing only a generic per-pass diagnostic channel via `passScope` (open question §9).

### 4.5 The `SceneView` side channel (the second engine→content coupling)

Inverting `PassHost` touches only the `host` param. The pass bodies reach content a **second way**:
through the engine-owned `SceneView`, which carries **live GPU content pipeline handles**:

- `scene.opaqueGroups[].shows[]` (`ClassifiedShow`) carries `fp: GPURenderPipeline`,
  `lp`, `bgl: GPUBindGroupLayout`, `vtEntry: ClassifierVTSource`
  (`bucket-scheduler.ts:51,66,68,361`); the opaque body draws via
  `cs.vtEntry.renderer.render(…cs.fp, cs.bgl…)` (`opaque-pass.ts:213-221`).
- `scene.oit[].vtEntry.renderer.render!` (`oit-pass.ts:60-69`).

So even after `host` is a `RenderNode`, the opaque/OIT/label bodies still consume content pipelines
off `SceneView` **every frame**. This must be a first-class part of the design, not deferred:

- **Option A (full inversion):** move pipeline resolution (`fp/lp/bgl/vtEntry`) behind the
  `OpaqueNode.drawVectorTiles` / `LabelNode` draw methods, so the engine sees only opaque
  `DrawItem` streams (`material.ts:61-81`) and never a `GPURenderPipeline` typed by content.
- **Option B (sanctioned data channel):** explicitly document `SceneView` as a content→engine data
  conduit and define exactly which handle types may cross it (a frozen `ClassifiedShow` shape).

`SceneClassifyHost` / `FrameLoopHost` (`pass-hosts.ts:106-136`) are a *third*, loop-level up-reach
(`classifyVectorTileShows`, `groupOpaqueBySource`, `heatmapRenderer`, `renderTargets`) outside
`PassHost` — their inversion is a separate task (§9#9). **v1 REQUIREMENT (not a recommendation):
Option A for opaque/OIT.** The prior-art benchmark (`engine-design-prior-art.md` §5, durable pattern 4)
makes this a standard, not a preference: bgfx/wgpu prove content **never reaches back through engine
frame state** — the engine sees only opaque `DrawItem` streams, never a content-typed
`GPURenderPipeline`. The `SceneView`-carried `fp/lp/bgl/vtEntry` is a **live content-object leak** that
(a) keeps the §8.5 engine→content == 0 gate from ever reaching 0, and (b) blocks any future
reorder/cull (a real GPU object can't be virtualized). So Option A for the dominant draws is a v1
acceptance item, tracked as part of the §4 inversion — not punted to "a separate task".

---

## 5. The register API

All three register surfaces follow the **`configureProjections` shape** (`projections.ts:43-50`):
a setter that (1) accepts a host-authored data record, (2) stores it in engine/module state,
(3) lazily (re)builds derived artifacts on first use, (4) **throws loudly** if a derived artifact
is accessed before registration. This is a **DATA push, not a code push**, and it is
**call-ordering-critical**: the single production call site is the `XGISMap` constructor, first
line of work (`map.ts:749-750`), and every `reflect()`/emit path throws
`configureProjections() must be called before any projection emit` (`projections.ts:48`).

### 5.1 `engine.registerProjection`

The existing `configureProjections` **is** this API. Generalize by re-homing it onto the engine
surface, keeping the `ProjectionSpec` data contract + lazy-artifact memoization + throw-on-unconfigured:

```ts
// projections.ts:43-50 today, promoted to the @xgis/engine surface:
export interface ProjectionSpec {     // intentionally MINIMAL — 4 fields (projections.ts:43)
  name: string; projType: number; isGlobe: boolean; cullThreshold?: number | null
}
engine.registerProjections(specs: readonly ProjectionSpec[]): void   // store, invalidate memo, lazily build ladder
```

The richer `ProjectionRecord` (`projections-table.ts:50-95`, ~11 fields) stays content-side — the
engine consumes only the 4 fields it needs to generate the dispatch ladder
(`projections.ts:307-326`, FLAT-filter + `emitForwardLadder`). **Index-as-identity** (projType ==
array order) is the ordering precedent the `PassDef.order` field inherits (`projections.ts:15-18`).
Whether this stays in `@xgis/shader-dsl` re-exported by `@xgis/engine`, or is promoted, is an open
question (§9).

### 5.2 `engine.registerRenderer`

Grounded in `Material` / `DrawItem` / `executeItems` (`material.ts:83-148`), which is **already**
the descriptor-driven, backend-agnostic render-node prototype: one `Material(rhi, MaterialDesc)`
builds N pipeline variants + bind layouts from data (`:92-109`); `DrawItem` is pure per-draw data
with no primitive-specific fields (`:61-81`); `executeItems` issues them through an `RhiRenderPass`
(`:130-148`). `MaterialDesc` already encodes the dual-backend contract (WGSL + optional split GLSL,
`:34-42`) and the reuse-vs-create layout choice (`:45-47`), so a `registerRenderer` built on it is
portable across WebGPU/WebGL2 with no new abstraction.

```ts
// @xgis/engine — render/graph/renderer-registry.ts (proposed)
export interface RendererDef {
  readonly id: string                  // bucket-resolvable key (the registry key)
  /** Lazy — like artifacts() (projections.ts:47-50). MUST run post-registerProjections,
   *  because buildMaterial → MaterialDesc may reflect() a uniform layout (e.g.
   *  polygonUniformSlots needs configureProjections — §6.1). Eager = the #612 crash class. */
  buildMaterial(rhi: RhiDevice): Material
  /** Per-frame content data. The engine owns Material construction + executeItems;
   *  content owns the DrawItem stream. */
  planDraws(scene: SceneView, frame: FrameContext): ReadonlyArray<DrawItem>
}
engine.registerRenderer(def: RendererDef): void   // store; build Material lazily on first draw
```

A registered renderer turns the by-type renderer reach (the `PassHost` role views, §2.2) into a
**keyed registry of render nodes**. A pass resolves renderer handles *by id* from the engine instead
of `Pick<XGISMap>` — directly inverting risk #1. The `buildMaterial` thunk **must be lazy**
(constructor / first-draw) to respect the no-eager-uniform-reflect rule (§6.1).

> **`registerRenderer` is the prerequisite that makes `registerPass`'s host data-driven** (§7):
> passes consume registered renderer/node handles, not typed slices of the concrete map. So
> `registerRenderer` lands *before or with* `registerPass`.

### 5.3 `engine.registerPass`

`registerPass` is the **smallest delta** of the three: `PassDef` (§3) extends `RenderPass`
(`pass.ts:57-65`, already `label/shouldRun/execute`) with `order` + the `io` declaration; register
the 8 existing singletons into an ordered array at constructor time; make the loop iterate it —
replacing the hardcoded imports (`render-loop.ts:30-37`) and sequence (`:452-481`).

```ts
// @xgis/engine — render/graph/pass-registry.ts (proposed)
const _passes: PassDef[] = []
export function registerPass(def: PassDef): void {
  _passes.push(def)
  _passes.sort((a, b) => a.order - b.order)   // explicit-order precedent: projType==index
}
export function orderedPasses(): readonly PassDef[] { return _passes }
```

The MRT/target vocabulary the `io` declaration needs already exists as `RhiRenderPassDesc`
(`rhi.ts:208-212`) and `RhiCommandEncoder.beginRenderPass` (`:259-268`) — P0.3 landed
(`0b835eac`). The remaining tension is `execute`'s `host`: until `registerRenderer` inverts
`PassHost`, `execute` still needs a host param — so `registerRenderer` lands **before (or with)**
`registerPass` (§7).

> **Execute-contract rule (no captured mutable state).** A registered pass's `execute` is a **pure
> command recorder**: it MUST NOT capture or read mutable renderer state through a closure; all
> per-frame data arrives via `FrameContext` + `SceneView` + the resolved `RenderNode`. This is a
> hard contract clause, not style — `engine-design-prior-art.md` §5/durable-pattern 3 grounds it in
> Unity (which routes all data through an explicit `PassData` struct + static lambdas) and Godot
> (render-thread self-sync) precisely because **captured state breaks the moment any reorder/cull/defer
> is introduced** (the §3.2 Phase-B scheduler, the §9#1 revisit). Single-threaded JS makes the
> *threading* trivial today; the *no-capture* discipline is what keeps a future derived schedule safe.

---

## 6. Frozen byte contracts

These must be **locked before the seam freezes** so the data-driven chain and the `RenderNode`
interface inherit a stable byte layout. Each is grounded as either already-converged or
needs-a-pre-step.

### 6.1 Polygon `Uniforms` — CONVERGED onto the reflected SoT (256B narrative is STALE)

**`engine-content-split.md` §7.3 (lines 165-169) is STALE.** It calls
`renderer.ts:842-880` + `graticule-renderer.ts:145-174` "literal-offset copies" of a hand-packed
256-byte struct. They are **not** literal copies anymore — all **three** packers now read field
offsets from the DSL reflection `polygonUniformSlots().slot`:

- VTR: `vector-tile-renderer.ts:11` imports `polygonUniformSlots`; `:25-28` a memoising Proxy `US`
  over `polygonUniformSlots().slot`; packers use `US.<field>` (SoT def `polygon-uniform-slots.ts:25-27`).
- `renderer.ts:843` `const S = polygonUniformSlots().slot`; `:844-885` all writes at
  `S.mvp / S.fill_color / S.clip_bounds / S.zoom / …`.
- `graticule-renderer.ts:172` `const S = polygonUniformSlots().slot`; `:157`
  `new ArrayBuffer(polygonUniformBytes())`; `:173-192` all writes at `S.<field>`.

**The frozen contract is the reflection itself** (`polygonUniformSlots()` / `polygonUniformBytes()`
/ `polygonUniformStride()`), *not* a literal 256. The size is dynamic (`slots * 4`). The `PassDef` /
`RenderNode` interface treats polygon uniform layout as **engine-injected-from-content-DSL** and
need not re-freeze a magic offset table. The §7.3 "converge before freezing" blocker is **DONE**.

Two follow-ups (both low-risk, do before the contract narrative freezes):
- **Lazy-only access:** `polygonUniformSlots/Bytes/Stride` may be called *only after*
  `configureProjections()` — never from a module-level const/static field, because
  `reflect(buildPolygonModule())` triggers projection-injection emit
  (`polygon-uniform-slots.ts:21-44`, comment `:37-41`; VTR defers via the `US` Proxy `:20-28`).
  This is the #612 EAGER-uniform-reflect crash class. Any `RendererDef.buildMaterial` that resolves
  the polygon stride must do so lazily (§5.2). **Freeze the order:** `registerProjection` precedes
  any uniform-layout reflection.
- **Delete stale comments:** `renderer.ts:831` ("192-byte"), `graticule-renderer.ts:158`
  ("240-byte"), and `engine-content-split.md` §4:102 ("256-byte") all drift from the now-dynamic
  reflected size. Only the *comments* are stale; the *code* is reflect-derived. Delete the byte-count
  comments to stop the next editor hand-maintaining a dead number.

### 6.2 `TEXT_FORMAT` / `ICON_FORMAT` (and `LINE_/POINT_/POLYGON_*_FORMAT`) — the clean model

These are single-source `VertexFormat` values built by `@xgis/compiler buildFormat()`; the packers
derive every slot from them so they cannot drift:

- `text-vertex-format.ts:9` `TEXT_FORMAT = buildFormat([…])`; `text-renderer.ts:35-37` derive
  `FLOATS_PER_VERT / TEXT_PX_SLOT / TEXT_UV_SLOT` from it.
- `icon-vertex-format.ts:10` `ICON_FORMAT = buildFormat([…])`; `icon-renderer.ts:66-68` derive slots.
- `line-vertex-format.ts:20`, `point-vertex-format.ts:11` same.
- `compiler/src/tiler/polygon-vertex-format.ts:33/45` `POLYGON_FILL_FORMAT / POLYGON_EXTRUDED_FORMAT`.
- `buildFormat` def: `compiler/src/tiler/vertex-format.ts:62`.

**No pre-freeze work.** The constraint: the engine `RenderNode` pipeline-desc must accept a compiler
`VertexFormat` / `RhiVertexLayout` (the `toVertexBufferLayout(FORMAT)` seam,
`text-renderer.ts:103/142`), and `buildFormat` stays in `@xgis/compiler` — a leaf both engine and
map depend on. `MaterialDesc.vertexBuffers` (`material.ts:50`) already models this shape.

### 6.3 `RhiBindLayoutEntry` (with the optional `name` for WebGL2 by-name reflection)

`MaterialDesc.groups` is `Array<RhiBindLayoutEntry[] | RhiBindGroupLayout>` (`material.ts:47`) —
entries to CREATE a layout, or an existing layout to REUSE (line shares the VTR tile layout). This
is the bind-group byte/slot contract the `RenderNode` interface freezes. The optional `name` field
(per `engine-content-split.md` §4:104) is required for the WebGL2 by-name uniform reflection path.
Freeze the entry shape before the interface so a registered renderer's bind layout is portable.

### 6.4 The DrawItem sub-range shape (arena binding) — must model `(buffer, offset, size)`

VTR binds shared `GPUArena` sub-ranges by raw byte offset:
`vector-tile-renderer.ts:3560` `setVertexBuffer(0, cached.vertexBuffer, cached.polyVertexOffset,
cached.polyVertexByteLength)`; `:3567` `setIndexBuffer(…, cached.polyIndexOffset,
cached.polyIndexByteLength)`. P0.2 landed the RHI sub-range op
(`setVertexBuffer(slot, buffer, offset?, size?)`, `rhi.ts:125`, commit `c518af8f`). **A `RenderNode`
draw is therefore NOT just `(pipeline, bindgroup, vbuf)` — it is `(pipeline, bindgroup +
dynamicOffset[], {vbuf, offset, size}[], {ibuf, offset, size})`.** `DrawItem` (`material.ts:61-81`)
must model these sub-ranges *before* the interface freezes, or it cannot express a VTR tile draw.
Whether the offset is a raw triple or an opaque `RhiBufferSlice` handle is an open question (§9).

### 6.5 `@xgis/shader-dsl` MUST gain compute → fragment-GPGPU lowering (the no-raw + parity consequence)

The no-raw-shader rule (§8.5) + the WebGL2 feature-parity mandate (§7.3, §8.6) **together force a
shader-dsl extension** — this is a direct, unavoidable consequence, not an optional nicety.

**Current state (grounded):**
- shader-dsl **already authors compute for WGSL**: `builder.ts:257-260,341-343` (`stage:'compute'`,
  `workgroupSize`, emits `@compute @workgroup_size(N)`), `nodes.ts:105-122` (`storage` address space,
  `read_write`). The compiler's per-feature compute kernels already go through it
  (`compute-gen.ts:58` `from '@xgis/shader-dsl'`) — so they are **DSL-authored, not raw**. Good.
- **But the GLSL backend FAIL-CLOSES on compute**: `glsl.ts:15-17` — a `storage` binding, a `@compute`
  entry, and MSAA-load all `throw UnsupportedFeatureError`; `glsl.ts:146` caps = "no storage buffers,
  no compute"; `required-caps.ts:19` marks `@compute` as the `'compute'` cap the GLSL backend rejects.
  `glsl.ts:47` even names the fix as a deferred "**later step**" (runtime-sized array → data-texture).

**The required extension** (so compute satisfies BOTH no-raw AND WebGL2 parity, authored ONCE in the DSL):
the shader-dsl **GLSL backend must lower a `@compute` kernel to a fragment-shader GPGPU form**, instead
of throwing:
- `@compute @workgroup_size(N)` + `global_invocation_id` → a **full-screen fragment pass** over a data
  texture; `gl_FragCoord` → the invocation index.
- `storage` **read** buffers → `sampler2D` data-texture gather (`texelFetch`) (the `glsl.ts:47` "later step").
- `storage` **read_write** writes → fragment **output** to an R32F/RGBA32F render target (`EXT_color_buffer_float`).
- the RHI `dispatchWorkgroups(...)` → a **fullscreen-quad draw** to the data texture on WebGL2
  (the `RhiComputePipelineDesc` routes: WebGPU compute pass / WebGL2 fragment pass — §7.3).

Until this lands, `gpu/compute.ts:generateShader()`'s **raw WGSL template literal** (the §8.5 Rule-B
violation) cannot be migrated to the DSL *and still run on WebGL2* — the two requirements are coupled.
This is the concrete shader-dsl work item the engine's shader-DSL-only + parity bars create; it aligns
with the in-code "later step" markers and the known compute-gen ↔ shader-dsl re-target debt.

> **Module-responsibility decision (authority: [`package-responsibilities.md`](./package-responsibilities.md)
> rulings f, i):** because the backend is chosen at **runtime**, **`@xgis/compiler` emits NO shader
> code** — it builds backend-neutral `@xgis/shader-dsl` IR and stops (no `emitModule`/WGSL string at
> compile time). **`@xgis/shader-dsl` is the SOLE shader-code generator**, emitting WGSL *or* GLSL
> (incl. this compute→fragment lowering) at runtime once the device backend is known. The current
> `compute-gen.ts:417` `emitModule(...)` (compile-time WGSL) is a violation to migrate to IR-out.
> Two modules generating shader code = the SRP break / wheel-reinvention this forbids.

---

## 7. Sequencing & gates (P0 → P1 → P2)

The three register APIs **must land in dependency order**, forced by the lazy-reflect + raw-encoder
facts, not preference:

```
registerProjection (EXISTS)
   └─> registerRenderer (Material-based; fully RHI-typed execute needs the P1 RhiCommandEncoder flip)
          └─> registerPass (needs registerRenderer to drop the Pick<XGISMap> host)
```

Mapped to `engine-content-split.md` §6 phases:

| Phase | What this doc's work does | Gated on |
|---|---|---|
| **Now (additive, pre-P1)** | §7.1 adapter: wrap the 8 existing `RenderPass[]` in a `PassDef[]` and have the loop iterate it — **behaviour byte-identical**, `host` still `Pick<XGISMap>`. | nothing — additive |
| **P0** | RHI extensions. P0.1 stencil / P0.2 vbuf sub-range / P0.3 beginRenderPass+MRT / P0.4 compute-types **LANDED** (`1de71c54`/`c518af8f`/`0b835eac`/`5b9a8525`). Gaps remain (§7.3). | — |
| **P1** | Flip every Draper default ON; route all draws through `Material`+RHI; the loop hands an `RhiCommandEncoder` (not raw `GPUCommandEncoder`). | enables RHI-typed `PassDef.execute` |
| **P2** | Carve `@xgis/engine`; make the chain data-driven (`registerPass(PassDef)`); **invert `PassHost` → `RenderNode`** (§4). | P1 done |

### 7.1 The additive path is TWO gated steps, not one

The earlier framing ("one byte-identical adapter that also proves the `io` model") conflated two
things that have **opposite byte behaviour**. Split them:

#### Phase A — inert-`io` wrapper (byte-IDENTICAL, lands before P1)

1. Wrap each of the 8 singletons (`render-loop.ts:30-37`) in a `PassDef` whose `order` = current
   sequence index, `shouldRun` = the existing predicate, `io` = the §3.2 declaration transcribed
   from each pass's current resource use, and `execute` = a thunk calling the existing
   `pass.execute(ctx, scene, host)` with the **unchanged `PassHost`** (still `Pick<XGISMap>`).
2. Replace the hardcoded `:452-481` ladder with a loop that runs **only** (i) `shouldRun` filtering
   in `order`, (ii) the §3.2 step-4 resolve-barrier as a **read-only assertion**, (iii) the
   `passScope` + `execute` thunk. It does **NOT** run §3.2 steps 2/3/5 — the bodies still attach the
   resolve target, decide depth store, and call `ensureOit`/`ensureOffscreen` themselves.
3. Keep the lifecycle hooks (§3.3) exactly as today, including `lineRenderer.ensureOffscreen` at
   `render-loop.ts:450` (do **not** move it into a `PassDef.io.creates` yet — that is Phase B, and is
   blocked on the `RenderTargets.ensure*` semantics open question §9#11).

Because `host` is still `Pick<XGISMap>` and `execute` bodies are untouched, the emitted command
stream is **identical**. **Crucially, this proves NOTHING about `io` being correct** — the bytes are
produced by the verbatim bodies (`opaque-pass.ts:44-45,57`), so the §8.1 gate passes even if every
`io` field were wrong. In Phase A `io` is *asserted* by the contract test (§8.2) only. (If the loop
instead installed the full §3.2 scheduler while the bodies still self-managed resolve/depth/ensure,
the logic would be **double-applied** — `resolveTarget` attached twice, `ensureOffscreen` at both
`:450` and in-pass — which is NOT byte-identical. Phase A must avoid that.)

#### Phase B — centralization (byte-DIVERGING, re-baselines the pixel-diff)

This is the step that makes `io` load-bearing and actually reduces risk #1. Move out of the `execute`
bodies and into the §3.2 scheduler: the resolve-attach (`opaque-pass.ts:44-45,77`,
`points-pass.ts:28`), the depth store-vs-discard (`opaque-pass.ts:57,106`, inter-pass part only —
the intra-opaque `!isLastOpaque` stays, §3.2 step 3), and the transient allocation (move
`ensureOffscreen`/`ensureOit` into `io.creates`, gated on §9#11).

Because the descriptors are now built by the engine from `io` rather than by the bodies from
`scene.*`, the command stream **can shift** (e.g. the redundant double-resolve might collapse, a
store/discard might differ at a sub-pass boundary). Phase B is therefore **not** gated by DC = 0
against the live ladder; it is gated by:
- DC = 0 on the **RenderPassDescriptor stream** (§8.1) versus **Phase A** for every scene where the
  intent is unchanged, and an explicit, reviewed allow-list of intended divergences (e.g. collapsed
  double-resolve), plus
- a fresh real-GPU pixel-diff **re-baseline** (§8.3).

Only Phase B is "the data-driven chain". The `RenderNode` inversion (§4) layers on top of Phase B at
P2 (it needs `registerRenderer` + the RHI-typed encoder, §7.2).

### 7.2 Gated on P1: the RHI-typed `execute` and the `RenderNode` inversion

`PassDef.execute`'s encoder cannot be cleanly RHI-typed until the **loop hands an
`RhiCommandEncoder`** instead of a raw `GPUCommandEncoder`. Today the loop still creates a raw
encoder and the lifecycle methods are OPTIONAL + bypassed: `beginScreenPass?` / `endScreenPass?` /
`createCommandEncoder?` are all optional on `RhiDevice` (`rhi.ts:286-313`), and the loop still calls
`renderer.dispatchComputePass(encoder, …)` with a raw encoder (`render-loop.ts:231,239`). The
`RenderNode` inversion (§4) is likewise P2 — a registered pass can only receive resolved node handles
once `registerRenderer` exists and the encoder is RHI.

### 7.3 Remaining P0 RHI gaps + the WebGL2 FEATURE-PARITY mandate

> **⛔ Feature parity is mandatory — no "WebGL2 can't, so it's unimplemented".** Every FEATURE ships on
> BOTH backends. "WebGL2 lacks a WebGPU capability" is **never** a reason to drop a feature — it is a
> reason to implement the **WebGL2-compatible technique**. The RHI's job is to **hide the technique
> difference** behind one contract; content authors the kernel once (DSL), the RHI routes it to native
> compute on WebGPU and to the emulation on WebGL2. The **only** legitimate backend difference is an
> **internal perf strategy whose OUTPUT is byte-identical** (e.g. render bundles, below) — never a
> missing feature, never missing output. `requiresCompute`-style "refuse on WebGL2" gates are **removed**.

| Gap | State | Resolution (parity-mandatory) |
|---|---|---|
| **Compute** | P0.4 landed **TYPES ONLY** — `RhiComputePipeline/Desc/Pass/PassDesc` exist (`rhi.ts:224-250`) but `RhiDevice` has no factory methods. Live `ComputeDispatcher` runs **raw** `device.createComputePipeline` (`gpu/compute.ts:58,87`). | **FEATURE, must run on both.** WebGPU → native compute pass. **WebGL2 → fragment-shader GPGPU**: the per-feature paint kernels (an embarrassingly-parallel *map* over features) run as a fragment pass writing a **data texture** (R32F/RGBA32F, gather-only), the storage→data-texture emulation the charter already anticipates (`engine-content-split.md` §5). The DSL emits BOTH forms from one kernel (WGSL compute / GLSL fragment) — §6 no-raw rule. So the RHI compute contract gets a **real WebGL2 implementation**, NOT a fail-close. (Blocks the chain? No — `preFrame` hook §3.3.) |
| **Render bundles** | No RHI surface. `bundle-cache.ts:78,134` records raw `GPURenderBundleEncoder`. | **The ONE legitimate backend difference** — bundling is a pure **perf optimization with byte-identical OUTPUT**: WebGPU records a bundle, WebGL2 replays the same draws per-frame. NOT a feature, so output parity holds with no WebGL2 bundle. The `PassDef` must not bake bundle-replay into its contract; invariant: a node's draw-list is REPLAYABLE (no per-draw `setStencilReference` inside a recorded scope). |
| **Pick** | `pickAt` runs raw `copyTextureToBuffer` + `mapAsync` (`interaction-controller.ts`). | **FEATURE, must run on both.** The pick `@location1` MRT is part of the opaque topology (WebGL2 supports MRT via `gl.drawBuffers`). WebGPU → `copyTextureToBuffer`+`mapAsync`; **WebGL2 → `gl.readPixels`** from the pick attachment. Both ship. The v1 `PassIo` (§3.2) has no extra-colour-attachment field, so the pick MRT stays built inside `opaque.execute` (`opaque-pass.ts:90-97`), out of the frozen v1 `io` schema; the readback routes per-backend behind the RHI. |

None of the three block the data-driven chain or the additive-now adapter. Compute and pick are
**features with mandatory WebGL2 implementations** (fragment-GPGPU; `gl.readPixels`) — not fail-close.
Render bundles are the single legitimate WebGPU-only **perf strategy** because output is byte-identical
via per-draw replay. The §8.5 parity gate enforces this.

> **Charter reconciliation:** `engine-content-split.md` §5's "fail-close on WebGL2" language is **interim**
> ("correct-first, perf-later" sequencing), NOT a permanent capability drop. The end state per this
> mandate is full WebGL2 feature parity; "fail-close" is only the temporary state before each WebGL2
> technique lands.

---

## 8. Test gates

Per CLAUDE.md §4 (goal-driven) and §5 (render verification MANDATORY).

### 8.1 Byte-identity snapshot (the additive-now gate)

Phase A (§7.1) must emit a **byte-identical command stream** versus the current `:452-481` ladder.
The snapshot must capture **more than WGSL/uniform/draws** — every coupling the `io` model governs
lives in the `beginRenderPass` **descriptor**, not in shader/uniform/draw bytes. Snapshot, per pass:
- the encoded **WGSL + uniform-pack + draw-call sequence**, AND
- the full **`RenderPassDescriptor`**: `colorAttachments[].{loadOp, storeOp, resolveTarget != null}`,
  `depthStencilAttachment.{depthLoadOp, depthStoreOp, stencilLoadOp, stencilStoreOp}`, and the pick
  attachment presence + `clearValue` (`opaque-pass.ts:77,87-112`, `points-pass.ts:28`,
  `background-pass.ts:86-95`).

A snapshot that omits the attachment descriptors **cannot catch** an `io`-driven resolve mis-attach,
a wrong depth store/discard, or a clear-ownership regression — i.e. it would ship green while
silently regressing MSAA resolve or depth occlusion, the exact §2.3 hazards this design exists to
lift. Gate across the fixed scene matrix (mercator + globe; with/without translucent, points,
heatmap, labels; `DEBUG_OVERDRAW` on/off — §2.3.5).

- **Phase A** (`io` inert): DC = 0 on the full stream above proves the *wrapper* is faithful — it
  does **NOT** prove the `io` fields are correct (the bytes come from the verbatim bodies, §1.3/§7.1).
- **Phase B** (`io` load-bearing): the descriptors are now built by the engine *from `io`*. Gate
  DC = 0 on the descriptor stream **versus Phase A**, with a reviewed allow-list for any *intended*
  divergence (e.g. a deliberately collapsed double-resolve). Only this proves the `io` model
  reconstructs the chain — and it is paired with the §8.3 real-GPU re-baseline.

### 8.2 Contract test (pin the schema) — modelled on `blueprint/__tests__/contract.test.ts`

`blueprint/src/__tests__/contract.test.ts:13-35` pins **exact field keys** of a schema-driven node
table so codegen can't drift (`FIELD_KEYS` map → `expect(NODE_SPECS[type].fields.map(f=>f.key))
.toEqual(keys)`). Mirror it for the render graph:

```ts
// runtime/src/engine/render/graph/__tests__/pass-contract.test.ts (proposed)
describe('@xgis/engine render-graph contract', () => {
  it('the 8 registered buckets keep their identity + order', () => {
    expect(orderedPasses().map(p => p.bucket)).toEqual([
      'background','opaque','oit','translucent','points','label','heatmap','overdraw-compose',
    ])
  })
  it('exactly one pass clears colour, exactly one clears depth/stencil/pick', () => {
    expect(orderedPasses().filter(p => p.io.clearsColor).map(p => p.bucket)).toEqual(['background'])
    expect(orderedPasses().filter(p => p.io.clearsDepthStencilPick).map(p => p.bucket)).toEqual(['opaque'])
  })
  it('resolved-domain passes are registered AFTER the last msaa-domain pass', () => {
    const idx = (b: string) => orderedPasses().findIndex(p => p.bucket === b)
    for (const b of ['heatmap','overdraw-compose'])
      expect(idx(b)).toBeGreaterThan(idx('label'))
  })
  it('resolve roles match the scene-derived owner model (§2.3.3)', () => {
    expect(byBucket('points').io.resolve).toBe('unconditional')   // points-pass.ts:28
    expect(byBucket('label').io.resolve).toBe('unconditional')     // label-pass.ts:1344
    expect(byBucket('opaque').io.resolve).toBe('owner-gated')      // opaque-pass.ts:44-45
  })
  it('depth readers/writers pin the feed-forward store rule (§2.3.2)', () => {
    expect(byBucket('opaque').io.writesDepth).toBe(true)
    for (const b of ['oit','points']) expect(byBucket(b).io.readsDepth).toBe(true)
  })
})
```

This freezes the §3 schema the same way blueprint freezes codegen field keys — drift fails loudly.

### 8.3 Real-GPU pixel-diff (CLAUDE.md §5 — MANDATORY, never skipped)

The byte-identity snapshot proves CPU-side faithfulness; it does **not** prove the rendered output.
Per CLAUDE.md §5 the render verdict requires:
1. **Directional pixel-diff** with `.claude/skills/compare-parity-pixeldiff/compare-diff.py`.
   **Phase A** (inert-`io` wrapper): live ladder vs adapter, DC = 0 expected (byte-identical). **Phase
   B** (centralization): this is a deliberate **re-baseline** — DC may be non-zero where a divergence
   is *intended* (e.g. collapsed double-resolve); diff vs Phase A, read every hot tile, and accept
   only reviewed intended changes. In both, vs MapLibre D1 < D0 unchanged. Gate on DC + direction,
   never an absolute %.
2. **Read the diff image in a 16-split (4×4) grid at full resolution** (tile-crop-review), worst
   tiles first — the cross-pass couplings most likely to regress are MSAA seams (resolve-owner
   mis-attach, §2.3.3), depth occlusion (feed-forward store, §2.3.2), and the
   heatmap/overdraw resolved-domain ordering (§2.3.4). Eyeballing a downscaled frame is FORBIDDEN.
3. Run across the §8.1 scene matrix, especially `DEBUG_OVERDRAW` (the whole-frame mode, §2.3.5) and
   labels-present (the de-facto resolver case, §2.3.3).

### 8.4 Strict `tsc --build`

`engine-content-split.md` §6 gate. The `RenderNode` inversion is a type-level change; strict
`tsc --build` is the gate that catches a pass whose `execute` host param no longer matches its
node slice. (Vitest does not typecheck — `bun run build` does.)

### 8.5 Zero-coupling gate — content-blind AND shaders-DSL-only (THE acceptance test)

This is the gate that proves the hard bar at the top of the doc: `@xgis/engine` is **content-blind**
(zero `@xgis/map` imports) and uses **shaders DSL-only** (no hardcoded raw shader strings).
`@xgis/shader-dsl` is an **allowed** dependency — it is the content-FREE leaf the engine authors its
generic shaders with. It is an **arch-ratchet**, modelled on the existing downward-only-spine gate
(`architecture-invariants.test.ts:633-685`) and the "compiler never imports @xgis/runtime" gate
(`:52-59`):

```ts
// runtime/src/engine/__tests__/engine-content-blind.test.ts (proposed — promote to @xgis/engine on carve)
it('@xgis/engine imports nothing from @xgis/map AND hardcodes no raw shader strings', () => {
  // Rule A — CONTENT-BLIND: zero import edges into @xgis/map content (the map renderers,
  // the map shader graphs, projection table). @xgis/shader-dsl is NOT here — it is allowed.
  const FORBIDDEN = /from\s+['"](@xgis\/map|.*\/(vector-tile-renderer|line-renderer|point-renderer|heatmap-renderer|raster-renderer|graticule-renderer|map|interpreter|projections-table|shaders\/dsl\/(polygon|line|point|heatmap|raster|graticule)))['"]/
  const FORBIDDEN_TYPE = /\bXGISMap\b/   // not even `import type`
  // Rule B — SHADERS DSL-ONLY (applies engine AND content): no shader hardcoded as a string
  // literal / template literal. All shaders are authored via @xgis/shader-dsl IR; the only
  // string is the DSL's EMIT output handed to the RHI. Authoring-via-DSL + reflect() are FINE.
  const RAW_SHADER_LITERAL = /`[^`]*(@vertex|@fragment|@compute|fn\s+main\s*\(|gl_Position|gl_FragColor|precision\s+(highp|mediump))[^`]*`/
  // walk engineFiles(); assert no FORBIDDEN import, no XGISMap, no RAW_SHADER_LITERAL. Allowlist = EMPTY.
})
```

Verified today: `rhi.ts`/`material.ts` pass both rules; `gpu/frame-uniform.ts:53` importing
`emitFrameUniformWgsl` is **correct** (the engine using the DSL, not a violation). The gate **fails
today** on the channels below — the objective, mechanical definition of "done":

| What the gate catches | Rule | Cut by |
|---|---|---|
| `pass.execute(host: Pick<XGISMap>)` (§2.2) | A | §4 `RenderNode` — content registers nodes; engine resolves by bucket id |
| `renderer` = `MapRenderer` named in engine (§4.1) | A | split renderer — RHI-driver → engine; pipelines → content `RendererDef` (§5.2) |
| `SceneView` carries `GPURenderPipeline`/`vtEntry` (§4.5) | A | §4.5 Option A — content draws emit generic `DrawItem[]` |
| `FrameContext.{projType,centerLon,centerLat}` (§4.2) | A | §9#3 — inject projection token, not degrees |
| **hardcoded raw WGSL in `gpu/compute.ts:105-117`** (`generateShader()` template literal) + `wgsl-expr.ts` string-building | B | **author the kernel via `@xgis/shader-dsl`** (not a hardcoded string); engine still uses the DSL |

When this test is green with an **empty allowlist**, the engine is content-blind and shader-DSL-only.
Every other gate (§8.1-8.4) proves *correctness*; this one proves *independence + no-raw-shaders*.

### 8.6 Feature-parity gate — every feature ships on WebGPU AND WebGL2

Enforces the §7.3 mandate: **no feature is WebGPU-only.** "WebGL2 lacks a WebGPU capability" is never
an excuse to leave a feature unimplemented in the fallback (§7.3). The gate has two parts:

1. **Capability-coverage assertion (static).** For every feature the engine exposes (compute dispatch,
   pick readback, MRT, float-render, …), assert a WebGL2 implementation path EXISTS — `rhi-webgl2.ts`
   must not `throw "unsupported"` for any *feature* (only for a genuinely-absent **perf strategy** like
   render bundles, whose output is reproduced by per-draw replay). A `throw` in a feature path fails
   the gate.
2. **Cross-backend pixel parity (real-GPU).** The §8.3 directional pixel-diff is run **on both
   backends** (`?forcegl2=1` pins WebGL2): WebGPU-vs-WebGL2 of the SAME scene must agree to the §8.3
   tolerance for every feature that has visible output (compute-driven per-feature paint, picked
   highlight, etc.). A feature that renders on WebGPU but is blank/different on WebGL2 fails — that is
   the mechanical definition of "no fail-close excuse".

The legitimate exception is explicit and narrow: an **internal perf strategy** (render bundles) may be
WebGPU-only **iff** its WebGL2 replay produces byte-identical output (so it never shows up in the
parity pixel-diff). Anything that changes *output* or *feature availability* between backends fails.

---

## 9. Open questions / risks

1. **Flat ordered list vs dependency DAG — DECIDED (was open).** Benchmarked against six engines in
   [`engine-design-prior-art.md`](./engine-design-prior-art.md) §3. **Decision: ship the flat ordered
   `PassDef[]` + declared `PassIo` roles for v1; REJECT a frame-graph DAG.** Evidence: the only
   same-shape peer — **three.js** (web, 2-backend WebGPU+WebGL2, node-graph shader IR) — ships **no
   frame-graph at all**; **bgfx** shipped a flat numbered-view scheduler for **10+ years**; the two DAG
   headline payoffs are **unreachable or free** on X-GIS's platform (transient memory aliasing needs
   app-placed heaps WebGPU/WebGL2 do not expose; minimal-barrier scheduling is *already done by WebGPU
   for free* — X-GIS sits above the barrier layer, unlike Godot's Vulkan-level RD). Unity/Godot
   migrated **off** flat models, but off *under-declared* ones — both still execute in declaration
   order; the real hazard is **under-declaration, not flatness**. So the teeth are in **hardening the
   declarations** (make `PassIo` complete + validated, §3.2 Phase-B) so the model is a strict superset
   a future derived schedule could consume *additively*. **Revisit trigger (measured, not aspirational):**
   (i) profiled async-compute need (N/A on single-queue WebGPU), (ii) measured transient-RT memory
   pressure, or (iii) a coupling `colorDomain/readsDepth/writesDepth/resolve/creates/reads/writes`
   genuinely cannot encode. Until one is *measured*, CLAUDE.md §2 forbids the compiler.

2. **Double MSAA resolve — collapse or preserve?** When labels exist, the `resolveOwner`-gated pass
   resolves AND the label text-overlay resolves again on the same `useResolve` frame
   (`points-pass.ts:28`, `label-pass.ts:1344`). v1 **preserves** it (byte-identical). **Open:**
   should the data-driven model collapse resolve ownership to a single explicit terminal pass? That
   would change the byte stream (one fewer resolve), so it is a *separate, gated* optimization, not
   part of the inversion.

3. **Projection content laced through the "engine" handoff** (`engine-content-split.md` §7 risk #2)
   — this is a **zero-coupling blocker (§8.5)**, not a stylistic choice. Two faces of the same
   Mercator coupling: (a) `camera.ts` IS the Web-Mercator camera (centerX/Y = Mercator metres) with
   the generic 4×4 algebra interleaved with map-projection inverses; (b) `FrameContext` itself
   carries `projType` / `centerLon` / `centerLat` (`frame-context.ts:36-42`), threaded into every
   content draw (`points-pass.ts:48`, `renderer.ts:785`). The engine struct the design "hands down"
   is therefore laced with projection identity. **Open:** does `@xgis/map` compose the engine camera
   or subclass it, and do the projection scalars (i) move onto the content `RenderNode` draw
   signature, or (ii) get carried as an **opaque projection token** the engine never interprets
   (the `configureProjections` precedent — content injects, engine stays blind)? Either way, raw
   `projType`/`centerLon`/`centerLat` degrees on `FrameContext` **fail §8.5** and must go. This gates
   the §4.2 `FrameContext` shape.

4. **Arena sub-range ownership** (§6.4, `engine-content-split.md` §7 risk #4). The
   `setVertexBuffer(offset, size)` mechanism landed (P0.2) but the *ownership* model is undecided:
   does `DrawItem` carry **raw `(buffer, offset, size)` triples** into engine-allocated memory (who
   validates in-bounds?), or **opaque `RhiBufferSlice` handles**? This directly shapes the frozen
   `DrawItem` shape, so it must be settled before the interface freezes.

5. **`registerRenderer` host inversion: atomic or transitional?** Does a registered pass receive
   fully resolved `RenderNode` handles by bucket id (full inversion of `PassHost`), or keep a
   narrowed host slice in a transitional phase? This determines whether `registerRenderer` and
   `registerPass` land **atomically** at P2 or can be staged. The additive-now adapter (§7.1)
   deliberately keeps the `Pick<XGISMap>` host, so the inversion is cleanly a *later* step.

6. **`pointRenderer` dual reach** (§4.3). One content node is invoked by two buckets (opaque + points,
   `pass-hosts.ts:36,57`). The registry must map bucket → node allowing a node to answer to two
   buckets. Settle before the `RenderNode` interface freezes.

7. **`_elapsedMs` ownership.** The engine frame clock (`pass-hosts.ts:31`) is consumed for *content*
   expression eval (raster/label time-animation). Charter implies engine-owned + handed down via
   `FrameContext` (§4.2). Confirm the content node reads it off the context, not off the map.

8. **Debug hooks' home** (`_pendingLabelDebugHook`, `_pendingTraceRecorder`,
   `pass-hosts.ts:67-68`). Neither pure engine nor pure render content. v1 puts them on the content
   `LabelNode` (label-subsystem internals), with the engine exposing only a generic per-pass
   diagnostic channel via `passScope`. Confirm.

9. **`heatmapRenderer` second up-reach.** It is reached by BOTH `HeatmapPassHost` (`:101`) AND
   `SceneClassifyHost` (`:110`) — so scene classification (a RenderLoop-level, non-pass concern)
   ALSO touches content. **Open:** does scene classification invert via the same `RenderNode`
   interface or a separate content-classification callback? `SceneClassifyHost`/`FrameLoopHost` are
   loop-level up-reaches NOT in `PassHost` — their inversion is a separate task from this doc's
   per-pass `RenderNode` interface.

10. **`registerProjection` home post-carve.** Stays in `@xgis/shader-dsl` (current
    `configureProjections` home, `projections.ts:46`) re-exported by `@xgis/engine`, or promoted to
    the `@xgis/engine` public surface with shader-dsl as an internal consumer? Affects the §5.1
    surface naming.

11. **`RenderTargets.ensure*` recreate-on-resize from a `PassDef`.** `render-targets.ts`
    (`ensure / ensureOit / ensureHeatmap`) was not read this pass. Confirm the exact
    recreate-on-resize semantics and whether `ensure()` is safe to call from a `PassDef.io.creates`
    allocator vs the loop — `lineRenderer.ensureOffscreen` is currently called by the LOOP
    (`render-loop.ts:450`), and §3.2 step 5 moves it into the translucent pass's `io`.

12. **Intra-opaque sub-pass granularity blocks engine-driven resolve/depth.** Opaque is ONE
    `PassDef` but emits `opaqueGroups.length` internal `beginRenderPass` sub-passes
    (`opaque-pass.ts:37-57`); only the **terminal** sub-pass may resolve (`isLastOpaque`, `:44-45`)
    or decide depth store (`:57,106`), and stencil is per-sub-pass. `io.resolve` / `io.writesDepth`
    are pass-scoped, so the engine cannot attach the resolve target or override depth-store to the
    correct *sub-pass* from `io` alone — the Phase-B centralization (§7.1) for opaque is **blocked**
    until opaque's internal loop is itself modelled (a sub-schedule the engine drives, or kept
    content-internal forever). `classifyVectorTileShows` / `groupOpaqueBySource`
    (`bucket-scheduler.ts`) were cited via `scene-view` but not read line-by-line — confirm the
    same-source sub-pass boundaries before deciding. Until then `io` describes opaque's terminal
    sub-pass only (§3.2 granularity caveat).

13. **`visibleWorldCopies` write-then-read hazard.** The label pass WRITES `ctx.visibleWorldCopies`
    (`label-pass.ts:359`) and comments say downstream opaque/line draws consume it. Verify there is
    no within-frame ordering hazard where opaque (which runs BEFORE labels) needs a value labels set
    AFTER. If real, this is a cross-pass *data* edge the `io` model must also encode.

---

## Appendix A — file:line index (this doc's anchors)

| Subject | Location |
|---|---|
| Fixed chain block | `runtime/src/engine/render-loop.ts:452-481` (hardcoded imports `:30-37`) |
| Lifecycle phases | `render-loop.ts:231,238-240` (compute), `:336-345,364-379` (beginFrame), `:490-495,501` (endFrame/resolve/submit), `:450` (loop-level ensureOffscreen) |
| `passScope` + frame error scope | `render-loop.ts:254,260-274,531` |
| `RenderPass` interface | `runtime/src/engine/render/passes/pass.ts:57-65`; `PassHost` `:46-54` |
| 8 role views (`Pick<XGISMap>`) | `runtime/src/engine/render/passes/pass-hosts.ts:23-103`; `SceneClassifyHost` `:106-110`; `FrameLoopHost` `:115-136`; `RenderLoopHost` `:141-152` |
| Pass bodies / gates | `{background:65/86-95, opaque:28/44-45/57/87-112, oit:19/26/36-48/54-57/78, translucent:19/26-27/30, points:20/28/32-41, label:158/359/1339/1344, heatmap:30/60-132, overdraw-compose:19/21-31}-pass.ts` |
| Scene-derived resolve owner | `runtime/src/engine/render/scene-view.ts:69-77`; `bucket-scheduler.ts:436-447` |
| Frame context (colorView/overdraw) | `runtime/src/engine/render/frame-context.ts:29-33` |
| `Material`/`DrawItem`/`executeItems` | `runtime/src/engine/render/material/material.ts:33-57,61-81,83-148` |
| `configureProjections` precedent | `runtime/src/engine/shaders/dsl/projections.ts:43-50`; call site `map.ts:749-750`; ladder `:307-326` |
| Polygon uniform reflected SoT | `runtime/src/engine/render/polygon-uniform-slots.ts:21-44`; packers `vector-tile-renderer.ts:11,25-28`, `renderer.ts:843-885`, `graticule-renderer.ts:157,172-192` |
| Vertex formats (`buildFormat`) | `text-vertex-format.ts:9`, `icon-vertex-format.ts:10`, `line-vertex-format.ts:20`, `point-vertex-format.ts:11`, `compiler/src/tiler/{polygon-vertex-format.ts:33/45,vertex-format.ts:62}` |
| RHI render surface (P0.1-0.4) | `runtime/src/engine/render/rhi/rhi.ts:125,133,208-212,224-250,259-268,271-313` |
| Arena sub-range binding | `vector-tile-renderer.ts:3560,3563,3567`; `gpu/gpu-arena.ts:1-60` |
| Compute (raw, types-only RHI) | `gpu/compute.ts:58,87,164,281`; `rhi.ts:224-250` |
| Bundles / pick (no RHI) | `bundle-cache.ts:78,134`; `vector-tile-renderer.ts:3571-3578`; `interaction-controller-*.test.ts` |
| Contract-test precedent | `blueprint/src/__tests__/contract.test.ts:13-35` |
