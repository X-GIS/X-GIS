// Regression: createFullCoverTileData must emit the quantized-ECEF polygon
// fill layout (POLYGON_FILL_FORMAT, stride 28 B = 7 floats, #398) — the SAME
// layout the fill pipeline binds (pipeline-factory.ts -> toVertexBufferLayout(
// POLYGON_FILL_FORMAT)) and the fill VS decodes (abs_lon @loc3 / abs_lat @loc4
// / true_lat @loc5).
//
// Before the fix it emitted a stride-5 tile-local DSFUN quad ([h,0,l,0,fid]),
// so abs_lon/abs_lat were absent, the VS mis-decoded position, and the
// per-fragment clip_bounds discard was inert -> an over-zoom full-cover parent
// flooded the viewport. The CPU-detectable invariant pinned here is the buffer
// layout: length divisible by DSFUN_POLY_STRIDE (=7), 4 corners => exactly 28
// floats, a real per-tile dequant half-range (> 0, not the identity default),
// and abs_lon/abs_lat populated within the tile's lon/lat bounds.

import { describe, it, expect } from 'vitest'
import { tileKey, tileKeyUnpack } from '@xgis/compiler'
import { TileCatalog } from '@xgis/data'
import { DSFUN_POLY_STRIDE } from '@xgis/data'
import {
  TILE_LAYOUT_VERSION,
  type TileSource, type TileSourceSink, type BackendTileResult,
} from '@xgis/data'

// Minimal mock backend that lets the test drive sink.acceptResult directly
// (same pattern as tile-data-origin-backend.test.ts). attachBackend lazily
// creates catalog.index via mergeBackendMeta, which acceptResult needs to
// synthesise the full-cover entry and route to createFullCoverTileData.
function makeMockBackend(): TileSource & {
  pushResult(key: number, result: BackendTileResult | null, sourceLayer?: string): void
} {
  let sink: TileSourceSink | null = null
  return {
    get meta() {
      return {
        bounds: [-180, -85, 180, 85] as [number, number, number, number],
        minZoom: 0,
        maxZoom: 6,
        scheme: 'web-mercator-xyz' as const,
        layoutVersion: TILE_LAYOUT_VERSION,
      }
    },
    has: () => true,
    attach(s) { sink = s },
    loadTile(key) { sink?.trackLoading(key) },
    pushResult(key, result, sourceLayer) {
      sink!.acceptResult(key, result, sourceLayer)
    },
  }
}

// A full-cover producer result: empty vertices + fullCover flag tells the
// catalog to synthesise the quad via createFullCoverTileData.
function fullCoverResult(fid: number): BackendTileResult {
  return {
    vertices: new Float32Array(0),
    dequantScale: 0,
    dequantHalf: 0,
    indices: new Uint32Array(0),
    lineVertices: new Float32Array(0),
    lineIndices: new Uint32Array(0),
    fullCover: true,
    fullCoverFeatureId: fid,
  }
}

describe('createFullCoverTileData quad layout (quantized-ECEF stride 7)', () => {
  it('synthesised full-cover quad matches the POLYGON_FILL_FORMAT stride', () => {
    const catalog = new TileCatalog()
    const backend = makeMockBackend()
    catalog.attachBackend(backend)

    const key = tileKey(3, 4, 3)
    backend.pushResult(key, fullCoverResult(42))

    const data = catalog.getTileData(key)
    expect(data, 'full-cover tile must be cached').not.toBeNull()

    // 4 corners. Stride-7 (quantized ECEF + true_lat, #398) => 28 floats.
    expect(data!.vertices.length % DSFUN_POLY_STRIDE, 'vertex buffer must be a whole number of stride-7 vertices').toBe(0)
    expect(data!.vertices.length, '4 corners x 7 floats').toBe(4 * DSFUN_POLY_STRIDE)

    // acceptResult bookkeeping (vertexCount = vertices.length / DSFUN_POLY_STRIDE) must be
    // consistent with the actual buffer: 28 / 7 === 4 corners.
    const idx = catalog.getIndex()!
    const verts = data!.vertices
    expect(verts.length / DSFUN_POLY_STRIDE).toBe(4)
    expect(idx).toBeDefined()

    // Real per-tile dequant half-range — NOT the identity default (half 0,
    // scale 1) the pre-fix path left in place.
    expect(data!.dequantHalf, 'per-tile ECEF half-range must be a real metre span').toBeGreaterThan(0)
    expect(data!.dequantScale, 'per-tile dequant step must be positive').toBeGreaterThan(0)

    // Float slots 4 / 5 now hold TILE-LOCAL Mercator (vertex_merc −
    // tileOriginMerc), NOT absolute lon/lat degrees. Reconstruct absolute
    // lon/lat (origin + local) and assert vertex 0 sits inside the tile's
    // bounds. Pre-fix these slots held absolute degrees (and earlier 0 / fid).
    const [tz, tx, ty] = tileKeyUnpack(key)
    const tn = Math.pow(2, tz)
    const tileWest = tx / tn * 360 - 180
    const tileEast = (tx + 1) / tn * 360 - 180
    const tileSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / tn))) * 180 / Math.PI
    const tileNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / tn))) * 180 / Math.PI
    const R = 6378137
    const D2R = Math.PI / 180
    const tileOriginMx = tileWest * D2R * R
    const tileOriginMy = Math.log(Math.tan(Math.PI / 4 + tileSouth * D2R / 2)) * R
    const absMx0 = verts[4] + tileOriginMx
    const absMy0 = verts[5] + tileOriginMy
    const lon0 = absMx0 / (D2R * R)
    const lat0 = (2 * Math.atan(Math.exp(absMy0 / R)) - Math.PI / 2) / D2R
    const eps = 1e-3
    expect(lon0).toBeGreaterThanOrEqual(tileWest - eps)
    expect(lon0).toBeLessThanOrEqual(tileEast + eps)
    expect(lat0).toBeGreaterThanOrEqual(tileSouth - eps)
    expect(lat0).toBeLessThanOrEqual(tileNorth + eps)
  })

  // #449 — the tail must be TILE-LOCAL Mercator (mx − tileOriginMerc), so
  // createFullCoverTileData MUST pass tileOriginMerc to the packer. Omitting it
  // defaulted to [0,0] → the tail held ABSOLUTE Mercator → the flat fill VS
  // double-counted tile_origin_merc → the full-cover quad rendered off-tile
  // (pure-ocean tiles showed the background colour). The prior test used tile
  // (3,4,3) where tileWest=0 AND tileSouth=0, so [0,0] coincided with the real
  // origin and MASKED the bug — this uses a tile with a NON-zero origin so the
  // absolute-vs-local mistake throws the reconstructed corner out of bounds.
  it('full-cover quad tail is tile-local at a non-zero-origin tile (#449)', () => {
    const catalog = new TileCatalog()
    const backend = makeMockBackend()
    catalog.attachBackend(backend)

    const key = tileKey(3, 6, 2) // lon ∈ [90,135], lat ∈ [~40.9,~66.5] — origin ≠ 0
    backend.pushResult(key, fullCoverResult(7))
    const data = catalog.getTileData(key)
    expect(data, 'full-cover tile must be cached').not.toBeNull()

    const [tz, tx, ty] = tileKeyUnpack(key)
    const tn = Math.pow(2, tz)
    const tileWest = tx / tn * 360 - 180
    const tileEast = (tx + 1) / tn * 360 - 180
    const tileSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / tn))) * 180 / Math.PI
    const tileNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / tn))) * 180 / Math.PI
    const R = 6378137, D2R = Math.PI / 180
    const tileOriginMx = tileWest * D2R * R
    const tileOriginMy = Math.log(Math.tan(Math.PI / 4 + tileSouth * D2R / 2)) * R
    const verts = data!.vertices
    const eps = 1e-3
    // Every corner: local_merc (slots 4/5) + origin must reconstruct INSIDE the
    // tile. Fails-before (tail = absolute → reconstruct ≈ 2× → out of bounds).
    for (let c = 0; c < 4; c++) {
      const lon = (verts[c * DSFUN_POLY_STRIDE + 4] + tileOriginMx) / (D2R * R)
      const absMy = verts[c * DSFUN_POLY_STRIDE + 5] + tileOriginMy
      const lat = (2 * Math.atan(Math.exp(absMy / R)) - Math.PI / 2) / D2R
      expect(lon, `corner ${c} lon in [${tileWest},${tileEast}]`).toBeGreaterThanOrEqual(tileWest - eps)
      expect(lon, `corner ${c} lon in [${tileWest},${tileEast}]`).toBeLessThanOrEqual(tileEast + eps)
      expect(lat, `corner ${c} lat in [${tileSouth},${tileNorth}]`).toBeGreaterThanOrEqual(tileSouth - eps)
      expect(lat, `corner ${c} lat in [${tileSouth},${tileNorth}]`).toBeLessThanOrEqual(tileNorth + eps)
    }
  })
})
