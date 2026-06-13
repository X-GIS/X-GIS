// GeoJSON tiling worker. Runs the geojsonvt + MVT-encode pipeline
// off the main thread so the engine never blocks on a large source
// attach or a deep-zoom drilldown. The worker is stateful — it
// retains one GeoJSONVT index per source name, then services
// per-tile requests on demand against that index.
//
// Wire protocol (in-message → out-message). `indexKey` is the
// pool-composed `${instanceId}::${sourceName}` — the namespaced key the
// index map is keyed by; `sourceName` is the user-facing name carried
// through for the encoded MVT layer name and the done echo:
//
//   { kind: 'set-source', indexKey, sourceName, geojson, options? }
//     → { kind: 'set-source-done', sourceName }
//     → { kind: 'set-source-error', message }
//
//   { kind: 'get-tile', indexKey, sourceName, z, x, y, key }
//     → { kind: 'tile', sourceName, key, bytes }   (bytes transferable)
//     → { kind: 'tile-error', message }
//
//   { kind: 'drop-source', indexKey }   (fire-and-forget, no response)
//
//  `key` is X-GIS's Morton-encoded tileKey; the worker echoes it
//  back so the main-thread pool can route the response without
//  re-deriving the key from (z, x, y).

import {
  geojsonvt, encodeMVT,
  type GeoJSONVT, type GeoJSONVTOptions,
} from '@xgis/compiler'

interface SetSourceIn {
  kind: 'set-source'
  taskId: number
  /** Process-global index key — composed by the pool as
   *  `${instanceId}::${sourceName}` so two maps that declare a source
   *  with the SAME user-facing name don't collide on this singleton
   *  worker's index map (silent cross-map geometry corruption). */
  indexKey: string
  sourceName: string
  /** Parsed GeoJSON FeatureCollection / Feature object. */
  geojson: unknown
  options?: Partial<GeoJSONVTOptions>
}

interface GetTileIn {
  kind: 'get-tile'
  taskId: number
  indexKey: string
  sourceName: string
  z: number
  x: number
  y: number
  key: number
}

interface DropSourceIn {
  kind: 'drop-source'
  /** Composed index key whose retained GeoJSONVT index is freed. No
   *  response — fire-and-forget eviction from the source detach/replace
   *  path so a per-source index isn't pinned for the process lifetime. */
  indexKey: string
}

type InMsg = SetSourceIn | GetTileIn | DropSourceIn

interface SetSourceDoneOut {
  kind: 'set-source-done'
  taskId: number
  sourceName: string
}

interface SetSourceErrOut {
  kind: 'set-source-error'
  taskId: number
  message: string
}

interface TileOut {
  kind: 'tile'
  taskId: number
  sourceName: string
  key: number
  /** Empty (length 0) when the tile has no features. Always
   *  transferable — caller can `bytes.buffer` straight into
   *  postMessage's transfer list. */
  bytes: Uint8Array
}

interface TileErrOut {
  kind: 'tile-error'
  taskId: number
  message: string
}

type OutMsg = SetSourceDoneOut | SetSourceErrOut | TileOut | TileErrOut

/** GeoJSONVT indexes keyed by the pool-composed `${instanceId}::${sourceName}`
 *  index key — NOT the bare user-facing source name. This worker is a
 *  process-global singleton shared by every XGISMap on the page, so keying
 *  by the bare name lets two maps with the same source name clobber each
 *  other's index. The composed key namespaces per caller. */
const indexes = new Map<string, GeoJSONVT>()

function post(msg: OutMsg, transfer?: Transferable[]): void {
  ;(self as unknown as { postMessage: (m: OutMsg, t?: Transferable[]) => void })
    .postMessage(msg, transfer)
}

self.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data as InMsg
  try {
    if (msg.kind === 'set-source') {
      const idx = geojsonvt(msg.geojson as Parameters<typeof geojsonvt>[0], msg.options)
      indexes.set(msg.indexKey, idx)
      post({ kind: 'set-source-done', taskId: msg.taskId, sourceName: msg.sourceName })
      return
    }

    if (msg.kind === 'drop-source') {
      // Fire-and-forget eviction — free the retained index when its
      // source is detached / replaced (no response expected).
      indexes.delete(msg.indexKey)
      return
    }

    if (msg.kind === 'get-tile') {
      const idx = indexes.get(msg.indexKey)
      if (!idx) {
        post({ kind: 'tile-error', taskId: msg.taskId, message: `unknown source: ${msg.sourceName}` })
        return
      }
      const tile = idx.getTile(msg.z, msg.x, msg.y)
      const bytes = (tile && tile.features.length > 0)
        ? encodeMVT([{ name: msg.sourceName, tile }])
        : new Uint8Array(0)
      post(
        { kind: 'tile', taskId: msg.taskId, sourceName: msg.sourceName, key: msg.key, bytes },
        bytes.byteLength > 0 ? [bytes.buffer] : [],
      )
      return
    }
  } catch (err) {
    const e = err as Error
    const errMsg = e.message || String(err)
    // `drop-source` carries no taskId and its body (Map.delete) can't throw,
    // so it never lands here — only the request kinds report errors back.
    if (msg.kind === 'set-source') {
      post({ kind: 'set-source-error', taskId: msg.taskId, message: errMsg })
    } else if (msg.kind === 'get-tile') {
      post({ kind: 'tile-error', taskId: msg.taskId, message: errMsg })
    }
  }
})

export type {
  SetSourceIn, GetTileIn, DropSourceIn, InMsg,
  SetSourceDoneOut, SetSourceErrOut, TileOut, TileErrOut, OutMsg,
}
