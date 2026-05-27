# PR 2d.1C — vs_line ECEF clip migration — DEFERRAL doc

**Status:** PR 2d.1C **shipped vs_line ECEF clip via option (b)+** (in-shader inverse-Mercator + WGS84 forward ECEF). Tiler call-site swap + sub-tile-generator migration + `packDSFUNLineVertices` deletion are **DEFERRED** to PR 2d.1D — blocked by `buildLineSegments` stride-input dependency on `packDSFUNLineVertices`'s stride-10 layout.

## What PR 2d.1C shipped

1. **`mvp_ecef: mat4x4<f32>` added to line `TileUniforms`** (slot 16, mirrors polygon `Uniforms` byte-for-byte). The line shader shares group(0) with the VTR polygon tile bind group, so the uniform-buffer layout MUST match the polygon's 256-byte struct. The CPU side (`uf.set(mvpEcef, 16)` at vector-tile-renderer.ts:3535) was already writing this slot for the polygon ECEF VS — the line VS now consumes it.

2. **`vs_line` body rewrite** (`runtime/src/engine/shader-dsl/shaders/line.ts:725-948`):
   - Clip computed via `u.mvp_ecef * vec4(ecef_rtc, 1)` using in-shader inverse-Mercator + WGS84 forward ECEF reconstruction.
   - `world_local` varying still emitted as tile-local Mercator metres for the FS distance / clip / backface / pattern math (FS unchanged at 6 read sites: line.ts:298, 322, 331, 716, 869, 894).
   - Hybrid VS — the per-projection ladder (`project_geom` / `proj_globe`) is off the VS hot path; the CPU bakes every projType into `mvp_ecef` once per frame.

3. **`finalize_corner` / `finalize_corner_globe` helpers retired** (line.ts:189-222 deleted, removed from module funcs at line.ts:1046).

4. **Polygon variant snapshots regenerated** (baseline 73b607d → a4f7a41). All 8 snapshots byte-identical except the baseline-hash header line.

## Verification

- `npx tsc -p compiler/tsconfig.json --noEmit` → clean.
- `npx tsc -p runtime/tsconfig.json --noEmit` → line.ts clean; pre-existing errors unrelated to this PR.
- `bun run build` → success.
- Full vitest 545 files / 5355 pass / 0 fail / 3 skipped.

## Why these items are deferred

### packDSFUNLineVertices tiler call-site swap (directive steps 5 + 6)

**Structurally blocked** by `buildLineSegments` stride-input contract (documented in `.omc/handoffs/pr2d1b-blocker.md` §1):

- `packDSFUNLineVertices` emits stride-10 `[mx_h, my_h, mx_l, my_l, featId, arc, tin_x, tin_y, tout_x, tout_y]`.
- `packECEFLineSegments` (PR 2d.1B) emits stride-11 `[ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, abs_lon, abs_lat, enu_e, enu_n, 0]`.
- `buildLineSegments` reads `vertices[a * stride + 4]` as `featId` and `vertices[a * stride + 5]` as `arc_start`, plus tangents at slots 6-9. The ECEF stride-11 layout has `ey_l` at slot 4 (not featId) — direct swap would corrupt every height / width / colour / arc-continuity lookup.
- A safe migration requires either (a) extending `packECEFLineSegments` stride to ALSO emit featId + arc + tin + tout, OR (b) emitting per-segment ECEF data directly (skipping the per-vertex intermediate).

Either route reshapes data flow across 3+ files (`packECEFLineSegments` in compiler, `buildLineSegments` in runtime/core, `vs_line` in runtime/shader-dsl). It's a coherent PR 2d.1D scope, not "trivial alongside the VS body rewrite".

### sub-tile-generator.ts:351 migration

Same root cause — `sub-tile-generator` produces stride-10 DSFUN outline vertices via `packDSFUNLineVertices(olvScratch, subMxW, subMyS)`. Migrating requires the `buildLineSegments` stride-input refactor above. Deferred to PR 2d.1D.

### Decision: option (b)+ (in-shader inverse-Mercator)

The blocker doc (`.omc/handoffs/pr2d1-main-blocker.md` §2) explicitly called option (b)+ "a reasonable shape". It achieves the **PR 2d.1 GOAL** (`vs_line` clips via `u.mvp_ecef`) **without** the structural producer migration. Per-vertex cost: 2 sin + 2 cos + 2 sqrt + 1 tan + 1 exp — modest on modern GPUs; line VS runs once per quad corner.

Trade-off vs option (a) (segment-storage ECEF bake):
- Pro: zero changes to `buildLineSegments`, `packDSFUNLineVertices`, `sub-tile-generator`, MVT/PMTiles workers, GeoJSON tilers.
- Pro: surgical-minimal diff — single file (`line.ts`) + polygon snapshot regen.
- Con: per-vertex inverse-Mercator + forward-ECEF cost (option (a) would amortize once per segment build).
- Con: PR 2d.1A's pre-baked ENU corner offset slots (`enu_p0`/`enu_p1` at LineSegment offsets 20-25) are now UNUSED scaffolding — retirement deferred to PR 2d.5 cleanup once the ENU-bake path is confirmed dead.

## Recommended PR 2d.1D scope

1. Refactor `buildLineSegments` to read either:
   - stride-15+ ECEF input with featId + arc + tin + tout appended after the existing stride-11 ECEF fields, OR
   - separate per-segment ECEF buffer the tiler builds directly (skipping the per-vertex intermediate).
2. Tiler call-site swap at `compiler/src/tiler/vector-tiler.ts:1598, :1602, :1830, :1834`.
3. Sub-tile-generator migration at `runtime/src/data/sub-tile-generator.ts:351`.
4. MVT/PMTiles worker pre-build path migration (`runtime/src/data/workers/mvt-worker.ts`, `runtime/src/data/sources/pmtiles-backend-helpers.ts`, `runtime/src/data/sources/virtual-pmtiles-backend.ts`).
5. `packDSFUNLineVertices` deletion + PR 2d.1A baked ENU offset slot retirement.
6. `vs_line` rewrite to consume the new per-vertex ECEF data directly (drops the in-shader inverse-Mercator from this PR — pure perf win).

Estimated 1-2 days. CI render-gate is the verification gate.

## Files referenced (absolute paths)

- `D:/X-GIS/runtime/src/engine/shader-dsl/shaders/line.ts:43-90` — `TileUniforms` + `mvp_ecef` slot
- `D:/X-GIS/runtime/src/engine/shader-dsl/shaders/line.ts:725-948` — `vs_line` ECEF body
- `D:/X-GIS/runtime/src/engine/shader-dsl/shaders/line.ts:189-222` (DELETED) — `finalize_corner` / `finalize_corner_globe`
- `D:/X-GIS/runtime/src/engine/shader-dsl/shaders/__polygon-variant-snapshots__/*.wgsl` (8 files) — baseline-hash bump only
- `D:/X-GIS/runtime/src/engine/render/vector-tile-renderer.ts:3535` — `uf.set(mvpEcef, 16)` (unchanged, already writing the slot)

## Return code

**SUCCESS** — PR 2d.1C ships the GOAL (`vs_line` ECEF clip via `u.mvp_ecef`) with the safest possible scope. The structural producer migration is a follow-up.
