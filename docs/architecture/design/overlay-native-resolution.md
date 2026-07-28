# Overlay at native resolution — dynamic resolution must not scale the text

**Status:** design, not yet implemented
**Author's problem statement:** _"잘 나오는데 반대로 말하면 다른곳에서는 제대로된 라벨도 못보잖아요"_ — it
looks fine on a fast machine, which is exactly the complaint: on a slow one you cannot read the
numbers.

## 1. The defect

`adaptive-dpr.ts` steps the device-pixel scale down when the host cannot hold 30 fps. That scale
multiplies the ONE device-pixel-ratio the whole frame is built from:

```ts
// engine/src/gpu/quality.ts:348
export function effectiveDpr(interacting = false): number {
  const cap = interacting && QUALITY.interactionDpr !== null ? QUALITY.interactionDpr : getMaxDpr()
  if (typeof window === 'undefined') return 1
  return Math.min(window.devicePixelRatio || 1, cap) * adaptiveDprScale() // ← the scale
}

// map/src/render-loop.ts:138
const dpr = resizeCanvas(this.host.ctx, effectiveDpr(this.host._interacting))
```

`resizeCanvas` sizes the **canvas backing store** itself, so there is exactly one render resolution
for the frame and the browser upscales the finished canvas to its CSS box. Measured on the
`coverage_bathymetry` demo under SwiftShader (a stand-in for a slow host), CSS box 580×800:

| `devicePixelRatio` | backing store | effective scale |
| ------------------ | ------------- | --------------- |
| 1                  | 348×480       | **0.60×**       |
| 2                  | 580×800       | 0.50×           |
| 3                  | 870×1200      | 0.50×           |

Label count and label text were identical in all three (15 labels, `19.4 / 25.0 / 29.7 / 40.0 /
9.0`). Only the resolution moved. `STEPS = [1, 0.85, 0.72, 0.6, 0.5]` (`adaptive-dpr.ts:44`) — the
run had walked to the floor.

The ladder is doing its job, and its own header states the trade it is making: _"a blurry map beats
a frozen one"_. That trade is correct **for the scene**. It is wrong for the overlay, because a
sounding numeral is not decoration that degrades gracefully — it is the only information that layer
carries, and a chart whose depths cannot be read has failed at the thing it exists to do. The
ladder currently has no way to express that distinction: every pixel is equal to it.

## 2. What mature engines do

Dynamic resolution is applied to the **scene** colour target; UI/HUD is composited afterwards at
native resolution. Unreal's `r.ScreenPercentage` scales the 3D scene while UMG renders at full res;
Unity's dynamic resolution scales the render target while a screen-space-overlay canvas draws at
native. The split is not an optimisation — it is the recognition that text and geometry have
different failure modes under resolution loss.

X-GIS has the ladder but not the split.

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

```
scene passes (background → flow → opaque → oit → translucent → hillshade → points → heatmap)
        ↓ render into                     sceneColor MSAA   @ sceneW × sceneH
        ↓ resolve into                    sceneColor        @ sceneW × sceneH
        ↓ full-screen upscale draw into   screenView        @ screenW × screenH
overlay passes (labels, graphics)
        ↓ render into                     screenView        @ screenW × screenH
```

- `screenW/H = round(clientSize × screenDpr)` where `screenDpr` is `min(devicePixelRatio, cap)`
  **without** the adaptive scale. The canvas backing store is native again.
- `sceneW/H = round(screenW/H × adaptiveDprScale())`.
- The upscale is a full-screen textured draw. `map/src/render/compose-pipelines.ts` already owns
  MSAA-aware full-screen compose pipelines for the OIT / overdraw paths; this is another consumer,
  not a new concept.

**Clip space is resolution-independent**, so the camera and every MVP are unchanged — a matrix that
is correct for the scene target is correct for the screen target. Only quantities measured in
device pixels differ, and they are already per-pass inputs (`{ width, height }` handed to
`stage.render`, `ctx.dpr` for text/icon sizing).

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

Each lands green on its own; none is a refactor-and-hope.

**INC-1 — make the distinction exist, change nothing.** Split `FrameContext` into `scene` / `screen`
sub-objects, both populated from the same numbers. Add the partition gate over `PASS_CHAIN_ORDER`.

- _Gate:_ frame hash-equality — the strongest rung of the §12 render ladder — before vs after, at
  ladder scale 1 AND at a pinned 0.6. Same code path, so `md5sum` equality is reachable and a
  directional diff is not good enough here.

**INC-2 — decouple the canvas from the ladder.** `resizeCanvas` takes `screenDpr` (no adaptive
scale); the scene target takes the scaled size; add the upscale compose between the scene resolve
and the overlay passes. Overlay passes still draw at the scene's resolution.

- _Gate:_ at scale 1, frame hash-equality against INC-1 (the upscale is identity, so this must be
  byte-exact — if it is not, the compose is wrong and that is the bug this rung exists to catch).
  At scale 0.6, a directional diff proving DC > 0 and the scene visibly resampled.

**INC-3 — move the overlay to native.** Label + graphics passes render into `screenView` at
`screenDpr`; text/icon sizing reads `screen.dpr`.

- _Gate:_ at scale 0.6, ×8 crops of a numeral before/after read at full resolution (§5 — the whole
  point is glyph sharpness, and a scalar cannot judge it); label COUNT and label TEXT must be
  unchanged (they were resolution-independent already, per §1's table, so any change is a
  positioning regression); frame-time median at scale 0.6 within noise of INC-2's, measured on the
  same commit both ways per §12.

**Out of scope, deliberately:** the picking buffer (`render-loop.ts:815-835`) keeps the scene's
resolution — picking is a scene query and gains nothing from native pixels; `?debug=overdraw`'s
accumulator likewise stays scene-side.

## 7. Backend fork — the part that bites

`flow-renderer.ts:17` states it plainly: _"Beginning a pass into an offscreen attachment is the one
thing the two backends do not agree about."_ Both orchestrations must land together:

- the native pass-chain (`pass-chain.ts` `buildRenderNodes`, the WebGPU authority), and
- the forced-WebGL2 linear twin (`render-loop.ts` `renderFrameViaRhi`),

with `pass-order-parity.test.ts` holding them in step. And CLAUDE.md §12's pipeline lesson applies
directly to the new compose: a pipeline built for the scene pass carries that pass's depth/sample
state, and reusing it on a colour-only compose makes every `SetPipeline` a validation error that is
**invisible without a GPU** — the step succeeds against a recorder and the only symptom is a layer
that never draws. The compose pipeline must derive its depth/sample state from the target pass and
be gated by asserting the created descriptor through the real `Material` path.

## 8. What this does not fix

The ladder still degrades the scene, and on a slow enough host the bathymetry ramp under the
numerals will be visibly soft. That is the intended trade. What changes is that the _reading_ stays
a reading.
