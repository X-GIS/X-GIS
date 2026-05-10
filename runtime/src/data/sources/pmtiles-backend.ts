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

import {
  tileKeyUnpack,
  decodeMvtTile, decomposeFeatures, compileSingleTile,
  evaluate,
  type GeoJSONFeature,
} from '@xgis/compiler'
import { buildLineSegments } from '../../engine/line-segment-build'
import { EXTRUDE_FALLBACK_HEIGHT_M } from '../../engine/polygon-mesh'
import type {
  TileSource, TileSourceSink, TileSourceMeta,
} from '../tile-source'
import { getSharedMvtPool, type MvtWorkerPool } from '../mvt-worker-pool'
import { evalExtrudeExpr } from '../extrude-eval'
import { evalFilterExpr } from '../filter-eval'
import {
  PriorityQueue, PriorityQueueItemRemovedError,
} from '../priority-queue'

/** Same height extractor as the worker (mvt-worker.ts). The inline
 *  fallback path can't import from mvt-worker because its module is
 *  worker-only (top-level postMessage handler), so we duplicate the
 *  helper. Keep in sync with the worker copy. */
function extractFeatureHeights(
  features: GeoJSONFeature[],
  expr: unknown,
): Map<number, number> {
  // Mirrors mvt-worker.ts — only emit entries for features whose
  // expression evaluates to a usable height. Missing / null /
  // non-finite values are left out; the language is responsible
  // for declaring fallbacks (`extrude: .height ?? 50`) when it
  // wants a default.
  const out = new Map<number, number>()
  if (!expr) return out
  for (let i = 0; i < features.length; i++) {
    const props = features[i].properties
    if (!props) continue
    const v = evalExtrudeExpr(expr, props as Record<string, unknown>)
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out.set(i, v)
  }
  return out
}

function extractFeatureWidths(
  features: GeoJSONFeature[],
  expr: unknown,
): Map<number, number> {
  const out = new Map<number, number>()
  if (!expr) return out
  for (let i = 0; i < features.length; i++) {
    const props = features[i].properties
    if (!props) continue
    const v = evaluate(expr as never, props as Record<string, unknown>)
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out.set(i, v)
  }
  return out
}

function extractFeatureColors(
  features: GeoJSONFeature[],
  expr: unknown,
): Map<number, number> {
  const out = new Map<number, number>()
  if (!expr) return out
  for (let i = 0; i < features.length; i++) {
    const props = features[i].properties
    if (!props) continue
    const v = evaluate(expr as never, props as Record<string, unknown>)
    if (typeof v === 'string' && v.startsWith('#') && (v.length === 7 || v.length === 9)) {
      const r = parseInt(v.slice(1, 3), 16)
      const g = parseInt(v.slice(3, 5), 16)
      const b = parseInt(v.slice(5, 7), 16)
      const a = v.length === 9 ? parseInt(v.slice(7, 9), 16) : 255
      if (a > 0) out.set(i, (r | (g << 8) | (b << 16) | (a << 24)) >>> 0)
    }
  }
  return out
}

/** Async HTTP byte fetcher.
 *
 *  Three-state return:
 *    - `Uint8Array`  — raw MVT bytes; decode + compile happen later
 *                      in tick().
 *    - `null`        — tile genuinely absent from the source (PMTiles
 *                      archive has no index entry, XYZ server returned
 *                      404). Caller caches an empty tile so the same
 *                      key isn't re-fetched.
 *    - `'failed'`    — transient/permanent fetch failure (5xx, network
 *                      error, retry exhaustion, OR aborted via signal).
 *                      Caller does NOT cache empty — keeps the tile in
 *                      "missing" state so the renderer's parent-walk
 *                      falls back to the nearest cached ancestor and
 *                      draws that magnified. The backend's per-key
 *                      negative cache prevents hammering the source
 *                      while the failure persists; abort failures are
 *                      handled separately so a cancelled request can
 *                      be re-issued immediately when the tile becomes
 *                      visible again.
 *
 *  `signal` lets the backend cancel an in-flight fetch when the
 *  catalog reports the tile is no longer wanted (camera moved past
 *  it, zoom changed enough that it's stale). Implementations should
 *  surface AbortError as `'failed'` and skip the negative cache for
 *  abort-induced failures (they're not a real fetch problem). */
export type PMTilesFetcher = (
  z: number, x: number, y: number,
  signal: AbortSignal,
) => Promise<Uint8Array | null | 'failed'>

export interface PMTilesBackendOptions {
  fetcher: PMTilesFetcher
  minZoom: number
  maxZoom: number
  bounds: [number, number, number, number]
  /** MVT layer name allow-list (decoder filters before compile). */
  layers?: string[]
  /** Per-MVT-layer info from `metadata.vector_layers` — id +
   *  minzoom/maxzoom + (optional) field schema. Used by the runtime
   *  to skip work for layers that don't have data at the current
   *  camera zoom (e.g. protomaps v4 `buildings` only at z≥14). */
  vectorLayers?: Array<{ id: string; minzoom: number; maxzoom: number; fields?: Record<string, string> }>
  /** Per-MVT-layer 3D-extrude expression AST. Forwarded to the MVT
   *  worker on every compile request; the worker evaluates the AST
   *  against each feature's properties to produce the feature's
   *  height in metres. */
  extrudeExprs?: Record<string, unknown>
  /** Companion to `extrudeExprs` for Mapbox `fill-extrusion-base` —
   *  per-feature wall-bottom z (default 0). */
  extrudeBaseExprs?: Record<string, unknown>
  /** Per-show slice descriptors. With this set, the worker emits one
   *  pre-filtered slice per UNIQUE (sourceLayer, filter) combo
   *  instead of one slice per source layer — eliminating the
   *  redundant draws when N xgis layers share one MVT layer with
   *  different filters. See `filter-eval.ts` for the contract. */
  showSlices?: Array<{ sliceKey: string; sourceLayer: string; filterAst: unknown | null; needsFeatureProps?: boolean; needsExtrude?: boolean }>
  /** Per-sliceKey stroke-width override AST. The worker uses it to
   *  bake per-feature widths into the slice's line segment buffer so
   *  the line shader picks each feature's width without re-uploading
   *  per-frame uniforms. Compiler-synthesized by mergeLayers. */
  strokeWidthExprs?: Record<string, unknown>
  /** Per-sliceKey stroke-colour override AST. Same plumbing as
   *  width — worker resolves per feature, packs RGBA8 into u32,
   *  writes into segment buffer. */
  strokeColorExprs?: Record<string, unknown>
}

/** Per-backend cap on simultaneous in-flight HTTP fetches. Independent
 *  of catalog-level MAX_CONCURRENT_LOADS — protects this backend from
 *  oversubscribing one archive's network. Mobile gets a tighter cap
 *  because each in-flight fetch holds a directory-page reference in
 *  the pmtiles client + an MVT decode in the worker queue. User-
 *  reported forced refresh on iPhone after sustained pinch+drag
 *  navigation traced to fetch / decode pressure compounding faster
 *  than the GPU could drain it.
 *
 *  Evaluated lazily — module top-level resolution would race the
 *  Playwright viewport apply (and real mobile DPR setup), so a
 *  module-init `MAX_INFLIGHT = …` constant could capture the wrong
 *  value before the host page is fully laid out. The function form
 *  re-checks `window.innerWidth` at every loadTile entry, which is
 *  cheap (one property read + one comparison) and always reflects
 *  the live viewport. */
function maxInflight(): number {
  const w = (typeof window !== 'undefined' ? window.innerWidth : 0) || 0
  return w > 0 && w <= 900 ? 4 : 16
}

/** Per-key negative cache TTL (ms) for tiles that the fetcher has
 *  reported `'failed'` for. While a key is in the failed cache,
 *  loadTile returns immediately without dispatching a new fetch and
 *  without calling acceptResult — so the catalog's hasTileData stays
 *  false, and the renderer's parent-walk continues to find the
 *  failed tile "missing" and falls back to the nearest cached
 *  ancestor. After the TTL, the next visible-tile pass retries the
 *  fetch once (in case the upstream issue resolved). */
const FAILED_KEY_TTL_MS = 5 * 60_000

export class PMTilesBackend implements TileSource {
  readonly meta: TileSourceMeta
  private fetcher: PMTilesFetcher
  private layers: string[] | undefined
  private extrudeExprs: Record<string, unknown> | undefined
  private extrudeBaseExprs: Record<string, unknown> | undefined
  private showSlices: Array<{ sliceKey: string; sourceLayer: string; filterAst: unknown | null; needsFeatureProps?: boolean; needsExtrude?: boolean }> | undefined
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
  private failedKeys: Map<number, number> = new Map()

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
    const failedAt = this.failedKeys.get(key)
    if (failedAt !== undefined) {
      if (Date.now() < failedAt) return
      this.failedKeys.delete(key)
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
      console.error('[pmtiles fetch queue]', err)
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
        // this tile's bounds (Mapbox-style overzoom fallback). After
        // FAILED_KEY_TTL_MS the cache entry expires and a fresh
        // visible-tile pass retries — useful when the upstream
        // problem was transient and has recovered.
        this.failedKeys.set(key, Date.now() + FAILED_KEY_TTL_MS)
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
      this.pendingMvt.push({ key, bytes: result })
    } catch (err) {
      // Aborted via signal (catalog no longer wants this tile) —
      // release the slot but DO NOT mark failedKeys. The tile is
      // free to be re-requested immediately if it becomes visible
      // again, and a future call won't sit in the negative cache.
      const isAbort = (err as Error)?.name === 'AbortError'
      if (!isAbort) {
        this.failedKeys.set(key, Date.now() + FAILED_KEY_TTL_MS)
        console.error('[pmtiles fetch]', (err as Error)?.stack ?? err)
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
          console.error('[pmtiles worker]', (err as Error)?.stack ?? err)
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
        const heights = extractFeatureHeights(sourceFeatures, this.extrudeExprs?.[sourceLayer])
        const bases = extractFeatureHeights(sourceFeatures, this.extrudeBaseExprs?.[sourceLayer])
        const widths = extractFeatureWidths(sourceFeatures, this.strokeWidthExprs?.[sliceKey])
        const colors = extractFeatureColors(sourceFeatures, this.strokeColorExprs?.[sliceKey])
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
            ? layerFeatures.filter(f => evalFilterExpr(desc.filterAst, f.properties ?? {}))
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
      console.error('[pmtiles inline]', (err as Error)?.stack ?? err)
      sink.acceptResult(key, null)
    }
  }

  private _pool: MvtWorkerPool | null = null
  private getPool(): MvtWorkerPool {
    if (!this._pool) this._pool = getSharedMvtPool()
    return this._pool
  }
}

/** Tile dimensions in Mercator metres — used by the worker's
 *  buildLineSegments call for tile-edge boundary detection.
 *  Computed on main and passed to the worker so the worker doesn't
 *  redo the trig per tile. */
function tileSizeMerc(z: number, y: number): { widthMerc: number; heightMerc: number } {
  const DEG2RAD = Math.PI / 180
  const R = 6378137
  const LAT_LIMIT = 85.051129
  const clamp = (v: number) => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, v))
  const n = 1 << z
  const widthMerc = (360 / n) * DEG2RAD * R
  const yToLat = (yt: number) => {
    const s = Math.PI - 2 * Math.PI * (yt / n)
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(s) - Math.exp(-s)))
  }
  const latNorth = yToLat(y)
  const latSouth = yToLat(y + 1)
  const myNorth = Math.log(Math.tan(Math.PI / 4 + clamp(latNorth) * DEG2RAD / 2)) * R
  const mySouth = Math.log(Math.tan(Math.PI / 4 + clamp(latSouth) * DEG2RAD / 2)) * R
  return { widthMerc, heightMerc: myNorth - mySouth }
}

/** True if Web-Mercator tile (z, x, y) overlaps the given lon/lat bounds. */
function tileIntersectsBounds(
  z: number, x: number, y: number,
  bounds: [number, number, number, number],
): boolean {
  const n = 1 << z
  const tileWest = (x / n) * 360 - 180
  const tileEast = ((x + 1) / n) * 360 - 180
  const yToLat = (yt: number) => {
    const s = Math.PI - 2 * Math.PI * (yt / n)
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(s) - Math.exp(-s)))
  }
  const tileNorth = yToLat(y)
  const tileSouth = yToLat(y + 1)
  return !(tileEast < bounds[0] || tileWest > bounds[2] ||
           tileNorth < bounds[1] || tileSouth > bounds[3])
}
