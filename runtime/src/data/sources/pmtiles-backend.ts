// PMTilesBackend — TileSource implementation for PMTiles archives.
//
// Two-stage pipeline (fetch / compile separation):
//
//   loadTile(key)
//     ↓ async HTTP byte-range request
//   pendingMvt: Map<key, Uint8Array>       ← raw MVT bytes queued
//     ↓ tick(budget) per frame
//   decodeMvtTile + decomposeFeatures + compileSingleTile
//     ↓ sink.acceptResult
//   catalog cache → onTileLoaded → VTR upload
//
// Why split: a v4 world basemap tile decode + compile takes 5-50 ms
// on the main thread. With 30+ fetches in flight, all .then handlers
// resolve in the same microtask boundary and stack 30+ compiles
// consecutively, blocking frames for hundreds of ms. Splitting lets
// catalog pace compile work via the per-frame tick budget while
// fetches keep streaming in async.

import { xlog } from '@xgis/shared'
import {
  tileKeyUnpack,
  decodeMvtTile, decomposeFeatures, compileSingleTile,
  makeEvalProps,
  type GeoJSONFeature,
} from '@xgis/compiler'
import { buildLineSegments } from '../../core/line-segment-build'
import {
  TILE_LAYOUT_VERSION,
  type TileSource, type TileSourceSink, type TileSourceMeta,
} from '../tile-source'
import { getSharedMvtPool, type MvtWorkerPool } from '../workers/mvt-worker-pool'
import { evalFilterExpr } from '../eval/filter-eval'
import {
  PriorityQueue, PriorityQueueItemRemovedError,
} from '../../core/priority-queue'
import type {
  PMTilesFetcher, PMTilesBackendOptions,
} from './pmtiles-backend-types'
import {
  extractFeatureHeights, extractFeatureWidths, extractFeatureColors,
  maxInflight, failedKeyTtlMs, tileSizeMerc, tileIntersectsBounds,
} from './pmtiles-backend-helpers'

// Type declarations live in pmtiles-backend-types.ts; pure free
// functions live in pmtiles-backend-helpers.ts. Both are imported
// above. `PMTilesFetcher` and `PMTilesBackendOptions` stay part of the
// public surface and are re-exported here.
export type { PMTilesFetcher, PMTilesBackendOptions } from './pmtiles-backend-types'

export class PMTilesBackend implements TileSource {
  readonly meta: TileSourceMeta
  private fetcher: PMTilesFetcher
  private layers: string[] | undefined
  private extrudeExprs: Record<string, unknown> | undefined
  private extrudeBaseExprs: Record<string, unknown> | undefined
  private showSlices: Array<{ sliceKey: string; sourceLayer: string; filterAst: unknown | null; needsFeatureProps?: boolean; needsExtrude?: boolean; featurePropKeys?: string[] }> | undefined
  private strokeWidthExprs: Record<string, unknown> | undefined
  private strokeColorExprs: Record<string, unknown> | undefined
  private sink: TileSourceSink | null = null
  /** Per-MVT-layer info from PMTiles metadata, indexed by layer id. */
  private vectorLayerInfo: Map<string, { minzoom: number; maxzoom: number }>

  /** Raw MVT bytes waiting for decode+compile. Drained by tick(). */
  private pendingMvt: { key: number; bytes: Uint8Array }[] = []

  /** Per-key "fetcher just reported 'failed'" cache → expiry timestamp
   *  ms. While present and unexpired, loadTile short-circuits without
   *  dispatching a new fetch AND without calling acceptResult, so the
   *  catalog's hasTileData stays false → renderer's parent walk
   *  treats the tile as missing → ancestor fallback draws in its
   *  place. See FAILED_KEY_TTL_MS for the recovery window. */
  private failedKeys: Map<number, { expiresAt: number; count: number }> = new Map()

  /** Per-key AbortController for in-flight fetches. cancelStale()
   *  walks this map to abort fetches the catalog no longer wants.
   *  Cleaned up on fetch settle (success, failure, or abort). */
  private abortControllers: Map<number, AbortController> = new Map()

  /** Concurrency-bounded fetch dispatcher. Replaces the old
   *  `getLoadingCount() >= maxInflight()` early-return gate with a
   *  proper queue: every visible tile gets enqueued, the queue itself
   *  caps how many run at once (`maxJobs`), and `cancelStale` drops
   *  queued-but-not-yet-dispatched keys via `removeByFilter`.
   *
   *  `priorityCallback` is left null by default → FIFO. Higher layers
   *  can install a comparator (typically distance-to-camera) to make
   *  near-camera tiles overtake horizon tiles when the queue backs up.
   *  Algorithm reference: NASA-AMMOS/3DTilesRendererJS PriorityQueue. */
  private fetchQueue = new PriorityQueue<number, void>()

  /** Per-layer zoom range from PMTiles metadata. Returns null when
   *  the archive didn't ship vector_layers metadata or the requested
   *  layer isn't listed. Caller (runtime) uses this to short-circuit
   *  rendering / sub-tile generation when the camera zoom is outside
   *  the layer's data range. */
  getLayerZoomRange(layerName: string): { minzoom: number; maxzoom: number } | null {
    return this.vectorLayerInfo.get(layerName) ?? null
  }

  constructor(opts: PMTilesBackendOptions) {
    this.fetcher = opts.fetcher
    this.layers = opts.layers
    this.extrudeExprs = opts.extrudeExprs
    this.extrudeBaseExprs = opts.extrudeBaseExprs
    this.showSlices = opts.showSlices
    this.strokeWidthExprs = opts.strokeWidthExprs
    this.strokeColorExprs = opts.strokeColorExprs
    this.vectorLayerInfo = new Map()
    if (opts.vectorLayers) {
      for (const vl of opts.vectorLayers) {
        this.vectorLayerInfo.set(vl.id, { minzoom: vl.minzoom, maxzoom: vl.maxzoom })
      }
    }
    this.meta = {
      bounds: opts.bounds,
      minZoom: opts.minZoom,
      maxZoom: opts.maxZoom,
      // PMTiles spec MVT tiles are addressed on the Web Mercator XYZ slippy grid.
      scheme: 'web-mercator-xyz',
      // Declares the polygon vertex byte format this backend emits. Catalog
      // evicts cached tiles on attach if the runtime's TILE_LAYOUT_VERSION
      // moves past what's cached (PR 2c.4).
      layoutVersion: TILE_LAYOUT_VERSION,
      // Empty property table — PMTiles' MVT properties aren't yet
      // surfaced to the styling layer. Catalog merges this with
      // first-attached-wins precedence; another backend's table wins
      // if attached first.
      propertyTable: { fieldNames: [], fieldTypes: [], values: [] },
      // No preregistered entries — PMTiles discovers tiles lazily on
      // fetch, catalog synthesises XGVTIndex entries via acceptResult.
      entries: undefined,
    }
  }

  attach(sink: TileSourceSink): void {
    this.sink = sink
  }

  /** Synchronous catalog-window predicate. True if (z, x, y) could
   *  plausibly be served — catalog uses this for hasEntryInIndex on
   *  non-preregistered keys. */
  has(key: number): boolean {
    const [z, x, y] = tileKeyUnpack(key)
    if (z < this.meta.minZoom || z > this.meta.maxZoom) return false
    return tileIntersectsBounds(z, x, y, this.meta.bounds)
  }

  /** Stage 1: enqueue an async HTTP fetch. Bytes land in pendingMvt
   *  when the fetcher resolves; the actual decode+compile waits for
   *  tick() to dequeue.
   *
   *  Concurrency is enforced by `fetchQueue` (maxJobs = maxInflight()).
   *  A loading slot is reserved at ENQUEUE time so the catalog's
   *  prefetch back-pressure (`loadingTiles.size < _cap`) sees queued
   *  tiles too — without this, a high-pitch frame would enqueue 200+
   *  tiles instantly and prefetch would race the visible-set. */
  loadTile(key: number): void {
    if (!this.sink) return
    if (this.sink.hasTileData(key)) return
    // Negative cache: a recent 'failed' result short-circuits without
    // dispatching another fetch. We deliberately DON'T also call
    // acceptResult here — keeping hasTileData(key) false lets the
    // renderer's parent-walk treat the tile as missing and draw the
    // nearest cached ancestor magnified into its bounds.
    const failed = this.failedKeys.get(key)
    if (failed !== undefined) {
      if (Date.now() < failed.expiresAt) return
      // TTL expired — drop the timestamp but KEEP the count so the
      // next failure (if it recurs) backs off further. Successful
      // fetches clear the entry entirely in doFetch's success path.
      this.failedKeys.set(key, { expiresAt: 0, count: failed.count })
    }
    // Dedupe: already queued or actively fetching.
    if (this.fetchQueue.has(key)) return
    if (this.abortControllers.has(key)) return

    // Refresh concurrency from current viewport — `maxInflight()`
    // resolves lazily off `window.innerWidth`, and a real device
    // rotation between frames should retune the cap without a reload.
    this.fetchQueue.maxJobs = maxInflight()

    const sink = this.sink
    sink.trackLoading(key)
    this.fetchQueue.add(key, () => this.doFetch(key)).catch((err: unknown) => {
      if (err instanceof PriorityQueueItemRemovedError) {
        // cancelStale dropped us before dispatch. Release the slot
        // we reserved at enqueue. NOT a fetch failure → no failedKeys.
        sink.releaseLoading(key)
        return
      }
      // doFetch swallows its own errors, so anything reaching here is
      // unexpected (queue invariant violation).
      xlog.error('[pmtiles fetch queue]', err)
      sink.releaseLoading(key)
    })
  }

  /** Stage 1 body — the actual HTTP fetch + outcome routing. Always
   *  resolves (errors are converted to `releaseLoading` + failedKeys).
   *  The queue's promise resolves with `void`; the catch handler in
   *  loadTile only sees `PriorityQueueItemRemovedError` from
   *  cancellation. */
  private async doFetch(key: number): Promise<void> {
    if (!this.sink) return
    const sink = this.sink
    const [z, x, y] = tileKeyUnpack(key)
    const ac = new AbortController()
    this.abortControllers.set(key, ac)
    try {
      const result = await this.fetcher(z, x, y, ac.signal)
      if (result === 'failed') {
        // Transient/permanent fetch failure — record in negative cache
        // and DO NOT acceptResult. The catalog will see hasTileData
        // remain false; the renderer's per-tile parent walk will find
        // the nearest cached ancestor and draw that magnified into
        // this tile's bounds (Mapbox-style overzoom fallback). TTL
        // grows exponentially per consecutive failure (see
        // failedKeyTtlMs); a transient blip recovers in 15 s, a truly
        // broken upstream is locked out for the 5-minute cap.
        const count = (this.failedKeys.get(key)?.count ?? 0) + 1
        this.failedKeys.set(key, { expiresAt: Date.now() + failedKeyTtlMs(count), count })
        sink.releaseLoading(key)
        return
      }
      if (!result) {
        // Genuinely missing (404 / archive has no index entry) — push
        // an empty placeholder so the catalog's hasTileData turns
        // true and we don't re-request this key. Distinct from
        // 'failed' above: a 404 means "there's no data at all here"
        // (e.g., outside the source's bounds), and the parent
        // fallback would be misleading — better to draw nothing.
        sink.releaseLoading(key)
        sink.acceptResult(key, null)
        return
      }
      // Bytes ready; queue for paced compile in tick(). Note we do
      // NOT releaseLoading here — the slot stays held until compile
      // finishes, providing back-pressure on requestTiles.
      // Successful fetch clears any prior failure state so the next
      // visible-tile pass after this resolves doesn't get held on
      // exponential backoff from a previous flaky attempt.
      this.failedKeys.delete(key)
      this.pendingMvt.push({ key, bytes: result })
    } catch (err) {
      // Aborted via signal (catalog no longer wants this tile) —
      // release the slot but DO NOT mark failedKeys. The tile is
      // free to be re-requested immediately if it becomes visible
      // again, and a future call won't sit in the negative cache.
      const isAbort = (err as Error)?.name === 'AbortError'
      if (!isAbort) {
        const count = (this.failedKeys.get(key)?.count ?? 0) + 1
        this.failedKeys.set(key, { expiresAt: Date.now() + failedKeyTtlMs(count), count })
        xlog.error('[pmtiles fetch]', (err as Error)?.stack ?? err)
      }
      sink.releaseLoading(key)
    } finally {
      this.abortControllers.delete(key)
    }
  }

  /** Install a comparator on the fetch priority queue. Higher-priority
   *  items must sort LAST (positive return when `a` should run before
   *  `b`). Typically: smaller distance-to-camera = higher priority.
   *  Reset to FIFO by passing null. */
  setFetchPriorityCallback(cmp: ((a: number, b: number) => number) | null): void {
    this.fetchQueue.priorityCallback = cmp
  }

  /** TileSource.isFailed — true while `key`'s negative-cache TTL has
   *  not yet expired. Used by TileCatalog.getTileState to surface the
   *  `'failed'` lifecycle state. Self-cleaning when the count has
   *  reset (entry only kept around to retain the failure-count for
   *  exponential backoff between TTL windows; once expired AND count
   *  has been reset by a successful fetch, the entry is removed). */
  isFailed(key: number): boolean {
    const failed = this.failedKeys.get(key)
    if (failed === undefined) return false
    return Date.now() < failed.expiresAt
  }

  /** Cancel in-flight fetches for keys NOT in `activeKeys`. Called by
   *  the catalog (driven by VTR per-frame) when the camera moves
   *  and previously-requested tiles become irrelevant. The fetcher
   *  raises AbortError → loadTile's catch path releases the loading
   *  slot WITHOUT marking failedKeys, leaving the tile free to be
   *  re-requested if it becomes visible again.
   *
   *  Also drops queued bytes from pendingMvt for cancelled keys —
   *  bytes that finished downloading but haven't been dispatched
   *  to the worker pool. Their loading slot is released here so
   *  the catalog can re-issue if needed. (Worker-pool tasks
   *  already in flight are NOT cancellable; their results are
   *  filtered on receipt — see tick().) */
  cancelStale(activeKeys: Set<number>): void {
    if (!this.sink) return
    // Idle-frame fast path: no in-flight fetches, no queued fetches, no
    // un-compiled bytes — every branch inside the function is a no-op
    // anyway, so skip the function call's work entirely (per-frame in
    // VTR.render at 60 fps when the camera is static). Top contributor
    // 5.4% on idle Seoul z=17 disappears here. The three sources cover
    // every entry point that could plant work for cancelStale to find:
    //   - fetchQueue gains items only via loadTile / scheduleFetch
    //   - abortControllers gains entries only via doFetch
    //   - pendingMvt gains items only via doFetch's bytes-ready branch
    // None of them tick autonomously, so re-running cancelStale with all
    // three empty is provably idempotent.
    if (this.fetchQueue.size() === 0
        && this.abortControllers.size === 0
        && this.pendingMvt.length === 0) {
      return
    }
    const sink = this.sink
    // Drop queued-but-not-yet-dispatched fetches first. Their .catch
    // handler in loadTile() catches PriorityQueueItemRemovedError and
    // calls releaseLoading. No abortController exists for these (the
    // queue hasn't run doFetch yet), so we don't double-up below.
    this.fetchQueue.removeByFilter(k => !activeKeys.has(k))
    // Cancel in-flight fetches. Skip controllers already aborted
    // — same fetch can sit in this.abortControllers across many
    // frames if the underlying transport (PMTiles archive.getZxy)
    // ignored our signal and the promise hasn't settled yet. Re-
    // calling abort() on an already-aborted controller is a no-op
    // semantically but still counts as "an abort was requested",
    // which (a) wastes CPU iterating + raising abort events for
    // listeners that already ran, and (b) makes diagnostics
    // (counter spies, devtools listeners) read off-by-thousands.
    for (const [key, ac] of this.abortControllers) {
      if (!activeKeys.has(key) && !ac.signal.aborted) {
        ac.abort()
      }
    }
    // Drop already-fetched-but-not-yet-compiled bytes for stale keys.
    if (this.pendingMvt.length > 0) {
      const kept: typeof this.pendingMvt = []
      for (const item of this.pendingMvt) {
        if (activeKeys.has(item.key)) {
          kept.push(item)
        } else {
          sink.releaseLoading(item.key)
        }
      }
      if (kept.length !== this.pendingMvt.length) {
        this.pendingMvt = kept
      }
    }
  }

  /** Stage 2: drain up to maxOps queued tiles per frame. Catalog
   *  calls this from resetCompileBudget. Each tile dispatches to the
   *  worker pool — main thread does ~zero compile work, just queues
   *  the postMessage and awaits the worker's Transferable response.
   *  When the worker resolves, sink.acceptResult fires (still on
   *  main, async). The maxOps budget here governs how many fresh
   *  worker dispatches we kick off per frame; in-flight workers
   *  continue regardless. */
  tick(maxOps: number): void {
    if (!this.sink || this.pendingMvt.length === 0) return
    const sink = this.sink
    const n = Math.min(maxOps, this.pendingMvt.length)
    // Prefer the worker pool when Worker is available (browser); fall
    // back to inline compile in environments without it (vitest node,
    // SSR). Both produce identical BackendTileResult shapes — the
    // worker is purely a performance optimisation.
    const useWorker = typeof Worker !== 'undefined'
    const pool = useWorker ? this.getPool() : null
    for (let i = 0; i < n; i++) {
      const { key, bytes } = this.pendingMvt.shift()!
      const [z, x, y] = tileKeyUnpack(key)
      const { widthMerc, heightMerc } = tileSizeMerc(z, y)
      if (pool) {
        pool.compile(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          z, x, y, this.meta.maxZoom,
          widthMerc, heightMerc,
          this.layers,
          this.extrudeExprs,
          this.extrudeBaseExprs,
          this.showSlices,
          this.strokeWidthExprs,
          this.strokeColorExprs,
        ).then(slices => {
          if (slices.length === 0) {
            sink.acceptResult(key, null)
            return
          }
          // Each slice is one MVT layer's geometry — push under its
          // layerName so xgis layers with `sourceLayer: "<name>"`
          // pick the matching slice from the catalog cache.
          for (const slice of slices) {
            sink.acceptResult(key, {
              vertices: slice.vertices,
              dequantScale: slice.dequantScale,
              dequantHalf: slice.dequantHalf,
              indices: slice.indices,
              lineVertices: slice.lineVertices,
              lineIndices: slice.lineIndices,
              pointVertices: slice.pointVertices,
              outlineIndices: slice.outlineIndices,
              outlineVertices: slice.outlineVertices,
              outlineLineIndices: slice.outlineLineIndices,
              polygons: slice.polygons,
              heights: slice.heights,
              bases: slice.bases,
              featureProps: slice.featureProps,
              fullCover: slice.fullCover,
              fullCoverFeatureId: slice.fullCoverFeatureId,
              prebuiltLineSegments: slice.prebuiltLineSegments,
              prebuiltOutlineSegments: slice.prebuiltOutlineSegments,
            }, slice.layerName)
          }
        }).catch(err => {
          xlog.error('[pmtiles worker]', (err as Error)?.stack ?? err)
          sink.acceptResult(key, null)
        }).finally(() => {
          sink.releaseLoading(key)
        })
      } else {
        try {
          this.compileInline(key, bytes, z, x, y, widthMerc, heightMerc)
        } finally {
          sink.releaseLoading(key)
        }
      }
    }
  }

  /** Inline compile path — used when Worker is unavailable (tests).
   *  Same pipeline as the worker but blocks the main thread. */
  private compileInline(
    key: number, bytes: Uint8Array,
    z: number, x: number, y: number,
    widthMerc: number, heightMerc: number,
  ): void {
    if (!this.sink) return
    const sink = this.sink
    try {
      const features = decodeMvtTile(bytes, z, x, y, { layers: this.layers })
      if (features.length === 0) { sink.acceptResult(key, null); return }
      // Mirror the worker's group-by-`_layer` so each MVT layer becomes
      // its own slice keyed under (key, layerName). Without this, vitest
      // runs (no Worker constructor) collapse all features into a single
      // unnamed slice and xgis layers with `sourceLayer: "..."` filter
      // miss everything.
      const byLayer = new Map<string, GeoJSONFeature[]>()
      for (const f of features) {
        const ln = (f.properties?._layer as string) ?? ''
        let bucket = byLayer.get(ln)
        if (!bucket) { bucket = []; byLayer.set(ln, bucket) }
        bucket.push(f)
      }
      let emittedAny = false
      const emitSlice = (
        sliceKey: string,
        sourceLayer: string,
        sourceFeatures: GeoJSONFeature[],
      ): void => {
        if (sourceFeatures.length === 0) return
        const parts = decomposeFeatures(sourceFeatures)
        const tile = compileSingleTile(parts, z, x, y, this.meta.maxZoom)
        if (!tile) return
        // Build featureProps map for the SDF text label pipeline:
        // featId (the index used by GPU vertex feat_id) → original
        // properties bag. decomposeFeatures preserves source order,
        // so featId == sourceFeatures index.
        const featureProps = new Map<number, Record<string, unknown>>()
        for (let fi = 0; fi < sourceFeatures.length; fi++) {
          const props = sourceFeatures[fi]?.properties
          if (props) featureProps.set(fi, props as Record<string, unknown>)
        }
        const heights = extractFeatureHeights(sourceFeatures, this.extrudeExprs?.[sourceLayer], z)
        const bases = extractFeatureHeights(sourceFeatures, this.extrudeBaseExprs?.[sourceLayer], z)
        const widths = extractFeatureWidths(sourceFeatures, this.strokeWidthExprs?.[sliceKey], z)
        const colors = extractFeatureColors(sourceFeatures, this.strokeColorExprs?.[sliceKey], z)
        let prebuiltOutlineSegments: Float32Array | undefined
        let prebuiltLineSegments: Float32Array | undefined
        if (tile.outlineVertices && tile.outlineVertices.length > 0
            && tile.outlineLineIndices && tile.outlineLineIndices.length > 0) {
          prebuiltOutlineSegments = buildLineSegments(
            tile.outlineVertices, tile.outlineLineIndices, 10,
            widthMerc, heightMerc,
            heights.size > 0 ? heights : undefined,
            widths.size > 0 ? widths : undefined,
            colors.size > 0 ? colors : undefined,
            0,
          )
        }
        if (tile.lineIndices.length > 0 && tile.lineVertices.length > 0) {
          let lineStride: 6 | 10 = 6
          let maxIdx = 0
          for (let li = 0; li < tile.lineIndices.length; li++) {
            if (tile.lineIndices[li] > maxIdx) maxIdx = tile.lineIndices[li]
          }
          const vertCount = maxIdx + 1
          if (vertCount > 0 && tile.lineVertices.length / vertCount >= 10) lineStride = 10
          prebuiltLineSegments = buildLineSegments(
            tile.lineVertices, tile.lineIndices, lineStride,
            widthMerc, heightMerc,
            heights.size > 0 ? heights : undefined,
            widths.size > 0 ? widths : undefined,
            colors.size > 0 ? colors : undefined,
            0,
          )
        }
        sink.acceptResult(key, {
          vertices: tile.vertices,
          dequantScale: tile.dequantScale,
          dequantHalf: tile.dequantHalf,
          indices: tile.indices,
          lineVertices: tile.lineVertices,
          lineIndices: tile.lineIndices,
          pointVertices: tile.pointVertices,
          outlineIndices: tile.outlineIndices,
          outlineVertices: tile.outlineVertices,
          outlineLineIndices: tile.outlineLineIndices,
          polygons: tile.polygons?.map(p => ({ rings: p.rings, featId: p.featId })),
          heights: heights.size > 0 ? heights : undefined,
          bases: bases.size > 0 ? bases : undefined,
          featureProps: featureProps.size > 0 ? featureProps : undefined,
          fullCover: tile.fullCover,
          fullCoverFeatureId: tile.fullCoverFeatureId,
          prebuiltLineSegments,
          prebuiltOutlineSegments,
        }, sliceKey)
        emittedAny = true
      }
      if (this.showSlices && this.showSlices.length > 0) {
        for (const desc of this.showSlices) {
          const layerFeatures = byLayer.get(desc.sourceLayer)
          if (!layerFeatures || layerFeatures.length === 0) continue
          const subset = desc.filterAst
            ? layerFeatures.filter(f => {
                const bag = makeEvalProps({
                  props: f.properties ?? undefined,
                  geometryType: f.geometry?.type,
                  featureId: (f as { id?: string | number }).id,
                  cameraZoom: z,
                })
                return evalFilterExpr(desc.filterAst, bag)
              })
            : layerFeatures
          emitSlice(desc.sliceKey, desc.sourceLayer, subset)
        }
      } else {
        for (const [layerName, layerFeatures] of byLayer) {
          emitSlice(layerName, layerName, layerFeatures)
        }
      }
      if (!emittedAny) sink.acceptResult(key, null)
    } catch (err) {
      xlog.error('[pmtiles inline]', (err as Error)?.stack ?? err)
      sink.acceptResult(key, null)
    }
  }

  private _pool: MvtWorkerPool | null = null
  private getPool(): MvtWorkerPool {
    if (!this._pool) this._pool = getSharedMvtPool()
    return this._pool
  }
}
