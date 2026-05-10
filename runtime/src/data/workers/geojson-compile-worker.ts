// ═══ GeoJSON compile worker ═══
//
// Runs on a dedicated Web Worker thread. Receives a GeoJSONFeatureCollection
// and compile options, runs `decomposeFeatures` + `compileGeoJSONToTiles`
// (earcut + line-segment build), and returns typed-array buffers as
// Transferables.
//
// Main-thread only pays the structured-clone of GeoJSON on postMessage and
// the typed-array transfer back — never the earcut cost.
//
// Matches the pattern established by `xgvt-worker.ts` for VT tile parsing.

import {
  compileGeoJSONToTiles,
  decomposeFeatures,
  type CompiledTile,
  type GeometryPart,
  type PropertyTable,
} from '@xgis/compiler'
import type { GeoJSONFeature, GeoJSONFeatureCollection } from '../../loader/geojson'
import { toU32Id } from '../../engine/id-resolver'

// ── Message protocol ──

/** Which id-resolution strategy the worker should use. Functions aren't
 *  structured-cloneable, so we pass an enum and reconstruct the resolver
 *  inside the worker scope. */
export type IdResolverMode = 'index' | 'feature-id-fallback'

export interface GeoJSONCompileRequest {
  kind: 'compile'
  taskId: number
  geojson: GeoJSONFeatureCollection
  minZoom: number
  maxZoom: number
  idResolverMode: IdResolverMode
}

/** Serialized tile — typed arrays become ArrayBuffers for transfer. */
export interface SerializedTile {
  z: number
  x: number
  y: number
  tileWest: number
  tileSouth: number
  vertices: ArrayBuffer
  indices: ArrayBuffer
  lineVertices: ArrayBuffer
  lineIndices: ArrayBuffer
  outlineIndices: ArrayBuffer
  /** Outline vertices in DSFUN stride 10 — see CompiledTile in
   *  vector-tiler.ts for the rationale. Empty buffer when the tiler
   *  didn't emit them (back-compat path). */
  outlineVertices: ArrayBuffer
  outlineLineIndices: ArrayBuffer
  pointVertices?: ArrayBuffer
  featureCount: number
  fullCover?: boolean
  fullCoverFeatureId?: number
  polygons?: { rings: number[][][]; featId: number }[]
}

export interface SerializedTileLevel {
  zoom: number
  /** Pairs of [tileKey, tile] so the receiver can rebuild Map<number, CompiledTile>. */
  tiles: [number, SerializedTile][]
}

export interface GeoJSONCompileResponse {
  kind: 'compile-done'
  taskId: number
  parts: GeometryPart[]
  levels: SerializedTileLevel[]
  bounds: [number, number, number, number]
  featureCount: number
  propertyTable: PropertyTable
}

export interface GeoJSONCompileError {
  kind: 'compile-error'
  taskId: number
  message: string
  stack?: string
}

type InMsg = GeoJSONCompileRequest
type OutMsg = GeoJSONCompileResponse | GeoJSONCompileError

// ── Shared logic (used by both worker and main-thread fallback) ──

export function resolveIdResolver(mode: IdResolverMode) {
  if (mode === 'feature-id-fallback') {
    return (f: GeoJSONFeature, i: number) => toU32Id(f.id ?? f.properties?.id ?? i)
  }
  return (_f: GeoJSONFeature, i: number) => i
}

/** Run the compile + part-decomposition end-to-end. Returns a serializable
 *  response shape plus the transferable ArrayBuffer list. Shared by the
 *  worker entry point and the sync fallback in the pool. */
export function runCompile(
  req: GeoJSONCompileRequest,
): { response: GeoJSONCompileResponse; transferables: ArrayBuffer[] } {
  const idResolver = resolveIdResolver(req.idResolverMode)
  const parts = decomposeFeatures(req.geojson.features, idResolver)
  const set = compileGeoJSONToTiles(req.geojson, {
    minZoom: req.minZoom,
    maxZoom: req.maxZoom,
    idResolver,
  })

  const transferables: ArrayBuffer[] = []
  const serializedLevels: SerializedTileLevel[] = set.levels.map((level) => {
    const tiles: [number, SerializedTile][] = []
    level.tiles.forEach((tile: CompiledTile, key: number) => {
      const s: SerializedTile = {
        z: tile.z, x: tile.x, y: tile.y,
        tileWest: tile.tileWest, tileSouth: tile.tileSouth,
        vertices: tile.vertices.buffer as ArrayBuffer,
        indices: tile.indices.buffer as ArrayBuffer,
        lineVertices: tile.lineVertices.buffer as ArrayBuffer,
        lineIndices: tile.lineIndices.buffer as ArrayBuffer,
        outlineIndices: tile.outlineIndices.buffer as ArrayBuffer,
        outlineVertices: tile.outlineVertices.buffer as ArrayBuffer,
        outlineLineIndices: tile.outlineLineIndices.buffer as ArrayBuffer,
        pointVertices: tile.pointVertices?.buffer as ArrayBuffer | undefined,
        featureCount: tile.featureCount,
        fullCover: tile.fullCover,
        fullCoverFeatureId: tile.fullCoverFeatureId,
        polygons: tile.polygons,
      }
      transferables.push(s.vertices, s.indices, s.lineVertices, s.lineIndices, s.outlineIndices)
      if (s.outlineVertices.byteLength > 0) transferables.push(s.outlineVertices)
      if (s.outlineLineIndices.byteLength > 0) transferables.push(s.outlineLineIndices)
      if (s.pointVertices) transferables.push(s.pointVertices)
      tiles.push([key, s])
    })
    return { zoom: level.zoom, tiles }
  })

  return {
    response: {
      kind: 'compile-done',
      taskId: req.taskId,
      parts,
      levels: serializedLevels,
      bounds: set.bounds,
      featureCount: set.featureCount,
      propertyTable: set.propertyTable,
    },
    transferables: transferables.filter((b) => b.byteLength > 0),
  }
}

// ── Worker entry point (no-op when imported outside a Worker scope) ──

// `self.addEventListener` exists in Workers; gate on DedicatedWorkerGlobalScope
// so this module can also be imported by unit tests without registering a
// stray listener on the test environment's global object.
const isWorkerScope =
  typeof self !== 'undefined' &&
  typeof (self as unknown as { importScripts?: unknown }).importScripts !== 'undefined'

if (isWorkerScope) {
  self.addEventListener('message', (e: MessageEvent<InMsg>) => {
    const msg = e.data
    if (msg.kind !== 'compile') return
    try {
      const { response, transferables } = runCompile(msg)
      ;(self as unknown as { postMessage: (m: OutMsg, t?: Transferable[]) => void })
        .postMessage(response, transferables)
    } catch (err) {
      const e = err as Error
      const response: GeoJSONCompileError = {
        kind: 'compile-error',
        taskId: msg.taskId,
        message: e.message || String(err),
        stack: e.stack,
      }
      ;(self as unknown as { postMessage: (m: OutMsg) => void }).postMessage(response)
    }
  })
}
