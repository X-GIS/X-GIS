// Isolated unit test for PMTilesBackend — exercises the TileSource
// interface with a mock fetcher closure (no real PMTiles archive).
// PMTilesBackend now uses a two-stage pipeline:
//   1. loadTile() fetches raw MVT bytes async and queues them.
//   2. tick() drains the queue (paced) — runs decode + compile +
//      pushes via sink.
// The test exercises both stages so failures surface at the right
// boundary.

import { describe, expect, it } from 'vitest'
// @ts-expect-error — no published types
import geojsonVt from 'geojson-vt'
// @ts-expect-error — no published types
import vtpbf from 'vt-pbf'
import { tileKey } from '@xgis/compiler'
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

/** Build raw MVT bytes for a synthetic polygon at (z, x, y). */
function buildSyntheticMvt(z: number, x: number, y: number): Uint8Array | null {
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
  return new Uint8Array(vtpbf.fromGeojsonVt({ shapes: tile }))
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
    expect(backend.has(tileKey(4, 0, 0))).toBe(false)
    expect(backend.has(tileKey(0, 0, 0))).toBe(true)
  })

  it('loadTile fetches bytes; tick decodes + compiles + pushes via sink', async () => {
    let fetchCount = 0
    const fetcher: PMTilesFetcher = async (z, x, y) => {
      fetchCount++
      return buildSyntheticMvt(z, x, y)
    }
    const backend = new PMTilesBackend({
      fetcher, minZoom: 0, maxZoom: 0,
      bounds: [-180, -85, 180, 85],
    })
    const { sink, events } = makeSink()
    backend.attach(sink)

    backend.loadTile(tileKey(0, 0, 0))
    await new Promise(r => setTimeout(r, 50))
    // Before tick: bytes queued, but no acceptResult yet.
    expect(fetchCount).toBe(1)
    expect(events, 'tick has not run — no acceptResult yet').toHaveLength(0)

    backend.tick(4)
    expect(events).toHaveLength(1)
    expect(events[0].result).not.toBeNull()
    expect(events[0].result!.vertices.length).toBeGreaterThan(0)
  })

  it('null fetcher result becomes empty placeholder via sink (immediate, no tick needed)', async () => {
    const fetcher: PMTilesFetcher = async () => null
    const backend = new PMTilesBackend({
      fetcher, minZoom: 0, maxZoom: 0,
      bounds: [-180, -85, 180, 85],
    })
    const { sink, events } = makeSink()
    backend.attach(sink)

    backend.loadTile(tileKey(0, 0, 0))
    await new Promise(r => setTimeout(r, 50))
    // Null fetch result short-circuits — no compile work to defer.
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

  it('respects per-backend in-flight cap (MAX_INFLIGHT)', () => {
    let fetchCount = 0
    const fetcher: PMTilesFetcher = async () => { fetchCount++; return null }
    const backend = new PMTilesBackend({
      fetcher, minZoom: 0, maxZoom: 4,
      bounds: [-180, -85, 180, 85],
    })
    let loadingCount = 16
    const sink: TileSourceSink = {
      trackLoading: () => { loadingCount++ },
      releaseLoading: () => { loadingCount-- },
      hasTileData: () => false,
      getLoadingCount: () => loadingCount,
      acceptResult: () => {},
    }
    backend.attach(sink)
    backend.loadTile(tileKey(0, 0, 0))
    expect(fetchCount).toBe(0)
  })

  it('tick paces compile work — only maxOps tiles compiled per call', async () => {
    // Always return bytes for ANY (z, x, y) so all fetches queue
    // (bypasses the null short-circuit which would push immediately).
    const sharedBytes = buildSyntheticMvt(0, 0, 0)!
    let fetchCount = 0
    const fetcher: PMTilesFetcher = async () => {
      fetchCount++
      return sharedBytes
    }
    const backend = new PMTilesBackend({
      fetcher, minZoom: 0, maxZoom: 4,
      bounds: [-180, -85, 180, 85],
    })
    const { sink, events } = makeSink()
    backend.attach(sink)

    for (let i = 0; i < 10; i++) {
      backend.loadTile(tileKey(0, 0, 0) + i)
    }
    await new Promise(r => setTimeout(r, 100))
    expect(fetchCount).toBe(10)
    expect(events, 'no tick yet — nothing compiled').toHaveLength(0)

    backend.tick(3)
    expect(events, 'first tick compiles 3').toHaveLength(3)
    backend.tick(3)
    expect(events, 'second tick compiles 3 more').toHaveLength(6)
    backend.tick(10)
    expect(events, 'third tick drains the rest (4 left)').toHaveLength(10)
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
