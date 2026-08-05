// ═══ Byte budget for the raster-family GPU texture caches (#1352) ═══
//
// Shared by RasterRenderer and HillshadeRenderer, which hold structurally
// identical `tileCache` maps (hillshade's loader is a verbatim copy of
// raster's, by its own comment). They must NOT each carry their own copy of
// the ceiling: a duplicated budget constant is the two-authorities drift this
// repo has already paid for more than once, and a hillshade cache silently
// running to a different limit than the raster one is precisely the shape that
// hides. One authority, two consumers.

import { isMobileClassViewport } from '@xgis/shared'
import type { RhiDevice, RhiTexture } from '@xgis/engine'

/** A loaded tile texture plus its resident GPU cost.
 *
 *  The cost has to travel WITH the texture. `RhiTexture` is an opaque handle
 *  (`rhi/src/rhi.ts:20` — just a `__rhi` brand) with no dimensions to read
 *  back, and the decoded `ImageBitmap` is closed the moment the upload
 *  completes, so texture-creation time is the only point at which the size is
 *  knowable at all. */
export interface LoadedTexture {
  texture: GPUTexture | RhiTexture
  bytes: number
}

/** Levels in a full mip chain down to 1x1, base included (#1436).
 *
 *  Shared by the texture that allocates the chain and the budget that pays for it, so the two
 *  can never disagree about how many levels exist — the failure mode being a cache that thinks
 *  it is under its ceiling while the GPU holds a third more than it counted. */
export function mipLevelCountFor(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1
}

/** Resident bytes for an `rgba8unorm` tile texture — 4 B per texel, mip chain included
 *  ONLY when `mipped` is true.
 *
 *  `mipped` is REQUIRED, not defaulted (#1579): this function has exactly four call
 *  sites and used to charge the full chain unconditionally, which was correct for
 *  raster-on-WebGL2 (the only arm that actually built a chain) and an over-charge by
 *  ~4/3 everywhere else — including DEM/hillshade tiles, which `mip-scope-invariant.test.ts`
 *  pins as DELIBERATELY un-mipped (elevation is DATA; averaging levels fabricates terrain
 *  slope-derivatives never sampled). A silently-defaulted flag would let a future un-mipped
 *  caller inherit the wrong answer instead of choosing one; every call site names its case.
 *
 *  The pyramid factor is REAL for a mipped texture (#1436): each level is a quarter of its
 *  parent, so a full chain sums to 4/3 of the base. Computed as the exact level sum rather
 *  than a flat ×4/3: a non-square or non-power-of-two tile's chain is not exactly 4/3, and
 *  rounding UP everywhere is the safe direction for a budget but wrong for the accounting a
 *  test reads back. */
export function textureBytesOf(width: number, height: number, mipped: boolean): number {
  if (!mipped) return width * height * 4
  let bytes = 0
  const levels = mipLevelCountFor(width, height)
  for (let level = 0; level < levels; level++) {
    bytes += Math.max(1, width >> level) * Math.max(1, height >> level) * 4
  }
  return bytes
}

/** Byte ceiling for ONE raster-family tile texture cache.
 *
 *  `MAX_CACHED_TILES` bounds ENTRIES, not bytes, and textures are created at
 *  the decoded bitmap's ACTUAL dimensions — never at the source's declared
 *  `tileSize`, which is only used for the LOD zoom bias. Per-entry cost is
 *  therefore publisher-controlled, and a count cap cannot bound the total:
 *
 *  | source tile | per tile |   × 256 |
 *  |-------------|----------|---------|
 *  | 256²        |  256 KB  |   64 MB |
 *  | 512²        |    1 MB  |  256 MB |
 *  | 1024²       |    4 MB  |    1 GB |
 *  | 2048²       |   16 MB  |    4 GB |
 *
 *  — all while `tileCache.size` reports a healthy 256. Raster and hillshade
 *  hold independent caches, so a style using both doubles whatever this is.
 *
 *  Follows the vector path's precedent (`data/src/tile-types.ts:179-209`): the
 *  BYTE cap is the enforced limit, the count cap is demoted to a safety net.
 *  Viewport-aware through the single `isMobileClassViewport` authority (#1350),
 *  never a raw width comparison — a phone's GPU cannot hold a desktop's
 *  texture working set, and 384 MB × 2 caches is already generous there.
 *
 *  The figures are chosen to sit above a full screen of tiles at realistic
 *  sizes and below the point where two caches threaten a mid-range GPU; they
 *  are not measured. Byte-level cache telemetry (#1355) is what would let them
 *  be tuned from data. */
export function maxRasterCachedBytes(): number {
  const w = typeof window !== 'undefined' ? window.innerWidth : 0
  return isMobileClassViewport(w) ? 96 * 1024 * 1024 : 384 * 1024 * 1024
}

/** Entry count that keeps a cache of UNIFORM `entryBytes`-sized textures inside
 *  `maxRasterCachedBytes()` (#1579).
 *
 *  For the raster/hillshade tile caches above, entry size varies by publisher
 *  (256²..2048²), so `evictToBudget` sums real bytes per entry. The vector-drape bake
 *  cache is the opposite shape — every bake is exactly `BAKE_PX²` RGBA8 — so a COUNT
 *  cap is already an exact byte cap; it only needed to be VIEWPORT-AWARE instead of a
 *  flat desktop-sized 256 (≈256 MiB, 2.7× the mobile raster ceiling this shares a GPU
 *  with). Routed through the one authority both siblings answer to, rather than a
 *  second copy of the mobile/desktop split. */
export function maxCachedEntriesFor(entryBytes: number): number {
  return Math.max(1, Math.floor(maxRasterCachedBytes() / entryBytes))
}

/** The cache-entry shape the shared insert/evict below need. Both renderers'
 *  `CachedTile` is exactly this. */
export interface EvictableTile {
  texture: GPUTexture | RhiTexture
  bytes: number
  lastUsedFrame: number
  /** -1 = "never drawn yet"; the draw loop stamps it on the tile's FIRST
   *  appearance so an off-screen prefetch still fades in. */
  firstShownFrame: number
}

/** Admit a loaded tile and return the new byte total. The single insert
 *  authority for both renderers' `tileCache`, so the accumulator cannot drift
 *  — the defect that motivated the vector cache's own drift invariant
 *  (`data/src/tile-data-cache.ts:132`, added after "263 MB for 2 tiles"). */
export function admitTile<T extends EvictableTile>(
  cache: Map<string, T>,
  key: string,
  loaded: LoadedTexture,
  frameCount: number,
  bytesNow: number,
): number {
  // Cast: every field T adds beyond EvictableTile is optional in both
  // consumers (raster's `globalBG`), so the literal is a valid T.
  cache.set(key, {
    texture: loaded.texture,
    bytes: loaded.bytes,
    lastUsedFrame: frameCount,
    firstShownFrame: -1,
  } as T)
  return bytesNow + loaded.bytes
}

/** Over EITHER limit. Bytes are the real ceiling; the count cap stays a safety
 *  net for a source of many tiny tiles, where 256 entries cost little in VRAM
 *  but still carry per-entry bind groups and bookkeeping. */
export function overBudget(count: number, bytes: number, maxCount: number): boolean {
  return count > maxCount || bytes > maxRasterCachedBytes()
}

/** Evict least-recently-used tiles until back under BOTH limits, returning the
 *  new byte total. Shared by both raster-family renderers — the policy was
 *  duplicated verbatim, which is the drift risk the budget constant above is
 *  also centralised to avoid.
 *
 *  Two properties the callers depend on:
 *
 *  - The budget is RE-TESTED each step rather than draining a count computed up
 *    front. Byte pressure can demand far more evictions than a count overflow
 *    implies — one 2048² tile is 64 of the 256² kind — and at 40 huge tiles the
 *    count cap does not fire at all while the cache sits hundreds of MB over.
 *  - Visible tiles are exempt, so this can legitimately return still over
 *    budget. Freeing a texture the current frame is about to sample would be a
 *    use-after-free; staying over for a frame is the correct trade. */
export function evictToBudget<T extends EvictableTile>(
  cache: Map<string, T>,
  visibleKeys: Set<string>,
  maxCount: number,
  bytesNow: number,
  rhi: RhiDevice,
  draper?: { dropTexture(t: GPUTexture | RhiTexture): void },
): number {
  let bytes = bytesNow
  if (!overBudget(cache.size, bytes, maxCount)) return bytes
  const entries = [...cache.entries()]
    .filter(([key]) => !visibleKeys.has(key))
    .sort((a, b) => a[1].lastUsedFrame - b[1].lastUsedFrame)
  for (const [key, tile] of entries) {
    if (!overBudget(cache.size, bytes, maxCount)) break
    // Free order matches what both renderers did inline: destroy through the
    // backend-appropriate path, then drop the draper's cached bind group
    // BEFORE the texture is gone.
    if (rhi.backend === 'webgl2') rhi.destroyTexture(tile.texture as RhiTexture)
    else (tile.texture as GPUTexture).destroy()
    draper?.dropTexture(tile.texture)
    cache.delete(key)
    bytes -= tile.bytes
  }
  return bytes
}

/** Abort every in-flight tile fetch and drop the loading ledger (#1570).
 *
 *  Shared by RasterRenderer and HillshadeRenderer, which are deliberately separate
 *  classes over the same tile machinery — so their teardown is one copy, not two that
 *  can drift (the drift class this campaign keeps finding).
 *
 *  Neither had a teardown at all: the per-tile `AbortController`s existed (the
 *  zoom-change sweep uses them) but nothing fired them when the map went away, and
 *  `_releaseGpuResources` never named these renderers. On WebGL2 that was not merely
 *  wasted bandwidth — `gpu.ts` hands back and RESTORES the same `gl` object on a
 *  remount, so a fetch that resolved after the reboot found a live context,
 *  `rhi.createTexture` no longer threw, and the texture landed in a cache
 *  `buildSceneRenderers` had already replaced: unreachable, undrawable, and never
 *  evicted, because eviction is render-driven and nothing renders that cache.
 *
 *  Only the FETCH side — the textures are owned by the device, which
 *  `_releaseGpuResources` destroys one call later. */
export function abortLoadingTiles(loadingTiles: Map<string, AbortController>): void {
  for (const ctrl of loadingTiles.values()) ctrl.abort()
  loadingTiles.clear()
}
