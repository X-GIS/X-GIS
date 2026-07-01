// TILE_LAYOUT_VERSION mismatch eviction — PR 2c.4 unit coverage.
//
// Verifies that TileCatalog.attachBackend evicts cached tiles attributable
// to the attaching backend (and the pre-attribution `undefined` legacy
// entries) when the backend's `meta.layoutVersion` does not match the
// running runtime's TILE_LAYOUT_VERSION. The warn is one-shot per backend
// instance — re-attach must not re-warn.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { TileCatalog } from '@xgis/data'
import {
  TILE_LAYOUT_VERSION, TILE_LAYOUT_VERSION_BASE,
  type TileSource, type TileSourceSink, type TileSourceMeta, type BackendTileResult,
  type TileLayoutVersion,
} from '@xgis/data'
import { setLogSink } from '@xgis/shared'

const WORLD_BOUNDS: [number, number, number, number] = [-180, -85, 180, 85]

const EMPTY_RESULT: BackendTileResult = {
  vertices: new Float32Array(0),
  dequantScale: 0,
  dequantHalf: 0,
  indices: new Uint32Array(0),
  lineVertices: new Float32Array(0),
  lineIndices: new Uint32Array(0),
}

interface MockBackend extends TileSource {
  pushResult(key: number, result?: BackendTileResult | null): void
}

/** Minimal TileSource that lets the test pump synthetic results into
 *  the catalog and vary the advertised `meta.layoutVersion`. Passing
 *  `null` for `layoutVersion` reproduces a pre-version-field backend
 *  (the field is omitted from meta entirely). */
function makeBackend(layoutVersion: TileLayoutVersion | number | null): MockBackend {
  let sink: TileSourceSink | null = null
  const meta: TileSourceMeta = layoutVersion === null
    ? {
        bounds: WORLD_BOUNDS,
        minZoom: 0,
        maxZoom: 4,
        scheme: 'web-mercator-xyz',
      }
    : {
        bounds: WORLD_BOUNDS,
        minZoom: 0,
        maxZoom: 4,
        scheme: 'web-mercator-xyz',
        // Type cast: tests deliberately push non-matching versions
        // through this path to exercise the eviction trigger.
        layoutVersion: layoutVersion as TileLayoutVersion,
      }
  return {
    meta,
    has: () => true,
    attach(s) { sink = s },
    loadTile(key) { sink?.trackLoading(key) },
    pushResult(key, result = EMPTY_RESULT) {
      sink!.acceptResult(key, result)
    },
  }
}

// Sanity guard: the eviction logic only triggers when the running runtime
// has moved past the baseline. PR 2c.4 satisfies this (2 > 1); these tests
// would silently no-op if a future change reverted the bump.
const POST_BASELINE = TILE_LAYOUT_VERSION > TILE_LAYOUT_VERSION_BASE

describe.skipIf(!POST_BASELINE)('TileCatalog.attachBackend layoutVersion eviction (PR 2c.4)', () => {
  let warnings: string[]

  beforeEach(() => {
    warnings = []
    setLogSink((level, message) => {
      if (level === 'warn') warnings.push(message)
    })
  })

  afterEach(() => {
    // Restore the default console-routing sink (setLogSink(null) resets).
    setLogSink(null)
  })

  it('(a) backend with stale layoutVersion: warn fires + cache evicted on attach', () => {
    const catalog = new TileCatalog()
    const stale = makeBackend(TILE_LAYOUT_VERSION_BASE)

    // First attach: cache empty, but the version mismatch still fires
    // the user-visible warn — the eviction step is a no-op here because
    // there are no entries yet.
    catalog.attachBackend(stale)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('tile-layout-version mismatch')
    expect(warnings[0]).toContain(`cached=${TILE_LAYOUT_VERSION_BASE}`)
    expect(warnings[0]).toContain(`running=${TILE_LAYOUT_VERSION}`)

    // Now push a tile so the cache has something attributable to stale,
    // then detach + re-attach. The one-shot guard suppresses a second
    // warn, but the eviction must still run.
    const key = tileKey(2, 0, 0)
    stale.pushResult(key)
    expect(catalog.hasTileData(key)).toBe(true)

    catalog.detachBackend(stale)
    catalog.attachBackend(stale)
    expect(catalog.hasTileData(key)).toBe(false)
  })

  it('(b) backend with undefined layoutVersion: cache evicted (treated as BASE)', () => {
    const catalog = new TileCatalog()
    const legacy = makeBackend(null)

    catalog.attachBackend(legacy)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain(`cached=${TILE_LAYOUT_VERSION_BASE}`)

    const key = tileKey(2, 0, 0)
    legacy.pushResult(key)
    expect(catalog.hasTileData(key)).toBe(true)

    catalog.detachBackend(legacy)
    catalog.attachBackend(legacy)
    expect(catalog.hasTileData(key)).toBe(false)
  })

  it('(c) backend with matching layoutVersion: no eviction, no warn', () => {
    const catalog = new TileCatalog()
    const current = makeBackend(TILE_LAYOUT_VERSION)
    catalog.attachBackend(current)
    const key = tileKey(2, 0, 0)
    current.pushResult(key)

    catalog.detachBackend(current)
    warnings.length = 0
    catalog.attachBackend(current)

    expect(catalog.hasTileData(key)).toBe(true)
    expect(warnings.length).toBe(0)
  })

  it('(d) cache-attribution backfill: entries with originBackend=undefined evicted alongside matched ones', () => {
    const catalog = new TileCatalog()

    // Backend A: current version, owns keyA. No warn, no eviction.
    const current = makeBackend(TILE_LAYOUT_VERSION)
    catalog.attachBackend(current)
    const keyA = tileKey(2, 0, 0)
    current.pushResult(keyA)

    // Backend B: stale version. Attaching it warns and (empty) evicts.
    // Push keyB attributable to B, AND a third tile we mutate to look
    // like a pre-attribution legacy entry (originBackend = undefined).
    const stale = makeBackend(TILE_LAYOUT_VERSION_BASE)
    catalog.attachBackend(stale)
    const keyB = tileKey(2, 1, 0)
    stale.pushResult(keyB)

    const keyLegacy = tileKey(2, 2, 0)
    stale.pushResult(keyLegacy)
    const legacyData = catalog.getTileData(keyLegacy)!
    ;(legacyData as { originBackend?: TileSource }).originBackend = undefined

    expect(catalog.hasTileData(keyA)).toBe(true)
    expect(catalog.hasTileData(keyB)).toBe(true)
    expect(catalog.hasTileData(keyLegacy)).toBe(true)

    // Re-attach the stale backend. Eviction must drop both the
    // B-owned tile AND the unattributed legacy tile. keyA stays.
    catalog.detachBackend(stale)
    catalog.attachBackend(stale)

    expect(catalog.hasTileData(keyA)).toBe(true)
    expect(catalog.hasTileData(keyB)).toBe(false)
    expect(catalog.hasTileData(keyLegacy)).toBe(false)
  })

  it('(e) warn is one-shot per backend instance across repeated attaches', () => {
    const catalog = new TileCatalog()
    const stale = makeBackend(TILE_LAYOUT_VERSION_BASE)

    // First attach triggers the warn (cache is empty, but mismatch
    // still fires — the warn is the user-visible signal, not the
    // eviction count).
    catalog.attachBackend(stale)
    expect(warnings.length).toBe(1)

    catalog.detachBackend(stale)
    catalog.attachBackend(stale)
    catalog.detachBackend(stale)
    catalog.attachBackend(stale)

    // Subsequent re-attaches do NOT re-warn the same backend.
    expect(warnings.length).toBe(1)
  })

})
