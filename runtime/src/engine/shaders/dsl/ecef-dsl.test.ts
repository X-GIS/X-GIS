import { describe, it, expect } from 'vitest'
import { module } from '@xgis/shader-dsl'
import { compileModule } from '@xgis/shader-dsl'
import { ECEF_CONSTS, ECEF_FUNCS } from './ecef'

// The DSL ecef fns must compute exactly the WGS84 ellipsoid ECEF formula. Evaluated on
// the CPU backend and compared to a plain JS reference — this proves the math regardless
// of how the WGSL is now formatted (the absorption is NOT byte-identical to the old raw
// string, so byte-cmp can't be the gate; math-equivalence is).
const WGS84_A = 6378137.0
const WGS84_E2 = 0.0066943799901975955
function ref(lonRad: number, latRad: number, h: number): [number, number, number] {
  const s = Math.sin(latRad)
  const c = Math.cos(latRad)
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s)
  return [(n + h) * c * Math.cos(lonRad), (n + h) * c * Math.sin(lonRad), (n * (1 - WGS84_E2) + h) * s]
}

const M = compileModule(module({ consts: ECEF_CONSTS, funcs: ECEF_FUNCS }))

describe('ecef DSL — CPU eval matches the WGS84 reference', () => {
  const cases: Array<[number, number, number]> = [
    [0, 0, 0], [127, 37, 100], [-122, 45, -50], [180, -85, 0], [90, 60, 1000],
  ]
  for (const [lonDeg, latDeg, h] of cases) {
    it(`lonlat_to_ecef(${lonDeg}deg, ${latDeg}deg, ${h}m) == reference`, () => {
      const lon = (lonDeg * Math.PI) / 180
      const lat = (latDeg * Math.PI) / 180
      const got = M.fns.lonlat_to_ecef(lon, lat, h) as number[]
      const r = ref(lon, lat, h)
      for (let i = 0; i < 3; i++) expect(Math.abs(got[i] - r[i])).toBeLessThan(1e-3) // sub-mm
    })
  }

  it('ecef_rtc_reconstruct sums hi + lo', () => {
    const got = M.fns.ecef_rtc_reconstruct([1, 2, 3], [0.25, 0.5, 0.75]) as number[]
    expect(got[0]).toBeCloseTo(1.25)
    expect(got[1]).toBeCloseTo(2.5)
    expect(got[2]).toBeCloseTo(3.75)
  })
})
