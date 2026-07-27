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

  // #1333 — a pure ZOOM (no pan) near a region-boundary tie used to flip the resident model on
  // every such zoom, hard-swapping the coverage source and wiping every arrow for a screen that
  // mostly didn't move. Both boxes below are centred on the SAME point in the cbofs/dbofs shared
  // zone; only the extent (i.e. zoom) changes.
  describe('hysteresis (currentKey) — a boundary-adjacent zoom must not flip the resident model', () => {
    const wide: Bounds = [-76.9, 37.3, -73.9, 40.3] // half-extent 1.5° — cbofs wins outright
    const zoomedIn: Bounds = [-75.7, 38.5, -75.1, 39.1] // same centre, half-extent 0.3°

    it('without a currentKey, the tie-break still favours the smaller domain (unchanged default)', () => {
      expect(bestModelForBounds(wide)?.key).toBe('cbofs')
      expect(bestModelForBounds(zoomedIn)?.key).toBe('dbofs') // the bug: zoom alone flips it
    })

    it('WITH currentKey, zooming in on the same centre keeps the resident model', () => {
      expect(bestModelForBounds(wide, 'cbofs')?.key).toBe('cbofs')
      expect(bestModelForBounds(zoomedIn, 'cbofs')?.key).toBe('cbofs') // stays — the fix
    })

    it('a DECISIVE pan (not just zoom) still switches despite the current bias', () => {
      // Fully inside dbofs only, far from cbofs — no tie, no ambiguity.
      const clearlyDelaware: Bounds = [-75.3, 39.0, -74.6, 39.8]
      expect(bestModelForBounds(clearlyDelaware, 'cbofs')?.key).toBe('dbofs')
    })

    it('switches away once the current model no longer overlaps at all', () => {
      const midPacific: Bounds = [-160, 10, -150, 20]
      expect(bestModelForBounds(midPacific, 'cbofs')).toBeNull()
    })
  })
})
