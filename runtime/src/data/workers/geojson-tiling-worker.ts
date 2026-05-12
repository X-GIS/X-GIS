// GeoJSON tiling worker. Runs the geojsonvt + MVT-encode pipeline
// off the main thread so the engine never blocks on a large source
// attach or a deep-zoom drilldown. The worker is stateful — it
// retains one GeoJSONVT index per source name, then services
// per-tile requests on demand against that index.
//
// Wire protocol (in-message → out-message):
//
//   { kind: 'set-source', sourceName, geojson, options? }
//     → { kind: 'set-source-done', sourceName }
//     → { kind: 'set-source-error', message }
//
//   { kind: 'get-tile', sourceName, z, x, y, key }
//     → { kind: 'tile', sourceName, key, bytes }   (bytes transferable)
//     → { kind: 'tile-error', message }
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
  sourceName: string
  /** Parsed GeoJSON FeatureCollection / Feature object. */
  geojson: unknown
  options?: Partial<GeoJSONVTOptions>
}

interface GetTileIn {
  kind: 'get-tile'
  taskId: number
  sourceName: string
  z: number
  x: number
  y: number
  key: number
}

type InMsg = SetSourceIn | GetTileIn

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
      indexes.set(msg.sourceName, idx)
      post({ kind: 'set-source-done', taskId: msg.taskId, sourceName: msg.sourceName })
      return
    }

    if (msg.kind === 'get-tile') {
      const idx = indexes.get(msg.sourceName)
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
    if ((msg as { kind?: string }).kind === 'set-source') {
      post({ kind: 'set-source-error', taskId: msg.taskId, message: errMsg })
    } else {
      post({ kind: 'tile-error', taskId: msg.taskId, message: errMsg })
    }
  }
})

export type {
  SetSourceIn, GetTileIn, InMsg,
  SetSourceDoneOut, SetSourceErrOut, TileOut, TileErrOut, OutMsg,
}
