/* eslint-disable @typescript-eslint/no-deprecated -- unit-tests the deprecated VirtualTileFetcher path on purpose (#1055) */
// Test the on-demand virtualCatalog fetcher path on TileCatalog.
// PMTiles + similar archives plug in through this hook instead of
// pre-fetching their entire contents.
//
// Oracle: setVirtualCatalog → requestTiles for a key inside the
// catalog window → fetcher called once → onTileLoaded fires →
// hasTileData returns true → second requestTiles is a no-op.

import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — no published types
import geojsonVt from 'geojson-vt'
// @ts-expect-error — no published types
import vtpbf from 'vt-pbf'
import { decomposeFeatures, compileSingleTile, tileKey, type CompiledTile } from '@xgis/compiler'
import { decodeMvtTile } from '../mvt-decoder'
import { TileCatalog } from '../tile-catalog'
import type { VirtualTileFetcher } from '../tile-types'

function buildSyntheticCompiledTile(z: number, x: number, y: number): CompiledTile | null {
  const orig = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-30, -30],
              [30, -30],
              [30, 30],
              [-30, 30],
              [-30, -30],
            ],
          ],
        },
        properties: {},
      },
    ],
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
      fetcher,
      minZoom: 0,
      maxZoom: 4,
      bounds: [-180, -85, 180, 85],
    })
    expect(source.hasEntryInIndex(tileKey(0, 0, 0))).toBe(true)
    expect(source.hasEntryInIndex(tileKey(4, 8, 5))).toBe(true)
    expect(
      source.hasEntryInIndex(tileKey(5, 0, 0)),
      'past maxZoom must NOT be reported as in-index — overzoom uses sub-tile gen',
    ).toBe(false)
  })

  it('skips fetcher for tiles outside the catalog bounds', () => {
    const source = new TileCatalog()
    let fetchCount = 0
    const fetcher: VirtualTileFetcher = async () => {
      fetchCount++
      return null
    }
    source.setVirtualCatalog({
      fetcher,
      minZoom: 0,
      maxZoom: 4,
      bounds: [11, 43, 12, 44], // tiny Firenze-like window
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
      fetcher,
      minZoom: 0,
      maxZoom: 0,
      bounds: [-180, -85, 180, 85],
    })

    const loadedKeys: number[] = []
    source.onTileLoaded = (key) => {
      loadedKeys.push(key)
    }

    const key = tileKey(0, 0, 0)
    expect(source.hasTileData(key)).toBe(false)
    source.requestTiles([key])

    // fetcher is async — wait for the next microtask cycle.
    await new Promise((r) => setTimeout(r, 50))

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
      fetcher,
      minZoom: 0,
      maxZoom: 0,
      bounds: [-180, -85, 180, 85],
    })
    const key = tileKey(0, 0, 0)
    source.requestTiles([key])
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchCount).toBe(1)
    source.requestTiles([key])
    source.requestTiles([key])
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchCount, 'cached key must not re-fetch').toBe(1)
  })

  it('null fetcher result caches an empty placeholder (no infinite re-request)', async () => {
    const source = new TileCatalog()
    let fetchCount = 0
    const fetcher: VirtualTileFetcher = async () => {
      fetchCount++
      return null
    }
    source.setVirtualCatalog({
      fetcher,
      minZoom: 0,
      maxZoom: 0,
      bounds: [-180, -85, 180, 85],
    })
    const key = tileKey(0, 0, 0)
    source.requestTiles([key])
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchCount).toBe(1)
    expect(
      source.hasTileData(key),
      'empty placeholder cached so cache.has shortcuts re-request',
    ).toBe(true)
    source.requestTiles([key])
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchCount).toBe(1)
  })

  it('maxLevel reports the catalog maxZoom', () => {
    const source = new TileCatalog()
    source.setVirtualCatalog({
      fetcher: async () => null,
      minZoom: 0,
      maxZoom: 14,
      bounds: [-180, -85, 180, 85],
    })
    expect(source.maxLevel).toBe(14)
  })

  it('getBounds returns the catalog bounds (camera fit)', () => {
    const source = new TileCatalog()
    source.setVirtualCatalog({
      fetcher: async () => null,
      minZoom: 0,
      maxZoom: 4,
      bounds: [11, 43, 12, 44],
    })
    expect(source.getBounds()).toEqual([11, 43, 12, 44])
  })
})

describe('a fetcher that throws SYNCHRONOUSLY releases its loading slot (#2091)', () => {
  // Fail-before: `loadTile` called `sink.trackLoading(key)` and THEN
  // `catalog.fetcher(...)` bare — a synchronous throw escaped before the
  // .then/.catch attached, so `releaseLoading` never ran and the key sat in
  // `loadingTiles` for the session. `hasPendingLoads()` then stayed true
  // forever, and since the idle predicate folds pending source work
  // (map.ts hasPendingSourceWork), the map could never fire `idle` again.
  it('leaves no pending load behind, and a later good request still works', async () => {
    const source = new TileCatalog()
    let calls = 0
    const fetcher: VirtualTileFetcher = (z, x, y) => {
      calls++
      if (calls === 1) throw new Error('sync boom')
      return Promise.resolve(buildSyntheticCompiledTile(z, x, y))
    }
    source.setVirtualCatalog({ fetcher, minZoom: 0, maxZoom: 0, bounds: [-180, -85, 180, 85] })

    const key = tileKey(0, 0, 0)
    source.requestTiles([key])
    expect(calls, 'the throwing fetcher ran').toBe(1)
    // THE ORACLE: the slot came back, so the idle predicate can settle.
    expect(source.hasPendingLoads(), 'sync throw stranded the loading slot').toBe(false)

    // And the catalog is not poisoned — a later request for the same key still
    // dispatches and lands (the strand also blocked re-requests via the
    // loadingTiles dedupe in requestTiles).
    //
    // Since #2108 that "later" is literal: a sync throw is a genuine failure, so it
    // arms the same TTL'd backoff every other failure gets, and an IMMEDIATE
    // re-request is deliberately deferred. Both contracts are asserted here rather
    // than one being dropped — the #2091 oracle is that no slot is STRANDED (above),
    // which is a different claim from "a retry may fire this instant".
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(Date.now() + 15_001)
    source.requestTiles([key])
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toBe(2)
    expect(source.hasTileData(key)).toBe(true)
    expect(source.hasPendingLoads()).toBe(false)
    now.mockRestore()
  })
})

describe('a persistently failing fetcher backs off instead of refetching every frame (#2108)', () => {
  // Fail-before: the adapter kept NO per-key failure state. Releasing the key on
  // failure is correct and must stay (holding it is the #2091 wedge above), but
  // nothing then REMEMBERED the failure — so the next `requestTiles` for a key the
  // camera still wants re-dispatched the fetch and re-logged the error. One attempt
  // and one `xlog.error` per frame, forever, on a path that by construction cannot
  // converge. Each `it` below fails on the pre-#2108 adapter.
  //
  // Clock is stubbed rather than slept through: the first backoff window is 15 s
  // (`failedKeyTtlMs`), which no unit test should wait out. Only `Date.now` is
  // mocked — timers stay real, so the promise plumbing below is untouched.
  const HALF_A_TICK = 50
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function alwaysFails(): { fetcher: VirtualTileFetcher; calls: () => number } {
    let calls = 0
    return {
      fetcher: () => {
        calls++
        return Promise.reject(new Error('upstream down'))
      },
      calls: () => calls,
    }
  }

  it('does not re-dispatch while the backoff window is still running', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const source = new TileCatalog()
    const { fetcher, calls } = alwaysFails()
    source.setVirtualCatalog({ fetcher, minZoom: 0, maxZoom: 0, bounds: [-180, -85, 180, 85] })
    const key = tileKey(0, 0, 0)

    source.requestTiles([key])
    await new Promise((r) => setTimeout(r, HALF_A_TICK))
    expect(calls(), 'the first attempt ran').toBe(1)

    // THE ORACLE: three more frames want the same key. Pre-#2108 this was three
    // more fetches and three more error lines.
    now.mockReturnValue(1_000_000 + 5_000)
    source.requestTiles([key])
    source.requestTiles([key])
    source.requestTiles([key])
    await new Promise((r) => setTimeout(r, HALF_A_TICK))
    expect(calls(), 'refetched inside the backoff window').toBe(1)
    expect(source.hasPendingLoads(), 'no slot left dangling').toBe(false)
  })

  it("retries once the window expires — the lockout is TTL'd, never permanent", async () => {
    // A permanent short-circuit is its own user-visible bug, which is why the TTL
    // policy is imported rather than reinvented: `failedKeyTtlMs`'s own docstring
    // records 21 tiles left flickering on a parked view after a single failure.
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000_000)
    const source = new TileCatalog()
    const { fetcher, calls } = alwaysFails()
    source.setVirtualCatalog({ fetcher, minZoom: 0, maxZoom: 0, bounds: [-180, -85, 180, 85] })
    const key = tileKey(0, 0, 0)

    source.requestTiles([key])
    await new Promise((r) => setTimeout(r, HALF_A_TICK))
    expect(calls()).toBe(1)

    // BOTH halves, deliberately: a test that only checked the retry fires would
    // pass identically against an adapter with NO backoff at all — the state this
    // whole block exists to detect (CLAUDE.md §12). So pin the window shut first.
    now.mockReturnValue(2_000_000 + 14_999)
    source.requestTiles([key])
    await new Promise((r) => setTimeout(r, HALF_A_TICK))
    expect(calls(), 'retried one millisecond BEFORE the window closed').toBe(1)

    // ...then one millisecond past it.
    now.mockReturnValue(2_000_000 + 15_001)
    source.requestTiles([key])
    await new Promise((r) => setTimeout(r, HALF_A_TICK))
    expect(calls(), 'the tile never got a second chance').toBe(2)
  })

  it('surfaces the failure through the catalog, which is what tile-decision reads', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(3_000_000)
    const source = new TileCatalog()
    const { fetcher } = alwaysFails()
    source.setVirtualCatalog({ fetcher, minZoom: 0, maxZoom: 0, bounds: [-180, -85, 180, 85] })
    const key = tileKey(0, 0, 0)

    expect(source.getTileState(key), 'clean before any attempt').toBe('unloaded')
    expect(source.getTileFailureCount(key)).toBe(0)

    source.requestTiles([key])
    await new Promise((r) => setTimeout(r, HALF_A_TICK))
    expect(source.getTileState(key), "backend reported nothing, so state stayed 'unloaded'").toBe(
      'failed',
    )
    expect(source.getTileFailureCount(key), 'the count tile-decision needs was absent').toBe(1)

    // A second failure, one window later, escalates the count — this is the number
    // `KEEP_WARM_MAX_FAILURES` is compared against, so it has to keep climbing.
    now.mockReturnValue(3_000_000 + 15_001)
    source.requestTiles([key])
    await new Promise((r) => setTimeout(r, HALF_A_TICK))
    expect(source.getTileFailureCount(key), 'consecutive failures must accumulate').toBe(2)
  })

  it('clears the ledger when a fetch finally succeeds', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(4_000_000)
    const source = new TileCatalog()
    let calls = 0
    const fetcher: VirtualTileFetcher = (z, x, y) => {
      calls++
      if (calls === 1) return Promise.reject(new Error('one blip'))
      return Promise.resolve(buildSyntheticCompiledTile(z, x, y))
    }
    source.setVirtualCatalog({ fetcher, minZoom: 0, maxZoom: 0, bounds: [-180, -85, 180, 85] })
    const key = tileKey(0, 0, 0)

    source.requestTiles([key])
    await new Promise((r) => setTimeout(r, HALF_A_TICK))
    expect(source.getTileFailureCount(key)).toBe(1)

    now.mockReturnValue(4_000_000 + 15_001)
    source.requestTiles([key])
    await new Promise((r) => setTimeout(r, HALF_A_TICK))
    expect(source.hasTileData(key), 'the retry landed').toBe(true)
    // A recovered tile must not keep paying the longer backoff window.
    expect(source.getTileFailureCount(key), 'success did not reset the count').toBe(0)
    expect(source.getTileState(key)).toBe('cached')
  })
})
