// Tests for the GeoJSON compile worker logic.
//
// These tests exercise the SHARED helpers inside `geojson-compile-worker.ts`
// (`runCompile`, `resolveIdResolver`) — the same code that runs inside the
// Web Worker AND inside the pool's sync fallback. That gives full coverage
// of the earcut/serialize path without having to spawn a real worker in
// vitest (where `?worker` imports fail).
//
// The pool wrapper itself is intentionally NOT loaded here because its
// top-level `import GeoJSONWorker from './geojson-compile-worker.ts?worker'`
// triggers Vite's worker-constructor transform, which vitest can't resolve.
// A separate e2e/playwright test covers the real worker spawn path.

import { describe, expect, it } from 'vitest'
import {
  runCompile,
  resolveIdResolver,
} from '../data/geojson-compile-worker'
import type { GeoJSONFeatureCollection } from '../loader/geojson'

function makePointFC(points: [number, number][], ids?: unknown[]): GeoJSONFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: points.map((c, i) => ({
      type: 'Feature',
      id: ids?.[i],
      geometry: { type: 'Point', coordinates: c },
      properties: {},
    })),
  }
}

function makePolygonFC(): GeoJSONFeatureCollection {
  // Simple square at 0..1 lon, 0..1 lat — one polygon, 4 corners.
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
      },
      properties: { name: 'square' },
    }],
  }
}

describe('resolveIdResolver', () => {
  it('index mode returns the array index regardless of feature.id', () => {
    const r = resolveIdResolver('index')
    expect(r({ type: 'Feature', id: 99, geometry: null as unknown as null, properties: {} }, 0)).toBe(0)
    expect(r({ type: 'Feature', id: 99, geometry: null as unknown as null, properties: {} }, 5)).toBe(5)
  })

  it('feature-id-fallback honours feature.id when present', () => {
    const r = resolveIdResolver('feature-id-fallback')
    expect(r({ type: 'Feature', id: 42, geometry: null as unknown as null, properties: {} }, 0)).toBe(42)
  })

  it('feature-id-fallback falls back to properties.id, then index', () => {
    const r = resolveIdResolver('feature-id-fallback')
    expect(r({ type: 'Feature', geometry: null as unknown as null, properties: { id: 7 } }, 999)).toBe(7)
    expect(r({ type: 'Feature', geometry: null as unknown as null, properties: {} }, 3)).toBe(3)
  })
})

describe('runCompile — point features', () => {
  it('produces one tile at z0 with pointVertices matching input count', () => {
    const fc = makePointFC([[0, 0], [10, 10], [-20, 30]])
    const { response, transferables } = runCompile({
      kind: 'compile', taskId: 1, geojson: fc,
      minZoom: 0, maxZoom: 0, idResolverMode: 'feature-id-fallback',
    })

    expect(response.kind).toBe('compile-done')
    expect(response.featureCount).toBe(3)
    expect(response.parts.length).toBe(3) // one part per Point
    expect(response.levels.length).toBe(1)
    expect(response.levels[0].zoom).toBe(0)
    // z=0 has exactly one tile (the whole world), containing all 3 points.
    expect(response.levels[0].tiles.length).toBe(1)
    const tile = response.levels[0].tiles[0][1]
    expect(tile.pointVertices).toBeDefined()
    // DSFUN stride-5: (mx_h, my_h, mx_l, my_l, feat_id) × 3 points = 15 floats.
    expect(tile.pointVertices!.byteLength).toBe(3 * 5 * 4)
    // Transferables list includes the point-vertex ArrayBuffer exactly once.
    expect(transferables).toContain(tile.pointVertices)
  })

  it('idResolverMode=feature-id-fallback encodes feature.id into feat_id slot', () => {
    const fc = makePointFC([[0, 0], [5, 5]], [123, 456])
    const { response } = runCompile({
      kind: 'compile', taskId: 2, geojson: fc,
      minZoom: 0, maxZoom: 0, idResolverMode: 'feature-id-fallback',
    })
    const tile = response.levels[0].tiles[0][1]
    const pv = new Float32Array(tile.pointVertices!)
    // Stride-5; index 4 = feat_id. Two points → [?, ?, ?, ?, id0, ?, ?, ?, ?, id1]
    expect(pv[4]).toBe(123)
    expect(pv[9]).toBe(456)
  })
})

describe('runCompile — polygon features', () => {
  it('tessellates a square into two triangles (6 indices)', () => {
    const { response, transferables } = runCompile({
      kind: 'compile', taskId: 3, geojson: makePolygonFC(),
      minZoom: 0, maxZoom: 0, idResolverMode: 'index',
    })

    expect(response.featureCount).toBe(1)
    const tile = response.levels[0].tiles[0][1]
    const verts = new Float32Array(tile.vertices)
    const idx = new Uint32Array(tile.indices)

    // Earcut on a quad → 2 triangles → 6 indices.
    expect(idx.length).toBe(6)
    // Stride-5 vertex layout: 4 unique corners = 20 floats.
    expect(verts.length).toBe(4 * 5)
    // Both main arrays must be in the transferables list.
    expect(transferables).toContain(tile.vertices)
    expect(transferables).toContain(tile.indices)
  })

  it('carries the property table through the serialization boundary', () => {
    const { response } = runCompile({
      kind: 'compile', taskId: 4, geojson: makePolygonFC(),
      minZoom: 0, maxZoom: 0, idResolverMode: 'index',
    })
    expect(response.propertyTable.fieldNames).toContain('name')
    // 'name' appears once with value 'square' — the table stores it per-feature.
    const nameIdx = response.propertyTable.fieldNames.indexOf('name')
    expect(response.propertyTable.values[0][nameIdx]).toBe('square')
  })
})

describe('runCompile — edge cases', () => {
  it('empty FeatureCollection yields zero parts and zero tiles', () => {
    const { response, transferables } = runCompile({
      kind: 'compile', taskId: 5,
      geojson: { type: 'FeatureCollection', features: [] },
      minZoom: 0, maxZoom: 0, idResolverMode: 'index',
    })
    expect(response.featureCount).toBe(0)
    expect(response.parts.length).toBe(0)
    // No tiles → no buffers to transfer.
    expect(transferables.length).toBe(0)
  })

  it('all non-zero typed-array buffers end up in the transferables list', () => {
    const { response, transferables } = runCompile({
      kind: 'compile', taskId: 6, geojson: makePolygonFC(),
      minZoom: 0, maxZoom: 0, idResolverMode: 'index',
    })
    const tile = response.levels[0].tiles[0][1]
    for (const buf of [tile.vertices, tile.indices, tile.outlineIndices]) {
      if (buf.byteLength > 0) {
        expect(transferables).toContain(buf)
      }
    }
    // Every entry in the transferables list must be non-empty — empty buffers
    // are filtered by runCompile so postMessage doesn't trip on a zero-length
    // Transferable.
    for (const b of transferables) expect(b.byteLength).toBeGreaterThan(0)
  })

  it('bounds reflect the union of all feature coordinates', () => {
    const fc = makePointFC([[-50, -30], [80, 40]])
    const { response } = runCompile({
      kind: 'compile', taskId: 7, geojson: fc,
      minZoom: 0, maxZoom: 0, idResolverMode: 'index',
    })
    const [minLon, minLat, maxLon, maxLat] = response.bounds
    expect(minLon).toBeCloseTo(-50)
    expect(minLat).toBeCloseTo(-30)
    expect(maxLon).toBeCloseTo(80)
    expect(maxLat).toBeCloseTo(40)
  })
})
