// Pin defensive guards in pointPatchToFeatureCollection. Pre-fix
// null / non-object input crashed opaquely on `.lon.length`; TS-
// typed-as-PointPatch casts at the boundary could let unexpected
// values through.

import { describe, it, expect } from 'vitest'
import { pointPatchToFeatureCollection } from './id-resolver'

describe('pointPatchToFeatureCollection defensive guards', () => {
  it('null data throws clear error', () => {
    expect(() => pointPatchToFeatureCollection(null as never))
      .toThrow(/data must be \{ lon: ArrayLike<number>, lat: ArrayLike<number>/)
  })

  it('missing lon throws clear error', () => {
    expect(() => pointPatchToFeatureCollection({ lat: [1] } as never))
      .toThrow(/data must be \{ lon:/)
  })

  it('missing lat throws clear error', () => {
    expect(() => pointPatchToFeatureCollection({ lon: [1] } as never))
      .toThrow(/data must be \{ lon: ArrayLike<number>, lat:/)
  })

  it('empty arrays produce empty FeatureCollection (regression guard)', () => {
    const result = pointPatchToFeatureCollection({ lon: [], lat: [] })
    expect(result.type).toBe('FeatureCollection')
    expect(result.features).toHaveLength(0)
  })

  it('matching lengths produce expected features (regression guard)', () => {
    const result = pointPatchToFeatureCollection({
      lon: new Float32Array([10, 20, 30]),
      lat: new Float32Array([40, 50, 60]),
      ids: new Uint32Array([1, 2, 3]),
    })
    expect(result.features).toHaveLength(3)
    expect(result.features[0]!.id).toBe(1)
    expect((result.features[0]!.geometry as { coordinates: [number, number] }).coordinates[0]).toBeCloseTo(10)
  })
})
