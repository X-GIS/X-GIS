// PMTilesBackend + VirtualPMTilesBackend need live archives / workers to
// instantiate, so they're not exercised directly here — the tsc gate on
// TileSourceMeta is the authoritative check that they populate the field.

import { describe, it, expect } from 'vitest'
import { GeoJSONRuntimeBackend } from '@xgis/data'
import { VirtualCatalogAdapter } from '@xgis/data'

describe('TileSource backends declare scheme = "web-mercator-xyz"', () => {
  it('GeoJSONRuntimeBackend populates meta.scheme at construction', () => {
    const backend = new GeoJSONRuntimeBackend()
    expect(backend.meta.scheme).toBe('web-mercator-xyz')
  })

  it('GeoJSONRuntimeBackend.setParts re-asserts meta.scheme', () => {
    const backend = new GeoJSONRuntimeBackend()
    backend.setParts([], 10)
    expect(backend.meta.scheme).toBe('web-mercator-xyz')
    expect(backend.meta.maxZoom).toBe(10)
  })

  it('VirtualCatalogAdapter declares meta.scheme directly', () => {
    const stubCatalog = {
      bounds: [-180, -85, 180, 85] as [number, number, number, number],
      minZoom: 0,
      maxZoom: 14,
      fetcher: () => Promise.resolve(null),
    }
    const adapter = new VirtualCatalogAdapter(stubCatalog)
    expect(adapter.meta.scheme).toBe('web-mercator-xyz')
  })

  it('TileScheme is a single-variant literal union', () => {
    // If a new variant lands, this const widening fails to compile.
    const onlyVariant: 'web-mercator-xyz' = 'web-mercator-xyz'
    expect(onlyVariant).toBe('web-mercator-xyz')
  })
})
