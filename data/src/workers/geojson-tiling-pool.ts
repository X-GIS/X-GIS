// Main-thread wrapper around the GeoJSON tiling worker. Single
// worker instance — one is enough for typical X-GIS workloads
// (one or two small to medium GeoJSON sources per scene). If a
// future scene needs more parallelism we can extend to a pool here
// without touching the worker protocol.
//
// API (callers pass a per-map `instanceId` from `newTilingInstanceId()`
// so the singleton worker namespaces each caller's index — two maps
// with the same source name no longer collide):
//   - newTilingInstanceId()                          → string
//   - setSource(instanceId, name, geojson, options?) → Promise<void>
//   - getTile(instanceId, name, z, x, y, key)        → Promise<Uint8Array>
//     (empty Uint8Array when the tile has no features)
//   - dropSource(instanceId, name)                   → void (evict index)

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
      if (p) {
        pendingSetSource.delete(m.taskId)
        p.resolve()
      }
    } else if (m.kind === 'set-source-error') {
      const p = pendingSetSource.get(m.taskId)
      if (p) {
        pendingSetSource.delete(m.taskId)
        p.reject(new Error(m.message))
      }
    } else if (m.kind === 'tile') {
      const p = pendingGetTile.get(m.taskId)
      if (p) {
        pendingGetTile.delete(m.taskId)
        p.resolve(m.bytes)
      }
    } else if (m.kind === 'tile-error') {
      const p = pendingGetTile.get(m.taskId)
      if (p) {
        pendingGetTile.delete(m.taskId)
        p.reject(new Error(m.message))
      }
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

/** Mint a process-unique caller id. The worker is a singleton shared by
 *  every XGISMap on the page; callers namespace their index keys with one
 *  of these so two maps that declare a GeoJSON source with the SAME
 *  user-facing name (the common default 'geojson') don't clobber each
 *  other's index under the bare name. One id per SourceManager (≈ per map). */
let _nextInstanceId = 1
export function newTilingInstanceId(): string {
  return `gjt${_nextInstanceId++}`
}

/** Compose the worker-side index key from the caller id + the user-facing
 *  source name. Keep the two arguments separate everywhere else so the
 *  encoded MVT layer name (and any host-visible diagnostic) stays the bare
 *  `sourceName`. */
function composeIndexKey(instanceId: string, sourceName: string): string {
  return `${instanceId}::${sourceName}`
}

/** Initialise / replace the worker's index for `(instanceId, sourceName)`.
 *  Resolves when the index is built and ready to serve tiles. */
export function setSource(
  instanceId: string,
  sourceName: string,
  geojson: unknown,
  options?: Partial<GeoJSONVTOptions>,
): Promise<void> {
  const taskId = _nextTaskId++
  const indexKey = composeIndexKey(instanceId, sourceName)
  return new Promise<void>((resolve, reject) => {
    pendingSetSource.set(taskId, { resolve, reject })
    post({ kind: 'set-source', taskId, indexKey, sourceName, geojson, options })
  })
}

/** Request an encoded MVT tile from the worker. The returned
 *  Uint8Array has length 0 when the tile has no features (caller
 *  should treat that as "tile is empty, not missing"). */
export function getTile(
  instanceId: string,
  sourceName: string,
  z: number,
  x: number,
  y: number,
  key: number,
): Promise<Uint8Array> {
  const taskId = _nextTaskId++
  const indexKey = composeIndexKey(instanceId, sourceName)
  return new Promise<Uint8Array>((resolve, reject) => {
    pendingGetTile.set(taskId, { resolve, reject })
    post({ kind: 'get-tile', taskId, indexKey, sourceName, z, x, y, key })
  })
}

/** Evict the worker's retained index for `(instanceId, sourceName)`.
 *  Fire-and-forget — the worker frees the per-source GeoJSONVT index so a
 *  detached / replaced source isn't pinned for the process lifetime. Safe
 *  on the shared singleton: only this caller's namespaced key is dropped,
 *  so a sibling map's live index is untouched. */
export function dropSource(instanceId: string, sourceName: string): void {
  // No worker yet ⇒ nothing was ever indexed under this key.
  if (_worker === null) return
  post({ kind: 'drop-source', indexKey: composeIndexKey(instanceId, sourceName) })
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
