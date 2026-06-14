// Source-honest polar-cap ECEF packing — shared kernel.
//
// Lifted verbatim out of synthetic-earth-surface-backend.ts so MORE THAN ONE
// backend can render ±90° polar caps through the polygon ECEF pipeline. The
// synthetic earth-surface background uses it for its sphere-band world mesh;
// the per-source GeoJSON polar-cap backend (issue #360 F1) uses it to fill the
// ±5° polar hole left by the geojsonvt/MVT pipeline, which is Mercator-[0,1]
// bounded on BOTH ends (forward projectY clamp + reverse mvt-decoder clampLat)
// and therefore structurally cannot carry geometry past ±85.0511°.
//
// Why a cap path EXISTS at all: polygon fills tessellate in Mercator metres,
// whose inverse asymptotes at ±85.0511° — so neither the geojsonvt pipeline nor
// the shared tiler kernel (packECEFPolygonVertices) can place a vertex at the
// geographic pole. This kernel keeps the TRUE latitude for polar rows and
// computes ECEF directly via lonLatToECEF, so the flat-disc vertex arm
// (polygon.ts vs_main: project(abs_lon, abs_lat)) projects the cap all the way
// to ±90 on sphere / orthographic / azimuthal / stereographic projections.
// The fragment-side `abs(abs_lat) > MERCATOR_LAT_LIMIT` discard never trips
// because the VS writes the CLAMPED abs_lat to the varying — only the POSITION
// attribute reaches the pole.

import { lonLatToECEF } from '../../engine/projection/ecef'
import { quantizeAxis } from '@xgis/shared'

/** Source-honest Web-Mercator latitude clamp. Rows beyond this take their TRUE
 *  latitude (the polar cap the Mercator pipeline cannot reach); rows within it
 *  stay Merc-clamped so they remain geoid-identical to ground-tile polygons. */
export const MERC_LAT_CLAMP = 85.051129

// POLYGON_FILL_FORMAT contract (compiler/src/tiler/polygon-vertex-format.ts):
//   stride = 6 f32 = 12 u16. u16×6 position lanes 0..5 occupy bytes 0..11;
//   f32 tail = feature_id @float3, abs_lon @float4, abs_lat @float5.
const FILL_FLOATS_PER_VERT = 6
const FILL_U16_PER_VERT = 12
const FILL_FID_FLOAT = 3
const FILL_LON_FLOAT = 4
const FILL_LAT_FLOAT = 5

/** Pack a stride-2 (lon,lat) mesh into the quantized-ECEF POLYGON_FILL_FORMAT
 *  WITH source-honest polar caps.
 *
 *  Per vertex:
 *    – |lat| ≤ MERC_LAT_CLAMP: latitude is Merc-clamped and the WGS84-ellipsoid
 *      ECEF is taken at that clamped latitude — the SAME geoid + abs_lat the
 *      shared kernel emits for ground tiles (reconstructs to the kernel value
 *      within the quant step, so geoid-unification is preserved).
 *    – |lat| >  MERC_LAT_CLAMP: latitude is kept TRUE (up to ±90) and the ECEF
 *      is `lonLatToECEF(lon, lat)` directly — the polar-cap rows the kernel
 *      cannot reach. abs_lat carries the true latitude so the flat-disc vertex
 *      arm projects the cap geometry all the way to the pole, closing the hole.
 *
 *  All vertices share ONE per-buffer symmetric half-range (max-abs residual
 *  over grid + caps) so they decode through the single `tile_dequant_scale`
 *  the GPU binds. The ellipsoid forward is `lonLatToECEF` to match the kernel
 *  (vector-tiler.ts:225-232) exactly. `feat_id` is 0 (single synthetic
 *  feature) for every vertex.
 *
 *  `meshVerts` is stride-2 `[lon, lat, …]`; `vertexCount` = meshVerts.length/2;
 *  `ecefTileCenter` is the RTC anchor the consuming tile's render-side
 *  `cam_ecef_off` reconstructs (so origins cancel in the polygon ECEF VS). */
export function packECEFWithPolarCaps(
  meshVerts: Float32Array,
  vertexCount: number,
  ecefTileCenter: readonly [number, number, number],
): { vertices: Float32Array; dequantScale: number; dequantHalf: number } {
  // Pass 1: ECEF residuals + per-vertex abs_lon/abs_lat; track max-abs residual.
  const rx = new Float64Array(vertexCount)
  const ry = new Float64Array(vertexCount)
  const rz = new Float64Array(vertexCount)
  const lonDeg = new Float64Array(vertexCount)
  const latDeg = new Float64Array(vertexCount)
  let maxAbs = 0
  for (let i = 0; i < vertexCount; i++) {
    const lon = meshVerts[i * 2]
    const lat = meshVerts[i * 2 + 1]
    // Polar rows (|lat| beyond the Web-Mercator cap) forward the TRUE latitude
    // to the WGS84 ellipsoid; all others use the Merc-clamped latitude so they
    // stay geoid-identical to the kernel/ground-tile path.
    const encLat = Math.abs(lat) > MERC_LAT_CLAMP
      ? lat
      : Math.max(-MERC_LAT_CLAMP, Math.min(MERC_LAT_CLAMP, lat))
    const [ex, ey, ez] = lonLatToECEF(lon, encLat)
    const ax = ex - ecefTileCenter[0]
    const ay = ey - ecefTileCenter[1]
    const az = ez - ecefTileCenter[2]
    rx[i] = ax; ry[i] = ay; rz[i] = az
    lonDeg[i] = lon
    latDeg[i] = encLat
    const m = Math.max(Math.abs(ax), Math.abs(ay), Math.abs(az))
    if (m > maxAbs) maxAbs = m
  }

  // Symmetric half-range + dequant params — mirrors the kernel exactly.
  const halfRange = maxAbs + 1e-6
  const span = 2 * halfRange
  const dequantScale = span / 0xFFFFFFFF
  const invSpan = 0xFFFFFFFF / span

  const out = new Float32Array(vertexCount * FILL_FLOATS_PER_VERT)
  const u16 = new Uint16Array(out.buffer)
  for (let i = 0; i < vertexCount; i++) {
    const [xh, xl] = quantizeAxis(rx[i], halfRange, invSpan)
    const [yh, yl] = quantizeAxis(ry[i], halfRange, invSpan)
    const [zh, zl] = quantizeAxis(rz[i], halfRange, invSpan)
    const u = i * FILL_U16_PER_VERT
    u16[u]     = xh
    u16[u + 1] = xl
    u16[u + 2] = yh
    u16[u + 3] = yl
    u16[u + 4] = zh
    u16[u + 5] = zl
    const f = i * FILL_FLOATS_PER_VERT
    out[f + FILL_FID_FLOAT] = 0   // single synthetic feature
    out[f + FILL_LON_FLOAT] = lonDeg[i]
    out[f + FILL_LAT_FLOAT] = latDeg[i]
  }
  return { vertices: out, dequantScale, dequantHalf: halfRange }
}
