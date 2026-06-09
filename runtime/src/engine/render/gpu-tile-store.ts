// ═══ GpuTileStore — resident GPU tile cache + arenas + buffer pool +
//     eviction + compaction (Cluster A; the memory core) ═══
//
// Extracted from VectorTileRenderer (Cluster A per
// .omc/plans/vtr-decomposition-2026-06-09.md §1 + the U2/U3/U4
// re-sequencing decision .omc/plans/vtr-u2-u4-resequence-2026-06-09.md,
// where this lands as "U3-prime"). This owner holds the resident GPU
// tile set within the byte/count budget: the nested `gpuCache` map, the
// three GPUArenas (poly vertex / poly index / z-buffer), the pooled
// GPU buffer recycler, the unique-key + byte-aware LRU eviction, the
// alloc-fail (OOM Lane-B) forced eviction, and the deferred post-submit
// arena compaction.
//
// VTR injects it as `private readonly _store = new GpuTileStore(device)`
// and keeps thin forwarders for the external surface (`getCacheSize`
// from label-pass.ts) so call sites are unchanged. The uploader (Cluster
// B) and the render hot loop stay on VTR; they call THROUGH this store
// (`getOrCreateLayer`/`getLayer`/arena getters/`acquireBuffer`).
//
// THE CRITICAL INVARIANTS — moved VERBATIM, asserted in tests
// (plan §5 DO-NOT-SPLIT #5):
//   1. `releaseTile` free order: line buffers releaseBuffer → outline/line
//      segment .destroy → featureDataBuffer .destroy → releaseTileHook (the
//      Cluster-D compute-handle free) → inner.delete → count--. The hook is
//      INJECTED (bound to `_featureBinder.releaseTile`); the store never
//      imports FeatureDataBinder.
//   2. Arena COMPACTION `copyBufferToBuffer` runs ONLY in the post-submit
//      safe window: `_pendingArenaCompaction` is flagged during render and
//      DRAINED by `runFrameMaintenance()` (called from VTR `beginFrame`).
//   3. Byte-aware eviction (count + bytes hysteresis, the #218 fix) +
//      the OOM Lane-B alloc-fail safety net stay byte-identical.
//
// The store holds NO back-reference to VTR. `stableKeys` (Cluster E) and
// the `releaseTileHook` (Cluster D) arrive as CALL ARGUMENTS. The
// uploadQueue active-count probe used by compaction arrives via a
// caller-supplied predicate so the store never references the queue.

import { GPUArena } from '../gpu/gpu-arena'
import { getMaxGpuTiles, ARENA_HIGH_WATER, ARENA_LOW_WATER } from './vector-tile-renderer-helpers'
import type { GPUTile } from './vector-tile-renderer-types'

/** Free a tile's per-tile ComputeLayerHandle (Cluster D). Bound to
 *  `FeatureDataBinder.releaseTile` and passed into the store's eviction
 *  entry points so the store can fire the `7b31ce52` eviction-free hook
 *  WITHOUT importing the binder — preserving the forward A→D dependency
 *  direction and the "store holds no back-reference" discipline. */
export type ReleaseTileHook = (handleKey: string) => void

export class GpuTileStore {
  private device: GPUDevice

  /** GPU tile cache keyed by `${tileKey}|${sourceLayer}`. The `sourceLayer`
   *  segment is the MVT layer slot — '' for single-layer sources
   *  (XGVT-binary, GeoJSON-runtime, sub-tiles), MVT layer name for
   *  per-layer slices (PMTiles). One tile key may have N entries here,
   *  one per xgis layer's `sourceLayer` filter. */
  /** Nested cache: outer key = MVT source-layer slot ('' for single-
   *  layer sources), inner key = numeric tile key. Lets the per-frame
   *  hot path fetch the inner Map once per `render()` call and then
   *  do pure numeric `has`/`get` lookups, eliminating composite-string
   *  allocation in the per-tile loop (was ~1.6 k allocations/frame at
   *  z=22 over Seoul × 4 PMTiles layers). */
  private gpuCache = new Map<string, Map<number, GPUTile>>()
  /** Total entries across all inner maps. Mirrors what the old flat
   *  `gpuCache.size` reported; used by eviction trigger, cache-size
   *  diagnostics, and the setLineRenderer reset guard. */
  private _gpuCacheCount = 0
  /** iter-226 — Strictly-monotonic counter assigned to each upload's
   *  `GPUTile.uploadEpoch`. Replaces the cache-size signal
   *  (`_gpuCacheCount`) in the RenderBundle cache key, where it was
   *  too coarse (changed on any upload/eviction even for tiles
   *  unrelated to the bundle). Per-tile epoch XORed across needed
   *  keys lets a hit prove every referenced tile's bind group is
   *  still the one the bundle recorded. */
  private _tileUploadEpoch = 0

  /** LRU-eviction scratch protection set — instance-level + `.clear()`-d
   *  per use to stay out of the GC nursery (plan §5 DO-NOT-REALLOCATE #6).
   *  Both `evictToBudget` and `forceEvictBytes` clear-then-refill it from
   *  the per-call `stableKeys`, so it never carries state across calls. */
  private _scratchProtectedKeys = new Set<number>()

  /** GPU buffer pool — keyed by `{powerOfTwoBucketSize}:{usage}`.
   *  doUploadTile and evictGPUTiles together create + destroy 5+
   *  GPUBuffers per tile, several times per frame on mobile during
   *  fast pinch/pan. Each createBuffer / destroy is a GPU driver
   *  call; pooling lets us hand a freed buffer straight back to
   *  the next acquire instead of round-tripping through the
   *  driver. Buckets are powers of two from 2 KB → 4 MB so size-
   *  fit reuse works across tiles with similar feature density.
   *  Cap per bucket prevents the pool itself from holding GPU
   *  memory hostage. */
  private _bufferPool = new Map<string, GPUBuffer[]>()
  private static readonly _BUFFER_POOL_CAP_PER_BUCKET = 16
  private static _bufferBucketSize(size: number): number {
    let bucket = 2048
    while (bucket < size) bucket *= 2
    return bucket
  }

  /** Phase 6a.2 (iter-208) — shared polygon vertex arena. Lazily created
   *  on first alloc so the GPUDevice is guaranteed alive (constructor runs
   *  before the device is fully configured in some test paths).
   *
   *  Sizing rationale (iter-208 initial): 64 MB caps at ~256 tiles ×
   *  ~250 KB peak polygon vertex per (tile, source-layer). Sufficient
   *  for OFM Bright/Liberty/Positron z=14 (~150 visible × ~6 source-
   *  layers ≈ ~37 MB headroom). Future Phase 6a.5 adds auto-grow if
   *  needed. */
  private polyVertexArena: GPUArena | null = null
  private static readonly POLY_VERTEX_ARENA_CAPACITY = 64 * 1024 * 1024

  /** Set true by `forceEvictBytes` when an alloc still cannot be served
   *  AFTER forced LRU eviction — i.e. the live set is fragmented (bump
   *  pointer near the cap while liveBytes is tiny) and the remaining
   *  tiles are protected stableKeys that eviction can't drop. The actual
   *  defragmenting `copyBufferToBuffer` MUST run in the post-submit safe
   *  window (NOT here, mid-render), so we only flag it; `runFrameMaintenance`
   *  drains the flag in the SAME safe window `evictToBudget` uses. */
  private _pendingArenaCompaction = false

  /** Old arena GPUBuffers retired by a compaction, awaiting destroy. A
   *  compaction swaps `arena.buffer` to a fresh packed buffer; the old
   *  buffer is pushed here and destroyed on the NEXT `runFrameMaintenance`
   *  (one full frame later), by which point the compaction's copy submit AND
   *  any command that referenced the old buffer have drained. Mirrors the
   *  uniform-ring retired-pool pattern. */
  private _retiredArenaBuffers: GPUBuffer[] = []

  private getOrCreatePolyVertexArena(): GPUArena {
    if (this.polyVertexArena === null) {
      this.polyVertexArena = new GPUArena(this.device, {
        capacityBytes: GpuTileStore.POLY_VERTEX_ARENA_CAPACITY,
        // COPY_SRC is required for compaction's copyBufferToBuffer (it
        // reads the old arena buffer as the copy SOURCE when relocating the
        // live set into the freshly-packed destination buffer).
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        label: 'poly-vertex-arena',
      })
    }
    return this.polyVertexArena
  }

  /** Phase 6a.3 (iter-209) — shared polygon index arena. Mirror of
   *  the vertex arena above. Capacity 64 MB matching vertex arena —
   *  initial 32 MB sizing underestimated demotiles-europe-z2 which
   *  exceeded 33 MB across all source-layers before eviction kicked
   *  in. Phase 6a.5 will add auto-grow + cross-test reset. */
  private polyIndexArena: GPUArena | null = null
  private static readonly POLY_INDEX_ARENA_CAPACITY = 64 * 1024 * 1024

  private getOrCreatePolyIndexArena(): GPUArena {
    if (this.polyIndexArena === null) {
      this.polyIndexArena = new GPUArena(this.device, {
        capacityBytes: GpuTileStore.POLY_INDEX_ARENA_CAPACITY,
        // COPY_SRC required for compaction (see poly-vertex-arena above).
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        label: 'poly-index-arena',
      })
    }
    return this.polyIndexArena
  }

  /** Phase 6a.4 (iter-210) — z-attribute arena. Per-vertex z (world
   *  metres) for extruded polygons. Smaller pool — only extruded
   *  tiles (e.g. fill-extrusion buildings) write here. */
  private zBufferArena: GPUArena | null = null

  constructor(device: GPUDevice) {
    this.device = device
  }

  // ── Cache accessors (cheap monomorphic field-deref getters for the
  //    render hot loop; NO allocation) ──────────────────────────────────

  /** The inner Map for a source-layer slot, or undefined when none has
   *  uploaded yet. Cheap field read for the per-tile hot path. */
  getLayer(sourceLayer: string): Map<number, GPUTile> | undefined {
    return this.gpuCache.get(sourceLayer)
  }
  /** The inner Map for a source-layer slot, creating it on first use.
   *  Used by the uploader + the render readiness path. */
  getOrCreateLayer(sourceLayer: string): Map<number, GPUTile> {
    let m = this.gpuCache.get(sourceLayer)
    if (!m) { m = new Map(); this.gpuCache.set(sourceLayer, m) }
    return m
  }
  /** Direct (sourceLayer, key) tile lookup — the cheap field-deref form
   *  for callers that don't hoist the inner Map. */
  get(sourceLayer: string, key: number): GPUTile | undefined {
    return this.gpuCache.get(sourceLayer)?.get(key)
  }
  /** The whole nested cache map. Read-only borrow for the per-tile
   *  feature bind-group rebuild (FeatureDataBinder.rebuildPerTileGroups
   *  iterates it). The store lends its container; the binder never
   *  mutates membership. */
  cache(): Map<string, Map<number, GPUTile>> {
    return this.gpuCache
  }
  /** Iterate every resident tile as [sourceLayer, key, tile]. Borrowed by
   *  callers that need a flat enumeration. */
  *eachTile(): IterableIterator<[string, number, GPUTile]> {
    for (const [sourceLayer, inner] of this.gpuCache) {
      for (const [key, tile] of inner) yield [sourceLayer, key, tile]
    }
  }

  /** Unique-composite (sourceLayer, key) entry count. Mirrors the old
   *  flat `gpuCache.size`. */
  cacheCount(): number {
    return this._gpuCacheCount
  }

  /** Assign + return the next strictly-monotonic upload epoch. Called by
   *  the uploader as it stamps each tile's `uploadEpoch`. */
  nextUploadEpoch(): number {
    return (this._tileUploadEpoch = (this._tileUploadEpoch + 1) | 0)
  }
  /** Increment the resident-entry count (uploader recorded a new tile). */
  incrementCount(): void {
    this._gpuCacheCount++
  }

  // ── GPU buffer pool ─────────────────────────────────────────────────
  acquireBuffer(size: number, usage: GPUBufferUsageFlags, label: string): GPUBuffer {
    const bucket = GpuTileStore._bufferBucketSize(size)
    const key = `${bucket}:${usage}`
    const pool = this._bufferPool.get(key)
    if (pool && pool.length > 0) return pool.pop()!
    return this.device.createBuffer({ size: bucket, usage, label })
  }
  releaseBuffer(buf: GPUBuffer | null | undefined): void {
    if (!buf) return
    const key = `${buf.size}:${buf.usage}`
    let pool = this._bufferPool.get(key)
    if (!pool) { pool = []; this._bufferPool.set(key, pool) }
    if (pool.length < GpuTileStore._BUFFER_POOL_CAP_PER_BUCKET) {
      pool.push(buf)
    } else {
      buf.destroy()
    }
  }

  // ── Arena getters (lazy-init; allocation-free probes via the public
  //    nullable getters below) ──────────────────────────────────────────
  polyVertexArenaOrCreate(): GPUArena {
    return this.getOrCreatePolyVertexArena()
  }
  polyIndexArenaOrCreate(): GPUArena {
    return this.getOrCreatePolyIndexArena()
  }
  /** Already-created vertex arena or null (allocation-free O(1) probe for
   *  the high-water / drain triggers — never force-creates). */
  polyVertexArenaOrNull(): GPUArena | null {
    return this.polyVertexArena
  }
  polyIndexArenaOrNull(): GPUArena | null {
    return this.polyIndexArena
  }
  zBufferArenaOrNull(): GPUArena | null {
    return this.zBufferArena
  }

  /** Whether a deferred arena compaction is pending. Drained by
   *  `runFrameMaintenance`. */
  pendingCompaction(): boolean {
    return this._pendingArenaCompaction
  }

  /** Reset all three arenas + drop every per-tile buffer and clear the
   *  cache — the setLineRenderer wholesale re-upload path. The per-tile
   *  buffer destroy loop goes through arenas (reset, not free), so it never
   *  touches the Cluster-D compute handles; the caller frees those via the
   *  injected hook BEFORE calling this (`releaseAllComputeHandles`). */
  resetForReupload(): void {
    for (const inner of this.gpuCache.values()) {
      for (const tile of inner.values()) {
        // Phase 6a.2/6a.3 — vertex + index buffers are shared arena
        // GPUBuffers. Per-tile destroy() would kill every other
        // tile's slice. Reset arenas once after the loop.
        tile.lineVertexBuffer?.destroy()
        tile.lineIndexBuffer?.destroy()
        tile.outlineIndexBuffer?.destroy()
        tile.outlineSegmentBuffer?.destroy()
        tile.lineSegmentBuffer?.destroy()
        tile.featureDataBuffer?.destroy()
      }
    }
    // Phase 6a.2/6a.3/6a.4 — reset every arena (keep GPU buffers
    // alive for next upload). reset() bounces the bump pointer to
    // 0 + clears the free-list — same effect as destroy + recreate
    // but without the GPU allocation cost.
    this.polyVertexArena?.reset()
    this.polyIndexArena?.reset()
    this.zBufferArena?.reset()
    this.gpuCache.clear()
    this._gpuCacheCount = 0
  }

  /** Per-frame post-submit maintenance, called from VTR `beginFrame` in the
   *  safe window the prior frame's `queue.submit()` has already drained.
   *  Runs, IN THIS ORDER (byte-identical to the in-VTR beginFrame block):
   *    1. drain `_retiredArenaBuffers` (prior compaction's old buffers),
   *    2. high-water evict trigger → `evictToBudget`,
   *    3. deferred compaction drain → `_compactPolyArenas`.
   *  `stableKeys` (E) + `releaseTileHook` (D) + the upload-active probe (B)
   *  arrive as arguments so the store references neither VTR nor the queue. */
  runFrameMaintenance(
    stableKeys: readonly number[],
    releaseTileHook: ReleaseTileHook,
    uploadActive: () => boolean,
  ): void {
    // Byte-pressure OR (Lane A): the count cap alone can't bound a large-
    // tile workload — globe / extruded tiles exhaust the 64 MB arena
    // before the unique-key count reaches getMaxGpuTiles, so the arena
    // alloc would throw every frame while the count trigger never fires.
    // ALSO trigger when an arena's bump high-water mark (usedBytes — the
    // exact value the OOM throw checks) crosses ARENA_HIGH_WATER. Read
    // only already-created arenas (the getters need an instance; never
    // force-create — a polygon-free source must not allocate 64 MB just
    // to be probed). Both getters are allocation-free O(1) field reads.
    const overCount = this._gpuCacheCount > getMaxGpuTiles()
    const vHi = this.polyVertexArena !== null
      && this.polyVertexArena.usedBytes >= GpuTileStore.POLY_VERTEX_ARENA_CAPACITY * ARENA_HIGH_WATER
    const iHi = this.polyIndexArena !== null
      && this.polyIndexArena.usedBytes >= GpuTileStore.POLY_INDEX_ARENA_CAPACITY * ARENA_HIGH_WATER
    // Drain arena buffers retired by a PRIOR frame's compaction. A full
    // frame has elapsed since they were swapped out (their copy submit +
    // every render that referenced them has long drained), so destroying
    // them now is safe — and must happen BEFORE this frame's compaction
    // pushes new entries, so the list never grows unbounded.
    if (this._retiredArenaBuffers.length > 0) {
      for (const b of this._retiredArenaBuffers) b.destroy()
      this._retiredArenaBuffers.length = 0
    }
    if (overCount || vHi || iHi) this.evictToBudget(stableKeys, releaseTileHook)
    // Deferred arena compaction (Phase 6a.5). When a mid-render alloc-fail
    // couldn't be relieved by forced eviction — because the live set is
    // FRAGMENTED (monotonic bumpPtr near the cap, liveBytes tiny) and the
    // residual tiles are protected stableKeys — forceEvictBytes flagged a
    // compaction. Run it HERE, in the post-submit safe window (the prior
    // frame's queue.submit() has returned), so the relocating
    // copyBufferToBuffer + old-buffer destroy can't poison an in-flight
    // submit. evictToBudget ran just above, so the live set is already as
    // small as protection allows before we repack it.
    if (this._pendingArenaCompaction) {
      this._pendingArenaCompaction = false
      this._compactPolyArenas(uploadActive)
    }
  }

  /** Drop LRU tiles past MAX_GPU_TILES and destroy their GPU buffers.
   *  ONLY called from `runFrameMaintenance` (and thus VTR `beginFrame`) so
   *  the previous frame's `queue.submit()` has already returned — destroying
   *  buffers here cannot poison an in-flight submit. Calling this from inside
   *  `render()` (the old behaviour) raced the bucket scheduler's
   *  multi-render-per-frame pattern; see beginFrame() for the full
   *  story. */
  evictToBudget(stableKeys: readonly number[], releaseTileHook: ReleaseTileHook): void {
    // Lane A — under-budget check consults BOTH the unique-key count cap
    // AND LIVE byte pressure. Use liveUsedBytes (which FALLS on free()),
    // NOT usedBytes (bumpPtr, monotonic-up — it never relieves, so looping
    // on it would thrash to the protected floor). Eviction drains down to
    // ARENA_LOW_WATER (hysteresis vs the HIGH_WATER trigger in beginFrame)
    // to avoid per-frame thrash.
    const cap = getMaxGpuTiles()
    const underBytes = (): boolean => {
      const vLow = this.polyVertexArena === null
        || this.polyVertexArena.liveUsedBytes <= GpuTileStore.POLY_VERTEX_ARENA_CAPACITY * ARENA_LOW_WATER
      const iLow = this.polyIndexArena === null
        || this.polyIndexArena.liveUsedBytes <= GpuTileStore.POLY_INDEX_ARENA_CAPACITY * ARENA_LOW_WATER
      return vLow && iLow
    }

    // FIX 4 — cheap early-out BEFORE the per-frame byTileKey Map build.
    // The HIGH_WATER trigger in beginFrame keys on usedBytes (bumpPtr,
    // monotonic) while the in-loop stop keys on liveUsedBytes — so in the
    // thrash window (bumpPtr high, liveBytes already under LOW_WATER) the
    // trigger keeps firing while there is nothing to evict, and we'd rebuild
    // this Map every frame for no progress. `_gpuCacheCount` is the COMPOSITE
    // (key, layer) entry count, which is ALWAYS ≥ the unique-tile-key count
    // the cap measures, so `_gpuCacheCount <= cap` conservatively implies the
    // unique count is under cap too — a sound skip. Reuses underBytes() for
    // the byte half. The full Map-building path below still runs whenever
    // either signal says there is real work.
    if (this._gpuCacheCount <= cap && underBytes()) return

    // Cap is on UNIQUE TILE KEYS, not composite (key, layer) entries —
    // a sliced source (PMTiles water/roads/buildings/...) generates
    // ~4 entries per tile, so a per-entry cap would let 100 visible
    // tiles × 4 layers = 400 entries blow MAX_GPU_TILES = 512 with
    // only 128 unique tiles. That under-counts what's actually visible
    // and triggers thrash. Counting unique keys keeps "tiles in flight"
    // bounded by tile geometry, not layer count. Slices share lifetime
    // — once a tile leaves the viewport every layer's slice is
    // irrelevant, so they evict together.
    // Aggregate per-tile-key entries across all layer slots. Each
    // bucket records the slot names (so we can drop the per-slot
    // entries together) and the latest lastUsedFrame across slots.
    const byTileKey = new Map<number, { lastUsed: number; tileZoom: number; slots: string[] }>()
    for (const [slot, inner] of this.gpuCache) {
      for (const [tk, tile] of inner) {
        let bucket = byTileKey.get(tk)
        if (!bucket) {
          bucket = { lastUsed: tile.lastUsedFrame, tileZoom: tile.tileZoom, slots: [] }
          byTileKey.set(tk, bucket)
        }
        bucket.slots.push(slot)
        if (tile.lastUsedFrame > bucket.lastUsed) bucket.lastUsed = tile.lastUsedFrame
      }
    }
    // Precise unique-tile-key re-check now that the Map is built: the
    // early-out above used the COMPOSITE count (conservative); this uses
    // the exact unique-key count + the same byte predicate. (cap +
    // underBytes hoisted to the top of this method for the early-out.)
    if (byTileKey.size <= cap && underBytes()) return

    // Eviction policy: only this frame's stableKeys are protected.
    //
    // The previous policy ALSO blanket-protected every tileZoom ≤
    // sourceMaxLevel (i.e. every archived ancestor). On a PMTiles
    // archive with maxLevel = 15, that meant essentially every cached
    // tile was protected — the cap stopped doing anything. Real-device
    // iPhone inspector showed gpuCache 317 entries past the 256 cap
    // because of this. Same fix as the catalog evictTiles change
    // earlier in this series: visible-frame protection (stableKeys =
    // neededKeys ∪ fallbackKeys) covers every ancestor sub-tile gen
    // actually needs THIS frame; ancestors for non-visible regions
    // are recoverable by re-fetch + GPU re-upload when the camera
    // returns to them — at the cost of a brief load shimmer, which
    // is far preferable to thermal throttle.
    const protectedKeys = this._scratchProtectedKeys
    protectedKeys.clear()
    for (const k of stableKeys) protectedKeys.add(k)

    const evictable: { tk: number; lastUsed: number; slots: string[] }[] = []
    for (const [tk, bucket] of byTileKey) {
      if (protectedKeys.has(tk)) continue
      evictable.push({ tk, lastUsed: bucket.lastUsed, slots: bucket.slots })
    }
    evictable.sort((a, b) => a.lastUsed - b.lastUsed)

    // Lane A — pressure-driven LRU loop (was a fixed toEvict count pass).
    // `evictable` is already LRU-sorted and already excludes
    // protectedKeys, so the loop can NEVER evict a stableKey. After each
    // tile-key eviction, re-check the stop condition: stop once BOTH the
    // count is under cap AND every arena is below the live low-water mark
    // (hysteresis). Genuine over-budget frame: if every remaining tile is
    // protected the loop simply runs out of evictable entries and exits —
    // it does NOT spin; Lane B's alloc-fail safety net handles the
    // residual.
    let evicted = 0
    for (const ev of evictable) {
      if (byTileKey.size - evicted <= cap && underBytes()) break
      for (const slot of ev.slots) this._releaseTileSlots(slot, ev.tk, releaseTileHook)
      evicted++
    }

    // Lane A — opportunistically reclaim drained arenas. free() never
    // lowers bumpPtr, so across zoom / source-layer the freed power-of-2
    // (now exact-align4) free-list won't match the next alloc's footprint
    // and a 66 MB bumpPtr stays pinned even when liveBytes is low.
    // reclaimIfDrained() resets the bump region IFF liveBytes === 0 —
    // safe because no outstanding offset can then point into it. This is
    // the only correct mid-session bump reclaim short of full compaction
    // (deferred Phase 6a.5).
    this.polyVertexArena?.reclaimIfDrained()
    this.polyIndexArena?.reclaimIfDrained()
    this.zBufferArena?.reclaimIfDrained()
  }

  /** Release one (slot, tileKey) entry: free its arena ranges + pooled
   *  GPU buffers + destroy non-poolable buffers, then delete the cache
   *  entry and decrement the count. Shared by evictToBudget (count /
   *  byte cap) and forceEvictBytes (byte-pressure on alloc-fail). Pure
   *  extraction of the former inline release block — same operations,
   *  same ORDER (arena.free → releaseBuffer → destroy), same guards — so
   *  the count-cap path is byte-for-byte behaviour-preserving. Returns
   *  the polygon vertex+index bytes reclaimed so forceEvictBytes can sum
   *  progress without a per-tile getStats(). */
  private _releaseTileSlots(
    slot: string, tk: number, releaseTileHook: ReleaseTileHook,
  ): { vBytes: number; iBytes: number } {
    const inner = this.gpuCache.get(slot)
    if (!inner) return { vBytes: 0, iBytes: 0 }
    const tile = inner.get(tk)
    if (!tile) return { vBytes: 0, iBytes: 0 }
    let vBytes = 0
    let iBytes = 0
    // Phase 6a.2 (iter-208) — polygon vertex lives in the shared arena.
    // Release the per-tile RANGE back to the arena (free-list) instead of
    // pooling the shared GPUBuffer object (which would corrupt every
    // other tile sharing this arena).
    if (this.polyVertexArena !== null) {
      this.polyVertexArena.free(tile.polyVertexOffset, tile.polyVertexByteLength)
      vBytes = tile.polyVertexByteLength
    }
    // Phase 6a.3 — index now arena-resident too. Free the range back to
    // the arena's free-list; never call releaseBuffer on the shared
    // GPUBuffer.
    if (this.polyIndexArena !== null) {
      this.polyIndexArena.free(tile.polyIndexOffset, tile.polyIndexByteLength)
      iBytes = tile.polyIndexByteLength
    }
    // Phase 6a.4 — z-buffer arena slice release. Flat (non-extruded)
    // tiles have zBufferByteLength === 0; arena.free is a silent no-op in
    // that case (GPUArena guards bytes<=0).
    if (this.zBufferArena !== null && tile.zBufferByteLength > 0) {
      this.zBufferArena.free(tile.zBufferOffset, tile.zBufferByteLength)
    }
    this.releaseBuffer(tile.lineVertexBuffer)
    this.releaseBuffer(tile.lineIndexBuffer)
    this.releaseBuffer(tile.outlineIndexBuffer)
    // SDF segment buffers are owned by lineRenderer's path; keep
    // destroying directly. Same for per-tile feature data — not pool-
    // friendly because its size depends on each tile's unique feature
    // count + variant schema.
    tile.outlineSegmentBuffer?.destroy()
    tile.lineSegmentBuffer?.destroy()
    tile.featureDataBuffer?.destroy()
    // P4 compute path — the per-tile ComputeLayerHandle (feat / out /
    // count buffer trio) is keyed `${tileKey}:${sourceLayer}` (slot here
    // IS the sourceLayer; tk IS the tileKey). Free + drop it (via the
    // FeatureDataBinder, Cluster D owner, reached through the injected
    // hook) so its buffers are reclaimed and dispatchComputePass stops
    // iterating over this evicted tile every frame. Stays AFTER
    // featureDataBuffer.destroy() — the 7b31ce52 order.
    releaseTileHook(`${tk}:${slot}`)
    inner.delete(tk)
    this._gpuCacheCount--
    return { vBytes, iBytes }
  }

  /** Forced eviction triggered ONLY on an arena alloc-fail (OOM, Lane B).
   *  Unlike evictToBudget, this ignores the UNIQUE-TILE-KEY cap and the
   *  byTileKey.size early-return — it evicts LRU *unprotected* tile keys
   *  (stableKeys stay protected so the visible frame survives) until the
   *  given arena reports at least `needed` free bytes, or no more
   *  unprotected tiles remain. Returns true if it freed enough. Called
   *  off the hot path (alloc throws are rare), so the getStats() reads
   *  + transient Map/sort here are acceptable. */
  forceEvictBytes(
    arena: GPUArena, needed: number,
    stableKeys: readonly number[], releaseTileHook: ReleaseTileHook,
  ): boolean {
    // O(1) exact serviceability probe. getStats().freeBytes is the SUM
    // across all distinct exact-align4 size-keys, so `freeBytes >= needed`
    // is a FALSE POSITIVE under fragmentation (the sum can exceed `needed`
    // while no single matching-footprint slot exists). canServe() checks
    // the matching free-list stack OR bump headroom directly, so it is
    // exact for one align4(needed) request.
    const hasRoom = (): boolean => arena.canServe(needed)
    if (hasRoom()) return true

    // LRU-ordered list of unprotected tile keys (same protection policy
    // as evictToBudget: only this frame's stableKeys are spared).
    const protectedKeys = this._scratchProtectedKeys
    protectedKeys.clear()
    for (const k of stableKeys) protectedKeys.add(k)

    const byTileKey = new Map<number, { lastUsed: number; slots: string[] }>()
    for (const [slot, inner] of this.gpuCache) {
      for (const [tk, tile] of inner) {
        if (protectedKeys.has(tk)) continue
        let bucket = byTileKey.get(tk)
        if (!bucket) {
          bucket = { lastUsed: tile.lastUsedFrame, slots: [] }
          byTileKey.set(tk, bucket)
        }
        bucket.slots.push(slot)
        if (tile.lastUsedFrame > bucket.lastUsed) bucket.lastUsed = tile.lastUsedFrame
      }
    }
    const order = [...byTileKey.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [tk, bucket] of order) {
      for (const slot of bucket.slots) this._releaseTileSlots(slot, tk, releaseTileHook)
      if (hasRoom()) return true
    }
    // Last resort: if the forced eviction drained liveBytes to 0, reclaim
    // the bump region (resets bumpPtr → 0) to expose the WHOLE arena.
    // free() alone never lowers bumpPtr, so without this the OOM path could
    // drop a tile despite having freed everything — bump headroom stays
    // pinned even at live=0. Re-probe after reclaim.
    arena.reclaimIfDrained()
    const served = hasRoom()
    if (!served) {
      // Eviction couldn't make room AND reclaim didn't fire (liveBytes > 0,
      // i.e. the remaining live tiles are protected stableKeys). This is the
      // FRAGMENTATION signature: bumpPtr is pinned near the cap by the
      // monotonic bump pointer while the stranded free-list holds footprints
      // that don't match this request. The bump can only fall via compaction
      // — but the relocating copyBufferToBuffer must run in the post-submit
      // safe window, never mid-render here. Flag it for beginFrame to drain.
      this._pendingArenaCompaction = true
    }
    return served
  }

  /** Run a deferred poly-arena compaction in the post-submit safe window.
   *  Called ONLY from `runFrameMaintenance` (after the prior frame's
   *  queue.submit() has returned, the SAME window `evictToBudget` uses) so
   *  the relocating `copyBufferToBuffer` + the old-buffer destroy can never
   *  poison an in-flight submit. Defragments BOTH polygon arenas: repacks the
   *  live set (every resident tile's vertex+index slot) to the front of a
   *  fresh buffer, then rewrites each tile's offset + buffer reference
   *  ATOMICALLY with the swap so the next frame's draws read the new buffer at
   *  the new offset (no frame can observe a half-compacted arena — the rewrite
   *  is a synchronous JS loop with no await between swap and offset write). */
  private _compactPolyArenas(uploadActive: () => boolean): void {
    const vArena = this.polyVertexArena
    const iArena = this.polyIndexArena
    if (vArena === null && iArena === null) return

    // SAFETY GUARD vs async uploads. doUploadTileAsync captures the arena
    // buffer reference (cached.vertexBuffer) BEFORE its mapAsync await, then
    // submits AFTER. An in-flight async upload can therefore be suspended
    // across this beginFrame; if we swap + retire the arena buffer now, that
    // upload would (a) submit a copy into the old buffer it already captured
    // and (b) record a tile whose buffer/offset point at the pre-compaction
    // buffer — which the NEXT compaction would mis-relocate from the new
    // buffer. Async jobs are a single mapAsync round-trip, so simply DEFER:
    // re-arm the pending flag and compact on a later frame when the upload
    // window is clear. (Mid-render sync doUploadTile cannot be in flight
    // here — beginFrame runs between frames, never inside a render call.)
    if (uploadActive()) {
      this._pendingArenaCompaction = true
      return
    }

    // Build the live relocation set from the gpuCache — the VTR owns the
    // ground truth of which offsets are live (the arena only tracks bump +
    // free-list). Each resident tile holds exactly one vertex slot and one
    // index slot. Collect tile refs in a stable order; the per-arena
    // relocation arrays index-align with this list so we can rewrite each
    // tile's offsets from the returned newOffsets.
    const tiles: GPUTile[] = []
    for (const inner of this.gpuCache.values()) {
      for (const tile of inner.values()) tiles.push(tile)
    }
    if (tiles.length === 0) {
      // Nothing live: the cheap reclaim already covers this, but be safe.
      vArena?.reclaimIfDrained()
      iArena?.reclaimIfDrained()
      return
    }

    const vReloc = vArena
      ? tiles.map((t) => ({ oldOffset: t.polyVertexOffset, bytes: t.polyVertexByteLength }))
      : null
    const iReloc = iArena
      ? tiles.map((t) => ({ oldOffset: t.polyIndexOffset, bytes: t.polyIndexByteLength }))
      : null

    // One encoder records ALL copies for both arenas; a single submit makes
    // the whole relocation atomic w.r.t. the GPU timeline.
    const encoder = this.device.createCommandEncoder({ label: 'arena-compact' })
    const vResult = vArena && vReloc ? vArena.compact(vReloc, encoder) : null
    const iResult = iArena && iReloc ? iArena.compact(iReloc, encoder) : null
    this.device.queue.submit([encoder.finish()])

    // Rewrite tile records to the new offsets + new buffer reference. This
    // is the atomic offset rewrite: it runs synchronously with no await, so
    // no frame can be rendered against a half-compacted arena. The NEXT
    // frame's draw loop reads cached.vertexBuffer + cached.polyVertexOffset,
    // which now point at the freshly-packed buffer.
    const newVBuffer = vArena?.buffer
    const newIBuffer = iArena?.buffer
    for (let k = 0; k < tiles.length; k++) {
      const t = tiles[k]
      if (vResult && newVBuffer) {
        t.vertexBuffer = newVBuffer
        t.polyVertexOffset = vResult.newOffsets[k]
      }
      if (iResult && newIBuffer) {
        t.indexBuffer = newIBuffer
        t.polyIndexOffset = iResult.newOffsets[k]
      }
    }

    // Retire the OLD buffers for destruction one frame later instead of
    // destroying them inline. The copy submit above + the prior frame's
    // render submit have both drained, so an inline destroy is safe vs
    // THOSE. The deferral is defense-in-depth against any consumer that
    // captured the old buffer ref this frame (the async-upload guard above
    // already covers the known case); next beginFrame drains the retired
    // list, by which point nothing can still reference them.
    if (vResult) this._retiredArenaBuffers.push(vResult.oldBuffer)
    if (iResult) this._retiredArenaBuffers.push(iResult.oldBuffer)
  }

  /** Tear down all GPU resources owned by the store — the eviction/teardown
   *  half of VTR's `destroy()`. The caller frees the Cluster-D compute
   *  handles (via `releaseAllComputeHandles`) BEFORE this so device memory
   *  is reclaimed in one pass; the per-tile loop here goes through arenas. */
  destroy(): void {
    for (const inner of this.gpuCache.values()) {
      for (const tile of inner.values()) {
        // Phase 6a.2/6a.3 — vertex + index buffers are shared arena
        // resources. arena.destroy() below tears them down.
        tile.lineVertexBuffer?.destroy()
        tile.lineIndexBuffer?.destroy()
        tile.outlineIndexBuffer?.destroy()
        tile.outlineSegmentBuffer?.destroy()
        tile.lineSegmentBuffer?.destroy()
        tile.featureDataBuffer?.destroy()
      }
    }
    this.gpuCache.clear()
    this._gpuCacheCount = 0
    // Phase 6a.2/6a.3/6a.4 — release every arena's GPU buffer.
    this.polyVertexArena?.destroy()
    this.polyVertexArena = null
    this.polyIndexArena?.destroy()
    this.polyIndexArena = null
    this.zBufferArena?.destroy()
    this.zBufferArena = null
    // Phase 6a.5 — destroy any arena buffers retired by a compaction that
    // haven't yet been drained by a subsequent beginFrame.
    for (const b of this._retiredArenaBuffers) b.destroy()
    this._retiredArenaBuffers.length = 0
  }
}
