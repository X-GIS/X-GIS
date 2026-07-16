# Ellipsoid datum unification — single WGS84 authority for 3D position + unproject

**Status:** design proposal (2026-07-16), from a two-reviewer (architect + adversarial critic) pass, all claims file:line-grounded. Supersedes the loose "unify everything on the ellipsoid / retire spherical Mercator" framing (which is WRONG — see §Target). GAP 3 of the S-100 rendering-feasibility report; the ellipsoid tension named in `nonmerc-vector-direct-reprojection.md:69-73`.

## TL;DR — the reframe

The naive framing ("the globe carries a ~21.5 km sphere-vs-ellipsoid offset; flip the camera to the ellipsoid") is **mis-scoped**, proven false by code:

- **Globe TILE geometry is ALREADY ellipsoid-correct.** Tile vertices pack ellipsoid ECEF (`compiler/src/tiler/ecef-packing.ts:246-254` `N=A/√(1−E2·sin²)`), and the tile camera anchor is ALSO ellipsoid (`map/src/render/tile-camera-anchor.ts:76-93`, both `tN`/`cN` with `E2`, `(1−E2)` z-term). The globe MVP is translation-invariant RTC, so `clip = mvp·(v_ellipsoid − c_ellipsoid)` is datum-correct in horizontal position. The ~21 km does NOT live in globe tile positions.
- **The real bug is a SPLIT-BRAIN camera anchor.** X-GIS has TWO camera ECEF anchors: the tile path uses the ellipsoid (`computeTileCameraAnchor`), but the **point/heatmap/label** path uses the SPHERE (`map/src/render/camera-anchor-dsfun.ts:31-43` → `camera.getECEFCenter()` → `lonLatToECEFSphere`, `camera.ts:511-518`). Since the vector DATA (tiles, extrusions, retained graphics, points) is ALL already ellipsoid, the intended datum is ellipsoid — the remaining sphere consumers are a bug, not a domain split.
- **EXECUTABLE proof of the split-brain Δ:** `|lonLatToECEF − lonLatToECEFSphere|` at the camera latitude = **0 km @ lat0, 21.3 km @ lat35, 24.5 km @ lat60, 21.5 km @ lat85**. A point feature and a polygon vertex at the SAME lon/lat therefore project to clip positions that differ by `mvp·Δ(cam)` (~24 km worth at lat 60) — a real point↔polygon misalignment, visible at pitch>0 / screen edge / high latitude, and identically zero at the equator (why the lat=0 parity gate never catches it).

## Why the parity gate is NOT a hard blocker (the keystone)

The camera reads the sphere today because of a dual-path parity gate (`polygon-ecef-mvp-latitude-parity.test.ts`, `camera-ecef-mvp.test.ts`): the ECEF-MVP must converge with the legacy spherical Mercator 2D MVP at lat=0, and ADR-0002 measured that an ellipsoid camera anchor "blows 19/24 cells past 1.5 px". BUT — the gate builds its ECEF vertices with `mercatorToECEFSphere` (SPHERE), while the production tiler packs the ELLIPSOID. The gate tests a **non-production pair** (sphere-vertex ↔ sphere-anchor). Rewriting the gate to ellipsoid-vertex makes the ellipsoid anchor converge exactly at lat=0 (`sinLat=0 → N=a, z=0`). The gate also bypasses globe-mode entirely, so the **globe camera datum is not bound to the Mercator parity gate at all.** Fixing the gate to ellipsoid-vertex is the keystone that unblocks every later ellipsoid increment.

## Target (VERDICT)

**Single WGS84 ELLIPSOID authority for all 3D-position and unproject; flat Web Mercator (projType 0) stays SPHERICAL.** Web Mercator is spherical by EPSG:3857 definition — the tile pyramid, zoom, `worldMerc` literal (`body.ts:68`), and mpp all depend on it; it is NOT a bug and must NOT change. The split is "**display/tiling projection (Mercator = sphere) vs position datum (3D = ellipsoid)**", not "one geoid everywhere". Retiring spherical Mercator (the naive "unify everything") is a dominated option — standard violation + massive regression for zero gain.

## Increments (each build + verified; flat Mercator invariant throughout)

- **INC-1 — unify the camera ECEF anchor to the ellipsoid + fix the parity gate (keystone).** CPU-only, small.
  - `getECEFCenter()`/`ecefCenterOf`: `lonLatToECEFSphere` → `lonLatToECEF` (`camera.ts:511-518`, `view-matrix.ts:333-336`). This auto-fixes the point/heatmap anchor (`camera-anchor-dsfun.ts:39`), making point/label features share the tiles' ellipsoid datum.
  - Rewrite the two flat parity gates' vertices `mercatorToECEFSphere → mercatorToECEF`, re-derive the threshold for the ellipsoid north-axis residual (~1.7 px @ z14, `camera.ts:503` 0.67%).
  - **Fail-first test (CPU, clip-space, no GPU):** at a globe camera lat=60, a polygon tile vertex and a point feature at the SAME lon/lat diverge by projected Δ(cam) today (thousands of px @ z14); assert they agree < 0.5 px after. Equivalently `devAssertClose(pointAnchor, tileAnchor)` — fires (24 km) before, passes after.
  - Invariant: flat Mercator, tile fill/line (already ellipsoid via `computeTileCameraAnchor` — unchanged), raster surface.
- **INC-2 — globe unproject → ellipsoid** (`geo/src/globe.ts:385-425`, scale-to-sphere: divide z by `b/a`, intersect unit sphere, invert). Fixes cursor/pick/measure lon/lat — the S-100-critical navigation readback. Small.
- **INC-3 — globe surface grid + camera focus → ellipsoid** (`globeForward`/`buildGlobeMatrix` target, `vs_tile` raster grid, pole cap, `eyeHorizon`/tile-select/under-occluder horizon stack in LOCKSTEP). The ONLY increment that puts an ellipsoid `N` in WGSL → must unify the deliberate CPU/GPU `e2` constant divergence (`body.ts:26-28`) and run the df64 battery (Apple/Metal, PR#924 precedent). Removes the vector↔raster limb mismatch. Large.
- **INC-4 — retire sphere helpers** (`lonLatToECEFSphere`, `mercatorToECEFSphere`, sphere `globeForward`) once caller count is 0. §11 full gate.

## Precision (Q4)

Vector path introduces **no new df64 risk** — the GPU consumes CPU-packed ellipsoid ECEF linearly (`polygon.ts:515-518`); the ellipsoid `N` runs on the CPU per tile-load, not per frame. Only INC-3 puts `N` in WGSL, and it is a smooth sub-percent multiplier (`1−e2·sin² ∈ [0.9933,1]`) the existing df64 path (twoProd/FMA) already handles; the binding precision cost is the 6.4 Mm absolute ECEF magnitude (df64 required sphere or ellipsoid). One gotcha: CPU `e2=f(2−f)` vs the WGSL `e2` literal are deliberately different (`body.ts:26-28`) — INC-3 must single-source them (the repo's dominant CPU/GPU sibling-divergence archetype).

## S-100 scope honesty

Ellipsoid unification fixes the HORIZONTAL datum only. S-100 also needs a decoupled plural VERTICAL-datum model (chart datum/LAT, positive-down soundings — entirely unbuilt) and a cm-level precision/uncertainty budget. This epic is ONE of ≥3 S-100 gates, not "the" unlock. Do not gate S-100 usability on it alone.

## What each increment fixes (user-visible)

| Symptom                                                     | Cause                                                         | Fix        |
| ----------------------------------------------------------- | ------------------------------------------------------------- | ---------- |
| point/label ↔ polygon misalign (pitch>0, high-lat, edge)    | point anchor sphere, tile anchor ellipsoid (Δ(cam) ~21-24 km) | INC-1      |
| cursor/pick/measure returns wrong lon/lat                   | `unprojectGlobe` intersects a sphere                          | INC-2      |
| vector ↔ raster basemap drift (0 at center → grows to limb) | raster surface sphere, vector ellipsoid                       | INC-3      |
| tiles ↔ retained ↔ extrusion                                | all already ellipsoid — consistent                            | — (no bug) |
