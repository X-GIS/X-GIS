# Grid vector-field flow visualization — the motion layer as its own pass (#1333)

Design document (no production code) for how X-GIS animates a **gridded vector field** — S-111
surface currents today, GFS wind (#1273) and any future S-100 speed+direction grid unchanged.

It replaces the arrow-glyph drift that landed in `62e9d22b`. That approach is **structurally
wrong**, not merely under-tuned, and this document's first job is to record why — so the same
mistake is not re-derived in a year.

Lands under epic #1271 / #1333. Constrained by #1046: any new pipeline is dual-source DSL or
capability-gated, never a backend-identity fork. Held to CLAUDE.md §5 (render claims need real
verification) and §0 (5-year architecture).

---

## 1. What went wrong, precisely

### 1.1 The symptom

The drifting arrows **blink**. Each glyph fades out at the end of its lifetime and reappears at
its home cell. Phases are hashed per instance, so the field twinkles rather than pulsing in
unison — but every individual arrow is plainly seen to wink out and return.

### 1.2 The cause is the primitive, not the parameters

The blink is not a tuning failure. It follows from the model by necessity:

```
move a discrete glyph  →  it must be recycled (it cannot drift forever)
                       →  recycling is a position discontinuity
                       →  hiding a discontinuity requires a fade
                       →  a fade on a large, individually recognizable object IS a blink
```

Every link is forced. No value of lifetime, drift distance, or fade width breaks the chain,
because the chain does not depend on those values.

### 1.3 Where the model came from, and what did not come with it

`docs/plans/2026-07-14-particle-flow-design.md` §1.1 defines exactly this lifecycle — "particles
fade in, drift for a bounded lifetime, fade out, and respawn" — and it is correct **there**,
because there the moving object is a 1–2 px dot in a dense pool. Three properties make the
recycling invisible in that setting:

1. the individual is below the threshold of being tracked by the eye,
2. density is high enough that the aggregate reads as a field, not as objects,
3. (in the reference implementations) trails carry visual continuity across a respawn.

The drift in `62e9d22b` reused the lifecycle on the **arrow glyph** — a large, oriented,
band-coloured, individually recognizable symbol — where none of the three hold. The artifact-
hiding mechanism was left behind; only the artifact came along.

**Lesson for the ledger:** a lifecycle model is only as portable as the perceptual conditions
that make its artifacts invisible. Porting the mechanism without auditing those conditions is
how a proven design becomes a visible bug.

### 1.4 The second defect: the glyph lies about where it is

A drifting arrow keeps its **home cell's** bearing and colour for its whole life. After drifting
it sits over a location whose actual current may differ, still drawing the old cell's reading.
The motion is decorative rather than a depiction of the field. Fixing this inside the glyph model
means sampling the field per instance per frame — which is the flow pass below, with extra steps.

---

## 2. The industry model: two layers, not one animated layer

Mature vector-field visualization (nullschool, Windy, Cesium, ParaView, VisIt, MetOffice) does
not animate the glyph. It separates two readings of one field:

| layer                                                | question it answers                 | animated? |
| ---------------------------------------------------- | ----------------------------------- | --------- |
| **static glyphs** — arrows, wind barbs               | "which way, how much, exactly here" | **no**    |
| **flow field** — advected texture or dense particles | "what is the motion, overall"       | yes       |

The load-bearing property of the motion layer, in every one of those implementations, is that
**the carrier of motion is not a discrete recognizable object.** That is precisely why none of
them blink.

This also settles the S-111 conformance question cleanly. The IHO Portrayal Catalogue defines
static point symbols and nothing else — `<lineStyles/>`, `<areaFills/>` and `<pixmaps/>` are all
empty (`docs/standards/s-111/`). Under the two-layer model the catalogue layer is left **exactly
as specified and unanimated**, and the motion is an additive, clearly non-catalogue layer. The
drift approach, by contrast, animated the specified symbol itself.

---

## 3. Technique choice: IBFV over particle advection

Two standard techniques carry the motion layer.

### 3.1 Candidate (a) — GPU particle advection with a trail buffer

Thousands of particle positions live in a state texture, ping-ponged each frame; particles are
drawn as points into a trail target that is faded each frame. This is the nullschool/Windy stack.

- Requires: a particle-state ping-pong pair, a trail pair, a point-primitive draw, a particle
  count to tune, and a respawn policy (particles converge into sinks and must be scattered).
- Respawn still exists — it is merely hidden by density and trails. **The blink is suppressed,
  not eliminated.**

### 3.2 Candidate (b) — IBFV (Image-Based Flow Visualization) — **chosen**

van Wijk's technique. Per frame, over the whole screen:

1. sample the previous frame at the position reached by stepping **backward** along the velocity
   field (semi-Lagrangian advection),
2. decay it,
3. blend in a time-varying noise pattern,
4. optionally modulate by speed for colour.

That is one fullscreen draw against one ping-pong pair.

Why this is the right choice here:

- **No particles ⇒ no respawn ⇒ the blink is structurally impossible**, not suppressed. This is
  the property the user asked for, and it is a property of the algorithm rather than of tuning.
- **"The value at the position it moved to" is the algorithm.** The backward step is a texture
  fetch into the field, so the motion is by construction the real local current everywhere —
  §1.4's defect cannot occur.
- **Cost is O(screen pixels), independent of grid size.** A 596×433 CBOFS cell and a global GFS
  grid cost the same. Contrast the current CPU path, which regenerates ~70k arrow instances per
  blended frame (5.0 ms generate + 3.9 ms pack, measured).
- **Fragment shaders only.** No compute, so the WebGL2 arm carries it honestly — the #1046
  constraint that made compute a caps-gated enhancement in the particle-flow design, never the
  baseline.
- **Transitions become trivial.** Blending two forecast hours means blending the _field texture_;
  the visualization follows continuously because it is a pure function of that texture. No
  instance regeneration, no re-seeding, no phase bookkeeping.
- **Reusable.** It is a technique over "a 2-channel velocity texture", not over S-111. Wind
  (#1273) is the same pass with a different palette.

### 3.2.1 CORRECTION — the history lives in FIELD space, not screen space

Van Wijk's IBFV is described in screen space, and the first draft of this document adopted
that verbatim. Writing the shader surfaced two defects in that reading, both fatal here:

1. **A screen-space pass needs a per-fragment screen→geo inverse to know where in the field
   it is.** `coverage-ramp.ts` exists in its current form precisely because that is wrong:
   INC-A drew a single quad and recovered latitude with an inverse Mercator, which was
   correct _only_ under Mercator — every other flat projection misplaced rows, and the globe
   did not draw at all. The fix was to TESSELLATE and interpolate lon/lat per vertex. A
   fullscreen flow pass would reintroduce the exact bug that fix retired.
2. **Screen-space history is invalidated by camera motion.** The recursion reads the previous
   frame at a screen position; pan or zoom makes that reading stale, so the animation smears
   or must be reset on every camera move.

**So the ping-pong pair is in the coverage's own GRID space, not screen space.** Advection
becomes pure texture math in grid uv — `uv' = uv − velocity·dt/extent` — with no projection
anywhere in the recursive step. The resulting field texture is then drawn over the footprint
by the EXISTING tessellated coverage geometry, which is already projection-general and
globe-capable.

This is strictly better on three counts: the history is camera-independent (panning and
zooming no longer disturb the animation), the projection problem disappears rather than being
re-solved, and the drape is the proven one rather than a second path.

It costs the "O(screen pixels)" property claimed in §3.2 — the advection is now O(grid
texels). That is a fair trade and usually a win: a 596×433 CBOFS cell is 258k texels against
~2M pixels at 1080p. A grid far larger than the screen (global GFS) wants the working
resolution capped, which is a bounded, local concern rather than an architectural one.

### 3.3 What is deliberately NOT built

- Compute-shader advection (the caps-gated enhancement of the particle-flow design). IBFV does
  not need it.
- A general particle system.
- Streamline/LIC geometry extraction.
- Any change to the arrow, icon, circle, or text primitives beyond removing the drift.

---

## 4. Field encoding: u,v components, not speed + direction

Today `coverage-renderer.ts:151` uploads **only band 0** (speed, as `r16float`) plus a validity
mask. Direction never reaches the GPU. The flow pass needs both, and the encoding matters.

**Store east/north components (u, v) in a two-channel texture, not speed + direction.**

- Texture filtering is linear interpolation of the stored channels. Interpolating a **direction
  in degrees** is wrong across the 0/360 wrap — 350° and 10° average to 180°, the exact opposite
  of the correct 0°. Components have no wrap and interpolate correctly for free.
- Direction is undefined at zero speed; components degrade to (0,0) gracefully.
- This is the same rule already established CPU-side: `interpolateVectorCoverage`
  (`data/src/coverage/interpolate-vector.ts:11-17`) blends components for exactly this reason.
  Using components on the GPU makes it **one rule, applied in both places** rather than two
  encodings that must be kept consistent.
- The advection step wants a velocity vector, so components are also the form the algorithm
  consumes — no per-sample trig.

Validity: a nodata cell must not advect. `(u,v) = (0,0)` plus the existing validity mask is
sufficient; the pass leaves invalid regions untouched so land does not smear.

---

## 5. Where it plugs in

The pass is a close sibling of the **heatmap pass**, which already solves the same structural
problems, and should mirror it rather than invent a parallel mechanism.

| concern                                                                           | heatmap precedent                                      | flow pass                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| offscreen ping-pong pair, lazily allocated at canvas size, destroyed with the map | `HeatmapTargets` (`map/src/render/heatmap-targets.ts`) | `FlowTargets` — same shape                                                   |
| runs after the label pass, composites onto the resolved swapchain                 | `heatmap-pass.ts:1-6`                                  | **NO — see §5.1**: the flow pass is a PRODUCER and must precede its consumer |
| gated so an unused feature allocates nothing and renders byte-identically         | `scene.hasHeatmap`                                     | `scene.hasFlow`                                                              |
| stateless singleton implementing `RenderPass` (`label` / `shouldRun` / `execute`) | `passes/pass.ts`                                       | same                                                                         |
| per-pass role view                                                                | `HeatmapPassHost` in `pass-hosts.ts`                   | `FlowPassHost`                                                               |

### 5.1 CORRECTION — the flow pass is a PRODUCER, so it runs BEFORE opaque

This document originally placed the flow pass in the heatmap's slot (after labels, compositing
onto the resolved swapchain). Wiring it surfaced that as wrong, and the reason is structural
rather than a detail of scheduling.

**The heatmap pass is a COMPOSITOR**: it consumes its own offscreen targets and writes the final
image, so it must run after everything it draws on top of. **The flow pass is a PRODUCER**: it
writes an offscreen texture that the coverage drape SAMPLES in the same frame — and the coverage
draws in the OPAQUE pass (`opaque-pass.ts:283`). A flow pass scheduled after labels would hand
the drape last frame's advection every frame: the animation would still run, one frame stale —
invisible in isolation, wrong under scrubbing, and exactly the class of defect this environment
cannot see.

So the slot is **between `background` and `opaque`**: after the colour clear (bucket 0 owns that,
per `passes/AGENTS.md`) and before the consumer. The flow pass touches no swapchain attachment at
all — it renders only into its own ping-pong pair — so it neither claims `resolveTarget` nor
participates in the clear-ownership contract.

`PASS_CHAIN_ORDER` is byte-frozen and `pass-order-parity.test.ts` pins it against a literal, so
inserting the slot is a deliberate, reviewable edit in one authority rather than a silent drift —
which is exactly what that freeze is for.

Two contracts from `passes/AGENTS.md` that this pass must honor: colour-clear ownership belongs
to `background-pass` (the flow pass composites with `loadOp: 'load'`), and `resolveTarget`
belongs to exactly one pass per frame (`scene.resolveOwner`) — compositing onto the _resolved_
swapchain, as heatmap does, sidesteps it.

**Keep-warm.** IBFV advances every frame, so it must arm the on-demand render loop the same way
an animated graphics batch does — the two-gate lesson from `62e9d22b`: the animation clock write
AND the loop keep-warm are separate gates that fail differently, and both must be armed.

---

## 6. Phasing

Each phase is independently reviewable and independently green.

- **P0 — this document.**
- **P1 — revert the drift.** Remove drift from `arrow-retained.ts` (feat stride 29 → 26),
  `retained-arrow-packer.ts`, `compiled-arrow-store.ts`, `graphics-manager.ts` (both animation
  gates), `coverage-arrow-show.ts`. **Keep** the `CompiledArrowStore` extraction and the
  `stroke_units` SDF outline — both stand on their own merits. Arrows return to the
  catalogue-exact static portrayal.
- **P2 — u,v field texture.** Upload the vector field as a 2-channel texture alongside the
  existing scalar value/validity textures, from the S-111 speed+direction bands.
- **P3 — `FlowTargets` + the IBFV pass.** Ping-pong pair sized to the grid, the advect+noise+decay
  shader (dual source DSL, WGSL + GLSL twin), the u,v upload, the `scene.hasFlow` gate, and the
  keep-warm arming. The DRAW of the advected field reuses the tessellated coverage drape rather
  than a fullscreen triangle (§3.2.1), so it is projection-general and globe-capable for free.
- **P4 — wire the demo + verify.** `s111-live.xgis`, then the §5 gate: directional pixel-diff
  before/after, and a 4×4 full-resolution read of the frame. The deterministic-probe contract
  (pinned `t`) must still hold — IBFV is frame-recursive, so the probe pins the _frame count_,
  not just the clock.

## 7. Verification notes

- **The blink claim is falsifiable and must be tested as such.** IBFV has no respawn, so the
  gate is structural: assert the shader contains no lifetime/fade term at all, rather than
  asserting a fade looks smooth.
- **Frame recursion breaks naive determinism.** A pinned-`t` single-frame capture is not
  reproducible for a recursive filter; the harness must pump a fixed number of frames from a
  cleared target. This is a real cost of (b) over a stateless closed form and is called out here
  so it is designed for, not discovered.
- **No visual claim without a GPU.** The environment this was authored in has none. Every
  "it looks right" statement belongs to a real-GPU run, per §5.
- **Emission tests pin the shape now.** `coverage-ramp.ts`'s header records the same constraint
  and the same answer: the headed readback cannot run here, so a dsl-emission test asserts the
  structural properties (grid-space advection, no screen→geo inverse, WGSL and GLSL agreement)
  rather than waiting for a GPU that this environment does not have.
