// ═══ @xgis/pipeline · encode — Table → renderable payload ═══
//
// Insight-oriented recipes turn a joined + transformed table into something a map
// can draw. Point recipes (bubble/points) emit a PointPatch (the typed-array
// `setSourcePoints` fast path — no per-point object bloat); line/polygon recipes
// (odFlow/choropleth) emit a GeoJSON FC (Phase 1.5+). The result is a CAPABILITY
// object: `.apply(sink, id)` picks the sink + (once wired) forwards the CRS, so the
// caller can never route to the wrong sink or drop the CRS. The pipeline imports NO
// render package; the host passes the real XGISMap, which satisfies `PipelineSink`.

import type { Table, Cell } from '../core/table'

/** Parallel typed-array point patch — structurally the `XGISMap.setSourcePoints`
 *  input (`data/src/id-resolver.ts` PointPatch), so no cross-package import. */
export interface PointPatch {
  lon: Float32Array | number[]
  lat: Float32Array | number[]
  ids?: Uint32Array | number[]
  properties?: Record<string, ArrayLike<unknown>>
}

export interface FeatureCollectionLike {
  type: 'FeatureCollection'
  features: unknown[]
}

/** The render sink the pipeline emits into — structurally satisfied by XGISMap. */
export interface PipelineSink {
  setSourcePoints(sourceId: string, patch: PointPatch): void
  setSourceData(sourceId: string, fc: FeatureCollectionLike): void
}

export interface EncodeResult {
  readonly kind: 'fc' | 'points'
  /** Push into the map, picking the sink + forwarding CRS. The one blessed path. */
  apply(sink: PipelineSink, sourceId: string): void
  /** Escape hatch — the raw FeatureCollection (points expand to Point features). */
  toFeatureCollection(): FeatureCollectionLike
}

/** Guard: projected coordinates (EPSG:5179 easting ~10^6) are ALWAYS outside the
 *  geographic range, so a forgotten `crs` on projected data is caught LOUD here
 *  instead of silently placing dots in the ocean. Phase 1 renders WGS84 only; a
 *  declared non-WGS84 crs throws (reprojection is delegated to the map sink, a
 *  deferred wiring — see the design doc §3). */
function assertGeographic(
  lonCol: readonly Cell[],
  latCol: readonly Cell[],
  crs: string | undefined,
  lonName: string,
  latName: string,
): void {
  if (crs !== undefined && crs !== 'EPSG:4326' && crs.toUpperCase() !== 'WGS84') {
    throw new Error(
      `[@xgis/pipeline] crs '${crs}' needs reprojection — not wired in Phase 1 (WGS84 input only). ` +
        `Reproject upstream, or declare the source crs on the map once that channel lands (design doc §3).`,
    )
  }
  for (let i = 0; i < lonCol.length; i++) {
    const lo = Number(lonCol[i])
    const la = Number(latCol[i])
    if (!(lo >= -180 && lo <= 180 && la >= -90 && la <= 90)) {
      throw new Error(
        `[@xgis/pipeline] columns '${lonName}'/'${latName}' hold (${lo}, ${la}) — outside the ` +
          `geographic range. This looks like PROJECTED coordinates (e.g. EPSG:5179 UTM-K). ` +
          `Declare crs so it can be reprojected, or pass WGS84 lon/lat.`,
      )
    }
  }
}

function numCol(t: Table, name: string): Float64Array {
  const c = t.col(name)
  const out = new Float64Array(c.length)
  for (let i = 0; i < c.length; i++) out[i] = Number(c[i])
  return out
}

function pointResult(
  lon: Float32Array,
  lat: Float32Array,
  properties: Record<string, ArrayLike<unknown>>,
): EncodeResult {
  const patch: PointPatch = { lon, lat, properties }
  return {
    kind: 'points',
    apply: (sink, id) => sink.setSourcePoints(id, patch),
    toFeatureCollection: () => ({
      type: 'FeatureCollection',
      features: Array.from(lon, (x, i) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [x, lat[i]] },
        properties: Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, v[i]])),
      })),
    }),
  }
}

/** Magnitude field: one point per row, sized by `value`. Emits `value` (raw) +
 *  `radius` (px, `value` normalised into `sizeRange` via sqrt so AREA reads
 *  proportional to value) as per-point properties. */
export function bubble(
  t: Table,
  o: { lon: string; lat: string; value: string; crs?: string; sizeRange?: [number, number] },
): EncodeResult {
  assertGeographic(t.col(o.lon), t.col(o.lat), o.crs, o.lon, o.lat)
  const lonD = numCol(t, o.lon)
  const latD = numCol(t, o.lat)
  const value = numCol(t, o.value)
  const [rMin, rMax] = o.sizeRange ?? [4, 40]
  let vMin = Infinity
  let vMax = -Infinity
  for (const v of value) {
    if (v < vMin) vMin = v
    if (v > vMax) vMax = v
  }
  const span = vMax - vMin || 1
  const n = t.length
  const lon = new Float32Array(n)
  const lat = new Float32Array(n)
  const radius = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    lon[i] = lonD[i]!
    lat[i] = latD[i]!
    radius[i] = rMin + (rMax - rMin) * Math.sqrt((value[i]! - vMin) / span)
  }
  return pointResult(lon, lat, { value, radius })
}

/** Origin-destination flow: one LineString per row connecting origin centroid to
 *  destination centroid. `origin` and `dest` are join `as` handles (the encoder
 *  reads `${origin}.lon` / `${origin}.lat` etc.). No `assertGeographic` — gazetteer
 *  centroids are WGS84 by the join contract. `lift` (default 0) is written to
 *  `properties.lift` on every feature as a reserved arc-bulge hint for a future
 *  curved-draper integration; the current straight-line render path ignores it.
 *  `purpose` and `segment` are optional column names whose numeric values are
 *  written into feature properties under the same key; omitting them keeps existing
 *  `{weight, lift}` behaviour byte-identical.
 *  `oName` and `dName` are optional string column names (e.g. `'origin.name'` /
 *  `'dest.name'` from a gazetteer join) written as feature properties for hover/tooltip
 *  use; omitting them is byte-identical. */
export function odFlow(
  t: Table,
  o: {
    origin: string
    dest: string
    weight: string
    lift?: number
    purpose?: string
    segment?: string
    oName?: string
    dName?: string
  },
): EncodeResult {
  const oLon = numCol(t, `${o.origin}.lon`)
  const oLat = numCol(t, `${o.origin}.lat`)
  const dLon = numCol(t, `${o.dest}.lon`)
  const dLat = numCol(t, `${o.dest}.lat`)
  const weight = numCol(t, o.weight)
  const lift = o.lift ?? 0
  const purposeVals = o.purpose != null ? numCol(t, o.purpose) : null
  const segmentVals = o.segment != null ? numCol(t, o.segment) : null
  const oNameVals = o.oName != null ? t.col(o.oName) : null
  const dNameVals = o.dName != null ? t.col(o.dName) : null
  const features = Array.from({ length: t.length }, (_, i) => ({
    type: 'Feature' as const,
    geometry: {
      type: 'LineString' as const,
      coordinates: [
        [oLon[i], oLat[i]],
        [dLon[i], dLat[i]],
      ],
    },
    properties: {
      weight: weight[i],
      lift,
      ...(purposeVals != null ? { purpose: purposeVals[i] } : {}),
      ...(segmentVals != null ? { segment: segmentVals[i] } : {}),
      ...(oNameVals != null ? { oName: String(oNameVals[i] ?? '') } : {}),
      ...(dNameVals != null ? { dName: String(dNameVals[i] ?? '') } : {}),
    },
  }))
  const fc: FeatureCollectionLike = { type: 'FeatureCollection', features }
  return {
    kind: 'fc',
    apply: (sink, id) => sink.setSourceData(id, fc),
    toFeatureCollection: () => fc,
  }
}

/** Plain points (no magnitude channel). */
export function points(
  t: Table,
  o: { lon: string; lat: string; id?: string; crs?: string },
): EncodeResult {
  assertGeographic(t.col(o.lon), t.col(o.lat), o.crs, o.lon, o.lat)
  const lonD = numCol(t, o.lon)
  const latD = numCol(t, o.lat)
  const n = t.length
  const lon = new Float32Array(n)
  const lat = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    lon[i] = lonD[i]!
    lat[i] = latD[i]!
  }
  return pointResult(lon, lat, {})
}
