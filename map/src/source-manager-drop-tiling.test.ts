// BUG 7 wiring: SourceManager.setSourceData (the GeoJSON source REPLACE path)
// must evict the old tiling-worker index for that source so the per-source
// GeoJSONVT index doesn't leak in the process-global tiling worker across SPA
// churn / repeated setSourceData calls.
//
// The fix calls `tilingPool.dropSource(this._tilingInstanceId, sourceId)` after
// teardownSource and BEFORE rebuildLayers (so the fresh re-tile under the same
// composed key isn't the one that gets deleted). This test mocks the tiling
// pool module, drives setSourceData against a stub-wired SourceManager, and
// asserts dropSource was called for that source with this map's instance id.
//
// No GPU: SourceManager's ctor just stores its injected deps; setSourceData
// touches only the shared Maps + the injected callbacks (all vi.fn stubs).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InputStore } from './render/input-store'

// Spy the tiling-pool functions on the SHARED @xgis/data namespace so
// newTilingInstanceId is deterministic and dropSource is observable. (The real
// module spawns a Worker via new URL(...).) SourceManager co-moved into @xgis/map
// (P3 Batch B10c) → the barrel eager-loads it during test setup
// (test-setup-projections imports configureProjections from '@xgis/map') BEFORE a
// hoisted vi.mock('@xgis/data') could bind, so a module-mock would miss. vi.spyOn
// mutates the already-loaded shared namespace at runtime, so SourceManager's
// `tilingPool.*` reads (import * as tilingPool from '@xgis/data') pick up the stubs
// at call time — load-order-independent.
import * as xgisData from '@xgis/data'
import * as vtrModule from './render/vector-tile-renderer'
import { SourceManager } from './source-manager'
import { TileCatalog, TILE_LAYOUT_VERSION } from '@xgis/data'
import type { GeoJSONFeatureCollection } from '@xgis/data'
import type { ShowSourceMaps } from './show-source-maps'

const dropSource = vi.fn()
let mintCount = 0

function makeManager() {
  const registered = new Map<string, TileCatalog>()
  const rawDatasets = new Map<string, GeoJSONFeatureCollection>()
  const teardownSource = vi.fn()
  const rebuildLayers = vi.fn()
  const deleteFeatureIndex = vi.fn()
  const invalidate = vi.fn()
  const order: string[] = []

  const mgr = new SourceManager({
    rawDatasets,
    inputs: new InputStore(),
    registerVtSource: (key, source) => {
      registered.set(key, source)
    },
    sourceCRS: new Map(), // no declared CRS ⇒ reproject is a no-op
    geojsonCapPoles: new Map(),
    heatmapPointData: new Map(),
    camera: {} as never,
    getCanvas: () => ({ width: 800 }) as never,
    getCtx: () => ({}) as never,
    getRenderer: () => ({}) as never,
    getLineRenderer: () => null,
    invalidate,
    fitZoomToLonSpan: () => 0,
    runBoundsFitGate: () => false,
    rebuildLayers: () => {
      order.push('rebuild')
      rebuildLayers()
    },
    teardownSource: (id) => {
      order.push('teardown')
      teardownSource(id)
    },
    fireError: () => {},
    getVtSource: () => null,
    hasVariantSources: () => false,
    deleteFeatureIndex,
    beginCoverageLoad: () => Promise.resolve(),
  })
  return { mgr, rawDatasets, teardownSource, rebuildLayers, order, registered }
}

const FC: GeoJSONFeatureCollection = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }],
} as GeoJSONFeatureCollection

beforeEach(() => {
  dropSource.mockClear()
  mintCount = 0
  vi.spyOn(xgisData, 'newTilingInstanceId').mockImplementation(() => `gjt-test-${++mintCount}`)
  vi.spyOn(xgisData, 'dropSource').mockImplementation(((...a: unknown[]) =>
    dropSource(...a)) as never)
  vi.spyOn(xgisData, 'setSource').mockImplementation((() => {}) as never)
  vi.spyOn(xgisData, 'getTile').mockImplementation((() => {}) as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SourceManager.setSourceData — drops the old tiling index (BUG 7)', () => {
  it('posts dropSource for the replaced source using this map instance id', () => {
    const { mgr, rawDatasets } = makeManager()
    // Source must already be declared (a prior attach seeded this entry).
    rawDatasets.set('geojson', { _vectorTile: true } as unknown as GeoJSONFeatureCollection)

    mgr.setSourceData('geojson', FC)

    expect(dropSource).toHaveBeenCalledTimes(1)
    const [instanceId, sourceId] = dropSource.mock.calls[0]
    expect(sourceId).toBe('geojson')
    // The same id this SourceManager minted at construction (deterministic mock).
    expect(instanceId).toBe('gjt-test-1')
  })

  it('drops AFTER teardownSource and BEFORE rebuildLayers (fresh re-tile not clobbered)', () => {
    const { mgr, rawDatasets, order } = makeManager()
    rawDatasets.set('geojson', { _vectorTile: true } as unknown as GeoJSONFeatureCollection)

    // Record when dropSource fires relative to teardown / rebuild.
    dropSource.mockImplementation(() => order.push('drop'))
    mgr.setSourceData('geojson', FC)

    expect(order).toEqual(['teardown', 'drop', 'rebuild'])
  })

  it('two SourceManagers (two maps) drop under DISTINCT instance ids — no cross-map eviction', () => {
    const a = makeManager()
    const b = makeManager()
    a.rawDatasets.set('geojson', { _vectorTile: true } as unknown as GeoJSONFeatureCollection)
    b.rawDatasets.set('geojson', { _vectorTile: true } as unknown as GeoJSONFeatureCollection)

    a.mgr.setSourceData('geojson', FC)
    b.mgr.setSourceData('geojson', FC)

    expect(dropSource).toHaveBeenCalledTimes(2)
    const idA = dropSource.mock.calls[0][0]
    const idB = dropSource.mock.calls[1][0]
    expect(idA).not.toBe(idB)
  })
})

// ── #1353: the SPA-churn half of BUG 7 ────────────────────────────────────
// setSourceData was the only path that ever freed a tiling-worker index; a map
// that was simply destroyed pinned every index it ever built for the lifetime
// of the page (the worker is a process-global singleton, so nothing collects
// them). XGISMap.teardownSource — reached by BOTH destroy() and
// _teardownForReinit — calls `catalog.destroy()` on every registered vt source,
// so the eviction hangs off the catalog's lifetime.
//
// The attach builds a VectorTileRenderer (needs a GPU device) and a real
// VirtualPMTilesBackend (spawns the tiling Worker); neither exists in the node
// test env, so both are replaced with inert stubs on the shared namespaces —
// same technique and rationale as source-manager-bounds-fit-gate.test.ts. The
// TileCatalog stays REAL: its destroy() is the production hook under test.
class StubVectorTileRenderer {
  setBindGroupLayout(): void {}
  setPaletteResources(): void {}
  setSpriteAtlasView(): void {}
  setExtrudedPipelines(): void {}
  setGroundPipelines(): void {}
  setPatternPipelines(): void {}
  setPatternExtrudedPipelines(): void {}
  setOITPipeline(): void {}
  setLineRenderer(): void {}
  setSource(): void {}
}
class StubVirtualPMTilesBackend {
  meta = {
    bounds: [-180, -85, 180, 85] as [number, number, number, number],
    minZoom: 0,
    maxZoom: 14,
    scheme: 'web-mercator-xyz' as const,
    layoutVersion: TILE_LAYOUT_VERSION,
  }
  has(): boolean {
    return false
  }
  attach(): void {}
  loadTile(): void {}
  detach(): void {}
}

/** No per-source layer filter / extrude / stroke overrides — the attach reads
 *  these maps but a single-point FC needs none. */
function emptyMaps(): ShowSourceMaps {
  return {
    usedSourceLayers: new Map(),
    extrudeExprsBySource: new Map(),
    extrudeBaseExprsBySource: new Map(),
    showSlicesBySource: new Map(),
    strokeWidthExprsBySource: new Map(),
    strokeColorExprsBySource: new Map(),
  } as unknown as ShowSourceMaps
}

describe('SourceManager teardown — drops the tiling index with its catalog (#1353)', () => {
  beforeEach(() => {
    vi.spyOn(vtrModule, 'VectorTileRenderer').mockImplementation(
      (() => new StubVectorTileRenderer()) as never,
    )
    vi.spyOn(xgisData, 'VirtualPMTilesBackend').mockImplementation(
      (() => new StubVirtualPMTilesBackend()) as never,
    )
  })

  it('URL-GeoJSON attach: catalog.destroy() posts dropSource for this map + source', async () => {
    const { mgr, registered } = makeManager()

    await mgr._attachGeoJSONViaVirtualPMTiles('geojson', FC, emptyMaps(), { fit: false })
    const catalog = registered.get('geojson')
    expect(catalog).toBeDefined()
    // Attaching must not evict the index it just built.
    expect(dropSource).not.toHaveBeenCalled()

    // Exactly what XGISMap.teardownSource does for each vtSources entry.
    catalog!.destroy()

    expect(dropSource).toHaveBeenCalledTimes(1)
    expect(dropSource.mock.calls[0]).toEqual(['gjt-test-1', 'geojson'])
  })

  it('inline-GeoJSON attach registers the same eviction on the caller-owned catalog', () => {
    const { mgr } = makeManager()
    // The inline path is handed a catalog XGISMap already built.
    const catalog = new TileCatalog()

    mgr._attachInlineGeoJSONViaVirtualPMTiles('geojson__1', FC, emptyMaps(), catalog)
    expect(dropSource).not.toHaveBeenCalled()

    catalog.destroy()

    expect(dropSource).toHaveBeenCalledTimes(1)
    expect(dropSource.mock.calls[0]).toEqual(['gjt-test-1', 'geojson__1'])
  })

  it('a second destroy() does not re-post the eviction', async () => {
    const { mgr, registered } = makeManager()
    await mgr._attachGeoJSONViaVirtualPMTiles('geojson', FC, emptyMaps(), { fit: false })

    registered.get('geojson')!.destroy()
    registered.get('geojson')!.destroy()

    expect(dropSource).toHaveBeenCalledTimes(1)
  })
})
