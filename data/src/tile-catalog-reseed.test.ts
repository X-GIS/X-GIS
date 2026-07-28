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

/** A backend that leaves every load IN FLIGHT until `flush()`, so a test can push
 *  `loadingTiles` past `maxConcurrentLoads()` — the state in which `requestTiles` stops
 *  issuing and `break`s out of the key loop. */
function deferredBackend(
  mark: number,
): TileSource & { calls: number[]; flush: () => void; inFlight: () => number } {
  let sink: TileSourceSink | null = null
  const calls: number[] = []
  let pending: number[] = []
  return {
    calls,
    inFlight: () => pending.length,
    flush: () => {
      const batch = pending
      pending = []
      for (const key of batch) {
        sink?.acceptResult(key, {
          vertices: Float32Array.of(mark),
          dequantScale: 1,
          dequantHalf: 0,
          indices: new Uint32Array(0),
          lineVertices: new Float32Array(0),
          lineIndices: new Uint32Array(0),
        })
        sink?.releaseLoading(key)
      }
    },
    meta: {
      bounds: [-180, -85, 180, 85],
      minZoom: 0,
      maxZoom: 14,
      scheme: 'web-mercator-xyz',
      layoutVersion: TILE_LAYOUT_VERSION,
    },
    has: () => true,
    attach: (s) => void (sink = s),
    loadTile: (key) => {
      calls.push(key)
      sink?.trackLoading(key)
      pending.push(key)
    },
  }
}

// A viewport's worth of tiles is routinely larger than `maxConcurrentLoads()` (8 on a phone,
// 32 otherwise), and `requestTiles` BREAKS out of its key loop at the cap. A one-shot refresh
// therefore re-tiled only as many tiles as happened to fit — and because nothing ever
// re-requests a CACHED key, every tile past the cap kept drawing the previous backend's data
// for the lifetime of the source. Measured in a browser before this: a host push of 8100
// polygons into a 19-tile viewport left 11 tiles stale, permanently.
describe('TileCatalog re-seed is not bounded by the concurrency cap (#1402)', () => {
  const KEYS = Array.from({ length: 40 }, (_, i) => tileKey(6, i, 1))

  it('refreshes EVERY key, across as many drains as the cap needs', () => {
    const first = deferredBackend(1)
    const catalog = catalogWithBackend(first)
    catalog.requestTiles(KEYS)
    first.flush()
    // Not every key necessarily made it in one pass — drive normal requests until all cached.
    for (let i = 0; i < 10 && KEYS.some((k) => !catalog.getTileData(k)); i++) {
      catalog.requestTiles(KEYS)
      first.flush()
    }
    expect(KEYS.every((k) => catalog.getTileData(k)?.vertices[0] === 1)).toBe(true)

    const second = deferredBackend(2)
    catalog.detachBackend(first)
    catalog.attachBackend(second)

    catalog.refreshTiles(KEYS)
    // The cap bit: this is the bug's signature — a single refresh cannot cover the viewport.
    expect(second.calls.length).toBeLessThan(KEYS.length)

    // Later frames drain the rest. `requestTiles([])` stands in for a selection call that
    // happens to ask for nothing new — the queue must not depend on the selector re-listing
    // the stale keys, because a cached key is exactly what the selector stops asking for.
    for (let i = 0; i < 20; i++) {
      second.flush()
      catalog.requestTiles([])
    }
    second.flush()
    expect(second.inFlight()).toBe(0)

    const stale = KEYS.filter((k) => catalog.getTileData(k)?.vertices[0] !== 2)
    expect(stale).toEqual([])
  })

  it('markReplaced re-arms a drained key so a consumer that could not swap is asked again', () => {
    const first = fakeBackend(1)
    const catalog = catalogWithBackend(first)
    catalog.requestTiles([K])
    const second = fakeBackend(2)
    catalog.detachBackend(first)
    catalog.attachBackend(second)
    catalog.refreshTiles([K])

    expect(catalog.consumeReplacedKeys()).toEqual([K])
    expect(catalog.consumeReplacedKeys()).toEqual([]) // drained — no second chance without…
    catalog.markReplaced(K)
    expect(catalog.consumeReplacedKeys()).toEqual([K]) // …this
  })

  it('hasReplacedKeys PEEKS — a swap owed is visible without consuming the evidence (#1448)', () => {
    // THE BUG THIS CLOSES. The render loop's idle-skip asked only "is a tile still FETCHING?",
    // so a replacement arriving after the last frame was never swapped in: `applyReplacedTiles`
    // runs at the START of a frame and nothing asked for another one. Measured on the real
    // demo — one `setSourceData` left 1-2 of 7 tiles drawing the PREVIOUS seed, flat for 60 s,
    // and a single `invalidate()` corrected it.
    //
    // It must PEEK. An idle-skip predicate that drained would consume the very swap it exists
    // to schedule, and the bug would survive the fix that named it.
    const first = fakeBackend(1)
    const catalog = catalogWithBackend(first)
    catalog.requestTiles([K])
    expect(catalog.hasReplacedKeys(), 'a first write owes no swap').toBe(false)

    const second = fakeBackend(2)
    catalog.detachBackend(first)
    catalog.attachBackend(second)
    catalog.refreshTiles([K])

    expect(catalog.hasReplacedKeys(), 'a replacement is owed').toBe(true)
    expect(catalog.hasReplacedKeys(), 'and asking did not consume it').toBe(true)
    expect(catalog.consumeReplacedKeys()).toEqual([K]) // still there for the real consumer
    expect(catalog.hasReplacedKeys(), 'false once the swap has been handed over').toBe(false)
  })

  it('markReplaced is a no-op for a key with no cached data — nothing to swap in', () => {
    const catalog = catalogWithBackend(fakeBackend(1))
    catalog.markReplaced(K)
    expect(catalog.consumeReplacedKeys()).toEqual([])
  })
})
