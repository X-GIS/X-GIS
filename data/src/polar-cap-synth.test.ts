// Polar cap synthesizer for PMTiles/TileJSON: verify ring geometry,
// projection gating, and feature properties.

import { describe, expect, it } from 'vitest'
import { synthesizePolarCaps, projectionNeedsPolarCaps } from './polar-cap-synth'

describe('synthesizePolarCaps', () => {
  it('produces a FeatureCollection with two cap polygons by default', () => {
    const fc = synthesizePolarCaps()
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.features.length).toBe(2)
    expect(fc.features.map((f) => f.properties.pole).sort()).toEqual(['north', 'south'])
  })

  it('emits only one pole when poles=north or poles=south', () => {
    const north = synthesizePolarCaps({ poles: 'north' })
    expect(north.features.length).toBe(1)
    expect(north.features[0].properties.pole).toBe('north')

    const south = synthesizePolarCaps({ poles: 'south' })
    expect(south.features.length).toBe(1)
    expect(south.features[0].properties.pole).toBe('south')
  })

  it('respects lonSegments — more segments → more vertices', () => {
    const coarse = synthesizePolarCaps({ lonSegments: 8, poles: 'north' })
    const fine = synthesizePolarCaps({ lonSegments: 72, poles: 'north' })
    const cv = coarse.features[0].geometry.coordinates[0].length
    const fv = fine.features[0].geometry.coordinates[0].length
    expect(fv).toBeGreaterThan(cv)
    // Two rings (outer at threshold, inner near pole) × (segments+1) + closing vertex
    expect(cv).toBe((8 + 1) * 2 + 1)
    expect(fv).toBe((72 + 1) * 2 + 1)
  })

  it('clamps lonSegments to minimum 8', () => {
    const tiny = synthesizePolarCaps({ lonSegments: 2, poles: 'north' })
    const v = tiny.features[0].geometry.coordinates[0].length
    expect(v).toBe((8 + 1) * 2 + 1)
  })

  it('north ring stays at +latThreshold on the outer perimeter', () => {
    const fc = synthesizePolarCaps({ latThreshold: 85, lonSegments: 8, poles: 'north' })
    const ring = fc.features[0].geometry.coordinates[0]
    // First 9 entries are the outer ring at latThreshold.
    for (let i = 0; i <= 8; i++) {
      expect(ring[i][1]).toBeCloseTo(85, 5)
    }
  })

  it('south ring uses negative latitude', () => {
    const fc = synthesizePolarCaps({ latThreshold: 85, lonSegments: 8, poles: 'south' })
    const ring = fc.features[0].geometry.coordinates[0]
    for (let i = 0; i <= 8; i++) {
      expect(ring[i][1]).toBeCloseTo(-85, 5)
    }
  })

  it('inner perimeter approaches the pole', () => {
    const fc = synthesizePolarCaps({ poles: 'north', lonSegments: 8 })
    const ring = fc.features[0].geometry.coordinates[0]
    // Inner ring is from index 9 to 17 (8+1 = 9 outer, then 9 inner).
    for (let i = 9; i < 18; i++) {
      expect(ring[i][1]).toBeGreaterThan(89)
    }
  })

  it('ring is closed (last vertex equals first)', () => {
    const fc = synthesizePolarCaps({ poles: 'north', lonSegments: 8 })
    const ring = fc.features[0].geometry.coordinates[0]
    expect(ring[ring.length - 1]).toEqual(ring[0])
  })

  it('uses stable ids for cap features', () => {
    const fc = synthesizePolarCaps()
    const ids = fc.features.map((f) => f.id)
    expect(ids).toContain('__xgis_polar_cap_north__')
    expect(ids).toContain('__xgis_polar_cap_south__')
  })

  it('merges featureProperty into output feature properties', () => {
    const fc = synthesizePolarCaps({
      featureProperty: { kind: 'ocean', layer: 'polar' },
      poles: 'north',
    })
    expect(fc.features[0].properties.kind).toBe('ocean')
    expect(fc.features[0].properties.layer).toBe('polar')
    expect(fc.features[0].properties.pole).toBe('north')
  })
})

describe('projectionNeedsPolarCaps', () => {
  it('excludes mercator and oblique mercator', () => {
    expect(projectionNeedsPolarCaps('mercator')).toBe(false)
    expect(projectionNeedsPolarCaps('oblique_mercator')).toBe(false)
    expect(projectionNeedsPolarCaps('obliqueMercator')).toBe(false)
  })

  it('includes pole-rendering projections', () => {
    expect(projectionNeedsPolarCaps('globe')).toBe(true)
    expect(projectionNeedsPolarCaps('orthographic')).toBe(true)
    expect(projectionNeedsPolarCaps('azimuthal_equidistant')).toBe(true)
    expect(projectionNeedsPolarCaps('stereographic')).toBe(true)
    expect(projectionNeedsPolarCaps('equirectangular')).toBe(true)
    expect(projectionNeedsPolarCaps('natural_earth')).toBe(true)
  })

  it('returns false for unknown projection names (defensive)', () => {
    expect(projectionNeedsPolarCaps('not-a-real-projection')).toBe(false)
    expect(projectionNeedsPolarCaps('')).toBe(false)
  })
})
