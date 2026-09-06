// ═══ DEM tile residency, owned in one place (#2268 / D5 INC-0) ═══
//
// Everything about "is this DEM tile available, and how do I get it" — the
// resident texture cache and its byte accounting, the in-flight ledger, the
// failure/backoff ledger, the URL template and row scheme, the fetch → decode →
// admit path, and eviction. Lifted verbatim out of `HillshadeRenderer`, which
// kept all of it inline and had reached its LOC ceiling exactly (850/850), so
// nothing further could be added to that file at all.
//
// WHY THE FETCH PATH COMES TOO, rather than stopping at the decoded-texture
// cache (the question #2201 left open for this increment): a request is admitted
// only by consulting THREE pieces of state together —
//
//     if (cache.has(key) || loading.has(key)) continue
//     if (!failed.requestable(key)) continue
//     if (loading.size >= budget) break
//
// Splitting the cache from the fetch path puts that one decision behind two
// owners. #1956 is the standing cost of exactly that shape (FailedTileLedger
// owns raster+hillshade while the vector loader runs its own policy), and this
// extraction must not add a third.
//
// WHAT THIS DELIBERATELY DOES NOT OWN: `firstShownMs`. It rides `EvictableTile`
// (raster-cache-budget.ts) and `admitTile` initialises it, so it arrives here by
// inheritance — but it answers "when did THIS LAYER start showing this tile",
// which is a property of the drawing layer, not of the DEM tile. Today that
// distinction is latent, not live: there is exactly one HillshadeRenderer
// (scene-renderers.ts) over one url template, so an entry is only ever drawn by
// one layer. It becomes wrong the moment a second consumer shares DEM residency
// — which is what this extraction exists to enable, and what `color-relief`
// (#2009) will do first: two layers over one DEM would share one ramp start, and
// the second to draw would inherit the first's instead of fading in. Moving the
// field is deferred to that increment, where a test can finally distinguish the
// two behaviours; the note lives at both sites so the next reader inherits the
// conclusion rather than rediscovering it.

import { tileUrl, loadImageBitmap, type TileRowScheme } from '@xgis/data'
import type { RhiDevice, RhiTexture } from '@xgis/engine'
import {
  admitTile,
  type EvictableTile,
  evictToBudget,
  overBudget,
  abortLoadingTiles,
  dropAllTiles,
  textureBytesOf,
  type LoadedTexture,
} from './raster-cache-budget'
import { FailedTileLedger, InflightLedger } from './tile-retry'

/** A resident DEM tile. Identical to the shared cache-entry shape — the DEM
 *  store adds no fields of its own (see the header on `firstShownMs`). */
export type CachedDemTile = EvictableTile

/** What `DemTileStore.resolve` hands back — D5 INC-1 (#2525). */
export interface DemResolved {
  /** The RESIDENT tile's coordinate (the exact one, or an ancestor). */
  z: number
  x: number
  y: number
  /** 0 = exact; k = the returned tile is k levels above the requested one. */
  levelsUp: number
  entry: CachedDemTile
  /** The REQUESTED tile's region inside the returned texture: the child covers
   *  `[u0, u0 + scale) x [v0, v0 + scale)`, `scale = 2^-levelsUp`. Identity at
   *  levelsUp 0. In XYZ tile space — see `resolve`. */
  sub: { scale: number; u0: number; v0: number }
}

/** The tile coordinate `tileUrl` substitutes into the template. */
interface TileCoord {
  z: number
  x: number
  y: number
  ox: number
}

/** Only the draper method eviction needs. Kept structural rather than importing
 *  `HillshadeDraper` so the store does not depend on the material layer. */
interface TextureDropper {
  dropTexture(t: RhiTexture): void
}

export class DemTileStore {
  private readonly rhi: RhiDevice
  /** Read at CALL TIME, never cached in a field. `rebuildForQuality` destroys the
   *  draper and drops it (#1578), so a stored reference would have this store
   *  dropping bind groups on a dead object one quality flip later — the #2165
   *  shape, where state captured once outlives the thing that produced it. */
  private readonly draperOf: () => TextureDropper | undefined

  private readonly tileCache = new Map<string, CachedDemTile>()
  /** Running sum of `tileCache`'s texture bytes (#1352) — `_cacheTile` and
   *  `evictTiles` are the only writers, so it cannot drift. */
  private _cachedBytes = 0
  private readonly loadingTiles = new InflightLedger((key) =>
    this.failedTiles.noteOutcome(key, false),
  )
  /** Tiles whose load resolved null, with the backoff state that stops them being
   *  re-requested every frame (policy in tile-retry.ts). Cleared when the
   *  source is re-armed — a new URL template is a new coverage. */
  readonly failedTiles = new FailedTileLedger()

  private _frameCount = 0
  private lastZoom = -1
  private lastVisibleKeys: Set<string> = new Set()

  private urlTemplate = ''
  /** The DEM source's row origin (#1985) — `'tms'` numbers tile rows from the BOTTOM, so
   *  `tileUrl` substitutes `2^z − 1 − y` for `{y}`. Undefined = `'xyz'`. It rides the
   *  template so a re-arm cannot leave a stale flip behind. */
  private scheme: TileRowScheme | undefined
  /** The template the RESIDENT tiles were fetched from (#2384 F-4) — pairs with
   *  `_cachedBytes`, which describes the same set. Distinct from `urlTemplate`,
   *  which round-trips through '' on every rebuild; see the flush. */
  private _cachedTemplate = ''

  constructor(rhi: RhiDevice, draperOf: () => TextureDropper | undefined) {
    this.rhi = rhi
    this.draperOf = draperOf
  }

  // ── Source arming ──

  setUrlTemplate(url: string, scheme?: TileRowScheme): void {
    // A different template is a different coverage, so past failures say nothing
    // about it — drop the backoff state rather than carry a stale "gave up" verdict
    // onto tiles the new source may well have.
    if (url !== this.urlTemplate) this.failedTiles.clearAll()
    // #2384 F-4 — and drop the DATA for the same reason, which this arm did not: the
    // key is `z/x/y` with no url in it, so the old DEM's resident tile answered for
    // the new source, and a VISIBLE tile is exempt from eviction — so it never healed.
    // In-flight loads are the second door: a request issued against the old url lands
    // under the same key after the swap, so the flush must abort them too.
    //
    // Keyed on the template the RESIDENT TILES belong to, not on `urlTemplate`:
    // `rebuildLayers()` resets every raster-family renderer with `setUrlTemplate('')`
    // before re-arming the live one (map.ts:3485), so a plain `url !== this.urlTemplate`
    // would drop every visible tile on each projection change or layer rebuild — correct
    // pixels bought with a full re-download. Empty is that reset and never a source, so
    // it flushes nothing; without that arm an `X -> '' -> Y` swap would launder into a
    // no-op. The raster twin runs the identical guard over `dropAllTiles`.
    if (url !== '' && url !== this._cachedTemplate) {
      abortLoadingTiles(this.loadingTiles)
      this._cachedBytes = dropAllTiles(this.tileCache, this.rhi, this.draperOf())
      this._cachedTemplate = url
    }
    this.urlTemplate = url
    this.scheme = scheme
  }

  hasSource(): boolean {
    return this.urlTemplate !== ''
  }

  // ── Residency reads (the draw loop's view) ──

  get size(): number {
    return this.tileCache.size
  }

  get frameCount(): number {
    return this._frameCount
  }

  has(key: string): boolean {
    return this.tileCache.has(key)
  }

  get(key: string): CachedDemTile | undefined {
    return this.tileCache.get(key)
  }

  /** Best resident tile at or above (z, x, y) — D5 INC-1 (#2525).
   *
   *  The exact tile when resident (`levelsUp` 0), else the nearest resident
   *  ancestor within `maxLevelsUp`. `sub` maps the REQUESTED tile onto the RETURNED
   *  texture, so a caller can sample a parent at the child's region without
   *  knowing how far up it had to go.
   *
   *  This was `HillshadeRenderer.render()`'s `findCachedParent` closure. It is
   *  promoted because INC-2's elevation sampler and INC-3's displacement need the
   *  same answer per vertex and cannot call a closure inside another object's draw
   *  loop. The draw loop keeps its behaviour as a pure move by passing a bound
   *  (it walked at most 4 levels); a sampler passes the default — a z14 vertex over
   *  a DEM resident only at z10 must still resolve, which a bound of 4 refuses.
   *
   *  `sub` is in XYZ tile space. A `tms` row scheme flips `{y}` inside `tileUrl`
   *  (the FETCH), never in the cache key, so the texture's own row orientation is
   *  the sampler's to apply on top of this — recorded here so it is not
   *  rediscovered downstream as a "flipped terrain" bug.
   *
   *  Read-only over what `request` already admitted: it never requests, and it
   *  reads no texels (CPU-side elevation is INC-2's decision, not this one's). */
  resolve(z: number, x: number, y: number, maxLevelsUp = Infinity): DemResolved | undefined {
    if (z < 0) return undefined
    const limit = Math.min(maxLevelsUp, z)
    for (let k = 0; k <= limit; k++) {
      const entry = this.tileCache.get(`${z - k}/${x >> k}/${y >> k}`)
      if (!entry) continue
      const scale = 1 / (1 << k)
      const mask = (1 << k) - 1
      return {
        z: z - k,
        x: x >> k,
        y: y >> k,
        levelsUp: k,
        entry,
        sub: { scale, u0: (x & mask) * scale, v0: (y & mask) * scale },
      }
    }
    return undefined
  }

  hasPendingLoads(): boolean {
    return this.loadingTiles.liveCount() > 0
  }

  /** Count of DEM tiles currently mid-fetch, DEADLINE-BOUNDED (#2149 — mirrors the
   *  raster arm through the shared InflightLedger). Feeds `getMissingTileCount()`
   *  and the pending-work registry's `dem-fetch` kind. */
  pendingLoadCount(): number {
    return this.loadingTiles.liveCount()
  }

  // ── Per-frame lifecycle ──

  /** Advance the frame counter that stamps `lastUsedFrame` (the LRU key). */
  nextFrame(): void {
    this._frameCount++
  }

  /** Cancel in-flight fetches for tiles finer than the new cover zoom. A zoom-out
   *  otherwise keeps paying for tiles the frame will never sample. */
  abortAboveZoom(currentZ: number): void {
    if (currentZ === this.lastZoom) return
    for (const [key, ctrl] of this.loadingTiles) {
      const tileZ = parseInt(key.split('/')[0])
      if (tileZ > currentZ) {
        ctrl.abort()
        this.loadingTiles.delete(key)
      }
    }
    this.lastZoom = currentZ
  }

  /** The keys `beginFrame`'s deferred eviction must treat as exempt. */
  noteVisible(visibleKeys: Set<string>): void {
    this.lastVisibleKeys = visibleKeys
  }

  /** Deferred eviction — runs from the host's beginFrame() only (the previous
   *  frame's queue.submit() has returned, so destroying textures can't poison a
   *  submit). */
  beginFrame(): void {
    if (overBudget(this.tileCache.size, this._cachedBytes, MAX_CACHED_TILES))
      this.evictTiles(this.lastVisibleKeys)
  }

  destroy(): void {
    abortLoadingTiles(this.loadingTiles) // #1570 — teardown must CANCEL, not just unschedule
  }

  // ── Requesting ──

  /** Admit one tile request if residency state allows it, returning whether a
   *  fetch was started. `budget` is the in-flight cap this call must respect —
   *  the leaf loop passes a reduced one on a cold start so the parent-fallback
   *  prefetch can still put a coarse tile on screen first (tile-retry.ts).
   *
   *  `evictWith` is the current frame's visible-key set: the LEAF path evicts
   *  right after admitting (the parent-fallback path deliberately does not, so a
   *  prefetch cannot evict the tile the frame is about to draw). Passing it is
   *  what selects the two behaviours; there is no second code path. */
  request(
    key: string,
    coord: TileCoord,
    budget: number,
    evictWith?: Set<string>,
    label = 'hillshade tile',
  ): boolean {
    if (this.tileCache.has(key) || this.loadingTiles.has(key)) return false
    // A tile that has failed recently is not re-requested until its backoff
    // elapses — without this, a past-max-zoom view spends the whole budget on
    // 404s every frame (tile-retry.ts explains why that path is common).
    if (!this.failedTiles.requestable(key)) return false
    if (this.loadingTiles.size >= budget) return false

    const ctrl = new AbortController()
    this.loadingTiles.set(key, ctrl)
    this.loadTileTexture(tileUrl(this.urlTemplate, coord, this.scheme), ctrl.signal)
      // #1153 P2 R4 — narrow the release to the LOAD promise: an expected load failure resolves
      // to null so the .then ALWAYS frees the loadingTiles slot (else the key wedges, pinning all
      // MAX_CONCURRENT slots → the DEM stream stalls). Scoped here so a throw from the .then
      // bookkeeping still surfaces — through the terminal handler below, not as an unhandled
      // rejection (#1565: the same leaf-vs-parent drift the raster twin carried).
      .catch(() => null)
      .then((texture) => {
        this.loadingTiles.delete(key)
        if (!texture) {
          this.failedTiles.noteOutcome(key, ctrl.signal.aborted)
          return
        }
        this.failedTiles.clear(key)
        // firstShownMs -1 = "never drawn yet"; the draw loop stamps it on the
        // tile's FIRST appearance so an off-screen prefetch still fades in.
        this._cacheTile(key, texture)
        if (evictWith) this.evictTiles(evictWith)
      })
      .catch((e) => console.error(`[X-GIS] ${label} post-load bookkeeping failed`, e))
    return true
  }

  /** True once the in-flight set is at or over `budget` — the caller's `break`
   *  condition, kept here so the cap is read off the same field it guards. */
  atBudget(budget: number): boolean {
    return this.loadingTiles.size >= budget
  }

  // ── Internals ──

  private _cacheTile(k: string, t: LoadedTexture): void {
    this._cachedBytes = admitTile(this.tileCache, k, t, this._frameCount, this._cachedBytes)
  }

  /** Drop LRU tiles until back under the count AND byte caps (#1352).
   *  Policy lives in raster-cache-budget so both renderers share one copy. */
  private evictTiles(vis: Set<string>): void {
    this._cachedBytes = evictToBudget(
      this.tileCache,
      vis,
      MAX_CACHED_TILES,
      this._cachedBytes,
      this.rhi,
      this.draperOf(),
    )
  }

  /** Tile load, through the RHI on BOTH backends (#1623 — WebGPU used to bypass the RHI
   *  entirely via the raw-device `loadImageTexture`, the last such arm in the raster
   *  family; raster's twin was closed in #1579). Verbatim raster `loadTileTexture` minus
   *  the mip chain: a DEM is DATA, not appearance, and `mip-scope-invariant.test.ts` pins
   *  it un-mipped (averaging elevation levels fabricates slope-derivatives never sampled) —
   *  the NEAREST decode this feeds is a sampler concern, in the draper. */
  private async loadTileTexture(url: string, signal: AbortSignal): Promise<LoadedTexture | null> {
    const bitmap = await loadImageBitmap(url, signal)
    if (!bitmap) return null
    // #1153 P2 R4 (ported from raster — hillshade was the pre-fix copy): createTexture throws on a
    // lost context (rhi-webgl2 :963) and copyExternalImage can throw too. Release the decoded
    // bitmap + any half-created texture and normalise to the WebGPU null contract (loadImageTexture
    // returns null on failure) so the caller's loadingTiles key is released rather than wedged; the
    // chains' .catch is the outer backstop.
    let tex: RhiTexture | null = null
    try {
      tex = this.rhi.createTexture({
        width: bitmap.width,
        height: bitmap.height,
        format: 'rgba8unorm',
        // 'render' is NOT for drawing into the tile: WebGPU's copyExternalImageToTexture requires
        // COPY_DST | RENDER_ATTACHMENT on the destination, and unlike raster's tiles (whose mip
        // chain makes createTexture auto-widen the usage, rhi-webgpu.ts #1436) this DEM texture is
        // single-level by contract, so the flag must be explicit. Caught by _hillshade-chain-gate
        // on WebGPU (10 validation errors).
        usage: ['sample', 'copy-dst', 'render'],
        label: 'hillshade-dem-tile',
      })
      this.rhi.copyExternalImage(tex, bitmap, bitmap.width, bitmap.height)
    } catch {
      bitmap.close()
      if (tex) this.rhi.destroyTexture(tex)
      return null
    }
    const bytes = textureBytesOf(bitmap.width, bitmap.height, false) // #1579 — un-mipped, as above
    bitmap.close()
    return { texture: tex, bytes }
  }
}

/** Count cap; the byte cap is the real ceiling (raster-cache-budget). */
const MAX_CACHED_TILES = 256
