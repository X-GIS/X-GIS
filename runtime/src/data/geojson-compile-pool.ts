// ═══ GeoJSON compile worker pool ═══
//
// Offloads `decomposeFeatures` + `compileGeoJSONToTiles` for inline GeoJSON
// sources to a dedicated worker so the main thread doesn't block on earcut
// for large feature collections.
//
// Mirrors `xgvt-worker-pool.ts` — one shared pool per page, round-robin
// dispatch, lazy spawn, sync fallback when workers are unavailable (SSR,
// vitest, or when `new Worker()` throws).

import type {
  CompiledTileSet,
  GeometryPart,
  CompiledTile,
  TileLevel,
  PropertyTable,
} from '@xgis/compiler'
import type { GeoJSONFeatureCollection } from '../loader/geojson'
// Vite ?worker import — produces a bundled Worker constructor. The module
// also exports the sync `runCompile` helper that the fallback path uses.
import GeoJSONWorker from './geojson-compile-worker.ts?worker'
import {
  runCompile,
  type GeoJSONCompileRequest,
  type GeoJSONCompileResponse,
  type GeoJSONCompileError,
  type IdResolverMode,
  type SerializedTile,
} from './geojson-compile-worker'

export interface CompileResult {
  parts: GeometryPart[]
  tileSet: CompiledTileSet
}

interface PendingJob {
  resolve: (res: CompileResult) => void
  reject: (err: Error) => void
}

/** Rebuild a live CompiledTileSet from the serialized worker response —
 *  wraps ArrayBuffers back into typed-array views and reassembles the
 *  `Map<number, CompiledTile>` for each level. */
function deserializeResponse(res: GeoJSONCompileResponse): CompileResult {
  const levels: TileLevel[] = res.levels.map((level) => {
    const tiles = new Map<number, CompiledTile>()
    for (const [key, s] of level.tiles) {
      const tile: CompiledTile = {
        z: s.z, x: s.x, y: s.y,
        tileWest: s.tileWest, tileSouth: s.tileSouth,
        vertices: new Float32Array(s.vertices),
        indices: new Uint32Array(s.indices),
        lineVertices: new Float32Array(s.lineVertices),
        lineIndices: new Uint32Array(s.lineIndices),
        outlineIndices: new Uint32Array(s.outlineIndices),
        outlineVertices: new Float32Array(s.outlineVertices),
        outlineLineIndices: new Uint32Array(s.outlineLineIndices),
        pointVertices: s.pointVertices ? new Float32Array(s.pointVertices) : undefined,
        featureCount: s.featureCount,
        fullCover: s.fullCover,
        fullCoverFeatureId: s.fullCoverFeatureId,
        polygons: s.polygons,
      }
      tiles.set(key, tile)
    }
    return { zoom: level.zoom, tiles }
  })

  return {
    parts: res.parts,
    tileSet: {
      levels,
      bounds: res.bounds,
      featureCount: res.featureCount,
      propertyTable: res.propertyTable as PropertyTable,
    },
  }
}

// Re-used by the sync fallback — convert the same serialized shape produced
// by `runCompile` back into the live CompileResult, without any worker hop.
function serializedTileToLive(s: SerializedTile): CompiledTile {
  return {
    z: s.z, x: s.x, y: s.y,
    tileWest: s.tileWest, tileSouth: s.tileSouth,
    vertices: new Float32Array(s.vertices),
    indices: new Uint32Array(s.indices),
    lineVertices: new Float32Array(s.lineVertices),
    lineIndices: new Uint32Array(s.lineIndices),
    outlineIndices: new Uint32Array(s.outlineIndices),
    outlineVertices: new Float32Array(s.outlineVertices),
    outlineLineIndices: new Uint32Array(s.outlineLineIndices),
    pointVertices: s.pointVertices ? new Float32Array(s.pointVertices) : undefined,
    featureCount: s.featureCount,
    fullCover: s.fullCover,
    fullCoverFeatureId: s.fullCoverFeatureId,
    polygons: s.polygons,
  }
}

/** Shared pool of N compile workers with round-robin dispatch. */
export class GeoJSONCompilePool {
  private workers: Worker[] = []
  private nextWorker = 0
  private pending = new Map<number, PendingJob>()
  private nextTaskId = 1
  private readonly size: number
  /** Flips to `true` permanently once Worker construction throws, so we
   *  stop retrying on every call in environments without workers. */
  private workersUnavailable = false

  constructor() {
    // Fewer workers than VT pool: GeoJSON compile is usually one-shot per
    // source, not per-tile. 1–2 is plenty; the cap stays at 4 for very
    // large multi-source scenes.
    const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4
    this.size = Math.max(1, Math.min(4, Math.floor(hc / 2)))
  }

  /** Spawn workers lazily on first use. Any construction failure sets
   *  `workersUnavailable` and forces the sync fallback. */
  private ensureWorkers(): boolean {
    if (this.workersUnavailable) return false
    if (this.workers.length > 0) return true
    try {
      for (let i = 0; i < this.size; i++) {
        const w = new GeoJSONWorker({ name: `geojson-compile-${i}` })
        w.addEventListener('message', (e: MessageEvent<GeoJSONCompileResponse | GeoJSONCompileError>) => {
          const msg = e.data
          const job = this.pending.get(msg.taskId)
          if (!job) return
          this.pending.delete(msg.taskId)
          if (msg.kind === 'compile-done') {
            job.resolve(deserializeResponse(msg))
          } else {
            const err = new Error(msg.message || 'worker compile failed')
            err.stack = msg.stack ?? err.stack
            job.reject(err)
          }
        })
        w.addEventListener('error', (e) => {
          console.error('[geojson-compile-worker]', e.message)
        })
        this.workers.push(w)
      }
      return true
    } catch (err) {
      console.warn('[X-GIS] Worker spawn failed, falling back to main-thread compile:', err)
      this.workersUnavailable = true
      return false
    }
  }

  /** Compile one GeoJSON source. Routes through a worker when possible and
   *  falls back to a main-thread run otherwise. Either path resolves with
   *  an identically-shaped CompileResult so callers don't need branch logic. */
  compile(
    geojson: GeoJSONFeatureCollection,
    minZoom: number,
    maxZoom: number,
    idResolverMode: IdResolverMode,
  ): Promise<CompileResult> {
    if (!this.ensureWorkers()) {
      return this.compileSync(geojson, minZoom, maxZoom, idResolverMode)
    }
    const taskId = this.nextTaskId++
    return new Promise<CompileResult>((resolve, reject) => {
      this.pending.set(taskId, { resolve, reject })
      const w = this.workers[this.nextWorker]
      this.nextWorker = (this.nextWorker + 1) % this.workers.length
      const req: GeoJSONCompileRequest = {
        kind: 'compile', taskId, geojson, minZoom, maxZoom, idResolverMode,
      }
      w.postMessage(req)
    })
  }

  /** Main-thread fallback used when workers are unavailable (SSR, vitest,
   *  or spawn failure). Runs the same logic synchronously but returns a
   *  Promise so callers always observe an async boundary. */
  private compileSync(
    geojson: GeoJSONFeatureCollection,
    minZoom: number,
    maxZoom: number,
    idResolverMode: IdResolverMode,
  ): Promise<CompileResult> {
    try {
      const { response } = runCompile({
        kind: 'compile', taskId: 0, geojson, minZoom, maxZoom, idResolverMode,
      })
      // runCompile produces the same serialized shape the worker emits; go
      // through the live-tile rebuild so both paths return identical typed
      // arrays, polygons, etc.
      const levels: TileLevel[] = response.levels.map((level) => {
        const tiles = new Map<number, CompiledTile>()
        for (const [key, s] of level.tiles) tiles.set(key, serializedTileToLive(s))
        return { zoom: level.zoom, tiles }
      })
      return Promise.resolve({
        parts: response.parts,
        tileSet: {
          levels,
          bounds: response.bounds,
          featureCount: response.featureCount,
          propertyTable: response.propertyTable,
        },
      })
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  /** Terminate all workers and reject any in-flight jobs. */
  dispose(): void {
    for (const w of this.workers) w.terminate()
    this.workers.length = 0
    for (const { reject } of this.pending.values()) {
      reject(new Error('worker pool disposed'))
    }
    this.pending.clear()
  }
}

/** Shared pool singleton — lazily created on first access. */
let sharedPool: GeoJSONCompilePool | null = null
export function getSharedGeoJSONCompilePool(): GeoJSONCompilePool {
  if (!sharedPool) sharedPool = new GeoJSONCompilePool()
  return sharedPool
}
