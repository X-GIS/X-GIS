# Overlay at native resolution — dynamic resolution must not scale the text

**Status:** design, not yet implemented
**Author's problem statement:** _"잘 나오는데 반대로 말하면 다른곳에서는 제대로된 라벨도 못보잖아요"_ — it
looks fine on a fast machine, which is exactly the complaint: on a slow one you cannot read the
numbers.

## 1. The defect

> **Re-verified 2026-07-28 against landed code.** The first draft of this section was written
> against `engine/src/gpu/adaptive-dpr.ts` and a flat `STEPS = [1, 0.85, 0.72, 0.6, 0.5]`. That
> module no longer exists: #1406 replaced it with `adaptive-quality.ts` and a two-lever ladder.
> The measurements and the framing below are redone against the module that actually ships.
> CLAUDE.md §12 — plan docs drift from landed reality; re-verify the predecessor's ACTUAL landed
> scope against the code, not against the doc's description of it.

`adaptive-quality.ts` steps an ordered degradation ladder when the host cannot hold 30 fps
(`DEGRADE_MS = 33.4`). Each notch names a far-field LOD boost and a device-pixel scale
(`adaptive-quality.ts:64`):

| notch | `farLod` | `dpr` |
| ----- | -------- | ----- |
| 0     | 1        | 1     |
| 1     | 2        | 1     |
| 2     | 4        | 1     |
| 3     | 4        | 0.85  |
| 4     | 4        | 0.72  |
| 5     | 6        | 0.6   |
| 6     | 6        | 0.5   |

**The ladder already agrees with the premise of this document.** Its own header says why the two
pure-LOD notches come first:

> _"FAR-FIELD LOD is spent BEFORE device pixels. Coarsening tiles several camera altitudes away is
> close to invisible — they are already metres-per-pixel — while lowering DPR blurs labels and text
> across the WHOLE frame. The map spends its horizon before it spends the user's legibility."_

That is a real, already-landed mitigation and this design does not replace it. What it does not do
is survive its own success: notches 3-6 exist because LOD alone does not get a slow host to budget,
and the moment the ladder reaches them the text blurs with everything else. The ordering buys time;
it does not keep the reading legible.

And the ladder does reach them. `adaptiveDprScale()` multiplies the one device-pixel-ratio the
whole frame is built from:

```ts
// engine/src/gpu/quality.ts:348
export function effectiveDpr(interacting = false): number {
  const cap = interacting && QUALITY.interactionDpr !== null ? QUALITY.interactionDpr : getMaxDpr()
  if (typeof window === 'undefined') return 1
  return Math.min(window.devicePixelRatio || 1, cap) * adaptiveDprScale() // <- the scale
}

// map/src/render-loop.ts:138
const dpr = resizeCanvas(this.host.ctx, effectiveDpr(this.host._interacting))
```

`resizeCanvas` sizes the **canvas backing store** itself, so there is one render resolution for the
frame and the browser upscales the finished canvas to its CSS box. Measured on
`coverage_bathymetry` under SwiftShader (a stand-in for a slow host), CSS box 580x800:

| `devicePixelRatio` | backing store | scale | ladder notch |
| ------------------ | ------------- | ----- | ------------ |
| 1                  | 417x576       | 0.72  | 4            |
| 2                  | 580x800       | 0.50  | 6 (floor)    |

Label count and label text were identical in both (38 labels, same numerals) — only the resolution
moved. A sounding numeral is not decoration that degrades gracefully: it is the only information
its layer carries, and a chart whose depths cannot be read has failed at the thing it exists to do.

## 2. What mature engines do

Dynamic resolution is applied to the **scene** colour target; UI/HUD is composited afterwards at
native resolution. Unreal's `r.ScreenPercentage` scales the 3D scene while UMG renders at full res;
Unity's dynamic resolution scales the render target while a screen-space-overlay canvas draws at
native. The split is not an optimisation — it is the recognition that text and geometry have
different failure modes under resolution loss.

X-GIS has the ladder, and (since #1406) an ordering that protects legibility for as long as LOD
lasts. It does not have the split, so past notch 2 the protection runs out.

## 3. Why this is smaller than it looks

The seam already exists. Three facts from the current code:

1. **Passes already render into an offscreen MSAA colour texture, not straight to the swapchain.**
   `FrameContext` carries `colorView` (the MSAA texture when `useResolve`) separately from
   `screenView` (`map/src/render/frame-context.ts:53-58`).
2. **Exactly one SCENE pass owns the MSAA resolve**, derived by a single authority
   (`deriveResolveOwner`, `map/src/render/bucket-scheduler.ts:577`), whose type is
   `'points' | 'hillshade' | 'composite' | 'opaque'` — all scene passes. The scene therefore
   already has a well-defined "last writer, then resolve" boundary.
3. **The label pass is already a separate, later, load-and-draw pass with its own resolve**
   (`map/src/render/passes/label-pass.ts:2085-2096`):

   ```ts
   const tPass = encoder.beginRenderPass({
     colorAttachments: [
       {
         view: ctx.colorView,
         resolveTarget: ctx.useResolve ? ctx.screenView : undefined,
         loadOp: 'load',
         storeOp: 'store',
       },
     ],
   })
   ```

So the work is not "introduce an offscreen pass". It is "let the scene's offscreen be a different
SIZE from the swapchain, and give the already-separate overlay pass the native one".

## 4. Target architecture

> **Revised after reading the target lifecycle.** Two findings changed the plan; both make it
> smaller, and one of them dissolves an increment.

**Finding 1 — the offscreen seam is conditional.** §3's "passes already render into an offscreen
MSAA texture" holds only when MSAA is on. `render-targets.ts:250` is explicit:

> _"When SAMPLE_COUNT === 1 (mobile / no MSAA), render DIRECTLY to the swapchain texture and never
> set a resolveTarget."_

So on mobile, under `?safe`, and on the software-GPU path this container actually runs, there is no
offscreen at all. The scene therefore needs its OWN target rather than a resized existing one.

**Finding 2 — the overlay needs no change, so INC-3 folds into INC-2.** The right move is not to
give the overlay a new native target; it is to leave the existing screen attachment exactly where
it is — canvas-sized, which is now native — and give the SCENE the new smaller pair:

```
scene passes    → sceneMsaa @ sceneSize (sc)  ─resolve→  sceneColor @ sceneSize (1)
scene-upscale   → sceneColor  ─sampled, full-screen draw→  the SCREEN attachment @ screenSize
overlay passes  → the SCREEN attachment, loadOp 'load'          (UNCHANGED — as today)
```

where "the SCREEN attachment" is whatever it already is: the screen-sized MSAA texture when
`useResolve`, else `screenView` itself. This matters for one specific reason: **every existing
pipeline keeps its `sampleCount`.** Pointing the label pass at a single-sample view instead would
have needed a second pipeline variant, and a pipeline whose sample state does not match its pass is
a validation error that is invisible without a GPU — CLAUDE.md §12's pipeline lesson, and the exact
trap this design was most likely to fall into. Only ONE new pipeline appears: the upscale, built
for the screen attachment's sample count.

INC-1 already pays for this: scene passes read `ctx.scene`, which simply starts reporting the
smaller size. Their `resolveTarget` moves from `ctx.screenView` to a new `ctx.sceneResolveView`
(the sceneColor view when scaled, `screenView` when not), which the partition gate can police the
same way it polices the geometry.

**Both new targets exist only while `adaptiveDprScale() < 1`.** At notch 0-2 the frame is
byte-for-byte what it is today: no extra texture, no extra pass, no upscale. That is worth stating
as a property rather than an optimisation — it means a host that never trips the ladder cannot be
regressed by this change at all, and it makes INC-2's "scale 1 ⇒ identical" gate a statement about
code that does not run rather than about a blit being exactly identity.

- `screenW/H = round(clientSize × screenDpr)`, `screenDpr = min(devicePixelRatio, cap)` with **no**
  adaptive scale. The canvas backing store is native again.
- `sceneW/H = max(1, round(screenW/H × adaptiveDprScale()))`, `sceneDpr = screenDpr × scale`.

**Clip space is resolution-independent**, so the camera and every MVP are unchanged — a matrix
correct for the scene target is correct for the screen target. Only device-pixel quantities differ,
and INC-1 made every one of them name its target.

**Consequence — the pick attachment.** `pickTexture` is a scene-pass attachment, so it is
scene-sized, while `pickAt` converts CSS→device pixels against `canvas.width`
(`interaction-controller.ts:178`). That would read the wrong texel the moment the two diverge. The
fix is single-authority rather than a scale factor threaded to the call site: derive the coordinate
from the texture being read, not from the canvas. The forced-WebGL2 branch has the same shape with
its own offscreen pick RT. A gate must cover a pick at scale < 1, or this is a silent
off-by-a-fraction that only appears on slow hosts — the same class of bug as the one being fixed.

## 5. The hazard this design must not create

`quality.ts:340` argues the current single-DPR arrangement is a feature:

> _"every consumer — the render loop, the MVP altitude, `canvasEffectiveDpr`'s fallback — already
> reads through this one function, and the swapchain and the frame math cannot disagree about how
> many device pixels exist."_

That is exactly right, and this design introduces a second DPR. **That is the whole risk.** CLAUDE.md
§12's "second ratchet" lesson is the same shape: two authorities drift, and the drift is silent.

Mitigations, in order of strength:

1. **`canvasEffectiveDpr` gets STRICTLY better, not worse.** It is the authority for
   device-px↔CSS-px conversion _outside_ the render loop (project/unproject/getBounds/fitBounds).
   Today its answer wobbles every time the ladder notches, because the canvas is the scaled buffer.
   After this change the canvas is always native, so those conversions stop depending on the
   ladder at all. This removes a real (currently unreported) inconsistency rather than adding one.
2. **The two sizes never appear as bare numbers.** `FrameContext` stops carrying `w`, `h`, `dpr` and
   carries two named targets instead, so a pass cannot use "the" size without saying which:

   ```ts
   interface FrameContext {
     scene:   { w: number; h: number; dpr: number; colorView: GPUTextureView; ... }
     screen:  { w: number; h: number; dpr: number; view: GPUTextureView }
   }
   ```

   A pass that reads the wrong one is a compile error at the field name, not a subtle offset.

3. **The scene/overlay split is DERIVED, not remembered.** `PASS_CHAIN_ORDER`
   (`map/src/render/passes/pass-order.ts:19`) is already the frozen single authority for pass
   sequence, and `deriveResolveOwner` already derives the resolve owner from it constructively. The
   overlay set becomes a second derivation from the same constant — a new pass lands in one of the
   two buckets by construction, and a gate asserts the two buckets partition `PASS_CHAIN_ORDER`
   exactly (no pass in both, none in neither). This is the §12 "path-keyed gate dies when the paths
   move" lesson applied up front.

## 6. Increments

**INC-1 — make the distinction exist, change nothing. LANDED.** `FrameContext` carries `scene` /
`screen`, both populated from the same numbers; `ctx.w` no longer exists. Scene/overlay membership
derived from `PASS_CHAIN_ORDER` with a partition gate (`target-role-partition.test.ts`).

- _Gate as run:_ hash equality was attempted and is NOT reachable on this scene — two same-code
  runs differ — so the honest rung is the directional diff. Cross-code 0.0167-0.0240% against a
  same-code noise band of 0.0165-0.0217%: a no-op within noise.

**INC-2 — the scene gets its own smaller target (absorbs the former INC-3).** Canvas sized at
`screenDpr`; scene MSAA + sceneColor allocated at scene size _only when the scale is below 1_;
scene passes resolve into sceneColor; a new upscale pass composites sceneColor into the screen
attachment before the overlay draws. Overlay passes unchanged. Pick coordinate derived from the
pick texture.

- _Gate:_ at scale 1, the new code does not run — assert that constructively (no scene texture
  allocated, upscale pass `shouldRun()` false) rather than by diffing pixels. At a pinned scale
  0.72 and 0.5: label COUNT and label TEXT unchanged (they are resolution-independent — §1's table
  is the evidence), ×8 crops of a numeral read at full resolution before/after (§5 — the whole
  point is glyph sharpness and no scalar can judge it), a pick at scale < 1 hits the same feature
  it hits at scale 1, and the frame-time median at scale 0.5 within noise of today's measured on
  the same commit both ways.

## 7. Backend fork — the twin keeps its canvas scale, and that unblocks INC-2

> **Corrected twice.** Draft 1 filed the twin as follow-up work. Draft 2, after building INC-2
> to a green `bun run build` and reading what the gates said, concluded the twin BLOCKS it.
> Draft 3 — this one — is why draft 2 was too pessimistic, and it is the plan.

The regression draft 2 found is real but it is not caused by the split. It is caused by
removing the ladder's scale from the CANVAS for a backend that has nowhere else to apply it:

- `renderFrameViaRhi` draws into one screen pass on FBO 0 and has no offscreen scene, so it
  cannot shrink a scene target.
- If `effectiveDpr()` simply drops the scale, the twin's canvas goes native and nothing else
  shrinks. The ladder's notches 3-6 stop doing anything on WebGL2 — a silent removal of the DPR
  lever on the backend that most needs it.

The fix is one line of intent, not a port: **the twin keeps applying the scale to its canvas.**

```ts
// The twin has no offscreen scene, so it keeps the pre-split behaviour: the ladder scales its
// CANVAS and its overlay blurs with the scene. Dropping the scale here without an offscreen
// would disable the DPR lever on WebGL2 entirely.
const canvasScale = rendersViaTwin ? adaptiveDprScale() : 1
const dpr = resizeCanvas(ctx, effectiveDpr(interacting) * canvasScale)
const sceneScale = rendersViaTwin ? 1 : adaptiveDprScale()
```

Then each backend is internally consistent and neither regresses:

|              | canvas            | scene    | overlay under a scaled ladder |
| ------------ | ----------------- | -------- | ----------------------------- |
| WebGPU chain | native            | scaled   | **native — the fix**          |
| WebGL2 twin  | scaled (as today) | = canvas | blurs (as today)              |

`scene-upscale` is then genuinely twin-missing, which is what `RHI_TWIN_MISSING` exists to say —
the repo's own idiom for "this orchestration does not do that yet", enforced by
`pass-order-parity`. Draft 2's reading of that gate's message was right about the mechanism and
wrong about the conclusion: declaring the pass twin-missing ships a regression only if the twin
ALSO loses the scale. It does not have to.

Porting the twin becomes a genuine follow-up that IMPROVES WebGL2 rather than a prerequisite
that prevents a regression. The machinery is there when it is done: `rhi.beginOffscreenPass`
already nests an offscreen inside the live screen pass and restores FBO 0 on end (the flow pass
does exactly this, `flow-renderer.ts:188`), and the twin's overlay split point already exists at
its `labelPass.execute` call.

### Verification reality, stated up front

This container and CI run the WebGL2 twin (WebGPU falls back under SwiftShader), so the path
INC-2 changes is the one that CANNOT be exercised here. ADR-0004 already covers this: CI proves
the no-GPU gates, render-correctness is checked locally on a real GPU, and the PR template
carries a "⏳ Pending — by-construction gates pass; the on-screen result is not yet GPU-verified"
option for exactly this case. INC-2 lands with every structural gate green and that box ticked,
naming the view: a scaled-ladder frame on the WebGPU backend.

### The complete cost of INC-2, measured

INC-2 was implemented three times, each to a green `bun run build`, and reverted each time. The
third pass drove every structural gate to its verdict, so this is an accounting rather than an
estimate. **Four of the seven pieces are done and proven; two remain and are well-defined.**

| #   | piece                                           | state                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Upscale shader (DSL module, dual-emit capable)  | ✅ emits correct WGSL — `textureSample` through a FILTERING sampler, so the upscale reads as a resolution scale and not a mosaic                                                                                                                                                                                                                                                                                       |
| 2   | Scene targets + resolve retarget                | ✅ `EnsureResult` grows `sceneResolveView` / `colorViewScreen` / `sceneScaled`; scene-side attachments size from SCENE pixels, screen MSAA stays at canvas size; a SECOND size tracker, because the ladder can move the scene while the canvas is unchanged                                                                                                                                                            |
| 3   | Pass order + twin declaration + partition       | ✅ `pass-order-parity` green (insertion declared, `scene-upscale` in `RHI_TWIN_MISSING`); `target-role-partition` widened to THREE roles — the upscale is a SEAM that reads the scene target and writes the screen attachment, so forcing it into a half would have broken the rules the halves assert                                                                                                                 |
| 4   | Twin keeps its canvas scale                     | ✅ no WebGL2 regression — each backend internally consistent                                                                                                                                                                                                                                                                                                                                                           |
| 5   | **The pass must be RHI-native, not raw WebGPU** | ❌ `raw-webgpu-ratchet`: "route through the RHI, don't grow the baseline". `flow-renderer.ts` is the model and says so explicitly — it is "inside both the concrete-backend-import ratchet and the raw-WebGPU ratchet with no baseline entry — the F3/P5 direction, arriving one pass at a time." A new pass should be RHI-typed from birth. That means an RHI pipeline/`Material`, not `device.createRenderPipeline`. |
| 6   | `render-loop.ts` −15 LOC                        | ❌ the FrameContext construction extracts to a `frame-context.ts` factory — where it belongs anyway                                                                                                                                                                                                                                                                                                                    |
| 7   | Forced-cast −2                                  | ❌ trivial: the twin's FrameContext literal has four `null as unknown as GPUTextureView`; one shared constant takes the file from 8 casts to 5, BELOW its baseline of 6                                                                                                                                                                                                                                                |

The ratchets are not bureaucracy here — they are the reason this accounting exists. Each one
named a real property the first two attempts had not thought about, and #5 in particular is a
genuine architectural instruction: the increment's new pass should arrive on the RHI side of the
#991 migration rather than adding to the raw-WebGPU debt it is shrinking.

**Scoping consequence.** INC-2 is not "implement the feature". It is the feature PLUS an
RHI-native pass PLUS a god-file extraction, and its render verification is pending real GPU
access this environment does not have. That is a deliberate scoping decision for whoever picks
it up, not something to discover halfway through a fourth attempt.

## 8. What this does not fix

The ladder still degrades the scene, and on a slow enough host the bathymetry ramp under the
numerals will be visibly soft. That is the intended trade, and #1406's LOD-first ordering already
makes it as late a trade as it can be. What changes is that when the trade finally is made, the
_reading_ stays a reading.
