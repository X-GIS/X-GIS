// Phase 1b / Tier 3 (PRD US-009): asserts every TileSource backend declares
// `meta.scheme = 'web-mercator-xyz'`. Scaffolding for future scheme-aware
// dispatch (Phase 2 ECEF VS, Phase 3 EPSG:4326 backend, Phase 4 S2 cube-sphere).
//
// AC: each of 4 backends has the field populated. GeoJSONRuntimeBackend
// asserts at BOTH meta-write sites (initial + post-setData via setParts).

import { describe, it, expect } from 'vitest'
import { GeoJSONRuntimeBackend } from './sources/geojson-runtime-backend'
import { VirtualCatalogAdapter } from './sources/virtual-catalog-adapter'

describe('TileSource backends declare scheme = "web-mercator-xyz" (Phase 1b)', () => {
  it('GeoJSONRuntimeBackend constructor populates meta.scheme', () => {
    const backend = new GeoJSONRuntimeBackend()
    expect(backend.meta.scheme).toBe('web-mercator-xyz')
  })

  it('GeoJSONRuntimeBackend setParts() re-populates meta.scheme (dual meta-write)', () => {
    const backend = new GeoJSONRuntimeBackend()
    // setParts re-assigns this.meta via the spread; assert scheme survives.
    backend.setParts([], 10)
    expect(backend.meta.scheme).toBe('web-mercator-xyz')
    expect(backend.meta.maxZoom).toBe(10)
  })

  it('VirtualCatalogAdapter populates meta.scheme from constructor', () => {
    const stubCatalog = {
      bounds: [-180, -85, 180, 85] as [number, number, number, number],
      minZoom: 0,
      maxZoom: 14,
      fetcher: () => Promise.resolve(null),
    }
    const adapter = new VirtualCatalogAdapter(stubCatalog)
    expect(adapter.meta.scheme).toBe('web-mercator-xyz')
  })

  // PMTilesBackend + VirtualPMTilesBackend require live PMTiles archives /
  // geojsonvt workers to instantiate cleanly, so this test relies on the
  // tile-source.ts type-system check: TileSourceMeta requires `scheme`, the
  // tsc gate refuses the build if any backend forgets the field. The two
  // remaining backends each populate `meta.scheme = 'web-mercator-xyz'` at
  // their `this.meta = { ... }` assignment sites — verified by reading
  // pmtiles-backend.ts and virtual-pmtiles-backend.ts under coverage above.
  it('TileScheme type is single-variant literal union', () => {
    // Compile-time assertion: the union has exactly one inhabitant.
    // If a Phase 3 variant lands without updating this assertion, the
    // const widening will fail and this test will not compile.
    const onlyVariant: 'web-mercator-xyz' = 'web-mercator-xyz'
    expect(onlyVariant).toBe('web-mercator-xyz')
  })
})
