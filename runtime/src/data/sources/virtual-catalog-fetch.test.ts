// Test the on-demand virtualCatalog fetcher path on TileCatalog.
// PMTiles + similar archives plug in through this hook instead of
// pre-fetching their entire contents.
//
// Oracle: setVirtualCatalog → requestTiles for a key inside the
// catalog window → fetcher called once → onTileLoaded fires →
// hasTileData returns true → second requestTiles is a no-op.

import { describe, expect, it } from 'vitest'
// @ts-expect-error — no published types
import geojsonVt from 'geojson-vt'
// @ts-expect-error — no published types
import vtpbf from 'vt-pbf'
import {
  decodeMvtTile, decomposeFeatures, compileSingleTile, tileKey,
  type CompiledTile,
} from '@xgis/compiler'
import { TileCatalog, type VirtualTileFetcher } from '../tile-catalog'

function buildSyntheticCompiledTile(z: number, x: number, y: number): CompiledTile | null {
  const orig = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[-30, -30], [30, -30], [30, 30], [-30, 30], [-30, -30]]] },
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

describe('TileCatalog virtual catalog (on-demand fetch)', () => {
  it('hasEntryInIndex reports true for keys inside the catalog window', () => {
    const source = new TileCatalog()
    const fetcher: VirtualTileFetcher = async () => null
    source.setVirtualCatalog({
      fetcher, minZoom: 0, maxZoom: 4,
      bounds: [-180, -85, 180, 85],
    })
    expect(source.hasEntryInIndex(tileKey(0, 0, 0))).toBe(true)
    expect(source.hasEntryInIndex(tileKey(4, 8, 5))).toBe(true)
    expect(source.hasEntryInIndex(tileKey(5, 0, 0)),
      'past maxZoom must NOT be reported as in-index — overzoom uses sub-tile gen').toBe(false)
  })

  it('skips fetcher for tiles outside the catalog bounds', () => {
    const source = new TileCatalog()
    let fetchCount = 0
    const fetcher: VirtualTileFetcher = async () => { fetchCount++; return null }
    source.setVirtualCatalog({
      fetcher, minZoom: 0, maxZoom: 4,
      bounds: [11, 43, 12, 44],  // tiny Firenze-like window
    })
    // tile (0,0,0) covers the whole world → intersects → in-index
    expect(source.hasEntryInIndex(tileKey(0, 0, 0))).toBe(true)
    // tile (4, 0, 0) is at lon ~ -180..-157 — does NOT overlap [11,12]
    expect(source.hasEntryInIndex(tileKey(4, 0, 0))).toBe(false)
    expect(fetchCount).toBe(0)
  })

  it('fetcher fires on requestTiles, result lands in cache + onTileLoaded', async () => {
    const source = new TileCatalog()
    let fetchCount = 0
    const fetcher: VirtualTileFetcher = async (z, x, y) => {
      fetchCount++
      return buildSyntheticCompiledTile(z, x, y)
    }
    source.setVirtualCatalog({
      fetcher, minZoom: 0, maxZoom: 0,
      bounds: [-180, -85, 180, 85],
    })

    const loadedKeys: number[] = []
    source.onTileLoaded = (key) => { loadedKeys.push(key) }

    const key = tileKey(0, 0, 0)
    expect(source.hasTileData(key)).toBe(false)
    source.requestTiles([key])

    // fetcher is async — wait for the next microtask cycle.
    await new Promise(r => setTimeout(r, 50))

    expect(fetchCount).toBe(1)
    expect(source.hasTileData(key)).toBe(true)
    expect(loadedKeys).toContain(key)
    const data = source.getTileData(key)
    expect(data).not.toBeNull()
    expect(data!.vertices.length).toBeGreaterThan(0)
  })

  it('second requestTiles for the same cached key is a no-op', async () => {
    const source = new TileCatalog()
    let fetchCount = 0
    const fetcher: VirtualTileFetcher = async (z, x, y) => {
      fetchCount++
      return buildSyntheticCompiledTile(z, x, y)
    }
    source.setVirtualCatalog({
      fetcher, minZoom: 0, maxZoom: 0,
      bounds: [-180, -85, 180, 85],
    })
    const key = tileKey(0, 0, 0)
    source.requestTiles([key])
    await new Promise(r => setTimeout(r, 50))
    expect(fetchCount).toBe(1)
    source.requestTiles([key])
    source.requestTiles([key])
    await new Promise(r => setTimeout(r, 50))
    expect(fetchCount, 'cached key must not re-fetch').toBe(1)
  })

  it('null fetcher result caches an empty placeholder (no infinite re-request)', async () => {
    const source = new TileCatalog()
    let fetchCount = 0
    const fetcher: VirtualTileFetcher = async () => { fetchCount++; return null }
    source.setVirtualCatalog({
      fetcher, minZoom: 0, maxZoom: 0,
      bounds: [-180, -85, 180, 85],
    })
    const key = tileKey(0, 0, 0)
    source.requestTiles([key])
    await new Promise(r => setTimeout(r, 50))
    expect(fetchCount).toBe(1)
    expect(source.hasTileData(key), 'empty placeholder cached so cache.has shortcuts re-request').toBe(true)
    source.requestTiles([key])
    await new Promise(r => setTimeout(r, 50))
    expect(fetchCount).toBe(1)
  })

  it('maxLevel reports the catalog maxZoom', () => {
    const source = new TileCatalog()
    source.setVirtualCatalog({
      fetcher: async () => null, minZoom: 0, maxZoom: 14,
      bounds: [-180, -85, 180, 85],
    })
    expect(source.maxLevel).toBe(14)
  })

  it('getBounds returns the catalog bounds (camera fit)', () => {
    const source = new TileCatalog()
    source.setVirtualCatalog({
      fetcher: async () => null, minZoom: 0, maxZoom: 4,
      bounds: [11, 43, 12, 44],
    })
    expect(source.getBounds()).toEqual([11, 43, 12, 44])
  })
})
