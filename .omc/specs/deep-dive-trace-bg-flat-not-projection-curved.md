# Deep Dive Trace: bg-flat-not-projection-curved

## Observed Result

User report (Korean): "백그라운드 렌더링시 타일에 렌더링되는게 아니라 그냥 평면으로 렌더링돼요 프로젝션에 따라 구부러지지 않고."

Translation: Background renders as a flat plane, not per-tile, and does not curve with the projection. Symptom appears under non-Mercator projections (globe / ortho / azimuthal / stereo and likely the 2D non-Merc set as well).

## Ranked Hypotheses

| Rank | Hypothesis | Confidence | Evidence Strength | Why it leads |
|------|------------|------------|-------------------|--------------|
| 1 | **Combined: bg VS lacks `project_geom` call AND geometry is 6-vert (2 triangle) Mercator-extent quad** — projection bend is a per-vertex non-linear transform; the bg shader is projection-blind in both axes (no per-vertex projection math, no tessellation) | High | Strong (Tier 1: source-of-truth shader code) | Lane 1 + Lane 2 converged on same mechanism viewed at two levels |
| 2 | **Stale design comment + missing sphere proxy** — `background-renderer.ts:17-23` defers globe sphere proxy "when added"; globe/ortho/azi/stereo (projType 3-7) shipped 2026-05-16 (`6dabe05`) — 4 days BEFORE the deferring comment was written (`bb0b383` 2026-05-20). Gap user-visible on all sphere-shaped projections today | High | Strong (git blame + projections-table.ts:67-71) | Confirms not-a-regression: feature gap, not bug |
| 3 | Reprojector is the missing link | Low | Weak (header-comment only) | `reprojector.ts` confirmed dead/unused; not wired to bg or any path |

## Evidence Summary by Hypothesis

**H1 (projection-blind shader + insufficient tessellation):**
- `shader-dsl/shaders/background.ts:25-33` — uniform struct `U` has `mvp + cam_center + pad + color` only. **No** `proj_params`, **no** `proj_type` field.
- `shader-dsl/shaders/background.ts:56-65` — VS: `transformMat4(mvp, vec4(local, 0, 1))` where `local = world_merc[idx] - cam_center`. Pure Mercator-space math, single MVP multiply, no projection branching.
- `shader-dsl/shaders/background.ts:59-61` — `arrayLit` contains exactly 6 `vec2` literals (BL/BR/TL/TL/BR/TR). World-extent rectangle `±2.5·WORLD_MERC × ±MAX_Y`.
- `render/background-renderer.ts:278` — `encoder.draw(6)`. Confirms 6 verts, 2 triangles.
- Contrast `shader-dsl/shaders/polygon.ts:215-228` — polygon VS has `t < 0.5` Mercator short-circuit vs `project_geom(abs_lon, abs_lat, projParams, tileRefLon)` for non-Mercator. Per-vertex projection at each tile geometry vertex; curvature emerges from vertex density × non-linear transform.
- `camera.ts:47` documents that `getFrameView` for projType 0..6 returns byte-identical matrices — i.e., MVP alone cannot encode non-Mercator warp; nonlinear projections MUST go through `project_geom`.

**H2 (stale comment / shipped-but-gap):**
- `projection/projections-table.ts:63-72` — 8 projections live: mercator(0), equirectangular(1), natural_earth(2), orthographic(3), azimuthal_equidistant(4), stereographic(5), oblique_mercator(6), globe(7). projType 3-7 have `isFlat: false`.
- git blame: globe/ortho/azi/stereo shipped 2026-05-16 (`6dabe05`). bg renderer comment "currently shipped (Mercator + 2D variants)" written 2026-05-20 (`bb0b383`) — already stale at write time.

**H3 (reprojector):** `projection/reprojector.ts:1-7` header marks unused. No call site. Eliminated.

## Evidence Against / Missing Evidence

**H1:** Tessellation alone insufficient — must also add `proj_params` to bg uniform + call `project_geom` per vertex. Two coupled changes, not one.

**H2:** Stencil/depth bypass in bg pipeline (`background-renderer.ts:143-155`, `depthCompare='always'` + `depthWriteEnabled=false`) was put in place because the prior **tile-based / quad-mesh** bg implementation kept colliding with depth+stencil bookkeeping at high pitch under log-depth. Any tessellated replacement must preserve these semantics or reintroduce z-fighting.

**H3:** No counter-evidence needed; reprojector is dead.

## Per-Lane Critical Unknowns

- **Lane 1 (geometry/shader)**: Whether the correct fix is (A) tessellated Mercator mesh + `project_geom` per vertex (parallel to polygon VS), or (B) sphere-proxy mesh layered on top of current flat bg (Mapbox globe model). Both fix symptom; different depth/stencil entanglement cost.
- **Lane 2 (orchestration)**: Whether `camera.getRTCMatrix` / `getFrameView` for projType 7 (globe orbit) already builds a matrix that would correctly map a sphere proxy's lat/lon vertices to clip, or whether camera path itself needs work.
- **Lane 3 (premise)**: WHICH projection user actually views when reporting bug. For pseudocyl projs (equirect/NE/oblique-merc) flat bg outside the rectangle is **visually correct** (matches MapLibre/Mapbox). For globe/ortho/azi/stereo it's **incorrect** — bg floods canvas instead of being clipped to globe disc silhouette.

## Rebuttal Round

**Best rebuttal to leader (H1+H2 merged):** "Maybe the world-extent quad, projected via MVP for ortho/globe, naturally clips to disc silhouette via GPU clipping — giving correct behavior without sphere proxy."

**Why leader holds:** GPU clip clips to NDC cube, not to disc. Quad covers `±2.5·WORLD_MERC × ±MAX_Y` in Mercator metres. For ortho/globe, MVP projects these as 4 corner points of a distorted rectangle — bg color floods entire canvas regardless of globe disc boundary. The 6-vert quad **also fundamentally cannot represent a sphere surface** even with a perfect MVP, because sphere → plane is a non-linear surface, not a single 4×4 transform.

## Convergence / Separation Notes

- **Lane 1 and Lane 2 are the same root mechanism at two levels**: bg geometry has no lat/lon sampling density (Lane 1) AND bg VS has no projection transform (Lane 2). Both are required for any fix; collapsing them gives the single statement: *the background does not participate in the non-Mercator projection pipeline*.
- **Lane 3 is independent context** that distinguishes "regression" (false) from "documented deferred feature" (true). It also narrows scope: fix is only user-visible on `isFlat: false` projections.

## Lane 3 Misplacement / SoT Ownership Scope

N/A — Lane 3 in this trace was used for premise audit, not for misplacement/move classification. No cross-boundary ownership concerns surfaced.

## Most Likely Explanation

The background quad is structurally frozen in the Mercator path:
1. Shader: pure `mvp * (world_merc - cam_center)`. No `proj_params`. No `project_geom`. No projType branch.
2. Geometry: 6 vertices (2 triangles), full Mercator world-extent rectangle.
3. Camera: MVP for projType 0..6 is byte-identical per `camera.ts:47`; nonlinear projections require explicit per-vertex `project_geom` dispatch.
4. The comment at `background-renderer.ts:17-23` documents this as a known deferred gap with sphere proxy "when added" — but the comment was already stale at write time because globe/ortho/azi/stereo had shipped 4 days earlier.

User-visible scope: all `isFlat: false` projections — orthographic (3), azimuthal_equidistant (4), stereographic (5), globe (7). Possibly also oblique_mercator (6) at certain rotations. Cylindrical 2D projections (equirect 1, natural_earth 2) — bg as flat rectangle is visually correct, matches MapLibre/Mapbox convention.

## Critical Unknown

**Which fix architecture does the user want — (A) tessellated bg with per-vertex `project_geom` extending the existing `BackgroundRenderer`, or (B) a separate sphere-proxy render object layered on top (Mapbox globe model)?** Choice affects:
- Whether `BackgroundRenderer` grows a projection-aware path or stays flat-only.
- How the depth/stencil bypass interacts with the curved surface.
- Whether the bg uniform struct grows (`proj_params` + projType + tile-ref-lon) or stays minimal.

## Recommended Discriminating Probe

Two-step probe:
1. **Scope confirmation**: ask user which projection(s) they're testing. If only globe/ortho/azi/stereo → fix targets `isFlat: false` projections. If also equirect/NE → user expectation diverges from Mapbox/MapLibre convention and needs deeper discussion.
2. **Architecture proof-of-concept**: replace 6-vert `arrayLit` in `background.ts` with a 20×20 lat/lon grid, add `proj_params` to `U` struct and to `bgUniformBuffer` upload in `background-renderer.ts`, call `project_geom` per vertex parallel to `polygon.ts:226`. Render under projType=3 (orthographic) at z=2, p=0. If background silhouette now matches polygon globe disc → path (A) works. Cost ~1 day, reversible.
