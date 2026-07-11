import { describe, it, expect } from 'vitest'
import { lonLatToECEF } from '@xgis/shared'
import { packRetainedCircleFeat, packRetainedCircleTint } from './retained-circle-packer'
import {
  CIRCLE_RETAINED_FEAT,
  CIRCLE_RETAINED_TINT_STRIDE,
} from '../shaders/dsl/circle-retained-feat-layout'
import type { CircleDrawSpec } from './graphics-types'

const F = CIRCLE_RETAINED_FEAT.slot
const S = CIRCLE_RETAINED_FEAT.stride

interface Pt {
  lngLat: readonly [number, number]
  r: number
}
const pts: Pt[] = [
  { lngLat: [10, 20], r: 4 },
  { lngLat: [-30, 45], r: 8 },
  { lngLat: [126.98, 37.57], r: 12 }, // Seoul
]

function circleSpec(overrides: Partial<CircleDrawSpec<Pt>> = {}): CircleDrawSpec<Pt> {
  return {
    type: 'circle',
    data: pts,
    getPosition: (p) => p.lngLat,
    getRadius: (p) => p.r,
    ...overrides,
  }
}

describe('#797 retained-circle packer', () => {
  it('runs each accessor EXACTLY ONCE per item (no per-frame closure)', () => {
    let posCalls = 0
    let radCalls = 0
    let colorCalls = 0
    let strokeCalls = 0
    const spec = circleSpec({
      getPosition: (p) => {
        posCalls++
        return p.lngLat
      },
      getRadius: (p) => {
        radCalls++
        return p.r
      },
      getColor: () => {
        colorCalls++
        return [1, 0, 0, 1]
      },
      getStrokeColor: () => {
        strokeCalls++
        return [0, 0, 0, 1]
      },
    })
    packRetainedCircleFeat(spec, 1)
    packRetainedCircleTint(spec)
    const n = pts.length
    expect(posCalls).toBe(n)
    expect(radCalls).toBe(n)
    expect(strokeCalls).toBe(n) // stroke colour packed into feat
    expect(colorCalls).toBe(n) // fill colour packed into tint
  })

  it('tint pack touches ONLY getColor (the color-only update path)', () => {
    let posCalls = 0
    let radCalls = 0
    let colorCalls = 0
    const spec = circleSpec({
      getPosition: (p) => {
        posCalls++
        return p.lngLat
      },
      getRadius: (p) => {
        radCalls++
        return p.r
      },
      getColor: () => {
        colorCalls++
        return [0.5, 0.5, 0.5, 1]
      },
    })
    packRetainedCircleTint(spec)
    // update({triggers:['color']}) re-packs tint only → getPosition/getRadius NOT re-run.
    expect(colorCalls).toBe(pts.length)
    expect(posCalls).toBe(0)
    expect(radCalls).toBe(0)
  })

  it('packs the ECEF + abs lon/lat DSFUN matching the point/arrow packer math', () => {
    const feat = packRetainedCircleFeat(circleSpec(), 1)
    for (let i = 0; i < pts.length; i++) {
      const o = i * S
      const [lon, lat] = pts[i]!.lngLat
      expect(feat[o + F.abs_lon]).toBe(Math.fround(lon))
      expect(feat[o + F.abs_lat]).toBe(Math.fround(lat))
      const ecef = lonLatToECEF(lon, lat)
      expect(feat[o + F.ecef_x_h]).toBe(Math.fround(ecef[0]))
      expect(feat[o + F.ecef_x_h] + feat[o + F.ecef_x_l]).toBeCloseTo(ecef[0], 6)
    }
  })

  it('scales radius + stroke width by dpr', () => {
    const feat = packRetainedCircleFeat(circleSpec({ getRadius: 5, getStrokeWidth: 2 }), 2)
    for (let i = 0; i < pts.length; i++) {
      const o = i * S
      expect(feat[o + F.radius_px]).toBe(10) // 5 × dpr 2
      expect(feat[o + F.stroke_width_px]).toBe(4) // 2 × dpr 2
    }
  })

  it('defaults radius 4, stroke width 0, transparent stroke, white fill', () => {
    const feat = packRetainedCircleFeat(
      { type: 'circle', data: [{ lngLat: [0, 0], r: 0 }], getPosition: [0, 0] },
      1,
    )
    expect(feat[F.radius_px]).toBe(4) // getRadius absent → 4
    expect(feat[F.stroke_width_px]).toBe(0) // getStrokeWidth absent → 0
    expect(feat[F.stroke_a]).toBe(0) // getStrokeColor absent → transparent
    const tint = packRetainedCircleTint({
      type: 'circle',
      data: [{ lngLat: [0, 0], r: 0 }],
      getPosition: [0, 0],
    })
    expect([tint[0], tint[1], tint[2], tint[3]]).toEqual([1, 1, 1, 1]) // getColor absent → white
  })

  it('normalises fill tint (default white, hex, tuple) and stroke rgba', () => {
    const white = packRetainedCircleTint(circleSpec()) // no getColor → white
    expect([white[0], white[1], white[2], white[3]]).toEqual([1, 1, 1, 1])
    expect(white.length).toBe(pts.length * CIRCLE_RETAINED_TINT_STRIDE)
    const red = packRetainedCircleTint(circleSpec({ getColor: '#ff0000' }))
    expect(red[0]).toBeCloseTo(1, 5)
    expect(red[1]).toBeCloseTo(0, 5)
    expect(red[2]).toBeCloseTo(0, 5)
    const feat = packRetainedCircleFeat(circleSpec({ getStrokeColor: [0.2, 0.4, 0.6, 0.8] }), 1)
    expect(feat[F.stroke_r]).toBeCloseTo(0.2, 5)
    expect(feat[F.stroke_g]).toBeCloseTo(0.4, 5)
    expect(feat[F.stroke_b]).toBeCloseTo(0.6, 5)
    expect(feat[F.stroke_a]).toBeCloseTo(0.8, 5)
  })
})
