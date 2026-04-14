// ═══ XGVT parse worker pool ═══
//
// Round-robin pool that dispatches tile parse jobs to N dedicated
// workers. Each job is (compressed bytes, tile entry) → parsed
// vertex/index Float32Array/Uint32Array views + polygon rings.
//
// Ownership: the pool lives on the main thread and is shared across
// all XGVTSources in a single XGISMap instance. Workers are spawned
// lazily on first use so cold imports (Monaco, etc.) don't pay the
// startup cost if vector tiles are never touched.

import type { TileIndexEntry, RingPolygon } from '@xgis/compiler'
// Vite ?worker import — produces a bundled Worker constructor.
import XGVTWorker from './xgvt-worker.ts?worker'

export interface ParsedTile {
  vertices: Float32Array
  indices: Uint32Array
  lineVertices: Float32Array
  lineIndices: Uint32Array
  outlineIndices: Uint32Array
  polygons?: RingPolygon[]
}

interface PendingJob {
  resolve: (tile: ParsedTile) => void
  reject: (err: Error) => void
}

/** Shared pool of N parse workers with round-robin dispatch. */
export class XGVTWorkerPool {
  private workers: Worker[] = []
  private nextWorker = 0
  private pending = new Map<number, PendingJob>()
  private nextTaskId = 1
  private readonly size: number

  constructor() {
    // Clamp worker count: at least 2, at most 6. Modern mobile SoCs
    // have 4-8 cores; leaving 1-2 for the main thread + browser.
    const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4
    this.size = Math.max(2, Math.min(6, hc - 1))
  }

  /** Spawn workers lazily on first use. */
  private ensureWorkers(): void {
    if (this.workers.length > 0) return
    for (let i = 0; i < this.size; i++) {
      const w = new XGVTWorker({ name: `xgvt-parse-${i}` })
      w.addEventListener('message', (e: MessageEvent<{
        kind: string; taskId: number;
        vertices?: ArrayBuffer; indices?: ArrayBuffer;
        lineVertices?: ArrayBuffer; lineIndices?: ArrayBuffer;
        outlineIndices?: ArrayBuffer;
        polygons?: RingPolygon[];
        message?: string; stack?: string;
      }>) => {
        const msg = e.data
        const job = this.pending.get(msg.taskId)
        if (!job) return
        this.pending.delete(msg.taskId)
        if (msg.kind === 'parse-done') {
          job.resolve({
            vertices: new Float32Array(msg.vertices!),
            indices: new Uint32Array(msg.indices!),
            lineVertices: new Float32Array(msg.lineVertices!),
            lineIndices: new Uint32Array(msg.lineIndices!),
            outlineIndices: new Uint32Array(msg.outlineIndices!),
            polygons: msg.polygons,
          })
        } else {
          const err = new Error(msg.message || 'worker parse failed')
          err.stack = msg.stack ?? err.stack
          job.reject(err)
        }
      })
      w.addEventListener('error', (e) => {
        console.error('[xgvt-worker]', e.message)
      })
      this.workers.push(w)
    }
  }

  /** Parse one compact tile. Resolves with typed-array views over
   *  buffers transferred from the worker. */
  parseTile(compressed: ArrayBuffer, entry: TileIndexEntry): Promise<ParsedTile> {
    this.ensureWorkers()
    const taskId = this.nextTaskId++
    return new Promise<ParsedTile>((resolve, reject) => {
      this.pending.set(taskId, { resolve, reject })
      const w = this.workers[this.nextWorker]
      this.nextWorker = (this.nextWorker + 1) % this.workers.length
      // Transfer the compressed buffer to the worker — it's consumed
      // once per tile so we don't need to keep a main-thread copy.
      w.postMessage({ kind: 'parse', taskId, compressed, entry }, [compressed])
    })
  }

  /** Terminate all workers. Called by XGISMap.stop(). */
  dispose(): void {
    for (const w of this.workers) w.terminate()
    this.workers.length = 0
    for (const { reject } of this.pending.values()) {
      reject(new Error('worker pool disposed'))
    }
    this.pending.clear()
  }
}

/** Shared pool singleton — lazily created on first access. Multiple
 *  XGISMap instances in the same page share one pool to avoid
 *  spawning dozens of workers for multi-map dashboards. */
let sharedPool: XGVTWorkerPool | null = null
export function getSharedPool(): XGVTWorkerPool {
  if (!sharedPool) sharedPool = new XGVTWorkerPool()
  return sharedPool
}
