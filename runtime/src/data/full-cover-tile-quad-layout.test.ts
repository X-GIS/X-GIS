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
import { tileKey, tileKeyUnpack, FILL_TILE_OVERLAP_FRAC } from '@xgis/compiler'
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
    const tileSpanLon = tileEast - tileWest
    const absLon0 = verts[4]!
    const absLat0 = verts[5]!
    // Corner 0 is the SW corner, widened OUTWARD by FILL_TILE_OVERLAP_FRAC
    // (inter-tile seam fix). lon is linear in Mercator x, so its widened value
    // is exact: tileWest − span·frac. abs_lat must sit at the (slightly widened)
    // SOUTH edge — crucially NOT at the pre-fix sentinel (0 / fid), which would
    // be tens of degrees north. Exact widening is pinned by the test below.
    expect(absLon0).toBeCloseTo(tileWest - tileSpanLon * FILL_TILE_OVERLAP_FRAC, 1)
    expect(absLat0).toBeLessThanOrEqual(tileSouth + 1e-3) // south corner, not fid/north
    expect(absLat0).toBeGreaterThan(tileSouth - 10)       // widened south, not garbage
  })

  it('synthesised quad is widened by FILL_TILE_OVERLAP_FRAC (inter-tile seam fix)', () => {
    const catalog = new TileCatalog()
    const backend = makeMockBackend()
    catalog.attachBackend(backend)

    const key = tileKey(3, 4, 3)
    backend.pushResult(key, fullCoverResult(7))
    const data = catalog.getTileData(key)!

    // abs_lon at float slot 4 of each stride-6 corner (SW, SE, NE, NW).
    const verts = data.vertices
    const absLon = [verts[4]!, verts[10]!, verts[16]!, verts[22]!]
    const span = Math.max(...absLon) - Math.min(...absLon)

    const [tz, tx] = tileKeyUnpack(key)
    const tn = Math.pow(2, tz)
    const tileSpanLon = ((tx + 1) / tn * 360 - 180) - (tx / tn * 360 - 180)

    // Mercator x is linear in lon, so the widened quad's abs_lon span equals the
    // tile span scaled by (1 + 2·frac). Pre-fix (exact corners) span == tile span.
    expect(span / tileSpanLon).toBeCloseTo(1 + 2 * FILL_TILE_OVERLAP_FRAC, 3)
  })
})
