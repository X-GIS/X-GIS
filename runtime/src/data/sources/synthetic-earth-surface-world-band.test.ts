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
//
// GEOID-UNIFICATION UPDATE (projection-matrix PR-1): the bg now encodes through
// the shared tiler kernel (packECEFPolygonVertices) so it sits on the SAME WGS84
// ellipsoid + RTC origin as tile ground polygons. The kernel consumes ABSOLUTE
// Mercator metres and re-emits abs_lat from the Merc-clamped mx/my, so every
// projType's abs_lat band is capped at ±MERCATOR_LAT_LIMIT (±85.051129) — the
// SAME cap real polar ground tiles carry. The sphere-class generator rows still
// span ±90 in lon/lat space, but the emitted ground geoid (and abs_lat) tracks
// the ±85 Mercator band. Reaching the geometric poles on globe/azimuthal is a
// separate polar-cap-synthesis concern (see 'polar cap gap on globe' memo), not
// a basis bug. We therefore assert the unified ±85 abs_lat cap across ALL
// projTypes here.

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

  it('natural_earth (2) + sphere-class (3/4/5/7) abs_lat caps at ±85.05° (Merc-clamped ground geoid)', () => {
    // Post geoid-unification: the sphere-band generator rows still span ±90 in
    // lon/lat, but the shared tiler kernel re-emits abs_lat from the Merc-clamped
    // mx/my, so the ENCODED ground band caps at ±MERCATOR_LAT_LIMIT — the same
    // ±85 cap real polar ground tiles carry (one geoid). Reaching the true poles
    // is a polar-cap-synthesis follow-up, not part of this basis fix.
    for (const projType of [2, 3, 4, 5, 7]) {
      const { min, max } = backendLatRange(projType)
      expect(max).toBeCloseTo(MERCATOR_LAT_LIMIT, 1)
      expect(min).toBeCloseTo(-MERCATOR_LAT_LIMIT, 1)
    }
  })

  it('default projType (0) is mercator-clamped, NOT the old ±90 hardcode (regression)', () => {
    const { max } = backendLatRange() // no arg → constructor default 0
    expect(max).toBeCloseTo(MERCATOR_LAT_LIMIT, 1)
    expect(max).toBeLessThan(86) // was ±90 before the worldBand wiring
  })
})
