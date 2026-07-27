// #1371 — the two catalog primitives an ATOMIC re-seed needs: re-request a key that is already
// cached (because the backend under it was swapped), and report which cached tiles were
// OVERWRITTEN so the renderer can swap their GPU buffers instead of being blanked.
import { describe, expect, it } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { TileCatalog } from './tile-catalog'
import { TILE_LAYOUT_VERSION, type TileSource, type TileSourceSink } from './tile-source'

/** A backend that records every loadTile call (with its `force` flag) and produces a tile whose
 *  single vertex carries `mark`, so a test can tell the two generations apart. */
function fakeBackend(mark: number): TileSource & { calls: Array<{ key: number; force: boolean }> } {
  let sink: TileSourceSink | null = null
  const calls: Array<{ key: number; force: boolean }> = []
  return {
    calls,
    meta: {
      bounds: [-180, -85, 180, 85],
      minZoom: 0,
      maxZoom: 14,
      scheme: 'web-mercator-xyz',
      layoutVersion: TILE_LAYOUT_VERSION,
    },
    has: () => true,
    attach: (s) => void (sink = s),
    loadTile: (key, force = false) => {
      calls.push({ key, force })
      sink?.acceptResult(key, {
        vertices: Float32Array.of(mark),
        dequantScale: 1,
        dequantHalf: 0,
        indices: new Uint32Array(0),
        lineVertices: new Float32Array(0),
        lineIndices: new Uint32Array(0),
      })
    },
  }
}

/** `attachBackend` synthesises the catalog's index from the backend's meta, which is all
 *  `requestTiles` needs — the same shape a virtual-tiled geojson source has. */
function catalogWithBackend(backend: TileSource): TileCatalog {
  const catalog = new TileCatalog()
  catalog.attachBackend(backend)
  return catalog
}

const K = tileKey(2, 1, 1)

describe('TileCatalog re-seed primitives (#1371)', () => {
  it('requestTiles SKIPS a cached key — the behaviour refreshTiles has to override', () => {
    const b = fakeBackend(1)
    const catalog = catalogWithBackend(b)
    catalog.requestTiles([K])
    expect(b.calls).toHaveLength(1)
    catalog.requestTiles([K]) // already cached
    expect(b.calls).toHaveLength(1)
  })

  it('refreshTiles re-requests a cached key, with force set so the backend does not short-circuit', () => {
    const b = fakeBackend(1)
    const catalog = catalogWithBackend(b)
    catalog.requestTiles([K])
    catalog.refreshTiles([K])
    expect(b.calls).toEqual([
      { key: K, force: false },
      { key: K, force: true },
    ])
  })

  it('the refreshed data REPLACES the cached tile (the renderer must re-upload, not re-add)', () => {
    const first = fakeBackend(1)
    const catalog = catalogWithBackend(first)
    catalog.requestTiles([K])
    expect(catalog.getTileData(K)?.vertices[0]).toBe(1)

    // Swap the backend the way a host data push does — the cache survives a detach by contract.
    const second = fakeBackend(2)
    catalog.detachBackend(first)
    catalog.attachBackend(second)
    expect(catalog.getTileData(K)?.vertices[0]).toBe(1) // still serving the OLD tile…
    catalog.refreshTiles([K])
    expect(catalog.getTileData(K)?.vertices[0]).toBe(2) // …until the replacement lands
  })

  it('consumeReplacedKeys reports only OVERWRITES, and drains', () => {
    const first = fakeBackend(1)
    const catalog = catalogWithBackend(first)
    catalog.requestTiles([K])
    expect(catalog.consumeReplacedKeys()).toEqual([]) // a FIRST write is not a replacement

    const second = fakeBackend(2)
    catalog.detachBackend(first)
    catalog.attachBackend(second)
    catalog.refreshTiles([K])
    expect(catalog.consumeReplacedKeys()).toEqual([K])
    expect(catalog.consumeReplacedKeys()).toEqual([]) // drained
  })
})
