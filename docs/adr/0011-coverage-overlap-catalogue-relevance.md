# ADR-0011: A coverage mosaic's overlap is decided by catalogue relevance; the most relevant region is drawn last

Status: Accepted
Date: 2026-08-10
Deciders: the #1500 / #1585 / #1602 consolidation

## Context

A `coverage` source holds several NOAA domains at once (`_coverage`, keyed by region —
`map-types.ts:73`), and their footprints overlap. The common real case is **nested and
unequal in resolution**: `sfbofs` (local, fine) sits inside `wcofs` (basin, coarse).

Three independent consumers each have to answer "which domain owns this water", and each
answers it somewhere else:

| Consumer    | Where it answers                                                          | How the answer reaches the user                                    |
| ----------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **readout** | `coverageHandleAt` (`coverage-source.ts:146`)                             | `XGISMap.getCoverage(id, at)`                                      |
| **drape**   | `CoverageRenderer.drawOrder` (`coverage-renderer.ts:575`)                 | one alpha-blended quad per region — the last drawn is on top       |
| **arrows**  | `CompiledArrowStore.recomputeSuppression` (`compiled-arrow-store.ts:275`) | one screen lattice per region, suppressed over ground another owns |

Each has already been wrong on its own terms, and the two bugs are the same bug:

- **#1585** — the arrows drew **both** fields over shared water: roughly double the glyph
  density, in two domains' colours and headings at once. On a chart that is a misreading
  rather than a blemish, and `arrow-drift.ts` already says so — `ARROW_LATTICE_FACTOR`
  exists precisely because "overlapping SCAROW symbols read as a faster current than the
  data says".
- **#1602** — the drape took its draw order from `states`, which is the renderer's **LRU**:
  `setCoverage` delete-then-sets, so the back is the most recently **armed** region. A
  per-region re-arm fires on every forecast tick and every playback frame, so the overlap's
  winner changed several times a second — and disagreed with the region `getCoverage(id, at)`
  reported for that same point.

The shared root is that **recency was standing in for relevance**. It looks like relevance
because the arm order normally _is_ the relevance order — until a re-arm lands. `writeRegion`
sets an existing key **without deleting it**, so the `_coverage` Map's order survives a
forecast step, while the renderer's `states` and the arrow store's `batches` both move a
re-armed region to the back. Two of those three orders are wrong, and they are the two that
are closest to hand.

Relevance is not invented here: `itemsForView` already ranks overlapping cells by overlap
area with ties toward the **smaller** bbox — "Preferring the smaller bbox picks the
higher-resolution local cell" — and the resolve arms them in that order.

## Decision

**We will resolve every coverage-mosaic overlap by catalogue relevance — the region's index
in the source's `_coverage` Map — and by nothing else. The most relevant region is drawn
LAST.**

One authority: `regionPriority(deps, sourceId, region)` (`coverage-source.ts:133`), lower =
more relevant. The arm passes it to every consumer (`coverage-source.ts:215,220,290,400`), so
the three agree **by construction** rather than by three rules that happen to coincide:

- **readout** — `coverageHandleAt` walks the Map in order and returns the first region that
  covers the point.
- **drape** — `drawOrder()` is a **stable** descending sort on `priority`, so the most
  relevant is drawn last and alpha-over puts it on top. Stable matters: regions that share a
  priority (every single-region caller) keep arm order.
- **arrows** — a batch yields only to **strictly** lower priority, so a region never
  suppresses itself and two regions can never suppress each other.

The eviction LRU is **deliberately untouched**: least-recently-**used** is still the right
thing to evict. One Map served both orders until they started wanting opposite directions.

**Pinned by** `map/src/render/coverage-overlap-identity.test.ts` — one probe point in the
overlap, the three authorities read through their real code paths, asserted equal as a single
check. Each consumer's own gate stays where it is (`coverage-draw-order.test.ts`,
`compiled-arrow-store.test.ts`, `_s111-overlap-ownership-gate.spec.ts`); this one exists
because three gates that each check one consumer against a rule stated three times can all
stay green while the consumers drift apart from each other.

### Alternatives rejected, with the reason (the reason is the point)

1. **Arrival / LRU recency** — the renderer's `states`, the arrow store's `batches`. This is
   the bug itself: a re-arm fires per forecast tick, so ownership flips several times a
   second and contradicts a readout that never moved.
2. **A lon/lat box test in the fragment shader.** #1366 INC-3 deliberately deleted
   `cov_edges` / `cov_geo`: a lon/lat rectangle is wrong for a projected UTM cell, and the
   fragment no longer carries lon/lat at all. (The arrow path may use one only because it is
   geographic-only to begin with.)
3. **Depth / stencil rejection.** CLAUDE.md §12: a truthy `depthCompare` makes `Material`
   synthesise a depth-stencil, turning every `SetPipeline` on a colour-only pass into a
   validation error.
4. **Averaging the two values.** The right _axis_ — blending two ramp **colours** shows a
   colour for a value neither region holds — but wrong for this data: the real overlap is
   nested and unequal in resolution, so a mean smears the high-resolution local forecast with
   the coarse basin one. That is exactly the damage already on record for this bug's eviction
   sibling, where arming basin-wide `wcofs` over local `sfbofs` left "a coarse cell drawing 2%
   of the frame where the right one had drawn 45%". Across the shipped twelve-model catalogue
   no point is covered by three boxes, so median ≡ mean anyway.

## Consequences

- The drape, the arrows and `getCoverage` cannot name three different domains for one patch
  of water. That was the visible defect in both #1585 and #1602.
- A new consumer of the mosaic inherits the rule by calling `regionPriority`, instead of
  re-deriving a tie-break from whatever order is nearest.
- **The cost, and the thing a future contributor will be tempted to "simplify":** both wrong
  orders remain in the code, correct for their own jobs — `states` is the eviction LRU and
  `batches` is the draw list — and both are one property access away at every site that needs
  a winner. Reaching for either is the regression, and it is invisible until a forecast tick
  lands. `coverage-overlap-identity.test.ts` fails when they do; the arrow half of it fails
  loudly rather than subtly, because two regions drawing at one point _is_ #1585.
- **Stated limit — layer opacity < 1.** The lower region still shows through; what the
  decision guarantees is that the **top contributor** is the correct one, which is the
  semantics any translucent layer has. Winner-take-all at opacity < 1 needs the stencil path
  rejected above, and its hazards.
- **Stated limit — the antimeridian.** Ownership is matched to `coverageCovers`
  (`coverage-bounds.ts:42`) rather than made a third convention, so a domain crossing ±180°
  inherits that function's limitation instead of a new one.
- Coverage is edge-**inclusive** on purpose (NOAA domains are published to abut), so overlap
  is the safe failure and a gap is not: two regions claiming a point now resolve to a defined
  answer, where a gap would read as "no data" over water that plainly has some.
