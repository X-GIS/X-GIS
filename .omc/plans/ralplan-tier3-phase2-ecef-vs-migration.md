# Phase 2 Plan — ECEF VS Migration (PR 2c)

**Status:** pending approval (consensus iteration 4 — Critic APPROVED-WITH-IMPROVEMENTS at v3; v4 applies wall-lift module attribution fix (runtime not tiler), is_top discriminator for roof/bottom, closeout tracking enforcement, CPU-wall-lift perf pre-mortem, plus minors)
**Spec:** `D:/X-GIS/.omc/specs/deep-dive-bg-flat-not-projection-curved.md`
**Branch:** `feature/ecef-tile-pipeline-phase2` (already exists; PRs 2a/2b/2c-prep landed: 4729613, 4a46a27, 52c7f0b).
**Predecessor work (already merged to main):**
- **PR 2a** (#156, 4729613): ECEF math layer (`runtime/src/engine/projection/ecef.ts`) + earth-surface-fill design + cache-version audit.
- **PR 2b** (#157, 4a46a27): `Camera.getECEFCenter()` + `Camera.getECEFToENURotation()` accessors. ECEF derived per call from canonical Mercator `centerX, centerY`; never cached on the class. **NOTE per Critic finding:** the PR 2b memory note's claim that "ECEF→ENU agrees with Mercator-metre basis to within tangent-plane curvature error" is mathematically wrong as stated; PR 2b only validated `ecefToENURotation` orthonormality, NOT matrix composition. The PR 2b accessors stand as correct primitives; the broken composition claim is corrected here in v2.
- **PR 2c-prep** (#158, 52c7f0b): `TILE_LAYOUT_VERSION = 1 as const` + `TileSourceMeta.layoutVersion?` field + `earth-surface-fill.ts` mesh generator (32×16 lat/lon grid). No runtime consumer yet.
- **Phase 1b** (#153, 6205164): `TileScheme` field + `TileCatalog.getSourceScheme`. Single variant `'web-mercator-xyz'`. Source-honest principle locked.

**Scope of PR 2c (v2):** First runtime consumer of all Phase 2 scaffolding. Migrates the polygon vertex pipeline from Mercator-DSFUN (with runtime re-quantization to stride-8 quantized) to **ECEF-DSFUN stride-7** (no runtime re-quantization for polygon). Adds a SEPARATE `u.mvp_ecef` uniform constructed in **true-ENU-metre semantics** on the CPU; polygon VS reads only this new uniform. **Legacy Mercator-DSFUN VSes (line / point / raster / text) are NOT touched in PR 2c** — they keep reading the existing `u.mvp` exactly as today. Earth-surface fill mesh dispatched through the standard opaque pipeline replaces `BackgroundRenderer`. `TILE_LAYOUT_VERSION 1 → 2` bump + doc-promised catalog mismatch eviction (with new `TileData.originBackend` reverse pointer).

**Out of scope (future Phase 2 PRs):** line / point / raster / text VSes migrated to ECEF (= PR 2d; these stay on Mercator-DSFUN throughout PR 2c). `reprojector.ts` deletion + `_back-compat` retire (= Phase 2e per memory `project_shader_dsl_pr_d_phase4_2026_05_27`). Quantized-ECEF vertex compression for polygon (= Phase 2f optimisation; explicit retire-quantized in PR 2c for the polygon path).

---

## Requirements Summary

The Phase 2 thesis (per Phase 1 ADR's "Follow-ups" + spec deep-dive at `.omc/specs/deep-dive-bg-flat-not-projection-curved.md`): X-GIS's polygon vertex pipeline today writes vertices in tile-local Mercator metres (DSFUN stride-5 from `compiler/src/tiler/vector-tiler.ts:1411` `packDSFUNPolygonVertices`), then **re-quantizes at runtime upload time** (`runtime/src/engine/render/vector-tile-renderer.ts:2171` `quantizePolygonVerticesExtruded`, `:2198` `quantizePolygonVertices`, `:2432` extruded sibling) into a `uint16x2 + f32` stride-8 GPU buffer, consumed by `vs_main_quantized` (polygon DSL `runtime/src/engine/shader-dsl/shaders/polygon.ts:272-358`). The GPU VS runs `project_geom(mercator_pos)` per vertex with per-projType branching. The vertex layout is declared at `runtime/src/engine/render/renderer.ts:738-744`.

This coupling has three documented defects:
1. **Per-vertex projection branching** by `projType` inside `project_geom` (`engine/shaders/projection.ts`) — three drift sites per shader, replicated across polygon / line / point / raster / text. The recurring CPU↔GPU parity bug class (memory `project_projection_divergences`).
2. **Hand-WGSL math parity** between `engine/shaders/projection.ts` and the lowered DSL `cpu-projections.ts`. The cpu mirror lives at `runtime/src/engine/shader-dsl/cpu-projections.ts` (generated from `shader-dsl/projections.ts`).
3. **`BackgroundRenderer` outside the standard tile pipeline.** Today the `runtime/src/engine/render/background-renderer.ts` draws a world-extent quad uniform with its own `bg-pipeline`. Under sphere projections the quad cannot curve; the result paints a flat strip while real polygon tiles correctly use `project_geom`. The user-visible defect at `.omc/specs/deep-dive-bg-flat-not-projection-curved.md`.

The Tier 3 cure: write polygon tile vertices in **ECEF Cartesian metres** (WGS84 ellipsoid; Cesium / 3D Tiles 1.1 / NASA 3DTilesRendererJS coordinate frame). The polygon VS reduces to `clip = u.mvp_ecef * vec4(ecef_rtc, 1)` — one matrix multiply per vertex, no projection branching.

### Critical math correction (v2 — Critic P0 #1)

The v1 plan's matrix-composition claim was wrong. `getRTCMatrix()` (`runtime/src/engine/projection/camera.ts:152-272`) is built in **Mercator-metre semantics**: `metersPerPixel = (WORLD_MERC / TILE_PX) / 2^zoom` (line 165) is Mercator-metres-per-CSS-pixel; `viewHeightMeters` (line 192) and the derived `altitude` (line 193) are Mercator metres. At latitude φ, one Mercator metre of east-west extent = `cos(φ)` true east-west metres. `ecefToENURotation` (`ecef.ts:123-142`) is a pure rotation (det=1) outputting true-ENU metres. The composition `getRTCMatrix() × ecefToENURotation()` mixes Mercator-metre semantics with true-metre input — at lat=φ polygons would render `cos(φ)` smaller than surrounding Mercator-DSFUN line/point/raster/text. At lat=45° that's a 30% shrink, at lat=60° a 50% shrink, at lat=85° a 91% shrink. **Hard correctness failure.**

The v2 cure: build a **separate, ENU-metre-native MVP** on the CPU per frame:

```
mvp_ecef = perspective(fov, aspect, near, far)
         × translate(0, 0, -altitude_true)
         × rotateX(-pitch)
         × rotateZ(bearing)
         × ecefToENURotation(cam_lon, cam_lat)
where altitude_true     = altitude_in_mercator_meters × cos(cam_lat)
      mppTrue            = mpp_mercator × cos(cam_lat)
      viewHeightTrueM    = (canvasH/dpr) × mppTrue
```

This is **a parallel build** alongside the existing `getRTCMatrix()`; the existing matrix continues to serve every other VS unchanged. The polygon VS gets the new `u.mvp_ecef` uniform and reads ONLY that. The cos(lat) factor moves the conversion from "wrong at the GPU side" to "correct at the CPU side" where lat is known cheaply (camera anchor latitude is a single number per frame). Off-anchor latitude variation across the visible viewport is irrelevant — the MVP is anchored at the camera, and ECEF→clip is geometrically exact regardless of where the vertex lives (vertex magnitude is bounded by tile extent ECEF-RTC, which is small relative to Earth radius).

This is the Critic's Option (a) "ENU-metre MVP" path. Cost: ~30 LOC of new CPU matrix-build code in `camera.ts`. Benefit: polygon VS becomes mathematically clean linear MVP without sec(φ) drift, and legacy VSes are NOT touched in PR 2c.

### Module boundaries (v4 — Critic M-1 gap fix)

PR 2c.2 splits implementation across two modules with a hard boundary at extruded-vs-flat-fill:

| Module | Owns | New routine | Existing routine to keep |
|--------|------|-------------|---------------------------|
| `compiler/src/tiler/vector-tiler.ts` | **Flat-fill polygon** ECEF pack (footprint vertices, no height info needed) | `packECEFPolygonVertices(scratchPv, ecefTileCenter): Float32Array` — stride-9 floats `[ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, fid, abs_lon, abs_lat]` | `packDSFUNPolygonVertices` (point path; still used by `pointVertices` at `:1420, :1632` — kept exported, point-VS migration deferred to PR 2d) |
| `runtime/src/core/polygon-mesh.ts` | **Extruded wall + roof** ECEF mesh (per-feature heights resolved at runtime) | `generateWallMeshExtrudedECEF(polygons, heights, tileEcefCenter): Float32Array` — stride-14 floats including `face_normal + wall_height + is_top` | `generateWallMesh*` Mercator path stays during PR 2c.2 if any non-ECEF consumer remains (audit at step 13 confirms zero non-extruded consumers; delete if so) |
| `runtime/src/engine/render/vector-tile-renderer.ts` | **Runtime upload glue** | None new; the `quantizePolygonVertices*` import + calls at `:30-31, :2171, :2198, :2432, :2439` DELETED. `generateWallMeshExtruded*` calls at `:2178, :2439` swap to `generateWallMeshExtrudedECEF` | n/a |

**Why this boundary:** heights flow `style-eval → runtime → vector-tile-renderer → polygon-mesh`. They never reach the compiler tiler (`vector-tiler.ts` is height-blind; grep confirms zero `heights|extrude` references). v3 plan misattributed wall lift to "the tiler emits TOP-ring vertices"; v4 corrects to runtime.

**Point migration decision (Critic gap fix):** point VS stays on Mercator-DSFUN throughout PR 2c per Principle 8 ("Dual-MVP, not legacy-VS-rewriting"). `pointVertices` continues using `packDSFUNPolygonVertices` via `vector-tiler.ts:1420, :1632`. Point VS migration is PR 2d scope.

### Vertex layout decision (v2 — Critic P0 #2)

The production polygon path is **`packDSFUNPolygonVertices` (tiler) → re-quantized to stride-8 via `quantizePolygonVertices*` (runtime upload) → `vs_main_quantized` (GPU)**. Confirmed by direct code reading at `vector-tile-renderer.ts:2171, 2198, 2432, 2439` and `renderer.ts:738-744` (stride-8 layout) and polygon DSL pipeline bindings at `renderer.ts:792, 804, 812, 830` (every polygon pipeline binds `vs_main_quantized` not `vs_main`).

v2 picks **Option (a) retire-quantized for polygon-ECEF**: PR 2c.2 ships stride-7 ECEF DSFUN (`[ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, fid]` = 28 bytes/vertex) directly from the tiler to the GPU with no runtime re-quantization. The `quantizePolygonVertices` + `quantizePolygonVerticesExtruded` call sites for polygon path are DELETED in PR 2c.2. Net memory cost: +20 bytes/vertex (stride 8 → 28 = +250%). On a 600-tile × 1000-vert polygon scene (= 600k verts) that's +12 MB GPU memory. Acceptable. The quantized stride-8 retire affects polygon only; line VS (stride-24 DSFUN) and point VS (stride-16) are unchanged.

Designing a proper quantized-ECEF format (u16×3 tile-local with per-tile-rotated axis quantization) is multi-day design work deferred to **Phase 2f** as a memory optimisation. The Phase 2c thesis is correctness (Tier 3 ECEF linear MVP), not memory; that pairing is explicit.

The retire of `vs_main_quantized` (polygon path) does NOT affect non-polygon paths — `vs_main_quantized` is a polygon DSL entry; other shaders have their own quantized variants if any.

---

## Acceptance Criteria

PR 2c splits into **four** sub-PRs that land in sequence off `feature/ecef-tile-pipeline-phase2`. Each is independently reviewable; sub-PRs are **honestly** revertible per the Revertibility Matrix below.

### Revertibility Matrix

| Sub-PR | Independent revert? | Coupled with | Rationale |
|--------|---------------------|--------------|-----------|
| 2c.1 (tiler + dual-MVP infrastructure + originBackend field) | YES — pure additive (sibling tiler fn + new CPU MVP build + new uniform slot + new `TileData` field) | — | Unused by any consumer until PR 2c.2 |
| 2c.2 (polygon VS rewrite + retire quantized + delete runtime re-quantize) | NO — must revert WITH 2c.1 if 2c.1 alone is wanted back, OR revert solo (returns polygon path to pre-PR-2c state) | 2c.1 supplies the inputs (tiler fn + MVP build) | The 2c.2 revert RESTORES the deleted runtime re-quantize calls + restores `vs_main_quantized` DSL entry. Mechanical revert is clean; 2c.1's additions become unused again |
| 2c.3 (synthetic earth-surface backend + BackgroundRenderer deletion) | YES — independent | — | Synthetic backend uses Mercator-DSFUN path until/unless polygon ECEF lands; works regardless |
| 2c.4 (TILE_LAYOUT_VERSION 1→2 + catalog eviction + per-backend tile-cache attribution) | YES — independent | — | Version-bump triggers eviction; backends still attach without the field |

**Honest count: 3 of 4 sub-PRs are independently revertible. PR 2c.2 reverts solo correctly (the additive scaffolding from 2c.1 becomes dormant). This satisfies "Minimum reversible step" with no Principle 4 contradiction.**

### PR 2c.1 — Tiler + dual-MVP infrastructure + `TileData.originBackend`

Pure additive scaffolding. No runtime behaviour change.

| AC | Criterion | Verification |
|----|-----------|--------------|
| AC2c.1.1 | Add `packECEFPolygonVertices(scratchPv: number[] \| Float64Array, ecefTileCenter: ECEF): Float32Array` to `compiler/src/tiler/vector-tiler.ts`. Input: stride-3 `[mx, my, fid]` ABSOLUTE Mercator metres. Output: stride-7 Float32Array `[ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, fid]` = DSFUN-split ECEF Cartesian metres relative to `ecefTileCenter`. Implementation: per-vertex `mercatorToECEF(mx, my, 0)` → subtract `ecefTileCenter` → DSFUN-split via `Math.fround`. The tile-anchor ECEF center keeps per-tile residuals ≤ tile-extent metres so the f32 high-half holds the magnitude. | Unit test `compiler/src/tiler/ecef-precision-fuzz.test.ts` — 1e4 random Mercator points across z∈{0,8,15,22}, pack → reconstruct on CPU as `f64(ex_h)+f64(ex_l)+ecefTileCenter[k]`, inverse via `ecefToLonLat`, assert reconstruction within **1 mm** @ z=22 and **1 cm** @ z=0. AC2c.1.1. |
| AC2c.1.2 | `packDSFUNPolygonVertices` (`vector-tiler.ts:136`) is NOT removed in 2c.1 — both sibling functions coexist. PR 2c.2 swaps the call sites. | Diff. |
| AC2c.1.3 | Add `tileEcefCenterFromMerc(tileMx: number, tileMy: number): ECEF` to `runtime/src/engine/projection/ecef.ts`. Thin wrapper around `mercatorToECEF(tileMx, tileMy, 0)`. | Unit test in `ecef.test.ts` (round-trip vs `mercatorToECEF`). |
| AC2c.1.4 | **Dual-MVP CPU build.** Add `getECEFFrameView(canvasWidth: number, canvasHeight: number, dpr: number = 1): { matrix: Float32Array; far: number; logDepthFc: number }` method on `Camera`. Mirrors `getFrameView` but builds the ENU-metre MVP per the math in Requirements Summary:<br/>1. Read `cam_lon, cam_lat` from canonical `centerX, centerY` (mirror existing inverse in `getECEFToENURotation`).<br/>2. Compute `cos_lat = cos(cam_lat * π/180)`.<br/>3. `mpp_mercator = (WORLD_MERC / TILE_PX) / 2^zoom`.<br/>4. `mpp_true = mpp_mercator * cos_lat`.<br/>5. `viewHeightTrueM = (canvasH/dpr) * mpp_true`.<br/>6. `altitude_true = viewHeightTrueM / 2 / tan(halfFov)`.<br/>7. Build perspective × translate(−altitude_true) × rotateX(−pitch) × rotateZ(bearing) — identical structure to `_buildRTCMatrix` (lines 207-258) but with true-metre altitude.<br/>8. Post-multiply by `ecefToENURotation(cam_lon, cam_lat)` (existing PR 2b primitive).<br/>9. Return `{matrix, far, logDepthFc}`. The far value derives from true-metre altitude via the same formula at `_buildRTCMatrix:198-205`.<br/><br/>**Backing-buffer discipline (architect P1 #8):** add `private rtcMatrixECEF = new Float32Array(16)` field on `Camera` — `getECEFFrameView` MUST own a separate backing buffer from `getFrameView`. JSDoc warning identical to `getFrameView:407-410`: caller must copy contents to its own uniform before any other `getECEFFrameView` call.<br/><br/>**Cache parity discipline (architect P1 #10):** the existing `_buildRTCMatrix` cache (`_cacheW/H/Dpr/Cx/Cy/Zoom/Bearing/Pitch/Far/invDirty/mvpGeneration` at `camera.ts:128-137, 277`) gates the legacy matrix build. The new build needs an equivalent. Implementation: bump `_mvpGeneration` whenever EITHER build reseats its matrix; both builds check a single `_cacheGeneration` counter. Per-build dirty flags (`_buildRTCMatrix` already has invDirty; `getECEFFrameView` adds `_invDirtyEcef`). Alternative: duplicate the 8-field cache as `_cacheEcef*`; same semantics, more code. Choose during implementation; document in `camera.ts` AGENTS.md. | Unit test `camera-ecef-mvp.test.ts`: instantiate camera at `{lon=0, lat=0, zoom=14}`, assert `getECEFFrameView` matrix equals `getFrameView` matrix to **0.01 px clip-space** across 1e3 random ECEF-RTC vertices in a z=14 tile (at lat=0, cos(0)=1, dual paths converge mathematically). Globe-mode bypass: `globeMode === true` returns the existing `_globeFrame` result (orbit camera owns its own math). Additional cache test: call `getECEFFrameView` + `getFrameView` interleaved 100× with unchanged camera state; assert ZERO matrix-mul work after the first call (cache-hit measurement). |
| AC2c.1.5 | **Latitude-spanning matrix-parity unit test** (Critic M-7). New test `polygon-ecef-mvp-latitude-parity.test.ts`. Across `lat ∈ {0, 30, 45, 60, 75, 85}` × `zoom ∈ {0, 4, 10, 18}` = 24 cells: take 1000 random Mercator-meter tile vertices, convert to ECEF via `mercatorToECEF`, apply both `getFrameView().matrix × mercatorVertex` (legacy path) and `getECEFFrameView().matrix × ecefVertex` (new path). Assert clip-space delta ≤ **0.5 px** in each cell. At lat=0 the delta is float-precision noise; at lat=85 it must still hold. Failure of any cell is HARD failure, no bucketing. | Vitest. AC2c.1.5. |
| AC2c.1.6 | Add `mvp_ecef: mat4x4f` field to polygon DSL `Uniforms` struct (`runtime/src/engine/shader-dsl/shaders/polygon.ts:43-65`). Field reserved but NOT read by any VS in PR 2c.1 (no polygon-shader changes here). Uniform-buffer size grows by 64 bytes. | tsc + uniform-layout-consistency.test.ts regen. |
| AC2c.1.7 | **Add `originBackend?: TileSource` field to `TileData`** at `runtime/src/data/tile-types.ts`. Populated by `TileCatalog.acceptResult` (`tile-catalog.ts:322` site) — the sink call has the backend reference via closure capture; thread it through. Existing tile-cache entries created before this PR ship with `undefined` (treated as "unknown origin"). | Unit test: register backend, accept a result, read back tile cache entry, assert `originBackend === backend`. Used by PR 2c.4. |
| AC2c.1.8 | `BackendTileResult.vertices` doc comment at `runtime/src/data/tile-source.ts:50-52` updated to acknowledge DSFUN-Mercator stride-5 is current; ECEF-DSFUN stride-7 lands in PR 2c.2. | Diff. |
| AC2c.1.9 | All existing tests pass. Mercator pixel-diff **byte-identical** (no runtime consumer yet). New `ecef-precision-fuzz.test.ts`, `polygon-ecef-mvp-latitude-parity.test.ts`, `camera-ecef-mvp.test.ts` green. | CI + pixel-diff. |

### PR 2c.2 — Polygon VS rewrite + retire-quantized + delete runtime re-quantize

The consumer of 2c.1's infrastructure. Single coupled change spanning shader DSL + tiler call site + runtime upload + GPU vertex layout.

| AC | Criterion | Verification |
|----|-----------|--------------|
| AC2c.2.1 | **Polygon DSL rewrite.** `runtime/src/engine/shader-dsl/shaders/polygon.ts`:<br/>- **KEEP `vs_main`** (architect-confirmed: this is the **LINE pipeline entry**, bound at `renderer.ts:822, 858` against `lineVertexBufferLayout`). Plan v1/v2 misread it as unused-polygon-legacy. Renaming to `vs_main_line` is optional clarity; not required for PR 2c.<br/>- DELETE `vs_main_quantized` (stride-8 quantized polygon entry, lines 272-358) — the production polygon entry that PR 2c.2 replaces.<br/>- DELETE `vs_main_quantized_extruded` (extruded stride-8 quantized polygon entry, lines 367-460) — replaced by the new extruded ECEF entry.<br/>- ADD `vs_main_ecef`: input attributes `pos_h: vec3<f32> @location(0)`, `pos_l: vec3<f32> @location(1)`, `feat_id: f32 @location(2)`, `abs_lon: f32 @location(3)`, `abs_lat: f32 @location(4)`. VS body: `let ecef_rtc = pos_h + pos_l; out.position = u.mvp_ecef * vec4(ecef_rtc, 1.0); …` — no `project_geom`, no `proj_globe`, no projType branch.<br/>- ADD `vs_main_ecef_extruded`: same flat-fill attributes + `face_normal: vec3<f32> @location(5)` + `wall_height: f32 @location(6)` (see AC2c.2.2 for the splitting of the v2-conflated "up_xyz" into FACE NORMAL — preserved from existing `z_attr.yzw` for MapLibre directional lighting — and separate wall-lift treatment). | Vitest `polygon.test.ts` + DSL drift-gate `_polygon-fixtures.ts` baselines regenerated (with snapshot-review gate per AC2c.2.10). New test `polygon-ecef-vs.test.ts` asserts WGSL emit contains `u.mvp_ecef *` exactly once per ECEF entry, no `project_geom` substring in the new entries (the surviving `vs_main` line entry CAN keep `project_geom` — it stays on Mercator-DSFUN until PR 2d).|
| AC2c.2.2 | **Extruded path: CPU wall lift at RUNTIME wall-mesh generator + face_normal preservation (architect P0 #5 + critic M-1 fix).** v2 conflated "ENU Up unit" with "face normal" — they're distinct vectors. The existing `extrudedZBufferLayout` slot at `renderer.ts:756-761` carries `vec4(z, nx, ny, nz)` where `(nx, ny, nz)` is the per-face **outward face normal** consumed by MapLibre directional lighting at `polygon.ts:466` (`dot(normal, LIGHT_POS)`). The face normal MUST be preserved.<br/><br/>**Module attribution (Critic M-1 fix):** wall lift happens at **runtime**, NOT at the compiler tiler. `runtime/src/core/polygon-mesh.ts:266` `generateWallMeshExtruded` already owns wall-mesh construction. It has access to `data.heights` (the per-feature height map plumbed through runtime style resolution; tiler is height-blind). PR 2c.2 extends `generateWallMeshExtruded` to accept a `tileEcefCenter` and emit DSFUN-ECEF + face_normal + wall_height + is_top vertex attributes directly — bypassing the deleted `quantizePolygonVerticesExtruded` step that used to consume its output.<br/><br/>**Per-vertex attributes for `vs_main_ecef_extruded` (stride-14 = 14 floats / 56 bytes; Critic M-2 + M-3 fix):**<br/>`pos_h(vec3) + pos_l(vec3) + feat_id(f32) + abs_lon(f32) + abs_lat(f32) + face_normal(vec3) + wall_height(f32) + is_top(f32)`<br/><br/>The `is_top: f32` (0 = bottom-ring wall vertex; 1 = top-ring wall vertex + roof vertex) discriminator preserves the existing `wall_blend` semantics at `polygon.ts:444` (`select(zWorld.gt(0), 1, 0)`) AND the `tTop` semantics at `polygon.ts:474`. After CPU lift, the vertex position itself no longer carries the "0 = bottom" sentinel that the old `z_attr.x` value carried — `is_top` restores it as an explicit role attribute. `wall_height` holds the feature's full height (used by `h_for_grad = max(zWorld, 1)` at `polygon.ts:479` for the vertical-gradient computation — under v3 the VS reads `wall_height` directly rather than `z_attr.x`).<br/><br/>The VS does NOT lift in shader — vertex positions are already at correct ECEF height. `face_normal` feeds the lighting `dot(normal, LIGHT_POS)` exactly as today. **No per-vertex Bowring in the VS.** Lift direction implicit in `lonLatToECEF(lon, lat, height)` (WGS84 ellipsoidal normal). | Unit test: random building footprint, assert top-ring ECEF height matches `lonLatToECEF(lon, lat, height)` to 1 mm; assert face_normal preserves wall/roof orientation (wall: dot with vertex-Up < 0.5; roof: dot with vertex-Up > 0.5); **assert is_top discriminator preserves wall_blend output (0 at wall-bottom, 1 at wall-top + roof) by re-emitting pre-PR `wall_blend` output via the new is_top path and diffing byte-exact**. |
| AC2c.2.3 | **Hemisphere-cull varying derivation.** The fragment-side hemisphere cull (`polygonCosCFragment`, `polygonRimAlpha` at `polygon.ts:129-159`) needs `abs_lon, abs_lat` varyings. Compute these on the CPU per vertex at `packECEFPolygonVertices` time. Per-vertex CPU cost: 1 atan2 + 1 log (Mercator inverse) per vertex at tile decode (worker-thread). **No per-vertex Bowring in the VS — eliminates the documented cross-vertex jitter risk.** | Unit test: assert abs_lon ∈ (-180, 180], abs_lat ∈ (-90, 90] for fuzzed input Mercator vertices; tolerances match `mercatorYToLat` round-trip. |
| AC2c.2.4 | **Vertex buffer layout change** at `runtime/src/engine/render/renderer.ts:734-761` for polygon. Replace stride-8 `uint16x2 + f32` (and the parallel stride-16 `extrudedZBufferLayout` slot) with:<br/>- **Flat-fill polygon:** `arrayStride: 36, attributes: [{loc=0, off=0, fmt=float32x3}, {loc=1, off=12, fmt=float32x3}, {loc=2, off=24, fmt=float32}, {loc=3, off=28, fmt=float32}, {loc=4, off=32, fmt=float32}]` — pos_h(12) + pos_l(12) + feat_id(4) + abs_lon(4) + abs_lat(4) = 36 bytes. Stride-9 floats.<br/>- **Extruded polygon (v4 — is_top added):** UNIFIED single buffer at `arrayStride: 56, attributes: […flat-fill attrs at loc 0..4…, {loc=5, off=36, fmt=float32x3}, {loc=6, off=48, fmt=float32}, {loc=7, off=52, fmt=float32}]` — adds face_normal(12) + wall_height(4) + is_top(4) = 56 bytes / 14 floats. The existing `extrudedZBufferLayout` slot (stride-16 vec4 z+normal at `renderer.ts:756-761`) is RETIRED — its contents fold into the unified layout with `is_top` as the new explicit roof/wall-bottom discriminator. | Layout-consistency test `vertex-layout-consistency.test.ts` regenerated against a documented schema-change checklist (see AC2c.2.10's review gate); arrayStride+attribute count match new WGSL @location list. |
| AC2c.2.5 | **Pipeline binding rewire (fail-loud grep guard).** Before rewiring, step 12 runs `grep -n "'vs_main_quantized'" runtime/src/engine/render/renderer.ts` and `grep -n "'vs_main_quantized_extruded'" runtime/src/engine/render/renderer.ts`; the result MUST be enumerated against an explicit allowlist captured in the PR body. Any hit not in the allowlist fails the PR. After grep pass, change `entryPoint: 'vs_main_quantized'` → `'vs_main_ecef'` and `'vs_main_quantized_extruded'` → `'vs_main_ecef_extruded'` at all hits. **Line pipelines at `:822, :858` are NOT touched** — they bind `vs_main` against `lineVertexBufferLayout` (architect P0 #4: preserved). | Build green; grep-guard captures all polygon pipeline sites; vertex-layout-consistency test confirms binding. |
| AC2c.2.6 | **DELETE runtime re-quantization for polygon.** Remove `quantizePolygonVertices` + `quantizePolygonVerticesExtruded` import and call sites at `vector-tile-renderer.ts:30-31, 2171, 2198, 2432, 2439`. The tiler now ships GPU-ready ECEF-DSFUN bytes; the runtime upload path writes them directly via `device.queue.writeBuffer`. Also delete `quantizePolygonVertices*` + `QUANT_POLY_STRIDE_BYTES` + `QUANT_POLY_RANGE` from `compiler/src/tiler/vector-tiler.ts:73-126` (the polygon quantizer is retired). Keep `packDSFUNPolygonVertices` if other callers exist (point path may still use it; check via grep at step time). | Build green; grep `quantizePolygonVertices` returns zero hits outside test fixtures. |
| AC2c.2.7 | Tiler `vector-tiler.ts:1411, 1623` `vertices: packDSFUNPolygonVertices(...)` swapped to `vertices: packECEFPolygonVertices(scratch.pv, tileEcefCenter)` where `tileEcefCenter = tileEcefCenterFromMerc(tileMx, tileMy)`. Same swap for `pointVertices` if applicable (read-time check; the point path may be unchanged in PR 2c). | Build green; tile-decode produces stride-9 (or stride-12 extruded) ECEF buffers. |
| AC2c.2.8 | **The new polygon (ECEF) entries read `u.mvp_ecef` ONLY.** The existing `u.mvp` field STAYS in the polygon Uniforms struct (architect P1 #6 clarification) — **`vs_main` (the LINE pipeline entry) is part of the same `emitPolygonWgsl` module and reads `u.mvp` via the shared `Uniforms` struct**. Deleting `u.mvp` would break line pipelines. Uniform writer uploads BOTH `u.mvp` (existing Mercator MVP via `getFrameView`) AND `u.mvp_ecef` (new ENU-metre MVP via `getECEFFrameView` from PR 2c.1). Marginal CPU cost: one extra matrix-build per frame. **Legacy non-polygon VSes — including the line VS sharing the polygon module — are NOT touched in PR 2c. PR 2d migrates them; at PR 2d closeout the legacy `u.mvp` deletes and `u.mvp_ecef` renames to `u.mvp`.** | Read uniform writer site; confirm both matrix builds; confirm zero edits to line/point/raster/text shaders. |
| AC2c.2.9 | **Pixel-diff harness** across Mercator/equirect/NE/ortho/azi/stereo/oblique/globe at `zoom ∈ {0,4,8,15}` × `pitch ∈ {0,45,75}` × explicit `centerLat ∈ {0,30,45,60,75,85}` for Mercator/equirect/NE (the cylindrical/pseudocyl set where polygon-ECEF interacts with legacy line/point at the same anchor). Total: ~96 cells base × 6 lat for cylindrical = ~200 cells. Acceptance: **≤ 0.5% pixel-delta ceiling** per memory `project_runtime_abstraction_h1a_h2a_2026_05_25` AC2.1 in every cell. Failure of any latitude cell at >0.5% is a HARD failure. | Pixel-diff harness. AC2c.2.9. |
| AC2c.2.10 | **Snapshot drift-gate review (architect P1 #11).** PR-C of Phase 2.5 (memory `project_shader_dsl_phase2_5_pr_c_2026_05_26`) established 7 byte-equal polygon-variant snapshots at `runtime/src/engine/shader-dsl/shaders/__polygon-variant-snapshots__/*.wgsl`. PR 2c.2 regenerates ALL of them (VS body rewrite + attribute layout change). **Regeneration MUST follow a documented diff review:** PR body includes a side-by-side diff of ONE representative snapshot (e.g. `positron-constant-d2cbaa49d118.wgsl`) annotated with each line-class of expected change (VS body rewrite for `vs_main_quantized`→`vs_main_ecef`, attribute @location list change, deletion of `vs_main_quantized_extruded` lighting compose, preservation of `vs_main` line entry). Unintended secondary changes (composer rewiring bugs, projection-funcs subtle shifts) MUST be called out and resolved before regeneration. Then all snapshots regenerate as a single atomic commit within PR 2c.2. | Vitest snapshot after manual diff review. PR body diff annotation. |
| AC2c.2.11 | CI render-gate (SwiftShader WebGPU under GitHub Actions) green; THE WGSL/GPU gate per memory `project_verification_gates_2026_05_25`. | `gh pr checks`. |
| AC2c.2.12 | Net memory cost recorded in PR body: +(36-8)=+28 bytes/vertex flat-fill, +(48-8 minus the retired stride-16 z buffer)/+24=+32 bytes/vertex extruded. Quantified for a 600-tile representative scene. | `git diff --stat` + benchmark fixture. |

### PR 2c.3 — Earth-surface fill mesh dispatch + `BackgroundRenderer` deletion

Independently revertible. The synthetic backend uses the polygon ECEF path that PR 2c.2 already shipped, so this sub-PR depends on 2c.2 landing but is revertible without affecting 2c.2.

| AC | Criterion | Verification |
|----|-----------|--------------|
| AC2c.3.1 | Add `SyntheticEarthSurfaceBackend` at `runtime/src/data/sources/synthetic-earth-surface-backend.ts` implementing `TileSource`. Single z=0 tile; `meta.scheme = 'web-mercator-xyz'`, `meta.layoutVersion = TILE_LAYOUT_VERSION` (= 1 in PR 2c.3, becomes 2 in PR 2c.4), `meta.bounds = world bounds`, `meta.minZoom = 0, maxZoom = 0`. Vertices computed from `generateEarthSurfaceFillMesh(widthSegments, heightSegments, band)` (`earth-surface-fill.ts:58`), then projected via `lonLatToECEF` per vertex, then `packECEFPolygonVertices(scratch.pv, tileEcefCenter=[0,0,0])` (world-center ECEF anchor — bg mesh is global, not tile-local).<br/><br/>**DSFUN precision note (architect P2 #7):** anchoring at ECEF origin means vertex magnitudes are ~6.378M metres. DSFUN hi-half precision = `6.4e6 × 2⁻²³ ≈ 0.76 m` (vs ~3e-4 m for normal tile-anchored vertices — 2500× coarser). Acceptable for a 32×16 mesh where adjacent grid cells span ~1200 km (0.76 m / 1.2e9 mm = invisibly fine). **Revisit if mesh density escalates beyond 64×32** — at higher densities the hi-half quantization could start to show. Document in Risks. | Unit test: instantiate, call `loadTile(0)`, assert `acceptResult` is called with `BackendTileResult` whose vertex count = (32+1)*(16+1) = 561 verts, index count = 32*16*6 = 3072. |
| AC2c.3.2 | **Mesh density** = 32×16 from PR 2c-prep's `earth-surface-fill.ts` lower bound. **Pre-mortem scenario 4 (Critic M-8):** under horizon-grazing camera angles (high pitch on sphere projections), the 32×16 grid cell may subtend visible screen pixels and look polygonal. Recovery plan: if pixel-diff at z=0 ortho pitch=80 shows visible facets >2 px, escalate mesh density to 64×32 (parametrized as a constructor arg on `SyntheticEarthSurfaceBackend`; cheap — 561 → 2145 verts is still trivial). | Pixel-diff fixture at z=0 ortho pitch=80 specifically scripted in PR 2c.3 step 24. |
| AC2c.3.3 | Backend auto-attached by `XGISMap` constructor when a `background { fill: ... }` style block exists. Layer inserted at sort-order 0 (= first show in the first opaque group, ahead of every real tile). The style background-color is applied via standard polygon fill path (`fs_fill` with `u.fill_color` = the bg colour). | Pixel test: OFM-bright at z=0 ortho projection now renders the bg colour curved inside the world disc, not as a flat strip. Diff vs spec screenshot in `.omc/specs/deep-dive-bg-flat-not-projection-curved.md`. |
| AC2c.3.4 | `layer_depth_offset = -0.0001` on the synthetic earth-surface layer. **Log-depth math (Critic P2 #9):** at z=22 + pitch=85, far ≈ 8.6 km, `fc = 1/log2(8601) ≈ 0.0765`, dz_ndc/dw ≈ 1.28e-5/m, so a 0.0001 NDC shift ≈ 7.8 m equivalent depth — well behind any real tile. At z=0 (far ~2e7 m), 0.0001 NDC ≈ 33 km equivalent depth. **Caveat:** synthetic mesh on WGS84 ellipsoid surface, real tiles on Mercator-projected-sphere; the two surfaces differ by ~21 km polar flattening. **Recovery:** if z-fight reproduces at lat=85 + pitch=80 + z=18 ortho, increase to -0.001 (still negligible at low z; conservative). | Manual test at high-lat ortho high-pitch scene. |
| AC2c.3.5 | DELETE `runtime/src/engine/render/background-renderer.ts` (301 LOC) and all call sites: `host.backgroundRenderer` field on render-loop's PassHost type, the `if (host.backgroundRenderer)` block at `opaque-pass.ts:140-150`, the `BackgroundRenderer` import + instantiation at `map.ts:1525-1526`, the `host.backgroundRenderer.setMvp/setCamCenter` calls, the bundle-stats aggregation at `render-loop.ts:535-539`. Also delete `runtime/src/engine/shader-dsl/shaders/background.ts` (subsumed by polygon DSL). Public API `XGISMap.setBackgroundFill` reroutes to `synth.updateFillColor(rgba)`. | Grep `BackgroundRenderer\|backgroundRenderer\|emitBgWgsl\|background\.ts` outside `.omc/`, `docs/`, `tests/` returns zero. Build green. |
| AC2c.3.6 | Opaque-pass `clearValue: { r: 0, g: 0, b: 0, a: 1 }` "no world here" pure-black sentinel **preserved** (iter-196 contract per memory). | Read opaque-pass.ts: clearValue line untouched. |
| AC2c.3.7 | Debug-overdraw mode (`?debug=overdraw`) still renders bg as one accumulator increment per fragment. The standard polygon path supports `fs_overdraw` already; synthetic backend dispatch routes through the normal debug-overdraw pipeline. Verify in PR 2c.3. | Manual `?debug=overdraw` test. |
| AC2c.3.8 | Net LOC delta: between -250 and -350 (delete 301 LOC bg-renderer + ~50 LOC call sites; add ~100 LOC synthetic backend). Recorded in PR body. | `git diff --stat`. |

### PR 2c.4 — `TILE_LAYOUT_VERSION` 1 → 2 + catalog mismatch eviction + originBackend-aware eviction

Independently revertible. Uses the `TileData.originBackend` field shipped in PR 2c.1.

| AC | Criterion | Verification |
|----|-----------|--------------|
| AC2c.4.1 | `runtime/src/data/tile-source.ts:138` `TILE_LAYOUT_VERSION = 1 as const` → `2 as const`. JSDoc updated. | Diff. |
| AC2c.4.2 | All 4 existing `TileSource` backends + the new `SyntheticEarthSurfaceBackend` populate `meta.layoutVersion = TILE_LAYOUT_VERSION` (= 2). `VirtualCatalogAdapter` proxies via lazy-getter (mirror Phase 1b's `meta.scheme` pattern). | Grep `meta.layoutVersion =` returns 5 hits. |
| AC2c.4.3 | `TileCatalog.attachBackend` reads `backend.meta.layoutVersion` after `mergeBackendMeta`. If `backend.meta.layoutVersion !== undefined && backend.meta.layoutVersion !== TILE_LAYOUT_VERSION`:<br/>(i) invoke `evictTilesForBackend(backend)`,<br/>(ii) emit one-shot `xlog.warn("[X-GIS] tile-layout-version mismatch for source N: cached=N, running=M — evicting cache + re-decoding")`,<br/>(iii) leave the backend attached (re-fetch on next visible frame).<br/>On `undefined`, treat as `TILE_LAYOUT_VERSION_BASE = 1` and evict if `TILE_LAYOUT_VERSION > 1`. | Unit test `tile-catalog-layout-version-eviction.test.ts`: (a) backend with mismatch evicts; (b) undefined treated-as-base evicts when current > 1; (c) version match no-eviction. |
| AC2c.4.4 | `evictTilesForBackend(backend: TileSource): void` private method on `TileCatalog`. **Iterates `dataCache` (`tile-catalog.ts:65`), checks `entry.originBackend === backend` (the field from PR 2c.1 AC2c.1.7), and drops matching entries.** Reuses existing budget-eviction infrastructure but with backend-identity predicate. Lazy-discovery backends (PMTiles, GeoJSON, synthetic) are now correctly evictable because the `originBackend` reverse pointer exists. | Unit test (AC2c.4.3 covers). |
| AC2c.4.5 | **Cache-attribution backfill.** Existing tile-cache entries created before PR 2c.1 (e.g., in user browser caches) have `originBackend = undefined`. Catalog treats `undefined` originBackend as "any backend" for eviction purposes — i.e., on a layoutVersion mismatch for backend B, both backend-B-attributed entries AND undefined-attributed entries get evicted. The undefined entries cover the gap during the rollout window where old cached tiles predate PR 2c.1. After 24-48h user cache rotation, all entries carry origin attribution. | Manual test: pre-PR cache + post-PR build, observe eviction includes pre-PR entries on mismatch. |
| AC2c.4.6 | **Eviction storm mitigation (Critic Pre-mortem scenario 3).** Post-eviction re-fetches go through the standard `MAX_CONCURRENT` budget at `tile-catalog.ts` (existing) — eviction does NOT bulk-dispatch. Manual UX check: pre-PR cache loaded into post-PR build, observe re-decode completes within ~200 ms; no console errors. | Manual. |
| AC2c.4.7 | All four sub-PRs landed: build green, full vitest green, render-gate CI green, pixel-diff envelope honored across the 200-cell harness. **Closeout tracking issue created (Critic m-4):** PR 2c.4 body MUST open a tracking issue (GitHub or repo-local) titled `"Phase 2 closeout: retire dual-MVP at PR 2d final sub-PR"` referencing the Phase 2 CLOSEOUT MILESTONE in Follow-ups. Without this tracking artifact, the dual-MVP residency risks becoming permanent infrastructure ("Dual models" predictability sink per memory `project_predictability_sinks`). | Final CI + issue URL in PR body. |

## Implementation Steps

Sequential per sub-PR.

| # | Sub-PR | Step | Verify |
|---|--------|------|--------|
| 1 | 2c.1 | Add `packECEFPolygonVertices` + `tileEcefCenterFromMerc`. Add `ecef-precision-fuzz.test.ts`. | Vitest. AC2c.1.1, AC2c.1.3. |
| 2 | 2c.1 | Add `getECEFFrameView` to `camera.ts`. Add `camera-ecef-mvp.test.ts` (equator-baseline). | Vitest. AC2c.1.4. |
| 3 | 2c.1 | Add `polygon-ecef-mvp-latitude-parity.test.ts` (24-cell latitude × zoom matrix). | Vitest. AC2c.1.5. |
| 4 | 2c.1 | Add `mvp_ecef: mat4x4f` field to polygon DSL Uniforms; regenerate layout-consistency baselines. | Vitest. AC2c.1.6. |
| 5 | 2c.1 | Add `originBackend?: TileSource` to `TileData`; thread through `acceptResult`. | Vitest. AC2c.1.7. |
| 6 | 2c.1 | Update `BackendTileResult.vertices` doc comment. | Diff. AC2c.1.8. |
| 7 | 2c.1 | Mercator pixel-diff byte-identical (no consumer). | Pixel-diff. AC2c.1.9. |
| 8 | 2c.1 | Open PR 2c.1, CI green, merge to feature branch. | `gh pr checks`. |
| 9 | 2c.2 | Polygon DSL: delete vs_main, vs_main_quantized, vs_main_quantized_extruded; add vs_main_ecef + vs_main_ecef_extruded. | Vitest `polygon.test.ts`. AC2c.2.1. |
| 10 | 2c.2 | **Compiler tiler** (`vector-tiler.ts`): extend `packECEFPolygonVertices` to compute abs_lon + abs_lat per vertex → stride-9 floats. Flat-fill only. **Runtime wall-mesh** (`polygon-mesh.ts`): add `generateWallMeshExtrudedECEF` taking `(polygons, heights, tileEcefCenter)` → stride-14 floats including face_normal + wall_height + is_top. Module boundary per "Module boundaries" subsection above. | Unit tests for both modules. AC2c.2.2, AC2c.2.3. |
| 11 | 2c.2 | Renderer.ts: replace polygon vertex layouts (stride-8 → stride-36 flat, stride-48 extruded). Delete `extrudedZBufferLayout`. | Layout test. AC2c.2.4. |
| 12 | 2c.2 | Rewire all polygon pipeline bindings (~20 sites) to `vs_main_ecef` / `vs_main_ecef_extruded`. | Build. AC2c.2.5. |
| 13 | 2c.2 | Delete `quantizePolygonVertices*` runtime imports + call sites in `vector-tile-renderer.ts:30-31, 2171, 2198, 2432, 2439`. Delete `quantizePolygonVertices*` + `QUANT_POLY_STRIDE_BYTES` + `QUANT_POLY_RANGE` from tiler/`polygon-mesh.ts`. **KEEP `packDSFUNPolygonVertices` exported** (still used at `vector-tiler.ts:1420, :1632` for `pointVertices`; point migration is PR 2d). Verify by grep at end-of-step that `packDSFUNPolygonVertices` references include only `pointVertices` consumers + test files. | Grep. AC2c.2.6. |
| 14 | 2c.2 | Tiler `:1411, :1623`: swap `packDSFUNPolygonVertices` → `packECEFPolygonVertices`. Pass `tileEcefCenter`. | Build. AC2c.2.7. |
| 15 | 2c.2 | Polygon uniform writer site: build BOTH `u.mvp` (existing) AND `u.mvp_ecef` (new); upload both per frame. | Read site. AC2c.2.8. |
| 16 | 2c.2 | Polygon DSL baselines regenerated. | Snapshot. AC2c.2.10. |
| 17 | 2c.2 | Run latitude-spanning pixel-diff harness (~200 cells); gate ≤ 0.5% delta. | Harness. AC2c.2.9. |
| 18 | 2c.2 | Render-gate CI green. | `gh pr checks`. AC2c.2.11. |
| 19 | 2c.2 | Record memory cost in PR body. | `git diff --stat`. AC2c.2.12. |
| 20 | 2c.2 | Open PR 2c.2, CI green, merge. | `gh pr checks`. |
| 21 | 2c.3 | Add `SyntheticEarthSurfaceBackend`. | Unit. AC2c.3.1. |
| 22 | 2c.3 | Wire auto-attach in `XGISMap` constructor; layer at sort-order 0. | Unit. AC2c.3.3. |
| 23 | 2c.3 | DELETE `background-renderer.ts`, `shader-dsl/shaders/background.ts`, all call sites. | Grep + build. AC2c.3.5. |
| 24 | 2c.3 | High-pitch z=0 ortho pixel-diff fixture: verify no visible 32×16 facets; escalate to 64×32 if delta > 2 px. | Pixel-diff. AC2c.3.2. |
| 25 | 2c.3 | Verify opaque-pass clearValue preserved. | Read. AC2c.3.6. |
| 26 | 2c.3 | Debug-overdraw mode renders correctly. | Manual. AC2c.3.7. |
| 27 | 2c.3 | LOC delta in PR body. | `git diff --stat`. AC2c.3.8. |
| 28 | 2c.3 | Open PR 2c.3, CI green, merge. | `gh pr checks`. |
| 29 | 2c.4 | Bump `TILE_LAYOUT_VERSION 1 → 2`. | Diff. AC2c.4.1. |
| 30 | 2c.4 | Populate `meta.layoutVersion = TILE_LAYOUT_VERSION` on all 5 backends. | Grep. AC2c.4.2. |
| 31 | 2c.4 | Implement `attachBackend` version check + `evictTilesForBackend` (using `originBackend`) + `xlog.warn`. | Unit. AC2c.4.3, AC2c.4.4. |
| 32 | 2c.4 | Manual cache-mismatch UX check. | Manual. AC2c.4.6. |
| 33 | 2c.4 | Full vitest + render-gate + pixel-diff harness. | All gates. AC2c.4.7. |
| 34 | 2c.4 | Open PR 2c.4, CI green, merge. | `gh pr checks`. |

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| AC2c.1.5 latitude-spanning matrix-parity test fails at high lat. | Low (math derivation in v2 is correct under dual-MVP) | High (blocks PR 2c.2) | Recovery: re-derive `getECEFFrameView` from the broken cell's coordinate frame; if `mpp_true × cos(lat)` is wrong direction, sign-flip and re-run. If the perspective matrix needs near/far adjustment for true-metre altitude, recompute. The 24-cell unit test catches the failure before the polygon VS lands. |
| Polygon ECEF retire-quantized = +20 bytes/vertex memory cost. Mobile GPU memory pressure. | Medium | Medium (mobile fps regression) | Documented Phase 2f as quantized-ECEF design optimisation. PR 2c.2 ships with the retire. If mobile testing surfaces frame-budget regression in PR 2c.2 step 17, defer the retire (revert) and consider per-tile per-axis ECEF quantization (Phase 2f early). |
| Extruded polygon path's per-vertex Up unit + abs_lon + abs_lat packing adds CPU cost at tile decode. MVT worker pool saturates. | Low-Medium | Medium | The per-vertex `atan2 + log + lonLatToECEF` adds ~100 ns/vertex at tile decode. On a 1000-vert/tile × 50-tile-decode/sec rate that's 5 ms/sec — sub-1% worker CPU. Profile in PR 2c.2 step 17; if hot, batch-vectorize the lat/lon→ECEF (Phase 2f optimisation). |
| Synthetic earth-surface mesh density 32×16 shows visible facets at horizon-grazing camera angles (Critic Pre-mortem #4). | Medium | Low (visible aesthetic) | AC2c.3.2 + step 24 explicitly tests this; escalate to 64×32 if needed. Cheap. |
| Bowring iteration cross-vertex jitter in shared-edge varyings (Critic Pre-mortem #5). | Low (now moot — abs_lon/abs_lat computed on CPU at tile decode, not in VS) | N/A | v2 design eliminates per-vertex VS Bowring inversion entirely (AC2c.2.3). |
| `TileData.originBackend` reverse pointer adds 1 pointer per cache entry. Memory pressure on large caches. | Low | Low | 8 bytes × ~5000 cache entries = 40 KB. Negligible. |
| Cache-mismatch eviction storm at PR 2c.4 deploy. | Medium | Medium-Low | Mitigated by AC2c.4.6 — post-eviction re-fetches go through standard `MAX_CONCURRENT` budget. Manual test in step 32 confirms ~200 ms re-decode UX. |
| Pre-PR cache entries with `undefined` originBackend get evicted "too eagerly" on first version-mismatch attach. | Low | Low (one-shot only) | AC2c.4.5 documents the intentional behaviour. After first user load, all entries carry origin attribution; subsequent eviction is precise. |
| PR 2c.2 + PR 2c.1 coupled revert direction. PR 2c.2 alone is solo-revertible (restores polygon Mercator-DSFUN + runtime re-quantize). PR 2c.1 alone reverts pure additive scaffolding. | N/A | — | Honestly documented in Revertibility Matrix; not a Principle 4 contradiction. |
| Polygon vertices grow to stride-9/12 floats. Test fixtures + serialisation paths that bake stride constants regress. | Medium | Medium | AC2c.0 (in v1) replaced by upfront list in Open Questions; tests + fixtures get explicit step entries: `dsfun-precision-fuzz.test.ts` (test only — superseded by `ecef-precision-fuzz.test.ts`), `compile-tile-invariants.test.ts`, `vertex-layout-consistency.test.ts`, `polygon-fill-vs-stroke-alignment.test.ts`, `polygon-mesh.test.ts`, `cross-validation.test.ts`, `_polygon-fixtures.ts`. Migration list in step 9 prereqs. |
| `vs_main` (DSFUN stride-5 polygon entry) was never bound — but other modules MAY have referenced it as an importable symbol. Deletion breaks downstream consumers. | Low | Low | Grep `vs_main` usages outside the polygon DSL file; if any non-test consumer exists, escalate before AC2c.2.1 lands the deletion. |
| Memory `project_runtime_abstraction_h1a_h2a_2026_05_25` flagged byte-identity as INFEASIBLE under H1a Tier-3 work due to bucketed pixel-survey + ancestor-LRU non-determinism. PR 2c.2 risks same. | High (acknowledged) | Medium | We do NOT chase byte-identity. Gate is render-gate CI + pixel-diff harness with explicit 0.5% delta ceiling. |

## Verification Steps

### Per sub-PR
- **PR 2c.1:** `bunx vitest run runtime/src/engine/projection compiler/src/tiler` — new fuzz + matrix-parity tests green. Mercator pixel-diff byte-identical. `bunx tsc -p compiler/tsconfig.json --noEmit && bunx tsc -p runtime/tsconfig.json --noEmit` clean.
- **PR 2c.2:** Polygon snapshot baselines regenerate cleanly. `bunx vitest run` green. Matrix-parity 24-cell test green. ~200-cell pixel-diff harness ≤ 0.5% delta. Render-gate CI green. Memory cost noted.
- **PR 2c.3:** Grep `BackgroundRenderer\|backgroundRenderer\|emitBgWgsl` outside `.omc/`, `docs/`, `tests/` returns zero. Build green. z=0 ortho/azi/stereo/globe bg-curve pixel-diff vs spec screenshot. Mesh-density facet test green (escalate to 64×32 if needed). Debug-overdraw mode correct. LOC delta in PR body.
- **PR 2c.4:** Catalog eviction unit tests green. Manual cache-mismatch re-decode under ~200 ms. Full vitest + render-gate green. Pixel-diff envelope holds.

### Aggregate
1. `bunx vitest run` — full suite green.
2. `bun run build` — typecheck clean. Bundle size delta < 5 KB gzipped vs pre-PR baseline (BackgroundRenderer deletion offsets new tiler routines).
3. Render-gate CI green on final merge.
4. Pixel-diff envelope at ≤ 0.5% across the latitude-spanning fixture set.
5. New memory `project_phase2_pr2c_ecef_migration.md` describing the landed migration + dual-MVP design + retire-quantized rationale.

### Rollback procedure
- **PR 2c.4 revert:** `TILE_LAYOUT_VERSION` back to 1; eviction logic + per-backend `meta.layoutVersion` deleted. No functional regression. `originBackend` field stays (added in 2c.1).
- **PR 2c.3 revert:** Restore `BackgroundRenderer` + `background.ts`. Bg colour back to flat-strip on sphere projections (intentional regression-to-known-state pending re-attempt).
- **PR 2c.2 revert:** Polygon VS back to `vs_main_quantized`; vertex layout back to stride-8; runtime re-quantize restored. Mercator-DSFUN polygon path resumes. PR 2c.1's `getECEFFrameView`, `packECEFPolygonVertices`, `originBackend` field, and `mvp_ecef` uniform slot stay dormant — no regression.
- **PR 2c.1 revert:** Pure additive scaffolding deleted. No regression.

**No two sub-PRs are coupled-must-revert-together in v2.** PR 2c.2 + PR 2c.1 are coupled in landing direction (2c.1 ships infrastructure 2c.2 uses), but 2c.2 reverts solo correctly.

---

## RALPLAN-DR Summary (Deliberate mode, iteration 2)

### Principles
1. **Source-honest at the vertex level** — polygon tile vertices encode ECEF Cartesian metres (geographic 3D), not a projection-baked approximation. The projection becomes purely a clip-space transform via `u.mvp_ecef`.
2. **One projection branch per frame, not per vertex** — `project_geom`-equivalent computation happens once on the camera anchor (`getECEFFrameView` build, sub-µs CPU). Hot-path GPU cost: one linear matrix multiply per vertex.
3. **Reference convergence (Cesium / 3D Tiles 1.1 / NASA 3DTilesRendererJS)** — ECEF + WGS84 ellipsoid is the industry-standard. Adopting it now unlocks future 3D Tiles interop without a second migration.
4. **Minimum reversible step (honest)** — split PR 2c into 4 sub-PRs. 3 of 4 are independently revertible. PR 2c.2 + PR 2c.1 are coupled in *landing direction* (2c.1 supplies what 2c.2 uses) but 2c.2 reverts solo cleanly. The Revertibility Matrix documents this.
5. **No byte-identity claim** — memory `project_runtime_abstraction_h1a_h2a_2026_05_25` documented Tier 3 ECEF cannot satisfy byte-identity. Replaced with explicit ≤ 0.5% pixel-delta envelope across a latitude-spanning fixture set + CI render-gate as THE WGSL/GPU gate.
6. **BackgroundRenderer deletion is a net architectural simplification** — 301 LOC → ~100 LOC synthetic backend reusing standard tile pipeline. Resolves the spec-anchored "bg flat, not projection-curved" defect as a side effect.
7. **Cache invalidation is part of the migration** — `TILE_LAYOUT_VERSION` bump WITH the eviction logic AND the `originBackend` reverse pointer that makes the eviction actually implementable for lazy-discovery backends.
8. **Dual-MVP, not legacy-VS-rewriting** (v2 addition) — polygon ECEF lives in `u.mvp_ecef`; legacy line/point/raster/text VSes keep reading `u.mvp` unchanged. PR 2c does NOT touch legacy shaders. PR 2d migrates them with the same dual-MVP scaffolding already in place.

### Decision Drivers
1. **User-explicit Tier 3 ECEF target** — Phase 1 ADR Follow-ups + memory `project_runtime_abstraction_h1a_h2a_2026_05_25`.
2. **Spec-anchored visible defect** — `.omc/specs/deep-dive-bg-flat-not-projection-curved.md` resolves as side-effect.
3. **Phase 2 scaffolding amortisation** — PRs 2a/2b/2c-prep have no consumer until PR 2c; landing it makes prior investment load-bearing.
4. **Critic-confirmed math correctness** — dual-MVP design fixes the sec(φ) scale defect from v1. Latitude-spanning fixture set catches regressions at every latitude.
5. **Critic-confirmed vertex path map** — production polygon is `packDSFUNPolygonVertices → quantize on upload → vs_main_quantized stride-8`. Plan v2 chooses Option (a) retire-quantized and ships stride-7 ECEF DSFUN directly.

### Viable Options (v2 reconsideration)

**Option A — Monolithic single PR 2c.** Same as v1. Rejected for same reason: 1000+ LOC review surface, revert risk.

**Option B — Dual-MVP 4-sub-PR split (CHOSEN).**
- Pros: Matrix correctness via separate ENU-metre MVP; legacy VSes untouched; sub-PRs honestly revertible; latitude-spanning verification gates.
- Cons: +64 bytes/uniform-write per polygon frame; mild CPU cost of dual matrix-build.
- **Chosen.**

**Option C — Keep `BackgroundRenderer` alive; only migrate polygon VS to ECEF + matrix.**
- Pros: Smaller PR 2c scope (3 sub-PRs); avoids destructive BG deletion in this phase.
- Cons: Defers visible spec-anchored defect; synthetic backend has no other Phase 2/3 consumer.
- **Re-evaluated honestly per Critic M-6:** the de-risking benefit is REAL (BG deletion is destructive and Phase 2c.3 is its own integration test surface). However, the SyntheticEarthSurfaceBackend is small (~100 LOC), shares the polygon ECEF pipeline that 2c.2 already validates, and its revert is independent — so the per-PR risk surface of bundling it into PR 2c.3 is not materially higher than deferring it. The spec-anchored defect is **user-visible today** (the deep-dive spec is referenced multiple times in the AGENTS.md). Keep bundled.
- **Acknowledged but not chosen.** The "destructive blast radius" worry is valid in principle but bounded in scope (single feature deletion + replacement, independent revert).

**Option D — Quantized ECEF (u16×3 tile-local) instead of f32×3 + f32×3 DSFUN.**
- Pros: Smaller vertex buffer (~12 bytes vs 28 bytes per vertex).
- Cons: ECEF tile-extent is not axis-aligned with ECEF X/Y/Z; per-tile per-axis quantization range varies; needs per-tile dequant uniform; multi-day design work. Per-axis u16 quantization on a non-axis-aligned domain wastes precision.
- **Deferred to Phase 2f** (explicit). The Phase 2c thesis is correctness, not memory; pairing is honest in v2.

**Option E (new in v2) — Rebuild legacy MVP to ENU-metre semantics globally.**
- Pros: Single MVP serves all VSes; legacy VSes converted to ENU-metre over time naturally.
- Cons: Touches every legacy VS (line/point/raster/text) in PR 2c → bloats scope to PR 2c + 2d combined. Most invasive option; high risk.
- **Rejected** — violates Principle 8 (Dual-MVP avoids touching legacy VSes in PR 2c).

### Invalidation Rationale
- A rejected — review surface + revert risk.
- C acknowledged-but-not-chosen — de-risking benefit is small; spec-anchored defect is user-visible.
- D deferred to Phase 2f — design work too large for PR 2c.
- E rejected — scope creep.

### Pre-mortem (deliberate mode, 5 scenarios)

**Scenario 1 — Latitude-spanning matrix-parity test fails at high lat.**
*Cause:* `getECEFFrameView` math derivation has a sign error or wrong-direction scale factor. The 24-cell unit test (AC2c.1.5) catches it.
*Detection:* CI fail on PR 2c.1.
*Recovery:* Re-derive the build; common pitfall is using `sec(lat)` instead of `cos(lat)` for the altitude scale conversion. Single-day fix.

**Scenario 2 — `BackgroundRenderer` deletion regresses an undocumented call site.**
*Cause:* Some test fixture, build artifact, or public-API re-export consumes `BackgroundRenderer` outside the audited `host.backgroundRenderer` access pattern.
*Detection:* Grep audit + build check in PR 2c.3.
*Recovery:* `git revert PR 2c.3`; PR 2c.3 is independently revertible per Revertibility Matrix.

**Scenario 3 — `TILE_LAYOUT_VERSION` bump triggers re-decode storm.**
*Cause:* All cached sources evict simultaneously; MVT worker pool saturates.
*Detection:* Manual UX test in PR 2c.4 step 32.
*Recovery:* AC2c.4.6 documents the standard `MAX_CONCURRENT` budget gating. If still hot, defer eviction to lazy first-visible-tile rather than attach-time (single-line change in `attachBackend`).

**Scenario 4 — Synthetic mesh density 32×16 shows visible polygonal facets at horizon-grazing camera angles.**
*Cause:* Per-grid-cell angular size at horizon exceeds visual smoothness threshold.
*Detection:* AC2c.3.2 + PR 2c.3 step 24 (pixel-diff fixture at z=0 ortho pitch=80).
*Recovery:* Escalate `widthSegments × heightSegments` from 32×16 to 64×32 (constructor arg on `SyntheticEarthSurfaceBackend`; 561 → 2145 vertices is still trivial). Document the new lower bound in `earth-surface-fill.ts`.

**Scenario 6 — CPU wall-lift saturates MVT worker pool on high-density extruded scenes (Critic m-5).**
*Cause:* `lonLatToECEF(lon, lat, height)` runs per wall-mesh vertex at runtime tile-decode (`generateWallMeshExtrudedECEF`). NYC OFM building tile at z=15 carries ~100 features × ~50 verts/feature × 2 (top + bottom rings) = ~10,000 `lonLatToECEF` calls per tile. At ~50 ns/call (1 atan2 + 1 sqrt + 6 mul) → ~0.5 ms/tile. At 50 tile-decodes/sec → 25 ms/sec = 2.5% worker CPU. Manhattan-density edge case at 5000-vert features ratchets up to ~25 ms/tile.
*Detection:* Mobile testing in PR 2c.2 step 17 (Manhattan z=15 pitch=60 fixture; worker-pool CPU profile via dev tools).
*Recovery:* Batch-vectorize `lonLatToECEF` over the wall ring (compute lat-band trig once, reuse for all longitudes in the ring → ~5× speedup). If still hot, hoist height-independent ECEF work to pre-pack (CPU baseline ECEF computed in `packECEFPolygonVertices` flat-fill step) and only add the height-dependent radial offset at wall-mesh time → ~3× additional speedup. Bench fixture lives at `runtime/src/core/polygon-mesh.bench.ts` (deferred to Phase 2f if not needed in PR 2c).

**Scenario 5 — Polygon ECEF retire-quantized causes mobile GPU memory pressure.**
*Cause:* +20 bytes/vertex × 600K verts/scene = +12 MB GPU memory per heavy scene. Some mobile devices saturate, frame budget regresses.
*Detection:* Mobile testing in PR 2c.2 step 17 (latitude-spanning pixel-diff harness includes mobile fixtures via the existing dev-https mobile pipeline per memory `project_pbf_glyph_bearingy_2026_05_22`).
*Recovery:* If saturation observed, accelerate Phase 2f quantized-ECEF design work; meanwhile defer PR 2c.2's retire-quantized (revert step 13 only) and design a hybrid where polygon-ECEF DSFUN-stride-7 + per-axis u16 quantization runs in parallel. Multi-week design slip vs visible memory regression — the latter is worse, but the trigger threshold matters.

### Expanded Test Plan (deliberate mode)

#### Unit (new)
- `compiler/src/tiler/ecef-precision-fuzz.test.ts` — 1e4 random Mercator points across z∈{0,8,15,22}; reconstruction within 1 mm @ z=22, 1 cm @ z=0.
- `runtime/src/engine/projection/ecef.test.ts` — extend PR 2a test: `tileEcefCenterFromMerc` round-trip.
- `runtime/src/engine/projection/camera-ecef-mvp.test.ts` — `getECEFFrameView` equator-baseline equals `getFrameView` to 0.01 px clip-space.
- `runtime/src/engine/projection/polygon-ecef-mvp-latitude-parity.test.ts` — **24-cell latitude × zoom** matrix-parity at lat∈{0,30,45,60,75,85} × zoom∈{0,4,10,18}; 1000 verts/cell; ≤ 0.5 px clip-space.
- `runtime/src/engine/shader-dsl/shaders/polygon-ecef-vs.test.ts` — DSL emit contains `u.mvp_ecef *` exactly once per VS entry; no `project_geom` substring in polygon module.
- `runtime/src/data/synthetic-earth-surface-backend.test.ts` — `loadTile(0)` round-trip: 561 verts (or 2145 if 64×32 escalation), 3072 indices.
- `runtime/src/data/tile-catalog-layout-version-eviction.test.ts` — mismatch eviction (per-backend via originBackend), undefined treated-as-base, match no-eviction.
- `runtime/src/data/tile-data-origin-backend.test.ts` — `TileData.originBackend` populated correctly for all 4 backend types + synthetic.

#### Integration
- Pixel-diff harness across 8 projections × 4 zooms × 3 pitches × **6 latitudes for cylindrical/pseudocyl** = ~200 fixtures. Baselines regenerate per sub-PR. Envelope: ≤ 0.5% pixel-delta per cell.
- OFM-bright z=0 ortho/azi/stereo/globe: bg now curved (new fixture baselines, shipped with PR 2c.3).
- Translucent buildings (OIT path) Mercator z=17 pitch=68 Liberty: ≤ 0.3% delta.
- 3D extruded fill Mercator z=15 pitch=60 Manhattan: ≤ 0.3% delta.
- **Mesh-density facet fixture** (PR 2c.3): z=0 ortho pitch=80 lat=0 — synthetic earth-surface looks smooth, no polygonal facets visible at >2 px scale.

#### E2E
- Live demo: pre-PR cache + post-PR build → re-decode completes within ~200 ms; no console errors.
- Live demo: projection switch Mercator → globe → ortho → NE; bg colour follows world band on every projection.
- Live demo: pinch zoom at z=0 ortho — sphere bg stays inside disc throughout gesture.

#### Observability
- `xlog.warn` on `TILE_LAYOUT_VERSION` mismatch (one-shot per source).
- New stats counter `bgFillDispatched` on the synthetic backend (debug-only, exposed via `XGISMap.getStats()`).
- New per-frame dual-MVP build stats counter `mvpBuildCount` to verify the dual build is fired exactly once per frame (catches accidental re-builds at the uniform writer site).
- Render-gate CI logs per-fixture pixel-delta.

#### Bundle size
- Pre-PR baseline captured. Post-PR delta < 5 KB gzipped. Recorded in final aggregate PR (PR 2c.4 body).

---

## ADR

**Decision:** Land PR 2c as **4 sequential sub-PRs** with a **dual-MVP architecture**:
- **PR 2c.1** — Tiler ECEF pack + `getECEFFrameView` CPU build + `mvp_ecef` uniform slot + `TileData.originBackend` field. Pure additive.
- **PR 2c.2** — Polygon DSL ECEF VS + retire-quantized for polygon path + delete runtime re-quantize. Coupled with 2c.1 in landing, solo-revertible.
- **PR 2c.3** — `SyntheticEarthSurfaceBackend` + `BackgroundRenderer` deletion. Independent.
- **PR 2c.4** — `TILE_LAYOUT_VERSION 1 → 2` + catalog mismatch eviction (per-backend via `originBackend`). Independent.

**Drivers:**
- User-explicit Tier 3 ECEF migration target.
- Spec-anchored visible defect resolves as side-effect.
- Phase 2 scaffolding amortisation.
- Critic-confirmed math correction (dual-MVP avoids sec(φ) scale error).
- Critic-confirmed vertex path map (production = `packDSFUNPolygonVertices` + runtime re-quantize + `vs_main_quantized`).
- Critic-confirmed `originBackend` reverse pointer requirement.

**Alternatives considered:**
- **A (monolithic):** rejected — review + revert risk.
- **C (defer BG deletion, polygon only):** acknowledged-but-not-chosen — de-risk benefit small vs visible spec-anchored defect.
- **D (quantized ECEF):** deferred to Phase 2f — multi-day design work.
- **E (rebuild legacy MVP globally):** rejected — scope creep.

**Why chosen (v2):**
The dual-MVP architecture solves the v1 sec(φ) scale-factor defect mathematically (true-ENU-metre MVP built on CPU with explicit `cos(lat)` altitude conversion) AND structurally (legacy VSes never touched in PR 2c). Retire-quantized for the polygon path is honest — the production code's quantization step is identified, the +20 bytes/vertex memory cost is documented and bounded, the future-Phase-2f quantized-ECEF design path is reserved. The 4-sub-PR split satisfies Principle 4 with a Revertibility Matrix that doesn't lie. `TileData.originBackend` makes the catalog eviction actually implementable for lazy-discovery backends (PMTiles, GeoJSON, synthetic).

**Consequences:**
- Polygon GPU hot path: one matrix multiply, no projection branching.
- Legacy line/point/raster/text VSes untouched in PR 2c — their migration is PR 2d, with the dual-MVP scaffolding already in place.
- `BackgroundRenderer`'s 301 LOC + `shader-dsl/shaders/background.ts` deleted; bg becomes one more polygon layer dispatched through standard pipeline.
- `TILE_LAYOUT_VERSION` ships first actual transition; users with caches see one-shot re-decode + `xlog.warn`.
- Per-frame uniform-write count grows by 1 (the dual MVP). Sub-µs CPU cost.
- ECEF Cartesian + WGS84 ellipsoid is now the canonical polygon vertex space. Phase 3 (EPSG:4326 backend) and Phase 4 (S2 cube-sphere) reuse the same vertex format.
- `TileData.originBackend` enables per-backend cache attribution; reuses pattern when Phase 3 adds non-Mercator backends.

**Follow-ups:**
- **PR 2d (line/point/raster/text ECEF):** migrate remaining VSes; each sub-PR mirrors PR 2c.2's shape on a different shader. Dual-MVP scaffolding already in place.
- **PR 2e (reprojector + `_back-compat` retire):** delete `reprojector.ts` + retire polygon DSL's `_back-compat` field after 22-consumer migration.
- **PR 2f (quantized ECEF):** u16×3 per-tile-axis quantization for polygon. Saves ~64% vertex memory. Independent of 2d/2e.
- **Phase 2 CLOSEOUT MILESTONE (mandatory, post-PR 2d) — architect deliberate-mode requirement:** when the last legacy VS migrates to ECEF (end of PR 2d), the dual-MVP residency MUST end. Polygon Uniforms struct's `u.mvp` field DELETES; `Camera.getFrameView` DELETES; `_buildRTCMatrix` DELETES; all VSes consume `u.mvp_ecef` which RENAMES to `u.mvp` at that point. **Without this commit, dual-MVP becomes a permanent predictability sink (memory `project_predictability_sinks`: "Dual models").** PR 2d's final sub-PR includes the closeout as a tracked AC.
- **Phase 3 (EPSG:4326 backend):** adds `'epsg-4326-quadtree'` to `TileScheme` union.

---

## Open Questions

1. **Confirmed (was Q1 in v1): polygon vertex path is `packDSFUNPolygonVertices` (tiler) → `quantizePolygonVertices*` (runtime upload at `vector-tile-renderer.ts:2171/2198/2432`) → stride-8 GPU → `vs_main_quantized`.** v2 deletes the runtime quantization for polygon ECEF.
2. **`packDSFUNPolygonVertices` may still be used by point path** (vector-tiler.ts:1420 `pointVertices: packDSFUNPolygonVertices(scratch.ptv, …)`). Verify at PR 2c.2 step 13 — if so, keep `packDSFUNPolygonVertices` exported; only the polygon call site swaps.
3. **`getECEFFrameView` cache scope:** PR 2b made `getECEFCenter()` derive-per-call. Same convention applies to `getECEFFrameView` in PR 2c.1 — per-frame build, no class field caching. PR 2d may revisit if many more callers materialize.
4. **Pre-PR cache entries with `undefined` originBackend** — AC2c.4.5 documents the rollout behaviour (treated as "any backend" for eviction). Confirm acceptable UX in step 32.

---

## Changelog

- **v4 (this iteration — Critic re-review APPROVED-WITH-IMPROVEMENTS at v3; 3 MAJOR + minors applied):**
  - **M-1 fix (wall-lift module attribution):** AC2c.2.2 + step 10 rewritten — wall lift lives at **runtime `polygon-mesh.ts:generateWallMeshExtrudedECEF`**, not at the compiler tiler. The tiler is height-blind by design (grep confirmed zero `heights|extrude` references in `vector-tiler.ts`). New "Module boundaries" subsection enumerates the compiler/runtime split.
  - **M-2 fix (`is_top` discriminator for roof/wall-bottom):** Per-vertex extruded layout grows to stride-14 / 56 bytes with explicit `is_top: f32` (0 = wall-bottom, 1 = wall-top + roof). Preserves `wall_blend` (`polygon.ts:444`) and `tTop` (`polygon.ts:474`) semantics after CPU lift removes the implicit `zWorld>0` discriminator.
  - **M-3 fix (stride math):** AC2c.2.4 extruded stride 52 → 56 bytes / 13 → 14 floats; @location list extends to loc 0..7.
  - **m-1 (cache parity discipline):** kept the choice but pointed at the existing `_mvpGeneration` counter at `camera.ts:277` as the natural shared-counter implementation.
  - **m-3 (synthetic precision threshold boundary):** AC2c.3.2 + AC2c.3.1 now cross-link; the 64×32 escalation point precisely matches the "revisit precision" threshold — boundary case explicitly documented.
  - **m-4 (closeout tracking enforcement):** AC2c.4.7 requires opening a Linear/GitHub tracking issue titled `"Phase 2 closeout: retire dual-MVP at PR 2d final sub-PR"` in PR 2c.4's body — prevents the "Dual models" predictability sink from becoming permanent.
  - **m-5 (CPU-wall-lift perf pre-mortem):** New Scenario 6 covers `lonLatToECEF` per-vertex cost at high-density extruded scenes; documented detection + 2-stage recovery (batch-vectorize, height-independent hoist).
  - **m-6 (`packDSFUNPolygonVertices` keep guard):** Step 13 explicitly preserves `packDSFUNPolygonVertices` exported for `pointVertices` consumers; deletion deferred to PR 2d.
  - **Module Boundaries subsection** added (compiler vs runtime split with table).
  - **Point migration decision** locked: stays on Mercator-DSFUN in PR 2c per Principle 8.

- **v3 (Architect re-review feedback applied):**
  - **P0 #4 fix (`vs_main` preservation for line VS):** Architect grep confirmed `vs_main` is the LINE pipeline entry at `renderer.ts:822, 858`, NOT unused-polygon-legacy. AC2c.2.1 rewritten: KEEP `vs_main` (line VS); only delete the `vs_main_quantized*` polygon entries.
  - **P0 #5 fix (face_normal preservation for MapLibre extrude lighting):** Architect identified that v2 conflated "ENU Up unit" with "per-face outward NORMAL" — different vectors. The face normal at `z_attr.yzw` feeds `dot(normal, LIGHT_POS)` for MapLibre directional lighting (memory `project_extrude_lighting_2026_05_20`). v3 design: **lift walls on CPU at tile-decode** (top-ring vertices pre-positioned at correct ECEF height); per-vertex attribute set becomes `pos_h + pos_l + feat_id + abs_lon + abs_lat + face_normal(vec3) + wall_height(f32)` = stride-13 / 52 bytes. Extruded `extrudedZBufferLayout` retired into unified buffer; face_normal preserved verbatim.
  - **P1 #6 fix (`u.mvp` rationalization):** AC2c.2.8 rewritten — `u.mvp` STAYS because `vs_main` (line VS) reads it from the shared polygon module `Uniforms` struct. The original "BackgroundRenderer's deletion" rationale was wrong; the actual reason is the shared module.
  - **P1 #8 fix (separate Float32Array backing):** AC2c.1.4 adds `private rtcMatrixECEF` field requirement + JSDoc warning matching `getFrameView:407-410`.
  - **P1 #10 fix (cache parity):** AC2c.1.4 specifies dual-cache discipline (shared `_cacheGeneration` counter OR duplicated `_cacheEcef*` fields; choose during implementation). Unit test asserts cache-hit on stationary camera.
  - **P1 #11 fix (DSL snapshot drift-gate review):** AC2c.2.10 requires PR-body annotated diff of one representative snapshot before regeneration. Catches secondary changes that bulk-regeneration would mask.
  - **P2 #7 fix (synthetic backend DSFUN precision note):** AC2c.3.1 acknowledges ~0.76 m hi-half precision at ECEF origin (2500× coarser than tile-anchored); revisit threshold documented.
  - **P2 #12 fix (binding grep guard):** AC2c.2.5 + step 12 add fail-loud grep guard before rewiring.
  - **Phase 2 closeout milestone (architect consensus):** Follow-ups section adds mandatory dual-MVP retirement at PR 2d closeout — prevents "Dual models" predictability sink from becoming permanent infrastructure.
  - Pre-mortem Scenario 4 (extruded lighting regression) implicitly addressed by P0 #5 fix.

- **v2 (Architect + Critic feedback applied):**
  - **P0 #1 fix (matrix composition):** Replaced `getRTCMatrix() × ecefToENURotation()` with a **separate `getECEFFrameView` CPU build in true-ENU-metre semantics**. Explicit `cos(lat)` altitude conversion. New uniform `u.mvp_ecef` on polygon shader only. Legacy `u.mvp` untouched. Legacy VSes (line/point/raster/text) NOT edited in PR 2c.
  - **P0 #2 fix (vertex path map):** Dropped the AC2c.0.1 "discovery audit" framing. Production polygon path confirmed = `packDSFUNPolygonVertices` → runtime re-quantize → stride-8 → `vs_main_quantized`. PR 2c.2 chooses **Option (a) retire-quantized** and ships stride-7 ECEF DSFUN directly from tiler to GPU. Quantized-ECEF deferred to Phase 2f.
  - **M-3 fix (originBackend):** Added `TileData.originBackend` field in PR 2c.1; `evictTilesForBackend` uses it.
  - **M-4 fix (PR 2c.3 misframing):** Dropped misframed v1 PR 2c.3 (OIT/translucent matrix). v2 sub-PR count is 4. OIT/translucent passes need NO code change (they share polygon's uniform writer); confirmed by `oit-pass.ts:32-67`, `translucent-pass.ts:23-66` reads zero `u.mvp` direct access.
  - **M-5 fix (Principle 4 contradiction):** Added Revertibility Matrix. 3-of-4 sub-PRs independently revertible; PR 2c.2 reverts solo cleanly (additive scaffolding from 2c.1 becomes dormant). Rollback procedure rewritten to match.
  - **M-6 fix (Option C analysis):** Re-evaluated Option C honestly. De-risk benefit acknowledged; bundling rationale strengthened (synthetic backend is small + spec-anchored defect is user-visible).
  - **M-7 fix (latitude-spanning tests):** Added `polygon-ecef-mvp-latitude-parity.test.ts` with explicit 24-cell lat × zoom matrix. Pixel-diff harness fixtures expanded to ~200 cells covering lat∈{0,30,45,60,75,85} for cylindrical/pseudocyl projections.
  - **M-8 fix (pre-mortem expansion):** Added Scenario 4 (synthetic mesh density facets) + Scenario 5 (now moot — abs_lon/abs_lat moved to CPU per-vertex pack at tile decode, NO Bowring inverse in VS).
  - Eliminated per-vertex VS Bowring inversion entirely: `abs_lon`, `abs_lat`, `up_xyz` (extruded) all computed CPU-side at tile decode and packed as vertex attributes. Stride grows from 7 → 9 (flat) → 12 (extruded). Memory cost documented.
  - Architect P2 #9 (log-depth math): explicit derivation at AC2c.3.4; `-0.0001` confirmed conservative; high-lat ortho test added.
  - Vector-tiler quantization import deletions enumerated (`quantizePolygonVertices`, `quantizePolygonVerticesExtruded`, `QUANT_POLY_STRIDE_BYTES`, `QUANT_POLY_RANGE`).

- **v1 (initial Planner draft):** Initial draft with sec(φ) error and DSFUN-vs-quantized audit deferral; rejected by Critic.
