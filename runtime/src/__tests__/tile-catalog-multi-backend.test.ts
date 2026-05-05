// Multi-backend dispatch test for TileCatalog. Verifies that the
// attachBackend / TileSource architecture (Step 5 of the layer-type
// refactor) actually delivers what it promised:
//
//  • Two backends in one catalog don't trample each other.
//  • Bounds union, maxLevel max, propertyTable first-attached-wins.
//  • Dispatch precedence — preregistered entries route via
//    entryToBackend, unknown keys iterate backends in attach order.
//  • detachBackend cleans up entryToBackend + survives without
//    erasing already-cached tiles.

import { describe, expect, it } from 'vitest'
import { decomposeFeatures, tileKey } from '@xgis/compiler'
import { TileCatalog } from '../data/tile-catalog'
import { GeoJSONRuntimeBackend } from '../data/sources/geojson-runtime-backend'
import { PMTilesBackend, type PMTilesFetcher } from '../data/sources/pmtiles-backend'

const POLY_LARGE = {
  type: 'Feature' as const,
  geometry: {
    type: 'Polygon' as const,
    coordinates: [[[-30, -30], [30, -30], [30, 30], [-30, 30], [-30, -30]]],
  },
  properties: {},
}

describe('TileCatalog multi-backend dispatch', () => {
  it('attachBackend merges bounds (union)', () => {
    const catalog = new TileCatalog()
    const geoBackend = new GeoJSONRuntimeBackend()
    geoBackend.setParts(decomposeFeatures([POLY_LARGE]), 7)
    catalog.attachBackend(geoBackend)
    // First backend establishes catalog bounds = its bounds.
    let bounds = catalog.getBounds()!
    expect(bounds[0]).toBeCloseTo(-30, 1)
    expect(bounds[2]).toBeCloseTo(30, 1)

    const fetcher: PMTilesFetcher = async () => null
    const pmBackend = new PMTilesBackend({
      fetcher, minZoom: 0, maxZoom: 14,
      bounds: [100, -50, 150, 50],
    })
    catalog.attachBackend(pmBackend)
    bounds = catalog.getBounds()!
    // Bounding union of [-30,-30,30,30] ∪ [100,-50,150,50]
    expect(bounds[0]).toBeCloseTo(-30, 1)
    expect(bounds[1]).toBeCloseTo(-50, 1)
    expect(bounds[2]).toBeCloseTo(150, 1)
    expect(bounds[3]).toBeCloseTo(50, 1)
  })

  it('attachBackend keeps maxLevel = max-of-maxes', () => {
    const catalog = new TileCatalog()
    const geoBackend = new GeoJSONRuntimeBackend()
    geoBackend.setParts(decomposeFeatures([POLY_LARGE]), 8)
    catalog.attachBackend(geoBackend)
    expect(catalog.maxLevel).toBe(8)

    const fetcher: PMTilesFetcher = async () => null
    const pmBackend = new PMTilesBackend({
      fetcher, minZoom: 0, maxZoom: 14,
      bounds: [-180, -85, 180, 85],
    })
    catalog.attachBackend(pmBackend)
    expect(catalog.maxLevel).toBe(14)
  })

  it('hasEntryInIndex iterates backends — second backend can claim a key', () => {
    const catalog = new TileCatalog()
    const fetcherA: PMTilesFetcher = async () => null
    // Backend A: tiny window over Europe — does NOT cover (z=2, x=0, y=0)
    catalog.attachBackend(new PMTilesBackend({
      fetcher: fetcherA, minZoom: 0, maxZoom: 14,
      bounds: [11, 43, 12, 44],
    }))
    expect(catalog.hasEntryInIndex(tileKey(2, 0, 0)),
      'first backend should NOT claim a tile outside its bounds').toBe(false)

    const fetcherB: PMTilesFetcher = async () => null
    // Backend B: world coverage — claims everything
    catalog.attachBackend(new PMTilesBackend({
      fetcher: fetcherB, minZoom: 0, maxZoom: 14,
      bounds: [-180, -85, 180, 85],
    }))
    expect(catalog.hasEntryInIndex(tileKey(2, 0, 0)),
      'second backend should claim the tile via has() check').toBe(true)
  })

  it('first-attached-wins: PMTiles A claims first when both backends overlap', async () => {
    let aFetched = false
    let bFetched = false
    const catalog = new TileCatalog()
    catalog.attachBackend(new PMTilesBackend({
      fetcher: async () => { aFetched = true; return null },
      minZoom: 0, maxZoom: 4,
      bounds: [-180, -85, 180, 85],
    }))
    catalog.attachBackend(new PMTilesBackend({
      fetcher: async () => { bFetched = true; return null },
      minZoom: 0, maxZoom: 4,
      bounds: [-180, -85, 180, 85],
    }))
    catalog.requestTiles([tileKey(0, 0, 0)])
    await new Promise(r => setTimeout(r, 50))
    expect(aFetched, 'first-attached backend claims overlapping keys').toBe(true)
    expect(bFetched, 'second backend should NOT be invoked').toBe(false)
  })

  it('detachBackend removes the backend without evicting cached tiles', async () => {
    const catalog = new TileCatalog()
    const geoBackend = new GeoJSONRuntimeBackend()
    geoBackend.setParts(decomposeFeatures([POLY_LARGE]), 7)
    catalog.attachBackend(geoBackend)

    const key = tileKey(0, 0, 0)
    catalog.compileTileOnDemand(key)
    expect(catalog.hasTileData(key)).toBe(true)
    const cacheSize = catalog.getCacheSize()

    catalog.detachBackend(geoBackend)
    // Cache survives — already-loaded tiles stay even after backend
    // detach (the data is GPU-uploadable independent of backend).
    expect(catalog.getCacheSize()).toBe(cacheSize)
    expect(catalog.hasTileData(key)).toBe(true)
    // But hasEntryInIndex now relies only on the synthesised entry
    // (no backend.has fallback for the detached backend).
    expect(catalog.hasEntryInIndex(key),
      'cached tile keeps its synthesised XGVTIndex entry').toBe(true)
  })
})
