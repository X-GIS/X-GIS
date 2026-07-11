# map → engine — content-blind GPU substrate promotion (EPIC #991)

> **Execution plan** for EPIC #991: promote every content-blind GPU primitive still trapped
> under `map/src/render/**` into `@xgis/engine`, **generalized** (not lifted) per the EPIC's
> mandate. Companion to `engine-content-split.md` (the original luma.gl/deck.gl carve, P0–P4 —
> done: the `@xgis/engine` + `@xgis/map` packages exist today) and `package-responsibilities.md`.
>
> **Scope of THIS doc.** The EPIC issue is the _what_ — a two-sweep audit (77 map→engine
> findings + 5 engine-layer violations), per-phase source `file:line`s, the leak table, the gap
> table. This doc is the _how_: the **dependency DAG** that fixes phase order, the **PR
> sequence** (incl. parallel tracks), the **enforcing ratchet** the EPIC under-specifies, the
> **generalized surface** each move must land (the "strip X-GIS" shape, not the source shape),
> the **per-phase verification gate**, and the **Socratic boundary self-critique** that rejects
> the lift-and-shift version of each move _before code exists_. Architect pass per the
> `author-architect-refactor` skill — **no code changes land with this doc.**

---

## 1. Current tree state (grounded — the starting line)

| Fact                                                                                                                                         | Evidence                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `@xgis/engine` + `@xgis/map` packages already exist (prior carve done).                                                                      | `engine/package.json` deps = `{rhi}`; `map/package.json` deps include `engine`, `rhi-webgpu`, `rhi-webgl2`, `geo`, … |
| Engine is **compiler-enforced backend-neutral** — `types: []`, so any `GPU*` identifier in `engine/src` is a compile error.                  | `engine/src/index.ts` header                                                                                         |
| Dependency direction is **ratchet-enforced** (`engine: [rhi, shader-dsl, shared]`; `map: [everything]`).                                     | `engine/src/dependency-direction-ratchet.test.ts:34-61`                                                              |
| The two engine-layer dep violations (EPIC 0.3 / 0.4) are **already pinned baselines**, shrink-only.                                          | `dependency-direction-ratchet.test.ts:69-84` — `['rhi-webgpu','compiler']`, `['rhi-webgpu','engine']`                |
| Engine geo-freedom is separately ratcheted (Gate-7).                                                                                         | `runtime/src/engine/architecture-invariants.test.ts:107-115`                                                         |
| **`Material` is genuinely content-blind already** — imports only `@xgis/engine` RHI types, zero geo.                                         | `map/src/render/material/material.ts:15-24`                                                                          |
| **`UniformBlock.of(struct).write({…})` exists** — the DSL-struct-as-single-layout-authority primitive (the 0.5 drift-killer).                | `engine/src/render/uniform-block.ts:188,195`                                                                         |
| The `bakeTileToTexture` RTT scaffold is already RHI-clean (`createCommandEncoder`→`createTexture`→`beginRenderPass`→`executeItems`→destroy). | `vector-tile-renderer.ts:737-873` (executeItems `:851`)                                                              |

### 1.1 The gap the EPIC under-specifies — there is NO raw-WebGPU gate on `map/src`

Engine neutrality is compiler-enforced (`types: []`); **`map/src` is not** (`@xgis/map` legitimately
depends on `rhi-webgpu`). The old _per-identifier_ webgpu-neutrality ratchet was **deleted** once
engine neutrality moved to the compiler (`dependency-direction-ratchet.test.ts:12-15` — "Successor to
the deleted per-identifier webgpu-neutrality ratchet #833 M1"). **Consequence: every raw-WebGPU leak
this EPIC closes is currently un-gated.** "Byte-identical, leak-closed" is a _claim_ with nothing
mechanical behind it.

**Architect deliverable #1 (see §4): establish a shrink-only raw-WebGPU ratchet over `map/src`
UP FRONT — seeded with the full current leak set as BASELINE — so each phase's PR mechanically
shrinks it.** Adding the gate only at close-out (as the EPIC checklist implies) means nothing
enforces per-phase progress; a leak silently reopened between phases would pass CI.

---

## 2. Dependency DAG — what fixes phase order

Not all 8 phases are a chain. The hard edges (X blocks Y) are few; most phases are independent
tracks gated only by their own RHI gap-fill. Foundational primitives and gap-fills move first
because a later phase cannot consume a primitive still trapped in map, nor route a call through an
RHI wrapper that doesn't exist yet.

```
        ┌─────────────────────────────────────────────────────────────┐
        │  P0  engine self-fixes (0.1–0.5)   ── independent, do first  │
        │      (clean the promotion TARGET before promoting into it)   │
        └─────────────────────────────────────────────────────────────┘

  P1 ─────────────────────────────┐         (Material → engine; zero blockers)
  Material/executeItems/desc-triad │
                                   ▼
        G2 (swapchain) ┐     ┌──► P5  render-graph: RenderNode sched
        G3 (RhiEncoder)┼─► P4 │        + FullscreenComposePass
        resolveTarget  ┘  Frame│        + RenderToTexturePass/bakeToTexture ──► #599
                        Context │
                        RenderT.└──► P6  PipelineFactory + per-renderer
                                        create*/writeBuffer/bindGroup → RHI
                                        (needs G1, G9, G11)  ──► P7 residual leaks

  G10 (region upload) ──► P3  atlas → engine AtlasTexture      (independent track)
  G4/G5/G7/G8 ─────────► P7  readback/staging/compute/timestamp; drop unwrapBuffer
  G6 (BufferPool) ─────► P8  GpuTileStore pool → RHI           (independent track)
  (soft: perf-marks)  ─► P2  UniformRing → engine              (independent track)
```

**Hard edges (must respect):**

- **P1 → P5** — `RenderToTexturePass`/`bakeToTexture` and `FullscreenComposePass` are built on
  `Material`+`executeItems`; they can't live in engine until P1 lands the draw backbone there.
  _(This is the EPIC's raison d'être: the generic bake primitive is stuck in map because a generic
  primitive it depends on is stuck in map.)_
- **P4 → P5** — a `RenderNode.execute` runs against RHI-typed frame context; needs P4's retype.
- **P4 → P6** — the 13 `ctx.encoder.beginRenderPass` + 5 `device.createBindGroup` pass-site leaks
  can't route through the RHI until `FrameContext` carries `RhiCommandEncoder`/`RhiTextureView`.
- **gap → phase** — a phase cannot start before the RHI wrapper it depends on exists (below).

**Soft / non-edges (do NOT serialize these — the EPIC's "each phase independently shippable"):**

- P2 (UniformRing) — only blocker is a `../__profile__/perf-marks` import; independent of P1/P4.
- P3 (atlas), P7 (async primitives), P8 (BufferPool) — separate subsystems; each gated only by its
  own gap-fill, not by another phase.
- P0 — touches the engine itself + `map/render/frame-uniform.ts`; independent of the primitive moves.

### 2.1 Gap → phase → what it unblocks

Every gap is a genuinely _missing_ RHI wrapper; it is its own small additive sub-PR that lands
**before** the phase that consumes it. (Full gap descriptions: EPIC "RHI / engine gaps" table.)

| Gap     | One-line                                                                                      | Unblocks                                                    | Land before                     |
| ------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------- |
| **G2**  | WebGPU swapchain acquire / screen-pass wrapper                                                | `render-loop.ts:263` raw `getCurrentTexture().createView()` | P4                              |
| **G3**  | `FrameContext` carrying `RhiCommandEncoder`+`RhiTextureView`; `RenderTargets` as `RhiTexture` | every pass reading raw ctx                                  | P4                              |
| **G1**  | adopt foreign `GPUTexture` → `RhiTexture` (`wrapWebGpuTexture`)                               | `raster-material.ts` union field                            | P6 (P4 for raster union)        |
| **G9**  | `createPipelineAsync` (RHI create is sync-only)                                               | `pipeline-factory.ts:1104-1273`                             | P6                              |
| **G11** | WebGL2 offscreen/MRT topology                                                                 | gl2 pick@loc1 / OIT / MAX-blend                             | P6                              |
| **G10** | region external-image upload `copyExternalImage(…, dstX, dstY)`                               | `host-sprite-atlas-rhi.ts` CPU-decode                       | P3                              |
| **G4**  | async texture→CPU `readbackTexture(): Promise` + pool                                         | `interaction-controller.pickAt`; `GPUTimer.pollReadbacks`   | P7                              |
| **G5**  | async staging-upload ring                                                                     | `upload-coordinator.ts` AsyncWriteSink                      | P7                              |
| **G7**  | compute create/dispatch (contract inert today)                                                | `ComputeDispatcher` bypass                                  | P7                              |
| **G8**  | opaque `RhiTimestampWrites` + `RhiProfiler`                                                   | `GPUTimer` raw                                              | P7                              |
| **G6**  | resident bucketed `BufferPool`                                                                | `gpu-tile-store.ts` hand-rolled recycler                    | P8                              |
| **G12** | _(consequence)_ `unwrapBuffer` casts                                                          | —                                                           | deleted when G4+G5 land (in P7) |

---

## 3. Recommended PR sequence

Ordered by **leverage × unblock-count**, respecting the DAG. Each row is ≥1 PR with its own green
gate; earlier rows never depend on later ones. Independent tracks (B/C/D/E/F) may interleave with the
critical path in any order once their gap lands — assign to parallel author passes if desired.

| #   | PR                                                                                                     | Track | Depends on      | Unblocks                  | Est. blast                 |
| --- | ------------------------------------------------------------------------------------------------------ | ----- | --------------- | ------------------------- | -------------------------- |
| 0   | **Ratchet up-front** ✅ **landed #993** — raw-WebGPU-in-`map/src` gate, BASELINE 555/44 (§4)           | —     | —               | mechanical per-phase gate | LOW (test only)            |
| 1   | **P0** engine self-fixes 0.1–0.5 (may split: 0.1+0.5 FrameUniform; 0.2 doc; 0.3/0.4 ratchet burn-down) | B     | —               | clean promotion target    | MED                        |
| 2   | **P1** `Material`+`executeItems`+`{MaterialDesc,PipelineVariant,DrawItem}` → engine                    | A     | —               | **P5**                    | HIGH (14 files, 32 sites)  |
| 3   | **P2** `UniformRing` → engine                                                                          | C     | —               | —                         | MED (~15 files)            |
| 4   | **G2+G3** gap-fill sub-PR (swapchain + RhiEncoder ctx)                                                 | A     | —               | P4                        | LOW (additive)             |
| 5   | **P4** `FrameContext` RHI-retype + `RenderTargets` → engine                                            | A     | G2, G3          | **P5, P6**                | HIGH (structural root)     |
| 6   | **P5** `RenderNode` sched + `FullscreenComposePass` + `RenderToTexturePass` → engine                   | A     | P1, P4          | **#599**                  | MED (4→1 compose, 9 nodes) |
| 7   | **G10 → P3** atlas → engine `AtlasTexture` (+ neutral `AtlasSlotInfo`)                                 | D     | G10             | —                         | MED                        |
| 8   | **P6** `PipelineFactory`/`compose-pipelines`/per-renderer create\* → RHI                               | A     | P4 (+G1,G9,G11) | P7 residual               | HIGH (~150 sites/16 files) |
| 9   | **G4/G5/G7/G8 → P7** readback/staging/compute/timestamp; delete 3 `unwrapBuffer`                       | E     | those gaps      | —                         | HIGH                       |
| 10  | **G6 → P8** resident `BufferPool`; `GpuTileStore` pool off raw GPU                                     | F     | G6              | —                         | MED                        |
| 11  | **Close-out** — full gate + CI; ratchet BASELINE == ∅ for `map/src`; close #991                        | —     | all above       | —                         | LOW                        |

**Why P1 before P4 despite P4 being the "structural root":** P1 has **zero blockers** and unblocks
P5 on its own; P4 needs G2+G3 built first. Shipping P1 early banks the foundational win and lets P5
proceed the moment P4 lands. **Why P0 first:** you cannot cleanly promote primitives _into_ an engine
that itself leaks content (0.1) and splits layout authority (0.5) — fix the target before filling it.

---

## 4. The enforcing ratchet (architect deliverable — establish in PR #0)

Mirror the existing `#929` dependency-direction ratchet convention exactly: a **shrink-only
BASELINE**, where removing the last leak of a kind **must** delete its baseline entry in the same
commit (a stale entry fails the test). This converts every phase's "leak-closed / byte-identical"
from a claim into CI.

**Design (as landed — `map/src/raw-webgpu-ratchet.test.ts`, PR #993):**

- **Location:** `map/src/raw-webgpu-ratchet.test.ts` — **not** an extension of
  `runtime/src/engine/architecture-invariants.test.ts`. That file walks
  `runtime/compiler/blueprint/shared` only; it does **not** walk `map/src` (an earlier draft of this
  doc claimed it did — it does not). `map/src/**/*.test.ts` rides the confirmed `test (map)` CI leg
  (`vitest map/src`, `test.yml`), so a map-scoped gate is guaranteed to run and is co-located with what
  it guards — no CI-dark risk, and no runtime→map reach.
- **Scan (comment-stripped):** count, per file, native `GPU[A-Z]\w*` identifiers (types **and** the
  global-constant namespaces `GPUShaderStage`/`GPUBufferUsage`/`GPUTextureUsage`/`GPUMapMode`/
  `GPUColorWrite`) + `unwrapBuffer`, **excluding** X-GIS-own GPU-prefixed names
  (`GPUArena*`/`GPUTimer`/`GPUContext`/`GPUTile*`). This single unambiguous signal beats the raw
  method-name list a first draft proposed: RHI methods share names with WebGPU ones
  (`createComputePipeline` is both a raw call **and** the G7 gap-fill's RHI method), so matching method
  names would flag correct routing after a gap lands. `GPU*` never appears in the RHI (always `Rhi*`),
  and the native-type declaration is the structural anchor — retyping `GPUDevice → RhiDevice` breaks
  every raw call on the handle at compile time, so tracking the **type** footprint transitively forces
  the call-site fixes.
- **BASELINE:** seeded with the exact current footprint — **555 tokens / 44 files** (measured, not the
  EPIC table's site list, which under-counts: it lists sites, this counts tokens incl. type-decl
  leaks in `*-types.ts`). Cross-checked accurate: `unwrapBuffer` = 3 (EPIC's "3 casts"),
  `frame-context.ts` = 4 (EPIC's P4 four GPU-typed fields).
- **Strict-equal, both directions:** `actual > baseline` = new leak (fix it); `actual < baseline` =
  win not locked (lower the baseline in the same commit). A ceiling-only gate would permit silent
  re-growth up to the cap — the exact failure §1.1 names.
- **Per phase:** the phase PR deletes the leaks it closes **and** lowers the matching baseline rows in
  the same commit. Close-out asserts the `map/src` baseline is empty.

**Reject:** a boolean "any leak?" gate (can't ratchet down incrementally); a close-out-only gate (no
per-phase enforcement); a ceiling-only gate (permits silent re-open); a method-name signal (collides
with RHI gap-fills). **Accept:** per-file-count, strict shrink-only, seeded up front.

---

## 5. Per-phase generalized surface + gate

The EPIC's `file:line`s are the **source**, never the destination shape. Below is the _landed
surface_ each phase must produce (the "strip X-GIS" API) and its gate. Shared verification protocol
in §7.

### P0 — engine self-fixes (0.1–0.5)

| #         | Landed shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0.1 / 0.5 | Engine keeps a **generic** frame uniform: `mvp: mat4x4f` + a **pixel** viewport `(w_px, h_px, dpr, _)`. The map-specific lanes (`proj_params` = type/centerLon/centerLat/log*depth_fc; **`meters_per_pixel`**) move to `@xgis/map`, composed onto the struct **via `UniformBlock.of(FrameUniform)`** so the DSL struct is the \_single* layout authority and the CPU writer packs _through_ it (kills the hand-locked `setFrame()` byte-lanes). Engine owns the **mechanism** (`UniformBlock`); map owns the **schema**. |
| 0.2       | Prune stale `shaders/projections.ts`/`cpu-projections.ts`/`ecef.ts` sections from `shader-dsl/src/AGENTS.md` — doc-only, matches the already-CONTENT-FREE barrel.                                                                                                                                                                                                                                                                                                                                                        |
| 0.3       | Relocate `ComputeKernel`/`ShaderVariant`/`VertexFormat` contract types onto `@xgis/rhi` seams; pass palette as **neutral descriptors** (not `PackedPalette`/`GRADIENT_WIDTH` value imports). Delete `['rhi-webgpu','compiler']` baseline in the same commit.                                                                                                                                                                                                                                                             |
| 0.4       | Finish #834 M5 context neutralization → neutral seam / composition-root injection for `RenderContext`/`BackendChoice`. Delete `['rhi-webgpu','engine']` baseline in the same commit.                                                                                                                                                                                                                                                                                                                                     |

**Gate:** `bun run build` (0 new TS); dep-direction ratchet green with **two fewer** baseline rows;
frame-uniform byte layout **snapshot-identical** (128 B; the pack-through-`UniformBlock` must emit the
same bytes — prove with a uniform-pack snapshot test, not eye). Render-gate byte-identical.

### P1 — `Material` draw backbone → engine

**Landed shape:** `Material`, `executeItems`, `MaterialDesc`, `PipelineVariant`, `DrawItem` in
`@xgis/engine` (`engine/src/render/material.ts`), re-exported from `engine/src/index.ts`. Type surface
moves **verbatim** (already RHI-only). **Comments rewritten** to name GPU concepts, not
raster/line/polygon examples (see §6). `map/src/render/material/material.ts` becomes a pure
`export * from '@xgis/engine'` **re-export shim** (external playground proofs keep importing from
`@xgis/map`); the 12 builders switch their import to `@xgis/engine`.

**Gate:** build 0-new-TS (watch TS6133 orphaned re-export); vitest (material + executeItems tests
travel to engine, decoupled from geo fixtures); render-gate byte-identical; dep-ratchet green
(no new edge — `map→engine` already allowed); raw-WebGPU baseline unchanged (Material had none).

### P2 — `UniformRing` → engine

**Landed shape:** `UniformRing` in `engine/src/render/uniform-ring.ts` — growable per-draw uniform
ring; `slotSize/capacity/label/onGrow` caller-supplied; backend-neutral on RHI. The lone
`../__profile__/perf-marks` coupling: **inject** a generic `onGrow`/marker callback (map supplies the
perf-mark), or drop the mark. Do **not** move perf-marks into engine.

**Gate:** build/vitest green; **DC=0 over a 10 s hard-settle** frame (per-frame ring is hot-path —
prove zero behavior drift); zero per-frame alloc regression (commit-vs-revert numeric check, §7);
dep-ratchet green.

### P3 — atlas primitives → engine `AtlasTexture` (needs G10)

**Landed shape:** **one** `AtlasTexture` in engine, consumed by **both** sprite and glyph (unify
`GlyphAtlasGPU` + `HostSpriteAtlasRhi`). Map's `SpriteInfo` lifts to a neutral `AtlasSlotInfo` +
structural `DirtySource` interface. `HostAtlasPacker`+`HOST_ATLAS_PAGE` + the `IconRenderer.setDraws`
quad-batcher generalize (page size caller-supplied). G10 (`copyExternalImage(tex, bitmap, w, h, dstX,
dstY)`) lands first so the atlas uploads a sub-region instead of CPU-decoding.

**Gate:** one engine `AtlasTexture`; **no** raw atlas twin left (`sprite-atlas-gpu.ts` /
`host-sprite-atlas-gpu.ts` native branches dropped → baseline shrinks); render-gate byte-identical
(glyphs + icons); build/vitest green.

### P4 — `FrameContext` RHI-retype + `RenderTargets` → engine (needs G2, G3)

**Landed shape:** `FrameContext` **stays in map** (it transports the map `ProjectionToken`, #929 C);
only its GPU fields retype: `device: GPUDevice → RhiDevice`, `encoder → RhiCommandEncoder`,
`screenView/colorView → RhiTextureView`. `render-loop.ts:262-263` mint the encoder + acquire the
swapchain **through the RHI** (G2/G3). `RenderTargets` **moves to engine** over `RhiTexture`, with
**neutral** target identity (map supplies which targets — no hardcoded `pickTarget`/`oitAccum`
names); MSAA resolve via `RhiColorAttachment.resolveTarget`.

**Gate:** no raw GPU **type names** in `map/src/render/**` core (baseline shrinks by the ctx/loop
rows); both backends render byte-identical (this is the WebGL2-fallback-critical retype); build/vitest.

### P5 — render-graph on RHI (needs P1, P4) → unblocks #599

**Landed shape:** in engine — (a) linear pass-chain **scheduler** + `RenderNode {label, shouldRun,
execute}` where **`execute` takes a NEUTRAL RHI context**, not map's `FrameContext`; (b) one
**`FullscreenComposePass`** driven by a neutral compose descriptor (shader + blend + bindings),
collapsing the 4 copy-pasted bodies + the offscreen line translucent/composite; (c) a
**`RenderToTexturePass` / `bakeToTexture(material, items, sizePx)`** = the RTT scaffold only. The bake
body's **geo core stays in map** (tile-local Merc MVP, dequant, `tileZoom`, `sphereR`).

**Gate:** 4 compose sites + both offscreen-line paths call the **one** helper; **#599 drape imports
`bakeToTexture` from `@xgis/engine`** (the acceptance proof); `line-composite draw()` raw variant
deleted (baseline shrinks); render-gate byte-identical.

### P6 — pipeline-creation + per-renderer leaks → RHI (needs P4; G1/G9/G11)

**Landed shape:** **classes stay in map**; only the create _mechanism_ routes through RHI.
`PipelineFactory` ~43 raw → `rhi.createPipeline`/`createBindGroupLayout`/…; `compose-pipelines.ts` 16
raw (folded into `FullscreenComposePass`); each per-renderer cluster (`renderer.ts`,
`heatmap-renderer.ts`, `line-renderer.ts`, `feature-data-binder.ts`, `point-renderer.ts`,
`graticule-renderer.ts`, `frame-uniform.ts`, `color-ramp.ts`, …) → `rhi.*`. The **descriptors**
(fill/ground/extrude/pattern/OIT variants, style-keyed) stay in map.

**Gate:** `grep -E '\.device\.(create|queue)|GPUShaderStage|GPUBufferUsage|GPUTextureUsage'
map/src/**` returns **only** residual gap-blocked sites (closed in P7); baseline shrinks by ~150;
render-gate byte-identical **per file** (route one cluster, verify, next).

### P7 — async primitives (needs G4/G5/G7/G8) → delete `unwrapBuffer`

**Landed shape:** `RhiDevice.readbackTexture(): Promise<…>` (**format-neutral** — map interprets the
RG32Uint pick bytes) + `RhiReadbackPool`; async staging-upload primitive; compute create/dispatch
**typed structurally over the shader-dsl IR, NOT `@xgis/compiler ComputeKernel`** (ties to 0.3 — do
not reintroduce that edge); `RhiTimestampWrites` + `RhiProfiler`. `pickAt` / `AsyncWriteSink` /
`ComputeDispatcher` / `GPUTimer` route through these; **all 3 `unwrapBuffer` casts deleted (G12)**.

**Gate:** no `mapAsync`/`copyTextureToBuffer`/`copyBufferToBuffer`/`createComputePipeline`/
`timestampWrites` raw in `map/src`; zero `unwrapBuffer`; behavior unchanged (pick round-trips
identical; profiling numbers present); baseline shrinks.

### P8 — resident `BufferPool` (needs G6)

**Landed shape:** general `BufferPool` in `rhi-webgpu` (bucketed pow-2 acquire/release over
`rhi.createBuffer`/`destroyBuffer`). `GpuTileStore` **class stays in map** (content-aware LRU keyed
`${tileKey}|${sourceLayer}`, byte-aware compaction) but drops `private device: GPUDevice` + its raw
recycler. **Track slot size in the pool** (the pool knows what it allocated) rather than widening the
opaque `RhiBuffer` with `.size`/`.usage`. RHI-type `UploadCoordinatorStore.acquireBuffer` (+ 3 test
doubles).

**Gate:** `GpuTileStore` holds no raw `GPUDevice`/`GPUBuffer` (baseline shrinks by its rows); contract
RHI-typed; render-gate byte-identical; no per-frame alloc regression.

---

## 6. Socratic self-critique — reject the weak version _before_ code

For each risky boundary: the **weak (lift-and-shift) version**, why it fails the "strip X-GIS" /
single-authority bar, and the **version we accept**.

1. **P1 `Material` — "it's already RHI-only, just `git mv` it."**
   The _type surface_ is genuinely generic and moves verbatim. But the file's **doc-comments encode
   map content** ("raster's per-tile slot", "line: fs*line vs fs_line_pattern", "polygon extrude
   swaps vs_main_ecef_extruded", "the VTR fill fallback variants"). Ship those verbatim and the
   engine's flagship primitive \_documents itself in map vocabulary* — the "map's lower half wearing an
   engine label" failure the mandate names. **Reject** copying the comment examples as contract.
   **Accept:** move the types unchanged; **rewrite comments** to GPU concepts ("optional pooled
   per-item uniform slot", "a variant may override the fragment entry", "optional per-tile stencil
   state") with map cases at most as `e.g.` illustrations.

2. **P1 re-export shim — dual authority smell.**
   A shim that _re-declares_ `Material`/`DrawItem` in map = two authorities = drift. **Reject** any
   shim with its own type bodies. **Accept** only a pure `export * from '@xgis/engine'`; add a
   baseline note so close-out can retire it once the 2 external playground proofs migrate.

3. **P0 0.1 — "delete `proj_params` from the engine struct, add it in map."**
   Two structs of the same 128-byte buffer = the exact split-authority 0.5 warns about; a lane
   reorder in one silently corrupts every draw. And is `meters_per_pixel` content? **Yes** — it's a
   Mercator-scale quantity; keeping it in a "generic" viewport fails the strip test on a single float
   lane. **Reject** two structs and **reject** `meters_per_pixel` in the engine viewport. **Accept:**
   engine viewport = pixels only `(w_px,h_px,dpr,_)`; map composes `mvp+viewport+proj_params` as **one**
   struct through `UniformBlock.of(...)`, the DSL struct the sole layout authority — one buffer, one
   pack path.

4. **P4 — "`FrameContext` is generic frame state; move it to engine."**
   It carries the opaque `ProjectionToken` — map content by construction (#929 C moved it to map
   deliberately). Move it and the engine re-acquires a projection vocabulary it spent #781 shedding.
   **Reject** relocating `FrameContext`. **Accept:** it stays in map; only its GPU **handle fields**
   retype to RHI. What moves is `RenderTargets` — and only if its target identity is **neutral** (map
   names the buckets); **reject** a `RenderTargets` hardcoding `pickTarget`/`oitAccum`.

5. **P5 `RenderNode.execute(ctx)` — "pass the `FrameContext` through."**
   Then the engine scheduler's node signature names map's context (+ its `ProjectionToken`) → engine
   reaches up into content by type. **Reject.** **Accept:** `execute(rhiCtx)` where `rhiCtx` is
   engine-typed (encoder + views + viewport); map's concrete nodes close over their own
   `FrameContext`. The scheduler orders opaque nodes; it never reads geo.

6. **P5 `FullscreenComposePass` — "one class, `if (oit) … else if (heatmap) …`."**
   A compose pass with a branch per map bucket is 4 bodies in a trench coat, not a primitive.
   **Reject** any bucket-named branch. **Accept:** one pass driven by a neutral descriptor
   `{shader, blend, bindings}`; map supplies 4 configs. Strip test: "fullscreen textured quad, configurable
   blend + shader" is a real engine primitive; "the OIT compose" is not.

7. **P5 `bakeToTexture` — "lift the whole `bakeTileToTexture`."**
   Its body computes a **tile-local Mercator MVP**, dequantizes, reads `tileZoom` and
   `activeBody().sphereR` — pure geo. Lift it and the engine grows a tile projection. **Reject.**
   **Accept:** `bakeToTexture(material, items, sizePx)` = encoder→texture→beginRenderPass→
   executeItems→destroy **only**; map computes the tile material + draw items and passes them as
   opaque handles.

8. **P6 — "move `PipelineFactory` to engine, it builds pipelines."**
   It embeds **MapLibre-style-keyed variant selection** (fill/ground/extrude/pattern/OIT) — content.
   **Reject** relocating the class. **Accept:** class stays in map; only `device.createRenderPipeline`
   → `rhi.createPipeline`. The generalization is bounded by RHI expressiveness — if a create* needs a
   capability the RHI lacks (async = G9, gl2 MRT = G11), that's a **gap to fill or fail-closed**, not a
   reason to leave the leak. **Reject** declaring P6 done with a create* still needing an unfilled cap.

9. **P7 compute — "wire `ComputeDispatcher` behind RHI using `ComputeKernel`."**
   `ComputeKernel` is a `@xgis/compiler` type; importing it into `rhi-webgpu` **reopens baseline 0.3**
   that P0 just burned down. **Reject.** **Accept:** compute descriptor **structural over the
   shader-dsl IR** (the pattern the rhi-webgl2 dispatcher already proved). Likewise **reject** a
   `readbackTexture` whose signature names "pick" or `RG32Uint`; **accept** a format-neutral readback,
   map interprets the bytes.

10. **P8 — "give `RhiBuffer` `.size`/`.usage` so `BufferPool` can bucket."**
    Widening the opaque handle leaks allocation detail into every RHI consumer to serve one pool.
    **Reject.** **Accept:** the pool tracks the size it allocated in its own map; `GpuTileStore` class
    stays in map (content-aware LRU/compaction). **Reject** moving `GpuTileStore` to engine.

11. **Cross-cutting — "byte-identical, verified" by a downscaled side-by-side.**
    CLAUDE.md §5: a downscaled composite hides the sub-pixel offsets these moves risk. **Reject** any
    eyeball verdict. **Accept** only the §7 protocol (directional pixel-diff DC-gated + 16-split +
    measured width). And **reject** "leak-closed" asserted by grep-in-a-PR; **accept** only the §4
    shrink-only ratchet.

---

## 7. Shared verification protocol (every phase, no exceptions — CLAUDE.md §5/§7/§11)

1. **Build = typecheck authority.** `bun run build` — 0 new TS; **watch TS6133** orphaned imports
   (plain `vite build` hides them; re-export shims + import swaps are prime offenders).
2. **vitest** — full run for the touched packages; **tests travel with the primitive** (P1/P2/P3),
   decoupled from geo fixtures (real-RHI / mock device).
3. **Render-gate + directional pixel-diff** (`.claude/skills/compare-parity-pixeldiff/compare-diff.py`)
   — **DC>0** proves what changed (must be **DC=0** for a pure relocation), **D1<D0** proves direction
   vs MapLibre. Gate on DC/direction, **never** an absolute %.
4. **16-split (4×4) read of the diff image at full res** (tile-crop-review), worst tiles first —
   paired red/blue edges = positional shift; red-both-sides = width; solid = fill/colour; text-only =
   glyph. **Measure pixel width** before calling any edge a width bug.
5. **Both backends** where P4+ touches the frame — WebGPU **and** WebGL2 parity (or explicit
   fail-closed), per the mandate.
6. **Zero-cost check** for hot-path moves (P2 ring, P5 executeItems path) — commit-vs-revert numeric
   per-frame-alloc comparison; no indirection regression.
7. **Both ratchets green** — dep-direction (#929) **and** the new raw-WebGPU-in-`map` baseline (§4),
   the latter **shrinking** by exactly the leaks the phase closed.
8. **§7 discipline:** never run two heavy jobs (vitest / `tsc --build --force` / `bun run build` /
   GPU verify) concurrently — serialize.
9. **§10 author↔review separation:** the authoring pass never self-approves; a distinct
   `code-reviewer` + `verifier` pass (or Workflow) gates each phase PR.

---

## 8. Open questions (decide before the phase that needs them)

1. **Ratchet home — RESOLVED (PR #993):** landed as `map/src/raw-webgpu-ratchet.test.ts`, **not** an
   extension of `architecture-invariants.test.ts`. The recommendation to extend it was based on a wrong
   premise — that file walks `runtime/compiler/blueprint/shared`, **not** `map/src`. Since the CI
   matrix shards by directory and `test (map)` runs `vitest map/src`, a test under `map/src/**` is
   guaranteed to run (not CI-dark) and stays co-located with what it guards — strictly better than
   reaching from the runtime package into map. See §4.
2. **P0 splitting (blocks P0 scope):** is P0 one PR or four? 0.2 is doc-only (trivial); 0.3/0.4 are
   pre-existing ratchet-baselined debt tied to #929 B3 / #834 M5 and may be **larger than the rest of
   the EPIC**. _Recommendation:_ land 0.1+0.5 (FrameUniform, the true blocker for a clean P4/P6) as
   one PR; treat 0.3/0.4 as **their parent issues' work folded in**, not gating the map→engine moves —
   they don't block any primitive move (only the two rhi-webgpu edges).
3. **P5 pass-graph ordering (blocks P5 design):** does `RenderNode` need ordering _dependencies_
   (heatmap-after-labels owns the MSAA resolve — the `engine-content-split.md` §7.1 open item) or is a
   flat ordered list enough? The resolve-owner coupling must be **engine render-graph metadata**, not a
   map assumption baked into node order. _Carry `render-graph-pass-scheduler.md` into P5._
4. **P3 vs critical path timing:** P3 (atlas) is independent but touches text/icon render — schedule it
   in a **quiet** window (glyph parity is the flakiest render-gate surface), not concurrent with P5/P6.
5. **`render-node.ts` location:** EPIC cites `passes/render-node.ts:27` but the file isn't a standalone
   in the tree (the `RenderNode` type may be inline in `pass-chain.ts`). _Confirm at P5 execution; the
   scheduler at `pass-chain.ts` is the real anchor._

---

## 9. Definition of done (EPIC close-out)

- All 8 phases + P0 merged, each with its own green gate (build + vitest + precheck + tsc + CI).
- Raw-WebGPU-in-`map/src` ratchet **BASELINE == ∅** (asserts zero raw WebGPU in `map/src` beyond
  none — every leak closed).
- Dependency-direction ratchet: `['rhi-webgpu','compiler']` and `['rhi-webgpu','engine']` baselines
  **deleted** (0.3/0.4 burned down).
- `@xgis/engine` exports a real engine surface — `Material`/`executeItems`, `UniformRing`,
  `AtlasTexture`, `RenderTargets`, `RenderNode` scheduler, `FullscreenComposePass`,
  `RenderToTexturePass`/`bakeToTexture`, `readbackTexture`, `BufferPool` — each passing the "strip
  X-GIS" test.
- **#599 globe-vector-drape imports `bakeToTexture` from `@xgis/engine`** (the substrate did its job).
- Render byte-identical vs pre-EPIC baseline on **both** backends, proven per §7 (no downscaled
  verdicts anywhere in the trail).

---

_Companion: `engine-content-split.md` (the P0–P4 package carve — done), `package-responsibilities.md`,
`render-graph-pass-scheduler.md` (P5), `p2-engine-carve-plan.md` / `p3-package-extraction-plan.md`
(prior carve). Grounded against the tree at branch `claude/issue-991-rd9w6d`; all `file:line`s from
EPIC #991's two read-only audits, spot-verified first-hand (Material RHI-only imports, `UniformBlock.of`,
the two dep-ratchet baselines, the absent map raw-WebGPU gate, the FrameUniform content leak)._
