// ═══ TileEvictionPolicy — LRU + byte-cap eviction, skeleton + evict-shield ═══
//
// Extracted VERBATIM from tile-catalog.ts (docs/research/2026-06-20-repo-
// separability-map.md, C5 split). This is the cross-cutting cache-retention
// concern TileCatalog used to own inline: the permanently-pinned low-zoom
// skeleton key set, the transient just-prefetched evict-shield, and the
// LRU + byte-cap eviction sweep that honours both protection channels.
//
// Pure relocation — identical behavior, identical method bodies. The
// catalog keeps a thin owner reference (`this.eviction`) and delegates;
// the cache (the accounting MECHANISM) stays in TileDataCache, this owns
// the eviction POLICY (which keys to drop) + the two protection sets.
//
// Layer: L2 (data) — imports only same-or-lower layers.

import { TileDataCache } from './tile-data-cache'
import { MAX_CACHED_TILES, maxCachedBytes } from './tile-types'

export class TileEvictionPolicy {
  /** Permanently-pinned keys: the global low-zoom skeleton that
   *  guarantees `classifyFallback`'s ancestor walk always succeeds
   *  during fast-pan. Mirrors Cesium `QuadtreePrimitive`'s
   *  `_doNotDestroySubtree` (root-tile permanent retention) and
   *  NASA-AMMOS 3D Tiles Renderer's protected `lruCache` anchors —
   *  fast-pan to a brand-new region on the globe used to drop into
   *  the `pending` decision (no fallback geometry pushed) and the
   *  canvas cleared white through the gap. With a pinned z=0..N
   *  skeleton the walk hits a cached ancestor in ≤ N hops every
   *  time. Populated lazily by {@link markSkeleton} (called by the
   *  PMTiles / TileJSON attach path); honoured by `evictTiles` and
   *  `cancelStale` so it survives both LRU pressure AND backend-fetch
   *  cancellation between prewarm pump retries. */
  private _skeletonKeys = new Set<number>()

  /** Eviction shield for just-prefetched keys: key → expiresAt ms.
   *  Distinct from the catalog's cancel-shield (`_prefetchKeys`,
   *  frame-counted age-out) — eviction happens against the catalog's
   *  MAX_CACHED_TILES cap, which on world-scale pan can fire many
   *  times per second. Without an evict shield the readiness gate's
   *  just-fetched target-LOD bytes get evicted next frame because the
   *  held cz's stableKeys don't include them yet, and the gate
   *  re-fetches forever (regression:
   *  _zoom-transition-blank-tiles.spec.ts zoom-in 13 → 16). 5 s is
   *  long enough to bridge gate hold → cz advance → tile becomes
   *  part of the new neededKeys (and thus protectedKeys). */
  private _evictShield = new Map<number, number>()

  // Reduced 5 s → 2 s after real-device inspector (iPhone) showed
  // 62 keys still protected by the shield while catalog cache sat
  // at 296 MB. With 5 s TTL + a steady stream of prefetch the shield
  // population grew faster than the natural eviction churn could
  // drain it. 2 s still bridges the prefetch → cz-advance gap on
  // mobile (typical step LOD fetch settles in 0.5-1 s).
  static readonly EVICT_SHIELD_TTL_MS = 2_000

  /** Pin `keys` as permanent skeleton — they survive `evictTiles`
   *  unconditionally and `cancelStale` never aborts their in-flight
   *  fetch. */
  markSkeleton(keys: Iterable<number>): void {
    for (const k of keys) this._skeletonKeys.add(k)
  }

  /** Release skeleton pins — the budget-stopped / never-arrived keys of
   *  a prewarm pump (#1045) — so ordinary LRU eviction can reclaim any
   *  stray that did land. Safe on keys that were never marked. */
  unmarkSkeleton(keys: Iterable<number>): void {
    for (const k of keys) this._skeletonKeys.delete(k)
  }

  /** True when there are any pinned skeleton keys. */
  get hasSkeleton(): boolean {
    return this._skeletonKeys.size > 0
  }

  /** Iterate the pinned skeleton keys. */
  get skeletonKeys(): Iterable<number> {
    return this._skeletonKeys
  }

  /** Shield `key` from eviction until `expiresAt` ms. Called from the
   *  prefetch path so just-fetched target-LOD bytes survive until the
   *  cz advance puts them into the frame's protected set. */
  shield(key: number, expiresAt: number): void {
    this._evictShield.set(key, expiresAt)
  }

  /** Backing evict-shield map. Exposed so TileCatalog can surface it
   *  under the `_evictShield` name the catalog test escape-hatches
   *  reach (tile-catalog-skeleton / -lifecycle assert directly on the
   *  shield Map). Read-only contract — only `shield()` mutates it
   *  outside the eviction sweep. */
  get shieldMap(): Map<number, number> {
    return this._evictShield
  }

  evictTiles(cache: TileDataCache, protectedKeys: Set<number>): void {
    cache.assertByteAccountingInvariant('evictTiles-entry')
    // Snapshot the protected keys that ARE in catalog pre-eviction —
    // these must survive the eviction call (Cesium replacement
    // invariant). Only takes effect when invariants are enabled.
    const _inv = (globalThis as { __XGIS_INVARIANTS?: boolean }).__XGIS_INVARIANTS
    // Both protectedKeys (frame-scoped: stableKeys + ancestors) and
    // _skeletonKeys (permanent low-zoom base) must survive eviction.
    // Union them into the invariant snapshot so a regression that
    // accidentally drops a skeleton key fires the same audit error
    // as a frame-protected drop — single failure mode, single
    // diagnostic.
    const _protectedPresent = _inv
      ? new Set([...protectedKeys, ...this._skeletonKeys].filter((k) => cache.has(k)))
      : null
    // Two caps: byte-based (tight, accurate) and count-based
    // (loose safety net). Either tripping is enough to trigger
    // eviction; the loop runs until BOTH are under their limits.
    const _byteCap = maxCachedBytes()
    // Sweep expired evict-shield entries on EVERY call, before the
    // under-budget early-return below. The shield's only removal path
    // used to sit after that return, so a map that stays under the cap
    // while still prefetching never drained the shield — it grew
    // monotonically (JS-heap growth + progressively slower has()).
    const _now = Date.now()
    for (const [k, exp] of this._evictShield) {
      if (exp <= _now) this._evictShield.delete(k)
    }
    if (cache.size <= MAX_CACHED_TILES && cache.cachedBytes <= _byteCap) {
      // Nothing to do — but still verify the protected set wasn't
      // accidentally dropped by some prior code path.
      if (_inv && _protectedPresent) {
        for (const k of _protectedPresent) {
          if (!cache.has(k)) {
            throw new Error(
              `[XGIS INVARIANT] protected key ${k} missing from catalog at evictTiles entry — replacement invariant violated by a prior code path`,
            )
          }
        }
      }
      return
    }

    // Eviction: anything not in `protectedKeys` (visible + fallback
    // ancestors for the current frame) is fair game. The previous
    // policy ALSO blanket-protected every z ≤ maxLevel ancestor
    // archive-wide so over-zoom sub-tile gen could re-clip from a
    // surviving ancestor — but that protection scaled with the
    // number of regions the user pans through, and on world-scale
    // navigation it grew without bound (multi-GB heap → OOM the
    // user reported on the live PMTiles archive, repro:
    // _pmtiles-stress-leak.spec.ts).
    //
    // The visible-frame protection (caller passes stableKeys =
    // neededKeys ∪ fallbackKeys) covers every ancestor sub-tile
    // gen actually needs THIS frame; ancestors for non-visible
    // regions are recoverable by re-fetching when the camera
    // returns to them — at the cost of a brief load shimmer, which
    // is far preferable to OOM.
    // (Expired evict-shield entries were already swept above the
    // early-return guard so the shield drains every call.)
    // Also protect keys the catalog prefetched within the last
    // EVICT_SHIELD_TTL_MS (5 s). The held-cz step prefetch lives
    // here for long enough to bridge the gap between fetch
    // completing and the cz advance that puts the key into
    // stableKeys — without that bridge the gate stalls forever
    // (regression: _zoom-transition-blank-tiles.spec.ts).
    // Skeleton keys (Cesium-style permanent base layer) are
    // unconditionally protected — see `_skeletonKeys` doc.
    const entries = [...cache.entries()].filter(
      ([key]) =>
        !protectedKeys.has(key) && !this._evictShield.has(key) && !this._skeletonKeys.has(key),
    )

    // Insertion order ≈ LRU (Map iteration order is insertion order;
    // re-inserts on access would yield true LRU but cacheTileData
    // / setSlice doesn't re-insert).
    let i = 0
    while (i < entries.length && (cache.size > MAX_CACHED_TILES || cache.cachedBytes > _byteCap)) {
      cache.deleteCacheEntry(entries[i][0])
      i++
    }
    cache.assertByteAccountingInvariant('evictTiles-exit')

    // Cesium replacement-invariant audit: every protected key that
    // was present pre-eviction must still be present post-eviction.
    // The filter above skipped these so the loop above shouldn't have
    // touched them — this catches future regressions where the filter
    // is altered.
    if (_inv && _protectedPresent) {
      for (const k of _protectedPresent) {
        if (!cache.has(k)) {
          throw new Error(
            `[XGIS INVARIANT] protected key ${k} was evicted despite being in ` +
              `protectedKeys — replacement invariant violated. The eviction ` +
              `filter at evictTiles must skip every key in protectedKeys.`,
          )
        }
      }
    }
  }
}
