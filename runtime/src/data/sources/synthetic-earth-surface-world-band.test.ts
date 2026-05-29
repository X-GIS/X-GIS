import { describe, it, expect } from 'vitest'
import { SyntheticEarthSurfaceBackend } from './synthetic-earth-surface-backend'
import type { BackendTileResult, TileSourceSink } from '../tile-source'
import { MERCATOR_LAT_LIMIT } from '../../engine/projection/projection'

// ═══ Synthetic earth-surface band tracks projType (source-honest world band) ═══
//
// The backend's mesh latitude band now follows worldBandForProjType, wired via
// the constructor (XGISMap passes the resolved projType on install and
// re-installs on setProjection when the band kind changes):
//   mercator-class (0/1/6) → ±MERCATOR_LAT_LIMIT (±85.05°): Web-Mercator data
//     has nothing beyond ±85°, so the bg fill stops there — source-honest, no
//     fake polar fill.
//   natural_earth (2) + sphere-class (3/4/5/7) → ±90°: rims reach the poles.
//
// This replaces the earlier gap guard that pinned the unwired ±90 hardcode.
// The backend now honors the band, so we assert the correct per-projType
// extent. (Pixel verification is impossible under SwiftShader — getImageData
// is empty — so this CPU-geometry check is the automatable path; the rendered
// disc extent was confirmed via page.screenshot.)

function backendLatRange(projType?: number): { min: number; max: number } {
  const backend = new SyntheticEarthSurfaceBackend(projType)
  let result: BackendTileResult | null = null
  backend.attach({
    acceptResult: (_key: number, r: BackendTileResult) => { result = r },
  } as unknown as TileSourceSink)
  if (!result) throw new Error('backend did not emit a result on attach')
  const v = (result as BackendTileResult).vertices
  const n = v.length / 6
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < n; i++) {
    const lat = v[i * 6 + 5]! // abs_lat tail at stride-6 offset 5
    if (lat < min) min = lat
    if (lat > max) max = lat
  }
  return { min, max }
}

describe('synthetic earth-surface band tracks projType (source-honest world band)', () => {
  it('mercator-class (0/1/6) clamps the bg mesh at ±85.05° — source-honest Web-Mercator extent', () => {
    for (const projType of [0, 1, 6]) {
      const { min, max } = backendLatRange(projType)
      expect(max).toBeCloseTo(MERCATOR_LAT_LIMIT, 1)
      expect(min).toBeCloseTo(-MERCATOR_LAT_LIMIT, 1)
    }
  })

  it('natural_earth (2) + sphere-class (3/4/5/7) reach the poles (±90°)', () => {
    for (const projType of [2, 3, 4, 5, 7]) {
      const { min, max } = backendLatRange(projType)
      expect(max).toBeCloseTo(90, 1)
      expect(min).toBeCloseTo(-90, 1)
    }
  })

  it('default projType (0) is mercator-clamped, NOT the old ±90 hardcode (regression)', () => {
    const { max } = backendLatRange() // no arg → constructor default 0
    expect(max).toBeCloseTo(MERCATOR_LAT_LIMIT, 1)
    expect(max).toBeLessThan(86) // was ±90 before the worldBand wiring
  })
})
