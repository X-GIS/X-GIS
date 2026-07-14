# Twin-frame elimination — one pass-chain over RHI, capability queries instead of backend identity (#1046)

Design document (no production code) for retiring the forced-WebGL2 twin frame
(`renderFrameViaRhi`) and running the ONE content-registered RenderNode pass-chain over the
RHI on both backends, with a `caps` record on `RhiDevice` replacing every `backend ===`
switch the frame path holds today. Empirical backbone: all four user-visible globe defects
in the #1048 bundle were twin-frame-only — the WebGPU frame was correct at identical
cameras (`docs/research/2026-07-13-globe-webgl2-bundle.md:3-7`). This lands under the #834
epic as the completion of #991 P4/P5 (`docs/architecture/engine-substrate-migration-991.md:242-265`)
with WebGL2 as a live second consumer, and it subsumes the WebGL2 gap census
(#1056–#1063, #1049): each gap becomes either a capability-gated feature or a port that
exists once, not twice.

Scope guard: this program deletes the twin FRAME (orchestration + twin packs + twin pick).
It does not finish #991 P6/P7 (per-renderer pipeline-creation leaks, async primitives) —
those continue on their own track; §4.3 states exactly where the boundary sits.

---

## 1. Current state — the twin frame and its tax

### 1.1 Two orchestrations of the same frame

**The authority (WebGPU):** `RenderLoop.render` mints a raw encoder + swapchain view
(`map/src/render-loop.ts:262-263`), dispatches compute pre-passes (`render-loop.ts:277-286`),
builds the reused `FrameContext` (`render-loop.ts:335-392`), then iterates the
content-registered chain (`render-loop.ts:522-524`):

```
for (const node of this._nodes) {
  if (node.shouldRun(scene)) node.execute(ctx, scene)
}
```

The chain is built constructively from the single order authority `PASS_CHAIN_ORDER`
(`map/src/render/passes/pass-order.ts:19-29`): background → opaque → oit → translucent →
points → labels → heatmap → overdraw-compose → graphics
(`map/src/render/passes/pass-chain.ts:72-74`, registered at `map/src/map.ts:1069`).
One submit ends the frame (`render-loop.ts:544`).

**The twin (WebGL2):** an early-return arm fires before any of that when
`asScreenPassDevice(this.host.ctx.rhi)` narrows — which it does exactly when
`backend === 'webgl2'` (`rhi/src/rhi.ts:486-492`) — and renders the whole frame through
`renderFrameViaRhi` (`render-loop.ts:242-259` → `:824-1048`): a hand-maintained
straight-line method that re-implements the pass sequence as inline stages. This is LIVE
production code, not a dev toggle: the `'auto'` provider chain falls back to WebGL2
whenever WebGPU is absent or adapter-null (`rhi-webgpu/src/backend-providers.ts:106-118`),
which is how the #1041 checkerboard reached users.

### 1.2 The twin surface — full inventory

| Twin member                                   | Location                                                                              | Duplicates                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Early-return arm                              | `render-loop.ts:234-259`                                                              | the frame shell (encoder / targets / submit / idle bookkeeping `:249-257`)                                                                                                                 |
| `renderFrameViaRhi`                           | `render-loop.ts:824-1048`                                                             | the pass ORDER + per-pass gating of the RenderNode chain                                                                                                                                   |
| — background stage                            | `render-loop.ts:836-859`                                                              | `background-pass.ts:70-107` (same `backgroundClearValue`, re-inlined shape resolve)                                                                                                        |
| — raster stage                                | `render-loop.ts:860-887`                                                              | the opaque pass's `isFirst` raster block (`opaque-pass.ts:131-181`)                                                                                                                        |
| — fills+strokes stage                         | `render-loop.ts:893-945`                                                              | the opaque pass's group loop + `cs.draw` closures (`opaque-pass.ts:211-242`)                                                                                                               |
| — translucent stage                           | `render-loop.ts:951-970`                                                              | `translucent-pass.ts:23-59` (offscreen MAX-blend + composite)                                                                                                                              |
| — label stage                                 | `render-loop.ts:975-1018`                                                             | drives the REAL `labelPass.execute` but through a hand-forged `FrameContext` with nulled `encoder`/`screenView`/`colorView` and `rhiPass` set (`:998-1015`)                                |
| — graphics stage                              | `render-loop.ts:1025-1038`                                                            | `graphics-pass.ts:33-52`                                                                                                                                                                   |
| `renderFillsRhi`                              | `map/src/render/vector-tile-renderer.ts:945-1134`                                     | VTR `render()`/`renderTileKeys` selection → acquisition → per-tile uniform pack → draw, as a fills-only sibling (`:664-671` names it a sibling)                                            |
| `renderLinesRhi`                              | `vector-tile-renderer.ts:1144-1408`                                                   | the stroke half of the same skeleton                                                                                                                                                       |
| `ensureLabelTilesRhi`                         | `vector-tile-renderer.ts:1416-1474`                                                   | selection + acquisition for label-only shows                                                                                                                                               |
| twin fill Materials                           | `vector-tile-renderer.ts:672-738` (`_fillMatRhi`, `_fillPickMatRhi`, `fillTileBgRhi`) | the PipelineFactory fill variants, rebuilt as ground-only single-sample twins                                                                                                              |
| `beginTranslucentPassRhi` / `compositeRhi`    | `map/src/render/line-renderer.ts:344/:358`                                            | `beginTranslucentPass` / `composite`                                                                                                                                                       |
| `pickViaRhi` + `_lastRhiFrame` + `_pickRtRhi` | `render-loop.ts:738-822`, `:711-718`, `:722-731`                                      | the continuous pick MRT (`opaque-pass.ts:94-101`) + async readback pool (`map/src/interaction-controller.ts:108-111`) as an on-demand offscreen pass + sync `readPixelRg32ui`              |
| `FrameContext.rhiPass` / `useRhi`             | `map/src/render/frame-context.ts:23-27/:70-76`                                        | the branch predicate the label pass forks on (`label-pass.ts:1711-1716`)                                                                                                                   |
| Pass-order twin gate                          | `pass-order.ts:33-43` (`RHI_TWIN_MISSING`), `pass-order-parity.test.ts:57-116`        | exists ONLY because two orchestrations exist; its own close-out comment: "RHI_TWIN_MISSING goes to [] and this gate's twin half retires with the twin" (`pass-order-parity.test.ts:21-23`) |

Passes the twin does not port at all (`pass-order.ts:38-43`): `oit` (runtime-dead in both),
`points`, `heatmap`, `overdraw-compose`. Within ported stages: extrusion is skipped
(`cached.extruded` → `continue`, `vector-tile-renderer.ts:1058`), dash landed late
(#834 M5 s5), fill-pattern / graticule (`opaque-pass.ts:250-252` never runs on WebGL2) /
globe drape (`vector-tile-renderer.ts:768-769` — bake returns null on webgl2) never landed.
That per-stage residue IS the census #1056–#1063.

### 1.3 The divergence tax — #1048 as evidence

All four root causes lived only in the twin, at identical cameras where the WebGPU chain
was correct (`docs/research/2026-07-13-globe-webgl2-bundle.md:9-16`):

| Defect                              | Twin-only root cause                                                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1044 raster↔vector misregistration | twin packs hard-zeroed the `cam_ecef_off_{h,l}` DSFUN lanes — the sibling pack drifted from `render()`'s (now healed by the `tile-camera-anchor.ts` single authority, `vector-tile-renderer.ts:1061-1071`) |
| #1041 checkerboard background       | twin drew the analytic checker as the `else` of `hasSource()` — a debug artefact production-reachable only because the twin frame is the auto-fallback frame                                               |
| #1040 ~16-gon globe silhouette      | a fixed 8×8 raster grid the WebGPU-side fix (userbug 09) was never ported to                                                                                                                               |
| #1043 WebGL2 flicker                | state leaks in the twin's clears/dispatches (`beginScreenPass` colour-mask, compute viewport, polygon-offset)                                                                                              |

The mechanism is structural: every frame-path change must land twice, and nothing but a
source-scan test (`pass-order-parity.test.ts`) and human diligence keeps the copies
aligned. Four escapes in one bundle is the measured rate.

### 1.4 Backend-identity switching today

38 non-test `backend === 'webgl2' / 'webgpu'` sites in `map/src` (measured 2026-07-14),
plus the narrow-by-identity in `asScreenPassDevice` itself (`rhi/src/rhi.ts:489`).
Representative: `interaction-controller.ts:151` (pick strategy),
`renderer.ts:385` (skip native bind-group rebuild), `line-renderer.ts:635/:769`
(proxy-no-op layouts), `raster-renderer.ts:187/:374/:670/:708`,
`pipeline-factory.ts:220/:540/:1273/:1315`, `render-loop.ts:1061` (sprite-atlas push),
`map.ts:2605`. Each is a fork content maintains because the device doesn't answer the
question the caller actually has ("can I…?"), only who it is. #996 set the precedent for
the fix (`isGlobeProj` over `projType === 7`, revived gate at commit `a1e56fc`): confine
the identity, expose the predicate.

### 1.5 What the RHI already absorbs — the gap is narrower than it looks

The unification is NOT a WebGL2 backend rewrite; most hardware divergence is already below
the RHI line:

- **Dual-source pipelines** — `RhiPipelineDesc` carries WGSL + split GLSL, backend picks
  (`rhi/src/rhi.ts:133-146`); shader-dsl is the sole generator of both.
- **Storage buffers** — emulated as 2D-tiled R32F data textures on WebGL2
  (`rhi-webgl2/src/rhi-webgl2.ts:77-86, :716-736`); the header note at `:39-42` predates
  this and is stale.
- **Compute** — fragment-GPGPU lowering into an R32UI target, proven byte-correct vs the
  CPU oracle (`rhi-webgl2/src/compute-webgl2.ts:1-9`, `_compute-dispatch-parity`).
- **Offscreen MRT** — `beginOffscreenPass` supports 1..4 colour attachments including
  integer clears (`rhi-webgl2.ts:587-604`); the on-demand pick pass already runs a
  colour+rg32uint MRT + depth-stencil on WebGL2 (`render-loop.ts:782-797`).
- **Content draws via RHI Materials** — the fill/line/point/heatmap/text/icon Material
  seams are default-on (`docs/architecture/engine-content-split-P1-status.md:55`), and the
  graphics pass already wraps its native pass into an `RhiRenderPass` for content
  (`graphics-pass.ts:22,:41` `wrapWebGpuPass`).

What genuinely differs and must be MODELLED (not hidden): MSAA, MRT on the presented
surface, float render+blend targets, readback synchrony, compute/timestamp availability,
immediate vs deferred execution. That list is the caps record.

---

## 2. Target architecture

### 2.1 One chain, one frame shell

End state: `RenderLoop.render` has exactly one body. Per frame, on BOTH backends:

```
encoder    = rhi.createCommandEncoder()            // universal, no longer optional
screenView = rhi.acquireScreenView()               // WebGPU: swapchain view; WebGL2: FBO-0 sentinel
compute pre-passes via the dispatcher seam         // native or fragment-emulated per caps
ctx        = FrameContext { rhi, encoder, screenView, colorView, … }   // RHI-typed (#991 P4)
rt.ensure(w, h, min(getSampleCount(), rhi.caps.maxSampleCount), …)
for node of _nodes: if (node.shouldRun(scene)) node.execute(ctx, scene)
encoder.finish()                                   // WebGPU: submit; WebGL2: flush
```

Passes keep beginning their own sub-passes through `ctx.encoder.beginRenderPass(desc)` with
the existing backend-neutral descriptors (`RhiRenderPassDesc`, `rhi/src/rhi.ts:286-290`) —
already byte-identically mapped on WebGPU (`rhiRenderPassToGpu`, pinned by
`rhi-webgpu/src/rhi-renderpass-parity.test.ts`). WebGL2 implements `beginRenderPass` as
FBO bind + per-attachment clears (its `beginOffscreenPass` body today), plus the one new
piece: when a colour attachment view is the screen sentinel, bind FBO 0 and use the default
depth-stencil (the context is created with `stencil: true`,
`rhi-webgpu/src/gpu.ts:265-270`). Where hardware genuinely differs, a pass branches on
`ctx.rhi.caps.*` — never on `backend`.

Frame-shape note: this does NOT force the two backends into one pass TOPOLOGY. The chain's
load/store descriptors already express the WebGPU topology; on WebGL2 the same descriptors
degenerate naturally (load = don't clear, store = no-op, `end()` = rebind). The twin's
"one screen pass with nested offscreen passes" shape was an artefact of the isolated
slice, not a requirement.

### 2.2 `rhi.caps` — placement and exact initial shape

**Placement.** A required readonly field on `RhiDevice` in `@xgis/rhi`
(`rhi/src/rhi.ts:365` interface), populated at device construction and frozen. Consumers
import through `@xgis/engine`, which already re-exports the whole RHI surface
(`engine/src/index.ts:8`) — matching the engine charter's "Device lifecycle + caps" row
(`docs/architecture/engine-content-split.md` §2). Making it REQUIRED (not `?`-optional) is
the verified-by-construction move: a backend that forgets to answer doesn't compile, and no
consumer ever needs a null-fallback that silently guesses.

**Shape.** Only capabilities the chain or its named seams actually branch on — audited in
§2.3. Append-only by policy: adding a field is additive; renaming/removing one is a
breaking change to every backend.

```ts
/** Immutable device capability record — the answers a frame asks of its device.
 *  Populated once at device creation; every field must be phrased as a device
 *  truth any hypothetical backend (Metal/D3D/GLES) could answer, and every
 *  field lists its consumer seam — a cap with no consumer is dead weight,
 *  a cap only one backend can answer honestly is identity in disguise (§5.3). */
export interface RhiCaps {
  /** Max MSAA sample count for the frame's colour/depth targets (1 = none).
   *  WebGPU: 4. WebGL2: 1 today (ES 3.0 renderbuffer MSAA is a future value
   *  change, not a shape change). Consumer: RenderTargets.ensure + pipeline
   *  sampleCount + the resolveOwner logic. */
  readonly maxSampleCount: number
  /** A render pass presenting to the screen can carry additional MRT colour
   *  attachments (the live rg32uint pick target). WebGPU: true (the swapchain
   *  is an ordinary texture). WebGL2: false (default framebuffer cannot MRT).
   *  Consumer: opaque-pass pick-attachment build; false selects the on-demand
   *  offscreen pick strategy. */
  readonly presentablePassMrt: boolean
  /** How a pick texel comes back: 'async' = copy-to-buffer + map (pool);
   *  'sync' = immediate readPixels. Consumer: interaction-controller readback
   *  strategy behind the unchanged async pickAt() public contract. */
  readonly pickReadback: 'async' | 'sync'
  /** Render-to-float-and-blend targets (r16float/rgba16float attachments with
   *  additive/max blend): heatmap accumulation, weighted OIT. WebGPU: true.
   *  WebGL2: feature-DETECTED (EXT_color_buffer_float && EXT_float_blend) —
   *  the canonical proof this is a capability, not an alias for backend
   *  identity: a desktop WebGL2 context commonly answers true. Consumer:
   *  heatmap/oit shouldRun gates + RenderTargets float-target allocation. */
  readonly floatBlendTargets: boolean
  /** Compute execution: native compute passes or the fragment-GPGPU lowering.
   *  Consumer: the compute dispatcher seam only — passes never read it. */
  readonly compute: 'native' | 'fragment-emulated'
  /** GPU timestamp profiling available. Consumer: GPUTimer construction gate
   *  (replaces GPUContext.timestampQuerySupported plumbed per-backend). */
  readonly timestampQuery: boolean
  /** Command execution semantics: 'deferred' (work runs at submit) or
   *  'immediate' (draws execute at record time). CONFINED consumer: engine
   *  upload/draw primitives (UniformRing / staging flush policy inside
   *  executeItems) — never passes, never renderers (§5.3 confinement gate). */
  readonly executionModel: 'deferred' | 'immediate'
}
```

Initial values — WebGpuDevice: `{ maxSampleCount: 4, presentablePassMrt: true,
pickReadback: 'async', floatBlendTargets: true, compute: 'native', timestampQuery:
<adapter feature>, executionModel: 'deferred' }`. WebGl2Device: `{ maxSampleCount: 1,
presentablePassMrt: false, pickReadback: 'sync', floatBlendTargets:
<EXT_color_buffer_float && EXT_float_blend>, compute: 'fragment-emulated',
timestampQuery: false, executionModel: 'immediate' }`.

### 2.3 The audit — what made the cut and what deliberately did not

Derived by reading every pass for the device features it touches:

| Candidate                                         | Who needs it                                                                                                                                                                                                                  | Verdict                                                                                                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MSAA sample count                                 | `render-loop.ts:381-392` (`getSampleCount` → `rt.ensure`), every pipeline's `sampleCount`, resolveOwner chain (`opaque-pass.ts:47`, `oit-pass.ts:79-88`, `translucent-pass.ts:28`, `points-pass.ts:32`, `label-pass.ts:1723`) | **cap** `maxSampleCount` — the frame clamps `getSampleCount()` by it                                                                                                               |
| Live pick MRT on the presented chain              | `opaque-pass.ts:94-101` attaches `rg32uint` alongside the colour target; WebGL2 FBO 0 cannot                                                                                                                                  | **cap** `presentablePassMrt`                                                                                                                                                       |
| Pick readback synchrony                           | `interaction-controller.ts:142-159` forks strategies at `:151` today                                                                                                                                                          | **cap** `pickReadback`                                                                                                                                                             |
| Float render+blend                                | heatmap r16float accum/blur (`heatmap-pass.ts:7-12`), OIT rgba16float+r8 MRT (`oit-pass.ts:38-65`; fail-closed note `rhi/src/rhi.ts:57-59`)                                                                                   | **cap** `floatBlendTargets`, feature-detected on WebGL2                                                                                                                            |
| Compute                                           | `render-loop.ts:277-286` pre-passes; WebGL2 lowering exists (`compute-webgl2.ts`)                                                                                                                                             | **cap** `compute`, consumed by the dispatcher seam only                                                                                                                            |
| Timestamp queries                                 | `gpuTimer?.` call sites throughout the chain                                                                                                                                                                                  | **cap** `timestampQuery` (kills the per-backend `GPUContext.timestampQuerySupported` plumbing)                                                                                     |
| Immediate vs deferred execution                   | the twin flushes uniforms per tile because GL draws execute at call time (`vector-tile-renderer.ts:1103-1107`); WebGPU flushes once per pass (`engine/src/index.ts:40-47`)                                                    | **cap** `executionModel`, confined to engine primitives (§5.3)                                                                                                                     |
| Storage buffers                                   | point/line/heatmap per-feature data                                                                                                                                                                                           | **not a cap** — already emulated below the RHI line (`rhi-webgl2.ts:716-736`); passes cannot tell                                                                                  |
| Offscreen MRT count                               | pick (2), OIT (2)                                                                                                                                                                                                             | **not a cap** — baseline RHI contract: every backend guarantees ≥4 offscreen colour attachments (WebGL2 spec minimum for `MAX_COLOR_ATTACHMENTS`; enforced by `rhi-webgl2.ts:595`) |
| Shader language                                   | pipeline creation                                                                                                                                                                                                             | **not a cap** — the dual-source descriptor is the device's internal concern (`rhi.ts:139-145`); a language cap would invite content to fork on it                                  |
| `rg32uint`/depth24plus-stencil8/index-u32 support | pick, clip masks, VTR indices                                                                                                                                                                                                 | **not a cap** — baseline contract, both backends implement today                                                                                                                   |
| Screen-pass lifecycle                             | the `asScreenPassDevice` narrow                                                                                                                                                                                               | **not a cap** — becomes UNIVERSAL surface (§2.4); an optional lifecycle was the seam that created the twin                                                                         |

### 2.4 Universal frame surface — what stops being optional

The optional screen-pass block (`rhi/src/rhi.ts:421-467`) exists because only WebGl2Device
originates frames through the RHI ("Story-7 convergence" deferred, `rhi.ts:427`). The
target inverts that:

- `createCommandEncoder` — required. WebGL2's encoder gains `beginRenderPass` (today it
  fail-closes, `rhi.ts:453-461`) by absorbing the proven `beginOffscreenPass` body + the
  FBO-0 sentinel arm; `finish()` = `gl.flush()` + error drain.
- `acquireScreenView(): RhiTextureView` — new, required. WebGPU wraps
  `context.getCurrentTexture().createView()` (#991 G2); WebGL2 returns the FBO-0 sentinel
  (plus a paired default depth-stencil sentinel used by `RhiDepthStencilAttachment`).
- `beginScreenPass` / `endScreenPass` / `beginOffscreenPass` / `RhiScreenPassDevice` /
  `asScreenPassDevice` — deleted at the end (§4). `readPixelRg32ui` stays, renamed into the
  readback seam that `pickReadback: 'sync'` selects.
- `takeGlErrors` — folded into `finish()`; the loop's error sink keeps one call site.

### 2.5 Fallback semantics per capability, decided per pass

The three verbs, chosen deliberately per pass (not per backend):

| Pass / seam                                           | Cap consulted        | When unavailable                                                                                                                                                                | Verdict + justification                                                                                                                                                                                                   |
| ----------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| frame shell (targets, pipelines)                      | `maxSampleCount`     | sampleCount clamps to 1, `useResolve=false`                                                                                                                                     | **degrade** — aliased edges only; cross-backend §5 gates are directional (DC/D1<D0), never pixel-exact cross-backend                                                                                                      |
| opaque pick attachment                                | `presentablePassMrt` | no live pick target; picking becomes an on-demand offscreen MRT re-render (the current `pickViaRhi` topology, §5.4) driven through the SAME draw closures with the pick variant | **degrade** — pick correctness identical; cost moves from per-frame to per-query. Emulating a live target would force the whole frame offscreen + a full-screen blit every frame to serve an occasional click             |
| interaction-controller                                | `pickReadback`       | `'sync'` reads the texel immediately inside the unchanged `async pickAt()`                                                                                                      | **degrade** — the public contract is already async (`interaction-controller.ts:142-145`), so a later ES3 PBO+fence upgrade is a value change, not an API change                                                           |
| heatmap                                               | `floatBlendTargets`  | pass `shouldRun` returns false; one-time dev warning                                                                                                                            | **disable** — an rgba8-quantized accumulator bands visibly (a quality trap worse than absence); the extension is near-universal on desktop WebGL2, so the real-world hole is small. Revisit only on user demand           |
| oit                                                   | `floatBlendTargets`  | same gate                                                                                                                                                                       | **disable** — already runtime-dead on both backends (`pass-chain.ts:17-22`); the gate simply makes its revival honest                                                                                                     |
| compute pre-passes                                    | `compute`            | `'fragment-emulated'` routes kernels through the proven lowering                                                                                                                | **emulate** — exists and is oracle-proven (`compute-webgl2.ts`)                                                                                                                                                           |
| gpuTimer                                              | `timestampQuery`     | timer is null; `?.` call sites already absorb it                                                                                                                                | **disable** — profiling is diagnostic, not output                                                                                                                                                                         |
| uniform staging / executeItems                        | `executionModel`     | `'immediate'` flushes staged slots before each recorded draw batch, inside the engine primitive                                                                                 | **emulate** (policy absorbed below the content line) — content never sees ordering rules; WebGPU keeps its single per-pass flush                                                                                          |
| points / graticule / extrusion / fill-pattern / drape | none                 | —                                                                                                                                                                               | **no cap at all**: nothing hardware-shaped is missing (storage is emulated, depth exists, atlases have RHI handles `vector-tile-renderer.ts:1475-1481`). These are pure ports that the unified chain executes once (§4.2) |

### 2.6 Alignment with #991 / #834

This program IS #991 P4 (FrameContext RHI-retype + neutral RenderTargets) + P5 (RenderNode
chain over RHI) executed with the WebGL2 backend as the second live consumer, under the
#834 epic's device-retirement arc (the fail-loud Proxy at `gpu.ts:296-306` becomes
unreachable from the frame path). Phase F2 = P4's G2/G3 gap-fill; F3–F4 = P5's "RenderNode
execute over a neutral RHI context" gate. The `FullscreenComposePass` consolidation
(P5 item b) is sequenced INSIDE F3 for exactly the two compose bodies the twin duplicates
(translucent composite, `line-renderer.ts:358`), leaving the remaining compose sites to
#991's own track.

---

## 3. Phased execution plan

Six phases. Every phase: `bun run build` (typecheck authority) + vitest + the named §5
probe, run SEQUENTIALLY (§7 — never two heavy jobs at once), and leaves the WebGL2 demo
rendering AT LEAST what it renders today — no regression window. GLSL twins come from
shader-dsl emit only (no hand GLSL). Ratchet touches (LOC ceilings
`map/src/loc-ceiling-ratchet.test.ts:73-160`, arch gates) are itemized per phase.

### F1 — caps surface + chain-visible RhiDevice (pure seam, byte-identical)

- **Scope:** add `RhiCaps` + required `caps` to `RhiDevice`; populate both devices
  (WebGL2 feature-detects `floatBlendTargets`); add `rhi: RhiDevice` to `FrameContext`
  (populated on both paths — `ctx.rhi` already exists on both boots); nothing READS caps
  except new unit gates. Add `backend-identity-ratchet.test.ts` (shrink-only high-water
  count of `backend ===` in `map/src`, baseline 38, vacuity-guarded per the #996 lesson).
- **Files:** `rhi/src/rhi.ts`, `rhi-webgpu/src/rhi-webgpu.ts`, `rhi-webgl2/src/rhi-webgl2.ts`,
  `map/src/render/frame-context.ts`, `map/src/render-loop.ts` (one assignment), new tests.
- **Gate:** build + vitest (caps unit tests: frozen webgpu values, webgl2 detection arms
  faked-GL); §5 before/after DC=0 on `ofm_bright_local` at `#14/35.68/139.76`, BOTH
  backends (SwiftShader, `backend=webgpu` / `backend=webgl2`).
- **Kill-switch:** revert — the phase is additive.

### F2 — frame origination via RHI on WebGPU (#991 P4 / G2+G3), twin untouched

- **Scope:** `createCommandEncoder` universal; `acquireScreenView` on both devices;
  `FrameContext` retypes `encoder`/`screenView`/`colorView` to RHI types and drops
  `device` from pass-visible surface; `RenderTargets` re-expressed over `RhiTexture` with
  map-supplied target identity (neutral, per P4); pass bodies swap
  `encoder.beginRenderPass({...})` for `ctx.encoder.beginRenderPass(rhiDesc)` — descriptor
  mapping already pinned byte-identical (`rhi-renderpass-parity.test.ts`). The WebGL2 twin
  keeps running exactly as today (it already holds an `RhiRenderPass`).
- **Files:** `rhi/src/rhi.ts`, both device impls, `map/src/render/frame-context.ts`,
  `map/src/render-loop.ts:262-263/:544`, `rhi-webgpu/src/render-targets.ts` (moves per
  P4), all 9 `map/src/render/passes/*-pass.ts`, `label-pass.ts` fake-context site shrinks.
- **Gate:** build + vitest (incl. `pass-order-parity`, alloc-counter — encoder/pass
  wrappers must be reused per frame, not per-pass allocated); §5 DC=0 on WebGPU across the
  probe matrix (`ofm_bright_local` flat + `proj=globe`, `fixture_extrude_local`,
  `multi_layer&picking=1`); WebGL2 DC=0 trivially (untouched). Commit-vs-revert frame-time
  on `ofm_bright_local` (hot-path move, §7 discipline).
- **Kill-switch:** `globalThis.__xgisRawFrameShell = true` restores the raw
  encoder/swapchain arm for one release (the `__xgisVtrFillViaRhi` seam pattern,
  `docs/architecture/engine-content-split-P1-status.md:31`).

### F3 — the unified chain executes on WebGL2 behind a dev flag

- **Scope:** `?rhichain=1` boots the WebGL2 frame through `this._nodes` instead of the
  twin. WebGL2 encoder gains `beginRenderPass` (absorb `beginOffscreenPass` + FBO-0
  sentinel arm — this WORK is the #1049 descriptor-parity umbrella: every descriptor shape
  the passes emit must bind correctly). Opaque/translucent/labels/graphics execute their
  unified bodies: the bucket scheduler's `cs.draw` closures run against the RHI pass on
  webgl2 (Materials already carry GLSL twins, e.g. `vector-tile-renderer.ts:686-700`);
  `executionModel` flush policy lands in the engine primitives; remaining native-only
  branches inside the closures get capability gates or die. The twin's loop-hot
  work-pending contract (missing-tile count arming `_needsRender`,
  `render-loop.ts:244-256`) merges into the shared frame tail (`render-loop.ts:690-695`).
  Pick attachment is caps-gated OFF (`presentablePassMrt=false`) — picking stays on the
  twin's `pickViaRhi` until F5.
- **Files:** `rhi-webgl2/src/rhi-webgl2.ts` (+~150 LOC; raise its #1003 ceiling with
  justification, current 1120), `map/src/render-loop.ts` (flag routing),
  `map/src/render/vector-tile-renderer.ts` + `line-renderer.ts` (capability-gating the
  closure paths), `map/src/debug-flags.ts`.
- **Gate:** build + vitest; the four gl2 CI gates + `_probe-bright-gl2` +
  `_translucent-outline-parity` stay green on the DEFAULT (twin) path; NEW **twin-parity
  ratchet**: chain-vs-twin pixel diff (`compare-diff.py`) at identical cameras on the
  fixture matrix {`minimal`, `ofm_bright_local` flat+globe, `dashed_lines`,
  `fixture_line_image_pattern`, `fixture_translucent_outline`}, high-water DC shrink-only
  per fixture, target 0 before F4. 16-split diff reads on the worst fixture per §5.
- **Kill-switch:** flag default-off IS the switch.

### F4 — the flip: the chain becomes the WebGL2 frame

- **Scope:** default flips once the twin-parity ratchet reads 0 on every fixture;
  `?twinframe=1` (or `__xgisTwinFrame=true`) keeps the twin reachable for ONE release as a
  bisect tool. The four gl2 CI gates + pick gate now exercise the chain. No new features
  in the same commit (pure default flip).
- **Files:** `map/src/render-loop.ts:234-259` (arm condition), `playground` gate specs'
  flag plumbing only if needed.
- **Gate:** build + vitest + full gl2 e2e leg; §5: before/after-flip DC≈0 on the
  twin-covered fixture matrix (the ratchet's zero makes this a formality, but run it —
  numbers never decide alone); WebGPU DC=0.
- **Kill-switch:** flip the default back — both paths still compiled this release.

### F5 — capability-gated completion: the census closes

Sequenced ports, each its own PR with its own §5 directional gate (DC>0 on webgl2 where
content appears, D1<D0 vs the WebGPU reference at identical cameras, DC=0 on WebGPU):

1. **Graticule** (#1061-class): route `graticule-renderer.ts` draws through its Material
   twin so `opaque-pass.ts:250-252` runs on webgl2.
2. **Extrusion** (#1056): drop the `cached.extruded` skip — the unified opaque pass
   supplies the depth attachment and two-phase ordering the twin lacked
   (`opaque-pass.ts:183-241`); extrude pipeline variants emit GLSL via the DSL.
3. **Points/circles + fill-pattern** (#1057/#1059-class): enable the points pass +
   pattern variants on webgl2 (storage emulation + atlas RHI handles already exist).
4. **Picking unification** (#1060-class): delete the fills-only twin pick; the on-demand
   strategy renders THROUGH the same `cs.draw` closures with the pick variant (lines,
   points, extrusions become pickable on webgl2 — today only fills are); controller forks
   on `caps.pickReadback`/`presentablePassMrt` (§5.4 for the contract analysis).
5. **Heatmap** (#1058-class): `floatBlendTargets`-gated enablement; where the extension is
   absent the pass stays disabled by the cap, documented.
6. **Globe drape** (#1062-class): the bake path drops its webgl2 bail
   (`vector-tile-renderer.ts:768-769`) — the F2 universal encoder makes `bakeToTexture`
   backend-neutral (#991 P5 item c).

- **Gate per item:** build + vitest + the item's e2e (`_pick-gl2-gate`, heatmap/extrude
  fixtures) + §5 directional diff; census issue closed or re-scoped in the same PR.
- **Kill-switch per item:** the pass/variant `shouldRun`/caps gate — each feature arrives
  gated, so disabling is a one-line revert.

### F6 — the kill: delete the twin

- **Scope:** the deletion inventory of §4.1, in one PR, after F5's last item has one green
  release behind it. Lower LOC ceilings (`render-loop.ts` 1173→~880,
  `vector-tile-renderer.ts` 4487→~3900) — the ratchet's shrink-only discipline banks the
  win. Retire the twin half of `pass-order-parity.test.ts` per its own instruction
  (`:21-23`); `RHI_TWIN_MISSING` = [] died with F5. Backend-identity ratchet baseline
  drops to the residual (#991 P6/P7-tracked) set, each residual annotated with its issue.
- **Gate:** build + vitest + FULL local gate + full CI + §5 DC=0 both backends (deletion
  is behaviour-neutral by definition — prove it); `grep -r "ViaRhi\|asScreenPassDevice\|twinframe"
map/src rhi/src` returns only history in comments.
- **Kill-switch:** git revert of the deletion PR (pure removal, no interleaved features).

---

## 4. What dies

### 4.1 Deletion inventory (F6 unless noted)

| Symbol                                                                                                         | Location                                                                              | Died because                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| forced-WebGL2 early-return arm                                                                                 | `render-loop.ts:234-259`                                                              | one frame shell (F4 makes it the chain; F6 removes the branch)                                                                          |
| `renderFrameViaRhi`                                                                                            | `render-loop.ts:824-1048`                                                             | the chain is the frame                                                                                                                  |
| `pickViaRhi`, `_lastRhiFrame`, `_pickRtRhi`                                                                    | `render-loop.ts:711-822`                                                              | unified on-demand pick (F5.4)                                                                                                           |
| `renderFillsRhi`, `renderLinesRhi`, `ensureLabelTilesRhi`                                                      | `vector-tile-renderer.ts:945-1134/:1144-1408/:1416-1474`                              | the native selection/acquisition/pack path runs on both backends                                                                        |
| twin fill Materials + bind-group caches                                                                        | `vector-tile-renderer.ts:672-738` (`_fillMatRhi`, `_fillPickMatRhi`, `fillTileBgRhi`) | PipelineFactory variants are the single authority                                                                                       |
| `beginTranslucentPassRhi` / `compositeRhi`                                                                     | `line-renderer.ts:344/:358`                                                           | one translucent pass body (F3)                                                                                                          |
| `FrameContext.rhiPass` + `useRhi`                                                                              | `frame-context.ts:23-27/:70-76`                                                       | ctx is RHI-typed everywhere; the label fork (`label-pass.ts:1711-1716`) collapses to the one encoder path (F2/F3)                       |
| `asScreenPassDevice` + `RhiScreenPassDevice` + optional `beginScreenPass`/`endScreenPass`/`beginOffscreenPass` | `rhi/src/rhi.ts:421-492`, `screen-pass-device-narrow.test.ts`                         | universal encoder surface (§2.4)                                                                                                        |
| `RHI_TWIN_MISSING` + the twin source-scan                                                                      | `pass-order.ts:33-43`, `pass-order-parity.test.ts:57-116`                             | one orchestration; the constructive authority half STAYS                                                                                |
| twin stages' e2e scaffolding (`__xgis*ViaRhi` page flags)                                                      | `playground/e2e/_*-rhi-parity.spec.ts`                                                | repointed at the chain or retired per spec                                                                                              |
| `?forcegl2` Proxy-stub reachability from the frame                                                             | `gpu.ts:296-315`                                                                      | the frame path no longer touches `ctx.device` on webgl2; the stub itself remains until #991 P6/P7 retire the non-frame consumers (§4.3) |

`?forcegl2=1` / `backend: 'webgl2'` themselves SURVIVE — backend pinning is boot
composition (`backend-providers.ts:106-118`), not frame branching, and the CI gates depend
on it.

### 4.2 Census subsumption

Census numbers per the #1046 filing (names authoritative here; `#1056` corroborated in-repo
at `docs/research/2026-07-13-extrusion-vs-maplibre.md:45`):

| Census gap              | Fate                                                                                                                          | Phase |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----- |
| 3D extrusion (#1056)    | straight port — exists once in the unified opaque pass                                                                        | F5.2  |
| points/circles          | straight port — storage emulation already below the RHI line                                                                  | F5.3  |
| heatmap                 | capability-gated (`floatBlendTargets`)                                                                                        | F5.5  |
| fill-pattern            | straight port — atlas RHI handles exist                                                                                       | F5.3  |
| picking degradation     | capability-gated strategy (`presentablePassMrt`/`pickReadback`), full-primitive pick via shared closures                      | F5.4  |
| graticule               | straight port                                                                                                                 | F5.1  |
| globe drape             | straight port over the universal encoder                                                                                      | F5.6  |
| #1049 descriptor parity | absorbed as F3's `beginRenderPass`-on-WebGL2 acceptance criteria — every pass-emitted descriptor shape must bind or fail loud | F3    |

### 4.3 Explicit non-goals

- #991 P6 (per-renderer pipeline-creation raw sites) and P7 (async readback primitives,
  `unwrapBuffer` deletion) — this program REDUCES their surface but does not finish them.
- WebGL2 MSAA (renderbuffer + blit) — a future `maxSampleCount` value change.
- OIT revival, atmosphere, pole caps (#1053) — untouched.

---

## 5. Risks and Socratic self-critique

**5.1 "Why not just port the gaps individually into the twin? Each census issue is small."**
Because every port would land twice forever after. The twin is not behind on features by
accident — it is behind because the maintenance cost of a second orchestration is paid per
frame-path change, and #1048 measured the escape rate: four user-visible defects in one
bundle, all twin-only, one of them (#1040) a fix that had existed on the WebGPU side since
userbug 09 and was simply never copied. Porting into the twin also grows
`renderFrameViaRhi` against its LOC ceiling and extends the source-scan parity gate —
scaffolding whose own comments call it interim (`pass-order.ts:33-37`). Individual ports
optimize the next month; the chain optimizes the next five years.

**5.2 "Why not keep the twin as a 'lite mode' for weak devices?"** Because "lite" is a
QUALITY policy, not an orchestration. Everything lite about the twin — single-sample, no
heatmap, no extrusion — is expressible as caps values + quality presets
(`engine/src/gpu/quality.ts`) + `shouldRun` gates on the ONE chain. Keeping a second
orchestration to get what predicates give for free is paying the divergence tax for
nothing. If a genuinely cheaper frame is ever needed (e.g. static-map mode), it should be
a different NODE LIST fed to the same scheduler (`registerNodes` already accepts any
ordered list, `render-loop.ts:86-89`), not a second render method.

**5.3 "Where does the caps model rot into backend-identity-in-disguise?"** Three smells,
each with a designed-in countermeasure:

1. _A cap only one backend can answer honestly_ (e.g. `isGl2Like`, `glslRequired`).
   Countermeasure: the shape rule in the interface doc — every field must be a device
   truth a Metal/D3D/GLES backend could answer, and shader language is explicitly ruled
   out (§2.3).
2. _Cap explosion_ — 40 booleans is identity by another name. Countermeasure: a cap is
   admitted only with a named consumer seam and written fallback semantics at the
   declaration (§2.2); the audit table documents rejected candidates so the bar is
   visible; the baseline-contract list (§2.3) absorbs "everyone guarantees this" facts
   without caps.
3. _Policy caps leaking upward_ — `executionModel` is the dangerous one: read in a pass it
   reconstructs `backend === 'webgl2'` exactly. Countermeasure: a confinement gate in the
   #996 mold (`a1e56fc`) — a co-located test enumerating the ALLOWED read sites
   (engine upload/draw primitives only), failing on any new reader. Same pattern that
   keeps `projType === 7` confined today.

And the honest residual: `pickReadback` is currently isomorphic to backend identity
(webgpu⇔async). It stays justified because the VALUE can change within a backend (ES3
PBO+fence makes WebGL2 async-capable) without any consumer edit — the test of a real
capability is that its value, not its shape, tracks hardware evolution.

**5.4 pickViaRhi migration — the interaction-controller contract (mandated analysis).**
The public contract is `async pickAt(clientX, clientY)` (`interaction-controller.ts:142-145`),
so both strategies fit behind one signature. The risks in moving the twin's pick to the
unified on-demand pass:

- _Snapshot semantics:_ the twin picks against the LAST PRESENTED frame's camera
  (`_lastRhiFrame`, `render-loop.ts:833-835`) — the unified on-demand pick must keep that
  (pick what the user sees), which is behaviourally equivalent to WebGPU's read of the
  last-submitted pick attachment. The snapshot moves to a neutral `lastFramePickParams`
  owned by the loop; a pick before the first present returns null on both (existing
  contract, `render-loop.ts:741`).
- _Sync-stall cost:_ `gl.readPixels` forces a pipeline sync, and the on-demand pass
  re-renders pickable content per query. Bounded: click-driven picks dominate; document
  that hover-rate `pickAt` on a `pickReadback:'sync'` device costs O(frame) and leave the
  PBO+fence upgrade as a cap-value change (no API motion). Do NOT pre-build that upgrade
  now (§2 simplicity-first).
- _Divergence-class risk:_ today's twin pick draws fills only (`pickViaRhi` →
  `renderFillsRhi 'pick'`, `render-loop.ts:798-818`) — a pick-vs-colour sibling pair that
  can drift (the #1048 archetype). The unified design kills the class by construction: the
  pick pass replays the SAME `cs.draw` closures with the pick variant, so pick geometry
  cannot diverge from rendered geometry. This is the strongest single argument that F5.4
  belongs in this program rather than as a twin patch.
- _Device-loss / backpressure:_ the mapAsync pool's in-flight bookkeeping
  (`interaction-controller.ts:108-111`) has no sync counterpart — the sync arm is
  strictly simpler; the fork stays inside the controller behind the caps read.

**5.5 "F2 wraps the hot path — WebGPU perf regression risk."** Encoder/pass wrapper
objects per pass per frame in an allocation-paranoid loop (`frame-context.ts:9-13`).
Mitigation is a design requirement, not a hope: wrappers are reused per-device (rebound
per frame like `_ctx`), the alloc-counter test extends to the frame shell, and F2's gate
includes commit-vs-revert frame time on `ofm_bright_local`. If wrapping shows up, the
WebGPU encoder wrapper is allowed to be the native object behind a type-brand (zero-cost),
because `rhiRenderPassToGpu` already proves descriptor identity.

**5.6 "F3's hybrid window — half-ported chain behind a flag could rot."** The flag default
is the twin until the parity ratchet reads ZERO on every fixture, and the ratchet is
shrink-only — a stalled port is visible as a non-shrinking number in CI, the same
mechanism that kept `RHI_TWIN_MISSING` honest (`pass-order-parity.test.ts:15-19`). The
window is also capped by scope: F3 ports no NEW features (census work is F5), only the
twin's existing output.

**5.7 "WebGL2 `beginRenderPass` on FBO 0 — state-leak regression risk (the #1043 class)."**
The twin's flicker bugs were unmask-before-clear / restore-after-pass leaks. F3
concentrates ALL pass begin/end state into one implementation (the former
`beginOffscreenPass` + sentinel arm) instead of two lifecycles (screen vs offscreen), so
the #1043 fixes apply once; the existing fake-GL fail-before tests
(`rhi-webgl2/src/webgl2-screen-pass.test.ts`) migrate with the body and extend to the
sentinel arm.

---

## 6. Verification strategy

### 6.1 The §5 method, per phase

All render claims go through the mandatory directional pixel-diff + 16-split read
(`.claude/skills/compare-parity-pixeldiff/compare-diff.py`; never a downscaled eyeball).
Headless SwiftShader probes as in the #1048 method
(`docs/research/2026-07-13-globe-webgl2-bundle.md:27-36`): `HEADED=0 XGIS_SOFTWARE_GPU=1`,
demo URL pinning `?id=…&backend=…&e2e=1&proj=…#zoom/lat/lon/bearing/pitch`, readiness via
`__xgisReady`/`__xgisActiveBackend`.

| Phase | Cameras / fixtures                                                                                     | Backends that may change        | Gate condition                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| F1    | `ofm_bright_local` #14/35.68/139.76                                                                    | none                            | DC=0 on webgpu AND webgl2                                                                            |
| F2    | + `proj=globe` same cam, `fixture_extrude_local`, `multi_layer&picking=1`                              | none                            | DC=0 webgpu (refactor-neutral); webgl2 untouched; frame-time commit-vs-revert                        |
| F3    | fixture matrix {minimal, ofm_bright flat+globe, dashed_lines, line_image_pattern, translucent_outline} | webgl2 under `?rhichain=1` only | twin-parity ratchet: chain-vs-twin DC shrink-only → 0; default path DC=0                             |
| F4    | same matrix, default boot                                                                              | webgl2                          | before/after-flip DC≈0 (ratchet zero makes this a formality — run it anyway); webgpu DC=0            |
| F5.n  | the feature's fixture (+ globe cam where projection-sensitive)                                         | webgl2                          | DC>0 on webgl2 (content appears) AND D1<D0 vs the WebGPU reference at identical cameras; webgpu DC=0 |
| F6    | full matrix                                                                                            | none                            | DC=0 both backends                                                                                   |

Width-looking diffs get measured, not eyeballed (§5.3 of CLAUDE.md).

### 6.2 The pass-order parity test's role

- F1–F5: unchanged and load-bearing — the constructive half pins the authority order; the
  twin half forces `RHI_TWIN_MISSING` to shrink in the same commit as any port (it fails
  otherwise, `pass-order-parity.test.ts:109-115`), so F3/F5 progress is ratcheted, not
  asserted.
- F6: the twin scan retires per its own comment (`:21-23`); the authority half (frozen
  literal + constructive build) remains forever — it gates the ONE chain's order on both
  backends from then on.

### 6.3 Ratchets that shrink to zero

1. **Twin-parity pixel ratchet** (new, F3–F4): per-fixture high-water DC of chain-vs-twin
   on webgl2; shrink-only; zero is F4's flip precondition; deleted with the twin in F6.
2. **`RHI_TWIN_MISSING`** (existing): shrinks as F3/F5 port passes; `[]` at F5 end.
3. **Backend-identity ratchet** (new, F1): `backend ===` count in `map/src` non-test,
   baseline 38, shrink-only, vacuity-guarded; F6 lowers it to the annotated #991 P6/P7
   residue; target 0 when those epics close.
4. **LOC ceilings** (existing, `loc-ceiling-ratchet.test.ts`): F3 raises
   `rhi-webgl2/src/rhi-webgl2.ts` with justification; F6 LOWERS `render-loop.ts` and
   `vector-tile-renderer.ts` — the shrink is the deliverable's measurable footprint.
5. **CI**: the four gl2 render gates (`.github/workflows/test.yml:85-92`) run every phase;
   `_webgl2-parity` (local-only, `test.yml:583`) tracks the cross-backend distance D1
   downward across F5.

---

## Appendix A — pass-needs audit trail (raw)

For future cap proposals, the per-pass device-feature reads as of `d82e6bd`: background —
clear only (`background-pass.ts:93-106`); opaque — depth24plus-stencil8 + optional pick MRT

- resolve + timestamps (`opaque-pass.ts:69-119`); oit — rgba16float+r8unorm MRT, depth
  load (`oit-pass.ts:38-65`); translucent — offscreen colour + MAX blend + composite
  (`translucent-pass.ts:30-58`); points — depth load, no write (`points-pass.ts:28-52`);
  labels — colour+resolve only (`label-pass.ts:1717-1734`); heatmap — r16float
  render+additive/max blend ×3 passes (`heatmap-pass.ts:63-157`); overdraw-compose —
  r16float sample (`overdraw-compose-pass.ts:26-51`, debug-only); graphics — colour load on
  the resolved target (`graphics-pass.ts:36-52`). Frame shell — encoder, swapchain acquire,
  compute pre-pass, submit (`render-loop.ts:262-286/:544`).
