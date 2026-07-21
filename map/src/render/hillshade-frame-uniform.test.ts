// ═══ Hillshade uniform byte-equality gate (#777 Phase II) ═══
//
// Contracts:
//   1. HELPERS — demUnpack (mapbox / terrarium / custom), hillshadeMethodFlag,
//      hillshadeDerivScale (the design §3 step-2 formula) resolve as specified.
//   2. GLOBAL — writeHillshadeGlobalUniform's block bytes ≡ a frozen verbatim
//      reference (azimuth = dir·π/180 + π + bearing; premultiplied colours;
//      texel = 1/tileSize; deriv = hillshadeDerivScale) over a fixture matrix.
//   3. LAYOUT PARITY — uniformBlock(HillshadeUniforms) offsets/sizes match
//      reflect(buildHillshadeModule()).

import { describe, it, expect } from 'vitest'
import { uniformBlock } from '@xgis/engine'
import { reflect } from '@xgis/shader-dsl'
import { buildHillshadeModule, hillshadeU as HILLSHADE_U } from '../shaders/dsl/hillshade'
import {
  writeHillshadeGlobalUniform,
  demUnpack,
  hillshadeDerivScale,
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
  it('standard = 0; every other model = 4 (basic / basic-fallback)', () => {
    expect(hillshadeMethodFlag('standard')).toBe(0)
    expect(hillshadeMethodFlag('basic')).toBe(4)
    expect(hillshadeMethodFlag('combined')).toBe(4)
    expect(hillshadeMethodFlag('igor')).toBe(4)
    expect(hillshadeMethodFlag('multidirectional')).toBe(4)
  })
})

describe('hillshade deriv scale (design §3 step 2)', () => {
  const scale = (tileSize: number, zoom: number) =>
    tileSize /
    Math.pow(
      2,
      (zoom >= 15 ? 0 : (zoom - 15) * (zoom < 2 ? 0.4 : zoom < 4.5 ? 0.35 : 0.3)) + 28.2562 - zoom,
    )
  it('matches the closed form at representative zooms', () => {
    for (const [ts, z] of [
      [512, 0],
      [512, 3],
      [256, 8],
      [512, 14.5],
      [512, 15],
      [512, 18],
    ] as const) {
      expect(hillshadeDerivScale(ts, z)).toBeCloseTo(scale(ts, z), 6)
    }
  })
  it('exaggeration_zoom clamps to 0 at/above z15', () => {
    // At z15 the exaggeration term is 0, so deriv = tileSize / 2^(28.2562 − 15).
    expect(hillshadeDerivScale(512, 15)).toBeCloseTo(512 / Math.pow(2, 28.2562 - 15), 6)
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
  unpack: { redFactor: 6553.6, greenFactor: 25.6, blueFactor: 0.1, baseShift: 10000 },
  tileSize: 512,
}
const ZOOM = 8.25
const BEARING_RAD = 0.4

/** Frozen verbatim reference: slots hs_unpack 0, hs_light 4, hs_shadow 8,
 *  hs_highlight 12, hs_accent 16, hs_texel 20 (6 vec4 = 24 f32 = 96 B). */
function referenceBytes(p: HillshadeParams, zoom: number, bearingRad: number): Uint8Array {
  const uf = new Float32Array(24)
  const premul = (c: readonly [number, number, number, number]) => [
    c[0] * c[3],
    c[1] * c[3],
    c[2] * c[3],
    c[3],
  ]
  const azimuth = p.direction * DEG2RAD + Math.PI + (p.anchorMap ? 0 : bearingRad)
  uf.set([p.unpack.redFactor, p.unpack.greenFactor, p.unpack.blueFactor, p.unpack.baseShift], 0)
  uf.set([azimuth, p.altitude * DEG2RAD, p.exaggeration, hillshadeMethodFlag(p.method)], 4)
  uf.set(premul(p.shadow), 8)
  uf.set(premul(p.highlight), 12)
  uf.set(premul(p.accent), 16)
  uf.set([1 / p.tileSize, hillshadeDerivScale(p.tileSize, zoom), 0, 0], 20)
  return new Uint8Array(uf.buffer.slice(0))
}

function packBlock(p: HillshadeParams, zoom: number, bearingRad: number): Uint8Array {
  const block = uniformBlock(HILLSHADE_U)
  writeHillshadeGlobalUniform(block, p, zoom, bearingRad)
  expect(block.byteLength).toBe(96)
  return new Uint8Array(block.buffer)
}

describe('hillshade global uniform — block bytes ≡ frozen reference', () => {
  it('viewport anchor (bearing folded into azimuth)', () => {
    expect([...packBlock(PARAMS, ZOOM, BEARING_RAD)]).toEqual([
      ...referenceBytes(PARAMS, ZOOM, BEARING_RAD),
    ])
  })
  it('map anchor drops the bearing term', () => {
    const p = { ...PARAMS, anchorMap: true }
    expect([...packBlock(p, ZOOM, BEARING_RAD)]).toEqual([...referenceBytes(p, ZOOM, BEARING_RAD)])
  })
  it('standard method flag = 0', () => {
    const p = { ...PARAMS, method: 'standard' }
    const got = new Float32Array(packBlock(p, ZOOM, BEARING_RAD).buffer.slice(0))
    expect(got[7]).toBe(0) // hs_light.w
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
