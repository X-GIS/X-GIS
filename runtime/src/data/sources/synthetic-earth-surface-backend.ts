// SyntheticEarthSurfaceBackend — TileSource implementation for the
// ECEF earth-surface fill mesh (Phase 2 PR 2c.3).
//
// Replaces `BackgroundRenderer` (deleted in PR 2c.3.B). The backend
// serves a single z=0 tile carrying a 32x16 lat/lon mesh projected to
// spherical ECEF metres, packed in the same DSFUN stride-9 layout the
// polygon VS (`vs_main_ecef`) consumes. XGISMap.run() auto-attaches
// this backend when the style declares a `background { fill: ... }`
// block and prepends a synthetic ShowCommand at the head of the
// opaque pass; the standard polygon ECEF pipeline renders it so the
// fill curves naturally on sphere projections instead of painting a
// flat strip.
//
// DSFUN precision note: vertices are DSFUN-split relative to ECEF origin
// `[0, 0, 0]` (world-center anchor). At sphere magnitudes ~6.378 Mm the
// f32 hi-half resolves to ~0.76 m, which is invisibly fine for a 32x16
// grid where adjacent cells span ~1200 km. Revisit if mesh density
// escalates beyond 64x32 (AC2c.3.1).

import { tileKey } from '@xgis/compiler'
import {
  generateEarthSurfaceFillMesh,
  worldBandForProjType,
  type WorldBandKind,
} from '../../engine/projection/earth-surface-fill'
import { lonLatToECEFSphere, type ECEF } from '../../engine/projection/ecef'
import {
  TILE_LAYOUT_VERSION,
  type BackendTileResult,
  type TileSource,
  type TileSourceMeta,
  type TileSourceSink,
} from '../tile-source'

const Z0_KEY = tileKey(0, 0, 0)
const WIDTH_SEGMENTS = 32
const HEIGHT_SEGMENTS = 16
const WORLD_ANCHOR: ECEF = [0, 0, 0]

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

    // Pass 1: ECEF RTC residual (about WORLD_ANCHOR) + abs lon/lat per vertex;
    // track the max-abs residual for the PR 2f double-u16 quantization range.
    // The world-anchored residuals span ~±6.4e6 m (this mesh covers the whole
    // globe at z=0), so the per-vertex 32-bit fixed-point step is ~3 mm — far
    // finer than the 32×16 grid's ~1200 km cell spacing.
    const rx = new Float64Array(vertexCount)
    const ry = new Float64Array(vertexCount)
    const rz = new Float64Array(vertexCount)
    const lons = new Float64Array(vertexCount)
    const lats = new Float64Array(vertexCount)
    let maxAbs = 0
    for (let i = 0; i < vertexCount; i++) {
      const lon = mesh.vertices[i * 2]
      const lat = mesh.vertices[i * 2 + 1]
      const ecef = lonLatToECEFSphere(lon, lat, 0)
      const ax = ecef[0] - WORLD_ANCHOR[0]
      const ay = ecef[1] - WORLD_ANCHOR[1]
      const az = ecef[2] - WORLD_ANCHOR[2]
      rx[i] = ax; ry[i] = ay; rz[i] = az
      lons[i] = lon; lats[i] = lat
      const m = Math.max(Math.abs(ax), Math.abs(ay), Math.abs(az))
      if (m > maxAbs) maxAbs = m
    }

    // Per-mesh symmetric half-range; matches the tiler's packECEFPolygonVertices
    // scheme so vs_main_ecef's dequant (`q*scale - half`) reconstructs the RTC.
    const dequantHalf = maxAbs + 1e-6
    const span = 2 * dequantHalf
    const dequantScale = span / 0xFFFFFFFF
    const invSpan = 0xFFFFFFFF / span
    const quant = (axis: number): [number, number] => {
      let q = Math.round((axis + dequantHalf) * invSpan)
      if (q < 0) q = 0
      else if (q > 0xFFFFFFFF) q = 0xFFFFFFFF
      return [(q >>> 16) & 0xFFFF, q & 0xFFFF]
    }

    // Pass 2: interleaved stride-24 buffer (u16×6 position + f32 fid/lon/lat),
    // matching the quantized polygon vertex layout vs_main_ecef consumes.
    const vertices = new Float32Array(vertexCount * 6)
    const u16 = new Uint16Array(vertices.buffer)
    for (let i = 0; i < vertexCount; i++) {
      const [xh, xl] = quant(rx[i])
      const [yh, yl] = quant(ry[i])
      const [zh, zl] = quant(rz[i])
      const u = i * 12
      u16[u]     = xh
      u16[u + 1] = xl
      u16[u + 2] = yh
      u16[u + 3] = yl
      u16[u + 4] = zh
      u16[u + 5] = zl
      const f = i * 6
      vertices[f + 3] = 0          // feat_id — single synthetic feature
      vertices[f + 4] = lons[i]    // abs_lon (degrees) — hemisphere-cull varying
      vertices[f + 5] = lats[i]    // abs_lat (degrees)
    }
    return {
      vertices,
      dequantScale,
      dequantHalf,
      indices: mesh.indices,
      lineVertices: new Float32Array(0),
      lineIndices: new Uint32Array(0),
    }
  }
}
