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
  evaluate,
  type GeoJSONFeature,
} from '@xgis/compiler'
import { buildLineSegments } from '../engine/line-segment-build'
import { evalExtrudeExpr } from './extrude-eval'
import { evalFilterExpr } from './filter-eval'

/** Extract per-feature 3D extrude heights from a layer's features.
 *  Only runs when the style explicitly opts in via `extrude:` (the
 *  AST is passed in as `expr`). Layers without an extrude directive
 *  return an empty Map — the previous "auto-detect render_height /
 *  height" fallback was removed because protomaps puts those fields
 *  on bridges, overpasses, POIs, etc., which then accidentally got
 *  lifted off the ground. Why: explicit > implicit. How to apply:
 *  if a style wants buildings extruded, it must say `extrude: .height`. */
function extractFeatureHeights(
  features: GeoJSONFeature[],
  expr: unknown,
): Map<number, number> {
  const out = new Map<number, number>()
  if (!expr) return out
  for (let i = 0; i < features.length; i++) {
    const props = features[i].properties
    if (!props) continue
    const v = evalExtrudeExpr(expr, props as Record<string, unknown>)
    if (v !== null) out.set(i, v)
  }
  return out
}

/** Extract per-feature stroke widths in pixels from a layer's
 *  features when the compound mergeLayers pass synthesized a
 *  width-by-match expression. Returns an empty Map when no expression
 *  is provided (the line shader's layer uniform width_px wins). */
function extractFeatureWidths(
  features: GeoJSONFeature[],
  expr: unknown,
): Map<number, number> {
  const out = new Map<number, number>()
  if (!expr) return out
  for (let i = 0; i < features.length; i++) {
    const props = features[i].properties
    if (!props) continue
    const v = evaluate(expr as never, props as Record<string, unknown>)
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out.set(i, v)
  }
  return out
}

/** Extract per-feature stroke colours, packed RGBA8 → u32. Returned
 *  Map's value is the packed u32 representation (LSB = R, MSB = A);
 *  buildLineSegments writes it into the segment buffer at offset 18
 *  (treated as u32 via a Uint32Array view). The shader unpacks with
 *  `unpack4x8unorm`. Alpha = 0 means "no override — fall through to
 *  the layer-uniform colour".
 *
 *  The expression is a compiler-synthesised `match(.field) { value
 *  -> #rrggbbaa, ..., _ -> #00000000 }`. The default arm packs to
 *  alpha=0 so unmatched features safely fall through. */
function extractFeatureColors(
  features: GeoJSONFeature[],
  expr: unknown,
): Map<number, number> {
  const out = new Map<number, number>()
  if (!expr) return out
  for (let i = 0; i < features.length; i++) {
    const props = features[i].properties
    if (!props) continue
    const v = evaluate(expr as never, props as Record<string, unknown>)
    // Color expressions resolve to a vec4 in shader; in JS via
    // evaluate() they come back as either an integer (vec4 packed
    // into a number) or a string '#rrggbbaa'. Match arms in
    // mergeLayers emit hex strings.
    if (typeof v === 'string' && v.startsWith('#') && (v.length === 7 || v.length === 9)) {
      const r = parseInt(v.slice(1, 3), 16)
      const g = parseInt(v.slice(3, 5), 16)
      const b = parseInt(v.slice(5, 7), 16)
      const a = v.length === 9 ? parseInt(v.slice(7, 9), 16) : 255
      if (a > 0) {
        // Little-endian: low byte = R, high byte = A. Matches
        // WGSL's `unpack4x8unorm` which reads byte 0 → .x (= R).
        out.set(i, (r | (g << 8) | (b << 16) | (a << 24)) >>> 0)
      }
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
  /** Per-show slice descriptors. Each entry says "produce a slice
   *  with this sliceKey, drawing only features from `sourceLayer`
   *  that pass `filterAst`". When undefined, the worker falls back to
   *  the legacy "one slice per MVT source layer" behaviour. With it,
   *  the worker bucket-splits each MVT layer's features by filter so
   *  every xgis show gets ITS subset — eliminating the redundant
   *  draws that result when N shows share one MVT source layer with
   *  different `filter:` clauses (the OSM-style demo's 6 landuse_*
   *  layers all reading `landuse`). */
  showSlices?: Array<{ sliceKey: string; sourceLayer: string; filterAst: unknown | null }>
  /** Per-sliceKey stroke-width override AST. The compound layer's
   *  width AST evaluated per feature → resolved width baked into the
   *  line segment buffer's per-segment slot so the line shader picks
   *  it up without per-frame uniform updates. */
  strokeWidthExprs?: Record<string, unknown>
  /** Per-sliceKey stroke-colour override AST. Same path as width:
   *  worker resolves per feature into RGBA8 packed u32, written
   *  into segment buffer for shader unpack. */
  strokeColorExprs?: Record<string, unknown>
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

    // Compile a feature subset for `sourceLayer` into a slice keyed
    // under `sliceKey`. Factored out so the legacy "one slice per
    // MVT layer" path AND the new pre-bucketed "one slice per
    // (sourceLayer, filter) combo" path share the heavy lifting.
    const emitSlice = (
      sliceKey: string,
      sourceLayer: string,
      sourceFeatures: GeoJSONFeature[],
    ): void => {
      if (sourceFeatures.length === 0) return
      const parts = decomposeFeatures(sourceFeatures)
      const tile = compileSingleTile(parts, msg.z, msg.x, msg.y, msg.maxZoom)
      if (!tile) return
      const heights = extractFeatureHeights(sourceFeatures, msg.extrudeExprs?.[sourceLayer])
      // Per-feature stroke widths / colours — keyed by sliceKey
      // because the compound layer's match() targets a specific
      // compound, not a raw source layer (multiple compounds can
      // share one source).
      const widths = extractFeatureWidths(sourceFeatures, msg.strokeWidthExprs?.[sliceKey])
      const colors = extractFeatureColors(sourceFeatures, msg.strokeColorExprs?.[sliceKey])
      let prebuiltOutlineSegments: ArrayBuffer | undefined
      let prebuiltLineSegments: ArrayBuffer | undefined
      if (tile.outlineVertices && tile.outlineVertices.length > 0
          && tile.outlineLineIndices && tile.outlineLineIndices.length > 0) {
        const seg = buildLineSegments(
          tile.outlineVertices, tile.outlineLineIndices, 10,
          msg.tileWidthMerc, msg.tileHeightMerc,
          heights.size > 0 ? heights : undefined,
          widths.size > 0 ? widths : undefined,
          colors.size > 0 ? colors : undefined,
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
          widths.size > 0 ? widths : undefined,
          colors.size > 0 ? colors : undefined,
        )
        prebuiltLineSegments = seg.buffer as ArrayBuffer
      }
      const slice: MvtCompileSlice = {
        layerName: sliceKey,
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

    if (msg.showSlices && msg.showSlices.length > 0) {
      // Pre-bucket path: one slice per UNIQUE (sourceLayer, filter)
      // combo. Multiple xgis shows that share the same sliceKey
      // (e.g. same filter on the same source layer) reuse one slice
      // — the catalog stores by sliceKey, not by show identity.
      for (const desc of msg.showSlices) {
        const layerFeatures = byLayer.get(desc.sourceLayer)
        if (!layerFeatures || layerFeatures.length === 0) continue
        const subset = desc.filterAst
          ? layerFeatures.filter(f => evalFilterExpr(desc.filterAst, f.properties ?? {}))
          : layerFeatures
        emitSlice(desc.sliceKey, desc.sourceLayer, subset)
      }
    } else {
      // Legacy path: one slice per MVT source layer, no filter
      // bucketing. Preserves behaviour for callers that don't pass
      // `showSlices` (xgvt-binary, tests).
      for (const [layerName, layerFeatures] of byLayer) {
        emitSlice(layerName, layerName, layerFeatures)
      }
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
