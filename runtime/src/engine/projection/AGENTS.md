<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-03 -->

# projection

## Purpose
Camera math and the full 8-surface projection system for X-GIS. Holds CPU forward/inverse pairs for projTypes 0–7, the `PROJECTIONS` table (single authority for all projType→capability mappings), the flat-path RTC MVP + log-depth camera, the true 3D globe orbit camera with ray–sphere interaction and sphere-cap tile selection, and pure matrix utilities shared across the above. The ECEF vertex pipeline (wired across compiler + runtime) re-exports its math from `@xgis/shared` through `ecef.ts` so neither package duplicates the ellipsoid implementation. `earth-surface-fill.ts` ships the lat/lon mesh generator for the synthetic earth-surface background (no runtime consumer yet; Phase 2 PR 2c).

## Key Files
| File | Description |
|------|-------------|
| `projection.ts` | CPU forward/inverse for projTypes 0–6 (`mercator`, `equirectangular`, `natural_earth`, `orthographic`, `azimuthal_equidistant`, `stereographic`, `oblique_mercator`). Exports `MERCATOR_LAT_LIMIT` (85.051129°, canonical across all CPU sites), `mercatorYToLatRad`/`mercatorYToLat` (single source, formerly inlined at ~22 sites), `wrapLonDelta`, and `getProjection` registry. Inverse functions hold a strict "in-range or NaN" contract. |
| `projections-table.ts` | `PROJECTIONS` ordered record array — index == projType == shader `proj_params.x`. Per-row fields: `cullThreshold`, `rimThreshold`, `isFlat`, `isSeam`, `isCylindrical`, `isGlobe`, `periodic`, `worldCopies`, `worldBand` (`WorldBandKind`). Exports derived predicates `worldCopiesFor`, `enumerateWorldCopies`, `routeToSphereSelector`, `promotesToGlobeWhenTilted`, `isGlobeProj`, `worldBandForProjType`, `flatViewHeightCapM`, `PROJECTION_NAME_TO_TYPE`, `SELECTOR_PROJ_NAMES`, `WORLD_COPIES`, `WORLD_COPY_MAX_ZOOM`. `gpu-shared.ts` re-exports from here — authority inversion complete. Known latent gap: oblique_mercator (6) sphere-routes tiles but is excluded from `promotesToGlobeWhenTilted` (cylindrical) — flat MVP + sphere tiles at pitch>0. |
| `camera.ts` | `Camera` class. State: `centerX`/`centerY` (Web Mercator metres, single source of truth), `zoom`, `bearing`, `pitch` (NaN guard + `pitchLocked` for azimuthal discs), `globeMode`, `globeOrtho`, `projType`, `azimuthalProjType`. Builds flat RTC MVP via `_buildRTCMatrix`; dispatches to `buildGlobeMatrix` for globe/promoted-azimuthal paths. `getECEFCenter()` and `getECEFToENURotation()` derive the ECEF anchor per-call from Mercator coords — ECEF is never cached on the class. |
| `globe.ts` | True 3D sphere path (projType 7 + azimuthal-promoted 3/4/5). `globeForward`/`globeInverse` (lon/lat ↔ ECEF sphere, lon=0,lat=0→+X; east→+Y; north→+Z), `buildGlobeMatrix` (orbit camera, perspective or telephoto-parallel `ortho` mode for the azimuthal set), `unprojectGlobe` (ray–sphere intersection for pan/zoom), `globeVisibleTiles` (sphere-cap quadtree descent with per-frame memo, distance-LOD, overzoom geographic-footprint fallback, SoA stack). `GLOBE_PROJ_TYPE=7`, `EARTH_R=6378137`, `MAX_TILES=300`. |
| `ecef.ts` | Thin `export * from '@xgis/shared'` — re-exports all ECEF/WGS84 math (`lonLatToECEF`, `mercatorToECEF`, `ecefToLonLat`, `dsfunSplitECEF`, etc.) so every existing `./ecef` import path in the runtime stays stable after the authority moved to shared. |
| `earth-surface-fill.ts` | `generateEarthSurfaceFillMesh(w, h, band)` — lat/lon triangle-strip mesh generator (min 32×16 grid, CCW winding) for the synthetic earth-surface background. Re-exports `worldBandForProjType` + `WorldBandKind` from `projections-table`. No runtime consumer yet (Phase 2 PR 2c placeholder). |
| `camera-helpers.ts` | Pure helpers shared by `camera.ts` and `globe.ts`. Azimuthal disc inverses `invOrthographic` / `invAzimuthalEquidistant` / `invStereographic` (Snyder sphere inverses matched to the `projection.ts` forwards, limb/antipode-clamped) + `discAnchorFor` (projType-keyed `{inv, safeRho}` dispatch for zoomAt's disc geo-anchor — keeps `projType ===` out of camera.ts). Column-major 4×4 matrix utilities `mulVec4`, `mul4`, `perspectiveMatrix`, `invert4x4`. |

## For AI Agents

### Working In This Directory
- **CPU↔GPU parity is the central contract.** The WGSL `proj_*` functions in `runtime/src/engine/shaders/projection.ts` are the GPU source of truth; `projection.ts` is the CPU mirror. Any formula change touches both + the DSL graph in `../shader-dsl/projections.ts` (which regenerates the cpu-f64 lowering at `../shader-dsl/cpu-projections.ts`). Mercator clamp, Natural Earth polynomial, and ortho back-face cull have each drifted before — `projection-wgsl-consistency.test.ts` pins parity.
- **`projections-table.ts` is the authority for all projType→capability relationships.** Never hand-encode `projType===0||1||2||6` branches in consumers — read the table predicates. `projections-table.test.ts` pins every row field to its intended literal; `projection-threshold-drift.test.ts` pins the emitted WGSL thresholds to `cullThreshold`.
- Flat azimuthal projections (ortho/azi/stereo, 3/4/5) are correct 2D projections. Pitch on those surfaces promotes to the true globe (projType 7) via `promotesToGlobeWhenTilted`. The `pitchLocked` flag on `Camera` prevents a flat-disc camera from accepting pitch. Do not "fix" their pitch behavior.
- Inverse functions must return NaN (not garbage) outside their valid domain — tile selection and interaction rely on the "in-range or NaN" contract.
- `ECEF` is never stored on `Camera`; it is derived per-call from `centerX`/`centerY`. Pan/zoom/hash-restore all mutate the Mercator-metre fields only.
- `globeVisibleTiles` has a per-call memo keyed on all inputs (toFixed precision). Do not add state the key doesn't cover, or the cache will serve stale tiles.
- Known open bugs: oblique_mercator at pitch>0 (flat MVP + sphere tiles, deferred); z=0+high-pitch Mercator perspective strip; antimeridian seam flicker (water polygon T-junction, user-deferred).

### Testing Requirements
45 test files in this directory. Key suites: `projection-wgsl-consistency.test.ts` (CPU `projection.ts` ↔ generated cpu-f64 parity — must pass on any formula change), `projections-table.test.ts` (row-by-row literal pins), `projection-threshold-drift.test.ts` (WGSL threshold pins), `projection-forward-edge.test.ts` + `projection-inverse-roundtrip.test.ts`, `camera.test.ts` + `camera-fuzz.test.ts` + `camera-coverage.test.ts` + `camera-ecef.test.ts` + `camera-ecef-mvp.test.ts` + `camera-z0-probe.test.ts` + `camera-transition-smoothness.test.ts`, `globe.test.ts` + `globe-deep-zoom-probe.test.ts` + `globe-z0-focal-tile.test.ts`, `mercator-clamp.test.ts` + `mercator-lat-limit.test.ts`, `oblique-mercator-tile-mismatch.test.ts` + `oblique-6-promotion.test.ts` + `oblique-polar-tearing.test.ts`, `polar-tile-pyramid-gap.test.ts`, `world-copy-projection.test.ts` + `visible-world-copies.test.ts`, `antimeridian-routing.test.ts` + `_antimeridian-seam-coincidence.test.ts`, `earth-surface-fill.test.ts`, `surface-geoid-unification.test.ts`, `interaction-contract-gates.test.ts`, `extruded-globe-recenter.test.ts`, `point-anchor-pitch-consistency.test.ts`, `ecef-vertex-camera-frame.test.ts`. Add a parity test for any new/changed projection formula.

### Common Patterns
- `{ name, forward, inverse }` projection objects; antipode/div-by-zero guards return NaN or centre point.
- All ECEF helpers imported from `./ecef` (which re-exports `@xgis/shared`) — do not copy-paste ellipsoid math locally.
- Column-major 4×4 matrices throughout; `camera-helpers.ts` has the shared ops.
- `flatViewHeightCapM(projType, worldMercM)` from `projections-table` is the single policy for the flat-path z0 view-height cap.

## Dependencies

### Internal
- `../gpu/gpu-shared` (`WORLD_MERC`, `TILE_PX`, derived predicates re-exported from `projections-table`)
- `../gpu/gpu` (`getMaxDpr`)
- `../shaders/log-depth` (`computeLogDepthFc`)
- `../../loader/geojson` (`lonLatToMercator`)
- `@xgis/shared` (ECEF math, via `ecef.ts` re-export)

### External
- None (pure math; zero npm dependencies).

<!-- MANUAL: notes below this line are preserved on regeneration -->
