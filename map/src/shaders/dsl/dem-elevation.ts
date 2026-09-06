// ═══ Shader DSL — DEM elevation authority (D5 INC-2, #2532) ═══
//
// ONE place turns a DEM texel into metres. Before this file the formula lived
// inside `hillshade.ts`'s `hs_elevation`, closed over the hillshade uniform block
// and a `textureSample` — correct, but reachable from nowhere else, and not
// executable in a compute pass (no derivatives there), so the CPU↔GPU parity
// harness `_absorbed-fn-parity.spec.ts` could not run it.
//
// The split that fixes both: everything HERE is pure arithmetic — no texture
// binding, no uniform block — so it is oracle-able in f64 (`compileModule`) and
// executable on the real GPU in a compute kernel. Sampling stays in the module
// that owns the texture (hillshade's fragment today, the raster/hillshade vertex
// stage in INC-3), as a thin wrapper that calls in here. Only the FORMULA is
// shared, which is what "one authority" has to mean when two modules bind two
// different textures.
//
// Deliberately NOT here (#2532's decision): a CPU-side elevation read. INC-3
// displaces in the vertex stage and needs none; the first consumer is INC-4
// (per-tile min/max for culling). Adding a readback now would reopen the "a DEM
// is DATA — un-mipped, bitmap closed on upload" invariant for no caller.

import { fn, f32, vec2, vec2fT, vec3fT, vec4fT, dot, type FuncDecl } from '@xgis/shader-dsl'
import { emitFuncs } from '@xgis/shader-dsl'

/** DEM texel → elevation in metres.
 *
 *  `texel` is what `textureSample` returns — normalised [0,1] per channel — and
 *  `unpack` is (redFactor, greenFactor, blueFactor, baseShift), the four numbers
 *  `demUnpack()` (hillshade-renderer.ts) resolves per encoding:
 *
 *    elevation_m = dot(texel·255, unpack.rgb) − unpack.w
 *
 *  ×255 before the dot mirrors MapLibre's `texture()*255`; the packed RGB must
 *  be sampled NEAREST (a bilinear blend of packed bytes decodes to garbage), which
 *  is the caller's sampler to bind, not this fn's to enforce. Byte-for-byte the
 *  expression `hs_elevation` carried before #2532 — same ops, same order — so the
 *  hillshade pixels do not move (the four hillshade gates hold it at the hash rung). */
export const demDecode = fn('dem_decode', { texel: vec3fT, unpack: vec4fT }, ({ texel, unpack }) =>
  dot(texel.mul(f32(255)), unpack.rgb).sub(unpack.w),
)

/** Map a REQUESTED tile's UV onto the RESIDENT (possibly ancestor) DEM texture —
 *  the INC-1 (#2525) sub-rect, consumed: `sub = (scale, u0, v0, _)` with
 *  `scale = 2^−levelsUp` and (u0, v0) the child's corner inside the ancestor.
 *  Identity at levelsUp 0.
 *
 *  `sub` is in XYZ tile space. A `tms` row scheme flips `{y}` in the FETCH
 *  (`DemTileStore.tileUrl`), never in the cache key, so the texture's own row
 *  orientation is the sampling wrapper's to apply on top of this. Recorded here
 *  so INC-3 does not rediscover it as a "flipped terrain" bug. */
export const demSubUv = fn('dem_sub_uv', { tile_uv: vec2fT, sub: vec4fT }, ({ tile_uv, sub }) =>
  vec2(sub.y, sub.z).add(tile_uv.mul(sub.x)),
)

export const DEM_ELEVATION_FUNCS: FuncDecl[] = [demDecode, demSubUv]

/** Emitted-WGSL accessor for the parity harness (`_dem-decode-parity.spec.ts`),
 *  which splices this exact WGSL into a standalone compute shader and diffs the
 *  executed result against the CPU f64 oracle. NOT a production path — runtime
 *  shaders are built via emitModule; this is the sanctioned string surface for
 *  harnesses, the same shape `ECEF_WGSL_FNS` takes. */
export const DEM_ELEVATION_WGSL_FNS = `${emitFuncs(DEM_ELEVATION_FUNCS)}\n`
