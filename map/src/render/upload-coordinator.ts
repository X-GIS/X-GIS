// ═══ Upload Coordinator ═══
// Owns the renderer-side GPU tile-upload pipeline that used to live inline
// on VectorTileRenderer: the priority queue + per-frame upload cap +
// stale-cancel, the atomic polygon-arena alloc (`_allocPolyPair`), and the
// SINGLE tile-upload dispatch body shared by the sync (mid-render fallback)
// and async (queued background) routes.
//
// WHY THIS EXISTS — the twin-body hazard it removes:
//   The two upload routes (`doUploadTile` sync + `doUploadTileAsync` async)
//   were ~85 % identical — same polygon-arena alloc, same OOM evict+retry,
//   same line/outline acquire + segment build, same cache-entry shape, same
//   memory nulling, same catch backstop — differing ONLY in how bytes reach
//   the GPU (immediate `queue.writeBuffer` vs the staging-pool mapAsync
//   path). Two siblings that must agree is exactly the divergence shape this
//   codebase's bugs live in: a fix to one branch silently skips the other.
//   Here both routes run ONE body (`_dispatch`) parameterised by a
//   `TileWriteSink` write-strategy, so the shared logic cannot diverge.
//
// THE SYNC/ASYNC FORK, contained to ONE place:
//   The async route SUSPENDS (staging mapAsync round-trip) and therefore
//   needs a post-await UAF/compaction guard + a same-key race guard + a
//   single `queue.submit`; the sync route must NOT suspend (mid-render
//   fallback uploads have to be on the GPU before the next render command
//   in the same call — see VectorTileRenderer's fallback paths). `_dispatch`
//   is an `async` function whose every `await` sits behind `sink.deferred`
//   (false for the sync sink) or an `instanceof Promise` check, so when
//   driven by the SYNC sink it reaches ZERO awaits and runs to completion
//   synchronously — the caller's immediate cache read sees the entry. The
//   ASYNC sink's writes are staged and the one `if (sink.deferred)` block
//   carries the suspension + guards + submit. That block is the only place
//   the two routes diverge.

import { GPUArena } from '@xgis/engine'
import { StagingBufferPool, asyncWriteBuffer } from '@xgis/rhi-webgpu'
import { PriorityQueue, PriorityQueueItemRemovedError } from '@xgis/shared'
import { buildLineSegments } from '@xgis/data'
import type { LineRenderer } from './line-renderer'
import { generateWallMeshExtrudedECEF } from '../core/polygon-mesh'
import { markStart as perfMarkStart, markEnd as perfMarkEnd } from '../__profile__/perf-marks'
import { xlog } from '@xgis/shared'
import type { TileData } from '@xgis/data'
import type { GPUTile } from './vector-tile-renderer-types'
import type { RhiBindGroup, RhiBuffer, RhiDevice } from '@xgis/engine'
import type { WebGpuDevice } from '@xgis/rhi-webgpu'

/** The subset of `GpuTileStore` the upload pipeline drives. Declared
 *  structurally so the real store satisfies it without an explicit
 *  `implements`, and unit tests can pass a plain stub. */
export interface UploadStore {
  getLayer(sourceLayer: string): Map<number, GPUTile> | undefined
  getOrCreateLayer(sourceLayer: string): Map<number, GPUTile>
  polyVertexArenaOrCreate(): GPUArena
  polyIndexArenaOrCreate(): GPUArena
  polyVertexArenaOrNull(): GPUArena | null
  polyIndexArenaOrNull(): GPUArena | null
  acquireBuffer(size: number, usage: GPUBufferUsageFlags, label: string): GPUBuffer
  releaseBuffer(buf: GPUBuffer | null | undefined): void
  incrementCount(): void
  nextUploadEpoch(): number
  forceEvictBytes(
    arena: GPUArena,
    needed: number,
    stable: readonly number[],
    hook: (k: string) => void,
  ): boolean
}

/** Injected collaborator port. The coordinator holds NO back-reference to
 *  VectorTileRenderer — every dependency arrives through this host (the same
 *  zero-coupling discipline `GpuTileStore` uses). Mutable-per-frame values
 *  (lineRenderer wired later, uniform ring created lazily, frameCount /
 *  stableKeys reassigned each frame) arrive as getters so the closures read
 *  live state at call time. */
export interface UploadHost {
  readonly device: GPUDevice
  /** Backend-blind RHI device — the poly-arena writes route through it (#832;
   *  byte-identical on WebGPU where rhi.writeBuffer IS queue.writeBuffer). */
  readonly rhi: RhiDevice
  readonly stagingPool: StagingBufferPool
  readonly store: UploadStore
  /** SDF line renderer (set externally on VTR; null until wired). */
  lineRenderer(): LineRenderer | null
  /** Per-tile feat_data buffer + bind group, or null when nothing to build.
   *  Wraps the FeatureDataBinder + uniform-ring buffer + palette resources
   *  so those stay off the coordinator's dependency surface. */
  buildPerTileFeatureData(
    featureProps: ReadonlyMap<number, Record<string, unknown>> | undefined,
    handleKey: string,
  ): { buffer: GPUBuffer; bindGroup: GPUBindGroup } | null
  frameCount(): number
  /** Current frame's protected (visible + ancestor) tile keys — eviction
   *  must not drop these. Reassigned each frame, so read at call time. */
  stableKeys(): readonly number[]
  /** Compute-handle release hook for the store's eviction path. */
  releaseTileHook(handleKey: string): void
  /** Warn-once dedup (FrameDrawStats), shared with the rest of VTR. */
  hasWarned(key: string): boolean
  markWarned(key: string): void
}

/** Write-strategy: the ONLY behavioural axis on which the sync + async
 *  upload routes differ. `deferred` selects the suspension boundary in
 *  `_dispatch`. */
interface TileWriteSink {
  /** True for the staging-pool (async) sink: `_dispatch` must await the
   *  staged writes + run the UAF/race guards + submit. False for the sync
   *  sink: writes already landed, no suspension. */
  readonly deferred: boolean
  /** Land `data` into `dst` at `offset`. Sync: `queue.writeBuffer` now.
   *  Async: stage into this tile's command encoder (batched, submitted in
   *  `submit()`). */
  write(dst: GPUBuffer, offset: number, data: ArrayBuffer | ArrayBufferView): void
  /** Land `data` into an RHI-handled buffer (the poly arenas, #832). Sync:
   *  `rhi.writeBuffer` now (=== queue.writeBuffer on WebGPU). Async: unwraps
   *  at this WebGPU-only seam and stages like write(). */
  writeRhi(dst: RhiBuffer, offset: number, data: ArrayBuffer | ArrayBufferView): void
  /** Create + write a line-segment STORAGE buffer, returning it. Sync
   *  returns the buffer directly; async returns a promise that resolves
   *  once the segment write is encoded (the buffer is created eagerly so
   *  the caller can bind it immediately). */
  uploadSegment(segData: Float32Array): GPUBuffer | Promise<GPUBuffer>
  /** Await every staged write (async only; no-op-shaped for sync — never
   *  called on the sync path). Collects the staging-slot releases. */
  awaitWrites(): Promise<void>
  /** Submit this tile's encoder + return all staging slots (async only). */
  submit(): void
  /** Return all collected staging slots WITHOUT submitting — the UAF bail
   *  (async only). */
  releaseAll(): void
}

/** Sync write strategy — `device.queue.writeBuffer`. Used for mid-render
 *  fallback uploads that must be GPU-resident before the next render command
 *  in the same call. Reaches no suspension (`deferred = false`). */
class SyncWriteSink implements TileWriteSink {
  readonly deferred = false
  constructor(
    private readonly device: GPUDevice,
    private readonly rhi: RhiDevice,
    private readonly lineRenderer: LineRenderer | null,
  ) {}
  write(dst: GPUBuffer, offset: number, data: ArrayBuffer | ArrayBufferView): void {
    this.device.queue.writeBuffer(dst, offset, data as BufferSource)
  }
  writeRhi(dst: RhiBuffer, offset: number, data: ArrayBuffer | ArrayBufferView): void {
    // === queue.writeBuffer on WebGPU (byte-identical); bufferSubData on WebGL2.
    this.rhi.writeBuffer(dst, offset, data as BufferSource)
  }
  uploadSegment(segData: Float32Array): GPUBuffer {
    return this.lineRenderer!.uploadSegmentBuffer(segData)
  }
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async awaitWrites(): Promise<void> {}
  submit(): void {}
  releaseAll(): void {}
}

/** Async write strategy — staging-pool `mapAsync` + one command-encoder per
 *  tile, batched into a single `queue.submit`. Used for queued background
 *  uploads where the JS thread can yield across the mapAsync round-trip. */
class AsyncWriteSink implements TileWriteSink {
  readonly deferred = true
  private readonly encoder: GPUCommandEncoder
  private readonly writeHandles: Array<Promise<{ release: () => void }>> = []
  private readonly releases: Array<() => void> = []
  constructor(
    private readonly pool: StagingBufferPool,
    private readonly device: GPUDevice,
    private readonly rhi: WebGpuDevice,
    private readonly lineRenderer: LineRenderer | null,
    key: number,
  ) {
    // One command encoder per tile — every copyBufferToBuffer batches into
    // a single submit at the end, minimising queue-submission overhead.
    this.encoder = device.createCommandEncoder({ label: `tile-upload-${key}` })
  }
  write(dst: GPUBuffer, offset: number, data: ArrayBuffer | ArrayBufferView): void {
    this.writeHandles.push(asyncWriteBuffer(this.pool, this.encoder, dst, offset, data))
  }
  writeRhi(dst: RhiBuffer, offset: number, data: ArrayBuffer | ArrayBufferView): void {
    // This sink is inherently WebGPU (staging pool + native encoder), so the
    // native unwrap lives HERE — the map's WebGPU seam — not in the engine.
    this.write(this.rhi.unwrapBuffer(dst), offset, data)
  }
  async uploadSegment(segData: Float32Array): Promise<GPUBuffer> {
    const seg = await this.lineRenderer!.uploadSegmentBufferAsync(segData, this.encoder, this.pool)
    this.releases.push(seg.release)
    return seg.buffer
  }
  async awaitWrites(): Promise<void> {
    // mapAsync round-trips overlap, so the wall-clock cost is one round-trip
    // (not N). After this the encoder holds every copy command for the tile.
    const settled = await Promise.all(this.writeHandles)
    for (const h of settled) this.releases.push(h.release)
  }
  submit(): void {
    // Single submit per tile. The GPU now consumes staging → dst. Then return
    // staging slots to the pool — subsequent borrows mapAsync, which natively
    // waits for the just-submitted copy to finish before re-mapping for write.
    this.device.queue.submit([this.encoder.finish()])
    for (const release of this.releases) release()
  }
  releaseAll(): void {
    for (const release of this.releases) release()
  }
}

export class UploadCoordinator {
  private readonly uploadQueue: PriorityQueue<string, void>
  private readonly uploadItemData = new Map<
    string,
    { key: number; data: TileData; sourceLayer: string }
  >()

  /** Set by `destroy()` before the arenas are torn down. In-flight async
   *  dispatch coroutines suspended on the staging mapAsync round-trip
   *  re-check this after their awaits and bail WITHOUT submitting — else
   *  their `queue.submit` would reference the now-destroyed poly-vertex/index
   *  arena buffer ("used in submit while destroyed"). */
  private _destroyed = false

  // ── Per-frame upload cap (cap-deferral) ──
  // `uploadTile` is per-SLICE (an 80-layer style emits ~80 calls per visible
  // tile), so an unbounded per-frame drain stalls the JS thread. The cap
  // bounds the uploads that START work this frame; overflow is held in
  // `_heldUploads` and replayed at `resetFrameCap`.
  private _uploadsThisFrame = 0
  private _heldUploads: { key: number; data: TileData; sourceLayer: string }[] = []
  private _heldUploadIds = new Set<string>()
  /** Mirror of `_heldUploads`'s tile keys (sliceLayer-collapsed), read by
   *  `classifyTile`'s `hasOtherSliceHeld` predicate so every slice of one
   *  tile stays on the same fallback level until the slowest catches up. */
  private _heldUploadKeys = new Set<number>()

  constructor(
    private readonly host: UploadHost,
    /** Injectable for unit tests; production passes nothing → a real queue. */
    queue: PriorityQueue<string, void> = new PriorityQueue<string, void>(),
  ) {
    this.uploadQueue = queue
  }

  // ───────────────────────── Enqueue + cap ─────────────────────────

  /** Route an upload through the priority queue (the background path). The
   *  queue caps concurrent uploads via `maxJobs`; same-(key,layer) dedup
   *  uses the queue's identity Map. Over-cap slices are held + replayed at
   *  `resetFrameCap`. */
  enqueue(key: number, data: TileData, sourceLayer = ''): void {
    if (this.host.store.getLayer(sourceLayer)?.has(key)) return
    const id = `${key}:${sourceLayer}`
    if (this.uploadQueue.has(id)) return
    if (this._heldUploadIds.has(id)) return // already deferred to next frame

    // Per-frame SLICE-upload cap. cap=4 desktop is the empirical sweet spot
    // (z=14 Tokyo / OFM Bright): convergence bounded, per-frame stall
    // tolerable. Mobile gets 1 (matches the prior uploadBudgetFor floor).
    const cap = typeof window !== 'undefined' && window.innerWidth <= 900 ? 1 : 4
    if (this._uploadsThisFrame >= cap) {
      this._heldUploads.push({ key, data, sourceLayer })
      this._heldUploadIds.add(id)
      this._heldUploadKeys.add(key)
      return
    }
    this._uploadsThisFrame++

    this.uploadItemData.set(id, { key, data, sourceLayer })
    this.uploadQueue
      .add(id, async () => {
        const item = this.uploadItemData.get(id)
        this.uploadItemData.delete(id)
        if (!item) return
        // #832 — the async sink is WebGPU staging machinery; on the WebGL2
        // backend the RHI sync sink lands the bytes directly (bufferSubData).
        const sink =
          this.host.rhi.backend === 'webgl2'
            ? new SyncWriteSink(this.host.device, this.host.rhi, this.host.lineRenderer())
            : new AsyncWriteSink(
                this.host.stagingPool,
                this.host.device,
                this.host.rhi as WebGpuDevice,
                this.host.lineRenderer(),
                item.key,
              )
        await this._dispatch(item.key, item.data, item.sourceLayer, sink)
      })
      .catch((err: unknown) => {
        this.uploadItemData.delete(id)
        // PriorityQueueItemRemovedError is the expected outcome when
        // `cancelStale` drops a queued upload (camera moved past the tile) —
        // a normal flow signal, not an error.
        if (err instanceof PriorityQueueItemRemovedError) return
        xlog.error('[upload queue]', err)
      })
  }

  /** Release the per-frame upload slot counter and replay any tiles held
   *  over from the previous frame. Called from beginFrame. */
  resetFrameCap(): void {
    this._uploadsThisFrame = 0
    if (this._heldUploads.length === 0) return
    const held = this._heldUploads
    this._heldUploads = []
    this._heldUploadIds.clear()
    this._heldUploadKeys.clear()
    for (const item of held) {
      // Re-deferrals (cap exceeded again) repopulate the held sets via the
      // push branch in `enqueue`; successful uploads leave the key out.
      this.enqueue(item.key, item.data, item.sourceLayer)
    }
  }

  /** Kick the queue. Mostly a no-op in steady state (the queue auto-
   *  schedules via queueMicrotask); an explicit flush point after a burst
   *  of `enqueue` calls. */
  drain(): void {
    this.uploadQueue.tryRunJobs()
  }

  /** Drop queued + held uploads for tiles the camera has moved past. Items
   *  outside `activeKeys` are safe to drop; their prebuilt SDF segment
   *  buffers are nulled so `TileCatalog.sizeOfTileData`'s omission invariant
   *  (segments assumed absent post-upload) stays true. */
  cancelStale(activeKeys: ReadonlySet<number>): void {
    const itemData = this.uploadItemData
    const staleIds: string[] = []
    for (const [id, item] of itemData) {
      if (!activeKeys.has(item.key)) staleIds.push(id)
    }
    if (staleIds.length === 0 && this._heldUploads.length === 0) return
    if (staleIds.length > 0) {
      const staleSet = new Set(staleIds)
      // removeByFilter rejects the dropped items' promises with
      // PriorityQueueItemRemovedError; the enqueue `.catch` handles it.
      this.uploadQueue.removeByFilter((id) => staleSet.has(id))
      for (const id of staleIds) {
        const item = itemData.get(id)
        if (item) releasePrebuiltSegments(item.data)
        itemData.delete(id)
      }
    }
    // Compact _heldUploads in-place; the id + key mirror sets are rebuilt
    // from the survivors so `classifyTile`'s coherence guard stays accurate.
    if (this._heldUploads.length > 0) {
      const kept: typeof this._heldUploads = []
      this._heldUploadIds.clear()
      this._heldUploadKeys.clear()
      for (const item of this._heldUploads) {
        if (activeKeys.has(item.key)) {
          kept.push(item)
          this._heldUploadIds.add(`${item.key}:${item.sourceLayer}`)
          this._heldUploadKeys.add(item.key)
        } else {
          releasePrebuiltSegments(item.data)
        }
      }
      this._heldUploads = kept
    }
  }

  // ───────────────────────── Queue surface ─────────────────────────

  /** Whether tiles are queued or actively uploading (scene not converged). */
  hasPending(): boolean {
    return this.uploadQueue.running
  }
  /** Diagnostic: full queue depth (queued + active). */
  pendingCount(): number {
    return this.uploadQueue.size() + this.uploadQueue.activeCount()
  }
  /** Diagnostic: queued (not yet dispatched) count. */
  queueSize(): number {
    return this.uploadQueue.size()
  }
  /** Whether any upload is actively in flight (the compaction-safety probe). */
  isActive(): boolean {
    return this.uploadQueue.activeCount() > 0
  }
  /** Whether `key` has a slice sitting in the held (cap-deferred) queue. */
  isHeld(key: number): boolean {
    return this._heldUploadKeys.has(key)
  }

  /** Install the distance-priority comparator (closer tiles dispatch first).
   *  Idempotent at the call site (VTR gates it once). */
  installPriority(distSq: (key: number) => number): void {
    const itemData = this.uploadItemData
    this.uploadQueue.priorityCallback = (a, b) => {
      const ia = itemData.get(a),
        ib = itemData.get(b)
      if (!ia || !ib) return 0
      return distSq(ib.key) - distSq(ia.key)
    }
  }
  /** Per-frame concurrent-upload cap (from `uploadBudgetFor`). */
  setMaxJobs(n: number): void {
    this.uploadQueue.maxJobs = n
  }
  /** Force the next sort to re-run (camera moved → distances changed). */
  markQueueDirty(): void {
    this.uploadQueue.markDirty()
  }

  /** Tear down the upload queue. Marks destroyed FIRST so any in-flight
   *  async dispatch suspended on staging mapAsync skips its submit, then
   *  drops every still-queued upload. */
  destroy(): void {
    this._destroyed = true
    this.uploadQueue.removeByFilter(() => true)
    this.uploadItemData.clear()
  }

  // ───────────────────────── Upload dispatch ─────────────────────────

  /** Mid-render fallback upload (sync). Data is GPU-resident before this
   *  returns — `_dispatch` reaches no await under the sync sink, so the
   *  caller's immediate `layerCache` read sees the entry. */
  uploadSync(key: number, data: TileData, sourceLayer = ''): void {
    const sink = new SyncWriteSink(this.host.device, this.host.rhi, this.host.lineRenderer())
    // No await is hit under the sync sink → the returned promise is already
    // resolved and every side effect (cache.set) has run synchronously.
    void this._dispatch(key, data, sourceLayer, sink)
  }

  /** Lane B — atomic polygon vertex+index arena alloc. Allocates the vertex
   *  slot first, then the index slot; if the index alloc throws (arena OOM)
   *  the already-claimed vertex slot is freed so a failed pair NEVER leaks.
   *  Returns null on any failure (caller runs forced eviction + retry, then
   *  warn-and-skip). Shared by both routes so OOM handling cannot diverge. */
  private _allocPolyPair(
    vArena: GPUArena,
    iArena: GPUArena,
    vBytes: number,
    iBytes: number,
  ): { v: number; i: number } | null {
    let v: number | null = null
    try {
      v = vArena.alloc(vBytes)
      const i = iArena.alloc(iBytes)
      return { v, i }
    } catch {
      if (v !== null) vArena.free(v, vBytes) // no partial leak
      return null
    }
  }

  /** THE single tile-upload body, shared by both routes via `sink`. Byte-
   *  for-byte the same GPU ops as the original twins; the ONLY route-
   *  specific code is `sink.write` / `sink.uploadSegment` and the one
   *  `if (sink.deferred)` suspension block. */
  private async _dispatch(
    key: number,
    data: TileData,
    sourceLayer: string,
    sink: TileWriteSink,
  ): Promise<void> {
    const store = this.host.store
    const layerCache = store.getOrCreateLayer(sourceLayer)
    if (layerCache.has(key)) return // already uploaded

    // Orphan-leak tracking for the catch backstop: a throw landing AFTER the
    // polygon vertex/index alloc but BEFORE `layerCache.set` would orphan
    // those slots (never recorded → never freed). Track offsets (−1 = unset)
    // + byte lengths + the arenas so the catch can free any claimed slot.
    let polyVertexOffset = -1
    let polyIndexOffset = -1
    let polyVertexFreeBytes = 0
    let polyIndexFreeBytes = 0
    let polyVertexArena: GPUArena | null = null
    let polyIndexArena: GPUArena | null = null
    // Set true once the poly slots are handed to the cache entry — the catch
    // backstop must NOT free them after that.
    let polySlotsCached = false
    // Hoisted OUTSIDE the try so the catch backstop can free buffers acquired
    // before a pre-cache throw — else those line/index + segment buffers leak.
    let lineVertexBuffer: GPUBuffer | null = null
    let lineIndexBuffer: GPUBuffer | null = null
    let outlineIndexBuffer: GPUBuffer | null = null
    let outlineSegmentBuffer: GPUBuffer | null = null
    let lineSegmentBuffer: GPUBuffer | null = null
    // Bail-site cleanup: the early-returns below (UAF/compaction guard,
    // same-key race guard) and the catch all return BEFORE layerCache.set,
    // so the line/outline + segment buffers are never recorded and the tile-
    // slot release path can never reach them. Each bail site calls this to
    // return the pooled index/vertex buffers + destroy the segment buffers.
    const cleanupLineBuffers = () => {
      store.releaseBuffer(lineVertexBuffer)
      store.releaseBuffer(lineIndexBuffer)
      store.releaseBuffer(outlineIndexBuffer)
      outlineSegmentBuffer?.destroy()
      lineSegmentBuffer?.destroy()
    }

    try {
      // ── Polygon vertex pipeline (ECEF-DSFUN) ──
      // Flat slices pass `data.vertices` (tiler's quantized ECEF stride)
      // through unchanged. Extruded slices route through the wall-mesh
      // generator for the unified walls + roof stride-14 buffer.
      const useFeatureHeights = data.heights !== undefined && data.heights.size > 0
      let polyVerts: ArrayBuffer
      let polyIndices: Uint32Array
      let dequantScale: number
      let dequantHalf: number
      if (useFeatureHeights && data.polygons) {
        // ECEF tile-corner anchor — must match the compiler tiler's
        // `tileEcefCenter` so the extruded buffer stays in the same DSFUN
        // frame as surrounding flat-fill tiles. WGS84 ellipsoidal math
        // (cross-package projection import forbidden in the worker thread).
        const A_ = 6378137
        const F_ = 1 / 298.257223563
        const E2_ = F_ * (2 - F_)
        const DEG2RAD = Math.PI / 180
        const clampLat = Math.max(-85.051129, Math.min(85.051129, data.tileSouth))
        const tileMx = data.tileWest * DEG2RAD * A_
        const tileMy = Math.log(Math.tan(Math.PI / 4 + (clampLat * DEG2RAD) / 2)) * A_
        const tileLonRad = tileMx / A_
        const tileLatRad = 2 * Math.atan(Math.exp(tileMy / A_)) - Math.PI / 2
        const sinLat = Math.sin(tileLatRad)
        const cosLat = Math.cos(tileLatRad)
        const N = A_ / Math.sqrt(1 - E2_ * sinLat * sinLat)
        const tileEcefCenter: readonly [number, number, number] = [
          N * cosLat * Math.cos(tileLonRad),
          N * cosLat * Math.sin(tileLonRad),
          N * (1 - E2_) * sinLat,
        ]
        const mesh = generateWallMeshExtrudedECEF(
          data.polygons,
          data.heights!,
          data.bases,
          tileMx,
          tileMy,
          tileEcefCenter,
        )
        polyVerts = mesh.vertices.buffer.slice(
          mesh.vertices.byteOffset,
          mesh.vertices.byteOffset + mesh.vertices.byteLength,
        ) as ArrayBuffer
        polyIndices = mesh.indices
        dequantScale = mesh.dequantScale
        dequantHalf = mesh.dequantHalf
      } else {
        polyVerts = data.vertices.buffer.slice(
          data.vertices.byteOffset,
          data.vertices.byteOffset + data.vertices.byteLength,
        ) as ArrayBuffer
        polyIndices = data.indices
        dequantScale = data.dequantScale
        dequantHalf = data.dequantHalf
      }

      // Polygon vertex + index allocate from the shared arenas; per-tile
      // offsets carry the sub-range (mirrored in the eviction `arena.free`).
      const vArena = store.polyVertexArenaOrCreate()
      const iArena = store.polyIndexArenaOrCreate()
      polyVertexArena = vArena
      polyIndexArena = iArena
      const polyVertexByteLength = Math.max(polyVerts.byteLength, 12)
      const polyIndexByteLength = Math.max(polyIndices.byteLength, 4)

      // Lane B — alloc-fail safety net. On first failure run a forced count-
      // bypassing byte-eviction (drops LRU UNPROTECTED tiles — stableKeys
      // stay resident) on BOTH arenas, then retry ONCE. Persistent failure
      // leaves the tile un-cached (warn-once) so the next frame's
      // classifyTile re-decides upload.
      let pair = this._allocPolyPair(vArena, iArena, polyVertexByteLength, polyIndexByteLength)
      if (pair === null) {
        perfMarkStart('vtr.evict')
        store.forceEvictBytes(vArena, polyVertexByteLength, this.host.stableKeys(), (k) =>
          this.host.releaseTileHook(k),
        )
        store.forceEvictBytes(iArena, polyIndexByteLength, this.host.stableKeys(), (k) =>
          this.host.releaseTileHook(k),
        )
        perfMarkEnd('vtr.evict')
        pair = this._allocPolyPair(vArena, iArena, polyVertexByteLength, polyIndexByteLength)
      }
      if (pair === null) {
        const wKey = `arena-oom:${sourceLayer}:${key}`
        if (!this.host.hasWarned(wKey)) {
          this.host.markWarned(wKey)
          xlog.warn(
            `[VTR arena-oom] poly arena out of capacity uploading tile ${key} (${sourceLayer || 'base'}); skipping this frame, will retry. vBytes=${polyVertexByteLength} iBytes=${polyIndexByteLength}`,
          )
        }
        return
      }
      polyVertexOffset = pair.v
      polyIndexOffset = pair.i
      polyVertexFreeBytes = polyVertexByteLength
      polyIndexFreeBytes = polyIndexByteLength
      const vertexBuffer = vArena.rhiBuffer
      const indexBuffer = iArena.rhiBuffer
      sink.writeRhi(vertexBuffer, polyVertexOffset, polyVerts)
      sink.writeRhi(indexBuffer, polyIndexOffset, polyIndices)

      // The parallel z attribute is retired — per-vertex height + face_normal
      // + is_top live inside the unified stride-14 vertex buffer. Cache schema
      // keeps zBuffer-shaped sentinel fields so layer-routing compiles.
      const zBuffer: RhiBuffer | null = null
      const zBufferOffset = 0
      const zBufferByteLength = 0

      if (data.lineVertices.length > 0) {
        lineVertexBuffer = store.acquireBuffer(
          data.lineVertices.byteLength,
          GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          'tile-line-vertices',
        )
        sink.write(lineVertexBuffer, 0, data.lineVertices)

        lineIndexBuffer = store.acquireBuffer(
          data.lineIndices.byteLength,
          GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
          'tile-line-indices',
        )
        sink.write(lineIndexBuffer, 0, data.lineIndices)
      }

      // Outline indices (polygon edges, reuses polygon vertex buffer)
      let outlineIndexCount = 0
      if (data.outlineIndices && data.outlineIndices.length > 0) {
        outlineIndexBuffer = store.acquireBuffer(
          Math.max(data.outlineIndices.byteLength, 4),
          GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
          'tile-outline-indices',
        )
        sink.write(outlineIndexBuffer, 0, data.outlineIndices)
        outlineIndexCount = data.outlineIndices.length
      }

      // SDF line segment buffers (polygon outlines + line features).
      // buildLineSegments reads DSFUN-stride vertex buffers and needs the
      // tile extent in Mercator metres so tile-boundary detection keeps
      // seamless joins across tile edges.
      const lineRenderer = this.host.lineRenderer()
      let outlineSegmentCount = 0
      let outlineSegmentBindGroup: RhiBindGroup | null = null
      let lineSegmentCount = 0
      let lineSegmentBindGroup: RhiBindGroup | null = null
      if (lineRenderer) {
        const SEG_DEG2RAD = Math.PI / 180
        const SEG_R = 6378137
        const SEG_LAT_LIMIT = 85.051129
        const clampSegLat = (v: number) => Math.max(-SEG_LAT_LIMIT, Math.min(SEG_LAT_LIMIT, v))
        const tileMercXWest = data.tileWest * SEG_DEG2RAD * SEG_R
        const tileMercXEast = (data.tileWest + data.tileWidth) * SEG_DEG2RAD * SEG_R
        const tileMercYSouth =
          Math.log(Math.tan(Math.PI / 4 + (clampSegLat(data.tileSouth) * SEG_DEG2RAD) / 2)) * SEG_R
        const tileMercYNorth =
          Math.log(
            Math.tan(
              Math.PI / 4 + (clampSegLat(data.tileSouth + data.tileHeight) * SEG_DEG2RAD) / 2,
            ),
          ) * SEG_R
        const tileWidthMerc = tileMercXEast - tileMercXWest
        const tileHeightMerc = tileMercYNorth - tileMercYSouth
        if (
          data.outlineVertices &&
          data.outlineVertices.length > 0 &&
          data.outlineLineIndices &&
          data.outlineLineIndices.length > 0
        ) {
          // PMTiles MVT worker pre-builds segments off-thread; reuse if
          // present, else build now (XGVT-binary path). Main-thread fallback
          // passes heights so outlines match the worker pre-build.
          const segData =
            data.prebuiltOutlineSegments ??
            buildLineSegments(
              data.outlineVertices,
              data.outlineLineIndices,
              10,
              tileWidthMerc,
              tileHeightMerc,
              data.heights && data.heights.size > 0 ? data.heights : undefined,
              undefined,
              undefined,
              0,
            )
          const segOut = sink.uploadSegment(segData)
          outlineSegmentBuffer = segOut instanceof Promise ? await segOut : segOut
          outlineSegmentCount = data.outlineLineIndices.length / 2
          outlineSegmentBindGroup = lineRenderer.createLayerBindGroup(outlineSegmentBuffer)
        }
        if (data.lineIndices.length > 0 && data.lineVertices.length > 0) {
          let segData: Float32Array
          if (data.prebuiltLineSegments) {
            segData = data.prebuiltLineSegments
          } else {
            // Detect stride from vertex data length / vertex count. Stride 10
            // includes precomputed tangent_in/out for cross-tile joins;
            // stride 6 is the legacy format without tangents.
            let lineStride: 6 | 10 = 6
            if (data.lineIndices.length > 0) {
              let maxIdx = 0
              for (let li = 0; li < data.lineIndices.length; li++) {
                if (data.lineIndices[li] > maxIdx) maxIdx = data.lineIndices[li]
              }
              const vertCount = maxIdx + 1
              if (vertCount > 0 && data.lineVertices.length / vertCount >= 10) lineStride = 10
            }
            segData = buildLineSegments(
              data.lineVertices,
              data.lineIndices,
              lineStride,
              tileWidthMerc,
              tileHeightMerc,
              data.heights && data.heights.size > 0 ? data.heights : undefined,
              undefined,
              undefined,
              0,
            )
          }
          const segOut = sink.uploadSegment(segData)
          lineSegmentBuffer = segOut instanceof Promise ? await segOut : segOut
          lineSegmentCount = data.lineIndices.length / 2
          lineSegmentBindGroup = lineRenderer.createLayerBindGroup(lineSegmentBuffer)
        }
      }

      // ── Suspension boundary — async route ONLY ──
      // The sync sink has `deferred === false`, so this whole block is
      // skipped and the body runs to completion synchronously. The async
      // sink stages its writes; here we await them, guard, and submit.
      if (sink.deferred) {
        await sink.awaitWrites()
        // UAF / compaction guard: a synchronous teardown (destroy → arenas
        // nulled) OR a compaction (arena.buffer swapped for a fresh packed
        // buffer, old one retired) can land inside the mapAsync suspension
        // above. Either way the captured vertex/index buffers are stale and
        // submitting would raise "used in submit while destroyed". A buffer-
        // identity check covers BOTH; bail WITHOUT submitting and return the
        // staging slots. The un-cached tile re-uploads into the live buffer
        // next frame. (Teardown's nulled arena means the claimed poly slots
        // need no free — the whole arena is gone; compaction likewise retired
        // the old buffer, so its slot range is irrelevant.)
        if (
          this._destroyed ||
          store.polyVertexArenaOrNull()?.rhiBuffer !== vertexBuffer ||
          store.polyIndexArenaOrNull()?.rhiBuffer !== indexBuffer
        ) {
          sink.releaseAll()
          cleanupLineBuffers()
          return
        }
        sink.submit()
        // Race guard: another upload (parallel async for the same key, or a
        // sync mid-render fallback) may have populated the cache while we
        // awaited. Skip the second set — but FIRST free the poly slots this
        // call claimed (never recorded in layerCache → would leak + pin
        // liveBytes > 0, blocking reclaim forever).
        if (layerCache.has(key)) {
          vArena.free(polyVertexOffset, polyVertexByteLength)
          iArena.free(polyIndexOffset, polyIndexByteLength)
          cleanupLineBuffers()
          return
        }
      }

      // Per-tile feat_data buffer for MVT/PMTiles data-driven paint. Compute-
      // handle keying matches the `${key}:${sourceLayer}` identity used by
      // the upload queue + held set, so the handle's lifetime tracks the
      // tile's bind-group lifetime.
      const perTileFeat = this.host.buildPerTileFeatureData(
        data.featureProps,
        `${key}:${sourceLayer}`,
      )

      layerCache.set(key, {
        vertexBuffer,
        polyVertexOffset,
        polyVertexByteLength,
        indexBuffer,
        polyIndexOffset,
        polyIndexByteLength,
        indexCount: polyIndices.length,
        zBuffer,
        zBufferOffset,
        zBufferByteLength,
        extruded: useFeatureHeights && !!data.polygons,
        lineVertexBuffer,
        lineIndexBuffer,
        lineIndexCount: data.lineIndices.length,
        outlineIndexBuffer,
        outlineIndexCount,
        outlineSegmentBuffer,
        outlineSegmentCount,
        outlineSegmentBindGroup,
        lineSegmentBuffer,
        lineSegmentCount,
        lineSegmentBindGroup,
        tileWest: data.tileWest,
        tileSouth: data.tileSouth,
        tileWidth: data.tileWidth,
        tileHeight: data.tileHeight,
        tileZoom: data.tileZoom,
        dequantScale,
        dequantHalf,
        lastUsedFrame: this.host.frameCount(),
        uploadTimeMs: performance.now(),
        featureDataBuffer: perTileFeat?.buffer ?? null,
        featureBindGroup: perTileFeat?.bindGroup ?? null,
        // Strictly-monotonic per-tile upload counter for RenderBundle cache
        // key composition.
        uploadEpoch: store.nextUploadEpoch(),
      })
      store.incrementCount()
      // Poly slots are now owned by the cache entry — the backstop must NOT
      // free them.
      polySlotsCached = true

      // Drop main-thread copies of GPU-resident SDF segment buffers (the GPU
      // buffers are the source of truth; buildLineSegments regenerates on a
      // later re-upload). Also drop the raw polygon rings — retained only for
      // sub-tile generation past archive maxLevel; the over-zoom path falls
      // back to outlineIndices when polygons are missing.
      data.prebuiltLineSegments = undefined
      data.prebuiltOutlineSegments = undefined
      data.polygons = undefined
    } catch (e) {
      // Backstop: a throw from line/outline acquireBuffer, uploadSegment,
      // createLayerBindGroup, encoder.finish, or submit reaching here means
      // layerCache.set did not run, so the polygon vertex/index slots claimed
      // by _allocPolyPair are orphaned. Free them (unless already handed to
      // the cache) + the line/outline/segment buffers before degrading to
      // skip-this-tile (warn-once, un-cached → retried a later frame). This
      // guarantees dispatch can never reject-with-leak.
      if (!polySlotsCached) {
        if (polyVertexOffset >= 0 && polyVertexArena !== null) {
          polyVertexArena.free(polyVertexOffset, polyVertexFreeBytes)
        }
        if (polyIndexOffset >= 0 && polyIndexArena !== null) {
          polyIndexArena.free(polyIndexOffset, polyIndexFreeBytes)
        }
        cleanupLineBuffers()
      }
      const wKey = `upload-throw:${sourceLayer}:${key}`
      if (!this.host.hasWarned(wKey)) {
        this.host.markWarned(wKey)
        xlog.warn(
          `[VTR upload] dispatch threw for tile ${key} (${sourceLayer || 'base'}); skipping. ${(e as Error)?.message ?? e}`,
        )
      }
    }
  }
}

/** Null a TileData's prebuilt SDF segment buffers. Used by `cancelStale`
 *  when it drops a queued/held upload whose TileData stays in the catalog:
 *  the buffers are rebuilt on demand by `buildLineSegments` at the next
 *  upload, and `TileCatalog.sizeOfTileData` assumes them absent for cached
 *  tiles, so leaving them set would under-count `_cachedBytes` and stall
 *  byte-cap eviction. */
function releasePrebuiltSegments(data: TileData): void {
  data.prebuiltLineSegments = undefined
  data.prebuiltOutlineSegments = undefined
}
