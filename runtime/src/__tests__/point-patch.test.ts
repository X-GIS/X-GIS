import { describe, it, expect } from 'vitest'
import { pointPatchToFeatureCollection } from '../engine/id-resolver'

describe('pointPatchToFeatureCollection', () => {
  it('synthesizes a FeatureCollection from parallel arrays', () => {
    const fc = pointPatchToFeatureCollection({
      lon: new Float32Array([-30, 0, 30]),
      lat: new Float32Array([0, 10, 0]),
      ids: new Uint32Array([101, 102, 103]),
    })
    expect(fc.type).toBe('FeatureCollection')
    expect(fc.features).toHaveLength(3)
    expect(fc.features[0]).toMatchObject({
      type: 'Feature',
      id: 101,
      geometry: { type: 'Point' },
      properties: {},
    })
    expect(fc.features[0].geometry?.coordinates[0]).toBeCloseTo(-30, 2)
    expect(fc.features[1].id).toBe(102)
    expect(fc.features[2].id).toBe(103)
  })

  it('falls back to array index when ids is omitted', () => {
    const fc = pointPatchToFeatureCollection({
      lon: [-10, 10],
      lat: [0, 0],
    })
    expect(fc.features[0].id).toBe(0)
    expect(fc.features[1].id).toBe(1)
  })

  it('bundles SoA properties into per-feature objects', () => {
    const fc = pointPatchToFeatureCollection({
      lon: [0, 10, 20],
      lat: [0, 0, 0],
      properties: {
        callsign: ['ALPHA', 'BRAVO', 'CHARLIE'],
        alt_m: new Float32Array([1000, 2000, 3000]),
      },
    })
    expect(fc.features[0].properties).toEqual({ callsign: 'ALPHA', alt_m: 1000 })
    expect(fc.features[1].properties).toEqual({ callsign: 'BRAVO', alt_m: 2000 })
    expect(fc.features[2].properties).toEqual({ callsign: 'CHARLIE', alt_m: 3000 })
  })

  it('throws on lon/lat length mismatch', () => {
    expect(() => pointPatchToFeatureCollection({
      lon: [0, 10],
      lat: [0],
    })).toThrow(/lon\/lat length mismatch/)
  })

  it('throws on ids length mismatch', () => {
    expect(() => pointPatchToFeatureCollection({
      lon: [0, 10, 20],
      lat: [0, 0, 0],
      ids: new Uint32Array([1, 2]),
    })).toThrow(/ids length/)
  })

  it('throws on property column length mismatch', () => {
    expect(() => pointPatchToFeatureCollection({
      lon: [0, 10],
      lat: [0, 0],
      properties: { callsign: ['A'] },
    })).toThrow(/property "callsign" length/)
  })

  it('handles zero-length input (empty push)', () => {
    const fc = pointPatchToFeatureCollection({
      lon: new Float32Array([]),
      lat: new Float32Array([]),
    })
    expect(fc.features).toHaveLength(0)
  })
})
