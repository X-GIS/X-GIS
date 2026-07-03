# @xgis/engine ↔ @xgis/map — the luma.gl / deck.gl split

> Engineering plan for splitting the monolithic `@xgis/runtime` into a backend-agnostic,
> content-blind **GPU engine** (`@xgis/engine`, the luma.gl analogue) and the **map content**
> (`@xgis/map`, the deck.gl analogue). Every claim is grounded in `file:line`; classification
> from a 4-area / 61-module read-only sweep (2026-06-25), spot-corroborated first-hand
> (`__xgis*ViaRhi` flag gates, `setStencilReference` at VTR 2994/3208, `PassHost = Pick<XGISMap>`
> at pass-hosts.ts:23). Companion to `package-responsibilities.md`.

## 1. The split

```
@xgis/shared ─┐         @xgis/shader-dsl  (IR + WGSL/GLSL emit, backend-NEUTRAL, content-FREE)
   (math leaf)│                 │   (leaves, unchanged)
              ▼                 ▼
        ┌──────────────────────────────────────────────┐
        │              @xgis/engine  (NEW)              │   = luma.gl
        │  backend-agnostic + content-BLIND GPU engine  │
        │  RHI(webgpu|webgl2) · device/buffer/tex/pipe  │
        │  Material/executeItems · arena/staging/ring   │
        │  render-graph (generic pass scheduler) ·      │
        │  frame loop · generic 4×4 camera · compute ·  │
        │  capability gates · DirtyTracker              │
        └───────────────────────┬──────────────────────┘
                                │  register{Renderer,Pass,Projection}()
                                │  (the configureProjections() precedent, generalized)
                                ▼
        ┌──────────────────────────────────────────────┐
        │               @xgis/map  (NEW)                │   = deck.gl
        │  CONTENT: VTR/line/point/heatmap/raster/      │
        │  graticule renderers · text/icon stages ·     │
        │  map shader graphs (shaders/dsl) · MAP        │
        │  projections (mercator/globe/azimuthal) ·     │
        │  tile data/loader/sources · style→SceneCmd    │
        └───────────────────────┬──────────────────────┘
                                ▼
        app shell  (runtime → thin: initGPU drive · resize · event bus · <xgis-map>)
```

**luma.gl/deck.gl mapping.** luma.gl = the backend-agnostic GPU framework that knows nothing
about what you draw (RHI, `Material`/`executeItems` at `material.ts:83/130`, arena, pass
scheduler, generic camera). deck.gl = the _layers_ — domain content that authors shaders +
buffers + draws via the framework. Here: **@xgis/engine = luma.gl**, **@xgis/map = deck.gl**,
and **@xgis/shader-dsl is already the luma.shadertools analogue** (content-blind shader IR).
Proof the inversion works: `shaders/dsl` is already a content-blind consumer whose only
map-coupling (the projection table) is injected — `configureProjections(PROJECTIONS)`
(`map.ts:745` → `projections.ts:45`).

## 2. @xgis/engine charter (luma.gl)

**OWNS** (backend-agnostic, content-blind — knows nothing about tiles/labels/map-projections):

| Concern                  | Modules (move in)                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| RHI contract + backends  | `render/rhi/{rhi,rhi-webgpu,rhi-webgl2}.ts`                                                                        |
| Generic draw core        | `render/material/material.ts` (`Material`/`DrawItem`/`executeItems`)                                               |
| GPU memory infra         | `gpu/{gpu-arena,frame-arena,staging-buffer-pool}.ts`                                                               |
| Device lifecycle + caps  | `gpu/gpu.ts` (device init, device-loss, feature flags)                                                             |
| Generic GPU services     | `gpu/{quality,frame-uniform,bind-tiers,gpu-timer}.ts`                                                              |
| Pipeline-state constants | BLEND__/DEPTH__/MSAA_STATE half of `gpu/gpu-shared.ts`                                                             |
| Invalidation primitive   | the `DirtyTracker` class from `state/dirty.ts` (NOT its domain enum)                                               |
| Render-graph (generic)   | SCHEDULING half of `render-loop.ts` + `passes/pass.ts` `RenderPass` interface + render-target pooling              |
| Generic camera math      | the 4×4 kernel (`mul4`/`perspectiveMatrix`/`invert4x4`/`mulVec4`) carved from `camera-helpers.ts`/`view-matrix.ts` |
| Compute dispatch         | `gpu/compute.ts` mechanics (typed on a descriptor, not on the `@xgis/compiler ComputeKernel`)                      |

**DOES NOT OWN:** tile semantics, MVT/PMTiles/GeoJSON, named map projections, label placement,
the bucket taxonomy (opaque/oit/translucent/points/labels/heatmap), any map shader graph,
style→scene. Pass _names_ (`oitAccum`/`heatmapAccum`) + bucket _order_ are content config
injected through the register API, not engine code.

## 3. @xgis/map charter (deck.gl)

| Concern                       | Modules (move in)                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderers                     | `vector-tile-renderer`, `line-renderer`, `point-renderer`, `heatmap-renderer`, `raster-renderer`, `graticule-renderer`, `renderer` (legacy MapRenderer)                                     |
| Per-primitive Draper adapters | `material/{raster,point,line,text,icon,heatmap}-material.ts` (carry the map shader-graph imports)                                                                                           |
| Text/icon stages              | `text/*`, `sprite/*`                                                                                                                                                                        |
| Map shader graphs             | `shaders/dsl/*` (cleanest target — already backend-neutral, zero raw-GPU)                                                                                                                   |
| MAP projections               | `projection/{projection,projections-table,globe,ecef,globe-anchor,earth-surface-fill}.ts` + the projection-inverse builders carved from `view-matrix.ts`/`camera-helpers.ts`/`unproject.ts` |
| The map camera                | `projection/camera.ts` (centerX/Y = Mercator metres, projType) — keeps lon/lat/zoom/projType + matrix selection; delegates the 4×4 algebra to engine                                        |
| Pass BODIES                   | `passes/{opaque,oit,translucent,points,heatmap,label,background,overdraw-compose}-pass.ts`                                                                                                  |
| Scene classification          | `scene-view.ts` (bucket taxonomy), the map half of `frame-context.ts`                                                                                                                       |
| Tile data + loaders           | `data/*`, `loader/*`                                                                                                                                                                        |
| Resource builders             | `pipeline-factory.ts`, `bind-group-registry.ts`, `bucket-scheduler.ts`, `gpu-tile-store.ts`, `bundle-cache.ts`, `feature-data-binder.ts`, `uniform-ring.ts`, `reflection-to-webgpu.ts`      |
| Style→scene                   | `interpreter.ts` (AST→SceneCommands), the content half of `map.ts`                                                                                                                          |

## 4. The engine ↔ content interface

The register API already exists in prototype — `material.ts` is the render-node API and
`configureProjections()` is the registration precedent. Generalize both:

```
engine.registerProjection(ProjectionSpec[])   // exists today (configureProjections)
engine.registerRenderer(name, RenderNode)     // VTR/line/point/heatmap/raster/graticule
engine.registerPass(PassDef)                  // ordered bucket chain → DATA-DRIVEN
```

`PassDef[]` replaces the inline 8-step chain at `render-loop.ts:455-481`; the _order + identity
of buckets_ become @xgis/map config, not engine code.

**Stable seam — frozen byte contracts:** vertex-format byte layouts (`TEXT_FORMAT`/`ICON_FORMAT`
already sourced from `@xgis/compiler buildFormat` — the model), the 256-byte polygon `Uniforms`
std140 contract (now reflected via `polygonUniformSlots()` — the reflection IS the contract),
`RhiBindLayoutEntry` shapes (with the optional `name` for WebGL2 by-name reflection), pass identity.

**Critical seam fix:** Draper batches today still carry RAW `GPUBuffer`/`GPUBindGroup`
(`point-material.ts:18-24`, wrapped via `wrapWebGpu*` at the call site). The seam isn't closed
until batches carry `Rhi*` handles — resource builders must build via `rhi.createBuffer`/
`createBindGroup`, not `device.create*` + wrap.

## 5. Prerequisite: complete the RHI (the gate)

**Key insight:** the RHI is _more complete than "only raster routes through it" but DEAD-by-
default_ — every primitive HAS a Draper, gated behind a `globalThis` flag (OFF in production):
`point-renderer.ts:534` (`__xgisPointViaRhi`), `line-renderer.ts:638` (`__xgisLineViaRhi`),
`heatmap-renderer.ts:423` (`__xgisHeatmapViaRhi`); raster ships raw `render()` (`:289`), only
`renderRhiChecker()` (`:251`, the `?forcegl2=1` slice) is RHI-routed. So "complete the RHI" =
**flip the defaults + delete the raw else-branches + fill the contract gaps**, not "build it".

**rhi.ts contract extensions required (blast order):**

1. **setStencilReference + real stencil states.** VTR per-tile clip-mask calls
   `pass.setStencilReference(1/0)` (`vector-tile-renderer.ts:2994/3208`); `rhi-webgpu.ts:191-194`
   hardwires stencil INERT; `RhiRenderPass` has no `setStencilReference`. **VTR blocked until this.**
2. **Offscreen / MRT begin-pass.** `RhiDevice` owns only single-sample `beginScreenPass`. The
   whole `passes/` topology (opaque pick `@location1`, OIT accum+revealage MRT, MSAA resolve,
   offscreen MAX line pass, heatmap 3-pass r16float) stays raw `encoder.beginRenderPass`.
3. **`setVertexBuffer(slot, buffer, offset, size)`** — VTR binds shared arena sub-ranges.
4. **Compute** — no `RhiCompute`; VTR feature-data prepass + `ComputeDispatcher` are raw.
5. **Render bundles** — `bundle-cache.ts` records `GPURenderBundleEncoder`; RHI has none.
6. **Pick readback** — RG32Uint MRT + buffer readback is raw.

**WebGL2 capability gates the engine must own:** GLSL-source required (`rhi-webgl2.ts:391`
throws without `vsCode/fsCode`); storage SSBO → R32F data-texture emulation; no compute / no
MRT in slice-1; no timestamp; `float32Filterable` gate.

## 6. Staged migration

Each phase independently shippable + green. Gates: **byte-identity** (snapshot WGSL/uniform-pack),
**real-GPU pixel-diff** (DC>0, D1<D0 + 16-split per CLAUDE.md §5), **strict `tsc --build`**.

| Phase  | Work                                                                                                                                                                                                                                                            | Delivers                                                 | Blast                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------- |
| **P0** | Extend `rhi.ts` (setStencilReference, beginRenderPass/MRT, setVertexBuffer offset/size, RhiCompute, render-bundle) + WebGPU impl, WebGL2 fail-close                                                                                                             | RHI expressive enough for VTR + passes                   | LOW (additive)             |
| **P1** | Flip every Draper default ON; route VTR fill/stroke/extrude through Material+RHI; delete raw else-branches; close batches onto `Rhi*` handles                                                                                                                   | **All draws through the RHI → backend-agnostic in fact** | HIGH                       |
| **P2** | Carve `@xgis/engine` out of runtime (no content): RHI, Material, gpu/ infra, DirtyTracker, generic 4×4 camera, scheduling + register API. **Invert `PassHost` from `Pick<XGISMap>` to a content-supplied RenderNode**; make the chain data-driven (`PassDef[]`) | content-blind engine package                             | HIGH                       |
| **P3** | Extract `@xgis/map`: renderers + Drapers + `shaders/dsl` + map projections + `data/`/`loader/` + style→scene; wire via register API; split `gpu-shared`/`frame-context`/`scene-view`; split god-file `map.ts` (~3600)                                           | the deck.gl content package                              | HIGH (mechanical after P2) |
| **P4** | runtime → thin app shell (initGPU drive / rAF / resize / event bus / `<xgis-map>`)                                                                                                                                                                              | the app layer                                            | LOW                        |

**WebGL2-as-real-fallback timing:** **P1** = primitive-level WebGL2 (point/line/heatmap once
storage→data-texture is proven; raster already proven). **End of P2** (data-driven pass chain on
RHI targets) = **full-frame WebGL2 fallback** — the map's MSAA-resolve + OIT + pick + stencil
clip-mask topology must originate through the RHI first.

## 7. Risks & open questions (the hard seams)

1. **The fixed map-shaped pass chain.** `render-loop.ts:455-481` hardcodes the map's 8-step layer
   model; `PassHost = Pick<XGISMap>` (`pass-hosts.ts:23-150`) — the engine reaches UP into the
   content class BY TYPE. **#1 extraction blocker.** Open: does `PassDef[]` need ordering
   _dependencies_ (heatmap-after-labels owns the MSAA resolve, `render-loop.ts:472`), or is a flat
   ordered list enough? The MSAA-resolve-owner coupling must be engine render-graph metadata.
2. **Projection generic/map split.** `camera.ts` IS the Web-Mercator camera (centerX/Y = Mercator
   metres), and the generic 4×4 algebra is INTERLEAVED with map-projection inverses in the same
   files. A deep carve, not a lift. Open: does @xgis/engine ship a generic camera that @xgis/map
   _composes_, or does @xgis/map subclass it? The Mercator-metre position can't live in a generic camera.
3. **Shared vertex-format byte contracts.** `TEXT_FORMAT`/`ICON_FORMAT` are the good model, but the
   256-byte polygon `Uniforms` is hand-packed in THREE places (`vector-tile-renderer.ts:23-26`
   reflected SoT, but `renderer.ts:842-880` + `graticule-renderer.ts:145-174` literal-offset copies).
   Converge all packers onto the DSL-reflected SoT _before_ freezing the interface (drift = every
   poly draw corrupted).
4. **Arena / uniform-ring ownership.** Clean engine leaves, but VTR binds shared arena _sub-ranges_
   by offset — content reaches into engine-allocated memory. First-class RHI sub-range op (gap #3)
   vs content-owned slices?
5. **Compute + render-bundle have no RHI path.** WebGPU-only today; on WebGL2 must fail-close to a
   non-bundled, non-compute path. Correct-first, perf-later.
