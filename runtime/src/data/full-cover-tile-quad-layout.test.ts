// Regression: createFullCoverTileData must emit the quantized-ECEF polygon
// fill layout (POLYGON_FILL_FORMAT, stride 24 B = 6 floats) — the SAME layout
// the fill pipeline binds (pipeline-factory.ts -> toVertexBufferLayout(
// POLYGON_FILL_FORMAT)) and the fill VS decodes (abs_lon @loc3 / abs_lat @loc4).
//
// Before the fix it emitted a stride-5 tile-local DSFUN quad ([h,0,l,0,fid]),
// so abs_lon/abs_lat were absent, the VS mis-decoded position, and the
// per-fragment clip_bounds discard was inert -> an over-zoom full-cover parent
// flooded the viewport. The CPU-detectable invariant pinned here is the buffer
// layout: length divisible by DSFUN_POLY_STRIDE (=6), 4 corners => exactly 24
// floats, a real per-tile dequant half-range (> 0, not the identity default),
// and abs_lon/abs_lat populated within the tile's lon/lat bounds.

import { describe, it, expect } from 'vitest'
import { tileKey, tileKeyUnpack } from '@xgis/compiler'
import { TileCatalog } from './tile-catalog'
import { DSFUN_POLY_STRIDE } from './tile-types'
import {
  TILE_LAYOUT_VERSION,
  type TileSource, type TileSourceSink, type BackendTileResult,
} from './tile-source'

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

describe('createFullCoverTileData quad layout (quantized-ECEF stride 6)', () => {
  it('synthesised full-cover quad matches the POLYGON_FILL_FORMAT stride', () => {
    const catalog = new TileCatalog()
    const backend = makeMockBackend()
    catalog.attachBackend(backend)

    const key = tileKey(3, 4, 3)
    backend.pushResult(key, fullCoverResult(42))

    const data = catalog.getTileData(key)
    expect(data, 'full-cover tile must be cached').not.toBeNull()

    // 4 corners. Stride-6 (quantized ECEF) => 24 floats. The pre-fix stride-5
    // buffer is 20 floats => 20 % 6 === 2 (fails), and 20 !== 24 (fails).
    expect(data!.vertices.length % DSFUN_POLY_STRIDE, 'vertex buffer must be a whole number of stride-6 vertices').toBe(0)
    expect(data!.vertices.length, '4 corners x 6 floats').toBe(4 * DSFUN_POLY_STRIDE)

    // acceptResult bookkeeping (vertexCount = vertices.length / DSFUN_POLY_STRIDE) must be
    // consistent with the actual buffer: 24 / 6 === 4 corners.
    const idx = catalog.getIndex()!
    const verts = data!.vertices
    expect(verts.length / DSFUN_POLY_STRIDE).toBe(4)
    expect(idx).toBeDefined()

    // Real per-tile dequant half-range — NOT the identity default (half 0,
    // scale 1) the pre-fix path left in place.
    expect(data!.dequantHalf, 'per-tile ECEF half-range must be a real metre span').toBeGreaterThan(0)
    expect(data!.dequantScale, 'per-tile dequant step must be positive').toBeGreaterThan(0)

    // abs_lon / abs_lat live at float slots 4 / 5 of each stride-6 vertex.
    // Corner 0 is the tile SW corner; its abs_lon/abs_lat must sit inside the
    // tile's lon/lat bounds. Pre-fix these slots held 0 / fid (no abs coords).
    const [tz, tx, ty] = tileKeyUnpack(key)
    const tn = Math.pow(2, tz)
    const tileWest = tx / tn * 360 - 180
    const tileEast = (tx + 1) / tn * 360 - 180
    const tileSouth = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + 1) / tn))) * 180 / Math.PI
    const tileNorth = Math.atan(Math.sinh(Math.PI * (1 - 2 * ty / tn))) * 180 / Math.PI
    const absLon0 = verts[4]
    const absLat0 = verts[5]
    const eps = 1e-3
    expect(absLon0).toBeGreaterThanOrEqual(tileWest - eps)
    expect(absLon0).toBeLessThanOrEqual(tileEast + eps)
    expect(absLat0).toBeGreaterThanOrEqual(tileSouth - eps)
    expect(absLat0).toBeLessThanOrEqual(tileNorth + eps)
  })
})
