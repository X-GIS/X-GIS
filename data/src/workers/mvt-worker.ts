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

import { decomposeFeatures, compileSingleTile, type GeoJSONFeature } from '@xgis/compiler'
import { decodeMvtTile } from '../mvt-decoder'
import { buildLineSegments } from '../line-segment-build'
import { buildPointFeatureIds } from '../point-feature-patch'
import { sliceFilterAccepts } from '../eval/filter-eval'
import {
  extractFeatureHeights,
  extractFeatureWidths,
  extractFeatureColors,
} from '../eval/feature-expr-extract'

/** Build the featId → properties Map the SDF label pipeline + data-driven
 *  feature buffer read from. When `keys` is non-empty, clone ONLY those
 *  keys per feature — the union of the label text-field + the variant's
 *  match/interpolate fields, a handful out of OFM's name/name:en/…/class/
 *  rank/… bag. Filtering here is the whole point: the returned Map is
 *  structured-cloned worker→main and that clone is the dominant transition
 *  cost (309 ms/msg on Bright). An undefined / empty `keys` is the safe
 *  fallback (legacy non-showSlices path, or an un-introspectable label AST):
 *  keep the FULL Record so no consumer loses a field it references.
 *  Exported for direct unit testing of the filter contract. */
export function buildFeatureProps(
  features: GeoJSONFeature[],
  keys?: string[],
): Map<number, Record<string, unknown>> {
  const out = new Map<number, Record<string, unknown>>()
  if (keys && keys.length > 0) {
    for (let fi = 0; fi < features.length; fi++) {
      const props = features[fi]?.properties
      if (props) {
        const filtered: Record<string, unknown> = {}
        for (const k of keys) if (k in props) filtered[k] = (props as Record<string, unknown>)[k]
        out.set(fi, filtered)
      }
    }
  } else {
    for (let fi = 0; fi < features.length; fi++) {
      const props = features[fi]?.properties
      if (props) out.set(fi, props as Record<string, unknown>)
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
  /** Per-MVT-layer 3D-extrude BASE expression AST (Mapbox
   *  `fill-extrusion-base`). Same evaluation path as extrudeExprs;
   *  the result is the metres-z of the wall BOTTOM (default 0).
   *  Layers without an entry get every feature's base = 0. */
  extrudeBaseExprs?: Record<string, unknown>
  /** Per-show slice descriptors. Each entry says "produce a slice
   *  with this sliceKey, drawing only features from `sourceLayer`
   *  that pass `filterAst`". When undefined, the worker falls back to
   *  the legacy "one slice per MVT source layer" behaviour. With it,
   *  the worker bucket-splits each MVT layer's features by filter so
   *  every xgis show gets ITS subset — eliminating the redundant
   *  draws that result when N shows share one MVT source layer with
   *  different `filter:` clauses (the OSM-style demo's 6 landuse_*
   *  layers all reading `landuse`). */
  showSlices?: Array<{
    sliceKey: string
    sourceLayer: string
    filterAst: unknown | null
    needsFeatureProps?: boolean
    needsExtrude?: boolean
    featurePropKeys?: string[]
  }>
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
  /** PR 2f per-tile quantized-position dequant params for `vertices`. */
  dequantScale: number
  dequantHalf: number
  indices: ArrayBuffer
  lineVertices: ArrayBuffer
  lineIndices: ArrayBuffer
  pointVertices?: ArrayBuffer
  /** #1375 — Uint32Array buffer of one stable feature id per packed point, in
   *  `pointVertices` order. Absent when no point in the slice resolved one. */
  pointFeatureIds?: ArrayBuffer
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
  /** Companion to `heights` for Mapbox `fill-extrusion-base`. Wall
   *  bottom z (metres) per feature. Missing entries fall back to 0. */
  bases?: ReadonlyMap<number, number>
  /** featId → original feature properties bag. Populated by the
   *  worker so the SDF text label pipeline can resolve
   *  `label-["{.field}"]` per feature. PMTiles MVT properties land
   *  here directly — there's no global PropertyTable. Postmessage-
   *  friendly: plain object keys + primitive values only. */
  featureProps?: ReadonlyMap<number, Record<string, unknown>>
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

const onMessage = (e: MessageEvent<InMsg>): void => {
  const msg = e.data
  if (msg.kind !== 'compile-mvt') return

  try {
    const features = decodeMvtTile(new Uint8Array(msg.bytes), msg.z, msg.x, msg.y, {
      layers: msg.layers,
    })
    if (features.length === 0) {
      ;(self as unknown as { postMessage: (m: OutMsg) => void }).postMessage({
        kind: 'compile-done',
        taskId: msg.taskId,
        slices: [],
      })
      return
    }

    // Group features by their `_layer` property — added by
    // decodeMvtTile per-feature. A feature without `_layer` (legacy
    // input) goes into a special '' bucket so it still renders.
    const byLayer = new Map<string, GeoJSONFeature[]>()
    for (const f of features) {
      const ln = (f.properties?._layer as string) ?? ''
      let bucket = byLayer.get(ln)
      if (!bucket) {
        bucket = []
        byLayer.set(ln, bucket)
      }
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
      needsFeatureProps: boolean,
      needsExtrude: boolean,
      featurePropKeys?: string[],
    ): void => {
      if (sourceFeatures.length === 0) return
      const parts = decomposeFeatures(sourceFeatures)
      const tile = compileSingleTile(parts, msg.z, msg.x, msg.y, msg.maxZoom)
      if (!tile) return
      // featureProps for the SDF text label pipeline + data-driven feature
      // buffer. Skip emission for slices whose consumer shows read no per-
      // feature attributes (the structured-clone of the Map worker→main is
      // the dominant cost — 309 ms/message on Bright transitions). When
      // populated, `featurePropKeys` (always set on the showSlices path)
      // restricts the clone to just the consumed fields — see
      // buildFeatureProps. Empty Map → `featureProps: undefined` below.
      const featureProps = needsFeatureProps
        ? buildFeatureProps(sourceFeatures, featurePropKeys)
        : new Map<number, Record<string, unknown>>()
      // Same skip for extrude data — only populate when ANY show on
      // this slice declared `fill-extrusion-height-…`.
      const heights = needsExtrude
        ? extractFeatureHeights(sourceFeatures, msg.extrudeExprs?.[sourceLayer], msg.z)
        : new Map<number, number>()
      const bases = needsExtrude
        ? extractFeatureHeights(sourceFeatures, msg.extrudeBaseExprs?.[sourceLayer], msg.z)
        : new Map<number, number>()
      // Per-feature stroke widths / colours — keyed by sliceKey
      // because the compound layer's match() targets a specific
      // compound, not a raw source layer (multiple compounds can
      // share one source).
      const widths = extractFeatureWidths(sourceFeatures, msg.strokeWidthExprs?.[sliceKey], msg.z)
      const colors = extractFeatureColors(sourceFeatures, msg.strokeColorExprs?.[sliceKey], msg.z)
      let prebuiltOutlineSegments: ArrayBuffer | undefined
      let prebuiltLineSegments: ArrayBuffer | undefined
      if (
        tile.outlineVertices &&
        tile.outlineVertices.length > 0 &&
        tile.outlineLineIndices &&
        tile.outlineLineIndices.length > 0
      ) {
        const seg = buildLineSegments(
          tile.outlineVertices,
          tile.outlineLineIndices,
          10,
          tile.tileOriginMerc,
          msg.tileWidthMerc,
          msg.tileHeightMerc,
          heights.size > 0 ? heights : undefined,
          widths.size > 0 ? widths : undefined,
          colors.size > 0 ? colors : undefined,
          0,
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
          tile.lineVertices,
          tile.lineIndices,
          lineStride,
          tile.tileOriginMerc,
          msg.tileWidthMerc,
          msg.tileHeightMerc,
          heights.size > 0 ? heights : undefined,
          widths.size > 0 ? widths : undefined,
          colors.size > 0 ? colors : undefined,
          0,
        )
        prebuiltLineSegments = seg.buffer as ArrayBuffer
      }
      // #1375 — the stable-id side-car for the packed points, resolved from
      // the SAME `sourceFeatures` array the packed `fid` slot indexes into, so
      // an id can never drift away from the geometry it names.
      const pointFeatureIds = buildPointFeatureIds(sourceFeatures, tile.pointVertices)
      const slice: MvtCompileSlice = {
        layerName: sliceKey,
        vertices: tile.vertices.buffer as ArrayBuffer,
        dequantScale: tile.dequantScale,
        dequantHalf: tile.dequantHalf,
        indices: tile.indices.buffer as ArrayBuffer,
        lineVertices: tile.lineVertices.buffer as ArrayBuffer,
        lineIndices: tile.lineIndices.buffer as ArrayBuffer,
        pointVertices: tile.pointVertices?.buffer as ArrayBuffer | undefined,
        pointFeatureIds: pointFeatureIds?.buffer as ArrayBuffer | undefined,
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- ABI passthrough of the retired field (see SerializedTile)
        outlineIndices: tile.outlineIndices?.buffer as ArrayBuffer | undefined,
        outlineVertices: tile.outlineVertices?.buffer as ArrayBuffer | undefined,
        outlineLineIndices: tile.outlineLineIndices?.buffer as ArrayBuffer | undefined,
        prebuiltLineSegments,
        prebuiltOutlineSegments,
        polygons: tile.polygons?.map((p) => ({ rings: p.rings, featId: p.featId })),
        heights: heights.size > 0 ? heights : undefined,
        bases: bases.size > 0 ? bases : undefined,
        featureProps: featureProps.size > 0 ? featureProps : undefined,
        fullCover: tile.fullCover ?? false,
        fullCoverFeatureId: tile.fullCoverFeatureId ?? 0,
      }
      slices.push(slice)
      transferables.push(slice.vertices, slice.indices, slice.lineVertices, slice.lineIndices)
      if (slice.pointVertices) transferables.push(slice.pointVertices)
      if (slice.pointFeatureIds) transferables.push(slice.pointFeatureIds)
      if (slice.outlineIndices) transferables.push(slice.outlineIndices)
      if (slice.outlineVertices) transferables.push(slice.outlineVertices)
      if (slice.outlineLineIndices) transferables.push(slice.outlineLineIndices)
      if (slice.prebuiltLineSegments) transferables.push(slice.prebuiltLineSegments)
      if (slice.prebuiltOutlineSegments) transferables.push(slice.prebuiltOutlineSegments)
    }

    if (msg.showSlices && msg.showSlices.length > 0) {
      // Pre-bucket path: one slice per UNIQUE (sourceLayer, filter)
      // combo. Per-slice `needsFeatureProps` / `needsExtrude` flags
      // gate the heaviest non-transferable fields — see emitSlice
      // for the structured-clone-cost rationale.
      for (const desc of msg.showSlices) {
        const layerFeatures = byLayer.get(desc.sourceLayer)
        if (!layerFeatures || layerFeatures.length === 0) continue
        const subset = desc.filterAst
          ? layerFeatures.filter((f) => sliceFilterAccepts(desc.filterAst, f, msg.z))
          : layerFeatures
        emitSlice(
          desc.sliceKey,
          desc.sourceLayer,
          subset,
          desc.needsFeatureProps === true,
          desc.needsExtrude === true,
          desc.featurePropKeys,
        )
      }
    } else {
      // Legacy path: one slice per MVT source layer, no filter
      // bucketing. No slice descriptor → no featurePropKeys, so
      // featureProps stays UNFILTERED (full Record) for back-compat.
      // Callers that opt into showSlices get the field-filter savings.
      for (const [layerName, layerFeatures] of byLayer) {
        emitSlice(layerName, layerName, layerFeatures, true, true)
      }
    }

    ;(self as unknown as { postMessage: (m: OutMsg, t?: Transferable[]) => void }).postMessage(
      { kind: 'compile-done', taskId: msg.taskId, slices },
      transferables.filter((b) => b.byteLength > 0),
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
}

// Gate on DedicatedWorkerGlobalScope (mirrors geojson-compile-worker.ts) so
// this module can be imported by unit tests — which need buildFeatureProps /
// the message types — without `self` being defined or a stray listener
// registering on the test global.
const isWorkerScope =
  typeof self !== 'undefined' &&
  typeof (self as unknown as { importScripts?: unknown }).importScripts !== 'undefined'

if (isWorkerScope) {
  self.addEventListener('message', onMessage)
}
