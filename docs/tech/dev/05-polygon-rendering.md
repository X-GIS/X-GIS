# Polygons: earcut, conforming curvature, and the fill/outline pact

> Edition: **dev**. Exhaustive version: [`../agent/05-polygon-rendering.md`](../agent/05-polygon-rendering.md).

Filled polygons look like the easy primitive — triangulate, rasterize, done. The
difficulties are all at the edges: agreeing with your own outline to sub-pixel precision,
meeting the neighboring tile without cracks, curving over a globe without T-junctions,
and surviving what a clipper does to real-world geometry. X-GIS's polygon pipeline is a
catalog of answers to those, most of them learned from a specific bug.

## The CPU pipeline, in the order that matters

Per tile, per feature: clip (Sutherland-Hodgman, in Mercator meters) → probe for
clipper-induced self-overlap → repair if needed → earcut → conforming subdivision → and
then derive the outline **from the same clipped rings**.

Choices worth noticing:

- **The fill is never simplified.** Douglas-Peucker runs only as a probe whose output is
  thrown away (it informs a subdivision heuristic). Reason: a simplified fill diverges
  from its own stroke by up to the tolerance, and since simplify∘clip ≠ clip∘simplify you
  can't repair the outline to match. Lines _are_ simplified — with tile-boundary vertices
  locked so adjacent tiles keep identical edges.
- **Boundary snapping**: clip intersections snap to a per-zoom grid so the two tiles
  sharing an edge produce bit-identical vertices — with the snapped coordinate clamped
  back into the segment's own span, because snapping near a corner could push it past the
  perpendicular edge and paint a phantom boundary stroke.
- **Self-overlap detection is a coverage test, not topology**: probe-earcut the rings and
  compare summed triangle area against the shoelace area. A clean polygon ratios 1.00; the
  canonical broken case (Korea at z7, where clipping produced a backtracking outer ring)
  ratios 2.57.
- **When clipping splits a footprint, the pieces are emitted as separate polygons, holes
  re-bucketed by point-in-polygon.** The alternative — flattening all outers into one ring
  list — met a consumer that assumed "first ring outer, rest holes" and earcut-punched
  piece two out of piece one's roof: _n_ building pieces rendered _n−1_ roofs, while the
  2D fill (a different consumer) stayed pixel-perfect. No test had ever fed that consumer
  more than one polygon. The lesson generalizes: "all rings this feature owns" and
  "outer + holes" are different contracts; make the boundary explicit and test with
  multi-piece fixtures.

For globes and curved projections, each earcut triangle is red-green refined — and the
split decision is made **per edge, not per triangle**, so the two triangles sharing an
edge always agree and no T-junction can open a crack. Midpoints are plain arithmetic
means (commutative, so both owners dedup to the same vertex); geodesic midpoints were
tried and reverted (banding at z0). The outline gets the same per-edge subdivision, and
because midpoints are collinear with the parent segment, subdividing preserves the
fill/outline coincidence instead of breaking it.

## One vertex format declaration

The 28-byte fill vertex (quantized ECEF-RTC position as u16 hi/lo pairs, feature id,
tile-local Mercator x/y, unclamped latitude for the polar caps) is declared once as a
field list from which the packer's byte offsets, the shader's `@location`s, and the
pipeline's vertex layout are all _computed_. The two f32 tail slots have their own scar:
they used to carry absolute degrees — one f32 ULP at longitude 127° is ~1.35 m, which
became a ~10 px fill-vs-outline split at deep overzoom. Tile-local values made the error
sub-millimeter at every zoom and, not incidentally, made the fill's flat-projection math
line-for-line the same shape as the stroke's.

## The fill fragment, and how styles reach it

The fragment discards (backface — with the spherical `cos c` **recomputed per fragment**,
because interpolating it as a varying is wrong across a triangle that spans the visibility
boundary; a latitude limit with a margin, because an exact comparison flickers per MSAA
sample at the pole fan; a parent-fallback clip rectangle), shades walls, then hits a
**composer placeholder** where the style variant's color expression is spliced in at the
IR level. Per-feature data arrives through a tiered system chosen by the compiler's
expression classifier: a plain uniform; a `feat_data` storage buffer indexed by the vertex
feature id; a palette texture for zoom-interpolated scalars; or the output buffer of a
per-feature compute kernel. Categorical values hash through a **stable 23-bit FNV** —
pure function of the value, sized to survive an f32 slot exactly — after a per-tile
alphabetical rank once made the same category change color as you panned.

Ground fills draw with **depth off**, ordered by submission (water → landuse → roads),
which is what makes stacking pitch-independent; coplanar fills ordered by depth bias was
the "lake disappears under landuse at pitch" bug. Parent/child tile coverage is stencil:
children stamp, parents draw only where no child did — plus a per-draw clip rectangle on
the fallback path, whose own bug (deduping four visible children into one dispatch keyed
without the visible tile) once left Korea unfilled while its outline drew fine.
Translucent fills go through weighted-blended OIT.

## Patterns without swimming

Fill patterns sample the sprite atlas with UVs derived from **absolute world coordinates**
— `fract(mercator_meters / repeat_meters)` — so the pattern is anchored to the ground:
pan and zoom don't make it swim, and tile boundaries can't seam it (the varyings
interpolate exactly). The repeat is recomputed per frame from camera zoom so an N-px
sprite repeats every N screen pixels. The scars here are about **slot reuse**: the pattern
path repurposes the fill-color uniform as an atlas bbox and fill-translate as the repeat
period, so a flag must disable the translate math in the vertex shader — before the flag,
those "translate" values (hundreds of kilometers) were applied as an NDC offset and threw
every vertex off screen.

## Extrusion and the globe

3D buildings earcut one roof per ring set, generate wall quads per edge, and are
pre-lifted in ECEF along local Up — in **the same tile anchor frame as the flat fill**, so
the camera-relative math applies unchanged (an early path that skipped the offset
collapsed every extruded tile onto the camera's tile the moment you pitched). Lighting
rotates MapLibre's viewport-frame light into the ENU frame first; dotting the raw light
against ECEF normals gave every face arbitrary brightness. Flat projections synthesize
wall height in Mercator's stretched Z (`/cos φ` — without it, walls render `cos φ`
short). And at coarse globe zooms, vector tiles are baked to a texture and **draped with
the proven raster sphere path** rather than growing a second sphere shader — handed back
to direct ECEF rendering past the zoom where the bake's blur exceeds the chord error.

## The pact

Fill and outline agreement is enforced, not hoped for: same clipped rings, same anchor
function from the same module, a byte-mirrored uniform block verified by reflecting both
emitted structs, plus two independent numeric gates — outline endpoints within 1 m of the
fill's boundary edges (extracted as "triangle edges that appear exactly once"), and a
decode-both-packings fuzz asserting < 0.25 px divergence at deep zoom. That fuzz test's
history is its own lesson: an earlier version "refuted" the bug because it probed near the
tile origin, where the f32 grid is fine. Probe where the error is largest.

## What to steal

1. Fill and outline from one clipped ring set; never simplify the fill; snap and lock
   tile boundaries.
2. Treat clipper output as hostile: coverage-ratio overlap probes, split pieces as
   separate polygons with re-bucketed holes, strip synthetic edges before stroking.
3. Per-edge subdivision decisions with commutative midpoints = conforming curvature free.
4. One vertex-format declaration, everything derived.
5. Depth off + painter's order for coplanar ground; stencil for tile coverage; recompute
   visibility predicates per fragment when interpolation is unsound.
6. World-anchored pattern UVs; be suspicious of uniform slot reuse.
7. Extrude in the fill's frame; rotate lights into it; reuse the proven path for the hard
   case and define the crossover analytically.
8. Gate sibling agreement numerically, and probe at the worst point of the domain.
