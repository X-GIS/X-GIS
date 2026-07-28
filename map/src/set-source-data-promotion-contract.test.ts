// Pin Mapbox-parity auto-promotion contract in setSourceData:
//   - FeatureCollection → stored as-is
//   - Feature → wrapped in single-feature FeatureCollection
//   - bare Geometry → wrapped in Feature → wrapped in FeatureCollection
// Pre-fix any non-FC shape threw `data.features must be an array` —
// confusing because Mapbox GL JS accepts all three shapes.
//
// This suite used to re-implement the normalisation inline, because
// `XGISMap` instantiation requires a GPU context. That mirror executed ZERO
// production code — it passed byte-identically whether the real branches were
// correct, inverted, or deleted — and it had silently drifted from them (its
// geometry arm demanded a `type` string the real one never reads). Now that
// the logic lives in its own module, the real function is importable without a
// GPU context, so the suite calls it directly.

import { describe, it, expect } from 'vitest'
import { normaliseHostPushedData } from './source-data-normalize'
import type { GeoJSONFeature, GeoJSONFeatureCollection, GeoJSONGeometry } from '@xgis/data'

type Input = GeoJSONFeatureCollection | GeoJSONFeature | GeoJSONGeometry
const normalise = (data: unknown) => normaliseHostPushedData('test-source', data as Input)

describe('setSourceData auto-promotion contract', () => {
  it('FeatureCollection passes through unchanged', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
      ],
    }
    expect(normalise(fc)).toBe(fc)
  })

  it('single Feature wraps in FeatureCollection', () => {
    const feat = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [10, 20] },
      properties: { name: 'A' },
    }
    const result = normalise(feat)
    expect(result.type).toBe('FeatureCollection')
    expect(result.features).toHaveLength(1)
    expect(result.features[0]).toBe(feat)
  })

  it('bare Point geometry wraps in Feature inside FeatureCollection', () => {
    const geom = { type: 'Point', coordinates: [30, 40] }
    const result = normalise(geom)
    expect(result.type).toBe('FeatureCollection')
    expect(result.features).toHaveLength(1)
    expect(result.features[0].type).toBe('Feature')
    expect(result.features[0].geometry).toBe(geom)
    expect(result.features[0].properties).toEqual({})
  })

  it('bare Polygon geometry wraps', () => {
    const geom = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    }
    expect(normalise(geom).features).toHaveLength(1)
  })

  it('discriminates a bare Geometry on `coordinates`, not on its `type` string', () => {
    // The retired mirror keyed the geometry arm on `typeof type === 'string' &&
    // type !== 'FeatureCollection' && type !== 'Feature' && coordinates !==
    // undefined`. The real code asks only `'coordinates' in data`. These two
    // inputs are exactly where those disagree, so they pin which rule shipped.
    const noType = { coordinates: [0, 0] } as unknown
    expect(normalise(noType).features).toHaveLength(1)

    // An FC that also carries `coordinates` takes the geometry arm, because
    // the Feature/geometry checks run before the fall-through.
    const fcWithCoords = { type: 'FeatureCollection', features: [], coordinates: [1, 1] } as unknown
    const r = normalise(fcWithCoords)
    expect(r.features).toHaveLength(1)
    expect(r.features[0].geometry).toBe(fcWithCoords)
  })

  it('throws on null / non-object rather than returning a sentinel', () => {
    for (const bad of [null, 42, []]) {
      expect(() => normalise(bad)).toThrow(/must be a FeatureCollection object/)
    }
  })

  it('throws when `features` is not an array', () => {
    // A GeometryCollection has no `coordinates`, so it falls to the FC arm and
    // is rejected here — the documented behaviour of that fall-through.
    expect(() => normalise({ type: 'GeometryCollection', geometries: [] })).toThrow(
      /features must be an array/,
    )
    expect(() => normalise({ type: 'FeatureCollection', features: 'nope' })).toThrow(
      /features must be an array/,
    )
  })

  it('enforces the ingest budget on the normalised collection', () => {
    // The DoS guard is the reason this module can throw at all past the shape
    // checks. Nothing else in the suite reaches it, so deleting the
    // `assertIngestBudget` call would otherwise leave every test green.
    // Sparse array: `length` alone trips the feature-count cap, which is
    // checked before any element is walked — so this costs no allocation.
    const huge = { type: 'FeatureCollection', features: new Array(1_000_001) }
    expect(() => normalise(huge)).toThrow(/test-source/)
    expect(() => normalise(huge)).toThrow(/ingest cap/)
  })
})
