// Phase 1b / Tier 3 (PRD US-009): asserts TileCatalog.getScheme() returns
// the primary attached backend's scheme. Replaces plan AC1b.5's
// `getSourceScheme(name)` because the catalog has no source-name concept
// (SourceManager owns the source-name → catalog map); the catalog-level
// accessor exposes the first-attached backend's scheme as the primary.

import { describe, it, expect } from 'vitest'
import { TileCatalog } from './tile-catalog'
import { GeoJSONRuntimeBackend } from './sources/geojson-runtime-backend'

describe('TileCatalog.getScheme accessor (Phase 1b)', () => {
  it('returns undefined when no backend has been attached', () => {
    const catalog = new TileCatalog()
    expect(catalog.getScheme()).toBeUndefined()
  })

  it('returns the first-attached backend scheme after attachBackend', () => {
    const catalog = new TileCatalog()
    catalog.attachBackend(new GeoJSONRuntimeBackend())
    expect(catalog.getScheme()).toBe('web-mercator-xyz')
  })

  it('continues to return the primary scheme after multiple attaches', () => {
    const catalog = new TileCatalog()
    catalog.attachBackend(new GeoJSONRuntimeBackend())
    catalog.attachBackend(new GeoJSONRuntimeBackend())
    // First-attached wins. Both backends in Phase 1b declare the same
    // single-variant scheme; the assertion holds.
    expect(catalog.getScheme()).toBe('web-mercator-xyz')
  })
})
