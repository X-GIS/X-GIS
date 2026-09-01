# 04 — Line rendering: instanced quads + a fragment-shader SDF

> Edition: **agent**. Companion: [`../dev/04-line-rendering.md`](../dev/04-line-rendering.md).
> Authority files: `map/src/shaders/dsl/line.ts` (~1,700 LOC, the shader authority),
> `data/src/line-segment-build.ts` (CPU packer), `map/src/render/line-pattern.ts` (uniform
> packer), `map/src/render/line-renderer.ts` (pass owner),
> `map/src/render/material/line-material.ts` (pipeline state).

## 1. The model in one sentence

X-GIS does **not** build join/cap geometry on the CPU. It emits **one instanced 6-vertex
quad per segment** that is only a *conservative bound*, and computes the entire stroke —
body, miter, bevel, round join, caps, dashes, patterns, anti-aliasing — as a **2-D signed
distance field in the fragment shader, in tile-local Mercator meters**.

Consequences that drive everything below: the CPU's only geometric job is to make the quad
big enough (overdraw is cheap; clipping the stroke is a bug); every visual feature is a
distance-field operation (`min` = union, `max` = intersection/clip); and per-segment data
lives in a storage buffer indexed by `instance_index`, so there is **no vertex buffer at
all** (`line-material.ts:417-426`: `count: 6, indexed: false, instanceCount: segmentCount`).
On WebGL2, where storage buffers don't exist, the same buffer is emulated as an R32F data
texture read with `texelFetch` (`line-material.ts:48-51`).

## 2. The per-segment record

`struct LineSegment`, 32 × f32 = 128 B, std430 (`line.ts:275-314`; written by
`buildLineSegments`, layout doc `line-segment-build.ts:22-56`):

| slots | field | meaning |
|---|---|---|
| 0-7 | `p0_h p1_h p0_l p1_l` (vec2f each) | endpoints, tile-local Mercator meters, split hi/lo (DSFUN) |
| 8-11 | `prev_tangent`, `next_tangent` | unit tangents; **a ZERO tangent means "cap here"**, non-zero means "join here" — that one bit is also how tile-boundary cap suppression works |
| 12-13 | `arc_start`, `line_length` | cumulative arc at p0; total arc of the whole polyline component |
| 14-15 | `pad_ratio_p0/p1` | miter along-pad, in multiples of half-width (CPU-computed, §3) |
| 16 | `z_lift_m` | per-feature roof height (extrusions) |
| 17 | `width_px_override` | 0 ⇒ layer width |
| 18 | `color_packed` | RGBA8 in an f32 slot via `Uint32Array` view; read with `unpack4x8unorm(bitcast<u32>(…))` |
| 20-31 | `e0`, `e1` ECEF RTC hi/lo (3 axes each) | CPU-f64 ECEF endpoint lanes for the globe (#2089, §7) |

The CPU↔GPU stride is locked by `map/src/render/line-segment-struct-layout.test.ts`, which
recomputes std430 — its header notes that a stride mismatch produces **no WebGPU validation
error**, so only a test can catch it.

Inputs are DSFUN vertex streams from the tiler: stride 6 for line features, stride 10 for
polygon outlines (which carry **pre-computed per-vertex in/out tangents**). Arc length and
tangents are produced once, upstream, by `augmentChainWithArc`
(`compiler/src/tiler/vector-tiler.ts:523-670`) — the **single helper shared by polygon
rings and line features**; closed rings wrap tangents and append a wrap vertex carrying
`arc = perimeter` so the closing join is a real join, not a cap. `line_length` is computed
by **union-find over the shared-endpoint graph** per connected component
(`line-segment-build.ts:283-316`) — needed for END/CENTER-anchored patterns and gradients.

## 3. Joins and caps (the actual math)

The CPU contributes exactly one scalar per endpoint — how far to extend the quad along the
segment. `data/src/line-segment-build.ts:85-124`:

```ts
const cross = Math.abs(ax * by - ay * bx)
const dotAB = ax * bx + ay * by
const denom = 1 + dotAB
if (denom < 1e-6) return 1                 // 180° reversal → bevel (#463 whisker fix)
const padAlong = cross / denom             // == |tan(θ/2)|
if (padAlong < 0.05) return 1              // collinear-ish
const bisLen = Math.hypot(ax + bx, ay + by)
const cosHalf = bisLen / 2                 // |A+B| = 2·cos(θ/2)
if (cosHalf < 1 / miterLimit) return 1     // beyond miter limit → bevel
return Math.min(padAlong, miterLimit)
```

Three bugs paid for in that snippet, each now an inline invariant:
- The pad is `|tan(θ/2)| = |cross|/(1+dot)`, **not** `1/sin(θ/2)` — the latter is the miter
  length along the bisector, which underestimates the *along-segment projection* for
  θ > 103.6°, leaving the miter tip outside the quad (a visible triangular gap).
- The miter-limit test is `cos(θ/2) < 1/L`, **not** `sin(θ/2)` (#432) — the Mapbox miter
  ratio is `1/cos(θ/2)`; the sin form failed to bevel sharp corners and spuriously
  bevelled shallow ones. Key identity: for unit tangents, `|A+B| = 2·cos(θ/2)`.
- A 180° reversal must return 1 (bevel), not "worst case miterLimit" — extending the quad
  along a reversed segment drew perpendicular whisker spikes at dense vertex clusters (#463).
- The build-time limit (4.0) is deliberately *larger* than the runtime default (2.0), so an
  over-generous quad only costs overdraw, never clipping.

In the **fragment shader**, joins are half-plane and circle operations on the SDF
(`line.ts:552-771`):

- **Bisector clip**: each segment's SDF is clipped at the angle bisector so the two
  neighboring segments tile the join without overlap
  (`dM = max(dM, −along)` where `along = dot(p − joinCenter, normalize(prevTan + dir))`).
- **Miter-limit in-shader**: `bisMag = |prevTan + dir| = 2·cos(θ/2)`;
  bevel iff `bisMag < 2/L` (mirrors the CPU test exactly).
- **Bevel**: a half-plane through the two outer corners on the sharp side.
- **Round join**: an SDF **circle union**, not fan geometry:
  `circleD = |p − joinCenter| − halfW; dM = min(circleD, …)`.
- **Acute fold** (#413): below `|prevTan + dir| ≤ 0.6` (interior ≲ 35°) the join collapses
  to a pure round point union (no half-plane carve) for MapLibre parity; the Mapbox
  `line-round-limit` property scales this constant, normalized so the spec default (1.05)
  reproduces the historic constant byte-identically (`line.ts:614-619`).
- **Caps** by `capType = flags & 7`: BUTT = half-plane at the endpoint; SQUARE = half-plane
  pushed out by halfW; ROUND = circle; ARROW = an analytic taper
  `newW = halfW·(1 − saturate(dist/arrowL))`, `arrowL = 4·halfW`.
- **Line offset** (`line-offset`) shifts the join center along the miter vector by
  `offset / dot(miterVec, nrm)` so offset strokes still join correctly.

## 4. Anti-aliasing

One smoothstep over the SDF, converted to pixels, DPR-aware (`line.ts:945-952`):

```wgsl
let d_px    = d_m / layer.mpp;                 // meters → CSS px
let blur_px = max(0.0, layer.aa_width_px - 1.0);
let half_aa = 0.5 / layer.dpr;                 // = 0.5 DEVICE px
let alpha   = 1.0 - smoothstep(-(half_aa + blur_px), half_aa, d_px);
if (alpha < 0.005) { discard; }
```

- The feather half-band is `1/(2·dpr)` CSS px = **0.5 device px**; `line-blur` widens only
  the inner side. The DPR term is the #606 fix: a fixed 0.5-CSS-px band is dpr× too wide in
  device pixels — invisible on a 12 px road, but it **doubles a 1 px line** on retina
  ("2-3 px vs MapLibre's 1 px crisp"). The regression test is GPU-free: it re-implements the
  emitted coverage profile and integrates it in device px
  (`map/src/render/line-thin-width-dpr.test.ts`).
- **Sub-pixel widths** are handled CPU-side, MapLibre-convention
  (`line-pattern.ts:276-287`): geometric width is clamped to ≥1 px and alpha is scaled by
  the requested fraction (`widthAlphaScale = strokeWidthPx < 1 ? strokeWidthPx : 1`) —
  otherwise a 0.3 px stroke renders as a fuzzy 2-3 px fringe.
- The vertex shader pads the quad by `aa_width_px` on both sides
  (VS `halfWm = (w/2 + aa)·mpp` vs FS `halfWm = (w/2)·mpp`) so the feather is never
  clipped; a separate early-discard rejects fragments beyond `max(halfW, patternExtent) +
  2·aa` (`line.ts:588-592`).

## 5. Width model

Width is authored in CSS pixels, realized as meters in tile-local Mercator, then corrected
in clip space. The only conversion is `mpp` (meters per CSS pixel) with a **single
authority** — `camera.effectiveMpp` (`map/src/camera/camera.ts:877-889`) — which caps the
raw `WORLD_MERC/512/2^zoom` by the frozen view height at low zoom. The #739 bug: a consumer
using the raw `2^-zoom` mpp kept scaling widths while the projection matrix had saturated;
and the fix's globe branch was left raw under an `UNVERIFIED` comment for a whole release —
gate: `map/src/render/vtr-line-mpp-effective.test.ts`.

Extrusion is **world-space** (along the segment normal in tile-local Mercator), then two
projection-dependent corrections, both of which *measure on-screen distance* rather than
trusting the matrix:

1. **Flat non-Mercator (#1246)** — the flat display MVP scales meters→pixels at the single
   Mercator `1/mpp` for every flat projType, so reprojection shrinks the across offset by
   the Mercator→projection Jacobian `J` (equirectangular N–S: `J = cos φ`) and a stroke
   collapses to `W·cos φ`. Fix (`line.ts:1321-1368`): project the base point and the
   across-offset point through the projection ladder *and* through Mercator passthrough,
   both via the same MVP; `widthScale = mercDist/projDist = 1/J`; widen **only the across
   component**. On Mercator the two probes are bit-equal ⇒ scale exactly 1 (no projType
   branch needed). The fragment frame (`world_local`) deliberately stays true-Mercator so
   the FS coverage isocontour lands exactly on the widened quad edge and the fragment
   shader is byte-unchanged.
2. **Globe / 3D perspective clamp** (`line.ts:1369-1403`) — project base and corner to NDC;
   `scale = clamp(targetNdc/screenDist, 1, 64)` where
   `targetNdc = (w + 2·aa)·dpr / viewport_height`. `·dpr` is its own paid-for fix (the
   viewport height is device px, the target CSS px — without it every stroke is `1/dpr`
   thin). Lower bound 1: the quad may only grow (shrinking clips coverage). Upper bound 64:
   post-#2089 the corner rides a tangent plane, and an unbounded scale walks it arbitrarily
   far at the limb where `screenDist → 0`. `viewport_height == 0` is the sentinel meaning
   "skip the clamp entirely" — used by the drape bake.

## 6. Dashes, patterns, gradients — everything rides one arc coordinate

Per-fragment arc position: `arcPos = arc_start + clamp(dot(p − p0, dir), 0, segLen)`.

- **Dashes** (`line.ts:800-857`): `phase = fract((arcPos + offset)/cycle)·cycle`, walk the
  ≤8-entry dash array (meters; converted CPU-side from Mapbox line-width units:
  `dash_m = dash · strokeWidthPx · mpp`), even index = ON, `discard` otherwise. A `notInCap`
  predicate keeps dashes from chopping caps. Because `arc_start` is a per-chain cumulative
  f64 computed in the tiler, phase advances continuously across joins regardless of vertex
  density; the documented caveat is that arc is measured along the *original* geometry, not
  the offset stroke's parallel curve (sub-pixel for typical offsets).
- **Procedural pattern stack** (`line.ts:886-943`): 3 uniform slots, each
  `{shapeId, flags(units+anchor), spacing, size, offset, start_offset}`; units m/px/km/nm.
  REPEAT anchors sample the nearest instance **plus both neighbours**
  (`kCenter = floor((arcPos − start)/spacing + 0.5)`, loop dk ∈ {−1,0,1}); START/END/CENTER
  anchor in polyline-arc space using `line_length` (this is *why* line_length is union-found
  per component). Each instance evaluates `sdf_shape` (a ≤32-segment path SDF with winding,
  shared with point symbols) in the instance's local frame, and the result is **unioned
  into the stroke SDF** (`dM = min(dM, patD)`), so patterns extend the stroke rather than
  mask it. The ±1-neighbour truncation is why `size > 2·spacing` warns.
- **Raster `line-pattern`** is a separate fragment entry with **world-anchored** UV
  (`fract(absMercator/repeat)` → atlas bbox), reusing uniform slots; mutually exclusive with
  `line-gradient`.
- **`line-gradient`** (#2117): evaluated analytically from ≤8 stops packed in the uniform —
  **no LUT texture** — because group(1) is per-tile while style rides a dynamic offset, so
  a per-layer ramp texture would need a bind group per (tile × layer). Progress reuses the
  same `arcPos`: `progress = clamp(arcPos / max(line_length, ε), 0, 1)`.

## 7. Extended precision (four live mechanisms)

See [`02-coordinates-precision.md`](./02-coordinates-precision.md) for the theory; the line
path's concrete mechanisms:

1. **DSFUN camera-relative cancellation** (`line-endpoint.ts:25-32`):
   `mercRel = (p_h − cam_h) + (p_l − cam_l)` — the ~1.4e7 m magnitude cancels *inside* the
   split arithmetic before f32 ever sees a large number.
2. **`finalize_corner` recentring (#598)** (`line-corner.ts:32-59`): for flat non-Mercator,
   feed the projection a camera-relative `dLon` and recenter the projection onto `clon = 0`
   — exact in real arithmetic because the projection depends only on `(lon − clon)`. The
   bug it fixed: the shader rebuilt an **absolute longitude in f32 degrees** (ULP ≈ 1.7 m
   at 127°) and the projection then subtracted the camera back out — catastrophic
   cancellation; strokes visibly shook at high zoom. Gate: a **closed-form error budget
   test** vs an f64 CPU mirror, no GPU (`line-finalize-corner-precision.test.ts`).
3. **CPU-f64 ECEF endpoint lanes (#2089)** for the globe. The pre-#2089 arm re-derived ECEF
   in-shader via f32 `atan(exp())` on absolute Mercator; the documented budget
   (`line.ts:1172-1177`): the f32 chain's angle error δφ (~1.6e-7 rad; up to ~8e-5 on
   SwiftShader) was multiplied by the **Earth radius** (→ up to ~512 m); the new form
   multiplies the same δφ only by `|offset|`. *"That change of multiplicand, not any change
   of formula, is the whole migration."* Measured end-to-end on SwiftShader: **1.17e3 m
   before → 2.1e-1 m after**. The CPU packs f64 geodetic→ECEF minus
   `tileEcefCenterFromMerc(tileOrigin)` as hi/lo lanes; the shader recombines `h + l` and
   rotates the local Mercator offset through the ENU basis. Residual budget is documented
   honestly: recombination is f32 (~1 m at z2, ~0.15 mm at z14) — *and the polygon fill
   does the identical `pos_h + pos_l`, so fill and stroke carry the identical residual and
   stay registered*. Crucially the anchor function is imported **from `@xgis/compiler`, not
   the same-named `@xgis/shared` helper** — the shared twin resolves constants through the
   active planetary body, and mixing the two would compute anchor and endpoints on
   different bodies, breaking fill↔stroke single-authority (`line-segment-build.ts:7-15`).
4. **Flat-Mercator hi/lo recombination (#2042)** — one shared authority with polygon
   (`merc-cam-rel.ts:52-63`): `hi−hi` (Sterbenz-exact near the camera) and `lo−lo`
   (recovers the bits a single-f32 tile origin lost), flag-selected.

## 8. Depth, order, translucency

- Pipeline state: `depthWrite: false, depthCompare: 'less-equal'`, alpha blend; a pick
  target with `writeMask: 0` (a line pick write of `(0,0)` once clobbered the fill's pick
  id — #1215).
- Fragment writes `@builtin(frag_depth)` from **logarithmic depth** minus two biases
  (`line.ts:1487-1514`):
  - `LINE_COPLANAR_DEPTH_BIAS = 1e-5` — the polygon fill adds a per-feature depth jitter of
    up to ±7.68e-6 (shared-wall z-fight fix), so a coplanar stroke drawn after it *ties*
    under less-equal and survival becomes driver float luck (real symptom: half of every
    coastline dash vanished on SwiftShader GLES; a parity gate's IoU fell 0.958 → 0.34).
  - `LINE_LOD_DEPTH_STEP = 3e-6` scaled by `log(EARTH_R / tile_extent_m)` — line depth
    comes from `view_w`, so two tiles at different zooms covering one pixel emit the same
    depth and less-equal keeps **both** LOD outlines stacked (#1140); the extent term pulls
    the finer tile nearer.
- **Translucent strokes draw into an offscreen MAX-blend target** (rgba8, no depth), then
  composite with a fullscreen triangle that premultiplies and applies layer opacity once.
  This is what kills double-darkening at self-intersections and corner overlaps: within a
  layer, overlap reduces to one max-coverage value per pixel. Each composite takes a fresh
  256 B uniform ring slot because WebGPU applies all `writeBuffer`s before any draw — a
  shared slot would make every composite read the *last* layer's opacity
  (`line-renderer.ts:230-241`).
- **Globe drape**: at coarse zoom, strokes are baked into the same offscreen tile texture
  as the fill (reusing the screen line pipeline through a single-sample 'bake' material
  with `depthCompare:'always'`, flat-Mercator VS arm selected by `proj_params.x=0`,
  `viewport_height=0` to skip the screen clamp) and draped on the sphere grid; widths
  compensate per zoom bucket by `2^(tileZ − camZoom)` (#1222).
- **Extruded layers draw no outline at all** (MapLibre fill-extrusion semantics) — a
  ground-height stroke with no depth interaction composites *across* raised geometry;
  instead `z_lift_m` puts polygon outlines on their building roof per feature, and its
  fallback must match the wall mesh's, or the wall occludes its own roof outline.

## 9. The fill↔stroke agreement contract

The repo's stated dominant bug archetype: two sibling paths that must agree, drifting.
Five mechanisms enforce fill/outline agreement:

1. **A byte-mirrored uniform block.** The renderer binds ONE group(0) buffer written with
   polygon's `Uniforms` layout and read as line's `TileUniforms`; line declares `_pad_*`
   placeholders at every polygon field it doesn't use so shared fields land at identical
   std140 offsets. Gate: `polygon-line-uniform-parity.test.ts` reflects **both** emitted
   structs and asserts every shared-by-name field offset and the total size (#998 — the
   prior guard was hardcoded offset literals, which would pass while a polygon-side change
   silently corrupted every line draw).
2. **Shared DSL functions, one authority per formula**: the projection ladder
   (`projections.ts`), the Mercator camera-relative pair (`merc-cam-rel.ts`), log depth
   (`log-depth.ts`), the ECEF anchor (`tileEcefCenterFromMerc`).
3. **Identical geometry source**: outlines and lines share `augmentChainWithArc`, the same
   vertex pack, the same `buildLineSegments`; `extractNonSyntheticArcs` drops the
   axis-aligned edges the clipper synthesized so the outline never strokes a tile edge.
4. **Identical fragment cull**: a test pins that line and polygon produce bit-identical
   backface-cull signals (else strokes leak on the globe's far side while fills discard).
5. **`fill-translate` propagation**: an outline drawn through the line pipeline applies the
   same post-MVP NDC translate the polygon VS does.

The canonical failure (blog `2026-07-11-the-precision-fix-that-opened-a-seam.md`): a commit
made the *outline's* longitude projection precise and left the fill's identical projection
alone. Both had been wrong **together** and moved as one; afterwards, at Seoul longitude
they parted by ~0.4 m ≈ 3 px at z20 — a seam manufactured by a correctness fix. *"A
precision fix is a change to arithmetic. Land it on one sibling only and you have
manufactured a divergence out of a fix."* Corollary: you cannot tell which sibling is
correct from the bug report — only from what each emits (the fill turned out to be the less
precise one).

## 10. Bug ledger (compressed)

| Cause → fix | Lesson |
|---|---|
| miter test used `sin(θ/2)` (#432) | derive limit math from `\|A+B\| = 2cos(θ/2)`, gate with fail-before on both a sharp and a shallow corner |
| pad used bisector length (`1/sin`) | the quad extends along the segment ⇒ pad = `\|tan(θ/2)\|` |
| 180° reversal extended the quad (#463) | degenerate cases return "bevel", never "worst case" |
| fixed 0.5 CSS px AA band (#606) | feather in device px: `0.5/dpr` |
| CSS target ÷ device viewport | every stroke 1/dpr thin — unit-check every screen-space formula |
| raw `2^-zoom` mpp (#739) | one mpp authority incl. the low-zoom cap; an `UNVERIFIED` comment is a bug, not a note |
| flat non-Mercator width `W·cosφ` (#1246) | measure the Jacobian on-screen via two probes through the same MVP |
| absolute f32 longitude rebuilt in-shader (#598) | subtract first; prove with a closed-form error budget |
| in-shader `atan(exp())` ECEF (#2053/#2025) | multiply the angle error by `\|offset\|`, not the Earth radius: CPU-f64 lanes |
| precision fix on one sibling (seam blog) | fix both siblings or neither |
| antimeridian wrap vertices clamped to ±180 (#1221) | a pixel-count gate passed on the broken image; only a contiguous-run **structure** gate separates a wall from a line |
| branch-cut segment projecting 2πR wide (#1496) | camera-tracked cuts can't be pre-split; degenerate the quad in-shader when `\|Δx\| > πR` |
| independently MVT-quantized abutting tiles (#1245) | extend boundary-continuation endpoints outward by one quantum so pieces overlap (safe under MAX blend) |
| "real endpoint" marker fired on every clipped arc (#1223) | boundary position is a stronger signal than the marker; suppress caps on the tile boundary |
| stroke depth tied fill's jittered depth | coplanar bias `1e-5` above the jitter amplitude |
| equal depth across LODs (#1140) | LOD step scaled by tile extent |
| RHI port hardcoded `dash = null` (#834) | cross-backend behavior ratios (continuous/dashed mask ≈ 3/2) catch a silently-dropped feature |
| GLSL twin got `variant = null` (#1605) | compose the same variant into both source languages; guard variant-carrying ids out of the baked cache |
| dense vertices → extreme bisectors + overdraw | simplify at the tiler (Douglas-Peucker), don't patch in the runtime |

## 11. Transferable design rules

1. **Conservative instanced quads + fragment SDF** beats CPU join tessellation for a
   GPU-first engine: zero per-vertex join code, every join/cap/dash/pattern is a distance
   operation, and quality is resolution-independent. Size the quad generously (build-time
   miter limit > runtime limit); overdraw is the cheap failure mode.
- 2. **Vertex pulling from a storage buffer** (quad corners from `vertex_index`, segment
   data from `instance_index`) removes vertex buffers entirely; on a GL backend, emulate
   the storage buffer as a data texture behind the same interface.
3. **Put all stroke math in one frame** (tile-local world units) and convert to pixels via
   a single mpp authority; correct projection-dependent width by *measuring* screen-space
   distances through the real MVP, not by special-casing projections.
4. **One arc coordinate funds dashes, patterns, and gradients.** Compute cumulative arc in
   f64 at tile build; anchor patterns in arc space; union pattern SDFs into the stroke SDF.
5. **AA half-band = 0.5 device px** (`0.5/dpr` CSS); clamp geometric width at 1 px and pay
   the remainder in alpha.
6. **Every sibling pair needs a shared authority or a parity gate** — shared uniform layout
   (reflected, not hardcoded), shared projection functions, shared geometry source, shared
   cull. Never land a precision change on one sibling.
7. **Depth ties are a design smell**: if two things can legitimately emit the same depth
   (stroke-on-fill, cross-LOD outlines), bias explicitly and document the amplitude that
   forced it.
8. **MAX-blend offscreen + single composite** is the clean answer to translucent stroke
   self-overlap.

## 12. Code map

- Shader: `map/src/shaders/dsl/line.ts`, `line-endpoint.ts`, `line-corner.ts`,
  `line-gradient.ts`, `line-composite.ts`; shared math `projections.ts`, `merc-cam-rel.ts`,
  `log-depth.ts`, `sdf.ts`
- CPU packer: `data/src/line-segment-build.ts`; chain/arc: `compiler/src/tiler/vector-tiler.ts`
  (`augmentChainWithArc`, `extractNonSyntheticArcs`)
- Renderer/material: `map/src/render/line-renderer.ts`, `material/line-material.ts`,
  `line-pattern.ts`; drape: `vector-drape-stroke.ts`
- Gates: unit tests listed in §10's files; e2e `playground/e2e/_1246-projection-width-gate`,
  `_1221-seam-control-matrix`, `_line-ecef-lane-parity`, `_dash-parity`,
  `_1222-drape-stroke-zoom-width`, `_fill-antialias-outline-gate`, `_line-regressions`, etc.
