// MVT compile worker — runs the heavy PMTiles tile pipeline off the
// main thread. Splits features by MVT `_layer` so a single source
// can serve multiple xgis layers (each with its own `sourceLayer`)
// from independently-compiled per-layer slices.
//
// Pipeline:
//   bytes (raw MVT) → decodeMvtTile (pbf decode + un-quantise lon/lat)
//                  → groupBy(_layer)
//   for each (layerName, features):
//     decomposeFeatures (project to MM, build GeometryParts)
//     compileSingleTile (clip + simplify + earcut + DSFUN pack)
//     buildLineSegments × 2 (outline + line)
//     emit one slice
//
// Returns an array of slices, each with its own typed-array buffers
// + prebuilt segment buffers, all marked Transferable.

import {
  decodeMvtTile, decomposeFeatures, compileSingleTile,
  type GeoJSONFeature,
} from '@xgis/compiler'
import { buildLineSegments } from '../engine/line-segment-build'
import { evalExtrudeExpr } from './extrude-eval'

/** Extract per-feature 3D extrude heights from a layer's features.
 *  With `expr` set, evaluates the AST against each feature's
 *  properties (any compiler expression — `.height`, `.levels * 3.5`,
 *  `max(.height, 20)`, `clamp(.h, 5, 200)`, etc.). Without it, falls
 *  back to the protomaps default of `render_height ?? height`.
 *  Non-finite / non-positive / non-numeric results are filtered by
 *  evalExtrudeExpr → those features get the layer's fallback height
 *  at upload time. */
function extractFeatureHeights(
  features: GeoJSONFeature[],
  expr?: unknown,
): Map<number, number> {
  const out = new Map<number, number>()
  for (let i = 0; i < features.length; i++) {
    const props = features[i].properties
    if (!props) continue
    if (expr) {
      const v = evalExtrudeExpr(expr, props as Record<string, unknown>)
      if (v !== null) out.set(i, v)
    } else {
      const r = (props as { render_height?: unknown; height?: unknown }).render_height
        ?? (props as { height?: unknown }).height
      if (typeof r === 'number' && Number.isFinite(r) && r > 0) out.set(i, r)
    }
  }
  return out
}

// ── Message protocol ──

export interface MvtCompileRequest {
  kind: 'compile-mvt'
  taskId: number
  bytes: ArrayBuffer
  z: number
  x: number
  y: number
  /** Compiler simplification cap (header.maxZoom of the archive) */
  maxZoom: number
  /** MVT layer name allow-list (decoder filters before decompose).
   *  Undefined → all layers are decoded and emitted as separate
   *  slices. Empty array behaves the same as undefined. */
  layers?: string[]
  /** Tile size in Mercator metres (precomputed by the dispatcher to
   *  avoid redoing the projection inside the worker). */
  tileWidthMerc: number
  tileHeightMerc: number
  /** Per-MVT-layer 3D-extrude expression AST. Evaluated against each
   *  feature's properties via miniEval to compute that feature's
   *  height in metres. Layers without an entry use the worker's
   *  default extraction (`render_height ?? height`). */
  extrudeExprs?: Record<string, unknown>
}

/** One per-MVT-layer slice in the response. */
export interface MvtCompileSlice {
  layerName: string
  vertices: ArrayBuffer
  indices: ArrayBuffer
  lineVertices: ArrayBuffer
  lineIndices: ArrayBuffer
  pointVertices?: ArrayBuffer
  outlineIndices?: ArrayBuffer
  outlineVertices?: ArrayBuffer
  outlineLineIndices?: ArrayBuffer
  prebuiltLineSegments?: ArrayBuffer
  prebuiltOutlineSegments?: ArrayBuffer
  polygons?: { rings: number[][][]; featId: number }[]
  /** featId → extrude height in metres. Populated only for layers
   *  whose features carry a `height` (or `render_height`) property —
   *  primarily protomaps `buildings`. The runtime branches the
   *  upload path onto the extruded fill pipeline when this is set
   *  and non-empty. Empty Map = no per-feature data; let the layer's
   *  default (e.g. style-set) extrude height apply uniformly. */
  heights?: ReadonlyMap<number, number>
  fullCover: boolean
  fullCoverFeatureId: number
}

export interface MvtCompileResponse {
  kind: 'compile-done'
  taskId: number
  /** Per-MVT-layer slices. Empty array when the archive returned
   *  no features for this key. */
  slices: MvtCompileSlice[]
}

export interface MvtCompileError {
  kind: 'compile-error'
  taskId: number
  message: string
  stack?: string
}

type InMsg = MvtCompileRequest
type OutMsg = MvtCompileResponse | MvtCompileError

// ── Worker entry ──

self.addEventListener('message', (e: MessageEvent<InMsg>) => {
  const msg = e.data
  if (msg.kind !== 'compile-mvt') return

  try {
    const features = decodeMvtTile(
      new Uint8Array(msg.bytes), msg.z, msg.x, msg.y,
      { layers: msg.layers },
    )
    if (features.length === 0) {
      ;(self as unknown as { postMessage: (m: OutMsg) => void })
        .postMessage({ kind: 'compile-done', taskId: msg.taskId, slices: [] })
      return
    }

    // Group features by their `_layer` property — added by
    // decodeMvtTile per-feature. A feature without `_layer` (legacy
    // input) goes into a special '' bucket so it still renders.
    const byLayer = new Map<string, GeoJSONFeature[]>()
    for (const f of features) {
      const ln = (f.properties?._layer as string) ?? ''
      let bucket = byLayer.get(ln)
      if (!bucket) { bucket = []; byLayer.set(ln, bucket) }
      bucket.push(f)
    }

    const slices: MvtCompileSlice[] = []
    const transferables: ArrayBuffer[] = []

    for (const [layerName, layerFeatures] of byLayer) {
      const parts = decomposeFeatures(layerFeatures)
      const tile = compileSingleTile(parts, msg.z, msg.x, msg.y, msg.maxZoom)
      if (!tile) continue

      // Build featId→height first so the segment builder can bake
      // per-segment z lift into the outline buffer for extruded
      // layers. protomaps `buildings` uses `render_height` (rounded
      // for rendering) and `height` (raw); custom expressions land
      // here via `msg.extrudeExprs`. Layers without any height data
      // produce an empty Map → segment z stays at 0 (ground).
      const heights = extractFeatureHeights(layerFeatures, msg.extrudeExprs?.[layerName])

      let prebuiltOutlineSegments: ArrayBuffer | undefined
      let prebuiltLineSegments: ArrayBuffer | undefined
      if (tile.outlineVertices && tile.outlineVertices.length > 0
          && tile.outlineLineIndices && tile.outlineLineIndices.length > 0) {
        const seg = buildLineSegments(
          tile.outlineVertices, tile.outlineLineIndices, 10,
          msg.tileWidthMerc, msg.tileHeightMerc,
          heights.size > 0 ? heights : undefined,
        )
        prebuiltOutlineSegments = seg.buffer as ArrayBuffer
      }
      if (tile.lineIndices.length > 0 && tile.lineVertices.length > 0) {
        let lineStride: 6 | 10 = 6
        let maxIdx = 0
        for (let li = 0; li < tile.lineIndices.length; li++) {
          if (tile.lineIndices[li] > maxIdx) maxIdx = tile.lineIndices[li]
        }
        const vertCount = maxIdx + 1
        if (vertCount > 0 && tile.lineVertices.length / vertCount >= 10) lineStride = 10
        const seg = buildLineSegments(
          tile.lineVertices, tile.lineIndices, lineStride,
          msg.tileWidthMerc, msg.tileHeightMerc,
          heights.size > 0 ? heights : undefined,
        )
        prebuiltLineSegments = seg.buffer as ArrayBuffer
      }
      const slice: MvtCompileSlice = {
        layerName,
        vertices: tile.vertices.buffer as ArrayBuffer,
        indices: tile.indices.buffer as ArrayBuffer,
        lineVertices: tile.lineVertices.buffer as ArrayBuffer,
        lineIndices: tile.lineIndices.buffer as ArrayBuffer,
        pointVertices: tile.pointVertices?.buffer as ArrayBuffer | undefined,
        outlineIndices: tile.outlineIndices?.buffer as ArrayBuffer | undefined,
        outlineVertices: tile.outlineVertices?.buffer as ArrayBuffer | undefined,
        outlineLineIndices: tile.outlineLineIndices?.buffer as ArrayBuffer | undefined,
        prebuiltLineSegments,
        prebuiltOutlineSegments,
        polygons: tile.polygons?.map(p => ({ rings: p.rings, featId: p.featId })),
        heights: heights.size > 0 ? heights : undefined,
        fullCover: tile.fullCover ?? false,
        fullCoverFeatureId: tile.fullCoverFeatureId ?? 0,
      }
      slices.push(slice)

      transferables.push(slice.vertices, slice.indices, slice.lineVertices, slice.lineIndices)
      if (slice.pointVertices) transferables.push(slice.pointVertices)
      if (slice.outlineIndices) transferables.push(slice.outlineIndices)
      if (slice.outlineVertices) transferables.push(slice.outlineVertices)
      if (slice.outlineLineIndices) transferables.push(slice.outlineLineIndices)
      if (slice.prebuiltLineSegments) transferables.push(slice.prebuiltLineSegments)
      if (slice.prebuiltOutlineSegments) transferables.push(slice.prebuiltOutlineSegments)
    }

    ;(self as unknown as { postMessage: (m: OutMsg, t?: Transferable[]) => void })
      .postMessage(
        { kind: 'compile-done', taskId: msg.taskId, slices },
        transferables.filter(b => b.byteLength > 0),
      )
  } catch (err) {
    const e = err as Error
    ;(self as unknown as { postMessage: (m: OutMsg) => void }).postMessage({
      kind: 'compile-error',
      taskId: msg.taskId,
      message: e.message || String(err),
      stack: e.stack,
    })
  }
})
