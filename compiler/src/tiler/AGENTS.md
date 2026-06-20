<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-03 -->

# tiler

## Purpose
The data-side of the compiler: compiles GeoJSON into a pyramid of GPU-ready vector tiles (COG-style overview levels) with no GPU dependency. The pipeline is: decompose GeoJSON features into per-part `GeometryPart` objects with tight bounding boxes (MultiPolygons split per polygon to reduce tile scatter), clip geometry to tile bounds (Sutherland-Hodgman V1 or geojson-vt-ported range-clip V2), Douglas-Peucker simplify in Mercator meters, earcut-tessellate polygons in MM, then pack vertices into one of three GPU-ready layouts: quantized ECEF RTC (polygons, stride 24 bytes: u16×6 position + f32 fid/lon/lat), DSFUN stride-10 (lines + polygon outlines), or DSFUN stride-9 (points, absolute ECEF). Tile addresses use a Morton Z-order `tileKey` (z≤22, f64-safe). Also provides: great-circle geodesic densification for lines (slerp, capped at 1° per sub-segment), zigzag-delta-varint coordinate encoding for compact storage, the in-memory tile-index structures shared with the runtime `TileCatalog`, and a single-source-of-truth vertex format registry so CPU packers and GPU shader locations cannot drift.

The `geojsonvt/` subdirectory contains a 1:1 TypeScript port of mapbox/geojson-vt plus an MVT/PBF encoder (see `geojsonvt/AGENTS.md`).

## Key Files
| File | Description |
|------|-------------|
| `vector-tiler.ts` | Tiler orchestrator. `compileGeoJSONToTiles(Async)` + `compileSingleTile` (now a thin per-geometry dispatcher, Tier-C5 split), `decomposeFeatures`, per-tile tile math, backtrack-repair probe. Emits `CompiledTileSet`/`CompiledTile`. Re-exports tile-key helpers + types from the split files. |
| `polygon-tiler.ts` / `line-tiler.ts` / `point-tiler.ts` | Per-geometry compile concerns split out of `compileSingleTile` (Tier-C5): clip + earcut tessellation + great-circle subdivision (polygon), segment build (line), point assembly. They IMPORT the shared byte-contract packers (`packECEF*`, DSFUN quant, `polygon-vertex-format`) — those stay shared, never inlined/forked (CPU↔WGSL vertex contract). |
| `vector-tiler-types.ts` | Type/interface declarations extracted from `vector-tiler.ts`: `CompiledTile`, `CompiledTileSet`, `TileLevel`, `GeometryPart`, `PropertyTable`, `TilerOptions`, `FeatureIdResolver`. |
| `vector-tiler-helpers.ts` | Side-effect-free Morton Z-order tile-key helpers: `mortonEncode/Decode`, `tileKey`, `tileKeyUnpack`, `tileKeyParent`, `tileKeyChildren`. Hot-path optimized (z-order accumulation loop, avoids `Math.pow` in tight loops). |
| `polygon-vertex-format.ts` | Single source of truth for the quantized ECEF polygon vertex layout (`POLYGON_FILL_FORMAT`, `POLYGON_EXTRUDED_FORMAT`). Uses `buildFormat` so stride and byte offsets are computed, not hand-copied, preventing packer-vs-shader drift. |
| `vertex-format.ts` | Generic vertex format infrastructure: `buildFormat`, `field`, `VertexFormat`, `VbFormat`, `WgslType`, `VB_FORMAT_BYTES`. Lives in compiler so runtime shader-DSL and compiler packers share one source. |
| `dequant-mirror.ts` | CPU mirrors of the GPU `dequant_ecef` WGSL function: `dequantVertex` (f64, quantization error only) and `dequantVertexF32` (Math.fround models GPU f32 arithmetic). Also `mulMat4Vec4F32` for the MVP clip-parity gate. Used in compute parity tests. |
| `clip.ts` | Polygon + line clipping against axis-aligned tile bounds. Sutherland-Hodgman V1 (`clipPolygonToRect`), geojson-vt range-clip V2 (`clipPolygonToRectV2`), Liang-Barsky line clip (`clipLineToRect`), and `splitBoundaryBacktracks` — splits self-touching rings earcut would triangulate with 2.5× coverage (Korea z=7 canonical case). |
| `simplify.ts` | Douglas-Peucker simplification with locked-vertex support (boundary vertices survive to keep adjacent tiles seamless). `simplifyPolygon`, `simplifyLine`, `toleranceForZoom` (degrees), `mercatorToleranceForZoom` (Mercator meters). |
| `encoding.ts` | ZigZag-delta-varint coordinate encoding for compact tile storage. `precisionForZoom` / `precisionForZoomMM`, encode/decode for coords, indices, feature IDs, and full `RingPolygon` ring data. |
| `geodesic.ts` | Great-circle (slerp) interpolation via Haversine: `interpolateGreatCircle`, `haversineDistance`. Used to densify line segments for globe/orthographic projections. |
| `tile-format.ts` | In-memory tile-index structures (`XGVTIndex`, `XGVTHeader`, `TileIndexEntry`, `TILE_FLAG_FULL_COVER`) shared with the runtime `TileCatalog`. The binary .xgvt container was removed; only these interface shapes remain. |
| `geojson-types.ts` | GeoJSON type definitions (`GeoJSONFeatureCollection`, `GeoJSONFeature`, `GeoJSONGeometry`), duplicated from runtime to avoid cross-package imports. |
| `earcut.d.ts` | Ambient module declaration for the `earcut` npm package. |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `geojsonvt/` | Embedded 1:1 TypeScript port of mapbox/geojson-vt 4.0.2 (ISC) + MVT/PBF encoder (see `geojsonvt/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- earcut runs in **Mercator-projected coordinates** (MM). Do not triangulate in raw lon/lat — the tolerance, clip, and GPU rendering all operate in MM.
- Polygon great-circle subdivision is intentionally NOT applied at the `makePolygonPart` stage (only lines). Adding subdivision to polygon rings before simplification breaks the fill/outline gap invariant (d34aed2): outline endpoints land off the simplified fill boundary. Any polygon globe-surface fix must subdivide after simplification or unify both paths through `dataRings`.
- The geodesic midpoint inside triangle densification was deliberately reverted to linear MM midpoint (iter 56): the slerp variant introduced z=0 Mercator banding regressions. Do not re-add geodesic midpoints without a regression-safe gate.
- Tile addressing uses Morton `tileKey()` (z≤22, f64-safe). `tileKeyParent` is `Math.floor(key/4)` — do not call `tileKeyUnpack` + re-encode in hot paths (it was 17% of CPU on Bright).
- Cross-package imports from runtime are forbidden here. WGS84 constants (`A`, `E2`, `RAD2DEG`) come from `@xgis/shared`; math that must match runtime is bit-identical but duplicated by design.
- The .xgvt binary container is gone. `tile-format.ts` is interface-only; do not reintroduce a serializer.
- `POLYGON_FILL_FORMAT` is the single source of truth for the stride-24 polygon layout. If you add a vertex field, update `polygon-vertex-format.ts`; offsets/stride update automatically.

### Testing Requirements
Colocated fuzz/invariant tests (run after any geometry-math change): `clip.test.ts`, `clip-fuzz.test.ts`, `simplify-fuzz.test.ts`, `geodesic-fuzz.test.ts`, `tile-key-fuzz.test.ts`, `dsfun-precision-fuzz.test.ts`, `ecef-precision-fuzz.test.ts`, `ecef-line-segment-fuzz.test.ts`, `ecef-point-precision-fuzz.test.ts`, `polygon-holes.test.ts`, `polygon-vertex-format.test.ts`, `compile-tile-invariants.test.ts`. Upstream tests in `compiler/src/__tests__/`: `tiler.test.ts`, `line-tiler.test.ts`, `ocean-holes-low-zoom.test.ts`, `korea-z7-clip-backtrack.test.ts`. GPU compute parity is verified via `dequant-mirror.ts` against SwiftShader in the CI render-gate.

### Common Patterns
- Zero-dependency pure-math files banner their algorithm (see file headers).
- Coordinate flow: lon/lat → Mercator meters (MM) at feature load → clip/simplify in MM → ECEF RTC at pack time. `precisionForZoomMM` governs quantization grain.
- DSFUN split: `hi = Math.fround(x)`, `lo = Math.fround(x - hi)` — used for both Mercator-local (lines) and ECEF-absolute (points) representations.
- Backtrack detection uses a probe-earcut area ratio (threshold 1.2×) before the real tessellation pass.

## Dependencies

### Internal
- `@xgis/shared` — `WGS84` ellipsoid constants (`A`, `E2`, `RAD2DEG`).
- `geojsonvt/` subdirectory — embedded geojson-vt port used by the full tiling pipeline.
- Re-exported broadly from `compiler/src/index.ts`.

### External
- `earcut` — polygon triangulation.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
