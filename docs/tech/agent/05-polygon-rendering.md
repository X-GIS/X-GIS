# 05 — Polygon rendering: fills, outlines, patterns, extrusion

> Edition: **agent**. Companion: [`../dev/05-polygon-rendering.md`](../dev/05-polygon-rendering.md).
> Authority files: `compiler/src/tiler/` (clip/tessellate/pack),
> `map/src/shaders/dsl/polygon.ts` (~1,570 LOC shader authority),
> `map/src/render/vector-tile-renderer.ts`, `map/src/core/polygon-mesh.ts` (extrusion).

## 1. CPU pipeline per tile (order is load-bearing)

```
clipPolygonToRect (Sutherland-Hodgman, MM)
→ self-overlap probe (earcut coverage-ratio test)
→ [splitBoundaryBacktracks + hole re-bucketing]   (only when the probe fires)
→ tessellatePolygonToArrays (earcut + conforming red-green subdivision)
→ outline arcs from THE SAME clipped rings
```

- **Tessellation is earcut** (flat-array contract: `rings[0]` outer, rest holes via
  `holeIndices`), run **off the main thread** in the MVT/GeoJSON workers, results
  transferred as ArrayBuffers.
- **Self-overlap detection is a coverage-ratio test, not topology**: probe-earcut the
  clipped rings, sum |cross|/2 triangle areas, compare with the shoelace area; ratio > 1.2
  ⇒ the clipper produced backtracking outers that need splitting (Korea z7 canonical
  broken case measured 2.57×, clean control 1.00×).
- **Disjoint pieces are emitted as separate polygons, each with its own point-in-polygon
  hole bucketing** (#1079). Flattening N outers into one ring list makes any consumer that
  assumes "outer + holes" earcut-punch pieces 2..N out of piece 1's roof — "n pieces render
  n−1 roofs" (`the-roof-that-became-a-hole` postmortem: 2D fill pixel-perfect throughout;
  zero tests had ever fed the consumer more than one polygon).
- **Clipping**: 4-pass Sutherland-Hodgman half-planes (a 2-pass geojson-vt-style variant
  exists behind a flag). Boundary intersections are **snapped to a per-zoom grid** so
  adjacent tiles produce bit-identical shared vertices, and the perpendicular coordinate is
  additionally clamped into the segment's own span (snapping could round it past the rect
  corner, producing a spurious boundary stroke). Grid: ~100 m at z≤2 down to 0.1 m past z7.
- **The FILL IS NEVER SIMPLIFIED.** Douglas-Peucker runs only as a _probe_ whose output is
  discarded (it feeds the adaptive-subdivision heuristic). Recorded reason: a simplified
  fill diverged from its own stroke by up to the tolerance, and `simplify∘clip ≠
clip∘simplify` so the outline can't be repaired to match. LINE features are simplified,
  with tile-boundary vertices locked so adjacent tiles share edge geometry.
- **Vertex dedup key is a string at 1 mm quantization** — deliberately not a packed int
  (the packed-int key overflowed after the pipeline moved to Mercator meters and produced
  ocean-spanning wedge triangles).

### Conforming subdivision (curvature without T-junctions)

Globe/non-Mercator surfaces need curved interiors. Each earcut triangle is red-green
refined with the split decision made **per edge, not per triangle** — so two triangles
sharing an edge always agree and no T-junction can open a crack:

```
edge splits ⟺ not (|Δx|<50km ∧ |Δy|<50km)  ∧  max(|Δlon|,|Δlat|) > 2°
3 marked edges → red 4-split; 2 → 3 tris; 1 → bisect; depth cap 5
```

Split points are **linear MM midpoints** (`(ax+bx)·0.5` — commutative in IEEE-754, so both
owners dedup to the same vertex). Geodesic (slerp) midpoints were tried and **reverted**
(z=0 banding). Outlines get the same per-edge gate (`subdivideChainMM`) so the stroke
follows the fill's curve, and because midpoints are collinear with the parent segment the
fill/outline coincidence invariant survives subdivision.

## 2. Vertex format (single source of truth)

`POLYGON_FILL_FORMAT`, stride 28 B, declared once as a field list from which the packer
bytes, the WGSL `@location`s, and the host `GPUVertexBufferLayout` are all **computed**:

```
loc0 q_xy u16×4       quantized ECEF-RTC x,y (hi/lo)
loc1 q_z  u16×2       quantized ECEF-RTC z
loc2 feature_id f32
loc3 abs_lon  f32     → actually TILE-LOCAL Mercator x
loc4 abs_lat  f32     → actually TILE-LOCAL Mercator y
loc5 true_lat f32     unclamped degrees (polar caps)
```

The extruded variant (stride 56 B) adds `face_normal vec3, wall_height, is_top, wall_base,
local_merc vec2`. History carried in the comments: loc3/4 used to hold **absolute degrees**
(f32 ULP at 127° ≈ 1.35 m → ~10 px fill/stroke split at deep overzoom); they now hold
tile-local Mercator, magnitude ≤ tile extent, sub-mm at every zoom — exactly mirroring the
line VS frame. See [`02-coordinates-precision.md`](./02-coordinates-precision.md) for the
quantization and the camera-relative ladder (shared with lines).

## 3. Fill fragment path

One shader module, 3 vertex entries (flat / ecef / ecef-extruded) and 6 fragment entries
(fill, fill_pattern, oit_translucent, fill_extrude, stroke, overdraw). `fs_fill` in order:

1. Three discards: hemisphere cull (`cos_c` **recomputed per fragment** from varyings —
   linear interpolation of a `cos_c` varying diverges across a triangle spanning the
   visibility boundary); Mercator-limit latitude with a +0.5° margin (a bare comparison
   flips per MSAA sample at the pole fan → speckle); `clip_bounds` parent-fallback bbox
   mask (sentinel −1e30 = off).
2. Wall shading factor.
3. **The composer placeholder `'fill-return'`** — swapped per style variant (see §7 of
   [`03-shader-dsl.md`](./03-shader-dsl.md)); default emits
   `out.color = vec4((u.fill_color.rgb * wall_shade), u.fill_color.a)`.
4. Rim-alpha (sphere limb fade), gated by a spare uniform lane that doubles as the
   `fill-antialias` flag.
5. Pick write `vec2u(feat_id, pick_id)` (channel order is load-bearing — swapping them made
   every pick return null).
6. Log depth **plus a per-feature deterministic depth jitter**
   (`jitter = (hash(feat_id) − 512)·1.5e-8`) to break coplanar shared-wall z-fights.

**Per-feature styling reaches the shader through four tiers**, chosen by expression
classification (see [`08-content-subsystems.md`](./08-content-subsystems.md) §3):
CPU-resolved uniform; a `feat_data: array<f32>` storage buffer (`feat_data[fid·stride+j]`,
indexed by the vertex `feature_id`); palette/scalar atlas textures for zoom-interpolated
scalars; and compute-kernel outputs (`array<u32>`, `unpack4x8unorm(compute_out[fid])`).
Categorical values map through `stableCategoryId` — FNV-1a masked to **23 bits** so the id
round-trips exactly through an f32 slot and is a pure function of the value (a per-tile
alphabetical rank once made a categorical fill change color across zoom/pan).

## 4. Outlines: a real stroke pass over the same rings

The outline is not a shader edge effect — it is the SDF line renderer drawing chains
derived from **the identical clipped ring set the fill tessellates**, with the clipper's
synthetic axis-aligned closure edges stripped (`extractNonSyntheticArcs`) so internal tile
boundaries never stroke. Deferred into a stroke queue **after all fills** so a later tile's
fill can't cover an earlier tile's outline.

Agreement is enforced four ways (beyond the shared clip space):

- the compiler-level alignment test: extract fill _boundary_ edges (triangle edges
  appearing in exactly one triangle — interior edges appear twice and cancel) and assert
  every outline endpoint lies within 1 m of one, across four zooms;
- an encoding-coincidence fuzz: fill (quantized ECEF) and outline (Mercator DSFUN) are
  packed by different kernels — decode both back to lon/lat and assert < 0.25 px at z19.4
  (its docstring records that an earlier "refuted" version probed near the tile origin
  where the f32 grain is small — probe where the error is largest);
- the shared uniform-layout parity test (one buffer, two struct views — §9 of
  [`04-line-rendering.md`](./04-line-rendering.md));
- the same ECEF anchor + forward math imported from the same module.

Stroke-over-fill z-fighting is solved by fragment depth biases (coplanar bias above the
fill's jitter amplitude + a per-LOD step), not geometry offsets.

`fill-antialias: false` reproduces MapLibre semantics: MapLibre's only fill-edge AA _is_
its 1 px outline pass, so X-GIS skips synthesizing the outline at convert time and disables
the rim fade via the flag lane.

## 5. Coverage, seams, AA, translucency

- **Edge AA is MSAA** (4× default, 2×/1× quality presets), not shader feather — the only
  fill-alpha smoothstep is the sphere rim fade. Feathered AA lives in strokes and point
  SDFs (where it is `fwidth`-based because SDF distance has AABB discontinuities).
- **No cracks between adjacent polygons by construction**: within a tile, 1 mm-quantized
  dedup makes coincident ring vertices the same index and subdivision is conforming;
  between tiles, boundary snap yields bit-identical shared vertices.
- **Parent/child coverage is stencil-based, not clip-based**: primary tiles draw with
  STENCIL_WRITE (always-pass, replace); parent-fallback tiles draw with STENCIL_TEST
  (equal, writeMask 0) so a coarse parent paints only where no child covered. The
  fallback path additionally carries a per-draw `clip_bounds` fragment mask — with a
  recorded dedup bug: four visible z3 tiles sharing one z2 parent were deduped into a
  single dispatch keyed only on (parent, worldCopy), so only the first dispatch's bounds
  let fragments through and Korea filled nothing while its stroke (no per-tile clip on the
  line path) still drew.
- **Ground (non-extruded) fills draw with depth OFF** (`depthCompare:'always'`,
  no depth write): coplanar z=0 layers are ordered by submission (water → landuse → roads),
  which is what makes the result pitch-independent — depth-bias ordering of coplanar fills
  produced the "lake hidden under landuse at pitch" class.
- **`fullCover` tiles keep their real ~4-vertex covering rect** rather than letting the
  client synthesize a quad — a synthesized quad never got the per-feature data, so
  data-driven fills rendered black over large interiors.
- **Translucent fills use Weighted-Blended OIT** (McGuire-Bavoil):
  `w = clamp(0.03/(1e-5 + (z/200)^4), 1e-2, 3e3)`, accum + revealage targets, composited
  after the opaque bucket.

## 6. Pattern fills

All fill patterns are sprite-atlas samples (no procedural hatch in the polygon path — the
procedural SDF pattern stack lives on strokes). The whole algorithm:

```wgsl
uv_local = vec2(fract(abs_merc.x / repeat_x), fract(abs_merc.y / repeat_y));
atlas_uv = mix(uv0, uv1, uv_local);          // bbox from the sprite atlas
out.color = vec4(sampled.rgb, sampled.a * opacity) * rim;
```

Pattern coordinates are **absolute Mercator meters — world-anchored** — which is why
patterns don't swim under pan/zoom and tile continuously across tile boundaries (the
varyings telescope exactly under interpolation). The repeat period is computed per frame
from camera zoom so an N-CSS-px sprite repeats every N CSS px on screen. Uniform slots are
**reused** (`fill_color` becomes the UV bbox; `fill_translate` becomes the repeat), guarded
by a `pattern_active` flag in the VS — without the guard, the repurposed translate slots
(hundreds of thousands of meters) were applied as an NDC offset and flung every vertex
off-screen. Consequence, documented: a pattern layer cannot also use fill-translate or a
solid color. One pack authority function is shared by the WebGPU and WebGL2 paths so the
twins cannot drift. `background-pattern` rides the same path via the synthetic
earth-surface show, giving world-anchored semantics on flat and globe alike.

## 7. Variants (data-driven styles)

The compiler generates a `ShaderVariant` per distinct style shape; the polygon module
swaps its three placeholders (`fill-return`, `stroke-return`, `fill-extrude-return`) with
variant expression trees via `composeModule` (IR composition, not string splicing; errors
on un-swapped/typo'd tags). Variant **identity** is the compiled key:
`fill kind × stroke kind × opacity kind × feature-field set × match-arm structure ×
expression body` — the arm-structure and body hashes exist because two compounds over the
same field produced identical coarse keys with different bodies (roads rendered with
landuse colors). Each key materializes ≥8 GPU pipelines (fill / ground / line ×
primary / fallback, extruded, no-pick mirrors), cached by key.

Emit stability is pinned by an 8-fixture **byte-equal** snapshot gate
(`__polygon-variant-snapshots__/`), fixtures chosen at behavior boundaries (10-arm and
13-arm match, zoom-interp, feat-data, palette). Engineering detail worth copying: the
snapshot's baseline-ancestry check is skipped on shallow clones — at `--depth 50` the
baseline commit _exists_ but `merge-base --is-ancestor` cleanly answers "no," which would
have instructed the reader to destructively re-capture 8 correct baselines.

A derived split-uniform module (`polygon-split.ts`) rewrites every `u.<field>` read to the
frame/show/tile block partition — and **throws at build time naming any field with no
destination**: a partition gap must fail the emit, not render zeros.

## 8. Extrusion (3D buildings)

`generateWallMeshExtrudedECEF`: one roof earcut per ring set at top height; wall quads per
ring edge; all pre-lifted in ECEF along local Up, quantized against the **same** tile ECEF
anchor as the flat fill (so the camera-relative recentring applies unchanged — an earlier
extruded-only path skipped the RTC offset and collapsed every extruded tile onto the
camera's tile at pitch). Lighting: per-vertex `face_normal` in the ENU→ECEF frame, light
direction packed CPU-side by rotating MapLibre's viewport-frame light through the camera
ENU basis (dotting the raw viewport light against ECEF normals gave arbitrary per-face
brightness). Data-driven extrusion fills sample the base color in the fragment and replay
MapLibre's lighting against interpolated geometric factors. Flat-projection arms synthesize
plane-z as `wall_base + (h−base)·is_top`, divided by `cos(lat)` on Mercator (MapLibre's
`mercatorZfromAltitude`; without it walls render cos(lat)× short). Extruded layers draw
no outlines (see [`04-line-rendering.md`](./04-line-rendering.md) §8).

## 9. Globe arms

- **Direct ECEF (default, and the only arm at fine zoom)**: curvature comes from
  tessellation-time subdivision; the VS is one linear transform. Fragment adds horizon
  cull (`dot(normalize(P), eyeN) > horizonCos` from the shared `eyeHorizon` authority) and
  rim fade. Polar caps project from the **unclamped** `true_lat` so ±90° reaches the pole.
- **Vector drape (coarse zoom)**: bake the tile's fill+strokes into a 512² offscreen
  texture and drape it with the proven raster sphere path — no second sphere shader;
  fidelity inherited from raster. Handed back to the direct arm past the zoom where the
  bake's blur exceeds chord sagitta. Kill-switch globals exist for A/B sever-arm gates.

## 10. Transferable design rules

1. **Clip once, in one space, and derive both fill and outline from the same clipped
   rings.** Never simplify the fill; if you simplify lines, lock boundary vertices.
2. **Never let a clipper's synthetic edges reach the outline**, and snap boundary
   intersections to a shared grid so adjacent tiles agree bit-for-bit.
3. **Emit split polygon pieces as separate polygons with re-bucketed holes** — "outer +
   holes" is a per-polygon contract, not a per-feature one; feed consumers multi-piece
   fixtures in tests.
4. **Make subdivision decisions per edge** (with commutative midpoints) and conformity is
   free; cap depth symmetrically.
5. **One vertex-format declaration; compute packer offsets, shader locations, and pipeline
   layouts from it.**
6. **Order coplanar ground layers by submission with depth off**; reserve depth for
   genuinely 3D content; stencil (not clipping) for parent/child tile coverage — but key
   per-draw masks by the _visible_ tile, not the fallback ancestor.
7. **World-anchor pattern UVs in world units** — screen- or tile-anchored patterns swim or
   seam.
8. **Data-driven style variants are IR composition with derived identity keys**, pinned by
   byte-equal snapshots at behavior boundaries.
9. **Extrude in the same anchor frame as the flat fill** and rotate lights into that frame;
   a second frame for the "3D version" of a feature is a standing divergence bug.
10. **Reuse the proven path for the hard case** (drape via the raster sphere pipeline)
    instead of writing a second projector, and define the crossover analytically (bake blur
    vs chord sagitta).

## 11. Code map

- Tiler: `compiler/src/tiler/{polygon-tiler,vector-tiler,clip,simplify,
subdivide-conforming,ecef-packing,polygon-vertex-format,encoding}.ts`
- Shader: `map/src/shaders/dsl/polygon.ts`, `polygon-split.ts`, `_polygon-fixtures.ts`,
  `__polygon-variant-snapshots__/`
- Renderer: `map/src/render/vector-tile-renderer.ts`, `material/polygon-fill-material.ts`,
  `feature-data-pack.ts`, `feature-data-binder.ts`; extrusion `map/src/core/polygon-mesh.ts`;
  drape `map/src/render/vector-drape-renderer.ts`
- Gates: `compiler/src/polygon-fill-vs-stroke-alignment.test.ts`,
  `compiler/src/tiler/fill-outline-coincidence-fuzz.test.ts`,
  `map/src/shaders/dsl/polygon-variant-diff.test.ts`, e2e `_polygon-fill-flat-pixel-gate`,
  `_fill-antialias-outline-gate`, `_korea-fill-regression`, `_pixel-match-school-fill`,
  `_fills-gl2-gate`, `_translucent-outline-parity`
