# Phase 2 Plan — PR 2f: Quantized ECEF (double-u16 position)

**Status:** APPROVED for implementation (autopilot plan, 5-angle critique folded in below). Format decision: **(A) double-u16** — position packed as 32-bit-per-axis fixed point (u16 hi + u16 lo), DSFUN precision contract preserved at all zooms. ~33% flat-fill vertex-memory reduction (36→24 B); the original "~64%" target is unreachable under the strict precision gate and was rejected with the single-u16 option.
**Branch:** `claude/effect-command-19mGH` (PR #187 base; `_back-compat` retire already landed, CI green).
**Predecessor:** PR 2c landed ECEF-DSFUN stride-9 flat / stride-14 extruded, retire-quantized. This re-introduces quantization on the position field only.

---

## Precision math (the crux — why double-u16, not single)

Polygon vertices are tile-local ECEF residuals (`ecef - tileEcefCenter`). Tile residual magnitude R varies by zoom. A single u16 (65,535 steps) over R:

| zoom | R (tile residual span) | single-u16 step | double-u16 (2³²) step | contract |
|---|---|---|---|---|
| z=22 | ~9.5 m | 0.15 mm ✅ | 2.2e-6 mm ✅ | ≤1 mm |
| z=15 | ~1,223 m | 18.7 mm ❌ | 2.8e-4 mm ✅ | ≤1 mm |
| z=8 | ~156 km | 2.39 m ❌ | 3.6e-2 mm ✅ | ≤1 cm |
| z=0 | ~12,742 km | 194 m ❌ | **2.97 mm** ✅ | ≤1 cm |

Single-u16 fails z≤18. Double-u16 (u16 hi·65536 + u16 lo = 32-bit fixed point per axis) passes every zoom with margin. **This is the format.**

## Quantization scheme

Per tile, position is the ECEF RTC residual already centered at `tileEcefCenter`. Quantize each axis independently over a per-tile symmetric range `[-halfRange, +halfRange]`:

```
encode (CPU, tiler/mesh):
  q = round( (rtc_axis + halfRange) / (2*halfRange) * 0xFFFFFFFF )   // u32 in [0, 2^32)
  hi = q >>> 16   (u16)   lo = q & 0xFFFF   (u16)

decode (GPU VS):
  q = f32(hi)*65536.0 + f32(lo)
  rtc_axis = q * u.tile_dequant_scale - u.tile_dequant_half        // scale = 2*halfRange/0xFFFFFFFF
```

- `halfRange` is per-tile, computed as the max abs residual across the tile's vertices (all 3 axes share one conservative `halfRange` = the tile's bounding sphere radius about its center) — simplest, axis-symmetric, no per-axis uniform. A tighter per-axis range is a later optimization; single radius is correct and within contract.
- `tile_dequant_scale` (f32) + `tile_dequant_half` (f32) travel as **per-tile uniform** fields (the renderer already writes per-tile uniforms — `cam_h/cam_l/tile_origin_merc` at `vector-tile-renderer.ts:4801-4835` — so this rides the same write).
- Only the **position** (pos_h+pos_l, 24 B → 12 B) is quantized. `fid`, `abs_lon`, `abs_lat`, `face_normal`, `wall_height`, `is_top` stay f32 (precision/complexity not worth it).

## GPU layout (WGPU has no uint16x3/x6)

WebGPU vertex formats: only `uint16x2` and `uint16x4` exist. The 6×u16 position splits into:
- `@location 0`: `uint16x4` (8 B) — qx_hi, qx_lo, qy_hi, qy_lo
- `@location 1`: `uint16x2` (4 B) — qz_hi, qz_lo

**Flat-fill new layout (arrayStride 24, was 36):**
| loc | offset | format | field |
|---|---|---|---|
| 0 | 0 | uint16x4 | qx_hi, qx_lo, qy_hi, qy_lo |
| 1 | 8 | uint16x2 | qz_hi, qz_lo |
| 2 | 12 | float32 | feat_id |
| 3 | 16 | float32 | abs_lon |
| 4 | 20 | float32 | abs_lat |

**Extruded new layout (arrayStride 44, was 56):** loc 0–1 as above (12 B), then feat_id(16) abs_lon(20) abs_lat(24) face_normal·float32x3(28) wall_height(40) is_top... — **wait**: face_normal float32x3 at off 28 spans 12 B → 40, wall_height f32 →44, is_top f32 →48. Recompute in implementation; the extruded stride is 36 (quantized pos) + remaining f32 fields. The integer attributes (uint16) and float attributes must respect 4-byte offset alignment — both uint16x2 (4 B) and uint16x4 (8 B) are 4-aligned, OK.

## Reuse template

PR 2c **deleted** `vs_main_quantized` (former uint16x2 stride-8 Mercator-quantized polygon entry) + `quantizePolygonVertices*` + `QUANT_POLY_STRIDE_BYTES`/`QUANT_POLY_RANGE`. Recover the layout-split + WGSL uint16-unpack pattern from git history (`git show 2aa064c:runtime/src/engine/shader-dsl/shaders/polygon.ts` pre-PR-2c, and the deleted tiler quantizer) as a structural reference — NOT a copy (that was single-u16 Mercator; this is double-u16 ECEF).

## Implementation steps (each → verify)

1. **Tiler `packECEFPolygonVertices`** (`compiler/src/tiler/vector-tiler.ts`): change output from stride-9 f32 to the quantized layout. Compute per-tile `halfRange` (max abs residual over the tile's verts), emit interleaved bytes: uint16×6 position + f32 fid/abs_lon/abs_lat. Return both the buffer AND the per-tile `{ dequantScale, dequantHalf }` so the runtime can write the uniform. → verify: extend `ecef-precision-fuzz.test.ts` to round-trip through quantize→dequant and assert the SAME ≤1mm@z22 / ≤1cm@z0 bounds.
2. **Runtime mesh `generateWallMeshExtrudedECEF`** (`runtime/src/core/polygon-mesh.ts`): same position quantization; keep face_normal/wall_height/is_top f32. Emit per-mesh `halfRange`. → verify: unit test top-ring ECEF height within 1mm after dequant.
3. **Uniform struct** (`polygon.ts` Uniforms): add `tile_dequant_scale: f32` + `tile_dequant_half: f32` (use the documented free f32 slots; keep 16-byte alignment). → verify: `uniform-layout-consistency.test.ts`.
4. **VS dequant** (`polygon.ts` `vs_main_ecef` + `vs_main_ecef_extruded`): replace `ecef_rtc = pos_h + pos_l` with the u16→u32→scaled dequant (per axis), reading the two integer attributes. → verify: `polygon-ecef-vs.test.ts` asserts dequant expression present, no `project_geom`.
5. **GPU layouts** (`renderer.ts`): rewrite flat-fill + extruded vertex buffer layouts to the uint16x4+uint16x2 split + f32 tail. → verify: `vertex-layout-consistency.test.ts` (arrayStride + attribute count + formats).
6. **Per-tile uniform write** (`vector-tile-renderer.ts`): write `tile_dequant_scale`/`tile_dequant_half` into the per-tile uniform alongside `cam_h`/`tile_origin_merc`; upload quantized bytes via `writeBuffer` unchanged (already byte-passthrough). → verify: build green.
7. **`TILE_LAYOUT_VERSION` 2→3** (`tile-source.ts`) + confirm eviction path warns/evicts on mismatch. → verify: `tile-layout-version.test.ts`.
8. **DSL snapshot regen** (`__polygon-variant-snapshots__/*.wgsl`): regenerate after VS body change; PR body annotates one representative diff (dequant math replacing the add). → verify: vitest snapshot.
9. **Memory accounting** in PR body: flat 36→24 B (−33%), extruded 56→44 B (−21%). → verify: `git diff --stat` + layout test.

## Risks (critique-folded)

- **R1 (correctness — quant range):** if a vertex residual exceeds `halfRange`, encode clamps/overflows. Mitigation: `halfRange` = exact max-abs over the tile's own verts (+ tiny epsilon), so by construction no vertex exceeds it. Test: fuzz asserts no clamp.
- **R2 (correctness — extruded heights):** wall-top vertices are lifted in ECEF before quantization, so their residual is larger than the flat footprint. `halfRange` must be computed AFTER lift (over the full extruded vertex set), else top-ring overflows. Step 2 computes halfRange post-lift.
- **R3 (alignment):** WGPU requires vertex attribute offsets aligned to format component size; uint16x2/x4 are 4-/8-byte and the f32 tail is 4-aligned — verified in the layout tables. Re-check exact offsets at step 5.
- **R4 (per-tile uniform vs batched draw):** dequant scale is per-tile, so tiles MUST be drawn with their own uniform write. Confirmed: the renderer already does per-tile uniform writes (ground-truth §8). If any path batches multiple tiles into one draw, quantization breaks — grep-guard at step 6.
- **R5 (scope creep):** abs_lon/abs_lat NOT quantized (1e-5 deg contract needs 32-bit; out of scope). Line/point paths untouched.
- **R6 (CPU cost):** per-tile halfRange = one max-abs pass over verts (already iterating to pack). Negligible.

## Out of scope
- Per-axis (vs single-radius) quant range — later optimization.
- abs_lon/abs_lat quantization.
- Line / point / raster vertex quantization (separate PRs).
- Reaching 64% (needs single-u16 + precision-contract relaxation, rejected).
