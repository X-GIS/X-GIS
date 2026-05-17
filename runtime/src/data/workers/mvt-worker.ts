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
  evaluate, makeEvalProps,
  type GeoJSONFeature,
} from '@xgis/compiler'
import { buildLineSegments } from '../../core/line-segment-build'
import { evalExtrudeExpr } from '../eval/extrude-eval'
import { evalFilterExpr } from '../eval/filter-eval'

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
  tileZoom: number,
): Map<number, number> {
  const out = new Map<number, number>()
  if (!expr) return out
  // Per-feature height — only set when the expression evaluates to
  // a usable numeric value. Features whose property is missing /
  // null / non-finite are LEFT OUT of the map; downstream consumers
  // (polygon-mesh + line-segment-build) treat their absence as
  // "no extrusion" and render the feature flat at z=0. This means
  // the language stays in control of the 3D decision: a style that
  // wants buildings without a `height` tag to extrude must say so
  // explicitly via `extrude: .height ?? 50` (or whatever default the
  // author wants). The engine doesn't fabricate a default.
  for (let i = 0; i < features.length; i++) {
    const f = features[i]
    // Properties-less features still resolve via the reserved keys
    // ($zoom / $geometryType / $featureId), so a geometry-type-only
    // or zoom-gated extrude expression evaluates cleanly against an
    // empty bag. Don't short-circuit on missing properties.
    const v = evalExtrudeExpr(
      expr,
      (f.properties ?? undefined) as Record<string, unknown> | undefined,
      tileZoom,
      f,
    )
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out.set(i, v)
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
  tileZoom: number,
): Map<number, number> {
  const out = new Map<number, number>()
  if (!expr) return out
  for (let i = 0; i < features.length; i++) {
    // Inject `$zoom` — the evaluator's RESERVED camera-zoom key
    // (evaluator.ts:33-38 looks up `props['$zoom']` for the `zoom`
    // identifier inside expressions like `interpolate_exp(zoom, …)`).
    // Pre-fix this used `zoom: tileZoom` which the evaluator silently
    // ignored — `props.$zoom` came back undefined, `toNumber(null)`
    // collapsed to 0, every interpolation evaluated to 0, and the
    // `v > 0` filter dropped every map entry. The runtime fell back
    // to the default 1 px layer-uniform width on every road. Visible
    // as hairline-thin OFM Bright highways.
    //
    // Tile zoom is a close-enough proxy for camera zoom — the user
    // has to be panning at an exact tile-zoom boundary for the
    // difference to be visible, and per-feature widths bake at tile-
    // decode time so camera-zoom tracking would require per-frame
    // segment-buffer re-upload (follow-up).
    //
    // Properties-less features (MVT/GeoJSON allows `null` properties)
    // still resolve via the reserved keys — `["==", ["geometry-type"],
    // "Polygon"]` and `interpolate(zoom, …)` are valid against an
    // empty props bag, so don't short-circuit on `!props`.
    const f = features[i]
    const v = evaluate(expr as never, makeEvalProps({
      props: (f.properties ?? undefined) as Record<string, unknown> | undefined,
      cameraZoom: tileZoom,
      geometryType: f.geometry?.type,
      featureId: (f as { id?: string | number }).id,
    }))
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
  tileZoom: number,
): Map<number, number> {
  const out = new Map<number, number>()
  if (!expr) return out
  for (let i = 0; i < features.length; i++) {
    // Inject reserved keys (`$zoom`, `$featureId`, `$geometryType`) via
    // makeEvalProps — matches the width path above. Pre-fix the raw
    // `props` bag meant any colour expression referencing `["zoom"]` /
    // `["geometry-type"]` / `["id"]` saw undefined for the reserved
    // identifier, evaluate() collapsed it to null, and the resolved
    // colour fell to the match's default arm (alpha=0 → "no override").
    // Per-feature colour-by-zoom and colour-by-id-class dispatched to
    // the layer-uniform fallback uniformly, dropping the per-feature
    // intent on the floor.
    // Properties-less features still get a clean eval against reserved
    // keys (e.g. colour-by-geometry-type or colour-by-zoom).
    const f = features[i]
    const v = evaluate(expr as never, makeEvalProps({
      props: (f.properties ?? undefined) as Record<string, unknown> | undefined,
      cameraZoom: tileZoom,
      geometryType: f.geometry?.type,
      featureId: (f as { id?: string | number }).id,
    }))
    // Color expressions resolve to a vec4 in shader; in JS via
    // evaluate() they come back as either an integer (vec4 packed
    // into a number) or a string '#rrggbbaa'. Match arms in
    // mergeLayers emit hex strings.
    if (typeof v === 'string' && v.startsWith('#')
        && (v.length === 4 || v.length === 5 || v.length === 7 || v.length === 9)) {
      // Accept all four CSS hex forms: #rgb / #rgba / #rrggbb / #rrggbbaa.
      // Pre-fix the short forms fell through the length gate and the
      // per-feature colour baking emitted nothing — match arms using
      // bare `#abc` or `#abcd` silently turned into the layer default.
      let r: number, g: number, b: number, a: number
      if (v.length === 4 || v.length === 5) {
        r = parseInt(v[1] + v[1], 16)
        g = parseInt(v[2] + v[2], 16)
        b = parseInt(v[3] + v[3], 16)
        a = v.length === 5 ? parseInt(v[4] + v[4], 16) : 255
      } else {
        r = parseInt(v.slice(1, 3), 16)
        g = parseInt(v.slice(3, 5), 16)
        b = parseInt(v.slice(5, 7), 16)
        a = v.length === 9 ? parseInt(v.slice(7, 9), 16) : 255
      }
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
  showSlices?: Array<{ sliceKey: string; sourceLayer: string; filterAst: unknown | null; needsFeatureProps?: boolean; needsExtrude?: boolean }>
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
      needsFeatureProps: boolean,
      needsExtrude: boolean,
    ): void => {
      if (sourceFeatures.length === 0) return
      const parts = decomposeFeatures(sourceFeatures)
      const tile = compileSingleTile(parts, msg.z, msg.x, msg.y, msg.maxZoom)
      if (!tile) return
      // featureProps for the SDF text label pipeline. Skip emission for
      // slices whose consumer shows have no `label-` utility — the
      // structured-clone of the Map across the worker→main boundary
      // is the dominant cost (309 ms/message on Bright transitions).
      // Empty Map → `featureProps: undefined` below.
      const featureProps = new Map<number, Record<string, unknown>>()
      if (needsFeatureProps) {
        for (let fi = 0; fi < sourceFeatures.length; fi++) {
          const props = sourceFeatures[fi]?.properties
          if (props) featureProps.set(fi, props as Record<string, unknown>)
        }
      }
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
      if (tile.outlineVertices && tile.outlineVertices.length > 0
          && tile.outlineLineIndices && tile.outlineLineIndices.length > 0) {
        const seg = buildLineSegments(
          tile.outlineVertices, tile.outlineLineIndices, 10,
          msg.tileWidthMerc, msg.tileHeightMerc,
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
          tile.lineVertices, tile.lineIndices, lineStride,
          msg.tileWidthMerc, msg.tileHeightMerc,
          heights.size > 0 ? heights : undefined,
          widths.size > 0 ? widths : undefined,
          colors.size > 0 ? colors : undefined,
          0,
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
        bases: bases.size > 0 ? bases : undefined,
        featureProps: featureProps.size > 0 ? featureProps : undefined,
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
      // combo. Per-slice `needsFeatureProps` / `needsExtrude` flags
      // gate the heaviest non-transferable fields — see emitSlice
      // for the structured-clone-cost rationale.
      for (const desc of msg.showSlices) {
        const layerFeatures = byLayer.get(desc.sourceLayer)
        if (!layerFeatures || layerFeatures.length === 0) continue
        const subset = desc.filterAst
          ? layerFeatures.filter(f => {
              const bag = makeEvalProps({
                props: f.properties ?? undefined,
                geometryType: f.geometry?.type,
                featureId: (f as { id?: string | number }).id,
                cameraZoom: msg.z,
              })
              return evalFilterExpr(desc.filterAst, bag)
            })
          : layerFeatures
        emitSlice(
          desc.sliceKey, desc.sourceLayer, subset,
          desc.needsFeatureProps === true,
          desc.needsExtrude === true,
        )
      }
    } else {
      // Legacy path: one slice per MVT source layer, no filter
      // bucketing. No need flags available — emit everything for
      // back-compat. Callers that opt into showSlices get the savings.
      for (const [layerName, layerFeatures] of byLayer) {
        emitSlice(layerName, layerName, layerFeatures, true, true)
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
