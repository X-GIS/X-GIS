<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-05-22 | Updated: 2026-05-22 -->

# projection

## Purpose
Camera math and the seven map projections. `projection.ts` is the CPU side: `mercator`, `equirectangular`, `naturalEarth`, `orthographic`, `azimuthalEquidistant`, `stereographic`, `obliqueMercator` (projType 0–6) — each a `{ forward, inverse }` pair used for tile selection, bounds, and label anchoring. `globe.ts` adds the SEPARATE true-3D sphere mode (projType 7). `camera.ts` owns zoom/pan/bearing/pitch, the MVP matrix, and log-depth FC. The GPU does projection in-shader (WGSL); the CPU-side mirror of those WGSL functions is now GENERATED from the shader DSL (`../shader-dsl/cpu-projections.ts`, lowered from the IR in `../shader-dsl/projections.ts`) and the automated parity check compares it against the CPU formulas. (The hand-maintained `projection-wgsl-mirror.ts` was deleted — see `../shader-dsl/AGENTS.md`.)

## Key Files
| File | Description |
|------|-------------|
| `projection.ts` | CPU forward/inverse for all 7 projections + `MERCATOR_LAT_LIMIT`, `getProjection`. Inverse fns hold an "in-range or NaN" contract (guard div-by-zero at antipode). |
| `camera.ts` | `Camera` — zoom/pan/bearing/pitch, MVP, meters-per-pixel, log-depth FC (`computeLogDepthFc`), `buildGlobeMatrix` hookup. **Phase 2 PR 2b** added `getECEFCenter()` + `getECEFToENURotation()` — read-only accessors that derive the ECEF anchor and ENU tangent-plane rotation from the canonical Mercator-metre `centerX, centerY` per call. ECEF is NEVER cached on the class; pan/zoom/hash-restore/interaction all keep mutating `centerX, centerY` as the single source of truth. Phase 2 PR 2c+ shader paths compose `getRTCMatrix() × getECEFToENURotation()` to consume ECEF-RTC vertices without rewriting the existing perspective MVP. |
| `globe.ts` | True-3D globe (projType 7) — real sphere with pitch as orbit, vs the flat 2D azimuthal discs (3/4/5) that "lay on their side" when pitched. |
| `../shader-dsl/cpu-projections.ts` | GENERATED cpu-f64 mirror of WGSL `proj_*` (`projectWgsl`, `projectGeomWgsl`, …) — replaces the deleted `projection-wgsl-mirror.ts`. Lowered from `../shader-dsl/projections.ts`; the parity check pins CPU `projection.ts` against it. |
| `ecef.ts` | **Phase 2 PR 2a (scaffolding).** WGS84 ellipsoid ECEF (Earth-Centered Earth-Fixed) coordinate math. `lonLatToECEF` / `mercatorToECEF` / `ecefToLonLat` / `dsfunSplitECEF` — feeds the Tier 3 ECEF vertex pipeline once VSes drop `project_geom` and become `mvp * vec4(ecef_rtc, 1)`. No runtime consumer yet (Phase 2 PR 2c is the first; the polygon VS is the first migration target). |
| `earth-surface-fill.ts` | **Phase 2 PR 2c-prep (scaffolding).** Lat/lon-grid mesh generator that will replace `BackgroundRenderer` once Phase 2 PR 2c flips the polygon VS to ECEF. `worldBandForProjType(projType)` resolves the per-projType band (Mercator/cyl clamped at ±85°, NE oval, sphere ±90°). `generateEarthSurfaceFillMesh(w, h, band)` emits a minimum-32×16 lat/lon triangle strip in row-major order with CCW winding. Data only — no shader inlines and no runtime consumer yet. |

## For AI Agents

### Working In This Directory
- **CPU↔GPU parity is the central contract here and a documented recurring bug class.** `engine/shaders/projection.ts` (WGSL) is the source of truth; the generated cpu-f64 lowering (`../shader-dsl/cpu-projections.ts`, from `../shader-dsl/projections.ts`) mirrors it in TS; `projection.ts` is the CPU implementation. A formula change touches the WGSL string + the DSL graph (which regenerates the cpu mirror) + `projection.ts` (Mercator clamp, Natural Earth poly, ortho back-face have each drifted before).
- Flat azimuthal projections (ortho/azimuthal/stereo, 3/4/5) are correct 2D projections — do not "fix" their pitch behavior; the true globe is projType 7 in `globe.ts`.
- Inverse functions must return NaN (not garbage) outside their valid domain — tile selection relies on the "in-range or NaN" contract.
- z=0 + high-pitch and polar/dateline tile selection are known open weak spots; verify against the projection e2e suite, not just unit math.

### Testing Requirements
- Extensive: `projection-wgsl-consistency.test.ts` (CPU `projection.ts` ↔ generated cpu-f64 parity), `projection-forward-edge.test.ts`, `projection-inverse-roundtrip.test.ts`, `camera*.test.ts` (fuzz, z0-probe, coverage), `globe*.test.ts`, `log-depth.test.ts`, `mercator-clamp.test.ts`, `oblique-mercator-tile-mismatch.test.ts`, `polar-tile-pyramid-gap.test.ts`, `world-copy-projection.test.ts`. Add a parity test for any new/changed projection.

### Common Patterns
- `{ name, forward, inverse }` projection objects; antipode/div-by-zero guards; DSFUN-friendly meter outputs; log-depth FC computed from the far plane.

## Phase 2 ECEF migration audit (PR 2a deliverables)

### Encode-site enumeration
The vertex encode site that PRs 2c/2d/2e will rewrite is **`compiler/src/tiler/vector-tiler.ts`** (+ helpers + types). `compiler/src/codegen/shader-gen.ts` is NOT involved — it generates shader code, not vertex layout. The Phase 2 v1/v2 plan misfiled this; v3 onward corrects it. Hot path also includes:
- `compiler/src/tiler/vector-tiler-helpers.ts`
- `compiler/src/tiler/vector-tiler-types.ts`
- GeoJSON path routes through the same `vector-tiler.ts` (via `VirtualPMTilesBackend` → geojsonvt → MVT → tiler; memory `project_geojson_mvt_unification_decision`).
- MVT worker (`runtime/src/data/workers/mvt-worker*`) consumes tiler output, no runtime encode.

### Tile-cache invalidation surface (AC2.11)
Audit finding: **no schema/layout version field exists today in `runtime/src/data/`**. Grep confirms zero hits for `XGVT_SCHEMA_VERSION`, `TILE_VERSION`, `cacheVersion`, etc. Eviction is byte-budget-based only (`MAX_CACHED_BYTES` + `evictTiles` at `tile-catalog.ts:97-148`). Phase 2 PR 2c must therefore ADD a version field — proposed `TILE_LAYOUT_VERSION` constant + per-source meta version that the catalog compares on attach. On version mismatch, the catalog evicts cached tiles for that source and triggers re-decode. PR 2c owns the addition; PR 2a documents the audit.

### Earth-surface fill design spec (AC2.3)
Phase 2 PR 2c replaces `BackgroundRenderer` with a synthetic ECEF earth-surface fill quad dispatched through the standard opaque tile pipeline. Design contract:
- **Mesh density:** minimum 32×16 lat/lon grid. 4-corner quad is INSUFFICIENT — under sphere VS it stays a planar rectangle, not a curved disc. Density may rise after a globe-disc visual audit in PR 2c; lower bound locked at 32×16.
- **World-band geometry per projType:**
  - Mercator / equirect / oblique_mercator: ±180° lon × ±MERCATOR_LAT_LIMIT (±85.0511°) lat rectangle.
  - Natural Earth: NE polygon-band clipped to NE valid extent.
  - Orthographic / Azimuthal Equidistant / Stereographic / Globe: ±180° × ±90° sphere band, source-honest at the poles.
- **Dispatch site:** synthetic `TileSource` backend is the preferred path (leverages existing catalog/pipeline; consistent with the Phase 1b `TileScheme` model). Renderer-level inject is fallback if the synthetic backend approach turns out to add catalog complexity > the BackgroundRenderer deletion savings — decided concretely at PR 2c.
- **Sort order:** layer 0 of the opaque pass — painted behind every real tile. Real tiles paint on top via the standard pipeline.
- **clearValue contract preservation:** opaque-pass `clearValue` stays pure black `{r:0,g:0,b:0,a:1}` (iter-196 contract — `runtime/src/engine/render/passes/opaque-pass.ts:86-100` documents the "no world here" sentinel that MapLibre parity depends on). bg color only paints INSIDE the world band; outside it shows the black clearValue through.

## Dependencies

### Internal
- `loader/geojson` (`lonLatToMercator`), `gpu/gpu-shared` (`WORLD_MERC`, `TILE_PX`), `gpu/gpu` (DPR), `shaders/log-depth`.

### External
- None (pure math).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
