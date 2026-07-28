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

## 7. Backend fork — a PREREQUISITE, not follow-up work

> **Corrected after building INC-2 far enough for the gates to answer.** The first draft filed
> the WebGL2 twin under "the part that bites", implying it could trail. It cannot: it blocks.

`flow-renderer.ts:17` states the shape of the problem — _"Beginning a pass into an offscreen
attachment is the one thing the two backends do not agree about."_ The sequencing consequence was
only visible once the code existed:

**Removing the ladder's scale from `effectiveDpr()` disables the DPR lever on the twin.** The
canvas becomes native for BOTH backends, but only the WebGPU pass-chain gains a scaled scene
target and an upscale to carry it. `renderFrameViaRhi` draws to FBO 0 and has no offscreen scene,
so on WebGL2 the ladder's notches 3-6 would stop shrinking anything at all — the lever silently
becomes a no-op on the backend that most needs it. That is a worse regression than the blurred
text this design exists to fix, and it is not something to land and follow up on.

So INC-2 lands as ONE change across both orchestrations, or not at all. `pass-order-parity.test.ts`
enforces exactly this and said so unprompted:

> _"twin ≠ authority − RHI_TWIN_MISSING: either a pass was ported (shrink RHI_TWIN_MISSING in this
> commit — lock the win) or a new pass was added without declaring its twin status"_

Declaring `scene-upscale` in `RHI_TWIN_MISSING` would satisfy the gate and ship the regression;
the gate is asking the right question and the honest answer is to port the twin.

CLAUDE.md §12's pipeline lesson still applies to the new compose and is already handled in the
build: `buildSceneUpscalePipeline` takes the SCREEN attachment's `sampleCount`, because that
attachment is the MSAA texture whenever `useResolve` and a pipeline whose multisample state
disagrees with its pass fails validation on every `SetPipeline` — invisible without a GPU.

### Acceptance gates, from a real build

INC-2 was implemented to a green `bun run build` and then reverted; the suite named the complete
set of structural gates it must satisfy. These are the acceptance criteria, not guesses:

| gate                            | what it demands of INC-2                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pass-order-parity` (authority) | `scene-upscale` declared in `DOCUMENTED_INSERTIONS` with the pass it precedes                                |
| `pass-order-parity` (twin)      | the twin ports it — see above                                                                                |
| `target-role-partition`         | scene/overlay is no longer a partition; the upscale is a SEAM that reads both, so the gate becomes three-way |
| `loc-ceiling-ratchet`           | `render-loop.ts` + `render-targets.ts` growth paid by extraction                                             |
| `raw-webgpu-ratchet`            | the new pass's raw WebGPU tokens routed through the RHI, or the baseline moved with justification            |
| `forced-cast-ratchet`           | no new `as unknown as` — the twin's FrameContext literal needs real values, not casts                        |

The design's own additions that survived the build unchanged: `EnsureResult` grows
`sceneResolveView` / `colorViewScreen` / `sceneScaled`; scene-side attachments (stencil, pick,
overdraw, scene MSAA, scene colour) size from SCENE pixels while the screen MSAA stays at canvas
size; `RenderTargets` needs a second size tracker because the ladder can move the scene while the
canvas is unchanged. The scene keeps its `sampleCount` rather than dropping to 1 when scaled —
scene pipelines are built at `getSampleCount()` and rebuilding them per notch is the 100-300 ms
cost `adaptive-quality.ts` says a frame-rate controller may not pay.

## 8. What this does not fix

The ladder still degrades the scene, and on a slow enough host the bathymetry ramp under the
numerals will be visibly soft. That is the intended trade, and #1406's LOD-first ordering already
makes it as late a trade as it can be. What changes is that when the trade finally is made, the
_reading_ stays a reading.
