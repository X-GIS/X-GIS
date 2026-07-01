// ═══ TileDataCache — in-memory compiled-tile store + byte accounting ═══
//
// Extracted VERBATIM from tile-catalog.ts (docs/research/2026-06-18-runtime-
// package-redesign.md §3.5 "TileDataCache extracts first"). This is the
// cohesive, self-contained unit TileCatalog used to own inline: the nested
// per-(tile key, source-layer) TileData map, the cumulative `_cachedBytes`
// accumulator, and the get/set/delete bookkeeping that keeps the two in sync
// so the byte-cap eviction invariant holds.
//
// Pure relocation — identical behavior, identical method bodies. TileCatalog
// keeps a thin owner reference (`this.cache`) and delegates; the eviction
// POLICY (which keys to drop) stays in TileCatalog, this owns only the
// accounting MECHANISM (what a stored tile costs and keeping the running
// total exact).
//
// Layer: L2 (data) — imports only same-or-lower layers (tile-types).

import { type TileData } from './tile-types'

export class TileDataCache {
  /** Cache of compiled tile data per (tile key, source-layer name).
   *  The inner map is keyed by MVT layer name; '' (empty string) is
   *  the "default" slice used by single-layer sources (XGVT-binary,
   *  GeoJSON-runtime) and as the legacy back-compat lookup for code
   *  that doesn't pass a sourceLayer. PMTiles emits one slice per
   *  MVT layer present in the tile, each landing under that layer's
   *  name — so a single source can serve multiple xgis layers each
   *  with its own `sourceLayer` filter. */
  private dataCache = new Map<number, Map<string, TileData>>()

  /** Cumulative byte cost of every TileData in `dataCache`, kept
   *  in sync by setSlice / dataCache.delete paths. Used by
   *  evictTiles to enforce `MAX_CACHED_BYTES` independent of
   *  tile count — a single dense city-zoom tile can hold 4-8 MB
   *  while a sparse ocean tile is < 100 KB, so count-based caps
   *  either over-shoot heap on dense scenes or churn on sparse
   *  ones. */
  private _cachedBytes = 0

  /** Best-effort byte size of a TileData. Sums every typed-array
   *  field we hold; skips `polygons` because RingPolygon is plain
   *  JS arrays (V8-internal, no byteLength) and stress-test
   *  measurement put it at ~20 % of typed-array total — not zero,
   *  but the budget cap has 25 % slack so this approximation is
   *  fine for the eviction trigger. */
  static sizeOfTileData(td: TileData): number {
    let n = 0
    n += td.vertices.byteLength + td.indices.byteLength
    n += td.lineVertices.byteLength + td.lineIndices.byteLength
    n += td.outlineIndices.byteLength
    if (td.outlineVertices) n += td.outlineVertices.byteLength
    if (td.outlineLineIndices) n += td.outlineLineIndices.byteLength
    if (td.pointVertices) n += td.pointVertices.byteLength
    // prebuiltLineSegments / prebuiltOutlineSegments INTENTIONALLY
    // omitted: VTR.doUploadTile nulls them out after GPU upload (a
    // 180 MB / 256-tile heap-saving optimisation). Including them
    // here would drift `_cachedBytes` upward — setSlice adds them
    // when the tile arrives, but the matching subtract in
    // deleteCacheEntry sees them already null. Real-device
    // inspector showed 2 catalog tiles reporting 263 MB cached
    // because of this; the byte cap then false-positive evicted
    // visible tiles, leaving currentZ stripes covered by parent-
    // walk fallback (regression: _mobile-detail-uniformity).
    return n
  }

  /** Internal: set a slice in the per-key nested map, creating the
   *  outer slot lazily. Used by cacheTileData + sub-tile gen.
   *  Maintains `_cachedBytes` so evictTiles can enforce a byte
   *  budget — same slot replacement subtracts the old data's size
   *  before adding the new one. */
  setSlice(key: number, layer: string, data: TileData): void {
    let slot = this.dataCache.get(key)
    if (!slot) { slot = new Map(); this.dataCache.set(key, slot) }
    const prev = slot.get(layer)
    if (prev) this._cachedBytes -= TileDataCache.sizeOfTileData(prev)
    slot.set(layer, data)
    this._cachedBytes += TileDataCache.sizeOfTileData(data)
  }

  /** Internal: drop a key (all slices) from dataCache. Use this
   *  instead of dataCache.delete directly so `_cachedBytes` stays
   *  in sync. */
  deleteCacheEntry(key: number): void {
    const slot = this.dataCache.get(key)
    if (!slot) return
    for (const td of slot.values()) {
      this._cachedBytes -= TileDataCache.sizeOfTileData(td)
    }
    this.dataCache.delete(key)
  }

  // ── Read accessors (thin pass-throughs over the nested map) ──

  /** The per-key slot map (MVT layer → TileData), or undefined. */
  getSlot(key: number): Map<string, TileData> | undefined {
    return this.dataCache.get(key)
  }

  has(key: number): boolean {
    return this.dataCache.has(key)
  }

  get size(): number {
    return this.dataCache.size
  }

  get cachedBytes(): number {
    return this._cachedBytes
  }

  /** Iterate [key, slot] entries — insertion order ≈ LRU. */
  entries(): IterableIterator<[number, Map<string, TileData>]> {
    return this.dataCache.entries()
  }

  /** Iterate the per-key slot maps. */
  values(): IterableIterator<Map<string, TileData>> {
    return this.dataCache.values()
  }

  /** Recompute the actual byte size of every cached TileData and
   *  compare against the running `_cachedBytes` accumulator. Drift
   *  triggered the user-reported "263 MB for 2 tiles" inspector
   *  bug (commit 497a2c1: prebuiltLineSegments were included in
   *  setSlice's add but excluded from delete after GPU upload
   *  nulled them). Activated by `globalThis.__XGIS_INVARIANTS`;
   *  production builds skip the recomputation entirely. */
  assertByteAccountingInvariant(label: string): void {
    if (!(globalThis as { __XGIS_INVARIANTS?: boolean }).__XGIS_INVARIANTS) return
    let actual = 0
    for (const slot of this.dataCache.values()) {
      for (const td of slot.values()) {
        actual += TileDataCache.sizeOfTileData(td)
      }
    }
    const drift = Math.abs(actual - this._cachedBytes)
    // 1 KB tolerance — Math.fround / typed-array byteLength rounding
    // shouldn't introduce more than a handful of bytes per tile;
    // a tile-count multiplier of <1 KB across hundreds of tiles
    // means the accounting is consistent.
    if (drift > 1024) {
      throw new Error(
        `[XGIS INVARIANT] _cachedBytes drift at ${label}: actual=${actual} `
        + `accumulator=${this._cachedBytes} drift=${drift} bytes across `
        + `${this.dataCache.size} tile slots. The setSlice / deleteCacheEntry `
        + `byte-add/subtract path is out of sync with sizeOfTileData. See `
        + `commit 497a2c1 for the prebuilt-SDF drift class.`,
      )
    }
  }
}
