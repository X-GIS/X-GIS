// GeoJSONPolarCapBackend — per-source ±5° polar-cap fill (issue #360 F1).
//
// The geojsonvt → MVT pipeline is Web-Mercator-[0,1] bounded on BOTH ends
// (forward projectY clamp + reverse mvt-decoder clampLat) so it structurally
// cannot carry geometry past ±85.0511°. On globe / orthographic / azimuthal /
// stereographic projections that DO reach the geographic poles, a GeoJSON
// source whose polygons touch the Mercator clamp boundary (ne_110m_ocean at the
// Arctic, ne_110m_land/Antarctica at the South Pole) leaves a black ±5° hole at
// the pole — the "black star" of #360.
//
// This backend fills that hole the SAME way the shipped
// SyntheticEarthSurfaceBackend fills the background's polar caps: it serves a
// single synthetic z=0 tile carrying a CAP-ONLY lat/lon mesh (rows from the
// Mercator clamp to ±90° over the full longitude span), packed through the
// shared `packECEFWithPolarCaps` kernel so the polar rows carry TRUE latitude
// ECEF positions + abs_lat = ±90. The polygon ECEF VS (polygon.ts vs_main)
// projects those rows all the way to the pole on sphere-class projections,
// closing the hole. The fragment-side `abs(abs_lat) > MERCATOR_LAT_LIMIT`
// discard never trips because the VS writes the CLAMPED abs_lat to the varying.
//
// Per-pole correctness for Earth: ne_110m_ocean touches only the NORTH boundary
// (Arctic) → north cap; ne_110m_land touches only the SOUTH boundary
// (Antarctica) → south cap. detectCapPoles walks the source's OUTER rings and
// ORs the poles found, so each source synthesises only the cap(s) it needs and
// the cap inherits that source layer's fill colour (blue ocean / green land).

import { tileKey } from '@xgis/compiler'
import { tileEcefCenterFromMerc } from '@xgis/engine'
import { findClampBoundarySpans } from '@xgis/data'
import type { GeoJSONFeatureCollection } from '@xgis/data'
import { packECEFWithPolarCaps, MERC_LAT_CLAMP } from './polar-cap-ecef-pack'
import {
  TILE_LAYOUT_VERSION,
  type BackendTileResult,
  type TileSource,
  type TileSourceMeta,
  type TileSourceSink,
} from '@xgis/data'

const Z0_KEY = tileKey(0, 0, 0)
const DEG2RAD = Math.PI / 180
const A = 6378137 // WGS84 semi-major axis — matches the tiler + render-side `off`.
// Decoded z=0 tile-south latitude (degrees) — the EXACT value the tile catalog
// reconstructs for the synthetic z=0 tile (atan(sinh(±π))·180/π) and the value
// the render-side `off` anchor feeds through clampLat. The cap tile-corner
// ANCHOR must use THIS decoded latitude (not the rounded MERC_LAT_CLAMP) so the
// pack anchor equals the render-side tileEcefCenter EXACTLY and the RTC origins
// cancel with no residual — identical to SyntheticEarthSurfaceBackend.
const Z0_DECODED_SOUTH = Math.atan(Math.sinh(-Math.PI)) * 180 / Math.PI

/** Which pole(s) a source touches at the Mercator clamp boundary. */
export interface CapPoles {
  north: boolean
  south: boolean
}

/** Stable source-name identifier the cap backend stamps on its emitted tiles.
 *  Mirrors `VectorTileRenderer.effectiveSourceLayer`'s `show.sourceLayer ||
 *  show.targetName` resolution so the cap ShowCommand (with
 *  `targetName === capSourceName(sourceName)`) lands in the same GPU cache
 *  slot. */
export function capSourceName(sourceName: string): string {
  return `${sourceName}__polar_cap`
}

/** Build a CAP-ONLY lat/lon mesh: for each enabled pole, rows from
 *  ±MERC_LAT_CLAMP out to ±90° spanning the full −180..180 longitude band,
 *  row-major stride-2 (lon, lat) + triangle indices (two tris per cell,
 *  mirroring generateEarthSurfaceFillMesh). The ±90° row collapses to a single
 *  ECEF point — the polygon ECEF VS handles the convergence without artifacts,
 *  same as the synthetic earth-surface mesh.
 *
 *  North and south sub-meshes are concatenated; the south indices are offset by
 *  the north vertex count. */
export function generatePolarCapMesh(
  poles: CapPoles,
  widthSegments = 128,
  capRows = 8,
): { vertices: Float32Array; indices: Uint32Array } {
  const verts: number[] = []
  const indices: number[] = []
  if (poles.north) appendCap(1, widthSegments, capRows, verts, indices)
  if (poles.south) appendCap(-1, widthSegments, capRows, verts, indices)
  return { vertices: new Float32Array(verts), indices: new Uint32Array(indices) }
}

/** Append one pole's cap grid to the running vertex/index arrays. The grid runs
 *  latitudinally from the Mercator clamp boundary (row 0) to the pole (last
 *  row) and longitudinally across the full −180..180 span. */
function appendCap(
  pole: 1 | -1,
  widthSegments: number,
  capRows: number,
  verts: number[],
  indices: number[],
): void {
  const baseVert = verts.length / 2
  const cols = widthSegments + 1
  const rows = capRows + 1
  const boundaryLat = pole * MERC_LAT_CLAMP
  const poleLat = pole * 90
  for (let y = 0; y < rows; y++) {
    const t = y / capRows
    const lat = boundaryLat + (poleLat - boundaryLat) * t
    for (let x = 0; x < cols; x++) {
      const lon = -180 + (360 * x) / widthSegments
      verts.push(lon, lat)
    }
  }
  // Two triangles per grid cell — same winding as generateEarthSurfaceFillMesh.
  for (let y = 0; y < capRows; y++) {
    for (let x = 0; x < widthSegments; x++) {
      const a = baseVert + y * cols + x
      const b = a + 1
      const c = a + cols
      const d = c + 1
      indices.push(a, b, c, b, d, c)
    }
  }
}

/** Walk every polygon / multipolygon OUTER ring of a FeatureCollection and OR
 *  the clamp-boundary poles each touches. Returns `{ north, south }` — both
 *  false when no ring reaches either Mercator pole boundary (no cap needed).
 *  Inner rings (holes) are intentionally excluded, matching
 *  polar-cap-detect.ts's polygonRingsOf. */
export function detectCapPoles(data: GeoJSONFeatureCollection): CapPoles {
  const out: CapPoles = { north: false, south: false }
  if (!data || !Array.isArray(data.features)) return out
  for (const feat of data.features) {
    const geom = feat?.geometry as { type?: string; coordinates?: unknown } | null | undefined
    if (!geom) continue
    for (const ring of outerRingsOf(geom)) {
      for (const span of findClampBoundarySpans(ring)) {
        if (span.pole === 1) out.north = true
        else out.south = true
      }
    }
    if (out.north && out.south) break
  }
  return out
}

type LonLat = [number, number]

function outerRingsOf(g: { type?: string; coordinates?: unknown }): LonLat[][] {
  if (g.type === 'Polygon') {
    const coords = g.coordinates as LonLat[][] | undefined
    return coords && coords.length > 0 && coords[0] ? [coords[0]] : []
  }
  if (g.type === 'MultiPolygon') {
    const out: LonLat[][] = []
    for (const poly of (g.coordinates as LonLat[][][] | undefined) ?? []) {
      if (poly.length > 0 && poly[0]) out.push(poly[0])
    }
    return out
  }
  return []
}

/** TileSource backend serving a single z=0 tile that fills a GeoJSON source's
 *  ±5° polar hole. Mirrors SyntheticEarthSurfaceBackend: it anchors ECEF about
 *  the z=0 tile corner (the SAME decoded tile-south the synthetic backend uses)
 *  and packs the cap mesh through the shared polar-cap kernel so the rendered
 *  caps share one geoid + RTC origin with the surrounding tile polygons. */
export class GeoJSONPolarCapBackend implements TileSource {
  // bounds follows the Mercator catalog convention (±85° clamp); the cap mesh
  // intentionally exceeds it so sphere-projection rims reach the poles.
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
  private readonly stamp: string

  /** @param sourceName the host GeoJSON source name (the cap is registered
   *    under `capSourceName(sourceName)`).
   *  @param poles which pole(s) this source touches (detectCapPoles).
   *  @param fillRgba the source layer's polygon fill — caps must match it. */
  constructor(
    sourceName: string,
    private readonly poles: CapPoles,
    fillRgba: [number, number, number, number],
  ) {
    this.stamp = capSourceName(sourceName)
    this.fillRgba = [...fillRgba]
  }

  has(key: number): boolean {
    return key === Z0_KEY
  }

  attach(sink: TileSourceSink): void {
    this.sink = sink
    // The cap tile is global and never refetched — emit immediately so the
    // catalog has it cached before the first render request.
    this.loadTile(Z0_KEY)
  }

  loadTile(key: number): void {
    if (!this.sink || key !== Z0_KEY) return
    if (!this.cachedResult) this.cachedResult = this.buildResult()
    this.sink.acceptResult(Z0_KEY, this.cachedResult, this.stamp)
  }

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
    const mesh = generatePolarCapMesh(this.poles)
    const vertexCount = mesh.vertices.length / 2

    // Anchor about the z=0 synthetic tile's ELLIPSOID corner — the SAME value
    // SyntheticEarthSurfaceBackend uses (lon=-180, lat=Z0_DECODED_SOUTH), so
    // the cap shares one RTC origin with the synthetic background + ground
    // tiles and the polygon ECEF VS origins cancel with no residual.
    const tileMx = -180 * DEG2RAD * A
    const tileMy = Math.log(Math.tan(Math.PI / 4 + Z0_DECODED_SOUTH * DEG2RAD / 2)) * A
    const ecefTileCenter = tileEcefCenterFromMerc(tileMx, tileMy)

    const q = packECEFWithPolarCaps(mesh.vertices, vertexCount, ecefTileCenter, [tileMx, tileMy])
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
