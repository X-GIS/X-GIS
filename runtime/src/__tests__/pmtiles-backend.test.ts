// Isolated unit test for PMTilesBackend — exercises the TileSource
// interface with a mock fetcher closure (no real PMTiles archive).
// Verifies:
//
//  • has() respects bounds intersection + zoom window
//  • loadTile invokes the fetcher and pushes the result via sink
//  • null fetcher result → sink.acceptResult(key, null) (empty placeholder)
//  • back-pressure: backend respects MAX_INFLIGHT and skips when
//    sink.getLoadingCount() is at the cap
//  • catalog-window predicate doesn't issue requests for off-bounds keys

import { describe, expect, it } from 'vitest'
// @ts-expect-error — no published types
import geojsonVt from 'geojson-vt'
// @ts-expect-error — no published types
import vtpbf from 'vt-pbf'
import {
  decodeMvtTile, decomposeFeatures, compileSingleTile, tileKey,
  type CompiledTile,
} from '@xgis/compiler'
import { PMTilesBackend, type PMTilesFetcher } from '../data/sources/pmtiles-backend'
import type { TileSourceSink, BackendTileResult } from '../data/tile-source'

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
  return { sink, events, getLoadingCount: () => loadingCount }
}

function buildSyntheticTile(z: number, x: number, y: number): CompiledTile | null {
  const orig = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[-20, -20], [20, -20], [20, 20], [-20, 20], [-20, -20]]] },
      properties: {},
    }],
  }
  const idx = geojsonVt(orig, { maxZoom: 0, indexMaxZoom: 0 })
  const tile = idx.getTile(z, x, y)
  if (!tile) return null
  const buf = vtpbf.fromGeojsonVt({ shapes: tile })
  const features = decodeMvtTile(buf, z, x, y)
  if (features.length === 0) return null
  const parts = decomposeFeatures(features)
  return compileSingleTile(parts, z, x, y, z)
}

describe('PMTilesBackend in isolation', () => {
  it('has() returns true for keys inside bounds + zoom window', () => {
    const fetcher: PMTilesFetcher = async () => null
    const backend = new PMTilesBackend({
      fetcher, minZoom: 0, maxZoom: 4,
      bounds: [-180, -85, 180, 85],
    })
    expect(backend.has(tileKey(0, 0, 0))).toBe(true)
    expect(backend.has(tileKey(4, 8, 5))).toBe(true)
  })

  it('has() rejects keys outside the zoom window', () => {
    const fetcher: PMTilesFetcher = async () => null
    const backend = new PMTilesBackend({
      fetcher, minZoom: 2, maxZoom: 4,
      bounds: [-180, -85, 180, 85],
    })
    expect(backend.has(tileKey(0, 0, 0))).toBe(false)
    expect(backend.has(tileKey(1, 0, 0))).toBe(false)
    expect(backend.has(tileKey(5, 0, 0))).toBe(false)
  })

  it('has() rejects keys outside bounds (Firenze-style narrow window)', () => {
    const fetcher: PMTilesFetcher = async () => null
    const backend = new PMTilesBackend({
      fetcher, minZoom: 0, maxZoom: 14,
      bounds: [11, 43, 12, 44],
    })
    // tile (4, 0, 0) covers lon [-180, -157] — does NOT overlap [11, 12]
    expect(backend.has(tileKey(4, 0, 0))).toBe(false)
    // tile (0, 0, 0) covers the whole world → intersects
    expect(backend.has(tileKey(0, 0, 0))).toBe(true)
  })

  it('loadTile invokes fetcher and pushes result via sink', async () => {
    let fetchCount = 0
    const fetcher: PMTilesFetcher = async (z, x, y) => {
      fetchCount++
      return buildSyntheticTile(z, x, y)
    }
    const backend = new PMTilesBackend({
      fetcher, minZoom: 0, maxZoom: 0,
      bounds: [-180, -85, 180, 85],
    })
    const { sink, events } = makeSink()
    backend.attach(sink)

    backend.loadTile(tileKey(0, 0, 0))
    await new Promise(r => setTimeout(r, 50))

    expect(fetchCount).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0].result).not.toBeNull()
    expect(events[0].result!.vertices.length).toBeGreaterThan(0)
  })

  it('null fetcher result becomes empty placeholder via sink', async () => {
    const fetcher: PMTilesFetcher = async () => null
    const backend = new PMTilesBackend({
      fetcher, minZoom: 0, maxZoom: 0,
      bounds: [-180, -85, 180, 85],
    })
    const { sink, events } = makeSink()
    backend.attach(sink)

    backend.loadTile(tileKey(0, 0, 0))
    await new Promise(r => setTimeout(r, 50))

    expect(events).toHaveLength(1)
    expect(events[0].result, 'null = empty placeholder').toBeNull()
  })

  it('skips fetch when sink already has the key cached', () => {
    let fetchCount = 0
    const fetcher: PMTilesFetcher = async () => { fetchCount++; return null }
    const backend = new PMTilesBackend({
      fetcher, minZoom: 0, maxZoom: 0,
      bounds: [-180, -85, 180, 85],
    })
    let cached = false
    const sink: TileSourceSink = {
      trackLoading: () => {},
      releaseLoading: () => {},
      hasTileData: () => cached,
      getLoadingCount: () => 0,
      acceptResult: () => { cached = true },
    }
    backend.attach(sink)
    cached = true  // simulate already-cached state
    backend.loadTile(tileKey(0, 0, 0))
    expect(fetchCount).toBe(0)
  })

  it('respects per-backend in-flight cap (MAX_INFLIGHT = 32)', () => {
    let fetchCount = 0
    const fetcher: PMTilesFetcher = async () => { fetchCount++; return null }
    const backend = new PMTilesBackend({
      fetcher, minZoom: 0, maxZoom: 4,
      bounds: [-180, -85, 180, 85],
    })
    let loadingCount = 32
    const sink: TileSourceSink = {
      trackLoading: () => { loadingCount++ },
      releaseLoading: () => { loadingCount-- },
      hasTileData: () => false,
      getLoadingCount: () => loadingCount,
      acceptResult: () => {},
    }
    backend.attach(sink)

    // Slot is at the cap → loadTile should be a no-op.
    backend.loadTile(tileKey(0, 0, 0))
    expect(fetchCount).toBe(0)
  })

  it('meta carries the constructor params', () => {
    const fetcher: PMTilesFetcher = async () => null
    const backend = new PMTilesBackend({
      fetcher, minZoom: 2, maxZoom: 14,
      bounds: [11, 43, 12, 44],
    })
    expect(backend.meta.minZoom).toBe(2)
    expect(backend.meta.maxZoom).toBe(14)
    expect(backend.meta.bounds).toEqual([11, 43, 12, 44])
    expect(backend.meta.entries, 'PMTiles uses lazy discovery — no preregistered entries').toBeUndefined()
  })
})
