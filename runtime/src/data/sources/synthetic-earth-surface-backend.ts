// SyntheticEarthSurfaceBackend — TileSource implementation for the
// ECEF earth-surface fill mesh (Phase 2 PR 2c.3).
//
// Replaces `BackgroundRenderer` (deleted in PR 2c.3.B). The backend
// serves a single z=0 tile carrying a 32x16 lat/lon mesh projected to
// WGS84-ellipsoid ECEF metres (via the shared tiler kernel), packed in
// the same DSFUN quantized layout the polygon VS (`vs_main_ecef`)
// consumes — so the bg ground shares one geoid with tile polygons.
// XGISMap.run() auto-attaches
// this backend when the style declares a `background { fill: ... }`
// block and prepends a synthetic ShowCommand at the head of the
// opaque pass; the standard polygon ECEF pipeline renders it so the
// fill curves naturally on sphere projections instead of painting a
// flat strip.
//
// DSFUN precision note: vertices are quantized (double-u16) about the z=0
// tile's ELLIPSOID anchor `tileEcefCenter` (lon=-180, lat=Z0_DECODED_SOUTH)
// via the SHARED tiler kernel `packECEFPolygonVertices`. The bg ground
// therefore shares ONE geoid (WGS84 ellipsoid) and ONE RTC origin with the
// surrounding tile polygons, so it lands on the same surface the ground tiles
// do (origins cancel exactly in the polygon ECEF VS — the anchor latitude is
// the SAME decoded z=0 tile-south the render-side `off` uses, not the rounded
// Mercator clamp). The whole globe is anchored about that single tile-corner,
// so the per-vertex 32-bit fixed-point step is ~3 mm — far finer than the
// 32×16 grid's ~1200 km cell spacing.

import { tileKey, packECEFPolygonVertices } from '@xgis/compiler'
import {
  generateEarthSurfaceFillMesh,
  worldBandForProjType,
  type WorldBandKind,
} from '../../engine/projection/earth-surface-fill'
import { tileEcefCenterFromMerc, lonLatToECEF } from '../../engine/projection/ecef'
import { quantizeAxis } from '@xgis/shared'
import {
  TILE_LAYOUT_VERSION,
  type BackendTileResult,
  type TileSource,
  type TileSourceMeta,
  type TileSourceSink,
} from '../tile-source'

const Z0_KEY = tileKey(0, 0, 0)
// Disc silhouette = projection of this lon/lat grid. At 32×16 the rim was a
// ~14-gon with visibly straight facets on the azimuthal/ortho z0 disc
// (userbug 09). Raised to 128×64 so the longitudinal step is 360/128 = 2.8125°
// (rim chord well under 1 px on a full-canvas disc) and the polar-cap row sits
// at 87.1875° (vs 85.0511°), tightening the cap fan. Cost: 8385 verts / 49152
// indices — trivial for a single z=0 quad drawn once.
const WIDTH_SEGMENTS = 128
const HEIGHT_SEGMENTS = 64
const DEG2RAD = Math.PI / 180
const A = 6378137 // WGS84 semi-major axis — matches the tiler + render-side `off`.
// Source-honest Web-Mercator latitude clamp applied to the PER-VERTEX mx/my
// encode. This is the rounded constant the tiler also uses to cap polar
// vertices (vector-tile-renderer.ts:2221), so the bg's polar rows surface with
// the SAME ±85 cap real polar ground verts carry — the geoid stays consistent
// (runtime/src/engine/render/vector-tile-renderer.ts:2221 clampLat).
// NOTE: this is the VERTEX clamp only; the tile-corner ANCHOR latitude must use
// the DECODED z=0 tile-south below, not this rounded value (see Z0_DECODED_SOUTH).
const MERC_LAT_CLAMP = 85.051129
// Decoded z=0 tile-south latitude (degrees) — the EXACT value the tile catalog
// reconstructs for the synthetic z=0 tile (tile-catalog.ts:1102,
// atan(sinh(±π))·180/π) and the value the render-side `off` anchor feeds
// through clampLat (vector-tile-renderer.ts:5041). It is just INSIDE the
// rounded ±85.051129 clamp (|Δ| ≈ 2.46 cm), so clampLat passes it through
// unchanged. The bg tile-corner ANCHOR must use THIS decoded latitude (not the
// rounded MERC_LAT_CLAMP) so the bg pack anchor equals the render-side
// tileEcefCenter EXACTLY and the RTC origins cancel with no residual.
const Z0_DECODED_SOUTH = Math.atan(Math.sinh(-Math.PI)) * 180 / Math.PI

/** Stable source-name identifier the synthetic backend stamps on its
 *  emitted tiles. Mirrors `VectorTileRenderer.effectiveSourceLayer`'s
 *  `show.sourceLayer || show.targetName` resolution so the synthetic
 *  ShowCommand (with `targetName === SYNTHETIC_EARTH_SURFACE_SOURCE`)
 *  lands in the same GPU cache slot. */
export const SYNTHETIC_EARTH_SURFACE_SOURCE = '__synthetic_earth_surface__'

export class SyntheticEarthSurfaceBackend implements TileSource {
  // meta.bounds follows the Mercator catalog convention (±85° clamp the
  // catalog assumes for non-sphere ingest). The actual mesh latitude band
  // now tracks the projType (worldBandForProjType, set in the constructor):
  // ±85.05° for mercator-class, ±90° for sphere-class. bounds stays ±85°
  // (catalog tile-selection convention); a sphere-band mesh intentionally
  // exceeds it so sphere-projection rims reach the poles.
  readonly meta: TileSourceMeta = {
    bounds: [-180, -85, 180, 85],
    minZoom: 0,
    maxZoom: 0,
    scheme: 'web-mercator-xyz',
    layoutVersion: TILE_LAYOUT_VERSION,
  }

  private sink: TileSourceSink | null = null
  private fillRgba: [number, number, number, number] = [0, 0, 0, 0]
  private cachedResult: BackendTileResult | null = null
  private readonly band: WorldBandKind

  /** @param projType resolved projection kind (0=mercator … 7=globe). The
   *  earth-surface mesh's latitude band follows `worldBandForProjType`:
   *  mercator-class (0/1/6) → ±85.05° (source-honest Web-Mercator extent),
   *  sphere-class (3/4/5/7) → ±90° (poles), natural_earth (2) → ±90° oval.
   *  The band is fixed per instance; XGISMap re-installs the backend on a
   *  projection change so the band — and thus the GPU vertex buffer —
   *  refreshes. */
  constructor(projType = 0) {
    this.band = worldBandForProjType(projType)
  }

  has(key: number): boolean {
    return key === Z0_KEY
  }

  attach(sink: TileSourceSink): void {
    this.sink = sink
    // The synthetic tile is global and never refetched — emit immediately
    // so the catalog has it cached before the first render request.
    this.loadTile(Z0_KEY)
  }

  loadTile(key: number): void {
    if (!this.sink || key !== Z0_KEY) return
    if (!this.cachedResult) this.cachedResult = this.buildResult()
    // Stamp sourceLayer = source name so VTR's effectiveSourceLayer
    // resolution (`show.sourceLayer || show.targetName`) lands in the
    // same cache slot. Mirrors the inline-GeoJSON pattern where the
    // tilingPool emits MVT with `_layer = sourceName`.
    this.sink.acceptResult(Z0_KEY, this.cachedResult, SYNTHETIC_EARTH_SURFACE_SOURCE)
  }

  /** Update the style background fill color. The backend stashes the
   *  RGBA so callers reading via `getFillColor()` see the latest value;
   *  the synthetic ShowCommand's `paintShapes.fill` carries the colour
   *  used by the fragment shader (kept in sync via
   *  `XGISMap.setBackgroundFill`). */
  updateFillColor(rgba: [number, number, number, number]): void {
    this.fillRgba[0] = rgba[0]
    this.fillRgba[1] = rgba[1]
    this.fillRgba[2] = rgba[2]
    this.fillRgba[3] = rgba[3]
  }

  getFillColor(): readonly [number, number, number, number] {
    return this.fillRgba
  }

  private buildResult(): BackendTileResult {
    const mesh = generateEarthSurfaceFillMesh(WIDTH_SEGMENTS, HEIGHT_SEGMENTS, this.band)
    const vertexCount = mesh.vertices.length / 2  // stride-2 lon/lat → vertex count

    // Anchor about the z=0 synthetic tile's ELLIPSOID corner — the SAME value
    // the render-side per-tile uniform pack reconstructs into `cam_ecef_off`
    // (runtime/src/engine/render/vector-tile-renderer.ts:5032-5054, tileWest=-180
    // / clampLat(cached.tileSouth)). The render `off` uses the DECODED z=0
    // tile-south (Z0_DECODED_SOUTH), which sits just inside the rounded clamp so
    // clampLat returns it unchanged — so the anchor latitude here is that decoded
    // value, NOT the rounded MERC_LAT_CLAMP. Both sides then feed
    // tileEcefCenterFromMerc the identical tileMy, so the anchors are bit-for-bit
    // equal and the polygon ECEF VS origins — (vertex − tileEcefCenter) +
    // (tileEcefCenter − cameraCenter) — cancel exactly with no residual.
    const tileMx = -180 * DEG2RAD * A
    const tileMy = Math.log(Math.tan(Math.PI / 4 + Z0_DECODED_SOUTH * DEG2RAD / 2)) * A
    const ecefTileCenter = tileEcefCenterFromMerc(tileMx, tileMy)

    // SPHERE-class bands (ortho/azi/stereo/globe) must reach the geographic
    // poles — their disc/sphere silhouette is the projection of the FULL ±90
    // grid, so a ±85.05 cap leaves a ~5° hole at each pole (userbug 09 black
    // dots). The flat-disc vertex arm projects from the per-vertex `abs_lat`
    // (polygon.ts vs_main: project(abs_lon, abs_lat)), so the cap is only
    // filled if the polar rows CARRY abs_lat = ±90 and a matching ECEF
    // position. The shared tiler kernel cannot produce that: it derives
    // ECEF + abs_lat from inverse-Mercator on mx/my, which asymptotes at
    // ±85.05 and can never represent ±90. So for sphere bands we dual-encode
    // here (F2): |lat| ≤ ±85.05 rows take the SAME WGS84-ellipsoid forward the
    // kernel runs (geoid-identical to ground tiles within the quant step), and
    // |lat| > ±85.05 polar rows take lonLatToECEF(lon, lat) directly — real
    // source-honest caps at ±90. One shared per-buffer scale spans grid+poles.
    // The fragment-side `abs(abs_lat) > MERCATOR_LAT_LIMIT` discard never trips
    // because the VS writes the CLAMPED abs_lat to the varying (polygon.ts:335)
    // — only the per-vertex POSITION attribute reaches the pole, not the
    // fragment's interpolated abs_lat. Mercator (0/1/6) + natural_earth (2)
    // bands have nothing beyond ±85.05 (source-honest Web-Mercator extent), so
    // they keep the unchanged canonical kernel path — byte-identical, zero
    // behaviour change.
    const q = this.band === 'sphere-full'
      ? packECEFWithPolarCaps(mesh.vertices, vertexCount, ecefTileCenter)
      : packKernelClamped(mesh.vertices, vertexCount, ecefTileCenter)
    return {
      vertices: q.vertices,
      dequantScale: q.dequantScale,
      dequantHalf: q.dequantHalf,
      indices: mesh.indices,
      lineVertices: new Float32Array(0),
      lineIndices: new Uint32Array(0),
    }
  }
}

// ── Quantized-ECEF packing for the synthetic z=0 surface ─────────────────────
//
// POLYGON_FILL_FORMAT contract (compiler/src/tiler/polygon-vertex-format.ts):
//   stride = 6 f32 = 12 u16. u16×6 position lanes 0..5 occupy bytes 0..11;
//   f32 tail = feature_id @float3, abs_lon @float4, abs_lat @float5.
const FILL_FLOATS_PER_VERT = 6
const FILL_U16_PER_VERT = 12
const FILL_FID_FLOAT = 3
const FILL_LON_FLOAT = 4
const FILL_LAT_FLOAT = 5

/** Mercator-clamped pack (the canonical ground-tile path). Builds an absolute
 *  Mercator-metre scratch (latitude capped at the Web-Mercator limit) and runs
 *  the SHARED tiler kernel `packECEFPolygonVertices` — byte-identical to real
 *  ground polygons. Used for mercator-class (0/1/6) + natural_earth (2) bands,
 *  whose source data legitimately stops at ±85.05° (no polar caps to fill). */
function packKernelClamped(
  meshVerts: Float32Array,
  vertexCount: number,
  ecefTileCenter: readonly [number, number, number],
): { vertices: Float32Array; dequantScale: number; dequantHalf: number } {
  const scratch = new Float64Array(vertexCount * 3)
  for (let i = 0; i < vertexCount; i++) {
    const lon = meshVerts[i * 2]
    const lat = meshVerts[i * 2 + 1]
    const clampedLat = Math.max(-MERC_LAT_CLAMP, Math.min(MERC_LAT_CLAMP, lat))
    scratch[i * 3]     = lon * DEG2RAD * A
    scratch[i * 3 + 1] = Math.log(Math.tan(Math.PI / 4 + clampedLat * DEG2RAD / 2)) * A
    scratch[i * 3 + 2] = 0   // feat_id — single synthetic feature
  }
  const q = packECEFPolygonVertices(scratch, ecefTileCenter)
  return { vertices: q.vertices, dequantScale: q.dequantScale, dequantHalf: q.dequantHalf }
}

/** Sphere-band pack WITH source-honest polar caps (F2 — principled dual-encode).
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
 *  the GPU binds — the polar residual is only ~24 mm larger than the ±85 band,
 *  so the shared scale shifts the ≤85 bytes imperceptibly (well inside the
 *  geoid-unification tolerance). The ellipsoid forward is inlined to match the
 *  kernel exactly (vector-tiler.ts:225-232). */
function packECEFWithPolarCaps(
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
