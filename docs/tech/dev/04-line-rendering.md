# Drawing a good line: quads that lie, SDFs that don't

> Edition: **dev**. Exhaustive version: [`../agent/04-line-rendering.md`](../agent/04-line-rendering.md).

High-quality 2D lines on a GPU are famously annoying: joins, caps, dashes,
anti-aliasing, variable width, and — on a globe — precision. The classical approach
(Mapbox-style) tessellates joins into triangles on the CPU. X-GIS takes the other road
and commits to it completely:

**The CPU emits one instanced 6-vertex quad per segment, sized generously. Everything
else — the stroke body, miters, bevels, round joins, caps, dashes, patterns, AA — is a
signed distance field evaluated in the fragment shader, in tile-local world meters.**

There is no vertex buffer at all. The quad corners come from `vertex_index`; the segment
data comes from a storage buffer indexed by `instance_index` (on WebGL2, where storage
buffers don't exist, the same buffer is an R32F data texture behind the same interface).
Each 128-byte segment record carries the split-precision endpoints, the neighbor tangents,
cumulative arc length, miter pads, an optional per-feature color, and — for the globe —
CPU-computed ECEF endpoints. One detail does a lot of work: **a zero tangent means "cap
here," a non-zero tangent means "join here."** That single bit is also how caps get
suppressed at tile boundaries.

## The math the CPU still owes

The CPU's only geometric job is making the quad *big enough*, and its one non-trivial
output is the miter pad — how far to extend the quad along the segment at a join. Three
subtle bugs live in that little function, all found the hard way:

- The pad is `|tan(θ/2)| = |cross| / (1 + dot)` — **not** `1/sin(θ/2)`, which is the miter
  length along the *bisector* and under-covers the along-segment extent past ~104°,
  leaving the miter tip poking out of the quad as a triangular hole.
- The miter-limit test is `cos(θ/2) < 1/limit`, using the identity `|A+B| = 2·cos(θ/2)`
  for unit tangents. The sin version (shipped once) fails to bevel sharp corners and
  spuriously bevels shallow ones.
- A 180° hairpin must answer "bevel," not "worst case" — extending a quad along a reversed
  segment paints perpendicular whiskers at dense vertex clusters.

The build-time miter limit is deliberately *larger* than the runtime one, so an
over-generous quad costs overdraw, never clipping. That asymmetry — make the cheap failure
mode the only possible one — is the whole philosophy of the design.

In the fragment shader, joins are distance-field set operations: clip each segment's SDF
at the angle bisector so neighbors tile the join without overlap; bevel with a half-plane
through the outer corners; round joins are a **circle union**, not fan geometry; caps are
half-planes, circles, or an analytic arrow taper. Very acute joins collapse to a pure
round union below a threshold that the Mapbox `round-limit` property scales — normalized
so the spec default reproduces the old constant byte-for-byte.

## Anti-aliasing that respects the device

The final coverage is one smoothstep over the SDF, and its half-band is `0.5 / dpr` CSS
pixels — i.e. **half a device pixel**. The predecessor used a fixed 0.5 CSS px band with
no DPR term: invisible on a 12 px road, but it *doubles* a 1 px line on retina, which is
exactly the "our thin lines look fat next to MapLibre" bug report. Sub-pixel widths are
handled the MapLibre way — clamp geometry to 1 px, pay the rest in alpha — because
rendering a 0.3 px ribbon geometrically just yields a fuzzy 2-3 px smear. The regression
test for the feather is a small gem: no GPU, it re-implements the emitted coverage profile
and integrates it in device pixels.

Width itself is authored in CSS px and converted through a single meters-per-pixel
authority (with a low-zoom cap — a consumer that used raw `2^-zoom` kept scaling widths
after the projection had saturated). Projection effects are corrected by *measuring*, not
by trusting the matrix: on flat non-Mercator projections the shader projects a base point
and an offset point through both the real ladder and a Mercator passthrough — the ratio
*is* the local Jacobian (equirectangular strokes were collapsing to `W·cos φ`), and on
Mercator the two probes are bit-equal so the scale is exactly 1 with no special case. On
the globe, a clip-space clamp holds the on-screen width, allowed only to grow, bounded
above (an unbounded scale walks tangent-plane corners to infinity at the limb).

## One arc coordinate funds everything

Dashes, patterns and gradients all ride a single per-fragment scalar: cumulative arc
length, computed in f64 at tile build and carried per segment. Dashes are `fract` over the
dash cycle in meters (with a predicate so they never chop a cap). Procedural patterns
place shape-SDF instances by arc (repeat anchors sample the nearest instance ± one
neighbor; start/end/center anchors need the total polyline length — which is why the
packer runs a union-find over shared endpoints to compute per-component length) and are
**unioned into the stroke SDF**, so a pattern extends the stroke rather than masking it.
`line-gradient` evaluates ≤8 stops analytically from the uniform — no LUT texture, because
the texture would need a bind group per (tile × layer).

## Precision: the multiplicand is the migration

Deep-zoom stability uses the standard X-GIS toolkit (split hi/lo endpoints, camera
subtraction inside the split arithmetic, projection re-centering onto the camera
longitude — see the [precision chapter](./02-coordinates-precision.md)). The
globe-specific episode is worth retelling because of how the fix is framed. The old arm
re-derived ECEF *in the shader* from absolute Mercator via f32 `atan(exp(·))`; the angle
error of that chain, times the **Earth radius**, is up to ~512 m of position error. The
new arm packs f64 ECEF endpoints on the CPU and rotates only the local corner offset in
the shader — so the same angle error now multiplies the *offset*, centimeters. The commit
message-level insight: *"that change of multiplicand, not any change of formula, is the
whole migration."* Measured on the software rasterizer: 1,170 m → 0.21 m. And the anchor
function is imported from the exact module the polygon packer uses — a same-named helper
in another package resolves constants differently, and fill and stroke must share one
position authority (both recombine hi+lo in f32, so they carry the *identical* residual
and stay registered).

## Order, translucency, and the fill contract

Lines never write depth; they write log-depth per fragment with two explicit biases — one
to beat the polygon fill's per-feature depth jitter (a coplanar stroke that *ties* the
fill's depth survives by driver luck; half of every coastline dash once vanished on one
backend), and one scaled by tile extent so outlines from two zoom levels covering the same
pixel don't stack. Translucent strokes draw into an offscreen **MAX-blend** target and
composite once — which is what kills double-darkening at self-intersections: within a
layer, overlap reduces to a single max coverage per pixel, and opacity applies once.

Finally, polygon outlines are this same renderer fed the *same clipped rings* as the fill,
with a byte-mirrored uniform block (one GPU buffer, two struct views, offsets asserted
equal by reflecting both emitted structs), shared projection functions, and a shared
fragment cull. The canonical war story: a correctness fix to the outline's projection —
and not the fill's — turned a shared invisible error into a visible seam. Sibling paths
get one authority, or a parity gate, or both.

## What to steal

1. Conservative instanced quads + fragment SDF; vertex pulling; no vertex buffers.
2. Derive join math from `|A+B| = 2cos(θ/2)`; make overdraw the only possible failure.
3. AA half-band = half a device pixel; width below 1 px is an alpha problem.
4. Correct projection width by measuring through the real MVP, not by special-casing.
5. One f64 arc coordinate for dashes, patterns, gradients; union patterns into the SDF.
6. In precision fixes, ask what the error *multiplies* — then shrink the multiplicand.
7. Depth ties are design bugs; bias explicitly. MAX-blend + composite for translucency.
8. Fill and outline: same geometry source, same uniforms (verified by reflection), same
   math modules. Never fix one sibling.
