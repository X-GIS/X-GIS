import { describe, it, expect } from 'vitest'
import { lonLatToECEF } from '@xgis/shared'
import { packRetainedArrowFeat, packRetainedArrowTint } from './retained-arrow-packer'
import {
  ARROW_RETAINED_FEAT,
  ARROW_RETAINED_TINT_STRIDE,
} from '../shaders/dsl/arrow-retained-feat-layout'
import type { ArrowDrawSpec } from './graphics-types'

const F = ARROW_RETAINED_FEAT.slot
const S = ARROW_RETAINED_FEAT.stride
const DEG2RAD = Math.PI / 180
// Mirrors the packer's private TIP_STEP_DEG — the geographic step from tail to tip.
const TIP_STEP_DEG = 0.02

interface Flow {
  lngLat: readonly [number, number]
  bearing: number
}
const flows: Flow[] = [
  { lngLat: [10, 20], bearing: 0 }, // due north
  { lngLat: [-30, 45], bearing: 90 }, // due east
  { lngLat: [126.98, 37.57], bearing: 45 }, // north-east (Seoul)
]

function arrowSpec(overrides: Partial<ArrowDrawSpec<Flow>> = {}): ArrowDrawSpec<Flow> {
  return {
    type: 'arrow',
    data: flows,
    getPosition: (f) => f.lngLat,
    getBearing: (f) => f.bearing,
    ...overrides,
  }
}

describe('#824/#825 retained-arrow packer', () => {
  it('runs each accessor EXACTLY ONCE per item (no per-frame closure)', () => {
    let posCalls = 0
    let brgCalls = 0
    let sizeCalls = 0
    let colorCalls = 0
    const spec = arrowSpec({
      getPosition: (f) => {
        posCalls++
        return f.lngLat
      },
      getBearing: (f) => {
        brgCalls++
        return f.bearing
      },
      getSize: () => {
        sizeCalls++
        return 100
      },
      getColor: () => {
        colorCalls++
        return [1, 0, 0, 1]
      },
    })
    packRetainedArrowFeat(spec, 1)
    packRetainedArrowTint(spec)
    const n = flows.length
    // feat pack: position/bearing/size once each; tint pack: color once each.
    expect(posCalls).toBe(n)
    expect(brgCalls).toBe(n)
    expect(sizeCalls).toBe(n)
    expect(colorCalls).toBe(n)
  })

  it('tint pack touches ONLY getColor (the color-only update path)', () => {
    let posCalls = 0
    let brgCalls = 0
    let colorCalls = 0
    const spec = arrowSpec({
      getPosition: (f) => {
        posCalls++
        return f.lngLat
      },
      getBearing: (f) => {
        brgCalls++
        return f.bearing
      },
      getColor: () => {
        colorCalls++
        return [0.5, 0.5, 0.5, 1]
      },
    })
    packRetainedArrowTint(spec)
    // update({triggers:['color']}) re-packs tint only → getPosition/getBearing NOT re-run.
    expect(colorCalls).toBe(flows.length)
    expect(posCalls).toBe(0)
    expect(brgCalls).toBe(0)
  })

  it('packs the TAIL ECEF + abs lon/lat DSFUN matching the point packer math', () => {
    const feat = packRetainedArrowFeat(arrowSpec(), 1)
    for (let i = 0; i < flows.length; i++) {
      const o = i * S
      const [lon, lat] = flows[i]!.lngLat
      // Stored into a Float32Array → the abs lon/lat is the f32 of the source double.
      expect(feat[o + F.abs_lon]).toBe(Math.fround(lon))
      expect(feat[o + F.abs_lat]).toBe(Math.fround(lat))
      const ecef = lonLatToECEF(lon, lat)
      const exH = Math.fround(ecef[0])
      // hi/lo DSFUN split must reconstruct the double-precision ECEF exactly.
      expect(feat[o + F.ecef_x_h]).toBe(exH)
      expect(feat[o + F.ecef_x_h] + feat[o + F.ecef_x_l]).toBeCloseTo(ecef[0], 6)
    }
  })

  it('steps the TIP one bearing-step along the geographic direction (0=N, CW)', () => {
    const feat = packRetainedArrowFeat(arrowSpec(), 1)
    for (let i = 0; i < flows.length; i++) {
      const o = i * S
      const [lon, lat] = flows[i]!.lngLat
      const br = flows[i]!.bearing * DEG2RAD
      const dLat = Math.cos(br) * TIP_STEP_DEG
      const cosLat = Math.cos(lat * DEG2RAD) || 1
      const dLon = (Math.sin(br) * TIP_STEP_DEG) / cosLat
      // Stored as f32 — compare against the same f32 the packer wrote (exact).
      expect(feat[o + F.tip_abs_lat]).toBe(Math.fround(lat + dLat))
      expect(feat[o + F.tip_abs_lon]).toBe(Math.fround(lon + dLon))
      // The tip ECEF DSFUN reconstructs the stepped tip lon/lat, not the tail's.
      const tipEcef = lonLatToECEF(lon + dLon, lat + dLat)
      expect(feat[o + F.tip_ecef_x_h] + feat[o + F.tip_ecef_x_l]).toBeCloseTo(tipEcef[0], 6)
    }
  })

  it('north bearing steps +lat only; east bearing steps +lon only', () => {
    const north = packRetainedArrowFeat(arrowSpec({ data: [{ lngLat: [0, 0], bearing: 0 }] }), 1)
    expect(north[F.tip_abs_lat]).toBeCloseTo(TIP_STEP_DEG, 6)
    expect(north[F.tip_abs_lon]).toBeCloseTo(0, 6)
    const east = packRetainedArrowFeat(arrowSpec({ data: [{ lngLat: [0, 0], bearing: 90 }] }), 1)
    expect(east[F.tip_abs_lon]).toBeCloseTo(TIP_STEP_DEG, 6) // cos(lat 0) = 1
    expect(east[F.tip_abs_lat]).toBeCloseTo(0, 6)
  })

  it('scales the arrow length by getSize × dpr; defaults size 1 / bearing north', () => {
    const feat = packRetainedArrowFeat(arrowSpec({ getSize: 50 }), 2)
    for (let i = 0; i < flows.length; i++) {
      expect(feat[i * S + F.size]).toBe(100) // 50 × dpr 2
    }
    const dflt = packRetainedArrowFeat(
      { type: 'arrow', data: [{ lngLat: [0, 0], bearing: 0 }], getPosition: [0, 0] },
      1,
    )
    expect(dflt[F.size]).toBe(1) // getSize absent → 1
    expect(dflt[F.tip_abs_lat]).toBeCloseTo(TIP_STEP_DEG, 6) // getBearing absent → 0 (north)
    expect(dflt[F.tip_abs_lon]).toBeCloseTo(0, 6)
  })

  it('normalises the tint rgba (default white, hex, and tuple)', () => {
    const white = packRetainedArrowTint(arrowSpec()) // no getColor → white
    expect([white[0], white[1], white[2], white[3]]).toEqual([1, 1, 1, 1])
    const red = packRetainedArrowTint(arrowSpec({ getColor: '#ff0000' }))
    expect(red[0]).toBeCloseTo(1, 5)
    expect(red[1]).toBeCloseTo(0, 5)
    expect(red[2]).toBeCloseTo(0, 5)
    expect(red[3]).toBeCloseTo(1, 5)
    const tuple = packRetainedArrowTint(arrowSpec({ getColor: [0.2, 0.4, 0.6, 0.8] }))
    // Float32Array storage → compare with f32 tolerance, not exact.
    expect(tuple[0]).toBeCloseTo(0.2, 5)
    expect(tuple[1]).toBeCloseTo(0.4, 5)
    expect(tuple[2]).toBeCloseTo(0.6, 5)
    expect(tuple[3]).toBeCloseTo(0.8, 5)
    expect(white.length).toBe(flows.length * ARROW_RETAINED_TINT_STRIDE)
  })
})
