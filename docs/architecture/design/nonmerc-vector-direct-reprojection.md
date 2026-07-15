# Non-Mercator vector: DIRECT reprojection + subdivision (retire the #599 bake→drape)

**Status:** design proposal (2026-07-15), REVISED after adversarial review (see next
section). Direction endorsed; increment plan corrected. Supersedes the continuity tradeoff
locked in `docs/research/2026-07-11-599-globe-vector-drape-reimpl.md` (approach **B**,
texture-drape).

## Review synthesis (2026-07-15) — verdict REVISE, direction endorsed

Two independent Opus reviews (architect + adversarial critic) + a CPU probe. **The pivot's
DIRECTION (retire the WebGPU-only bake→drape for a single direct-reprojection vector
authority) is endorsed** — a raster bake cannot be sharp-at-every-zoom and disqualifies S-100
by construction. **But the increment plan below MATERIALLY understated scope and contained two
false claims; the corrected plan supersedes the "Phased migration plan" section further down.**

### Grounded measurements (CPU probe on `tessellatePolygonToArrays`, since removed)

- **Depth-cap leaves facets ("chord≈0 by construction" is FALSE).** A 70°×40° low-lat
  rectangle → 2048 triangles (2×4⁵ = `MAX_TRI_SUBDIVIDE_DEPTH=5` fully saturated) with **max
  residual edge = 2.188°** (> the 2° gate). A 100°×40° high-lat (lat 40–80) rectangle →
  residual **3.125°**. So the fixed `MAX_TRI_DEGREES_FOR_PROJ=2` / depth-5 subdivision is
  simultaneously **cap-saturated AND still faceted** on big low-zoom polygons. Raising the cap
  to kill facets is 4^depth growth (the "2–3% extra points" figure is Mapbox's typical-map
  number, NOT a z0 hemisphere). Do NOT reintroduce great-circle midpoints (z=0 banding
  regression, `vector-tiler.ts:414`).
- **The mesh is NON-CONFORMING (intra-tile hanging nodes) — the pivot ACTIVATES a dormant
  crack.** A jagged strip (long top edge + fine sawtooth bottom) → **458 hanging nodes**
  (a vertex lying strictly interior to a neighbour triangle's edge). `subdivideTriangleMM`
  decides refine/stop **per-triangle on `maxEdge`** (`vector-tiler.ts:503`) then does a uniform
  3-midpoint split (`:518-531`): two triangles sharing a SHORT edge disagree on subdividing it
  when only one has another long edge → hanging node. On Mercator the midpoint is collinear
  (zero gap); direct sphere reprojection bows it off the chord (sagitta) → a crack opens. The
  T-junction risk is therefore **intra-tile, not merely cross-tile** — the "cross-tile edge
  determinism" framing below is a special case.

### Corrections that supersede the sections below

1. **"Increment-1 = one gate flip at `vector-tile-renderer.ts:3135`" is FALSE (CONFIRMED).**
   The gate is COARSE: `_drapeStrokes` is assigned only inside the `if (_drapeGlobeFills …)`
   block (`:3157`), so flipping `:3135` routes **fills AND strokes** direct in the same frame
   (`drawFills` `:3934`, `drawStrokes` `:3938`). The Inc-1(fills)/Inc-2(strokes) phasing is not
   realizable by that flip — a **fill-only sub-gate refactor** must land first. And the three
   "prerequisites" (pole fan, conforming subdivision, under-occluder sphere) are new mesh/pass
   work, not flips. The under-occluder sphere is **confirmed ABSENT** (inventory C1).
2. **"Curvature-adaptive SCREEN-tolerance subdivision, once per tile load" is UNBUILDABLE as
   stated (CONFIRMED).** `tessellatePolygonToArrays` / `subdivideTriangleMM` take **no camera
   zoom and no projType** — the mesh is projection- and zoom-independent and cached. A
   "sagitta < 0.5 px" stop test needs camera state at subdivision time. Commit instead to a
   **STATIC per-tile-zoom angular granularity** (the existing 2° gate is already a tile-zoom
   proxy: coarser tiles span bigger arcs → more subdivision); a screen-adaptive path is a
   **separate future GPU-amplification increment**, not a "stop-criterion tweak."
3. **Conforming subdivision needs closure templates, not just endpoint-keying.** The fix is
   (a) a per-edge deterministic refine decision keyed on the edge endpoints + global
   granularity AND (b) **red-green / 2:1-balanced closure** so a triangle with 1–2 subdivided
   edges is re-triangulated without a hanging node. Endpoint-keying ALONE only relocates the
   T-junction. This is a change to the **shared compiler authority Mercator also consumes**
   (10 inbound call paths) → widest blast radius → verify Mercator stays **hash-identical up to
   added collinear vertices** (not just DC=0).
4. **Cross-LOD T-junctions need a SKIRT, not endpoint-stitch (CONFIRMED).** The globe renders
   mixed LOD every frame (parent-walk fallback, `vector-tile-renderer.ts:3116`). A z4 tile edge
   and its two z5 sub-edges have DIFFERENT endpoints → endpoint-keying (§1a) cannot reconcile
   them. Use the §1b skirt/apron (or an LOD-boundary snap) for cross-LOD.
5. **Only globe (projType 7) is verified.** The A/B forced the ECEF else-arm (`polygon.ts:416`).
   Disc {3,4,5} use the flat_rel arm (`polygon.ts:383`) with an untested rim clip on subdivided
   fills; oblique_merc(6) has `cullThreshold: null` + a **rotated antimeridian** the tiler's
   geographic-±180 split does not cover, plus a pre-existing flat-MVP/sphere-tile bug at pitch>0
   (`projections-table.ts:236`). Verify per-projType; treat oblique(6) as new machinery, LAST or
   excluded.
6. **5-year tension (not a free bonus):** S-100 nautical ENC is WGS84-**ellipsoidal**; a
   sphere-based authority lands features ~21.5 km off → disqualifying. So the single authority
   must ultimately be ELLIPSOIDAL, which then **breaks byte-identity with spherical Web
   Mercator** — "converge with Mercator" and "ellipsoid-correct" are in tension, not jointly
   free. Defer the ellipsoid switch, but stop describing them as free together.
7. **Honest present-day defect size:** at steady state the drape is ~crisp; the PERMANENT defect
   is **past source maxzoom (z14+) over-zoom + a transient during the zoom-in hold**. The strong
   justification for retiring the subsystem is STRATEGIC (S-100 / sharp vector), not the
   measured present magnitude. (The near-term-only alternative is the MapLibre adaptive-bake
   fallback at a fraction of the risk — recorded, not chosen.)
8. **Unverified premise:** "WebGL2 already uses the direct path" leans on the WebGL2 backend,
   which the inventory calls a PoC-stub (A5, possibly stale post-#581). NOT load-bearing — the
   WebGPU `__XGIS_DISABLE_VECTOR_DRAPE` A/B independently proves the direct path renders — but
   verify WebGL2 vector separately before citing it.

### Corrected increment plan (multi-PR; replaces "Phased migration plan" below)

- **INC-0 — conforming static subdivision (FIRST, widest blast radius).** Red-green closure in
  `subdivideTriangleMM` so the same-LOD mesh has zero hanging nodes; keep linear-MM + static
  per-tile-zoom granularity; budget the triangle count; gate: a CPU conformance test (the 458→0
  witness) + a **Mercator hash-equality** gate.
- **INC-1 — under-occluder sphere (SECOND, cheap).** Opaque depth-writing sphere just under
  `EARTH_R`; closes the back-lip AND masks any residual crack to the sphere colour.
- **INC-2 — pole fan (THIRD).** Mirror `needsNorthPoleCap` (`raster-renderer.ts:120`) + replicate
  the winding invariant (`raster-pole-cap.test.ts:115`); solve the >±85° no-MVT-data colour story.
- **INC-3 — fill-only drape sub-gate.** Decouple fills from strokes at `:3135` so fills can flip
  independently.
- **INC-4 — flip globe(7) FILLS direct behind an opt-in flag.** Verify same-LOD + cross-LOD
  (skirt) + antimeridian on the real GPU.
- **INC-5 — globe(7) strokes direct.** Live-mpp width; verify outline glued to fill.
- **INC-6 — disc {3,4,5} per-projType** (A/B each: rim clip on subdivided fills). **oblique(6)
  LAST/excluded** (rotated antimeridian + flat-MVP pitch>0 bug = separate work).
- **INC-7 — retire the bake→drape subsystem.**
- Deferred (separate initiatives): screen-adaptive GPU-amplification subdivision; ellipsoid switch.
  **Decision (maintainer):** target the Mapbox-style **direct vector reprojection + geometry
  subdivision** for the whole non-Mercator family, converging it with the Mercator DIRECT
  path so there is ONE vector authority. The MapLibre-style adaptive-bake-resolution is
  recorded here only as a **fallback**, not the direction.

## TL;DR

- **Symptom (user):** on every non-Mercator projection, vector fills/strokes look
  stale / soft / magnified as you zoom, and line width/length drift — the map "is not
  re-rendered per zoom level." Mercator is crisp and continuous at every zoom.
- **Root cause:** #599 (globe vector great-circle drape) **bakes** each tile's fill+strokes
  into a **fixed-resolution** texture (`BAKE_PX = 512` at the tile's NATIVE zoom, ortho
  `E = TWO_PI_R_EARTH / 2^tileZoom`) and drapes it on the raster sphere grid. A baked
  texture is a **raster**: between LOD steps, and whenever the tile is displayed larger than
  its native 512², it **magnifies** (softens + widens lines) instead of re-rasterising the
  vector at the display zoom. Mercator renders vector **directly** (the VS projects tile
  vertices every frame and computes line width from the per-frame camera mpp), so it is
  resolution-independent.
- **Scope:** this is the ENTIRE sphere-route family, not "globe". `routeToSphereSelector`
  (geo/src/projections-table.ts:223) = `globeMode || (!isFlat && !isGlobe)` routes projTypes
  **{3 orthographic, 4 azimuthal_equidistant, 5 stereographic, 6 oblique_mercator, 7 globe}**
  (+ any globeMode-promoted azimuthal at pitch>0) through the bake→drape. Mercator(0),
  equirectangular(1) and natural_earth(2) are `isFlat` → they render DIRECTLY and are
  unaffected. (Pinned by `projections-table.test.ts`: `routeToSphereSelector === {3,4,5,6} ∪
globeMode`.)
- **Target:** replace the bake→drape with **direct ECEF reprojection of the tile geometry**
  (the arm that already exists — see below) + **subdivision** dense enough that no triangle
  or line edge chord-facets on the sphere. This is curve-correct AND zoom-continuous AND
  sharp — one authority shared with Mercator.
- **Why now / S-100:** raster bakes are fundamentally inadequate for nautical ENC symbology
  (S-101 features, S-102 depth contours) which must stay sharp and precise at every zoom. A
  direct vector path is a prerequisite for that roadmap.

## Background: the three reference architectures

|                                   | how non-Merc vector is drawn                                                                                           | sharp?                 | continuous?         | curve-correct?                | cost                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------- | ----------------------------- | ------------------------------------------ |
| **X-GIS today (#599 approach B)** | bake tile→512² texture at native z, drape on sphere grid                                                               | no (raster, magnifies) | **no**              | yes (grid drape)              | 1 offscreen bake / tile + drape            |
| **MapLibre** (fallback here)      | same raster/bake idea, but bake resolution scales with `cameraZoom − tileZoom` overzoom delta                          | better                 | ~ (raster-discrete) | yes                           | bigger bakes; still raster                 |
| **Mapbox GL JS** (target)         | DIRECT vertex reprojection to ECEF + geometry SUBDIVISION (granularity grid) + adaptive Mercator transition on zoom-in | **yes**                | **yes**             | yes (subdivision bends edges) | per-frame vertex transform (like Mercator) |

Mapbox does **not** bake to raster; it reprojects tile geometry client-side with per-tile
globe matrices and subdivides straight edges into a grid so they bend along the sphere, and
gradually blends toward Web Mercator as you zoom in. Sources: mapbox.com/blog/adaptive-projections,
docs.mapbox.com/mapbox-gl-js/guides/globe, /guides/projections.

## Why #599 baked instead of drawing direct

The direct sphere path ALREADY EXISTS and is what the pre-#599 code (and WebGL2 sphere-route
TODAY — the bake is WebGPU-only, `bakeTileToTexture` returns null on WebGL2) uses:

- **Polygon fill:** `vs_main_ecef` (map/src/shaders/dsl/polygon.ts:506) — the ECEF-RTC arm of
  `emitPolygonProjectionLadder`: `clip = u.mvp * vec4(ecef_rtc, 1)` with the ECEF-frame MVP
  from `Camera.getECEFFrameView()`. Vertices are projected directly, every frame.
- **Line/stroke:** the line VS extrudes width by the per-frame `mpp` (metres-per-pixel) — on
  the direct path this is the LIVE camera mpp, so a `w`-px line stays `w` screen px at every
  zoom (the resolution-independence Mercator has). The bake path instead packs `mpp = E/512`
  (native, fixed) — the exact source of the width drift.

`#599` (docs/research/2026-07-11-599-globe-vector-drape-reimpl.md) rejected the direct path
("approach A, tiler subdivision — partial-only mitigation") because a flat triangle whose
vertices span a large lon/lat arc projects as a **chord under the sphere** → visible faceting
on large polygons/lines at low globe zoom. The raster sphere-grid drape sidesteps this by
construction (a uniformly fine grid follows the curve). **That decision optimised
curve-correctness + per-frame cost; it did not weigh zoom-continuity / resolution-independence
— which is exactly what it traded away.**

## The key fact #599 under-weighted: subdivision already exists

The chord-faceting the drape avoids is **already** mitigated on the direct path by the tiler —
and, critically, it subdivides the **EARCUT OUTPUT MESH (interior triangles)**, not just the
boundary, which is exactly the property MapLibre's globe guide says is required (boundary-only
subdivision leaves big sparse-polygon interiors — Russia — chording):

- `compiler/src/tiler/vector-tiler.ts:632 tessellatePolygonToArrays` earcuts the ring, then at
  `:674` loops the earcut triangles (`for (t) subdivideTriangleMM(earcutIdx[t], …)`) and
  recursively 4-splits any FILL triangle whose lon/lat edge span exceeds
  `MAX_TRI_DEGREES_FOR_PROJ = 2°` (line 390) to `MAX_TRI_SUBDIVIDE_DEPTH = 5`, with **intra-tile
  vertex dedup** (`getOrAddVertexMM`) so shared sub-edges reuse one vertex → no T-junctions
  _within_ a tile. It is called unconditionally from the MVT pipeline
  (`polygon-tiler.ts:76,91,115`; `vector-tiler.ts:1361,1370,1384`) — projection-agnostic,
  built once per tile.
- **Landed 2026-05-05** (commit `042de3b2`), TWO MONTHS BEFORE the 2026-07-11 #599 decision — so
  the fill subdivision existed when approach A was called "partial-only" (see next section).
- **Midpoints are LINEAR in Mercator-metres, NOT great-circle.** A geodesic-slerp midpoint was
  tried (iter 6) and **reverted** (`25a33316`, iter 56) because it caused z=0 banding. At the 2°
  gate the linear-vs-GC midpoint difference is sub-km (< the chord it removes), so linear is
  sufficient and is the shipped choice. (Inline GeoJSON's twin `data/src/geojson.ts:282
subdivideTri` DOES use `interpolateGreatCircle`, but inline is not the OFM/MVT path.)
- **Index width:** X-GIS fill indices are **32-bit** (`Uint32Array`, vector-tiler.ts:1510;
  `polygon-fill-material.ts:495` draw `format: 'uint32'`). MapLibre caps its grid granularity
  at **128 because it uses 16-bit indices**; X-GIS has NO such ceiling — it can subdivide finer
  if needed. A standing advantage for the direct path.

So X-GIS ALREADY subdivides the earcut OUTPUT MESH (interior triangles) — the property MapLibre
achieves with a grid clip — via recursive angular refinement + intra-tile dedup. **Point of
correction:** `map/src/core/polygon-mesh.ts` is the 3D building-EXTRUSION mesh (its own comment
`:205` calls great-circle tessellation "overkill" there), and `line-material.ts` is the #599
line BAKE material — neither is the flat-fill sphere subdivision. The real authority is the
**tiler** above. So the premise "fill subdivision does not exist yet / was never built" is not
accurate: it was built (approach A's core), shipped, and is live on the WebGL2 sphere-route +
the `__XGIS_DISABLE_VECTOR_DRAPE` direct path this session measured.

The open question #599 never measured: **with this earcut-interior subdivision, is the direct
path visibly chord-faceted today, or is the drape solving a problem the tiler already solved?**
This doc answers it empirically (below): at z0.7–z4 the direct fill is NOT visibly faceted. The
migration TIGHTENS the fixed 2° gate to a curvature-adaptive tolerance (§Target design 2) so
"no facets" holds at every zoom by construction.

## Revisiting the 2026-07-11 "partial-only" verdict (addressed reason-by-reason)

The #599 decision (docs/research/2026-07-11-599-globe-vector-drape-reimpl.md:3) rejected
approach A as "partial-only." The SPECIFIC reasons are in the incomplete-work inventory
(docs/research/2026-06-25-incomplete-work-inventory.md, item **A1**): the drape "closes globe
**inner-sphere / back-lip / tessellation-gap / over-zoom-jitter**." That is a BUNDLE — and only
one item is even about vector geometry. Taken point by point, with this session's evidence:

- **Faceting / chord (the geometry item):** REFUTED as a reason to bake. Fill subdivision
  already existed (2026-05-05) and the real-GPU A/B shows the direct fill curve-correct at
  z0.7–z4 (below). Approach A covers this.
- **inner-sphere / back-lip:** LEGITIMATE but SEPARABLE. The inventory itself (C1) says the
  back-lip is NOT a mesh facet — it is "(a) the per-pixel cos_c cull boundary at the limb, (b)
  no under-occluder sphere to depth-block the far hemisphere" — with a **minimal non-drape fix:
  an opaque sphere just under EARTH_R, depth-write, before the vector pass.** This is a
  depth/occlusion concern, independent of whether vector fills are baked or drawn direct.
  ⇒ **Migration dependency:** retiring the drape must ensure the under-occluder sphere (C1) is
  present, or the back-lip re-appears. This is the one real thing the drape was masking.
- **tessellation-gap:** the earth-surface fill is already **128×64** (`earth-surface-fill.ts`,
  raised to kill the azimuthal/ortho z0 facet) and fill subdivision exists — not a bake reason.
- **over-zoom-jitter:** INVERTED by the evidence. The bake is the WORSE path at over-zoom (soft,
  over-thick, LOD-discrete — z6.9/z16 below); the DIRECT path is what actually fixes over-zoom
  continuity. The drape "closing over-zoom-jitter" does not survive measurement.

**Net:** the "partial-only" verdict bundled a geometry problem approach A already solved with a
depth/occlusion problem (back-lip) that has its own minimal fix — and claimed an over-zoom win
the bake does not actually deliver. MapLibre/Mapbox ship approach A as COMPLETE precisely
because they pair subdivision with proper depth/occlusion + adaptive projection, not a raster
bake. The migration adopts approach A AND carries the under-occluder sphere (C1) as an explicit
dependency.

## Target design

**One vector authority.** Non-Mercator projTypes render fills+strokes through the SAME direct
vertex path Mercator uses, differing only in the MVP (`getViewForProjection` per projection)
and the subdivision granularity. No bake, no drape, no second raster cache.

1. **Direct reprojection.** Reuse `vs_main_ecef` (fills) + the line VS globe/ECEF arm
   (strokes). Vertices → ECEF-RTC → `u.mvp`. Line width from the **live** camera mpp →
   continuous screen-space width. Log-depth + hemisphere-cull already wired on this arm.
2. **Curvature-ADAPTIVE RECURSIVE subdivision (the granularity answer — Mapbox's scheme, NOT a
   fixed grid).** Mapbox (mapbox.com/blog/adaptive-projections) densifies by **recursive
   midpoint refinement within a tolerance**: add the midpoint of a segment, measure how far the
   reprojected midpoint deviates from the straight chord, and recurse into the two halves only
   while the deviation exceeds a screen-space tolerance. Net cost ≈ **2–3 % extra points** on a
   typical map — points are added ONLY where curvature demands, not uniformly. This replaces the
   fixed `MAX_TRI_DEGREES_FOR_PROJ = 2°` gate with a **tolerance test** (`sagitta =
R(1 − cos(θ/2))` projected to screen px < ~0.5 px): it TIGHTENS at low zoom (big on-screen
   arcs) and effectively stops at high zoom (arcs already flat). `subdivideTriangleMM` /
   `subdivideTri` are already the recursive-4-split skeleton — the change is the STOP CRITERION
   (fixed degrees → reprojection tolerance) and applying it to boundary AND earcut-interior
   edges (both already covered). Midpoints are linear-MM today (GC slerp reverted for z=0
   banding, `25a33316`); at a tightened tolerance a per-latitude GC midpoint can be revisited if
   a banding-safe form is found — but linear-MM at the tolerance is likely already sub-pixel.
   - **Where:** transform + subdivide ONCE per tile LOAD (Mapbox does the same — no per-frame
     geometry cost), cached in the tile mesh. WebGPU has no tessellation/geometry shader, so
     CPU-side (the tiler, which already owns this) is the pragmatic home; a GPU compute
     amplification pass is a later option only if per-tile CPU cost bites.
3. **Adaptive projection + GPU affine skew (convergence to Mercator on zoom-in).** Mapbox uses
   3 zoom zones — low zoom: fixed projection centre; high zoom: screen-centre reference (feels
   like Mercator, no scale drift); middle: smooth interpolation — plus a render-time GPU
   **affine skew** of the view matrix that makes meridians/parallels perpendicular at high
   zoom, phasing in as you zoom. This is a per-frame GPU MATRIX (zero geometry cost) and is
   what gives seamless zoom-in continuity. X-GIS's per-projection `getViewForProjection`
   already supplies the MVP seam to host this; the skew term is an additive increment (after
   fills/strokes are direct). Deferred to a later increment — not required for the core
   continuity win, but the documented path to full Mercator-convergence.

**Reference sources.** Mapbox gives the design-level algorithm (above) but NOT the seam/pole/
antimeridian implementation. Those concretes — subdivision granularity constants, tile-edge
STITCHING, pole handling, the globe transform + affine correction — live in **MapLibre GL JS's
open-source globe** (`src/geo/projection/`, `src/render/subdivision*`): mine it for the exact
stitching + pole-fan details when implementing the Seams section. (Fetch pending — flagged.)

**Granularity control — X-GIS recursive vs MapLibre grid.** MapLibre subdivides earcut output
against a regular **grid of granularity N**, chosen per geometry-type per zoom from a
`SubdivisionGranularitySetting`; FILL uses **max N = 128** — "enough for smooth curved
horizons, not too much geometry, and it does not overflow 16-bit indices." It is not perfect
(finite N → residual micro-faceting; MapLibre issue #7489 "no perfect curve at any zoom"), but
128 reads as smooth. X-GIS instead uses **recursive angular refinement** (4-split while an edge

> threshold, depth-capped) which places points ADAPTIVELY (only where an edge is still long) —
> closer to Mapbox's recursive-tolerance scheme and cheaper on near-flat geometry. The migration
> should:

- Replace the fixed `2°` threshold with a **per-zoom, screen-tolerance** stop test (sagitta <
  ~0.5 px), so low-zoom tiles (big arcs) refine more and high-zoom tiles stop early. A
  per-zoom granularity table is the equivalent knob — indicative ceiling: refine until edge
  arc ≤ ~1–2° at z≤2, relaxing above; no fixed N cap needed given 32-bit indices.
- Keep the intra-tile dedup; ADD cross-tile edge determinism (Seams §1) so adjacent tiles
  agree on shared-border midpoints.
- Keep the depth cap as an overflow guard only; with 32-bit indices it is not the binding
  constraint MapLibre's 128 is.

**What is deleted at the end:** `VectorTileRenderer.bakeTileToTexture`, `VectorDrapeRenderer`,
`vector-drape-stroke.ts`, `vector-drape-cache.ts`, the `_drape*` state, `BakeStrokeStyle`, and
the `strokeBakeKey` cache plumbing — the bake→drape subsystem in its entirety. The raster
sphere grid (`RasterDraper`) stays; it drapes actual RASTER basemap tiles, which are
legitimately raster.

## Phased migration plan

Each increment is build + real-GPU verified (headed WebGPU, main checkout), §5 pixel-diff +
16-split, not eyeball. Every increment keeps Mercator byte-identical (the direct path is gated
behind `routeToSphereSelector`).

- **Increment 1 — FILLS, one projection (globe / projType 7, the ECEF arm this session
  measured), direct + verify.** Route the globe's constant fills through the existing direct
  ECEF draw (skip the bake) and verify on the real GPU:
  - (a) **curve-correctness** — no chord faceting at low zoom (z0–z4) vs the drape;
  - (b) **continuity** — crisp across a zoom sweep + over-zoom (z6.9) + past source maxzoom
    (z16), vs the drape's magnified softness;
  - (c) **tile-edge cracks (Seams §1)** — inspect a tile boundary at mid-zoom for hairline
    T-junction cracks; if present, land the deterministic per-edge subdivision (Seams §1a);
  - (d) **antimeridian (Seams §2)** — centre at lon 180 and confirm no gap/duplication (✓ this
    session);
  - (e) **pole (Seams §5)** — the direct path needs a pole fan (white-oval artifact observed);
  - (f) **back-lip (inventory C1)** — confirm the under-occluder sphere is present so retiring
    the drape does not re-expose the far-hemisphere back-lip.
    Curve-correctness (a) + antimeridian (d) are already GREEN this session; (c) pole (e) and
    back-lip (f) are the remaining gates. This is a gate flip + pole-fan, NOT new fill
    subdivision. Keep the drape for the disc/oblique projTypes until their arms are verified
    (increment 3).
- **Increment 2 — STROKES.** Route the same projection's polygon outlines + line features
  through the direct line VS (live mpp width). Verify width is constant screen-px across zoom
  (§5 measure px) and outlines stay glued to fills.
- **Increment 3 — all sphere-route projTypes.** Extend to {3,4,5,6,7} (enumerate via
  `routeToSphereSelector`); verify each with the projection-coverage harness.
- **Increment 4 — retire the bake.** Delete the bake→drape subsystem (list above); drop its
  e2e specs or repoint them at the direct path; confirm no VRAM/allocation regression.

## Fallback (NOT the direction): MapLibre adaptive bake resolution

If the direct+subdivision path proves infeasible for some tile geometry, the smaller stopgap is
to keep the bake but scale its resolution with the overzoom delta: `bakePx = BAKE_PX <<
clamp(floor(cameraZoom) − tileZoom, 0, MAX_LEVELS)` (zero cost at native zoom; higher-res only
when the readiness-gate holds an over-zoomed parent or past source maxzoom), cache-keyed by the
level and byte-budgeted. This restores continuity within the raster model but keeps the vector
soft under a loupe and does NOT serve S-100. Documented for completeness; **do not build it**
unless the target is blocked.

## Seams — the five that direct+subdivision MUST solve (Mapbox proves it is achievable, but it is not automatic)

A subdivided direct-reprojection globe has five distinct seam classes. Design each head-on;
increment-1's real-GPU verification must actively check (1), (2) and (5).

1. **Tile-edge T-junction cracks (the classic subdivided-globe seam).** When two adjacent
   tiles subdivide their shared border independently, they can insert DIFFERENT midpoints on
   the same physical edge → a T-junction → a hairline crack (background bleeds through) once
   the two edges bow onto the sphere. `subdivideTriangleMM` currently subdivides each tile's
   own triangles with no cross-tile edge agreement, so this risk is REAL for fills.
   **Fixes (pick one):** (a) deterministic per-edge subdivision keyed only on the shared
   edge's endpoints + a global granularity so both tiles compute the identical midpoint set
   (edge-stitch by construction — the cleanest; MVT tile borders are exact integers so the
   endpoints match); (b) a 1-px "skirt" (drop-down apron) along each tile boundary that hides
   sub-pixel cracks (Google-Earth-style); (c) snap the boundary rows to the un-subdivided
   chord (no midpoints ON the tile border), accepting a slightly larger border chord. (a) is
   the 5-year answer.
2. **Antimeridian / dateline (±180°).** Geometry crossing ±180° must be split/wrapped or its
   earcut interior edges cut across the globe. The tiler already has this
   (`splitLineAtAntiMeridian`, `detectsAntiMeridianCross` + Sutherland-Hodgman clip in
   data/src/geojson-helpers.ts; the globe selector keeps tiles on BOTH sides by construction —
   globe-visible-tiles.ts). Direct reprojection must keep using it; verify no gap/duplication
   at lon 180.
3. **Projection-boundary seams.** The azimuthal/stereographic/orthographic disc has a finite
   rim (visible hemisphere = a disc of diameter 2·EARTH_R; projections-table.ts:315) and
   oblique_mercator has its own rotated antimeridian. Geometry must be clipped at the
   boundary (the `cullThreshold`/`rimThreshold` per-row data already drives the hemisphere
   cull in the shader; the direct fill path already consumes it via `polygon_cos_c_fragment`
   - `polygon_rim_alpha`). Verify the rim on the disc projTypes in increment-3.
4. **Ellipsoid vs sphere (BONUS win).** The globe currently reprojects onto a normalised
   SPHERE (`lonLatToECEF` → radius `EARTH_R = EARTH.sphereR`, geo/src/globe.ts:29,54), the
   source of the known ~21.5 km ellipsoid−sphere discrepancy (site/src/content/blog/
   2026-07-13-two-renderers-one-truth.md; project_projection_matrix_unification memory).
   A DIRECT ECEF path can reproject to the true WGS84 **ellipsoid** (like Mapbox), retiring
   that offset; the raster bake — locked to whatever sphere basis the grid drape uses — never
   could. Call this a second win: direct reprojection is a prerequisite for ellipsoid-correct
   globe geometry (the ellipsoid switch itself is a later, separable increment).
5. **Pole cap (OBSERVED this session).** The Web-Mercator tile pyramid stops at ±85.051°, so
   the geographic pole is a hole the vector fills cannot reach; it must be closed by a pole FAN
   (converging vertices from the ±85° row to the pole), mirroring the raster grid's pole cap
   (`raster.ts:160` "#1053 globe raster pole cap") and the earth-surface-fill pole handling.
   Real-GPU (globe z2): the direct path currently shows a WHITE oval at the pole, the drape a
   BLACK hole — both wrong, differently. Increment-1 must give the direct fills a proper pole
   fan (MapLibre `subdivision` does exactly this). This is the third gate before the default
   flip.

## Verification evidence (real GPU, this session)

Headed WebGPU (real GPU, Windows), main checkout `D:\X-GIS\playground`, OFM Bright, Seoul,
pitch 0. Spec `playground/e2e/_drape-zoom-continuity.spec.ts`; `SWEEP_DIRECT=1` forces the
DIRECT ECEF path via the existing `__XGIS_DISABLE_VECTOR_DRAPE` escape hatch — an in-place
A/B of the two paths on identical data/camera. Verdict by §5 (read ×5 crops; the scalar
gradient-energy metric MISLEADS here — the drape's soft magnified ramps inflate lapVar/edgeFrac
above the direct path's flat-fill+sharp-line frames, so the crops, not the numbers, decide).

- **Continuity / crispness (globe z6.9, over-zoom):** DECISIVE. The DRAPE renders soft,
  blobby, over-THICK roads with visibly LESS detail (fewer roads) — the baked-at-native-then-
  magnified raster signature. The DIRECT path is crisp, THIN, and denser (correct screen-px
  line width, full detail). Line width is wrong (too thick) on the drape, correct on direct.
- **Curve-correctness / faceting (globe z3):** the DIRECT coastlines (Korea/Japan/China) are
  smooth curves with NO gross chord-faceting — visually equal to the drape's curves. The
  existing 2° tiler subdivision (`subdivideTriangleMM`) already makes the direct fill path
  curve-correct at this zoom, i.e. the drape solves a faceting problem the tiler had ALREADY
  largely solved.
- **Settled fractional sweep (mercator/globe/stereographic z6.0–7.9):** at steady state the
  readiness gate has advanced to native LOD so the drape is ~crisp — confirming the loss is
  (i) TRANSIENT during the zoom-in hold before child tiles bake and (ii) PERSISTENT past
  source maxzoom.
- **Past-maxzoom (persistent):** globe z16 shows OFM's z14 tiles magnified 4×; the drape frame
  is near-flat (13 KB PNG, edgeFrac 0.023) — permanent softness that never heals, exactly the
  raster-LOD ceiling the direct path does not have.
- **Antimeridian (globe centred lon 180, z3):** the DIRECT path renders Pacific islands on
  BOTH sides of the dateline (NZ / Fiji / Vanuatu / Tonga / Hawaii) with no gap or
  duplication — identical to the drape. The tiler's antimeridian split works on the direct
  draw (Seams §2 ✓ at z3).
- **Extreme low zoom (globe z0.7, whole hemisphere — the worst-case chord):** the DIRECT
  coastlines (Russia/China/India/Japan/Philippines) are SMOOTH curves with no gross
  faceting, matching the drape. The 2° subdivision is sufficient even here (Seams-adjacent
  curve-correctness ✓).
- **Large-polygon chord = 0 (globe z2, centred lat55/lon90 — Russia ~60° wide near the
  limb):** the DIRECT path renders Russia + all Eurasian coastlines as SMOOTH curves (no
  straight-chord segments) with a smooth disc limb, matching the drape — confirming the 2°
  earcut-interior subdivision gives chord≈0 on the biggest polygons. ×4 Arctic hot-crop:
  Greenland/Iceland/Scandinavia coastlines smooth on both; direct crisper, drape blockier.
- **Pole handling differs (NEW open item):** near the North pole the DIRECT path shows a
  WHITE oval, the DRAPE a BLACK hole — neither correct. The pole is imperfect in BOTH paths
  (a known polar-cap concern), but DIFFERENTLY; the migration must give the direct path a
  proper pole fan (MapLibre's `subdivision` pole handling) so it is at least as good as the
  drape.
- **Tile-edge T-junction cracks (Seams §1):** NOT conclusively verified — sub-pixel
  hairline cracks are not detectable at whole-frame scale, and blindly targeting an exact
  on-screen tile boundary for an ×8 crop was not done this session. **FLAGGED** (with pole
  handling + the under-occluder-sphere dependency) as the open increment-1 checks before
  flipping the default (see status below).

## Status of increment-1 (this session)

**Reframed by the facts:** increment-1 is NOT "build fill subdivision" — that already exists
(tessellatePolygonToArrays → subdivideTriangleMM, earcut-interior, landed 2026-05-05, 32-bit
indices). Increment-1 is "**route globe fills+strokes direct (skip the bake) and verify the
existing subdivision + pole + seams hold**."

**Measurement: DONE and strongly positive** — via the existing `__XGIS_DISABLE_VECTOR_DRAPE`
escape hatch (no product-code change), the direct globe path is: crisper + correct-width
(z6.9), curve-correct with **large-polygon chord≈0** (Russia z2; coastlines z0.7–z4), and
antimeridian-correct (z3), decisively beating the fixed-res bake on continuity.

**Code flip: intentionally NOT landed this session.** The one-condition gate is
`vector-tile-renderer.ts:3135` (exclude globe/projType 7 from `_drapeGlobeFills`). Three checks
must close before flipping #599's default — each observed or flagged this session, not
hand-waved:

1. **Pole handling** — the direct path shows a white-oval pole artifact (needs a pole fan).
2. **Tile-edge T-junction cracks (Seams §1)** — not conclusively ruled out at sub-pixel scale.
3. **Under-occluder sphere (back-lip, inventory C1)** — the drape may be masking the far-
   hemisphere back-lip; confirm the opaque under-sphere is present so retiring the drape does
   not re-expose it.

Flipping before these would be the "quick fix that won't last" the repo bars. With them closed
(or the pole-fan + edge-stitch landed alongside), the flip is a one-condition change plus the
bake-subsystem deletion (Increment 4).
