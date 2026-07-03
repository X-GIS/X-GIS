<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-03 | Updated: 2026-06-03 -->

# core

## Purpose

GPU-free primitives shared by the rendering layer and MVT compile workers. Contains the load-bearing CPU math for SDF line-segment quad generation, ECEF-quantized polygon wall/roof mesh building, and concurrency-limited async fetch scheduling. Nothing here imports WebGPU types or WGSL, so worker threads and unit tests can import directly. The runtime renderer classes re-export their public surfaces.

## Key Files

| File                    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `line-segment-build.ts` | Builds the SDF line-segment storage buffer (`LINE_SEGMENT_STRIDE_F32 = 20`, 80 bytes per segment). Input stride `5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 6   | 10`; throws if stride < 6 (stride-5 polygon-fill indices are not valid here — polygon outlines must come via stride-10 `outlineVertices`). Packs DSFUN high+low pairs for p0/p1, prev/next tangents via CSR adjacency, `arc_start`, `line_length`, `pad_ratio`values computed by`computeMiterPadRatio`(mirrors WGSL miter math using` | cross | /(1+dot)`tangent formula), per-segment`z_lift_m`for 3D extrude outlines (sampled from optional`heights`map; falls back to`defaultHeight`to stay in sync with`polygon-mesh.ts`), `width_px_override`and packed RGBA8`color_packed`(u32 bit-pattern in slot 18 via`Uint32Array`view) for compiler-merged compound layers. Tile-boundary cap suppression (1 m tolerance) prevents double-caps at tile seams. Extracted from`line-renderer.ts` so workers can import it. |
| `polygon-mesh.ts`       | Exports `EXTRUDE_FALLBACK_HEIGHT_M = 50` (shared constant used by both the wall path and `line-segment-build.ts` `z_lift_m`). `generateWallMeshExtrudedECEF` builds the ECEF-RTC wall + roof mesh for fill-extrusion layers; returns `WallMeshExtrudedECEF` (vertices, indices, `dequantScale`, `dequantHalf`). Output is a single interleaved stride-11-f32 (44 bytes) buffer: 6 u16 quantized ECEF-RTC position lanes (hi+lo per axis, written in a final pass once `maxAbs` is known) + f32 fields for `feat_id`, `abs_lon`, `abs_lat`, `face_normal×3`, `wall_height`, `is_top`. Accepts an optional `bases` map for `fill-extrusion-base`. All field offsets derived at module load from `POLYGON_EXTRUDED_FORMAT` / `vertexField` (compiler single source of truth). Roof face normal uses sphere-radial "up" (lighting approximation); roof and wall ECEF positions use the WGS84 ellipsoid via `lonLatToECEF`. |
| `priority-queue.ts`     | Concurrency-limited async scheduler (TypeScript port of NASA-AMMOS/3DTilesRendererJS `PriorityQueue`). Sort-and-pop dispatch with idempotency `dirty` flag to skip redundant sorts (also skips sort when `items.length <= available slots`); O(N) `removeByFilter` for per-frame stale-fetch cancellation (replaces prior O(N²) naive loop). `PriorityQueueItemRemovedError` is the typed rejection reason. Used for tile-fetch scheduling in VTR. Default `maxJobs = 6`, `autoUpdate = true`, scheduling via `queueMicrotask`.                                                                                                                                                                                                                                                                                                                                                                                        |

## For AI Agents

### Working In This Directory

- Files here must remain WebGPU-free — they are imported by worker threads and unit tests. Do not add GPU types or `@webgpu/types`.
- The line-segment stride and field layout at the top of `line-segment-build.ts` must stay in sync with the WGSL `struct LineSegment` in `engine/render/line-renderer.ts`. Slot 19 is pure alignment padding.
- `EXTRUDE_FALLBACK_HEIGHT_M` is used by both the wall mesh (`polygon-mesh.ts`) and the line outline `z_lift_m` path in `line-segment-build.ts`. They must read the same constant or building outlines will ride the wrong z and be occluded by walls.
- Polygon vertex field offsets (`EXT_FID_FLOAT`, etc.) are derived at module load from `POLYGON_EXTRUDED_FORMAT` / `vertexField` — do not hardcode numeric offsets. The renderer's `extrudedVertexBufferLayout` and WGSL `@location` attributes are also derived from that spec; drift is caught by `vertex-layout-consistency.test.ts`.
- `buildLineSegments` throws on `stride < 6` — do not pass stride-5 polygon-fill indices directly; polygon outline vertices must use the stride-10 path.
- `PriorityQueue.sort()` has an idempotency skip: it no-ops when `dirty = false` AND the queue fits available slots. Call `markDirty()` after camera moves so the tile-distance comparator re-orders against the new position.

### Testing Requirements

- `priority-queue.test.ts` — scheduling, concurrency cap, `remove` / `removeByFilter`.
- `line-segment-build-fuzz.test.ts` — randomised fuzz for segment packing and miter math.
- `boundary-cap-suppression.test.ts` — tile-boundary cap suppression edge cases.
- `polygon-mesh.test.ts` and `polygon-mesh-ecef.test.ts` — wall/roof mesh geometry and ECEF quantization.
- Add a co-located test for any new packing or scheduling logic; these files have no GPU dependency so tests run in plain vitest.

### Common Patterns

- Pure functions over typed arrays; return new allocated buffers, no shared mutable state.
- DSFUN (double-single float) high/low f32 split for positions — reconstruct as `h + l` on CPU, cancel `(p - cam_h) + (p - cam_l)` in the shader.
- Field offsets derived from a single-source spec constant rather than hardcoded numbers.
- u32 bit patterns (packed RGBA8 colour) written via a `Uint32Array` view onto the same `ArrayBuffer` as the `Float32Array` output to avoid NaN coercion.

## Dependencies

### Internal

- `@xgis/compiler` — `RingPolygon` type, `POLYGON_EXTRUDED_FORMAT`, `vertexField`.
- `../engine/projection/ecef` — `lonLatToECEF` (WGS84 ellipsoid ECEF conversion).
- `../engine/projection/projection` — `mercatorYToLatRad` (inverse Mercator y → latitude).

### External

- `earcut` — polygon roof tessellation in `polygon-mesh.ts`.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
