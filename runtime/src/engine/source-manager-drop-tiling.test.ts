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

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the tiling pool so newTilingInstanceId is deterministic and dropSource
// is observable. (The real module spawns a Worker via new URL(...).)
const dropSource = vi.fn()
let mintCount = 0
vi.mock('../data/workers/geojson-tiling-pool', () => ({
  newTilingInstanceId: () => `gjt-test-${++mintCount}`,
  setSource: vi.fn(),
  getTile: vi.fn(),
  dropSource: (...a: unknown[]) => dropSource(...a),
}))

import { SourceManager } from './source-manager'
import type { GeoJSONFeatureCollection } from '../loader/geojson'

function makeManager() {
  const rawDatasets = new Map<string, GeoJSONFeatureCollection>()
  const teardownSource = vi.fn()
  const rebuildLayers = vi.fn()
  const deleteFeatureIndex = vi.fn()
  const invalidate = vi.fn()
  const order: string[] = []

  const mgr = new SourceManager({
    rawDatasets,
    vtSources: new Map(),
    sourceCRS: new Map(), // no declared CRS ⇒ reproject is a no-op
    geojsonCapPoles: new Map(),
    heatmapPointData: new Map(),
    camera: {} as never,
    canvas: { width: 800 } as never,
    getCtx: () => ({}) as never,
    getRenderer: () => ({}) as never,
    getLineRenderer: () => null,
    invalidate,
    fitZoomToLonSpan: () => 0,
    runBoundsFitGate: () => false,
    rebuildLayers: () => { order.push('rebuild'); rebuildLayers() },
    teardownSource: (id) => { order.push('teardown'); teardownSource(id) },
    deleteFeatureIndex,
  })
  return { mgr, rawDatasets, teardownSource, rebuildLayers, order }
}

const FC: GeoJSONFeatureCollection = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }],
} as GeoJSONFeatureCollection

beforeEach(() => {
  dropSource.mockClear()
  mintCount = 0
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
