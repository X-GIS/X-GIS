# Text, styles, science data, and moving water

> Edition: **dev**. Exhaustive version: [`../agent/08-content-subsystems.md`](../agent/08-content-subsystems.md).

A tour of the subsystems around the core geometry pipeline — each compressed to its
central idea and its best scar.

## Text

Glyphs are SDFs from two sources: MapLibre-format PBF ranges (parsed in-house) and a
Canvas2D + exact distance-transform fallback that draws immediately while the real fonts
load — the swap is invisible because landing a PBF invalidates the slot and the next
prepare upgrades it. The quiet masterstroke: the local rasterizer draws at **24 px, the
PBF native size**, so a PBF glyph enters the atlas as a 1:1 byte copy. The previous
resample was measurably blurring labels against MapLibre; matching sizes deleted the
resample entirely.

Shaping is manual (advances over cached metrics; Knuth-Plass line breaking behind an LRU
whose *key* had to become an integer hash — the string key was the top GC source at 5,000
labels/frame). CJK gets an injected fallback chain (stripped again before talking to the
glyph server, which doesn't know CSS families), local rasterization of ideographs at
display-size buckets (a minified 24 px SDF turns small hanzi into boxes), and vertical
writing composed *directly* — offsets march down at **em pitch** (PBF has no vertical
advance; using the horizontal advance is the classic mistake), one column centerline from
the em box (per-glyph ink metrics make bilingual columns zig-zag), rotation zero — rather
than emulating MapLibre's rotate-then-counter-rotate dance, whose two halves only exist
because its glyph data is baked in shaping space.

Collision is greedy first-claim-wins over a **deterministic order**, and the order is a
two-act story. Act one: the tie-break was accidentally tile-load order — the surviving
label changed depending on which tiles happened to arrive first; fixed with a stable
per-feature identity, locked by a permutation test. Act two, the better lesson: at pitch
81° that *stable* identity was deciding a **depth** question — "Seoul" < "Shanghai" let
the far city occlude the near one. *Stable is not the same as correct.* The fix inserts a
screen-Y depth proxy between layer precedence and identity. Along-path labels anchor
their spacing **phase in world coordinates** (a screen-space walk starts wherever the
road enters the viewport — phase was camera-dependent by ~4 px) and scale spacing by
`2^frac(zoom)`, reproducing MapLibre's tile-space cadence to a measured 0.1 %.

In 3D, ground-projected labels use a basis that is **a ratio of the projection's own
Jacobians** — finite-difference the live projector and the pitch-0 projector at the
label's own position, solve the 2×2. No inverse projection needed (azimuthal discs have
none), identity at pitch 0 *by construction*, and correct at the screen edge where the
previous screen-center linearization was 84-240 % wrong. Horizon culling of globe labels
took three rounds to get right, and the postmortem's shape is the lesson: an additive
angular margin can't work (visibility headroom collapses ~100× between z12 and z18), a
fractional one still interleaved floaters with healthy labels, and the gate only held once
the margin lived **where the quad height exists** — per label, not at the anchor.

## The style compiler

The `.xgis` language is purely declarative (control flow was removed). Utilities resolve
through a **declarative registry** — one row per prefix with longest-match lookup —
replacing four duplicated `startsWith` ladders with two silent-drop holes; unknown
utilities are diagnostics with nearest-name suggestions, never no-ops. (The best
micro-lesson: `hover:opacity-100` once compiled cleanly into *nothing*. Unhandled
modifiers are now errors — and per-feature interaction state remains a CPU concern, the
one axis the architecture reserved no GPU lane for. If you're starting fresh, put a state
axis in the classification lattice on day one.)

The heart is **expression classification**: every style expression is placed in a lattice
— constant / zoom-dependent / input-dependent / per-feature-GPU / per-feature-CPU — which
decides whether it folds at compile time, becomes a per-frame uniform, compiles to WGSL,
or uploads as feature-table data. Two rules keep it sound: classification recurses
*through* subexpressions (an expression is only as GPU-safe as its parts — the
unconditional version routed CPU-only code to a path where unknown callees silently emit
0.0), and the GPU-safe builtin set is asserted to be a **subset** of the CPU-evaluable
set, because every GPU-routed expression also needs a CPU fallback and a folding story.
Heavy per-feature match/gradient work can lower further into per-feature **compute
kernels** whose packed outputs the fill shader just reads.

Mapbox style compatibility is governed by a spec-coverage table with two drift gates
(every property the converter touches is in the table; every table row is actually
referenced) and a definition of done that reads like policy: every row `supported`, or
`partial` with a warning-backed degradation note — **silent drops are defects** — and the
`na` rows are *reaffirmed architecture decisions, not backlog*.

## Scientific data (S-102 bathymetry, S-111 currents)

The formative mistake, made twice, is enshrined as ADR-0010: the project invented private
binary containers (`.xgvt`, then `.xgcov`) for data that already lived in standards it
could read. The rule: **a reader for a standard is legitimate; transcoding a standard into
a house blob is not** — you lose the entire ecosystem *and* HTTP-range streamability.
So there's an in-house HDF5 reader over HTTP Range — with a measured surprise: for a
typical 4.5 MB cell, reading ranges was **17× slower** than downloading the whole file
(125 ms vs 2,100 ms), because HDF5 address discovery is serial (≥6 dependent round-trips)
and an unwindowed read touches every chunk anyway. The algebra
(`ranged = K·RTT + needed/T` vs `whole = RTT + total/T`) picked an 8 MB whole-file
threshold; ranging keeps its point for plucking one forecast timestep out of a
multi-group file. Even discovery follows the no-house-formats rule: regions are found
through STAC, because inventing `catalog.json` would be "`.xgcov` one level up."

The multi-region (mosaic) story produced ADR-0011: three subsystems — the value readout,
the drape draw order, the arrow suppressor — each answered "which dataset owns this
water" independently, and what they were all actually using was *recency*, which
impersonates relevance right up until a forecast refresh re-arms a region and the winner
flips several times a second. One priority function, passed to all three; the draw order
is a stable sort on it; and the eviction LRU is deliberately left alone — it wants the
opposite order. Depth numerals ("soundings") sample the grid **from the screen** — a
viewport walk is bounded by pixels, not the 3.5 M-cell grid; scale-thinning falls out
free; values are nearest-cell reads, never interpolated, because a printed number must
exist in the data.

## Moving water: three generations of flow

1. **Stateless particles**: position is a pure function `f(seed, t)` — no state buffers,
   no compute pass, byte-reproducible frames for free.
2. **The structural insight** (after a "drifting arrows" attempt blinked): moving a
   discrete glyph forces recycling; recycling is a discontinuity; hiding it needs a fade;
   *a fade on a large recognizable object IS a blink*. Particle systems get away with it
   only because their artifacts sit below perceptual thresholds — "a lifecycle model is
   only as portable as the perceptual conditions that make its artifacts invisible." The
   industry answer is two layers: exact static glyphs + an animated field texture (IBFV
   ping-pong) — sized to the **data grid, not the canvas** (history becomes
   camera-independent and no screen→geo inverse enters the recursion), storing velocity as
   **components, never speed+direction** (interpolating headings across 0°/360° averages
   to *backwards*), advecting anisotropically (`cos φ`), and clearing only on fresh
   targets (a recursive filter doesn't overwrite stale texels — it feeds on them).
3. **The synthesis** for chart arrows: the S-111 portrayal catalog binds a *function* of
   position — and contains no notion of time — so an arrow may drift **if it is
   re-symbolized from the data wherever it arrives**. The final design stores a bounded
   *displacement* (origins keep CPU-packed double precision; f32 suffices for the offset),
   then goes fully stateless: **a phase holds no position**, so instance count becomes a
   per-frame decision, fades become possible, and frame zero *is* the standard's static
   placement. Instances come from a ground-anchored lattice generated from the view
   (screen-seeded fields slide over the water; data-seeded density would need 355 M
   instances at z19), and glyph "trains" make recycling seamless — at phase 1.0 every
   glyph lands exactly where its neighbor was, so there is nothing to blink. The camera
   enters as four corner rays unprojected through the f64 inverse — not an f32 inverse
   matrix (~1 m ≈ 8 px), and not a second hand-derived basis (a second statement of a
   composition the forward path already owns *will* drift).

## The globe's skin

The style background is not a clear color — it's a **synthetic earth-surface tile**
through the ordinary polygon pipeline (the standalone background renderer had been a
second projection path, second geoid, and second world-copy story; deleting it deleted a
bug class). A bucket-zero background pass owns the viewport clear as a pure function of
projection and style — flat maps clear to the style color, globes to deliberate
space-black — under the requirement that **every pixel has a defined source**, which the
ADR explicitly ranks above MapLibre parity at letterbox pixels: when you reverse a
convention, write the reversal down so it doesn't read as a bug. Raster tiles drape on a
subdivided grid with no skirts (shared edge vertices by construction), and the grid's
precision fix is a compact classic: every in-shader transcendental on the ECEF path
multiplies the Earth radius, so trig error lands in *meters* (1.17 km measured on a
software rasterizer) — and feeding a more precise *input* measurably didn't help; the fix
removes the transcendentals (a CPU-built trig table; the shader only multiplies). Tile
transitions are temporal (fades on a wall-clock, not frame counts — a frame-count fade
runs 2× slow at 30 fps) rather than geometric.

External-renderer interop is, deliberately, a *documented set of contracts* rather than a
feature: the camera is a fused RTC-relative MVP with no separable view/projection; depth
is logarithmic and per-fragment; geometry is split-float ECEF on a dual-geoid frame. Each
has a named ~50-line bridge, unbuilt. If interop matters to your library, keep
view/projection unfused in the public API from the start and publish your depth encoding
as frame state.

## What to steal

- Match glyph raster size to the source's native size; intern every cache axis into the
  key; deterministic collision with an explicit depth proxy; world-anchored label phase.
- Jacobian-ratio bases for ground-projected annotation — identity at pitch 0 by
  construction.
- An expression-classification lattice with subexpression recursion and a
  GPU ⊆ CPU containment gate; declarative utility registries; diagnostics over silent
  no-ops; reserve the interaction-state axis early.
- Read standards in place, but *measure* the range-vs-whole crossover; discover through
  the ecosystem's catalog, not a house manifest; one relevance authority for N consumers.
- Animate fields or pure phase functions, never recognizable objects; store components,
  not headings; size simulations to the data grid.
- Every pixel defined; conventions reversed on purpose get written down.
