# Line labels: world-anchored placement and path collision

Design document (no production code) for the two remaining MapLibre parity gaps in
`symbol-placement: line`, both traced to the same root: **X-GIS decides where a line label goes,
and how much room it occupies, in SCREEN space, while MapLibre decides both in the tile's own
frame.** Everything below is measured against MapLibre GL JS on OFM Positron at
`#16.7/37.79172/126.79102` and `#16/37.79172/126.79102` — the camera from the original user
report — using the harnesses landed in `playground/e2e/_debug-shield-spacing.spec.ts` and
`_debug-ml-collision-boxes.spec.ts`.

Follows #1358 (spacing cadence), #1370 (paired-symbol badge box) and #1383 (extent-based edge
inset), which closed the parity gaps that did _not_ need a frame change. These two do.

Held to CLAUDE.md §0 (5-year architecture), §5 (a render claim needs a real gate), §2
(right-sized, not gold-plated).

---

## 1. The two symptoms, and why they are one problem

### 1.1 Phase — the chain is anchored to the viewport, not the world

`label-pass.ts` projects a polyline's vertices to screen, then walks the **screen** polyline
placing a label every `spacingPx` starting at `spacingPx / 2` from the start of the visible run
(`placeLabelsAlongLine`). The origin of that walk is wherever the road happens to enter the
viewport, so the whole chain slides as the user pans, and it does not agree with the reference.

Measured at z16.7 after #1383, on the route-400 chain:

|          | shield 1  | shield 2   | shield 3   |
| -------- | --------- | ---------- | ---------- |
| MapLibre | (22, 428) | (329, 322) | (636, 216) |
| X-GIS    | (18, 428) | (325, 324) | (632, 218) |

The **cadence** matches (that was #1358 — 0.999–1.003 of the reference across a zoom sweep);
the **phase** is offset by ~4 px. Four pixels is cosmetically small, but the mechanism behind it
is not: the offset is a function of the camera, so it is not stable under pan, and it cannot be
tuned away.

MapLibre computes symbol anchors once per tile, in tile units, at bucket build time
(`symbol_layout.ts`, `getAnchors`), from the line's own first vertex. The anchors are baked into
the bucket and only transformed on screen. Phase is therefore a property of the DATA, invariant
under camera motion, and identical between two clients showing the same tile.

### 1.2 Extent — a line label collides as a box, not as its path

MapLibre models a line symbol's collision footprint as a **chain of circles along the label's
path** (`CollisionFeature` with `circleDiameter`, one circle per ~`boxSize` of path length), not
as a single AABB. Its collision debug at z16 renders exactly that: a run of red circles down
Dogam-ro is the rejected road-NAME label, and the red square beside "Wijeon-ri" is the rejected
route-14 shield.

X-GIS uses one AABB per line label. Consequences, both observed at that camera:

- A long road name that curves across other labels only conflicts where its single box overlaps,
  so X-GIS draws "Dogam-ro 도감로" where MapLibre drops it.
- Conversely a straight label's box is a poor fit for a curved path, over-blocking on the concave
  side.

This is the same frame problem: the box is computed from the SCREEN-projected glyph run, and a
box is the only shape that survives that projection cheaply. In tile space the path is known and
a circle chain is natural.

---

## 2. What we are NOT doing

**Not** moving label layout into the tile worker. MapLibre bakes anchors at bucket build; X-GIS
dispatches labels per frame from `forEachLineLabelPolyline`. Matching MapLibre's _architecture_
would be a rewrite of the label pass, the tile pipeline and the collision index at once — and the
observable behaviour we need does not require it (§3).

**Not** changing the cadence. `lineLabelSpacingPx` (#1358) is measured-correct and stays the
authority for the step size.

**Not** touching point labels. Both changes are gated on `placement === 'line' | 'line-center'`.

---

## 3. The key observation: mercator metres are already a world frame

`VectorTileRenderer.forEachLineLabelPolyline` hands the label pass
`(polylineMercX: Float64Array, polylineMercY: Float64Array, props)` — **mercator metres**, not
screen pixels, and sliced per tile, so each polyline's first vertex is a tile-derived, camera-
invariant point.

That is all the anchoring we need. We do not have to move to tile-local units to get MapLibre's
_invariant_; we only have to stop starting the walk at the viewport.

### 3.0 REFUTED BY MEASUREMENT — read before implementing §3.1

The anchor rule in §3.1 was implemented and measured, and it is **wrong**. It is kept rather
than deleted because it is the obvious rule and will otherwise be re-derived from scratch.

Walking from the polyline's first vertex does deliver camera invariance — that part held, and
was unit-provable — but it does NOT agree with the reference. At z16.7 the chain moved from
~4 px off to **155 px off, uniformly across all three anchors**:

|                              | shield 1   | shield 2   | shield 3   |
| ---------------------------- | ---------- | ---------- | ---------- |
| MapLibre                     | (22, 428)  | (329, 322) | (636, 216) |
| X-GIS, walking from vertex 0 | (176, 374) | (484, 272) | (791, 164) |

The offset is constant (cadence intact, so #1358 is unaffected) and is ~half a step: the
on-screen spacing at z16.7 is ~325 px and the error is 155. That is the signature of a
**half-step phase convention mismatch**, not of a wrong origin scale.

So the origin is right in kind and wrong in detail. Leads, in order of likelihood:

1. MapLibre's `getAnchors` does not start at `spacing / 2`. It offsets by the LABEL's own
   length (`labelLength / 2`) and, for a line shorter than the spacing, centres the single
   anchor — so the first anchor is not at a fixed fraction of the step.
2. The line it walks is the TILE-CLIPPED geometry including the tile buffer, so its vertex 0 is
   not the same point as our polyline's vertex 0 even for the same road.
3. `getAnchors` resamples with `EXTENT`-quantised positions, which shifts anchors by up to half
   a tile unit — too small to explain 155 px, so this is a refinement, not the cause.

#### The convention, measured

That measurement has now been done, without a browser: MapLibre's three anchor screen positions
at z16.7 were unprojected to mercator and their arc-length along the decoded `ref=400` polyline
(tile `14/13962/6331`) computed directly.

| ML anchor (pane px) | along-line (merc px @ z16.7) | perpendicular error |
| ------------------- | ---------------------------- | ------------------- |
| (22, 428)           | 1094.1                       | 0.5 px              |
| (329, 322)          | 1418.9                       | 1.6 px              |
| (636, 216)          | 1743.8                       | 0.1 px              |

The sub-2 px perpendicular error confirms the camera + geometry maths, so the along-line numbers
are trustworthy. Two things follow:

1. **The step is confirmed** — consecutive anchors are 324.8 and 324.9 px apart against the
   `200 × 2^frac(z)` prediction of 324.9. #1358 is exactly right.
2. **The phase residual is a constant 119.3 px**, i.e. `0.367 × step` — _not_ `step / 2`
   (162.4). That is why the vertex-0 walk missed.

And 119.3 is not an arbitrary number. Walking the polyline for tile-boundary crossings puts the
first one at along-line **119.8** — matching the residual to 0.5 px. Predicting anchors as
`tileEntry + k · step`:

|           |       |       |       |            |            |
| --------- | ----- | ----- | ----- | ---------- | ---------- |
| predicted | 119.8 | 444.7 | 769.6 | **1094.5** | **1419.4** | **1744.3** |
| measured  | —     | —     | —     | **1094.1** | **1418.9** | **1743.8** |

Error 0.4 / 0.5 / 0.5 px on the three anchors that are on screen.

**So the phase origin is the point where the line enters the tile, and the first anchor sits AT
that point — offset 0, not half a step.** Lead 2 above was right that the origin is the tile
clip; the `spacing / 2` half of the rule was the wrong part.

**Caveat before implementing.** This is ONE line, three anchors, one camera. The agreement is
tight enough that coincidence is unlikely, but the rule must be confirmed on at least a second
route and a second zoom before it is worth wiring.

#### Is X-GIS's vertex 0 already the entry point? No.

The hope was that the polyline from `forEachLineLabelPolyline` is already tile-clipped, so its
vertex 0 would BE the entry point and INC-1 would collapse to deleting the `+ step / 2`. It is
not. The decoded `ref=400` geometry from tile `14/13962/6331` straddles the tile bounds on both
sides — it carries the standard MVT **buffer**:

|             | lon                      | vs tile edge                        |
| ----------- | ------------------------ | ----------------------------------- |
| tile bounds | `[126.78223, 126.80420]` | —                                   |
| vertex 0    | `126.78154`              | **0.000687° WEST of the west edge** |
| last vertex | `126.80489`              | **0.000691° EAST of the east edge** |

13 of the 16 vertices are inside; the other three are buffer overhang, symmetric to within
0.4 %. So the walk's origin sits ~119 px _before_ the tile edge at z16.7 — which is exactly the
119.8 px entry offset measured above, and exactly the phase error. The two numbers agreeing from
independent directions is the strongest evidence in this document.

**Consequence for INC-1.** The phase origin must be the tile-boundary crossing, so the walk has
to either clip the polyline to the tile bounds first or find the crossing and start the
`k · step` chain there. Not a one-line change, but a bounded one, and the target is now a number
rather than a guess. The crossing is a property of the polyline and the tile, not of the camera,
so the camera invariance the vertex-0 walk did deliver is preserved.

#### Both prerequisites are now met

**The rule holds across the zoom sweep.** Re-running the along-line analysis on MapLibre's
captures at every sampled zoom, and testing `(s − tileEntry) mod step` for each anchor:

| zoom | step  | tile entry | residual per anchor    |
| ---- | ----- | ---------- | ---------------------- |
| 16.0 | 200.0 | 73.8       | +0.2, −0.8, −0.7, −0.6 |
| 16.2 | 229.7 | 84.7       | +0.1, −0.8, −0.4, −0.3 |
| 16.5 | 282.8 | 104.3      | −0.6, −0.1, −0.1, −0.1 |
| 16.7 | 324.9 | 119.8      | −0.7, −0.3, −0.2       |
| 16.9 | 373.2 | 137.6      | −0.7, −0.3             |

Sixteen anchors, five zooms, every residual inside ±1 px. Note the entry offset itself moves
73.8 → 137.6 across the sweep while the residual does not — so this is the rule reproducing,
not a constant fitted to one camera.

**The tile identity is available.** `LabelFeatureSource.forEachLineLabelPolyline` already
iterates `for (const key of seen)` over tile keys and emits each tile's runs inside that loop;
the key simply is not passed to the callback. Exposing it is a signature change on
`fn(polylineMercX, polylineMercY, props)` plus one argument at the emit site — not a new lookup.

#### INC-1 recipe

1. Thread the tile key through `forEachLineLabelPolyline`'s callback.
2. Per polyline, find where it crosses into the tile's own bounds (it enters from the MVT
   buffer — see above). That crossing, in mercator arc-length, is the phase origin.
3. Walk `origin + k · step` with `step = spacingPx / pxPerMeter`, projecting each anchor and
   dropping the ones that fail (#1050's phantom-chord rule moves to this projection step).
4. Gate: the z16.7 chain lands within 1 px of MapLibre's three anchors, and the pan-invariance
   property (a clipped run's anchors are a strict subset of the full run's) still holds.

Step 3 landed the other way round — the origin is carried INTO the existing screen walk as an
along-screen offset (`origin − headSkip`, scaled by `pxPerMeter`) rather than the walk being
rewritten in mercator. Same anchors, and it leaves #1050's run-trimming and the curved branch
untouched, which keeps INC-1's blast radius to the one thing it is about. `headSkip` is the
mercator arc-length the projection loop skipped before its first retained sample: leading
samples that fail to project are dropped, so the screen run can start mid-polyline, and without
that term the phase would be measured from the wrong place exactly when the run is clipped.

`label-pass.ts` is AT its 2130-LOC ceiling, so the walk belongs in
`place-labels-along-line.ts` alongside `lineLabelSpacingPx`.

**Do not land the vertex-0 walk on its own.** Camera invariance is not worth a 155 px
regression against the reference; the two must arrive together.

---

### 3.1 The anchor rule (as implemented — see §3.0)

**Anchor rule.** Walk the polyline in mercator metres from its own first vertex, stepping
`spacingPx / pxPerMeter` metres, first anchor at half a step. `pxPerMeter` is already computed in
`label-pass.ts` (the `_ppmA` / `_ppmB` probe) and `spacingPx` already carries the #1358 zoom
factor, so the on-screen cadence is unchanged by construction — only the origin moves.

Three properties were expected to fall out, each as a test. Only the first survived contact
with the reference:

1. **Pan invariance — HELD, and is unit-provable.** Panning changes which anchors are visible,
   never where they are: a clipped run's anchors stay a strict subset of the full run's, which
   the screen walk cannot satisfy.
2. **Cross-tile continuity.** Two tiles of one route, walked from their own starts, no longer
   collide phases mid-route the way two independent viewport walks do.
3. **Pitch faithfulness.** A world-space step maps to a _varying_ screen step under pitch —
   which is what MapLibre does too, since a uniform tile-unit step is uniform in world space. The
   current screen-space walk is uniform on screen, i.e. wrong under pitch in the other direction.

### 3.2 The one hard part

The curved (tangent-rotated) branch feeds `TextStage.addCurvedLineLabel(polyX, polyY,
anchorDistancePx, …)` — a SCREEN polyline plus an along-**screen** distance. World-space anchors
must therefore be mapped back to an along-screen offset. The projected sample array is already
built (`_pxScratch` / `_pyScratch`); the mapping is a parallel prefix-sum: accumulate screen
arc-length and mercator arc-length over the same sample walk, then convert an anchor's mercator
offset to the screen offset by interpolating within the containing sample interval. O(n) over
samples we already visit, no extra projection.

The viewport-aligned branch needs no mapping — it consumes the anchor point directly.

---

## 4. Increments

Each lands separately, green, with its own gate. No increment is allowed to change the cadence.

**INC-1 — world-anchored phase, viewport-aligned branch. LANDED.**
Replace the screen walk with the mercator walk for `text-rotation-alignment: viewport` line
symbols (the OFM shield layers). Smallest blast radius: no curved mapping, and the shields are
exactly what the reference measurements cover.
_Gate:_ the z16.7 chain lands within 1 px of MapLibre's three anchors (before: ~4 px); and a
pan-invariance test — dispatch the same polyline under two camera translations and assert the
emitted world anchors are identical, which is impossible to satisfy with the screen walk.

_As landed._ `tileEntryDistance` (`map/src/render/tile-entry-distance.ts`, a Liang–Barsky slab
clip — an endpoint-inside test silently reports 0 for a segment that spans the whole tile)
supplies the origin; `LabelFeatureSource` computes it once per run and caches it with the run,
since it is camera-independent; `placeLabelsAlongLine` takes the origin as a `phasePx` residue
mod the step, which is what makes the emitted set invariant under clipping.

_Measured_ (OFM Positron, 1800×900, settle-until-3-identical-hashes; same-code noise floor 0 px
at all three cameras, so every count below is signal):

| camera | DC (before→after) | D0 (before vs ML) | D1 (after vs ML) |
| ------ | ----------------- | ----------------- | ---------------- |
| z16.0  | 1481              | 5557              | 4908 (−649)      |
| z16.7  | 847               | 4868              | 4566 (−302)      |
| z16.9  | 583               | 4278              | 4033 (−245)      |

Both "400" shields at z16.7, measured at full resolution (box left edge, physical px): the upper
went −4 px from MapLibre to +1, the lower −4 to 0 (exact, matching top edge too). Box width is
25 px in all three frames — the shields moved, they did not resize.

_Known cost._ At z16.7 X-GIS now also draws a route-`1` shield MapLibre does not place at this
camera: an anchor that previously fell off the run's end now lands in view. That is the
collision-model gap INC-3/INC-4 close, not a phase error — and D1 < D0 at every camera says the
phase win outweighs it.

**INC-2 — world-anchored phase, curved branch. LANDED.**
Add the mercator↔screen arc-length mapping of §3.2 and switch the curved stops.
_Gate:_ road-name labels hold position under pan (same invariance test, curved path); the
existing curved-label suites stay green.

_As landed._ `mercOffsetToScreenOffset` is the §3.2 mapping: the projection loop already
visits every sample, so it accumulates mercator arc-length into `_pmScratch` alongside the
projected points, and the world→screen conversion becomes a lookup in the two parallel prefix
sums. `lineLabelFirstStopPx` is now the single authority for the lattice — both branches call
it, so they cannot drift into different phases for the same road. The curved branch's two
emission sites (short-line midpoint, spacing walk) collapsed into one `emitCurvedStop`, which
is what paid for label-pass.ts's LOC ceiling (2148 → 2116).

_Measured_ (OFM Positron, 1800×900, settle-until-3-identical-hashes; same-code noise floor 0 px
at all four cameras). Two PITCHED cameras were added — pitch is the only place the prefix-sum
mapping and INC-1's single `pxPerMeter` scalar can disagree, and at flat z16.7 they are in fact
bit-identical (DC = 0 when the curved branch is held fixed), so a flat-only sweep cannot tell
them apart:

| camera             | DC   | D0   | D1           |
| ------------------ | ---- | ---- | ------------ |
| z16.7              | 1225 | 4566 | 4601 (+35)   |
| z16.0              | 1854 | 4908 | 4325 (−583)  |
| z16.7 pitch 60     | 2224 | 7937 | 7762 (−175)  |
| z16.0 pitch 45 b30 | 3635 | 8536 | 7470 (−1066) |

z16.7 reads +35 — flat, not a regression. The raw ML↔X-GIS diff cannot credit what changed
there: X-GIS now draws the `Nuhyeon-gil / 누현길` road label MapLibre also draws and previously
drew nothing, and a label present in both but not glyph-aligned costs diff pixels at BOTH
positions. A text-coverage measure (dark-pixel masks, dilated 4 px so "same label, 1 px off"
counts as agreement) shows the content actually converged: ML-text-not-covered-by-X-GIS
515 → 469, X-GIS-text-not-in-ML 1120 → 1064.

_Known cost._ At z16.7 pitch 60 both coverage counts move the wrong way (+52 / +114) even though
the pixel diff improves. The world lattice lands anchors in the pitch-compressed far field where
MapLibre places none — because MapLibre's `getAnchors` FILTERS candidate anchors (max-angle, and
whether the label fits) and X-GIS does not. The old half-step cadence avoided those spots by
accident. That filter is the real missing piece and belongs with INC-3/INC-4.

_Rejected by measurement._ A midpoint retry for runs the lattice misses (MapLibre re-resamples
from the middle when its own resample yields no anchor) was implemented and measured. It does
restore the labels — but at positions MapLibre does not use: z16.0 went −583 → −269 and z16.7
pitch 60 went −175 → +254, worse on the text-coverage measure too. It only pays once anchors are
filtered the way MapLibre filters them, so it was reverted rather than kept as a net-negative
mitigation. `label-pass-line-lattice.test.ts` pins the unlabelled-run behaviour so the gap stays
visible instead of being rediscovered.

**INC-3 — path collision, representation.**
Extend `CollisionItem` with an optional circle chain (centre + radius per element) and teach
`greedyPlaceBboxes` circle↔box and circle↔circle overlap. Keep AABB as the default so point
labels and every existing test are untouched.
_Gate:_ unit tests for the three overlap pairs, plus a scene-level assertion that a straight
label's circle chain and its AABB place identically (the chain must be a strict refinement, not a
behaviour change, when the path is straight).

**INC-4 — emit circle chains for line labels.**
`TextStage` builds the chain from the curved layout it already has (glyph positions along the
path) instead of one bbox.
_Gate:_ the witness — MapLibre drops "Dogam-ro 도감로" at z16 and X-GIS must too; and a
no-regression sweep on the shield cameras.

INC-3 and INC-4 are independently useful: INC-3 alone is a dormant capability, INC-4 without
INC-3 is impossible. INC-1 is independently shippable and is the recommended first landing.

---

## 5. Risks

- **Off-screen walk cost.** A world walk covers the whole polyline, including off-screen spans,
  where the screen walk covered only the visible run. Anchors that fail to project are dropped,
  so correctness is unaffected, but a long route at low zoom does more arc-length arithmetic.
  Bound it by clipping the mercator walk to the viewport's world-space AABB _inflated by one
  spacing step_ — inflation keeps the phase, clipping keeps the cost.
- **The #1050 phantom-chord rule must survive.** A null projection currently HARD-breaks the run
  so no label lands on a chord bridging a horizon-culled gap. With world anchors the break moves
  to the projection step: an anchor is emitted only if it projects AND both its neighbouring
  samples projected.
- **Collision cost.** A circle chain is more overlap tests than one box. `greedyPlaceBboxes` is
  already O(N²); the #1341 grid in `icon-collide-overlap.ts` is the precedent for fixing that if
  it bites, and the same uniform-grid argument applies unchanged.
- **Test churn.** Any test that pins an absolute line-label screen position will move by INC-1.
  That is the point of the change; each such test should be re-derived from the reference, not
  re-baselined blind.

---

## 6. Verification posture

The measurement harnesses already exist and are the gate for every increment:

- `playground/e2e/_debug-shield-spacing.spec.ts` — both panes over a zoom sweep, shield boxes
  located by connected-component detection at full resolution.
- `playground/e2e/_debug-ml-collision-boxes.spec.ts` — MapLibre's own placed/rejected verdicts,
  which is how the shield-vs-place-label case was settled in #1370 rather than by inference.

Two lessons from that PR carry forward and are non-negotiable here:

- **A 0 px diff is not evidence until the code is proven to have run.** In #1370 the union was
  patched at one of three bbox sites; the render was byte-identical because the path never
  executed. Instrument the wiring, then read the pixels.
- **Never conclude from a downscaled or single-sample render.** The same PR produced a 615 px
  "regression" that was settle variance; four samples and a hash-stable harness settled it.
