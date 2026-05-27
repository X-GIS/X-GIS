# PR 2d.1 Spike 2 — ENU-tangent validation outcome

**Decision:** Method A (stride 26)

## Measured clip-space deltas (max across 100 segments × 4 corners = 400 samples)

| Lat | Method A delta | Method B delta | Threshold |
|-----|----------------|----------------|-----------|
| 0   | 2.157e-10 px   | 2.157e-10 px   | 0.5 px    |
| 85  | 3.303e-4 px    | 3.303e-4 px    | 0.5 px    |

Both methods pass the 0.5 px threshold by **6-7 orders of magnitude** at lat=85
and **9-10 orders of magnitude** at lat=0. The lat=85 delta of ~3.3e-4 px is
the curvature gap between Mercator-metre tile-local 2D-tangent math (current
production) and ENU-metre ECEF-frame 2D-tangent math (migration target) at a
5 m half-width stroke 100 m segment under identity MVP × 1024×768 viewport.

Methods A and B are algebraically equivalent — same ENU→ECEF rotation
applied to the same (along, across) corner intent. The split is purely
"where does the linear combination run, CPU or VS". At f32 precision
within the segment buffer, neither path introduces measurable extra error
under f64 reference math, and the lat=85 residual is the inherent
Mercator-vs-ENU divergence that is the WHOLE POINT of the migration to
land.

## Memory cost

- Method A: stride **26** f32 — +6 f32/segment = +24 B/segment
- Method B: stride **30** f32 — +10 f32/segment = +40 B/segment

Method A wins on memory by **16 B per segment** = ~6.6% smaller LineSegment
struct. For a typical viewport at z=14 with ~10k line segments, that's
~160 KB of GPU storage saved per frame's worth of pipeline.

## Recommendation

**PR 2d.1 main implementation MUST use stride-26 segment storage.**

## VS-side decoding (Method A)

CPU bakes per-endpoint (dir_enu, nrm_enu) × half_w_m, written as one
vec3 hi/lo pair per endpoint into the segment buffer. VS reads:

```wgsl
// Per-endpoint stored slots (3 f32 × 2 endpoints = 6 extra f32 over base stride 20).
// Bake at compiler/tiler time:
//   dir_enu_a = (cos(heading_a), sin(heading_a), 0)
//   nrm_enu_a = (-sin(heading_a), cos(heading_a), 0)   // 2D-tangent ⊥ rotation in ENU
//
// VS-side corner formation:
let baked_a = seg.tangent_enu_a;       // vec3 (E, N, U=0) × half_w_m on outer side
let baked_b = seg.tangent_enu_b;
let R_a = ecef_to_enu_rotation(p_a.abs_lon, p_a.abs_lat);  // 3x3 ENU→ECEF
let corner_offset_a = (along * baked_a.xy.x + across * baked_a.xy.y) ...
// then transpose(R) * (along*dir_enu + across*nrm_enu)*half_w_m
```

The exact field layout (single vec3 baked offset vs 2× vec3 dir+nrm) can be
decided in the PR 2d.1 main implementation — both schemas fit within the
stride-26 envelope. The validation gate above is agnostic to that choice.

## Note on the test approach

Both methods compute corner positions via the **same** ENU→ECEF basis
rotation; they only differ in where the linear combination runs. The
test's "legacy" reference is the production Mercator-metre 2D-tangent
path, reconstructed via inverse Mercator from the corner Mercator
position back to lon/lat → ECEF. The lat=85 delta of 3.3e-4 px is the
true curvature signal the migration replaces; the 2.2e-10 px lat=0
delta is f64 round-off noise (Mercator y-stretch at lat=0 is 1.0
exactly, so the two methods should be numerically identical and the
residual is end-to-end accumulated f64 round-off).

## Files

- Test: `D:/X-GIS/runtime/src/core/line-segment-build.test.ts`
- Helper used: `D:/X-GIS/runtime/src/engine/projection/ecef.ts:lonLatToECEF`
- Builds on Spike 1: `D:/X-GIS/compiler/src/tiler/vector-tiler.ts:packECEFLineSegments`
