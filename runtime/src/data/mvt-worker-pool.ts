// MVT compile worker pool — round-robin dispatch of MVT bytes to N
// worker threads. Each worker decodes + decomposes + compiles +
// builds line segments off-thread, returning Transferable buffers
// that the main thread wraps as a BackendTileResult.

import type { RingPolygon } from '@xgis/compiler'
import MvtWorker from './mvt-worker.ts?worker'

export interface MvtCompileResult {
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
  fullCover: boolean
  fullCoverFeatureId: number
  empty: boolean
}

interface PendingJob {
  resolve: (r: MvtCompileResult) => void
  reject: (e: Error) => void
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
    this.size = Math.max(2, Math.min(6, hc - 1))
  }

  private ensureWorkers(): void {
    if (this.workers.length > 0) return
    for (let i = 0; i < this.size; i++) {
      const w = new MvtWorker({ name: `mvt-compile-${i}` })
      w.addEventListener('message', (e: MessageEvent<{
        kind: string; taskId: number;
        vertices?: ArrayBuffer; indices?: ArrayBuffer;
        lineVertices?: ArrayBuffer; lineIndices?: ArrayBuffer;
        pointVertices?: ArrayBuffer;
        outlineIndices?: ArrayBuffer;
        outlineVertices?: ArrayBuffer;
        outlineLineIndices?: ArrayBuffer;
        prebuiltLineSegments?: ArrayBuffer;
        prebuiltOutlineSegments?: ArrayBuffer;
        polygons?: RingPolygon[];
        fullCover?: boolean;
        fullCoverFeatureId?: number;
        empty?: boolean;
        message?: string; stack?: string;
      }>) => {
        const m = e.data
        const job = this.pending.get(m.taskId)
        if (!job) return
        this.pending.delete(m.taskId)
        if (m.kind === 'compile-done') {
          job.resolve({
            vertices: new Float32Array(m.vertices!),
            indices: new Uint32Array(m.indices!),
            lineVertices: new Float32Array(m.lineVertices!),
            lineIndices: new Uint32Array(m.lineIndices!),
            pointVertices: m.pointVertices ? new Float32Array(m.pointVertices) : undefined,
            outlineIndices: m.outlineIndices ? new Uint32Array(m.outlineIndices) : undefined,
            outlineVertices: m.outlineVertices ? new Float32Array(m.outlineVertices) : undefined,
            outlineLineIndices: m.outlineLineIndices ? new Uint32Array(m.outlineLineIndices) : undefined,
            prebuiltLineSegments: m.prebuiltLineSegments ? new Float32Array(m.prebuiltLineSegments) : undefined,
            prebuiltOutlineSegments: m.prebuiltOutlineSegments ? new Float32Array(m.prebuiltOutlineSegments) : undefined,
            polygons: m.polygons,
            fullCover: m.fullCover ?? false,
            fullCoverFeatureId: m.fullCoverFeatureId ?? 0,
            empty: m.empty ?? false,
          })
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

  /** Dispatch one MVT compile job; returns the parsed result wrapped
   *  around Transferable buffers. */
  compile(
    bytes: ArrayBuffer,
    z: number, x: number, y: number,
    maxZoom: number,
    tileWidthMerc: number, tileHeightMerc: number,
    layers?: string[],
  ): Promise<MvtCompileResult> {
    this.ensureWorkers()
    const taskId = this.nextTaskId++
    return new Promise<MvtCompileResult>((resolve, reject) => {
      this.pending.set(taskId, { resolve, reject })
      const w = this.workers[this.nextWorker]
      this.nextWorker = (this.nextWorker + 1) % this.workers.length
      w.postMessage({
        kind: 'compile-mvt', taskId, bytes,
        z, x, y, maxZoom,
        tileWidthMerc, tileHeightMerc,
        layers,
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
