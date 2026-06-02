# ADR-0001: ECEF tile pipeline (single MVP, ellipsoid vertices)

- Status: Accepted
- Date: 2026-05-28 (Phase 2 PR 2d.5 closeout; quantization PR 2f)
- Scope: `@xgis/compiler` tiler, `@xgis/runtime` polygon/line/point/raster
  vertex paths, `@xgis/shared` ECEF math.

This ADR records the Phase 2 migration of the tile vertex pipeline off the
old per-vertex Mercator-DSFUN format onto **WGS84-ellipsoid ECEF metres with
a single `u.mvp`**. Read `docs/COORDINATES.md` first — it defines the LL / MM /
DLM / SP spaces this ADR's output space (ECEF) sits at the end of.

## Context

Before Phase 2, every render surface carried its own projection ladder in the
vertex shader. The polygon `Uniforms` struct held **two** matrices — a legacy
Mercator-RTC `mvp` and an `mvp_ecef` — and the vertex shader branched on
`proj_params.x` to pick a Mercator-DSFUN relative path, a `project_geom`
non-Mercator path, or a `proj_globe` RTC path. That ladder was hand-pasted
across the polygon, line, point, and raster shaders, and each producer in the
tiler packed a matching DSFUN Mercator vertex (split f32 hi/lo about
`tileMx`/`tileMy`, the **DLM** space in `docs/COORDINATES.md`).

The cost of that design:

- Two matrices per tile uniform (the dual `mvp` / `mvp_ecef`), doubling the
  per-tile uniform write and the polygon `Uniforms` footprint.
- The projection-specific 3D→clip math lived in WGSL, replicated per surface,
  and drifted (the projection-divergence audits catalogued the duplication).
- Globe / azimuthal / stereographic could not share one vertex format with
  flat Mercator — the same vertices meant different things per projection.

## Decision

**Tiles are packed once, on the CPU, as WGS84-ellipsoid ECEF metres,
quantized about a per-tile RTC anchor, and every surface transforms them with
a single `u.mvp`.** The projection-specific 3D→clip pipeline is baked into that
one matrix by the camera (`Camera.getECEFFrameView` /
`Camera.getViewForProjection`, `runtime/src/engine/projection/camera.ts:545,706`).

### 1. Vertex geoid = WGS84 ellipsoid

`packECEFPolygonVertices` (`compiler/src/tiler/vector-tiler.ts:205`) takes
stride-3 **absolute Mercator metres** `[mx, my, fid]`, inverts Web Mercator to
lon/lat radians, then forwards each vertex to the WGS84 ellipsoid
(`vector-tiler.ts:225-232`):

```
lon_rad = mx / A
lat_rad = 2*atan(exp(my / A)) - π/2          // inverse Web Mercator
N  = A / sqrt(1 - E2 * sin²lat)              // prime-vertical radius of curvature
ex = N * cosLat * cos(lon_rad)
ey = N * cosLat * sin(lon_rad)
ez = N * (1 - E2) * sinLat                   // (1-E2) north-axis compression
```

`A = 6378137` (WGS84 semi-major, = EPSG:3857 R), `E2 = F*(2-F)` with
`F = 1/298.257223563`. This is bit-identical to `lonLatToECEF` in
`shared/src/ecef.ts:36-47` (`A`/`E2` at `ecef.ts:26-28`); the tiler used to
hand-mirror the constants across the compiler↔runtime package barrier, but
both packages now import the same `@xgis/shared` source (`ecef.ts:20-24`,
`runtime/src/engine/projection/ecef.ts` is a thin re-export). Precision-fuzz
tests pin the parity.

### 2. RTC anchor + double-u16 quantization

Raw ECEF metres are ~6.4e6 in magnitude — far outside the f32 sweet spot. So
each tile is re-centred about a per-tile **RTC anchor** `ecefTileCenter`
(`tileEcefCenterFromMerc(tileMx, tileMy)`, `shared/src/ecef.ts:93`), then the
residual `vertex − ecefTileCenter` is quantized per axis into 32-bit fixed
point over the tile's symmetric half-range and split into two u16 lanes
(`quantizeAxis`, `vector-tiler.ts:164-172`):

```
halfRange = max-abs residual over this tile's verts + 1e-6
q  = round((axis + halfRange) / (2*halfRange) * 0xFFFFFFFF)   // u32
hi = q >>> 16    lo = q & 0xFFFF                              // two u16 lanes
```

The companion per-tile uniform carries `dequantScale = 2*halfRange/0xFFFFFFFF`
and `dequantHalf = halfRange` (`QuantizedPolygonVertices`,
`vector-tiler.ts:144-154`). The GPU reconstructs each axis as
`q = f32(hi)*65536 + f32(lo); axis = q*dequantScale - dequantHalf` — the
`dequant_ecef` WGSL fn (`runtime/.../shaders/polygon.ts:386-400`), which is the
single source for the decode (also run standalone in the compute parity harness
against the CPU `fround` mirror).

### 3. One vertex format, one matrix

The polygon fill vertex layout is **stride 24 bytes** (`POLYGON_FILL_FORMAT`,
`compiler/src/tiler/polygon-vertex-format.ts:29-35`):

```
bytes  0..11  uint16×6  q_xy (loc 0, uint16x4) + q_z (loc 1, uint16x2)
bytes 12..15  f32       feature_id (loc 2)
bytes 16..19  f32       abs_lon  (deg, loc 3)
bytes 20..23  f32       abs_lat  (deg, loc 4)
```

`abs_lon` / `abs_lat` ride alongside each vertex so the fragment-side
hemisphere-cull recompute can reconstruct absolute Mercator coordinates as
varyings (`polygonCosCFragment`, `polygon.ts:148-160`) without a second
attribute set.

The polygon `Uniforms` struct holds **one** `mvp` (the ECEF-MVP) — the dual
Mercator/ECEF `mvp_ecef` slot was retired in PR 2d.5, shrinking the struct
**256 → 192 bytes** (`polygon.ts:43-84`, see the header comment at
`polygon.ts:46-49`). `vs_main_ecef` collapses to a dequant + a single linear
transform (`polygon.ts:407-479`):

```
ecef_rtc = dequant_ecef(q_xy, q_z, tile_dequant_scale, tile_dequant_half)
clip     = u.mvp * vec4(ecef_rtc + cam_ecef_off, 1)        // 3D / globe arm
```

`cam_ecef_off = (tileEcefCenter − cameraCenter)` (DSFUN hi/lo, `cam_ecef_off_h`
/ `cam_ecef_off_l`, `polygon.ts:81-82`) re-centres the tile-local residual onto
the camera-at-ENU-origin MVP; the RTC origins cancel exactly in the VS.

## Consequences

### All surfaces share one ECEF path

Polygon, line, point, and raster vertices ship in ECEF and transform with the
same `u.mvp` baked by the camera. Switching projection is a uniform change, not
a re-tessellation — the same packed tile renders under any of the 7 projections.

### Flat projections reproject per-vertex in-shader

`u.mvp` is the 3D ECEF-MVP only on the globe / 3D arm. For flat display
projections the shader keeps a per-vertex reproject ladder
(`emitPolygonProjectionLadder`, `polygon.ts:229-294`), gated on `proj_params.x`:

```
proj_params.x < 0.5   flat Mercator: rel = project(abs_lon, abs_lat) − cam_merc,
                      z = 0, + world-copy offset
proj_params.x < 6.5   flat non-Mercator: flat_rel reproject (world-copy aware)
else                  3D ECEF-RTC: ecef_rtc + cam_ecef_off, single transform
```

The renderer writes the matching `u.mvp` per projType
(`Camera.getViewForProjection`, `camera.ts:706-718` — flat Mercator routes to
the 2D-plane MVP, 3D / globe to `getECEFFrameView`), so only the live branch's
matrix is consumed. This is why `abs_lon` / `abs_lat` must travel with each
vertex even though the position is ECEF: the flat arms reproject from absolute
lon/lat, not from the ECEF residual.

### The synthetic background shares the tile geoid

The z=0 earth-surface fill is served by `SyntheticEarthSurfaceBackend`
(`runtime/src/data/sources/synthetic-earth-surface-backend.ts`), which packs a
128×64 lat/lon mesh through the **same** `packECEFPolygonVertices` kernel about
the **same** decoded z=0 tile-corner anchor (`Z0_DECODED_SOUTH`,
`backend.ts:69,160-162`). Because the bg ground and the surrounding ground tiles
share one geoid (WGS84 ellipsoid) and one RTC origin, the polygon ECEF VS
origins cancel and the bg lands on the same surface the tiles do — it renders
through the standard polygon ECEF pipeline (`vs_main_ecef`), so it curves on
sphere projections instead of painting a flat strip. Sphere-class bands
(ortho / azi / stereo / globe) additionally dual-encode polar-cap rows beyond
±85.051° via `lonLatToECEF` directly, since the inverse-Mercator kernel
asymptotes at the Web-Mercator limit and can never reach ±90°
(`packECEFWithPolarCaps`, `backend.ts:261-318`).

### Open seam: vertex (ellipsoid) vs camera (sphere)

The **vertex** geoid is the WGS84 ellipsoid (above). The **camera** geoid is a
**sphere**: `getECEFFrameView` derives its ECEF centre via
`mercatorToECEFSphere` (`camera.ts:364,545`), and `lonLatToECEFSphere`
(`shared/src/ecef.ts:112-122`, `E2 = 0`, radius `A`) documents why — the legacy
2D MVP is built on a spherical Mercator basis (`WORLD_MERC = 2π·A`), so for the
dual-path parity gate the ECEF-MVP had to converge with the legacy MVP at
lat=0, which the ellipsoid's `(1-E2)` north-axis compression breaks (~1.7 px
clip-space delta at z=14 per `ecef.ts:97-110`).

The decision is to **keep this vertex(ellipsoid) / camera(sphere) split** — it
is intentional and guarded (≤1.5 px tolerance). The cross-cutting consequence,
catalogued by the projection-matrix-unification audit (2026-05-31): any *other*
surface that builds its own ECEF on a sphere basis (extrusion walls, globe
hit-testing / `unprojectGlobe`, graticule) diverges from the ellipsoid ground
by ~21 km at the poles. Those sphere usages are *unintended drift*, not part of
this decision, and are tracked separately. New ECEF producers MUST use the
shared ellipsoid `lonLatToECEF` for vertices; only the camera basis reads the
sphere.

## Verification

- Polygon vertex offsets/stride are single-sourced from `POLYGON_FILL_FORMAT`
  (`polygon-vertex-format.ts`) and consumed by both the packer
  (`vector-tiler.ts:177-181`) and the WGSL `@location` attributes
  (`polygon.ts:412-416`), so the written bytes cannot drift from the read.
- `dequant_ecef` is extracted as a shared fn and run standalone in the compute
  parity harness (`_dequant-parity.spec.ts`) against the CPU `fround` mirror, so
  the GPU f32 decode is checked against the host (`polygon.ts:380-405`).
- DSFUN reconstruction exactness is a `docs/COORDINATES.md` invariant (#5):
  `hi + lo` recovers the f64 value within ≤1 mm; the per-tile half-range step is
  ~3 mm at world scale (`backend.ts:24-25`).

## References

- `runtime/src/data/sources/synthetic-earth-surface-backend.ts` — synthetic z=0
  earth-surface pack (shared kernel + polar caps).
- `compiler/src/tiler/vector-tiler.ts` — `packECEFPolygonVertices`,
  `quantizeAxis`, `QuantizedPolygonVertices`.
- `compiler/src/tiler/polygon-vertex-format.ts` — single-source vertex layout.
- `runtime/src/engine/shader-dsl/shaders/polygon.ts` — `Uniforms` (one mvp,
  192 B), `vs_main_ecef`, `dequant_ecef`, `emitPolygonProjectionLadder`.
- `shared/src/ecef.ts` — `lonLatToECEF` (ellipsoid), `lonLatToECEFSphere`
  (camera basis), `tileEcefCenterFromMerc`, `dsfunSplitECEF`.
- `runtime/src/engine/projection/camera.ts` — `getECEFFrameView`,
  `getViewForProjection`.
- `docs/COORDINATES.md` — LL / MM / DLM / SP spaces and DSFUN invariants.
