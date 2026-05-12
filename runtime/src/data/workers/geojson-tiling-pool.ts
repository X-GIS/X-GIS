// Main-thread wrapper around the GeoJSON tiling worker. Single
// worker instance — one is enough for typical X-GIS workloads
// (one or two small to medium GeoJSON sources per scene). If a
// future scene needs more parallelism we can extend to a pool here
// without touching the worker protocol.
//
// API:
//   - setSource(name, geojson, options?)  → Promise<void>
//   - getTile(name, z, x, y, key)         → Promise<Uint8Array>
//     (empty Uint8Array when the tile has no features)

import type { GeoJSONVTOptions } from '@xgis/compiler'
import type { InMsg, OutMsg } from './geojson-tiling-worker'

let _worker: Worker | null = null
let _nextTaskId = 1

interface Pending<T> {
  resolve: (v: T) => void
  reject: (e: Error) => void
}

const pendingSetSource = new Map<number, Pending<void>>()
const pendingGetTile = new Map<number, Pending<Uint8Array>>()

function getWorker(): Worker {
  if (_worker !== null) return _worker
  // Vite-style worker creation. The `?worker` import suffix is
  // resolved at bundle time to a Worker constructor.
  _worker = new Worker(new URL('./geojson-tiling-worker.ts', import.meta.url), { type: 'module' })
  _worker.addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as OutMsg
    if (m.kind === 'set-source-done') {
      const p = pendingSetSource.get(m.taskId)
      if (p) { pendingSetSource.delete(m.taskId); p.resolve() }
    } else if (m.kind === 'set-source-error') {
      const p = pendingSetSource.get(m.taskId)
      if (p) { pendingSetSource.delete(m.taskId); p.reject(new Error(m.message)) }
    } else if (m.kind === 'tile') {
      const p = pendingGetTile.get(m.taskId)
      if (p) { pendingGetTile.delete(m.taskId); p.resolve(m.bytes) }
    } else if (m.kind === 'tile-error') {
      const p = pendingGetTile.get(m.taskId)
      if (p) { pendingGetTile.delete(m.taskId); p.reject(new Error(m.message)) }
    }
  })
  _worker.addEventListener('error', (ev) => {
    // Reject every outstanding promise with the worker's error
    // message so callers don't hang on a crashed worker.
    const err = new Error(ev.message || 'geojson-tiling-worker crashed')
    for (const p of pendingSetSource.values()) p.reject(err)
    for (const p of pendingGetTile.values()) p.reject(err)
    pendingSetSource.clear()
    pendingGetTile.clear()
    _worker = null
  })
  return _worker
}

function post(msg: InMsg): void {
  getWorker().postMessage(msg)
}

/** Initialise / replace the worker's index for `sourceName`.
 *  Resolves when the index is built and ready to serve tiles. */
export function setSource(
  sourceName: string,
  geojson: unknown,
  options?: Partial<GeoJSONVTOptions>,
): Promise<void> {
  const taskId = _nextTaskId++
  return new Promise<void>((resolve, reject) => {
    pendingSetSource.set(taskId, { resolve, reject })
    post({ kind: 'set-source', taskId, sourceName, geojson, options })
  })
}

/** Request an encoded MVT tile from the worker. The returned
 *  Uint8Array has length 0 when the tile has no features (caller
 *  should treat that as "tile is empty, not missing"). */
export function getTile(
  sourceName: string,
  z: number, x: number, y: number,
  key: number,
): Promise<Uint8Array> {
  const taskId = _nextTaskId++
  return new Promise<Uint8Array>((resolve, reject) => {
    pendingGetTile.set(taskId, { resolve, reject })
    post({ kind: 'get-tile', taskId, sourceName, z, x, y, key })
  })
}

/** Terminate the underlying worker. Test cleanup only — production
 *  keeps the worker alive for the lifetime of the page. */
export function disposeGeoJSONTilingPool(): void {
  if (_worker !== null) {
    _worker.terminate()
    _worker = null
  }
  for (const p of pendingSetSource.values()) p.reject(new Error('pool disposed'))
  for (const p of pendingGetTile.values()) p.reject(new Error('pool disposed'))
  pendingSetSource.clear()
  pendingGetTile.clear()
}
