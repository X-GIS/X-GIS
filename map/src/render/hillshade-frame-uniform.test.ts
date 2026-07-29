// ═══ Hillshade uniform byte-equality gate (#777 Phase II) ═══
//
// Contracts:
//   1. HELPERS — demUnpack (mapbox / terrarium / custom), hillshadeMethodFlag,
//      hillshadeDerivBase (the zoom-independent half of the design §3 step-2
//      formula) resolve as specified.
//   2. GLOBAL — writeHillshadeGlobalUniform's block bytes ≡ a frozen verbatim
//      reference (azimuth = dir·π/180 + π + bearing; premultiplied colours;
//      texel = 1/tileSize; deriv = hillshadeDerivBase) over a fixture matrix.
//   3. LAYOUT PARITY — uniformBlock(HillshadeUniforms) offsets/sizes match
//      reflect(buildHillshadeModule()).

import { describe, it, expect } from 'vitest'
import { uniformBlock } from '@xgis/engine'
import { reflect } from '@xgis/shader-dsl'
import { buildHillshadeModule, hillshadeU as HILLSHADE_U } from '../shaders/dsl/hillshade'
import {
  writeHillshadeGlobalUniform,
  demUnpack,
  hillshadeDerivBase,
  hillshadeMethodFlag,
  type HillshadeParams,
} from './hillshade-renderer'

const DEG2RAD = Math.PI / 180

describe('DEM elevation-pack unpack factors (design §2)', () => {
  it('mapbox (default Terrain-RGB)', () => {
    expect(demUnpack('mapbox')).toEqual({
      redFactor: 6553.6,
      greenFactor: 25.6,
      blueFactor: 0.1,
      baseShift: 10000,
    })
  })
  it('terrarium (Mapzen)', () => {
    expect(demUnpack('terrarium')).toEqual({
      redFactor: 256,
      greenFactor: 1,
      blueFactor: 1 / 256,
      baseShift: 32768,
    })
  })
  it('custom uses source factors, falling back to mapbox for missing lanes', () => {
    expect(demUnpack('custom', { redFactor: 100, baseShift: 500 })).toEqual({
      redFactor: 100,
      greenFactor: 25.6, // mapbox fallback
      blueFactor: 0.1, // mapbox fallback
      baseShift: 500,
    })
  })
})

describe('hillshade-method → shader flag', () => {
  it('all five MapLibre v5 methods map to distinct flags (unknown → standard)', () => {
    expect(hillshadeMethodFlag('standard')).toBe(0)
    expect(hillshadeMethodFlag('basic')).toBe(1)
    expect(hillshadeMethodFlag('combined')).toBe(2)
    expect(hillshadeMethodFlag('igor')).toBe(3)
    expect(hillshadeMethodFlag('multidirectional')).toBe(4)
    expect(hillshadeMethodFlag('not-a-method')).toBe(0)
  })
})

describe('hillshade deriv base (design §3 step 2, zoom-independent half)', () => {
  it('is tileSize / 2^28.2562 and scales linearly with the DEM tile size', () => {
    expect(hillshadeDerivBase(512)).toBeCloseTo(512 / Math.pow(2, 28.2562), 12)
    expect(hillshadeDerivBase(256)).toBeCloseTo(256 / Math.pow(2, 28.2562), 12)
    expect(hillshadeDerivBase(512) / hillshadeDerivBase(256)).toBe(2)
  })
})

const PARAMS: HillshadeParams = {
  direction: 335,
  altitude: 45,
  anchorMap: false,
  exaggeration: 0.5,
  shadow: [0.1, 0.2, 0.3, 0.8],
  highlight: [0.9, 0.95, 1.0, 1.0],
  accent: [0.05, 0.06, 0.07, 0.5],
  method: 'basic',
  extraSources: [],
  unpack: { redFactor: 6553.6, greenFactor: 25.6, blueFactor: 0.1, baseShift: 10000 },
  tileSize: 512,
}
const BEARING_RAD = 0.4

/** Frozen verbatim reference: slots hs_unpack 0, hs_light 4, hs_shadow 8,
 *  hs_highlight 12, hs_accent 16, hs_texel 20, then the multidirectional
 *  lanes hs_light2 24 / hs_light3 28 / hs_light4 32 / hs_shadow2 36 /
 *  hs_highlight2 40 / hs_shadow3 44 / hs_highlight3 48 / hs_shadow4 52 /
 *  hs_highlight4 56 (15 vec4 = 60 f32 = 240 B). hs_light2.z always carries
 *  the source count (1 + extras); unused source lanes stay zero. */
function referenceBytes(p: HillshadeParams, bearingRad: number): Uint8Array {
  const uf = new Float32Array(60)
  const premul = (c: readonly [number, number, number, number]) => [
    c[0] * c[3],
    c[1] * c[3],
    c[2] * c[3],
    c[3],
  ]
  const azimuthOf = (dirDeg: number) => dirDeg * DEG2RAD + Math.PI + (p.anchorMap ? 0 : bearingRad)
  uf.set([p.unpack.redFactor, p.unpack.greenFactor, p.unpack.blueFactor, p.unpack.baseShift], 0)
  uf.set(
    [azimuthOf(p.direction), p.altitude * DEG2RAD, p.exaggeration, hillshadeMethodFlag(p.method)],
    4,
  )
  uf.set(premul(p.shadow), 8)
  uf.set(premul(p.highlight), 12)
  uf.set(premul(p.accent), 16)
  uf.set([1 / p.tileSize, hillshadeDerivBase(p.tileSize), 0, 0], 20)
  const count = Math.min(4, 1 + p.extraSources.length)
  const lightSlot = [24, 28, 32]
  const colorSlot = [36, 44, 52]
  uf[24 + 2] = count
  for (let i = 0; i < 3; i++) {
    const s = p.extraSources[i]
    if (!s) continue
    uf.set([azimuthOf(s.direction), s.altitude * DEG2RAD], lightSlot[i]!)
    uf[lightSlot[i]! + 2] = i === 0 ? count : 0
    uf.set(premul(s.shadow), colorSlot[i]!)
    uf.set(premul(s.highlight), colorSlot[i]! + 4)
  }
  return new Uint8Array(uf.buffer.slice(0))
}

function packBlock(p: HillshadeParams, bearingRad: number): Uint8Array {
  const block = uniformBlock(HILLSHADE_U)
  writeHillshadeGlobalUniform(block, p, bearingRad)
  expect(block.byteLength).toBe(240)
  return new Uint8Array(block.buffer)
}

describe('hillshade global uniform — block bytes ≡ frozen reference', () => {
  it('viewport anchor (bearing folded into azimuth)', () => {
    expect([...packBlock(PARAMS, BEARING_RAD)]).toEqual([...referenceBytes(PARAMS, BEARING_RAD)])
  })
  it('map anchor drops the bearing term', () => {
    const p = { ...PARAMS, anchorMap: true }
    expect([...packBlock(p, BEARING_RAD)]).toEqual([...referenceBytes(p, BEARING_RAD)])
  })
  it('standard method flag = 0', () => {
    const p: HillshadeParams = { ...PARAMS, method: 'standard' }
    const got = new Float32Array(packBlock(p, BEARING_RAD).buffer.slice(0))
    expect(got[7]).toBe(0) // hs_light.w
  })
  it('multidirectional sources pack azimuth/altitude/colours + count', () => {
    const p: HillshadeParams = {
      ...PARAMS,
      method: 'multidirectional',
      extraSources: [
        { direction: 270, altitude: 30, shadow: [0.2, 0, 0, 1], highlight: [1, 0.5, 0, 1] },
        { direction: 315, altitude: 60, shadow: [0, 0.2, 0, 0.5], highlight: [0, 1, 0.5, 1] },
      ],
    }
    const bytes = packBlock(p, BEARING_RAD)
    expect([...bytes]).toEqual([...referenceBytes(p, BEARING_RAD)])
    const got = new Float32Array(bytes.buffer.slice(0))
    expect(got[24 + 2]).toBe(3) // hs_light2.z = source count
    expect(got[24]).toBeCloseTo(270 * DEG2RAD + Math.PI + BEARING_RAD, 5) // hs_light2.x
    expect(got[32]).toBe(0) // hs_light4 unused → zero
    expect(got[52]).toBe(0) // hs_shadow4 unused → zero
  })
  it('map anchor drops the bearing from every extra source too', () => {
    const p: HillshadeParams = {
      ...PARAMS,
      anchorMap: true,
      method: 'multidirectional',
      extraSources: [
        { direction: 270, altitude: 30, shadow: [0, 0, 0, 1], highlight: [1, 1, 1, 1] },
      ],
    }
    const got = new Float32Array(packBlock(p, BEARING_RAD).buffer.slice(0))
    expect(got[24]).toBeCloseTo(270 * DEG2RAD + Math.PI, 5)
  })
})

describe('hillshade layout — handle path ≡ reflected module path', () => {
  it('HillshadeUniforms offsets/sizes match reflect(buildHillshadeModule())', () => {
    const r = reflect(buildHillshadeModule(false))
    const reflected = r.uniforms.find((u) => u.name === 'HillshadeUniforms')!
    expect(reflected).toBeDefined()
    const block = uniformBlock(HILLSHADE_U)
    expect(block.byteLength).toBe(reflected.size)
    for (const fl of reflected.fields) {
      expect(block.fieldOffset(fl.name as never), fl.name).toBe(fl.offset)
    }
  })
})
