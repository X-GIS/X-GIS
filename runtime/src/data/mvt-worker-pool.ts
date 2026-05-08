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

  private ensureWorkers(): void {
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
          const wrapped: MvtCompileSlice[] = (m.slices ?? []).map(s => ({
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
            fullCover: s.fullCover,
            fullCoverFeatureId: s.fullCoverFeatureId,
          }))
          job.resolve(wrapped)
        } else {
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
    showSlices?: Array<{ sliceKey: string; sourceLayer: string; filterAst: unknown | null }>,
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
