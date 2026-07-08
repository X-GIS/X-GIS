import { describe, it, expect } from 'vitest'
import { mercatorYToLat, MERCATOR_LAT_LIMIT } from '@xgis/geo'

// Pins the invariant behind the render-loop RTC-centre clamp unification
// (P2 2.6): the RTC-centre latitude is now clamped to ±MERCATOR_LAT_LIMIT,
// the SAME limit the camera position uses (Camera.MAX_Y = ±20037508.34 m =
// ±85.051129°) — not a tighter ±85.0. This test proves the clamp is a no-op
// at the camera's own limit, so the RTC centre matches the camera position
// near the pole instead of falling ~5.7 km short.

describe('Mercator latitude limit consistency', () => {
  it('MERCATOR_LAT_LIMIT is the canonical Web-Mercator clamp (±85.051129°)', () => {
    expect(MERCATOR_LAT_LIMIT).toBeCloseTo(85.051129, 5)
  })

  it('mercatorYToLat at the camera MAX_Y equals MERCATOR_LAT_LIMIT', () => {
    const MAX_Y = 20037508.34 // Camera.MAX_Y
    expect(mercatorYToLat(MAX_Y)).toBeCloseTo(MERCATOR_LAT_LIMIT, 3)
    expect(mercatorYToLat(-MAX_Y)).toBeCloseTo(-MERCATOR_LAT_LIMIT, 3)
  })

  it('the ±85.0 it replaced was tighter than the camera limit (the drift it fixes)', () => {
    // A centre at the camera limit projected to lat would have been clamped
    // 0.051° short by the old ±85.0.
    expect(MERCATOR_LAT_LIMIT).toBeGreaterThan(85.0)
  })
})
