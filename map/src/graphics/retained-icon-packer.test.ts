import { describe, it, expect } from 'vitest'
import { lonLatToECEF } from '@xgis/engine'
import {
  packRetainedIconFeat,
  packRetainedIconTint,
  type PackerAtlas,
} from './retained-icon-packer'
import {
  ICON_RETAINED_FEAT,
  ICON_RETAINED_TINT_STRIDE,
} from '../shaders/dsl/icon-retained-feat-layout'
import type { IconDrawSpec } from './graphics-types'

const F = ICON_RETAINED_FEAT.slot
const S = ICON_RETAINED_FEAT.stride

// A stub atlas: 'pin' is a 32×32 sprite at (64,128) on a 1024² page.
const atlas: PackerAtlas = {
  get: (name) =>
    name === 'pin'
      ? { name: 'pin', x: 64, y: 128, width: 32, height: 32, pixelRatio: 1, sdf: false }
      : undefined,
  size: () => ({ width: 1024, height: 1024 }),
}

interface Station {
  lngLat: readonly [number, number]
  hot: boolean
}
const stations: Station[] = [
  { lngLat: [10, 20], hot: true },
  { lngLat: [-30, 45], hot: false },
  { lngLat: [120, -60], hot: true },
]

function iconSpec(overrides: Partial<IconDrawSpec<Station>> = {}): IconDrawSpec<Station> {
  return {
    type: 'icon',
    data: stations,
    getPosition: (s) => s.lngLat,
    getImage: 'pin',
    ...overrides,
  }
}

describe('#797 P1 retained-icon packer', () => {
  it('runs each accessor EXACTLY ONCE per item (no per-frame closure)', () => {
    let posCalls = 0
    let imgCalls = 0
    let sizeCalls = 0
    let colorCalls = 0
    const spec = iconSpec({
      getPosition: (s) => {
        posCalls++
        return s.lngLat
      },
      getImage: () => {
        imgCalls++
        return 'pin'
      },
      getSize: () => {
        sizeCalls++
        return 1
      },
      getColor: () => {
        colorCalls++
        return [1, 0, 0, 1]
      },
    })
    packRetainedIconFeat(spec, atlas, 1)
    packRetainedIconTint(spec)
    const n = stations.length
    // feat pack: position/image/size once each; tint pack: color once each.
    expect(posCalls).toBe(n)
    expect(imgCalls).toBe(n)
    expect(sizeCalls).toBe(n)
    expect(colorCalls).toBe(n)
  })

  it('tint pack touches ONLY getColor (the color-only update path)', () => {
    let posCalls = 0
    let imgCalls = 0
    let colorCalls = 0
    const spec = iconSpec({
      getPosition: (s) => {
        posCalls++
        return s.lngLat
      },
      getImage: () => {
        imgCalls++
        return 'pin'
      },
      getColor: () => {
        colorCalls++
        return [0.5, 0.5, 0.5, 1]
      },
    })
    packRetainedIconTint(spec)
    // update({triggers:['color']}) re-packs tint only → getPosition/getImage NOT re-run.
    expect(colorCalls).toBe(stations.length)
    expect(posCalls).toBe(0)
    expect(imgCalls).toBe(0)
  })

  it('packs ECEF + abs lon/lat DSFUN matching the point packer math', () => {
    const feat = packRetainedIconFeat(iconSpec(), atlas, 1)
    for (let i = 0; i < stations.length; i++) {
      const o = i * S
      const [lon, lat] = stations[i]!.lngLat
      expect(feat[o + F.abs_lon]).toBe(lon)
      expect(feat[o + F.abs_lat]).toBe(lat)
      const ecef = lonLatToECEF(lon, lat)
      const exH = Math.fround(ecef[0])
      // hi/lo DSFUN split must reconstruct the double-precision ECEF exactly.
      expect(feat[o + F.ecef_x_h]).toBe(exH)
      expect(feat[o + F.ecef_x_h] + feat[o + F.ecef_x_l]).toBeCloseTo(ecef[0], 6)
    }
  })

  it('packs the atlas UV rect + DPR-scaled pixel size', () => {
    const feat = packRetainedIconFeat(iconSpec({ getSize: 2 }), atlas, 2)
    const o = 0
    // pin 32×32 at (64,128) on 1024² → normalised rect.
    expect(feat[o + F.u0]).toBeCloseTo(64 / 1024, 6)
    expect(feat[o + F.v0]).toBeCloseTo(128 / 1024, 6)
    expect(feat[o + F.u1]).toBeCloseTo((64 + 32) / 1024, 6)
    expect(feat[o + F.v1]).toBeCloseTo((128 + 32) / 1024, 6)
    // designW 32 × scale 2 × dpr 2 = 128.
    expect(feat[o + F.size_w]).toBe(128)
    expect(feat[o + F.size_h]).toBe(128)
  })

  it('normalises the tint rgba (default white, hex, and tuple)', () => {
    const white = packRetainedIconTint(iconSpec()) // no getColor → white
    expect([white[0], white[1], white[2], white[3]]).toEqual([1, 1, 1, 1])
    const red = packRetainedIconTint(iconSpec({ getColor: '#ff0000' }))
    expect(red[0]).toBeCloseTo(1, 5)
    expect(red[1]).toBeCloseTo(0, 5)
    expect(red[2]).toBeCloseTo(0, 5)
    expect(red[3]).toBeCloseTo(1, 5)
    const tuple = packRetainedIconTint(iconSpec({ getColor: [0.2, 0.4, 0.6, 0.8] }))
    // Float32Array storage → compare with f32 tolerance, not exact.
    expect(tuple[0]).toBeCloseTo(0.2, 5)
    expect(tuple[1]).toBeCloseTo(0.4, 5)
    expect(tuple[2]).toBeCloseTo(0.6, 5)
    expect(tuple[3]).toBeCloseTo(0.8, 5)
    expect(white.length).toBe(stations.length * ICON_RETAINED_TINT_STRIDE)
  })

  it('a missing sprite packs a zero-size (invisible) instance, not a crash', () => {
    const feat = packRetainedIconFeat(iconSpec({ getImage: 'no-such-icon' }), atlas, 1)
    for (let i = 0; i < stations.length; i++) {
      const o = i * S
      expect(feat[o + F.size_w]).toBe(0)
      expect(feat[o + F.size_h]).toBe(0)
      // position is still packed (only the sprite is missing).
      expect(feat[o + F.abs_lon]).toBe(stations[i]!.lngLat[0])
    }
  })

  it('applies the layer-level anchor mode to every instance', () => {
    const feat = packRetainedIconFeat(iconSpec({ anchor: 'bottom' }), atlas, 1)
    for (let i = 0; i < stations.length; i++) {
      expect(feat[i * S + F.anchor_mode]).toBe(2) // bottom = 2
    }
  })
})
