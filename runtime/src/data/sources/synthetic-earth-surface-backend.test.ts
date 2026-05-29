// Phase 2 PR 2c.3 — US-001 — SyntheticEarthSurfaceBackend unit tests.
//
// Covers AC2c.3.1 surface shape:
//   - meta exposes web-mercator-xyz scheme + TILE_LAYOUT_VERSION + z=0 only.
//   - loadTile pushes exactly one BackendTileResult with 561 verts × stride-9
//     and 3072 indices (32x16 grid).
//   - Corner verts reconstruct the per-projType band (sphere ±90°, mercator
//     ±85°) via abs_lon/abs_lat.
//   - DSFUN hi+lo reconstructs ECEF metres at sphere magnitudes.

import { describe, it, expect } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { SyntheticEarthSurfaceBackend } from './synthetic-earth-surface-backend'
import {
  TILE_LAYOUT_VERSION,
  type BackendTileResult,
  type TileSourceSink,
} from '../tile-source'

// WGS84 semi-major axis — matches ecef.ts lonLatToECEFSphere radius.
const A = 6378137

function makeRecordingSink(): {
  sink: TileSourceSink
  pushed: { key: number; result: BackendTileResult | null }[]
} {
  const pushed: { key: number; result: BackendTileResult | null }[] = []
  const sink: TileSourceSink = {
    trackLoading: () => {},
    releaseLoading: () => {},
    hasTileData: () => false,
    getLoadingCount: () => 0,
    acceptResult: (key, result) => { pushed.push({ key, result }) },
  }
  return { sink, pushed }
}

describe('SyntheticEarthSurfaceBackend — meta shape', () => {
  it('reports web-mercator-xyz scheme, current TILE_LAYOUT_VERSION, single z=0 tile', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    expect(backend.meta.scheme).toBe('web-mercator-xyz')
    expect(backend.meta.layoutVersion).toBe(TILE_LAYOUT_VERSION)
    expect(backend.meta.minZoom).toBe(0)
    expect(backend.meta.maxZoom).toBe(0)
    expect(backend.meta.bounds).toEqual([-180, -85, 180, 85])
  })

  it('has(key) returns true only for tileKey(0,0,0)', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    expect(backend.has(tileKey(0, 0, 0))).toBe(true)
    expect(backend.has(tileKey(1, 0, 0))).toBe(false)
    expect(backend.has(tileKey(2, 1, 1))).toBe(false)
  })
})

describe('SyntheticEarthSurfaceBackend — attach + loadTile', () => {
  it('attach pushes the z=0 tile result synchronously', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    expect(pushed.length).toBe(1)
    expect(pushed[0].key).toBe(tileKey(0, 0, 0))
    expect(pushed[0].result).not.toBeNull()
  })

  it('emits 561 verts × stride-6 (PR 2f quantized) + 3072 indices from 32x16 grid', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const result = pushed[0].result!
    expect(result.vertices.length).toBe(561 * 6)
    expect(result.indices.length).toBe(32 * 16 * 6)
    expect(result.lineVertices.length).toBe(0)
    expect(result.lineIndices.length).toBe(0)
    // Quantized buffer must carry its dequant companion params.
    expect(result.dequantScale).toBeGreaterThan(0)
    expect(result.dequantHalf).toBeGreaterThan(0)
  })

  it('loadTile(z=0 key) re-pushes the cached result object without rebuilding', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    backend.loadTile(tileKey(0, 0, 0))
    expect(pushed.length).toBe(2)
    expect(pushed[1].result).toBe(pushed[0].result)
  })

  it('loadTile ignores non-z0 keys', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    backend.loadTile(tileKey(1, 0, 0))
    expect(pushed.length).toBe(1)
  })
})

describe('SyntheticEarthSurfaceBackend — vertex content', () => {
  // PR 2f: position is quantized u16×6 in the first 12 bytes (floats 0..2);
  // f32 tail is fid(3), abs_lon(4), abs_lat(5). Dequant a position axis from
  // the u16 lanes: q = hi*65536 + lo; axis = q*scale - half.
  const dequantAxis = (u16: Uint16Array, lane: number, scale: number, half: number): number => {
    const q = u16[lane] * 65536 + u16[lane + 1]
    return q * scale - half
  }

  it('first vertex sits at lon=-180, lat=-90 (south-west pole, sphere band projType 7)', () => {
    const backend = new SyntheticEarthSurfaceBackend(7)
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const v = pushed[0].result!.vertices
    expect(v[4]).toBeCloseTo(-180, 6)  // abs_lon
    expect(v[5]).toBeCloseTo(-90, 6)   // abs_lat
  })

  it('last vertex sits at lon=+180, lat=+90 (north-east pole, sphere band projType 7)', () => {
    const backend = new SyntheticEarthSurfaceBackend(7)
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const v = pushed[0].result!.vertices
    const last = (561 - 1) * 6
    expect(v[last + 4]).toBeCloseTo(180, 6)
    expect(v[last + 5]).toBeCloseTo(90, 6)
  })

  it('quantized position at corner reconstructs ECEF magnitude ≈ Earth radius', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const result = pushed[0].result!
    const v = result.vertices
    const u16 = new Uint16Array(v.buffer)
    // Sample the mid-row, mid-col vertex — lon=0, lat=0 → ECEF (A, 0, 0).
    // Mid row index = 8 (heightSegments/2), mid col index = 16 (widthSegments/2).
    const cols = 33
    const idx = 8 * cols + 16
    const lane = idx * 12   // u16 lane base (12 lanes / vertex)
    const { dequantScale: scale, dequantHalf: half } = result
    // Dequant is the RTC residual about WORLD_ANCHOR = (0,0,0), so the
    // reconstructed axis IS the absolute sphere ECEF at world-center anchor.
    const ex = dequantAxis(u16, lane, scale, half)
    const ey = dequantAxis(u16, lane + 2, scale, half)
    const ez = dequantAxis(u16, lane + 4, scale, half)
    // At lon=0, lat=0: ECEF = (A, 0, 0). Sphere radius A = 6378137.
    // double-u16 over a ~6.4e6 m range → ~3 mm step; 0.01 m tolerance.
    expect(ex).toBeCloseTo(A, 1)
    expect(ey).toBeCloseTo(0, 1)
    expect(ez).toBeCloseTo(0, 1)
    // abs_lon/abs_lat at the same vertex (f32 tail).
    expect(v[idx * 6 + 4]).toBeCloseTo(0, 6)
    expect(v[idx * 6 + 5]).toBeCloseTo(0, 6)
  })

  it('feat_id is 0 for every vertex (single synthetic feature)', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const v = pushed[0].result!.vertices
    for (let i = 0; i < 561; i++) {
      expect(v[i * 6 + 3]).toBe(0)
    }
  })
})

describe('SyntheticEarthSurfaceBackend — fill color', () => {
  it('updateFillColor stores the rgba quad for downstream consumers', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    backend.updateFillColor([0.1, 0.2, 0.3, 0.4])
    expect(Array.from(backend.getFillColor())).toEqual([0.1, 0.2, 0.3, 0.4])
  })

  it('defaults to transparent (alpha=0) before updateFillColor is called', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    expect(backend.getFillColor()[3]).toBe(0)
  })
})
