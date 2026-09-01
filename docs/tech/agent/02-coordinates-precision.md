# 02 — Coordinates & precision: sub-pixel correctness on an f32 GPU

> Edition: **agent**. Companion: [`../dev/02-coordinates-precision.md`](../dev/02-coordinates-precision.md).
> Contract document: `docs/COORDINATES.md`. Error-budget method:
> `.claude/skills/render-error-budget/SKILL.md` + `map/src/camera/coordinate-error-budget.test.ts`.

## 1. The four spaces and the one-way rule

| Code | Space | Units | Used for |
|---|---|---|---|
| **LL** | WGS84 lon/lat | degrees | source data, bbox-reject, area |
| **MM** | Web Mercator EPSG:3857 | meters | ALL tiler clip/simplify/tessellate, arc length, DSFUN origin |
| **DLM** | tile-local Mercator, split f32 hi/lo | meters | vertex output format |
| **SP** | screen/NDC | px/clip | camera projection only |

Rules (`docs/COORDINATES.md`):
- **Project once at load (LL→MM), never invert inside the compile pipeline** (one documented
  exception). Tile origins are derived from LL bounds via `lonLatToMercF64`, never inverted.
- **Sibling paths clip/simplify in the SAME space.** The pre-unification split (polygon
  clipped in LL, stroke in MM) produced **27 km** of fill/stroke divergence at z=8 boundary
  tiles. The checklist for any new clip/simplify step ends with: "does the SIBLING path use
  the same space? Add a cross-path invariant test."
- DSFUN reconstruction is exact: `h + l` recovers the original f64 within 1 µm in MM.

## 2. The error budget — write it before the shader

Closed form (executable as a vitest file, no GPU):

```
ULP_F32    = 2^-23
pxPerM(z)  = TILE_PX · 2^z / (2π·R)          TILE_PX = 512, R = 6378137
boundPx(z) = dominantM · 2^-23 · pxPerM(z)
```

`dominantM` = the largest intermediate magnitude the path stores in f32. The whole
architecture falls out of this table:

| Frame | dominantM | error floor | crosses 0.5 px at | @ z20.55 |
|---|---|---|---|---|
| absolute Mercator meters (or degrees→reproject) | ~1.41e7 (Seoul) | 1.68 m | **z ≈ 14.5** | 33 px analytic / 56.7 px measured |
| absolute ECEF meters | 6.38e6 | 0.76 m | z ≈ 15.6 | ~15 px |
| **tile-local Mercator** | ≤ tile extent = 2πR/2^z | zoom-cancelling | **never** | 6.1e-5 px, constant |
| **DSFUN hi/lo** | residual after hi | ~1e-8 m | never | ≪ 0.5 px |

The tile-local line is the key algebraic fact:
`boundPx = (2πR/2^z)·2^-23·(512·2^z/2πR) = 512·2^-23 ≈ 6e-5 px` — **the zoom cancels
exactly**. Choose a frame whose magnitude scales *with* the pixel scale and the linear term
never needs f64 on the GPU. (The measured/analytic 1.7× gap has a named second term: the
truncated shader constant `DEG2RAD_F32` carries ~1.4e-7 relative error — same order as one
ULP, so it must be budgeted too.)

**Jitter is a separate budget.** A stationary vertex *shakes* when the camera anchor is a
single f32: at |mercator| ≈ 6.1e6, one ULP is 0.73 m, and panning walks the rounding across
the f32 grid frame-to-frame. Gates assert: old single-f32 anchor > 1 px shake at z18+; the
shipped DSFUN hi/lo anchor < 0.05 px at every zoom (ratio > 100×). The same budget is run
for the flat non-Mercator `clon` (a single-f32 central longitude at 127° has ULP ≈ 1.7 m —
the whole tile sheet shook) and for the globe/ECEF arm.

## 3. Three nested RTC subtractions (all f64, all CPU)

```
GeoJSON LL →(project once)→ MM
MM →(inverse Mercator, f64)→ lon/lat →(WGS84 N-formula)→ absolute ECEF (~6.4e6 m)
① ECEF − ecefTileCenter            → tile-local residual        (tiler, f64)
② quantize residual                → 2×u16 per axis             (pack)
③ (tileCenter − cameraCenter)      → per-tile RTC offset, hi/lo (per frame, f64)
GPU: dequant + offset_h + offset_l → camera-relative ECEF → clip = mvp · pos
```

- **① Anchor**: `tileEcefCenterFromMerc(tileMx, tileMy)` — WGS84 **ellipsoid** ECEF of the
  tile origin. Vertices are `N·cosφ·cosλ − ax` etc. with
  `N = a/√(1−e²sin²φ)` (`compiler/src/tiler/ecef-packing.ts:214-301`).
- **② Quantization instead of a second float** (`shared/src/quantize.ts`): per tile,
  `halfRange = max|residual| + 1e-6`, `q = round((axis + halfRange)·(0xFFFFFFFF/2·halfRange))`,
  stored as u16 hi/lo. Step size: **0.57 µm** at a z14 tile; ~3 mm even at world scale.
  Round-trip gate: ≤1 mm arc-length error at z22 (`ecef-precision-fuzz.test.ts`).
- **③ Camera offset ships as DSFUN hi/lo** (`map/src/render/tile-camera-anchor.ts`, the
  single authority for four callers): both terms computed on the **same ellipsoid**, split
  by `hi = fround(x); lo = fround(x − hi)`. The Mercator twin is
  `camRel = camMercX − tileMercX` in f64, split the same way.

In-shader recombination error anatomy (`rtc-recombine-precision.test.ts`): `hi−hi` is a
correctly-rounded subtract of exact f32s, bounded by `|off|·2^-25` — and **Sterbenz-exact
when the camera is near the tile**; `lo−lo` ≤ ~2.4e-8 m; split residue ≤ ~1e-8 m per
anchor. Whole-domain bound ≤ 1e-3 px; measured worst case 2.3e-4 px.

**The GPU vertex ladder** (`map/src/shaders/dsl/polygon.ts:370-549`) has three arms on
`proj_params.x`: flat Mercator (`rel = local_merc − cam_h − cam_l`, straight into the MVP);
flat non-Mercator (compute a camera-relative `dLon`, re-center the projection onto
`clon = 0` — exact because the projection depends only on `lon − clon`); and 3D/ECEF
(`ecef_cam = ecef_rtc + rtc_off_h + rtc_off_l`). The Mercator hi/lo pair comes from one
shared helper (`merc-cam-rel.ts`) used by polygon and line alike: *"hi−hi is
Sterbenz-exact when the camera is near the tile, and lo−lo recovers the low bits the
single-f32 tile origin lost."*

## 4. df64: emulated doubles as a compiler-adversarial technique

Representation (`shader-dsl/src/core/fp64/df64-lib.ts`): an f64 value is an unevaluated
`(hi, lo)` pair in a `vec2<f32>` with `|lo| ≤ ulp(hi)/2` — **~48 significand bits** at f32
exponent range. Lineage: DSFUN90 → CUDA dsadd/dsmul → Thall → luma.gl.

Host split: `hi = Math.fround(x); lo = Math.fround(x − hi)`.

The error-free transformations (verbatim shapes):

```
twoSum(a,b):       s = a+b; v = s−a; e = (a−(s−v)) + (b−v)          // Knuth, no precondition
quickTwoSum(a,b):  s = a+b; e = b−(s−a)                              // Dekker, |a|≥|b|
split(a):          t = a·4097; hi = t−(t−a); lo = a−hi               // Veltkamp, 4097 = 2^12+1
twoProd(a,b):      p = a·b; e = aHi·bHi−p + aHi·bLo + aLo·bHi + aLo·bLo
```

**The whole battle is keeping compilers from folding these away.** `e = b−(s−a)` is zero in
real arithmetic; WGSL §15.7.5 permits reassociation, Metal defaults to fast-math, ANGLE's
D3D compiler reassociates — and neither WGSL nor GLSL ES 3.00 has `precise`. X-GIS's
defense stack, each layer paid for by a specific device failure:

1. **A runtime-opaque `ONE` multiplied through every EFT intermediate — fetched from a 1×1
   TEXTURE, never a uniform.** Drivers specialize pipelines on observed uniform values and
   hot-swap re-optimized variants mid-session (seen in the field: the fp64 half of a demo
   alternated with an f32-collapsed rendering under byte-identical input). No driver
   constant-folds texel values. FMA-based twoProd is deliberately not used (WGSL `fma`
   accuracy is "inherited from x*y+z" — fusion not guaranteed).
2. **Per-cross-term renormalization in `df64_mul`** (not one renorm at the end as textbook
   QD): threading `one` through the cross terms does NOT help because the compiler factors
   `a` out of `a·b_hi + a·b_lo`, rounding `b_hi + b_lo` back to `b_hi` — the guard must sit
   *outside* the distributable form. (Blog: "add held, mul collapsed" — on Apple, add read
   0.5 and mul read exactly 0.)
3. **`renormForCancel` — the #915 guard.** A `lo` word that arrives from a uniform/attribute
   **load** is discardable to a reassociating backend right before a cancellation; a `lo`
   the compiler computed one instruction earlier, it keeps. So every operand feeding a
   *cancelling* op (`sub`, `div`, and the lanes of `fract/mix/normalize/distance`) is
   laundered loaded→computed by adding a **df64 zero**. Idempotent (byte-unchanged on
   correct GPUs) and opaque (it is a `df64_add` call, not `x+0`).
4. **The zero itself is a bitcast barrier**: `vec2(bitcast<f32>(bitcast<u32>(0)), …)`.
   Written as a plain literal, a member-fold pass resolves it back to `0.0`, const-prop
   carries it into twoSum's `s = a+b`, and the pre-existing `x+0 → x` identity **deletes
   the add — and that add IS the renorm**. Measured: 408 flattened ops → 400 while the
   guard-texture read *survives* (1→1), so a gate that only checks the guard binding passes
   straight through the regression. What catches it: an op-count ratchet plus a
   barrier-strip cut test that requires the drop to reappear.
5. **Opacity is a decl flag, not a name prefix** (#1926): the mangler renames the df64
   library on purpose, so a `df64_*` name test held or not depending on plugin order —
   `[mangle, inline]` flattened the whole EFT library with no error. A property of the decl
   survives every rename.
6. **The Apple escape hatch: integer-domain EFTs** (`df64-int.ts`) — twoSum/twoProd rebuilt
   in u32 bit arithmetic (exact 24×24→48 product, round-to-nearest-even shift). Same names,
   same `vec2<f32>` contract, **no guard binding at all** — integer ops have nothing to
   reassociate. Selected per device (`recommendFp64Flavor`: Apple/Metal → integer; ANGLE-D3D
   stays float because FXC's compile cost on fully-inlined integer bodies can TDR).
   The general lesson from the blog series: float-side guards die on Metal *by construction*
   (fast-math deletes the error term); the durable answers are integer EFTs or
   restructuring so the high-precision multiply never happens — which is why deck.gl
   deprecated emulated fp64, and why X-GIS's coordinate pipeline needs df64 only where RTC
   cannot reach.

Achieved precision (known-answer tests): `1/3` and `√2` to ~2^-44 relative; cross-term
retention to ~2^-48. Fun fact with a lesson: the Veltkamp split constant was **never** the
bug — 8193 and 4097 are both error-free for f32; the one that breaks is a constant too
*small*.

## 5. Projection math (geo package)

- Web Mercator forward/inverse with a deliberate non-DRY: two call sites spell the
  radian conversion differently and the comment forbids collapsing them — "it would move
  ulps under callers." `wrapLonDelta` is byte-identical between CPU (`geo/src/projection.ts`)
  and GPU (`projections.ts`) so tile bounds agree with rendering at any central meridian.
- Eight projections implemented as forward (+inverse where closed-form): equirectangular,
  natural earth (Šavrič 6th-order polynomial; inverse = 5-iteration Newton on latitude),
  orthographic (`cosC < 0 → NaN` backface), azimuthal equidistant, stereographic, oblique
  Mercator — the last with a **singularity-only pole clamp** (`90° − 1e-4`): the standard
  85.05° clamp is wrong in the *rotated* frame and collapsed distinct rotated latitudes to
  the same Y (degenerate mesh, tile tearing).
- WGS84: `N = a/√(1−e²sin²φ)`; geodetic→ECEF standard; inverse via 4-iteration Bowring with
  a polar short-circuit. Constants come from one `Body` authority (`shared/src/body.ts`)
  with two values **pinned, not derived**: `worldMerc = 40075016.686` (≠ 2πa by 0.4 mm — a
  sub-meter drift is a coherent DC shift through meters-per-pixel), and `e2 = f·(2−f)`.
  A literal ratchet (`earth-literal-ratchet.test.ts`) forbids the constants appearing
  anywhere else.

**The geoid split (ADR-0002, revised).** Display/tiling projection (Web Mercator) is
spherical *by EPSG:3857 definition*; the 3D position datum is the WGS84 ellipsoid. The
original implementation also had the **camera** on a sphere while vertices sat on the
ellipsoid — a ~21 km frame mismatch (0 km at the equator, 24.5 km at lat 60). The
subtlety: within one RTC subtraction the mismatch **cancels** (both endpoints carry it), so
"force the constant to a sphere and assert a 10 km shift" measured **0.7 m** — differences
forgive shared bias; only a guard that *breaks the symmetry* (mixed frame: ellipsoid tile,
sphere camera) sees the real regression. The bug that did surface (#208): the globe arm
computed `tileCenter − cameraCenter` across the two frames, baking the full 21 km into the
offset — 0.8 px at z1.5, 69 px at z8, 4396 px (blank tile) at z14. Resolution: camera ECEF
moved to the ellipsoid, unified with vertices; residual E/N anisotropy is the honest
`max|f−1| = e² ≈ 0.669 %` ⇒ ≤ 1.9 px across the 24-cell parity matrix, gated at 2.5 px.
The split-brain witness test: point vs polygon anchor divergence **5697 px → <0.5 px** at
lat 60 / z14 / pitch 45.

## 6. Depth precision

- **Forward-Z + logarithmic depth**, not reversed-Z (reversed-Z + depth32float is a
  documented open recommendation, unshipped). At pitch 85°, plain forward-Z left ~10
  effective bits near the far plane.
- CPU per frame: `fc = 1/log2(far + 1)`. Vertex: `z = log2(max(1e-6, w+1))·fc·w` (the `·w`
  pre-cancels the perspective divide). Fragment: `frag_depth = log2(max(1e-6, view_w+1))·fc`
  per pixel — linearly interpolating a non-linear function across a triangle drifts, so the
  fragment recomputes.
- Far plane is horizon-bounded (MapLibre's law-of-sines construction) — before that fix the
  far plane degenerated to 150× altitude (~252 km of ground vs MapLibre's ~58 km).
  `near = max(1, altitude·0.01)`.
- The globe's "orthographic" arm keeps a **perspective** matrix with a 96× telephoto
  (eye pushed back, FOV narrowed by the same factor) because a true parallel matrix has
  `clip.w ≡ 1`, which collapses w-driven log depth to a constant and lets the far
  hemisphere render through the near one.
- Coplanar layers use an NDC-space `layer_depth_offset` bias; ground fills instead draw
  with depth OFF and painter's order (see [`05-polygon-rendering.md`](./05-polygon-rendering.md) §5).

## 7. CPU/GPU parity — four layers

1. **One IR, two backends (structural).** Projection math is authored once as shader-DSL
   IR; the GPU gets emitted WGSL/GLSL, the CPU gets a **generated f64 lowering of the same
   graph** (`cpu-projections.ts` — the generated replacement for a hand-maintained mirror).
   Tile selection, label anchors, raster anchors all call it. Two CPU backends (tree-walk
   interpreter + a `new Function` codegen twin, bit-identical by construction; the codegen
   twin exists because the interpreter was ~40 % of frame time in tile-selection probes).
   The memo is body-scoped — an unscoped memo once had "the CPU compute on Earth while the
   GPU drew the Moon, in one frame."
2. **The f64 oracle's honest blind spot**, stated in its own header: it is an *algebra*
   oracle, structurally blind to f32-precision loss — "a CPU↔CPU pass here is NOT evidence
   of GPU precision parity." Named bugs it cannot catch (fill-vs-outline displacement, the
   polar black hole). One deliberate concession: `==`/`!=` on f32-typed operands compare
   after f32 rounding (exact f64 equality silently disagrees on equality branches).
3. **Executed-WGSL parity**: a compute pass runs the *real* emitted WGSL projection
   functions over a lon/lat grid and diffs against the CPU f64 lowering, with a two-tier
   tolerance — hardware 100 m absolute; SwiftShader `max(3000, |v|·2e-3)` (its software
   transcendentals are ~3e-4 relative and stereographic's `2/(1+cos c)` amplifies that).
   Net contract: CI catches gross breakage; the tight hardware gate catches subtle drift.
4. **Kernel-level parity**: hot kernels (e.g. `dequant_ecef`) are extracted as shared DSL
   functions and executed standalone in a compute harness against a CPU `fround` mirror —
   "the verification kernel executes the EXACT shader logic, not a hand-retyped copy."

**The known hole, named**: parity between two copies of the *same* bug passes (WGSL and CPU
mirror share the DSL source). The counter is a **metamorphic** invariant — e.g. seam
continuity across ±180 — not parity.

## 8. Camera model

Three pure matrix builders (`map/src/camera/view-matrix.ts`; header: "the multiply chain
order and every association are load-bearing — do NOT reorder or 'simplify'"):

- **Flat RTC**: `MVP = P × T(0,0,−altitude) × Rx(−pitch) × Rz(bearing)` — an orbit camera
  (`mvp[15] === altitude` at every pitch).
- **ECEF frame view**: same chain × an ECEF→ENU rotation; true-meter altitude uses
  `mpp · cos(lat)`.
- **Globe orbit**: target on the ellipsoid, local `up/east/north` frame, hand-written
  right-handed lookAt.

Jitter avoidance is in the **matrix**, not the vertices, via three devices: (1) the GPU
only ever receives an **RTC matrix** built from `eye − target` ("lookAt is invariant under
shifting eye AND target by the same vector, so this is the exact RTC of the absolute
matrix") — the absolute matrix never reaches the GPU; (2) the absolute matrix is kept in
**f64 for the inverse** — at f32 the translation column quantizes to ~0.5 m/ULP, and the
drag-anchor loop (unproject every frame, pin ground point under cursor) could not converge
below that noise, shaking tens of px at z17+ (gate: f64/f64 < 0.05 px, f32 arm re-shakes
> 1 px); (3) the per-tile camera anchor ships as DSFUN hi/lo (§3).

## 9. Horizon culling and the globe intersection

- **One horizon authority**: `eyeHorizon(eye, a, b)` — the exact tangent-plane visibility
  test for a convex ellipsoid (`E·P/a² + … > 1`), evaluated in a frame that z-stretches the
  ellipsoid to a sphere, collapsing to `dot(q̂P, eyeN) > horizonCos = a/|eye|`. Three
  consumers in lockstep: the label projector, the globe tile selector, and the GPU
  fragment cull (packed as a uniform). For a sphere it reduces bit-for-bit to the retired
  sphere-only helper.
- **Ray↔ellipsoid via scale-to-sphere**: scale z by `a/b`, solve the sphere quadratic —
  "scaling is linear, so the ray parameter t is invariant under it" — then evaluate the hit
  on the original ray and invert with Bowring (not spherical asin).

## 10. Dateline, world copies

- One authority (`Camera.getVisibleWorldCopies`) enumerates copies per projType: globe and
  azimuthal discs = `[0]`; periodic flat = static `[-2..2]` below zoom 4 (static, not
  camera-derived, so label copies stay byte-identical to tile/fill copies); Mercator = a
  tight camera-derived range from 9 unprojected canvas samples (mid-edges included, because
  at extreme pitch corner rays go behind the camera and return null).
- The #212 lesson: the flat-Mercator polygon fill let the world-copy offset **algebraically
  cancel** (`(tileWest + worldOff)` appears in both `tile_origin` and the camera term) —
  half the world rendered as boundary lines on black. The fix recovers the copy index from
  the tile's own displayed center longitude and re-adds `wo·2πR`, camera-independently.
- Sphere routing is a table-derived predicate: cylindrical projections never sphere-route
  (world copies cover both sides); center-relative projections always do — the old
  "camera within 45° of ±180" heuristic dropped back-of-world tiles.
- f64 landmine (#2023): `(x/R)·(180/π)` round-trips ±180 to ±180.00000000000003, outside
  every inclusive [-180,180] containment — polar-cap selection returned nothing on the
  dateline. Wrap only out-of-range values so exact ±180 stays byte-identical.
- You cannot delete a rotated projection's branch cut, only **choose where it lives**:
  resolving it per tile scattered a 40,075 km discontinuity across every tile join;
  relocate it to the one edge geometry expects.

## 11. Transferable design rules

1. **Write the error budget before the shader.** A 200-line closed-form vitest file rejects
   a wrong frame at design time; it would have prevented three wrong "fixes."
2. **Pick frames so magnitudes shrink with zoom** (tile-local + RTC); then f32 suffices for
   the linear term and df64 is reserved for the few genuinely global computations.
3. **Subtract first, in f64, on the CPU.** Never reconstruct an absolute coordinate in f32
   and subtract a large anchor afterwards — that is catastrophic cancellation by
   construction.
4. **The camera anchor must be split hi/lo everywhere** — Mercator, non-Mercator `clon`,
   ECEF. A single-f32 anchor *is* the map-shake bug.
5. **One geodesy authority, one datum per role** — display projection may be spherical by
   spec; the 3D datum is the ellipsoid; brand the frames so a cross-frame subtraction is
   caught. Remember: differences forgive shared bias, so test guards must break the
   symmetry to see anything.
6. **Emulated doubles are an adversarial-compiler problem**, not a math problem: texel-fetch
   guards (never uniforms), per-cross-term renorms, load-laundering before cancellation,
   bitcast-barrier zeros, decl-flag opacity, and an integer-EFT fallback for fast-math
   platforms. Verify with op-count ratchets and cut tests — a pixel gate can be blind to a
   deleted guard.
7. **Log depth with per-fragment `frag_depth`** is the pragmatic depth answer for a
   planet-scale scene on `depth24plus`; keep perspective (telephoto) even for "ortho" looks
   so w-driven depth survives.
8. **Parity tests cannot see a shared bug** — pair them with metamorphic invariants.
9. **Enumerate world copies from one table-derived authority** consumed by tile selection,
   drawing, and labels alike.

## 12. Code map

- Contract: `docs/COORDINATES.md`; budgets: `map/src/camera/coordinate-error-budget.test.ts`,
  `map/src/render/rtc-recombine-precision.test.ts`, `compiler/src/tiler/*fuzz.test.ts`
- Packing: `compiler/src/tiler/ecef-packing.ts`, `shared/src/quantize.ts`, `shared/src/ecef.ts`
- Camera: `map/src/camera/view-matrix.ts`, `camera.ts`, `tile-camera-anchor.ts`;
  globe: `geo/src/globe.ts` (RTC matrix, f64 inverse, unproject)
- Projections: `geo/src/projection.ts`, `geo/src/projections-table.ts`,
  `map/src/shaders/dsl/projections.ts` (+ generated `cpu-projections.ts`)
- df64: `shader-dsl/src/core/fp64/` (`df64-lib.ts`, `df64-int.ts`, `flavor-select.ts`),
  `shader-dsl/src/core/passes/fp64-lower.ts`
- Depth: `engine/src/shaders/log-depth.ts`, `map/src/shaders/dsl/log-depth.ts`
- Horizon/world copies: `shared/src/ecef.ts` (`eyeHorizon`), `docs/adr/0006`,
  `geo/src/antimeridian-routing.test.ts`
- Blog series: fp64 posts (11), `the-precision-fix-that-opened-a-seam`,
  `reconstructing-the-absolute-coordinate-was-the-bug`, `differences-forgive-shared-bias`,
  `choose-where-the-discontinuity-lives`
