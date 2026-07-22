import { describe, expect, it } from 'vitest'
import { S111_MODELS, modelsForBounds, bestModelForBounds, type Bounds } from './s111-models'

describe('S-111 model→bbox registry (#1272 E-④)', () => {
  it('every model has a well-formed envelope and a unique key', () => {
    const keys = new Set<string>()
    for (const m of S111_MODELS) {
      expect(m.bounds[0]).toBeLessThan(m.bounds[2]) // west < east
      expect(m.bounds[1]).toBeLessThan(m.bounds[3]) // south < north
      expect(keys.has(m.key)).toBe(false)
      keys.add(m.key)
    }
    expect(keys.size).toBe(S111_MODELS.length)
  })

  it('picks the covering regional model for a viewport over that region', () => {
    const chesapeake: Bounds = [-76.6, 37.5, -75.9, 38.3]
    expect(bestModelForBounds(chesapeake)?.key).toBe('cbofs')
  })

  it('breaks a containment tie toward the SMALLER (more local) domain', () => {
    // A San Francisco Bay view sits fully inside BOTH sfbofs (local) and wcofs (the whole
    // West Coast). Both overlap the full view area → tie → the local, higher-res model wins.
    const sfBay: Bounds = [-122.6, 37.5, -122.1, 38.0]
    expect(bestModelForBounds(sfBay)?.key).toBe('sfbofs')
  })

  it('returns null / empty when the viewport covers no model (mid-ocean)', () => {
    const midPacific: Bounds = [-160, 10, -150, 20]
    expect(bestModelForBounds(midPacific)).toBeNull()
    expect(modelsForBounds(midPacific)).toEqual([])
  })

  it('lists every overlapping model, most-overlap-first, across a boundary', () => {
    // A mid-Atlantic view spans both Chesapeake (cbofs) and Delaware (dbofs) bays.
    const midAtlantic: Bounds = [-76.5, 37.5, -74.5, 39.5]
    const keys = modelsForBounds(midAtlantic).map((m) => m.key)
    expect(keys).toContain('cbofs')
    expect(keys).toContain('dbofs')
    expect(keys[0]).toBe('cbofs') // larger overlap leads
  })
})
