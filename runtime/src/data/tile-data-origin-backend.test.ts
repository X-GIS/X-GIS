// TileData.originBackend reverse pointer — PR 2c.1 Task #5
//
// Verifies that every TileData stored in TileCatalog.dataCache carries the
// exact TileSource backend that produced it, as set by the per-backend sink
// closure in TileCatalog.makeSink. Used by evictTilesForBackend (PR 2c.5)
// for per-backend cache invalidation on TILE_LAYOUT_VERSION mismatch.

import { describe, it, expect } from 'vitest'
import { tileKey, decomposeFeatures } from '@xgis/compiler'
import { TileCatalog } from './tile-catalog'
import { GeoJSONRuntimeBackend } from './sources/geojson-runtime-backend'
import { PMTilesBackend, type PMTilesFetcher } from './sources/pmtiles-backend'
import {
  TILE_LAYOUT_VERSION,
  type TileSource, type TileSourceSink, type BackendTileResult,
} from '@xgis/data'

// ─── Minimal mock TileSource ──────────────────────────────────────────────────
// Implements the TileSource protocol with the smallest viable surface.
// The mock's attach() captures the sink, then the test manually drives
// sink.acceptResult to push a BackendTileResult — no real fetch needed.

function makeMockBackend(id: string): TileSource & { pushResult(key: number, result: BackendTileResult | null, sourceLayer?: string): void } {
  let _sink: TileSourceSink | null = null
  const backend: TileSource & { pushResult(key: number, result: BackendTileResult | null, sourceLayer?: string): void } = {
    get meta() {
      return {
        bounds: [-180, -85, 180, 85] as [number, number, number, number],
        minZoom: 0,
        maxZoom: 4,
        scheme: 'web-mercator-xyz' as const,
        layoutVersion: TILE_LAYOUT_VERSION,
      }
    },
    has: (_key) => true,
    attach(sink) { _sink = sink },
    loadTile(key) { _sink?.trackLoading(key) },
    pushResult(key, result, sourceLayer) {
      _sink!.acceptResult(key, result, sourceLayer)
    },
  }
  // Tag with id for debugging (not part of the TileSource interface)
  ;(backend as unknown as { _id: string })._id = id
  return backend
}

const EMPTY_RESULT: BackendTileResult = {
  vertices: new Float32Array(0),
  dequantScale: 0,
  dequantHalf: 0,
  indices: new Uint32Array(0),
  lineVertices: new Float32Array(0),
  lineIndices: new Uint32Array(0),
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TileData.originBackend reverse pointer (PR 2c.1 Task #5)', () => {
  it('single mock backend: originBackend === that backend', () => {
    const catalog = new TileCatalog()
    const backend = makeMockBackend('A')
    catalog.attachBackend(backend)

    const key = tileKey(0, 0, 0)
    backend.pushResult(key, EMPTY_RESULT)

    const data = catalog.getTileData(key)
    expect(data, 'tile must be cached after acceptResult').not.toBeNull()
    expect(data!.originBackend, 'originBackend must be the producing backend').toBe(backend)
  })

  it('two mock backends: each tile carries its own producing backend', () => {
    const catalog = new TileCatalog()
    const backendA = makeMockBackend('A')
    const backendB = makeMockBackend('B')
    catalog.attachBackend(backendA)
    catalog.attachBackend(backendB)

    const keyA = tileKey(1, 0, 0)
    const keyB = tileKey(1, 1, 0)
    backendA.pushResult(keyA, EMPTY_RESULT)
    backendB.pushResult(keyB, EMPTY_RESULT)

    const dataA = catalog.getTileData(keyA)
    const dataB = catalog.getTileData(keyB)

    expect(dataA!.originBackend).toBe(backendA)
    expect(dataB!.originBackend).toBe(backendB)
    // Cross-check: each tile does NOT carry the other backend
    expect(dataA!.originBackend).not.toBe(backendB)
    expect(dataB!.originBackend).not.toBe(backendA)
  })

  it('null result (empty placeholder): originBackend still set', () => {
    const catalog = new TileCatalog()
    const backend = makeMockBackend('A')
    catalog.attachBackend(backend)

    const key = tileKey(2, 0, 0)
    backend.pushResult(key, null)

    const data = catalog.getTileData(key)
    expect(data, 'null result produces an empty placeholder in cache').not.toBeNull()
    expect(data!.originBackend).toBe(backend)
  })

  it('per-MVT-layer slices: originBackend set on each slice', () => {
    const catalog = new TileCatalog()
    const backend = makeMockBackend('A')
    catalog.attachBackend(backend)

    const key = tileKey(1, 0, 0)
    backend.pushResult(key, EMPTY_RESULT, 'water')
    backend.pushResult(key, EMPTY_RESULT, 'landuse')

    const water = catalog.getTileData(key, 'water')
    const landuse = catalog.getTileData(key, 'landuse')
    expect(water!.originBackend).toBe(backend)
    expect(landuse!.originBackend).toBe(backend)
  })

  it('GeoJSONRuntimeBackend: originBackend populated via compileSync path', () => {
    const catalog = new TileCatalog()
    const POLY = {
      type: 'Feature' as const,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[[-30, -30], [30, -30], [30, 30], [-30, 30], [-30, -30]]],
      },
      properties: {},
    }
    const geoBackend = new GeoJSONRuntimeBackend()
    geoBackend.setParts(decomposeFeatures([POLY]), 4)
    catalog.attachBackend(geoBackend)

    const key = tileKey(0, 0, 0)
    catalog.compileTileOnDemand(key)

    const data = catalog.getTileData(key)
    expect(data, 'GeoJSON tile must be cached after compileTileOnDemand').not.toBeNull()
    expect(data!.originBackend).toBe(geoBackend)
  })

  it('PMTilesBackend: originBackend populated after async acceptResult', async () => {
    const catalog = new TileCatalog()
    const fetcher: PMTilesFetcher = async () => null
    const pmBackend = new PMTilesBackend({
      fetcher,
      minZoom: 0,
      maxZoom: 4,
      bounds: [-180, -85, 180, 85],
    })
    catalog.attachBackend(pmBackend)

    const key = tileKey(0, 0, 0)
    catalog.requestTiles([key])
    // Allow async fetch + acceptResult to complete
    await new Promise(r => setTimeout(r, 80))

    const data = catalog.getTileData(key)
    expect(data, 'PMTiles null-fetch produces a cached empty placeholder').not.toBeNull()
    expect(data!.originBackend).toBe(pmBackend)
  })
})
