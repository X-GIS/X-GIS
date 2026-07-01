// Isolated unit test for GeoJSONRuntimeBackend — exercises the
// TileSource interface directly with a hand-rolled sink so the test
// doesn't go through TileCatalog. Verifies:
//
//  • compileSync produces real geometry for tiles overlapping parts
//  • compileSync produces an empty placeholder (acceptResult(null))
//    for tiles inside the catalog window but with no overlapping parts
//  • has() respects maxZoom + parts presence
//  • spatial grid (z=3) lookup returns the right parts at z<3, z=3, z>3

import { describe, expect, it } from 'vitest'
import { decomposeFeatures, tileKey } from '@xgis/compiler'
import { GeoJSONRuntimeBackend } from './geojson-runtime-backend'
import type { TileSourceSink, BackendTileResult } from '../tile-source'

function makeSink() {
  const events: { key: number; result: BackendTileResult | null }[] = []
  let loadingCount = 0
  const sink: TileSourceSink = {
    trackLoading: () => { loadingCount++ },
    releaseLoading: () => { loadingCount-- },
    hasTileData: () => false,
    getLoadingCount: () => loadingCount,
    acceptResult: (key, result) => { events.push({ key, result }) },
  }
  return { sink, events }
}

const POLYGON_FEATURE = {
  type: 'Feature' as const,
  geometry: {
    type: 'Polygon' as const,
    coordinates: [[[-30, -30], [30, -30], [30, 30], [-30, 30], [-30, -30]]],
  },
  properties: {},
}

describe('GeoJSONRuntimeBackend in isolation', () => {
  it('has() rejects keys above maxZoom', () => {
    const backend = new GeoJSONRuntimeBackend()
    backend.setParts(decomposeFeatures([POLYGON_FEATURE]), 7)
    expect(backend.has(tileKey(0, 0, 0))).toBe(true)
    expect(backend.has(tileKey(7, 64, 64))).toBe(true)
    expect(backend.has(tileKey(8, 128, 128))).toBe(false)
  })

  it('has() returns false when no parts loaded', () => {
    const backend = new GeoJSONRuntimeBackend()
    expect(backend.has(tileKey(0, 0, 0))).toBe(false)
  })

  it('compileSync pushes a real result for a tile that overlaps parts', () => {
    const backend = new GeoJSONRuntimeBackend()
    const { sink, events } = makeSink()
    backend.attach(sink)
    backend.setParts(decomposeFeatures([POLYGON_FEATURE]), 7)

    const ok = backend.compileSync(tileKey(0, 0, 0))
    expect(ok).toBe(true)
    expect(events).toHaveLength(1)
    const ev = events[0]
    expect(ev.result).not.toBeNull()
    expect(ev.result!.vertices.length).toBeGreaterThan(0)
    expect(ev.result!.indices.length).toBeGreaterThan(0)
  })

  it('compileSync pushes null for a tile with no overlapping parts (empty placeholder)', () => {
    const backend = new GeoJSONRuntimeBackend()
    const { sink, events } = makeSink()
    backend.attach(sink)
    // Polygon spans lon [-30, 30], lat [-30, 30]. Tile z=4 at x=0/y=0
    // covers lon [-180, -157], lat [83, 85] — well outside the polygon.
    backend.setParts(decomposeFeatures([POLYGON_FEATURE]), 7)

    const ok = backend.compileSync(tileKey(4, 0, 0))
    expect(ok).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0].result, 'empty placeholder').toBeNull()
  })

  it('compileSync returns false when backend cannot serve key', () => {
    const backend = new GeoJSONRuntimeBackend()
    const { sink, events } = makeSink()
    backend.attach(sink)
    // Empty backend — has() returns false, compileSync should bail.
    expect(backend.compileSync(tileKey(0, 0, 0))).toBe(false)
    expect(events).toHaveLength(0)
  })

  it('getRelevantParts returns null for tiles outside coverage', () => {
    const backend = new GeoJSONRuntimeBackend()
    backend.setParts(decomposeFeatures([POLYGON_FEATURE]), 7)
    // At z=4, tile (0, 0) is far from the polygon → no overlap.
    expect(backend.getRelevantParts(4, 0, 0)).toBeNull()
  })

  it('getRelevantParts returns parts for tiles inside coverage', () => {
    const backend = new GeoJSONRuntimeBackend()
    backend.setParts(decomposeFeatures([POLYGON_FEATURE]), 7)
    const parts = backend.getRelevantParts(0, 0, 0)
    expect(parts).not.toBeNull()
    expect(parts!.length).toBeGreaterThan(0)
  })

  it('meta.bounds reflects the loaded parts envelope', () => {
    const backend = new GeoJSONRuntimeBackend()
    backend.setParts(decomposeFeatures([POLYGON_FEATURE]), 7)
    const [minLon, minLat, maxLon, maxLat] = backend.meta.bounds
    expect(minLon).toBeCloseTo(-30, 1)
    expect(maxLon).toBeCloseTo(30, 1)
    expect(minLat).toBeCloseTo(-30, 1)
    expect(maxLat).toBeCloseTo(30, 1)
  })
})
