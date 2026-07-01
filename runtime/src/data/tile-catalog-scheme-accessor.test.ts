import { describe, it, expect } from 'vitest'
import { TileCatalog } from '@xgis/data'
import { GeoJSONRuntimeBackend } from '@xgis/data'

describe('TileCatalog.getScheme', () => {
  it('returns undefined before any backend is attached', () => {
    const catalog = new TileCatalog()
    expect(catalog.getScheme()).toBeUndefined()
  })

  it('returns the attached backend scheme', () => {
    const catalog = new TileCatalog()
    catalog.attachBackend(new GeoJSONRuntimeBackend())
    expect(catalog.getScheme()).toBe('web-mercator-xyz')
  })

  it('returns the first-attached scheme when multiple backends are present', () => {
    const catalog = new TileCatalog()
    catalog.attachBackend(new GeoJSONRuntimeBackend())
    catalog.attachBackend(new GeoJSONRuntimeBackend())
    expect(catalog.getScheme()).toBe('web-mercator-xyz')
  })
})
