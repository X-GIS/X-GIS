// Phase 2 PR 2c.3 — US-001 — SyntheticEarthSurfaceBackend unit tests.
//
// Covers AC2c.3.1 surface shape:
//   - meta exposes web-mercator-xyz scheme + TILE_LAYOUT_VERSION + z=0 only.
//   - loadTile pushes exactly one BackendTileResult with 561 verts × stride-9
//     and 3072 indices (32x16 grid).
//   - Corner verts reconstruct the ±180° × ±90° band via abs_lon/abs_lat.
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

  it('emits 561 verts × stride-9 + 3072 indices from 32x16 grid', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const result = pushed[0].result!
    expect(result.vertices.length).toBe(561 * 9)
    expect(result.indices.length).toBe(32 * 16 * 6)
    expect(result.lineVertices.length).toBe(0)
    expect(result.lineIndices.length).toBe(0)
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
  it('first vertex sits at lon=-180, lat=-90 (south-west pole of sphere band)', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const v = pushed[0].result!.vertices
    expect(v[7]).toBeCloseTo(-180, 6)  // abs_lon
    expect(v[8]).toBeCloseTo(-90, 6)   // abs_lat
  })

  it('last vertex sits at lon=+180, lat=+90 (north-east pole)', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const v = pushed[0].result!.vertices
    const last = (561 - 1) * 9
    expect(v[last + 7]).toBeCloseTo(180, 6)
    expect(v[last + 8]).toBeCloseTo(90, 6)
  })

  it('DSFUN hi+lo at corner reconstructs ECEF magnitude ≈ Earth radius', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const v = pushed[0].result!.vertices
    // Sample the mid-row, mid-col vertex — lon=0, lat=0 → ECEF (A, 0, 0).
    // Mid row index = 8 (heightSegments/2), mid col index = 16 (widthSegments/2).
    const cols = 33
    const midRow = 8
    const midCol = 16
    const idx = midRow * cols + midCol
    const base = idx * 9
    const ex = v[base] + v[base + 3]   // hi + lo
    const ey = v[base + 1] + v[base + 4]
    const ez = v[base + 2] + v[base + 5]
    // At lon=0, lat=0: ECEF = (A, 0, 0). Sphere radius A = 6378137.
    expect(ex).toBeCloseTo(A, 0)   // ≤1 m DSFUN precision at world-center anchor
    expect(ey).toBeCloseTo(0, 0)
    expect(ez).toBeCloseTo(0, 0)
    // abs_lon/abs_lat at the same vertex
    expect(v[base + 7]).toBeCloseTo(0, 6)
    expect(v[base + 8]).toBeCloseTo(0, 6)
  })

  it('feat_id is 0 for every vertex (single synthetic feature)', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const v = pushed[0].result!.vertices
    for (let i = 0; i < 561; i++) {
      expect(v[i * 9 + 6]).toBe(0)
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
