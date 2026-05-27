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
import { generateEarthSurfaceFillMesh } from '../../engine/projection/earth-surface-fill'
import { lonLatToECEFSphere, dsfunSplitECEF, type ECEF } from '../../engine/projection/ecef'
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
  // catalog assumes for non-sphere ingest). The actual mesh covers ±90°
  // latitude (`bandLatRange('sphere-full')`) so sphere-projection rims
  // reach the poles. The two ranges intentionally differ.
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
    const mesh = generateEarthSurfaceFillMesh(WIDTH_SEGMENTS, HEIGHT_SEGMENTS, 'sphere-full')
    const vertexCount = mesh.vertices.length / 2  // stride-2 lon/lat → vertex count
    const vertices = new Float32Array(vertexCount * 9)
    for (let i = 0; i < vertexCount; i++) {
      const lon = mesh.vertices[i * 2]
      const lat = mesh.vertices[i * 2 + 1]
      const ecef = lonLatToECEFSphere(lon, lat, 0)
      const { hi, lo } = dsfunSplitECEF(ecef, WORLD_ANCHOR)
      const base = i * 9
      vertices[base]     = hi[0]
      vertices[base + 1] = hi[1]
      vertices[base + 2] = hi[2]
      vertices[base + 3] = lo[0]
      vertices[base + 4] = lo[1]
      vertices[base + 5] = lo[2]
      vertices[base + 6] = 0          // feat_id — single synthetic feature
      vertices[base + 7] = lon        // abs_lon (degrees) — hemisphere-cull varying
      vertices[base + 8] = lat        // abs_lat (degrees)
    }
    return {
      vertices,
      indices: mesh.indices,
      lineVertices: new Float32Array(0),
      lineIndices: new Uint32Array(0),
    }
  }
}
