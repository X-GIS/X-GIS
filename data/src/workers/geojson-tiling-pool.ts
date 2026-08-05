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
import { xlog } from '@xgis/shared'
import type { InMsg, OutMsg } from './geojson-tiling-worker'

let _worker: Worker | null = null
let _nextTaskId = 1

interface Pending<T> {
  resolve: (v: T) => void
  reject: (e: Error) => void
}

const pendingSetSource = new Map<number, Pending<void>>()
const pendingGetTile = new Map<number, Pending<Uint8Array>>()

/** #1572 D — every index this pool has registered and not dropped, so a RESPAWNED worker
 *  can be given them back.
 *
 *  A worker 'error' nulls `_worker`; the next `getTile` lazily spawns a fresh one whose
 *  `indexes` map is empty, and an unknown index answers `tile-error` with
 *  `sourceGone: true` — the flag that means "map disposed / source replaced". The
 *  consumer reads that as benign teardown, caches an empty placeholder, and the key is
 *  never requested again: after ONE mid-session crash every newly requested tile of a
 *  still-live source renders empty forever, logged at `debug`.
 *
 *  The retained `geojson` is the SAME object `SourceManager.hostSeededFC` already holds
 *  for the source's lifetime (#1235 gap 2), so this is one extra pointer, not a copy —
 *  and `dropSource` / `disposeGeoJSONTilingPool` release it on the same schedule the
 *  worker-side index is released. */
const registered = new Map<string, InMsg & { kind: 'set-source' }>()

/** A get-tile rejection that carries WHY it failed. `sourceGone` marks the one
 *  benign case: the instance's index was dropped (map disposed, or the source
 *  replaced) while the request was in flight, so the tile can never be produced.
 *  Callers use it to tell teardown from a real failure — see
 *  {@link isSourceGone}. */
export interface TileLoadError extends Error {
  sourceGone?: true
}

function tileError(message: string, sourceGone?: true): TileLoadError {
  const e: TileLoadError = new Error(message)
  if (sourceGone) e.sourceGone = true
  return e
}

/** True when a get-tile rejection is the disposal signal rather than a fault.
 *  A structural check — never a match on the message text. */
export function isSourceGone(err: unknown): boolean {
  return (err as TileLoadError | null)?.sourceGone === true
}

function getWorker(): Worker {
  if (_worker !== null) return _worker
  // Vite-style worker creation. The `?worker` import suffix is
  // resolved at bundle time to a Worker constructor.
  const spawned = new Worker(new URL('./geojson-tiling-worker.ts', import.meta.url), {
    type: 'module',
  })
  _worker = spawned
  // #1572 D — hand a respawned worker back every index it is expected to know, BEFORE any
  // `get-tile` reaches it. No promise plumbing is needed: the worker processes its message
  // queue in order, so a `get-tile` posted right after these finds the index built. On the
  // first spawn `registered` is empty and this loop does nothing.
  for (const msg of registered.values()) spawned.postMessage({ ...msg, taskId: _nextTaskId++ })
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
      } else {
        // No awaiter ⇒ this was a post-respawn replay (#1572 D). Nothing can be retried
        // from here, but it must not be silent: every tile of that source will now come
        // back `sourceGone` and render empty.
        xlog.error('[geojson-tiling] index replay failed after worker respawn', m.message)
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
        p.reject(tileError(m.message, m.sourceGone))
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
  const msg = { kind: 'set-source', taskId, indexKey, sourceName, geojson, options } as const
  // Resolve the worker BEFORE recording, because a lazy spawn replays `registered` — and a
  // key recorded first would be replayed AND posted below, indexing it twice on every
  // first attach. Recording still precedes the post, so a worker that dies while this very
  // build is in flight is handed the index on respawn (#1572 D). Replacing a source
  // overwrites the entry, which is what the worker's own index map does with the same key.
  const worker = getWorker()
  registered.set(indexKey, msg)
  return new Promise<void>((resolve, reject) => {
    pendingSetSource.set(taskId, { resolve, reject })
    worker.postMessage(msg)
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
  const indexKey = composeIndexKey(instanceId, sourceName)
  // Released here as well as worker-side, so a dropped source's FeatureCollection is not
  // pinned by the replay record and a respawn does not rebuild an index nobody wants.
  registered.delete(indexKey)
  // No worker yet ⇒ nothing was ever indexed under this key.
  if (_worker === null) return
  post({ kind: 'drop-source', indexKey })
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
  registered.clear()
}
