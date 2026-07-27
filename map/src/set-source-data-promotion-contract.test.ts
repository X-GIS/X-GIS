// Pin Mapbox-parity auto-promotion contract in setSourceData:
//   - FeatureCollection → stored as-is
//   - Feature → wrapped in single-feature FeatureCollection
//   - bare Geometry → wrapped in Feature → wrapped in FeatureCollection
// Pre-fix any non-FC shape threw `data.features must be an array` —
// confusing because Mapbox GL JS accepts all three shapes.

import { describe, it, expect } from 'vitest'

// Inline the normalization logic to test it in isolation (XGISMap
// instantiation requires a GPU context).

function normalizeSetSourceDataInput(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const shape = data as {
    type?: string
    features?: unknown
    geometry?: unknown
    coordinates?: unknown
  }
  if (shape.type === 'Feature' && !Array.isArray(shape.features)) {
    return { type: 'FeatureCollection', features: [data] }
  }
  if (
    typeof shape.type === 'string' &&
    shape.type !== 'FeatureCollection' &&
    shape.type !== 'Feature' &&
    shape.coordinates !== undefined
  ) {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: data, properties: {} }],
    }
  }
  return data
}

describe('setSourceData auto-promotion contract', () => {
  it('FeatureCollection passes through unchanged', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
      ],
    }
    expect(normalizeSetSourceDataInput(fc)).toBe(fc)
  })

  it('single Feature wraps in FeatureCollection', () => {
    const feat = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [10, 20] },
      properties: { name: 'A' },
    }
    const result = normalizeSetSourceDataInput(feat) as { type: string; features: unknown[] }
    expect(result.type).toBe('FeatureCollection')
    expect(result.features).toHaveLength(1)
    expect(result.features[0]).toBe(feat)
  })

  it('bare Point geometry wraps in Feature inside FeatureCollection', () => {
    const geom = { type: 'Point', coordinates: [30, 40] }
    const result = normalizeSetSourceDataInput(geom) as {
      type: string
      features: { type: string; geometry: unknown; properties: unknown }[]
    }
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
    const result = normalizeSetSourceDataInput(geom) as { features: unknown[] }
    expect(result.features).toHaveLength(1)
  })

  it('null / non-object returns null (caller throws)', () => {
    expect(normalizeSetSourceDataInput(null)).toBeNull()
    expect(normalizeSetSourceDataInput(42)).toBeNull()
    expect(normalizeSetSourceDataInput([])).toBeNull()
  })
})
