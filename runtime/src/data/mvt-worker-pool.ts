// MVT compile worker pool — round-robin dispatch of MVT bytes to N
// worker threads. Each worker decodes + decomposes + compiles +
// builds line segments OFF-thread, returning per-MVT-layer slices
// as Transferable buffers. The catalog stores each slice under
// (key, layerName) so a single source can serve multiple xgis
// `sourceLayer`-filtered render passes.

import type { RingPolygon } from '@xgis/compiler'
import MvtWorker from './mvt-worker.ts?worker'

/** One per-MVT-layer slice in the worker response. Mirrors
 *  MvtCompileSlice in mvt-worker.ts but with already-wrapped
 *  TypedArray views (the buffers were transferred zero-copy). */
export interface MvtCompileSlice {
  layerName: string
  vertices: Float32Array
  indices: Uint32Array
  lineVertices: Float32Array
  lineIndices: Uint32Array
  pointVertices?: Float32Array
  outlineIndices?: Uint32Array
  outlineVertices?: Float32Array
  outlineLineIndices?: Uint32Array
  prebuiltLineSegments?: Float32Array
  prebuiltOutlineSegments?: Float32Array
  polygons?: RingPolygon[]
  heights?: ReadonlyMap<number, number>
  bases?: ReadonlyMap<number, number>
  /** featId → original feature properties bag. Forwarded from the
   *  worker so the SDF text label pipeline can resolve
   *  `label-["{.field}"]` per feature. PMTiles MVT properties are
   *  the primary source — there's no global PropertyTable. */
  featureProps?: ReadonlyMap<number, Record<string, unknown>>
  fullCover: boolean
  fullCoverFeatureId: number
}

interface PendingJob {
  resolve: (slices: MvtCompileSlice[]) => void
  reject: (e: Error) => void
}

interface SliceMsg {
  layerName: string
  vertices: ArrayBuffer
  indices: ArrayBuffer
  lineVertices: ArrayBuffer
  lineIndices: ArrayBuffer
  pointVertices?: ArrayBuffer
  outlineIndices?: ArrayBuffer
  outlineVertices?: ArrayBuffer
  outlineLineIndices?: ArrayBuffer
  featureProps?: ReadonlyMap<number, Record<string, unknown>>
  prebuiltLineSegments?: ArrayBuffer
  prebuiltOutlineSegments?: ArrayBuffer
  polygons?: RingPolygon[]
  heights?: ReadonlyMap<number, number>
  bases?: ReadonlyMap<number, number>
  fullCover: boolean
  fullCoverFeatureId: number
}

/** Shared pool — N workers, round-robin. */
export class MvtWorkerPool {
  private workers: Worker[] = []
  private nextWorker = 0
  private pending = new Map<number, PendingJob>()
  private nextTaskId = 1
  private readonly size: number

  /** rAF-driven resolve queue. Workers can complete decode in close
   *  succession (LOD transition: 5-10 tiles in 50 ms) — resolving them
   *  all in the same microtask boundary triggers a downstream burst:
   *  every resolve runs sink.acceptResult → cacheTileData → uploadTile
   *  → priority-queue add. The `_perf-bright-transition-profile.spec.ts`
   *  showed worst-frame hitches of 138-200 ms on z=10→16 zoom, and the
   *  hot path is bursty rather than uniformly heavy.
   *
   *  Buffer messages here; a rAF callback drains at most
   *  `MAX_RESOLVES_PER_FRAME` per frame so the burst spreads across
   *  several render frames instead of a single microtask. Trade-off:
   *  ~16 ms / queued item of additional first-paint latency on a
   *  cold-start cascade. Worth it for the smoother interactive feel.
   *  Falls back to setTimeout in environments without rAF (vitest
   *  node, SSR) so unit tests still drain. */
  private resolveQueue: Array<{ job: PendingJob; slices: SliceMsg[] }> = []
  private resolveScheduled = false
  private static readonly MAX_RESOLVES_PER_FRAME = 4

  constructor() {
    const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4
    // Cap workers at 2 on mobile-class viewports — every active
    // worker holds an MVT-decode arena in flight + competes with
    // the main thread for thermal budget. Desktop keeps the
    // hardwareConcurrency-driven 2-6 range. Re-checked at
    // construction time so the cap works in both real mobile
    // browsers and Playwright mobile-emulation viewports.
    const isMobile = typeof window !== 'undefined'
      && (window.innerWidth || 0) > 0
      && (window.innerWidth || 0) <= 900
    const ceiling = isMobile ? 2 : 6
    this.size = Math.max(2, Math.min(ceiling, hc - 1))
  }

  /** Spawn the worker fleet if it doesn't exist yet. Called lazily
   *  from `compile()` on first use; also called from
   *  `prewarmMvtWorkerPool()` to start the workers earlier. */
  ensureWorkers(): void {
    if (this.workers.length > 0) return
    for (let i = 0; i < this.size; i++) {
      const w = new MvtWorker({ name: `mvt-compile-${i}` })
      w.addEventListener('message', (e: MessageEvent<{
        kind: string; taskId: number;
        slices?: SliceMsg[];
        message?: string; stack?: string;
      }>) => {
        const m = e.data
        const job = this.pending.get(m.taskId)
        if (!job) return
        this.pending.delete(m.taskId)
        if (m.kind === 'compile-done') {
          // Buffer for rAF drain — see field comment on `resolveQueue`.
          // The wrapping (Float32Array / Uint32Array constructors) is
          // ALSO deferred to drain time so the per-microtask
          // allocation burst is split across several frames too.
          this.resolveQueue.push({ job, slices: m.slices ?? [] })
          this.scheduleResolveDrain()
        } else {
          // Error path stays synchronous — the rejection is light
          // (no typed-array wrapping) and prompt error reporting is
          // more important than burst smoothing.
          const err = new Error(m.message || 'mvt worker failed')
          err.stack = m.stack ?? err.stack
          job.reject(err)
        }
      })
      w.addEventListener('error', (e: ErrorEvent) => {
        console.error('[mvt-worker]', e.message)
      })
      this.workers.push(w)
    }
  }

  /** Schedule a drain of the resolve queue at the next animation
   *  frame. Cheap dedup via `resolveScheduled`; falls back to
   *  setTimeout for non-browser environments (vitest node, SSR). */
  private scheduleResolveDrain(): void {
    if (this.resolveScheduled) return
    this.resolveScheduled = true
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(() => this.drainResolveQueue())
    } else {
      setTimeout(() => this.drainResolveQueue(), 0)
    }
  }

  /** Drain up to `MAX_RESOLVES_PER_FRAME` queued worker results.
   *  Each drained item:
   *    1. wraps every transferred ArrayBuffer in a typed-array view
   *    2. resolves the pending Promise (which fires PMTilesBackend's
   *       acceptResult chain — uploads, cache, render invalidation)
   *
   *  Re-schedules itself if items remain. The cap-per-frame is the
   *  whole point — without it, a 5-tile worker burst all resolved in
   *  one microtask and triggered a 138-200 ms hitch frame on LOD
   *  transition. */
  private drainResolveQueue(): void {
    this.resolveScheduled = false
    let processed = 0
    while (processed < MvtWorkerPool.MAX_RESOLVES_PER_FRAME && this.resolveQueue.length > 0) {
      const { job, slices } = this.resolveQueue.shift()!
      const wrapped: MvtCompileSlice[] = slices.map(s => ({
        layerName: s.layerName,
        vertices: new Float32Array(s.vertices),
        indices: new Uint32Array(s.indices),
        lineVertices: new Float32Array(s.lineVertices),
        lineIndices: new Uint32Array(s.lineIndices),
        pointVertices: s.pointVertices ? new Float32Array(s.pointVertices) : undefined,
        outlineIndices: s.outlineIndices ? new Uint32Array(s.outlineIndices) : undefined,
        outlineVertices: s.outlineVertices ? new Float32Array(s.outlineVertices) : undefined,
        outlineLineIndices: s.outlineLineIndices ? new Uint32Array(s.outlineLineIndices) : undefined,
        prebuiltLineSegments: s.prebuiltLineSegments ? new Float32Array(s.prebuiltLineSegments) : undefined,
        prebuiltOutlineSegments: s.prebuiltOutlineSegments ? new Float32Array(s.prebuiltOutlineSegments) : undefined,
        polygons: s.polygons,
        heights: s.heights,
        bases: s.bases,
        featureProps: s.featureProps,
        fullCover: s.fullCover,
        fullCoverFeatureId: s.fullCoverFeatureId,
      }))
      job.resolve(wrapped)
      processed++
    }
    if (this.resolveQueue.length > 0) this.scheduleResolveDrain()
  }

  /** Dispatch one MVT compile job; returns ALL per-layer slices the
   *  worker found in the tile. Layers may be filtered upstream via
   *  the `layers` arg (allow-list); when omitted, every MVT layer
   *  in the tile produces a slice. */
  compile(
    bytes: ArrayBuffer,
    z: number, x: number, y: number,
    maxZoom: number,
    tileWidthMerc: number, tileHeightMerc: number,
    layers?: string[],
    extrudeExprs?: Record<string, unknown>,
    extrudeBaseExprs?: Record<string, unknown>,
    showSlices?: Array<{ sliceKey: string; sourceLayer: string; filterAst: unknown | null; needsFeatureProps?: boolean; needsExtrude?: boolean }>,
    strokeWidthExprs?: Record<string, unknown>,
    strokeColorExprs?: Record<string, unknown>,
  ): Promise<MvtCompileSlice[]> {
    this.ensureWorkers()
    const taskId = this.nextTaskId++
    return new Promise<MvtCompileSlice[]>((resolve, reject) => {
      this.pending.set(taskId, { resolve, reject })
      const w = this.workers[this.nextWorker]
      this.nextWorker = (this.nextWorker + 1) % this.workers.length
      w.postMessage({
        kind: 'compile-mvt', taskId, bytes,
        z, x, y, maxZoom,
        tileWidthMerc, tileHeightMerc,
        layers,
        extrudeExprs,
        extrudeBaseExprs,
        showSlices,
        strokeWidthExprs,
        strokeColorExprs,
      }, [bytes])
    })
  }

  dispose(): void {
    for (const w of this.workers) w.terminate()
    this.workers.length = 0
    for (const { reject } of this.pending.values()) {
      reject(new Error('mvt worker pool disposed'))
    }
    this.pending.clear()
  }
}

let sharedPool: MvtWorkerPool | null = null
export function getSharedMvtPool(): MvtWorkerPool {
  if (!sharedPool) sharedPool = new MvtWorkerPool()
  return sharedPool
}

/** Prewarm the shared MVT worker pool. Spawns the workers eagerly so
 *  the first `compile()` call doesn't pay the worker-spawn latency
 *  (each Worker takes 10-50 ms to set up its JS context). Call from
 *  the runtime bootstrap (`map.run()`) right after the data-load URLs
 *  are known so worker spawn overlaps with PMTiles header/metadata
 *  round trips and shader pipeline compilation.
 *
 *  Safe to call multiple times — idempotent (`ensureWorkers` early-
 *  returns once the workers exist). */
export function prewarmMvtWorkerPool(): void {
  getSharedMvtPool().ensureWorkers()
}
