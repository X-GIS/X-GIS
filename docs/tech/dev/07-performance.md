# Staying at 60: demand rendering, graded LOD, and one quality controller

> Edition: **dev**. Exhaustive version: [`../agent/07-performance.md`](../agent/07-performance.md).

Map-engine performance is less about making code fast and more about *not doing things*:
not rendering identical frames, not selecting tiles you can't see, not preparing labels
that haven't changed, not letting one slow machine drag the design. X-GIS's performance
layer is a set of "don't" machines, each with a story.

## Render-on-demand, and the registry that saved it

The loop renders only when something changed: an explicit invalidation, an animation, a
camera/canvas signature mismatch — or **pending async work**. That last clause is the
hard one. "Is anything still in flight?" was once a hand-maintained list, and six separate
incidents were the same failure: a new async resource class (an upload staging buffer, a
sprite atlas, a coverage fetch) forgot to join it. The best of those bugs is a classic:
the idle predicate couldn't see the staging buffer, so the loop stopped *mid-load* and the
map fossilized half-drawn — and because probe runs kept catching it at different stages of
decay, label pixel counts fell 6980 → 2138 → 76 → 0 across four runs *in commit order*,
looking exactly like a code regression gradient. One line making the buffer visible took
labels from 0 to 7,081 pixels with zero interaction.

The fix is structural: one enumerated registry of pending-work kinds, with two
non-negotiables — every kind has a **deadline** (a server that accepts a connection and
never answers must not keep the map awake forever), and consumers subscribe to named
*scopes*, not the union. Alongside it, the project maintains an honest distinction between
two "settled" signals: the missing-tile count is an affordance (it reads zero while a
tile is showing a magnified ancestor — never use `=== 0` to settle a test), and the `idle`
event is the truth — with a test helper that owns its two traps (it fires only on the
busy→idle *transition*, and a never-idle scene must fail loudly, not hang).

## Tile selection: screen-space error with a graded target

Tile refinement is Cesium-style SSE — geometric error projected to pixels using the
distance to the **closest point of the tile** (center distance under-refines the tile
you're standing on). The distinctive part is the *target*: instead of one global "refine
until error < X px", the target ramps with `distance/altitude`, engaging only past twice
the altitude — chosen because an unpitched frame's far corner sits at ~1.3 altitudes, so
**low-pitch views are untouched by construction, not by tuning**. The failure this
replaced: a global coarsening knob meant a pitched city view emitted zero native-zoom
tiles — buildings vanished as you pitched, because building data only exists at z14+.

Traversal is a DFS that visits children nearest-first (so the emit cap spends its budget
on the foreground) and world copies by |copy| (the natural array order once gave
off-screen copies first claim, blanking a band of the primary world). Culling stacks
four layers, including a nice trick: the **flat map borrows the globe's horizon** —
a plane has no horizon, so a pitched Mercator view cull uses `1.2·√(2Rh)`, cutting a
1,331-tile selection to ~300. The globe has its own allocation-free traversal with a
distance-LOD term (`desiredZ = zoom + log2(distToTarget/distToTile)`) that measured 4-13×
over-selection when missing, and a forced-descend clause for the tile containing the
camera target (a tight high-zoom frustum otherwise prunes the branch under your feet and
returns *nothing*).

## One quality controller

Adaptive quality is a single controller over an ordered ladder — far-field LOD spent
first, then device-pixel ratio down to 0.5 — because "two independent controllers on one
signal fight: each reads the other's improvement as its own success," and because the
levers compose: the LOD lever multiplies the SSE *far* target, so it's inert on unpitched
views by the same construction as above, and DPR alone bottoms out (a quarter of frame
cost isn't pixel-proportional).

The sampling rules are where most such controllers go wrong, and each is explicit:
sample **rendered** frame intervals, never rAF ticks (an idle map's ticks are cheap by
definition — sampling them lets a still map convince the controller the machine is fast);
decide on the **median of a full window** (one GC frame can't cross a threshold); keep a
hysteresis gap (degrade at 33 ms — deliberately the 30 fps line, not 60: don't trade
fidelity a mid-range machine didn't ask to lose — restore at 20 ms); **clear the window on
every notch change** (the samples that justified the move were measured at the old notch).
Scoping is split: the learned notch is global (it describes the *host* and survives
remounts), but sample windows are per map (two maps interleaving one ring described
neither). Two integration details carry disproportionate weight: the current boost is part
of **every selection memo key** (a static camera invalidates nothing, which is exactly
when the controller acts), and overlay passes — labels, UI graphics — render at native
resolution while only the scene target scales ("a sounding numeral is not decoration that
degrades gracefully").

For measurement, the controller pins off with a URL flag *at module load*, before the
first sample — a wall-clock-driven render input is fatal to hash-equality testing, since a
slower machine literally selects a different tile set.

## Pacing the bursts

Everything bursty has a budget with a single authority: worker completions re-enter N per
frame (an unpaced five-tile burst = a 200 ms hitch), uploads are capped per frame (552
buffer writes in one frame once cost ~250 ms), a cold-start "burst mode" raises all three
caps in lockstep while there's nothing on screen to keep smooth (exiting on idle frames
or a **non-rAF** timer — hidden tabs throttle rAF to ~0 Hz, so an rAF-only exit never
fires), and prefetch routes each carry their own throttle discipline — including one
deliberately *not* idle-gated, because the idle gate made it unreachable in the exact case
it exists for (during an active zoom, the camera is never idle).

## Draw calls: bundles with typed dependencies

Draws batch through a pure-function bucket scheduler (opaque → translucent → points; a
classification bug ships silently, so the classifier has zero side effects and its own
tests), and on WebGPU through **render bundles** — encode once, replay (~270 calls → 1
measured). The transferable piece is the cache key: bundle validity depends on a dozen
things (tile sets, epochs, world offsets, pipeline labels, pick state…), so the key is an
**explicit TypeScript type** — adding a dependency is a compile error at every call site,
and "reviewing this file = reviewing the invariant." The field that earned its place the
hard way is the uniform-ring cursor: recorded draws bake dynamic offsets relative to the
frame's allocation walk, so a key hit with a shifted base replayed stale offsets — the
"mostly empty canvas while navigating" bug that kept bundles disabled until keyed.

Labels have their own "don't do it again" machine: a numeric dispatch signature skips the
O(N²) collision + shaping + upload entirely when nothing relevant changed, with a
relaxed comparison **during** continuous zoom (the exact key made every zoom frame a miss,
putting the full prepare on the hot path) and an exact one the moment motion stops.
Fades mutate alpha in place so they never force a re-prepare.

## Measuring without lying

The rules are cultural as much as technical, and every one is a condensed incident: a
timing measurement owns the machine (contention corrupts the measured quantity);
never edit sources a live browser gate is serving (hot reload = measuring a moving tree);
settle by **stability polling** (identical readings 3× in a row), never fixed sleeps
(fixed waits read one host's settled state as another's regression — a −43.9 % phantom);
when a stress gate's premise is marginal, raise the load, never lower the bar; and assert
**the quantity the subsystem moves** — the adaptive-quality gate asserted triangles, and
cutting the exact wire it watched failed *identically* to the wire working; only when it
asserted tiles could any outcome distinguish the two. The general form: don't just check
that a new test fails before the fix — cut the mechanism it guards and confirm the failure
message names the severed half. Even the profiler obeys the rules: perf marks are off by
default because recording them measured 8-12 % of frame cost — the observer was the
second-hottest file.

## What to steal

1. Demand rendering with an enumerated, deadline-bounded pending-work registry; an honest
   transition-based `idle`; "missing == 0" is an affordance.
2. SSE with a distance-graded target — quality levers must be *inert by construction*
   where they shouldn't act, and must multiply the far target, not the base.
3. One controller, ordered levers, median-of-window, hysteresis, window-clear-on-change,
   rendered-frames-only; notch global, windows per source; notch in every memo key;
   overlays never degrade.
4. Budget every burst through one authority; exits and timers must survive hidden tabs.
5. Replay caches with typed dependency keys, including allocation-cursor state.
6. Prepare-skip signatures for expensive per-frame work, with motion-relaxed comparisons.
7. Measurement discipline: own the machine, stability-poll, raise load not bars, assert
   the moved quantity, cut mechanisms to validate gates, keep the profiler off by default.
