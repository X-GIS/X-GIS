# DSFUN Precision Refactor — Implementation Plan

> **Status**: designed, not yet implemented. Phase A (preload staging)
> and Phase B (Web Worker parse pool) already shipped. Shader-only
> stable Mercator reformulation shipped as commit `02cffcc` — this
> document replaces it with the full vertex format change.
>
> **Estimate**: 4-6 hours focused work. Atomic refactor: partial commits
> not possible, plan to finish in a single sitting or stash/resume.

## Why

Current tile vertex storage is `[lon, lat, featId]` f32 stride 3 (or
stride 4 for lines with arc_start). At high camera zoom on coarse parent
tiles, two cumulative precision problems show up:

1. **Float32 vertex storage** — a z=5 tile spans ~11.25° wide. Float32
   precision at that magnitude is ~15 cm, so at camera zoom 22 where 1
   screen pixel ≈ 1 cm, vertices quantize to ~15 pixel-visible steps.
2. **Shader Mercator Y cancellation** — the naive
   `log(tan(abs_lat)) - log(tan(origin))` subtracts two near-equal
   large values. Commit `02cffcc` replaced this with
   `atanh`+sum-to-product for ~2x improvement, but `sin(origin_rad)` is
   still computed at f32 precision (~1e-7 rad ≈ 0.6 m at Earth
   radius) — the **intrinsic f32 ceiling**.

The only way to break the f32 ceiling is to store **and compute** in
emulated double precision: split each coordinate into `(high, low)` f32
pairs where `high + low ≈ f64` value. The subtraction
`(vertex_h - cam_h) + (vertex_l - cam_l)` cancels the large magnitudes
first and preserves the small difference at full f64-equivalent
precision. This technique is standard in globe renderers (Cesium, Google
Earth) and is called DSFUN (Double-Single FUNction).

## Design decisions (already settled)

1. **Storage unit**: tile-local **Mercator meters**, NOT tile-local
   degrees. Mercator meters is what the shader ultimately feeds to
   `mvp`, and pre-projecting at compile time kills the `log(tan)`
   step in the shader entirely. Non-Mercator projections (Natural
   Earth, Orthographic, etc.) reconstruct lon/lat via inverse
   Mercator — those are only used at global zoom where precision
   doesn't matter.
2. **Vertex stride**:
   - Polygon vertices: 3 → **5** f32: `[mx_h, my_h, mx_l, my_l, featId]`
   - Line vertices: 4 → **6** f32: `[mx_h, my_h, mx_l, my_l, featId, arcStart]`
   - Point vertices: 3 → **5** f32: same as polygon
3. **Uniform**: add `cam_h: vec2<f32>, cam_l: vec2<f32>` per tile.
   Computed on CPU each frame as
   `splitF64(camera_merc - tile_origin_merc)`. Tile-local origin is
   already computed in `tile_rtc` so extend that struct.
4. **Compile-time conversion**: tiler runs `lonLatToMerc_f64(lon, lat)`,
   subtracts `tileOriginMerc_f64`, then splits into `(high, low)`
   via `Math.fround(x)` / `Math.fround(x - Math.fround(x))`.
5. **Runtime conversion**: none. Tiles ship as pre-DSFUN'd bytes and
   go straight to GPU via the worker pool from Phase B.
6. **`maxZoom` cap**: lifted from `maxLevel + 6` to fixed **22** for
   every source — the precision ceiling is gone so the clamp no
   longer exists.

## Files to change (atomic)

| # | File | Change |
|---|---|---|
| 1 | `compiler/src/tiler/vector-tiler.ts` | `CompiledTile.vertices` / `lineVertices` / `pointVertices` stride update. Add `splitF64` helper. Vertex output converts lon/lat to tile-local Mercator meters and splits. |
| 2 | `compiler/src/tiler/tile-format.ts` | `parseGPUReadyTile` reads new stride. `serializeXGVT` writes new stride. `includeGPUReady` path stays — layout just changes. |
| 3 | `compiler/src/tiler/encoding.ts` | `decodeRingData` / `encodeRingData` output is already f64-equivalent TS numbers, but the tessellation output that gets written as vertices now goes through the Mercator+split pipeline. |
| 4 | `runtime/src/data/xgvt-source.ts` | `TileData` type updates. `generateSubTile` clip region converts to Mercator meters (was degrees). `cacheTileData` signature unchanged but stride differs. |
| 5 | `runtime/src/data/xgvt-worker.ts` | Worker response already sends typed-array buffers via Transferable — the bytes are just laid out differently now. Main thread also needs layout match. |
| 6 | `runtime/src/data/xgvt-worker-pool.ts` | `ParsedTile` interface stride update (same fields, different view sizes). |
| 7 | `runtime/src/engine/vector-tile-renderer.ts` | Vertex buffer layout descriptor: `pos_h: vec2<f32>` @0, `pos_l: vec2<f32>` @8, `feat_id: f32` @16, stride 20. Line: same + `arc_start: f32` @20, stride 24. Uniform: add `cam_h`, `cam_l` (replacing current `tile_rtc` components). Compute `(cam_merc_x - tile_origin_merc_x)` per tile per frame, splitF64, upload. |
| 8 | `runtime/src/engine/renderer.ts` `vs_main` | Rewrite as DSFUN: `rel = (pos_h - cam_h) + (pos_l - cam_l); position = mvp * vec4(rel, 0, 1)`. Mercator path is now pure addition. Non-Mercator path: reconstruct `abs_merc = rel + cam_abs_merc`, unproject Mercator → lon/lat, forward-project to target. |
| 9 | `runtime/src/engine/line-renderer.ts` `vs_line` | Same DSFUN rewrite. Segment builder `buildLineSegments` (if it reads vertices) also updates. |
| 10 | `runtime/src/engine/point-renderer.ts` `vs_point` | Same DSFUN rewrite. Point has no arc_start so stride 5. |
| 11 | `runtime/src/engine/raster-renderer.ts` `vs_tile` | Raster has no vertex buffer (procedural grid), but `tile.bounds` / `tile.merc_y` uniforms should also DSFUN-split for consistency at high zoom. |
| 12 | `runtime/src/engine/map.ts` | `camera.maxZoom = 22` always. Remove the `maxSrcLevel + 6` clamp. Delete the stable-Mercator shader reformulation from commit `02cffcc` — DSFUN replaces it. |
| 13 | `playground/public/data/*.xgvt` | Recompile every demo data file with the new compiler. File size increases ~1.67× (stride 5 vs 3). Since these files are `.gitignored` they only need to exist on disk, not commit. |
| 14 | Tests | Any test that asserts vertex stride / vertex values needs updating. Expect 1-3 test files in `compiler/src/__tests__/` and `runtime/src/__tests__/`. |

## Execution order (keeps builds fixable)

Because this is an atomic refactor, builds WILL break midway. The order
below minimizes the time builds are broken:

1. **Add helpers in compiler** (`splitF64`, `lonLatToMerc_f64`, tile origin
   conversion). Build still works (new code unused).
2. **Update `CompiledTile` types** to new stride + comment update.
   Build breaks in every consumer of `vertices` — accept this.
3. **Update compiler output** (`vector-tiler.ts`, `tile-format.ts`,
   `encoding.ts`) to emit new stride. Compiler package builds alone.
4. **Update runtime readers** (`xgvt-source.ts`, `worker.ts`, `worker-pool.ts`)
   to new stride. Runtime package builds alone. Integration broken.
5. **Update VTR vertex buffer layout + uniform pack**. VTR compiles, GPU
   pipeline rebinds.
6. **Rewrite 3 vertex shaders** (`renderer.ts vs_main`, `line-renderer.ts vs_line`,
   `point-renderer.ts vs_point`). WGSL inside TS template strings — mind
   the backticks.
7. **Update raster shader uniform pack** (lower priority, can defer).
8. **Lift `maxZoom` cap** in `map.ts`.
9. **Delete the 02cffcc shader-only Mercator reformulation** (now dead code).
10. **Recompile all `.xgvt` files** via
    `for f in playground/public/data/*.geojson; do bun compiler/src/cli/compile.ts tile "$f"; done`.
11. **Update tests** that asserted old stride.
12. **`bun run build && bun run test`** — 302 tests must pass.

Do NOT try to commit between steps. Finish the whole loop, then commit.

## Verification

**Baseline** (before starting):
- `bun run build && bun run test` — 302 tests pass
- `physical_map_10m#0.50/0.00000/5.59440` loads sub-second (Phase A+B
  already shipped)
- `physical_map_10m#14.57/-12.27836/27.40074/10.3/9.5` shows ~15 cm
  jitter on land boundaries (current state)
- `stroke_align#12.81/...` renders three parallel stripes correctly

**After refactor**:
- `bun run build && bun run test` — 302 tests pass (or updated count
  if stride tests were adjusted)
- Same demos at same URLs render identically at low/mid zoom
- `physical_map_10m#14.57/...` jitter drops to **sub-millimeter**
  (invisible at any practical zoom)
- `zoom#22/42.15/123.21/285.0/71.4` renders correctly — previously
  showed broken diagonal lines from `log(tan)` cancellation
- New capability: **zoom 22 works cleanly on any low-maxLevel source**
  because the clamp was lifted and precision no longer breaks
- iOS regression: same URLs work on CriOS (hash-loaded)
- **Main thread** still has no > 50 ms blocks during tile loads (Phase B
  still owns the parse → worker flow)

## Pitfalls

- **WGSL backticks in comments**. The shader is a JS template literal.
  Never write backticks inside `//` comments in the shader string.
- **Worker response format**. The pool returns `ParsedTile` with
  `vertices: Float32Array`. The underlying buffer layout must match
  the VTR vertex buffer layout descriptor exactly; a mismatch produces
  silent garbage rendering, not a validation error.
- **`generateSubTile`** reads `parent.vertices` at stride 3 today. Must
  update to stride 5 AND do the clip math in Mercator meters (not
  degrees). Re-project sub-tile bounds to Mercator before comparing.
- **`outlineIndices`** reuses the same vertex buffer — the stride
  change propagates to outline rendering automatically via the same
  vertex buffer layout. No separate update needed, but test.
- **Line `arc_start`** is the 5th element (stride 6 total) for lines.
  Keep the field offset stable so dash/pattern shader code doesn't
  need a rewrite — only the preceding position fields change layout.
- **Demo data regeneration** must run AFTER compiler changes land
  but BEFORE browser tests. Script:
  `bun compiler/src/cli/compile.ts tile playground/public/data/*.geojson`
  (loop — CLI accepts one at a time).
- **Non-Mercator projections**. Natural Earth / Orthographic / etc.
  live at very low zoom in practice. Don't over-engineer their
  precision; just inverse-Mercator the camera-relative coords and
  forward-project.

## Pause and resume

If the session is about to time out mid-refactor:

1. `git stash save "dsfun-wip <timestamp>"` — saves working tree
2. Note which step # from the execution order you stopped at
3. Next session: `git stash pop` and resume from that step

Alternatively: `git add -A && git commit -m "WIP: dsfun refactor at step N"` on a **branch**, never on `main`. Main must stay buildable.

## Rollback

If a critical regression ships to `main`:

1. Revert the refactor commit: `git revert <sha>`
2. Rebuild demo data: already-compiled tiles are in old format on disk,
   unchanged by `git revert` (since they're gitignored). Recompile
   with the reverted compiler.
3. Users whose browser cached the new-format `.xgvt` files get
   confusing errors — bump a cache-busting version query param in
   demo URLs if needed.

## Out of scope

- Compressing the stride-5 format further (e.g., int16 quantization)
  is a follow-up, not part of this refactor.
- Out-of-core compiler for cm-level data — future work tracked in the
  plan file (`polished-floating-cat.md` in `.claude/plans/`).
- Feature-density per-tile caps — polish, not a blocker.
- Worker pool architecture changes — already done in Phase B.
