// VirtualPMTilesBackend — serves GeoJSON-derived tiles through the
// same TileSource interface PMTilesBackend uses. After
// construction the backend asks the GeoJSON tiling worker to build
// an in-memory geojsonvt index, then per-tile fetches go:
//
//   loadTile(key) → tilingPool.getTile() → PBF Uint8Array
//                 → mvtPool.compile()    → MvtCompileSlice[]
//                 → sink.acceptResult(key, slice, layerName)
//
// The downstream half (mvtPool.compile + acceptResult) is byte-
// identical to PMTilesBackend's pipeline. The only difference is
// upstream: instead of HTTP fetching from a remote archive, the
// bytes come from our own tiling worker. GeoJSON sources therefore
// inherit every fix the PMTiles path has accumulated (paced
// compile, per-layer slices, extrude / stroke-width per-feature
// bakes, etc.) without a separate runtime backend.

import {
  tileKeyUnpack,
  decodeMvtTile, decomposeFeatures, compileSingleTile,
  type GeoJSONFeature, type GeoJSONVTOptions,
} from '@xgis/compiler'
import * as tilingPool from '../workers/geojson-tiling-pool'
import { getSharedMvtPool, type MvtWorkerPool } from '../workers/mvt-worker-pool'
import { buildLineSegments } from '../../core/line-segment-build'
import type { BackendTileResult, TileSource, TileSourceMeta, TileSourceSink } from '../tile-source'

export interface VirtualPMTilesBackendOptions {
  /** Logical source name — used as the MVT layer name when no
   *  `sourceLayer:` filter is set on the consuming xgis layer, and
   *  as the key inside the tiling worker's index map. */
  sourceName: string
  /** Parsed GeoJSON object (FeatureCollection / Feature / single
   *  geometry — anything geojsonvt's `convert` accepts). */
  geojson: unknown
  /** Bounds for the source's data. Falls back to world-bounds when
   *  unset; the catalog's bbox-of-attached-sources picks this up. */
  bounds?: [number, number, number, number]
  /** Override the geojsonvt indexer's options (extent, buffer,
   *  tolerance, maxZoom, indexMaxZoom, etc.). Defaults are
   *  MapLibre-style values from @xgis/compiler. */
  geojsonvtOptions?: Partial<GeoJSONVTOptions>
  /** MVT layer name allow-list — passed through to the MVT worker's
   *  decode step. Usually unset for GeoJSON (only one layer per
   *  source) but mirroring the PMTiles backend's signature keeps
   *  the catalog-side dispatch uniform. */
  layers?: string[]
  /** Per-MVT-layer 3D extrude expression AST (same shape as the
   *  PMTiles backend takes). */
  extrudeExprs?: Record<string, unknown>
  extrudeBaseExprs?: Record<string, unknown>
  /** Per-show slice descriptors — when set the MVT worker emits one
   *  pre-filtered slice per (sourceLayer, filter) combo. Mirrors
   *  PMTilesBackend.options.showSlices. */
  showSlices?: Array<{ sliceKey: string; sourceLayer: string; filterAst: unknown | null; needsFeatureProps?: boolean; needsExtrude?: boolean }>
  /** Per-sliceKey stroke-width / colour override ASTs (compiler-
   *  synthesised by the layer-merge pass). */
  strokeWidthExprs?: Record<string, unknown>
  strokeColorExprs?: Record<string, unknown>
}

const WORLD_BOUNDS: [number, number, number, number] = [-180, -85, 180, 85]

export class VirtualPMTilesBackend implements TileSource {
  readonly meta: TileSourceMeta
  private sink: TileSourceSink | null = null
  private indexReady: Promise<void>

  private readonly sourceName: string
  private readonly layers?: string[]
  private readonly extrudeExprs?: Record<string, unknown>
  private readonly extrudeBaseExprs?: Record<string, unknown>
  private readonly showSlices?: VirtualPMTilesBackendOptions['showSlices']
  private readonly strokeWidthExprs?: Record<string, unknown>
  private readonly strokeColorExprs?: Record<string, unknown>
  private readonly geojsonvtOptions: Partial<GeoJSONVTOptions>

  constructor(opts: VirtualPMTilesBackendOptions) {
    this.sourceName = opts.sourceName
    this.layers = opts.layers
    this.extrudeExprs = opts.extrudeExprs
    this.extrudeBaseExprs = opts.extrudeBaseExprs
    this.showSlices = opts.showSlices
    this.strokeWidthExprs = opts.strokeWidthExprs
    this.strokeColorExprs = opts.strokeColorExprs
    this.geojsonvtOptions = opts.geojsonvtOptions ?? {}

    const maxZoom = this.geojsonvtOptions.maxZoom ?? 14
    this.meta = {
      bounds: opts.bounds ?? WORLD_BOUNDS,
      minZoom: 0,
      maxZoom,
    }

    // Kick off the worker-side index build immediately. loadTile()
    // chains on this promise; for sub-MB GeoJSON files the index
    // completes in tens of ms so by the first tile request the
    // worker is usually ready.
    this.indexReady = tilingPool.setSource(
      this.sourceName, opts.geojson, this.geojsonvtOptions,
    )
  }

  has(key: number): boolean {
    const [z] = tileKeyUnpack(key)
    return z <= this.meta.maxZoom
  }

  attach(sink: TileSourceSink): void {
    this.sink = sink
  }

  loadTile(key: number): void {
    if (!this.sink) return
    if (this.sink.hasTileData(key)) return
    const sink = this.sink
    sink.trackLoading(key)

    this.indexReady
      .then(() => this.fetchAndCompile(key, sink))
      .catch(err => {
        console.error('[virtual-pmtiles fetch]', (err as Error)?.stack ?? err)
        sink.acceptResult(key, null)
        sink.releaseLoading(key)
      })
  }

  detach(): void {
    this.sink = null
  }

  /** Per-tile fetch + compile. Pulls PBF bytes from the tiling
   *  worker, hands them to the MVT compile worker pool, and pushes
   *  every resulting slice through the catalog sink. */
  private async fetchAndCompile(key: number, sink: TileSourceSink): Promise<void> {
    const [z, x, y] = tileKeyUnpack(key)
    let bytes: Uint8Array
    try {
      bytes = await tilingPool.getTile(this.sourceName, z, x, y, key)
    } catch (err) {
      console.error('[virtual-pmtiles getTile]', (err as Error)?.stack ?? err)
      sink.acceptResult(key, null)
      sink.releaseLoading(key)
      return
    }

    if (bytes.byteLength === 0) {
      // Empty tile — cache the empty placeholder so the renderer's
      // parent-walk stops re-requesting this key.
      sink.acceptResult(key, null)
      sink.releaseLoading(key)
      return
    }

    const { widthMerc, heightMerc } = tileSizeMerc(z, y)

    if (typeof Worker !== 'undefined') {
      try {
        const pool = this.getPool()
        const slices = await pool.compile(
          bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer,
          z, x, y, this.meta.maxZoom,
          widthMerc, heightMerc,
          this.layers,
          this.extrudeExprs,
          this.extrudeBaseExprs,
          this.showSlices,
          this.strokeWidthExprs,
          this.strokeColorExprs,
        )
        if (slices.length === 0) {
          sink.acceptResult(key, null)
        } else {
          for (const slice of slices) {
            sink.acceptResult(key, sliceToBackendResult(slice), slice.layerName)
          }
        }
      } catch (err) {
        console.error('[virtual-pmtiles worker]', (err as Error)?.stack ?? err)
        sink.acceptResult(key, null)
      } finally {
        sink.releaseLoading(key)
      }
    } else {
      // Inline fallback for Worker-less environments (vitest, SSR).
      try {
        this.compileInline(key, bytes, z, x, y, widthMerc, heightMerc)
      } finally {
        sink.releaseLoading(key)
      }
    }
  }

  private compileInline(
    key: number, bytes: Uint8Array,
    z: number, x: number, y: number,
    widthMerc: number, heightMerc: number,
  ): void {
    if (!this.sink) return
    const sink = this.sink
    try {
      const features = decodeMvtTile(bytes, z, x, y, { layers: this.layers })
      if (features.length === 0) { sink.acceptResult(key, null); return }
      const byLayer = new Map<string, GeoJSONFeature[]>()
      for (const f of features) {
        const ln = (f.properties?._layer as string) ?? this.sourceName
        let bucket = byLayer.get(ln)
        if (!bucket) { bucket = []; byLayer.set(ln, bucket) }
        bucket.push(f)
      }
      let emitted = false
      for (const [layerName, layerFeatures] of byLayer) {
        const parts = decomposeFeatures(layerFeatures)
        const tile = compileSingleTile(parts, z, x, y, this.meta.maxZoom)
        if (!tile) continue
        const lineSegments = buildLineSegments(
          tile.lineVertices ?? new Float32Array(0),
          tile.lineIndices ?? new Uint32Array(0),
          10, widthMerc, heightMerc,
        )
        const outlineSegments = buildLineSegments(
          tile.outlineVertices ?? new Float32Array(0),
          tile.outlineLineIndices ?? new Uint32Array(0),
          10, widthMerc, heightMerc,
        )
        sink.acceptResult(key, {
          vertices: tile.vertices,
          indices: tile.indices,
          lineVertices: tile.lineVertices,
          lineIndices: tile.lineIndices,
          pointVertices: tile.pointVertices,
          outlineIndices: tile.outlineIndices,
          outlineVertices: tile.outlineVertices,
          outlineLineIndices: tile.outlineLineIndices,
          polygons: tile.polygons?.map(p => ({ rings: p.rings, featId: p.featId })),
          fullCover: tile.fullCover,
          fullCoverFeatureId: tile.fullCoverFeatureId,
          prebuiltLineSegments: lineSegments,
          prebuiltOutlineSegments: outlineSegments,
        }, layerName)
        emitted = true
      }
      if (!emitted) sink.acceptResult(key, null)
    } catch (err) {
      console.error('[virtual-pmtiles inline]', (err as Error)?.stack ?? err)
      sink.acceptResult(key, null)
    }
  }

  private _pool: MvtWorkerPool | null = null
  private getPool(): MvtWorkerPool {
    if (!this._pool) this._pool = getSharedMvtPool()
    return this._pool
  }
}

/** Direct field-by-field mapping between an MvtCompileSlice (the
 *  wire format) and a BackendTileResult (the sink's shape). */
function sliceToBackendResult(slice: {
  vertices: Float32Array; indices: Uint32Array
  lineVertices: Float32Array; lineIndices: Uint32Array
  pointVertices?: Float32Array
  outlineIndices?: Uint32Array; outlineVertices?: Float32Array; outlineLineIndices?: Uint32Array
  polygons?: unknown
  heights?: ReadonlyMap<number, number>
  bases?: ReadonlyMap<number, number>
  featureProps?: ReadonlyMap<number, Record<string, unknown>>
  fullCover: boolean
  fullCoverFeatureId: number
  prebuiltLineSegments?: Float32Array
  prebuiltOutlineSegments?: Float32Array
}): BackendTileResult {
  return {
    vertices: slice.vertices,
    indices: slice.indices,
    lineVertices: slice.lineVertices,
    lineIndices: slice.lineIndices,
    pointVertices: slice.pointVertices,
    outlineIndices: slice.outlineIndices,
    outlineVertices: slice.outlineVertices,
    outlineLineIndices: slice.outlineLineIndices,
    polygons: slice.polygons as BackendTileResult['polygons'],
    heights: slice.heights,
    bases: slice.bases,
    featureProps: slice.featureProps,
    fullCover: slice.fullCover,
    fullCoverFeatureId: slice.fullCoverFeatureId,
    prebuiltLineSegments: slice.prebuiltLineSegments,
    prebuiltOutlineSegments: slice.prebuiltOutlineSegments,
  }
}

/** Tile dimensions in Mercator metres — copy of the same helper
 *  PMTilesBackend uses. The MVT worker needs these to detect tile-
 *  edge boundary vertices during line segment construction. */
function tileSizeMerc(z: number, y: number): { widthMerc: number; heightMerc: number } {
  const DEG2RAD = Math.PI / 180
  const R = 6378137
  const LAT_LIMIT = 85.051129
  const clamp = (v: number) => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, v))
  const n = 1 << z
  const widthMerc = (360 / n) * DEG2RAD * R
  const yToLat = (yt: number) => {
    const s = Math.PI - 2 * Math.PI * (yt / n)
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(s) - Math.exp(-s)))
  }
  const latNorth = yToLat(y)
  const latSouth = yToLat(y + 1)
  const myNorth = Math.log(Math.tan(Math.PI / 4 + clamp(latNorth) * DEG2RAD / 2)) * R
  const mySouth = Math.log(Math.tan(Math.PI / 4 + clamp(latSouth) * DEG2RAD / 2)) * R
  return { widthMerc, heightMerc: myNorth - mySouth }
}
