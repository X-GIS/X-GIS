# 07 — Performance: the frame loop, tile selection, and adaptive quality

> Edition: **agent**. Companion: [`../dev/07-performance.md`](../dev/07-performance.md).
> Authority files: `map/src/render-loop.ts`, `map/src/pending-work.ts`,
> `data/src/tiles-sse.ts`, `data/src/globe-visible-tiles.ts`,
> `engine/src/gpu/adaptive-quality.ts`, `map/src/render/bucket-scheduler.ts`.

## 1. Frame loop and render-on-demand

One rAF authority, deduped, parked when the document is hidden; the tick closure is
allocated **once**. Per tick: camera events are processed _before_ the skip gate (events
fire on idle ticks too), cold-start hysteresis advances even on skipped frames, then
`shouldRenderThisFrame()` decides; three consecutive render throws halt the loop with a
typed error event.

`shouldRenderThisFrame()` = `_needsRender` (from `invalidate()`) ∨ animations (scene,
camera, paint transitions, label fades, tile fades, flow fields) ∨ **pending async work**
∨ an exact-float camera/canvas signature mismatch against the previous frame's snapshot.
Damage is snapshotted at end of frame; the loop is kept warm while tiles are missing or
keep-warm-scoped work is pending.

**The pending-work registry** (`map/src/pending-work.ts`) is the generalizable piece.
"Is async scene content in flight?" was hand-maintained per resource class, and six
recorded incidents were _someone forgot to join the list_ — the map either fossilized
half-loaded (an upload staging buffer invisible to the idle predicate stopped the loop
mid-load; labels decayed 6980 → 0 px across probe runs, looking exactly like a rendering
regression) or never idled. Now: one enumerated kind list (glyph, sprite, coverage,
raster-fetch/retry, dem-fetch/retry, vt-fetch/replaced/upload/missed/lod), **mandatory
per-kind deadlines** ("boundedness is non-negotiable" — a host that accepts a connection
and never answers must not keep the map non-idle forever), and named scopes (keep-warm vs
cold-start-burst) so consumers subscribe to a partition, not the union.

Two "settled" signals with different contracts, documented as non-interchangeable:
`getMissingTileCount()` is an affordance (it reads 0 while a cell shows a magnified
ancestor mid-download — never use `=== 0` as a settle condition); the `idle` event is the
honest one (camera at rest ∧ no pending source work ∧ nothing left to draw). The test
helper `awaitMapIdle` owns the two traps so specs don't: `idle` fires only on the
busy→idle **transition** (an already-idle map never re-fires), and a never-idling scene
must time out loudly.

## 2. Tile selection (flat): SSE with a distance-graded target

The metric (Cesium convention):

```
geometricError(z) = tileSize_m(z) / 512
distance = ‖(clamp(cam, tileRect) − cam, altitude)‖     // closest point on the RECT, not center
ssePx    = geometricError · canvasHeight / (distance · 2·tan(FOV/2))
subdivide ⟺ ssePx > effectiveTarget ∧ z < maxZ
```

- Closest-point distance matters: center distance catastrophically under-estimates SSE for
  a huge tile the camera sits over.
- `CAMERA_FOV_RAD` is a single authority — a stale local `FOV_DEG = 45` vs the real 36.87°
  once inflated altitude, SSE, horizon distance and the far ramp by 24 % in one gate.

**The distance-graded target** is the non-obvious part:

```
farness = clamp01((distance/altitude − 2) / (5 − 2))
effectiveTarget = baseTarget + farness · (farTargetSSE − baseTarget)
```

`NEAR = 2` because an unpitched 45°-FOV frame's corner sits at ≈1.3 altitudes — so
**low-pitch views are untouched by construction, not approximately**. `farTargetSSE` ramps
only past pitch 60° (toward 12, then toward 24 past z17). The failure this replaced: a
_global_ coarsening target emitted **zero** native-zoom tiles at Paris z16 pitch 70 —
buildings (z≥14 data) vanished as you pitched up. The adaptive-quality boost then
**multiplies the ramp's own far target** (capped at 64), never the base — composing rather
than competing, and inert on an unpitched camera by the same construction.

Traversal: DFS from z=0 (roots always descend — off-screen roots have on-screen
children); children visited nearest-first so the emit cap keeps the foreground; world
copies visited by |copy| (table order gave off-screen copies first claim on the budget —
a missing band on the primary world); an explicit primary cap (600) that does **not**
charge fallback-only ancestors (charging them shrank the real budget ~24 %). Culling is
four independent layers: frustum/AABB **through the camera's own MVP** (same matrix the
renderer draws with, so cull and raster agree at any DPR; camera-inside-tile is always
visible or selection collapses at pitch), far-plane cull on `min cw` over corners, a
**globe-equivalent horizon cull for the flat plane** (`1.2·√(2·R·altitude)` — a plane has
no horizon, so borrow the sphere's; pitch-80 Tokyo went 1331 → ~300 tiles), and a 2×2 px
sub-pixel cull (only when all four corners project; partial projection keeps
conservatively). Each emitted tile also pushes 2 ancestor keys flagged fallback-only
(eviction protection, not draw work).

**Globe route** is a separate explicit-stack sphere quadtree (parallel typed-array stacks,
zero per-node allocation): 5 samples per node fully inlined (ellipsoid forward + MVP);
horizon = the shared ellipsoid tangent-plane authority; descent =
`tooBig(screenSpan > max(256, min(w,h)/2)) ∧ tz < floor(desiredZ)` where
`desiredZ = zoom + log2(distToTarget/distToTile)` — the distance-LOD term measured 4-13×
over-selection without it; forced descent for z≤2 and the tile containing the camera
target (a tight visible cone at high zoom otherwise prunes the branch under the camera and
returns empty). Whole-result memo keyed by a rounded camera string.

A **viewport-class tile budget** (~1 tile per 12k CSS px, ceiling 300) uses CSS px
deliberately — device px inflates by DPR² (9× on a DPR-3 phone).

## 3. Adaptive quality: one controller, an ordered ladder

`engine/src/gpu/adaptive-quality.ts` (~240 lines; read whole). One controller — "two
independent controllers on one signal fight: each reads the other's improvement as its own
success." The ladder spends **far-field LOD before device pixels**:

```
notch: 0 {lod 1, dpr 1} → 1 {2, 1} → 2 {4, 1} → 3 {4, .85} → 4 {4, .72} → 5 {6, .6} → 6 {6, .5}
```

Rationale measured: quartering pixels on a dense pitched scene gave 2.38×, but ~25 % of
frame cost isn't pixel-proportional, so DPR bottoms out; and the LOD lever is inert on
unpitched views by construction (§2). It samples **rendered-frame intervals, never rAF
ticks** ("an idle map's ticks are cheap by definition; sampling those would let a map
sitting still convince the controller the machine is fast"), fed from the one existing
frame clock — one clock, not two that can disagree. Decision rule: degrade past 33.4 ms
(the 30 fps line — deliberately not 60: "degrading a map that is merely not-perfect would
trade fidelity every mid-range machine did not ask to lose"), restore below 20 ms, over a
**median of a full 12-sample window** (lower-median of the even window — conservative
about degrading; a preallocated sort buffer — zero alloc per decision).

Non-oscillation is three properties, each load-bearing: the hysteresis gap; **window clear
on every notch change** (samples that justified a move were measured at the old notch);
median-not-mean (one GC frame can't cross a threshold). Scoping: the **notch is global**
(it describes the host; survives device-lost and SPA remount) but the **sample window is
per clock source** (two maps interleaving one ring described neither; a fast map could
deny a struggling sibling its degrade) — rings live in a WeakMap keyed by the feeding
object, with lazy clear via a generation counter.

Lever landing sites: the DPR lever scales an offscreen **scene** target that a
`scene-upscale` pass reinflates, while overlay passes (labels, host graphics) render at
native resolution — "a sounding numeral is not decoration that degrades gracefully." The
LOD lever multiplies the SSE far target _and_ is passed to the readiness gate's probe (a
gate holding out for tiles a coarser selection never asks for would stall). **The boost is
part of every selection memo key** — a static camera bumps no frame signature, so without
it a ladder change would compute and never be observed, exactly when the controller most
needs to act.

Pinning: `?adaptive=0` disables at module load _before the first frame is sampled_ and
drops every sample; `?scenescale=N` pins only the DPR half **and leaves the selector
moving** — a recorded trap for hash-equality gates (a render input that is a function of
wall clock). Diagnostics surface the notch, boost and median; the controller's ring is
kept separate from the stats median precisely because pinning drops controller samples and
an A/B needs the same clock on both arms.

## 4. Tile pipeline pacing

- Worker pool: `max(2, min(6 desktop / 2 mobile, cores−1))`; results transferable;
  **rAF-paced resolve queue** (4/frame, 32 during cold-start burst, read at fire time)
  racing a 250 ms timer for hidden-tab rAF throttling — an unpaced 5-tile completion burst
  cascaded into a 138-200 ms hitch.
- Upload budget: 4/frame desktop, **1 mobile** (historic incident: 552 buffer writes /
  8.4 MB in one frame → ~250 ms stall); a single burst authority raises pool-drain,
  catalog-tick, and upload caps **in lockstep** during cold start (pure pacing while
  nothing is on screen), exiting on 3 consecutive idle frame-starts or a 10 s **non-rAF**
  timer (an rAF-only cap never fires on a hidden tab). The doc honestly records the mobile
  exclusion is precautionary — the original "mobile regression" didn't survive permutation
  testing.
- Network concurrency 32/8 (mobile 8 because sustained pinch-drag churn reproducibly
  triggered thermal page refresh on iPhone); `window.innerWidth` reads memoized per tick
  (forced synchronous layout, 1.3 ms across ~50 calls in one frame).
- Fallback classification is a **tagged union** (`classifyTile` → primary |
  overzoom-parent | queued-with-fallback | parent-fallback (+wantsRequestKey — without it
  the target LOD never loads because the parent is always "good enough") | child-fallback
  (≤3 levels, bounded lookups) | drop-empty | drop-no-archive | pending(terminal after 3
  failures — the source retries but the renderer stops counting the miss so the loop can
  idle)) — replacing ~7 implicit `if…continue` escape paths that hosted two regressions in
  one session.
- Prefetch: three routes, each with its own throttle discipline — adjacent (idle-only,
  every 10th frame); zoom-direction (every 6th frame, deliberately **not** idle-gated: the
  idle gate made it unreachable during the active zoom it exists for); pan-velocity
  speculation (walk strided 6 frames, but the **velocity snapshot stays per-frame** — the
  projector discards stale dt, so a strided snapshot would silently kill the route it
  amortizes). All bail on Save-Data/2g.

## 5. Draw-call organization

- **Bucket scheduling** as a pure function (zero side effects — two releases shipped
  silent classification bugs a smoke test couldn't catch): opaque fills (consecutive
  same-source shows share a sub-pass) → translucent (offscreen MAX-blend + composite,
  after the _whole_ opaque bucket — interleaving by source let a translucent layer
  composite before an opaque one covered it) → points. Opacity < 0.005 drops the layer; a
  translucent-stroke layer appears in both buckets (fill half opaque).
- **Render bundles**: encode once, replay (`270 draw calls → 1` measured at z14 Seoul).
  The transferable part is the **cache key as an explicit type** (`BundleKeyState` — "the
  canonical list of dependencies the bundle replay depends on; reviewing this file =
  reviewing the invariant"; adding a dependency is a compile error at every call site).
  The paid-for field is `ringCursor`: recorded draws bake dynamic offsets = base + walk
  position, so a key hit with a shifted base replayed stale offsets ("mostly empty canvas
  during interactive navigation" — the bug that kept bundles disabled). Uniform _data_
  updates do NOT invalidate (bundles hold bind-group references); bind-group
  _reassignment_ does, tracked by an epoch. Bundles can't record stencil-ref/viewport/
  scissor — draws split so those change outside.
- **Bind groups**: two source-level groups reused across all tiles; per-tile variation
  rides dynamic offsets into a uniform ring (reset per frame; CPU mirrors flushed just
  before submit — WebGPU orders writeBuffer-before-submit). Pipeline cache keyed by
  variant key; bind sizes derived lazily from `reflect()` of the same IR.
- **Instancing**: retained host graphics draw N icons in O(copies × batches) draws,
  gated with zero slack: `drawCalls(10k) === drawCalls(100k)` — an N-independence
  _invariant_, not a pinned count ("a gate that cannot fail is decoration": the gate was
  trusted only after breaking batching on purpose and watching 100,000 draw calls).
- **Selection memos**: a 16-slot LRU over visible-tile selections keyed by
  (cameraSig, z, maxLevel, farBoost, indexGeneration) — N shows with divergent stroke cull
  margins ping-ponged a single slot, re-running a 7-16 ms quadtree walk up to 14× per
  frame (frames with walks: 15.0 ms median vs 6.9 without); plus a per-frame SSE-gate memo
  (a 13-show style re-ran an identical walk 13× during zoom).

## 6. Labels: the prepare-skip

The biggest label lever: a **numeric dispatch signature** (zoom quantized ×100,
pixel-quantized center, bearing/pitch/canvas/show-count, per-source cache sizes — numeric,
not string: the string sig was itself a per-frame allocation). On a hit, `prepare()` — the
O(N²) greedy collision + shaping + upload — is skipped entirely and persistent draws
replay. Two things the signature can't capture force a re-collation: an async glyph/sprite
landing after the signature settled, and time-driven label shapes. During an _active_ zoom
the comparison relaxes (|Δzoom| ≤ 0.15, center drift ≤ 48 px) because the exact key made
every continuous-zoom frame a miss — putting full prepare cost on the wheel-zoom hot path;
motion stopping restores the exact compare and forces one final prepare so idle is
snap-correct. Replayed frames get a screen-space similarity correction solved from 3
reference samples; fades advance on replay frames by mutating alpha in place (a fade must
never force a re-prepare).

## 7. Measurement integrity (the rules that keep numbers honest)

- **A timing measurement owns the machine** — co-running compute corrupts the measured
  quantity itself ("instrument integrity, not ritual"). Everything else parallelizes.
- **Never edit sources a running browser gate is serving** — dev-server hot-reload kills
  the in-flight evaluation and the pipeline greens while measuring a moving tree (a
  comment-only edit once invalidated a 37-minute run).
- **Poll for stability, don't guess durations**: a gate settles by sampling until the
  drawn-tile histogram and triangle count are identical across 3 consecutive reads (fixed
  12 s waits read one host's settled 20,008 as another's 28,794 — a −43.9 % phantom).
- **Raise the load, never lower the bar** when a perf gate's premise ("the host genuinely
  can't keep up") is marginal.
- **Assert the quantity the subsystem moves**: the adaptive-ladder gate asserted triangles
  and severing the controller→selector wire failed _identically_ to the wire working (no
  premise fix could ever green it); fixed by asserting tiles. Method: don't just check
  fail-before goes red — **cut the specific mechanism and confirm the message names the
  severed half**. And never attribute causes from composite numbers (triangles = tiles ×
  geometry/tile; decompose before accusing a subsystem).
- **Pin wall-clock render inputs** (`?adaptive=0` at module load) before any hash-equality
  claim; capture chrome-free (an on-canvas status element whose text is a function of
  missing-tile count was 53 % of one gate's diff).
- Perf instrumentation is **off by default** (recording perf marks measured 8-12 % of
  frame CPU — the observer was the #2 hottest file), opt-in per URL flag; an in-page
  `?measure=<scenario>` harness gives humans on real hardware a copyable-JSON measurement
  protocol, and headless probes read the same report object.

## 8. Transferable design rules

1. **One rAF authority + explicit damage signature + a pending-work registry with
   mandatory deadlines.** Render-on-demand dies by a thousand forgotten async classes;
   enumerate them in a type.
2. **Grade the SSE target by distance/altitude so quality levers are inert where there is
   no far field**, and multiply the far target, never the base.
3. **One degradation ladder with ordered levers** (LOD before pixels), median over a full
   window, hysteresis, window-clear-on-change; sample rendered frames only; global notch,
   per-source windows; **put the notch in every memo key it affects**.
4. **Overlay content (text, UI graphics) never degrades with scene resolution** — split
   scene and overlay targets from day one.
5. **Pace everything bursty**: worker completions, uploads, cold-start, prefetch — each
   with an explicit budget authority shared by all its consumers.
6. **Make replay-cache dependencies an explicit type**, including frame-cursor state that
   baked offsets depend on.
7. **Sibling code paths that must agree get one body** (sync/async upload as one dispatch
   with a sink; readiness probes run the same selector the frame draws).
8. **`missing === 0` is an affordance; ship an honest transition-based `idle` event** and
   a harness helper that owns its traps.
9. **Perf gates assert invariants** (N-independence, monotonic ladders) on the moved
   quantity, settle by stability-polling, and are validated by cutting the mechanism.

## 9. Code map

- Loop: `map/src/render-loop.ts`, `map/src/map.ts` (scheduling), `map/src/pending-work.ts`,
  `render-loop-keep-warm.ts`, `map/src/map-cold-start-burst.ts`
- Selection: `data/src/tiles-sse.ts`, `data/src/globe-visible-tiles.ts`,
  `data/src/tile-select-budget.ts`, `map/src/render/tile-selection-cache.ts`,
  `map/src/tile-decision.ts`
- Adaptive: `engine/src/gpu/adaptive-quality.ts`, `engine/src/gpu/quality.ts`,
  `map/src/stats.ts`, `map/src/diagnostics.ts`
- Draws: `map/src/render/bucket-scheduler.ts`, `rhi-webgpu/src/bundle-cache.ts`,
  `map/src/_cache/bundle-cache-key.ts`, `map/src/render/bind-group-registry.ts`,
  `map/src/render/pipeline-factory.ts`
- Labels: `map/src/render/passes/label-pass.ts`, `map/src/text/text-stage.ts`,
  `label-replay-transform.ts`, `label-fade.ts`
- Measurement: `map/src/__profile__/`, `playground/src/measure-harness.ts`,
  `playground/e2e/_perf-*.spec.ts`, `_adaptive-quality-ladder-gate.spec.ts`
