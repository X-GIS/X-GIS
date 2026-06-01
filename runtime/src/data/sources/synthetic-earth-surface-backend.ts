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
import { tileEcefCenterFromMerc } from '../../engine/projection/ecef'
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

    // Build a stride-3 `[mx, my, fid]` ABSOLUTE Mercator scratch from the mesh
    // and feed it through the canonical tiler kernel. `packECEFPolygonVertices`
    // inverts mx/my back through inverse-Mercator then runs the WGS84 ellipsoid
    // forward (vector-tiler.ts:225-232) — byte-identical to real ground tiles.
    // The sphere band's ±90 rows are clamped to the Web-Mercator limit for the
    // mx/my ENCODE only: the kernel re-derives lon/lat from mx/my, so the abs_lat
    // varying it re-emits is the clamped value — exactly how real polar ground
    // verts encode (consistent ±85 cap), and the ground geoid stays identical.
    const scratch = new Float64Array(vertexCount * 3)
    for (let i = 0; i < vertexCount; i++) {
      const lon = mesh.vertices[i * 2]
      const lat = mesh.vertices[i * 2 + 1]
      const clampedLat = Math.max(-MERC_LAT_CLAMP, Math.min(MERC_LAT_CLAMP, lat))
      scratch[i * 3]     = lon * DEG2RAD * A
      scratch[i * 3 + 1] = Math.log(Math.tan(Math.PI / 4 + clampedLat * DEG2RAD / 2)) * A
      scratch[i * 3 + 2] = 0   // feat_id — single synthetic feature
    }

    const q = packECEFPolygonVertices(scratch, ecefTileCenter)
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
