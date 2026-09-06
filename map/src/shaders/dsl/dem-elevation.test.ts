// dem-elevation.ts — the DEM elevation authority, evaluated on the CPU f64 oracle
// (D5 INC-2, #2532).
//
// This is the math gate. The f64 oracle is blind to f32 reassociation, which is
// exactly why `_dem-decode-parity.spec.ts` ALSO executes the emitted WGSL on the
// GPU — the pair is the same split `ecef-dsl.test.ts` + `_absorbed-fn-parity`
// use, and neither half alone is the gate.

import { describe, it, expect } from 'vitest'
import { module, compileModule } from '@xgis/shader-dsl'
import { DEM_ELEVATION_FUNCS } from './dem-elevation'

const M = compileModule(module({ funcs: DEM_ELEVATION_FUNCS }))
const decode = (texel: number[], unpack: number[]) => M.fns.dem_decode(texel, unpack) as number
const subUv = (uv: number[], sub: number[]) => M.fns.dem_sub_uv(uv, sub) as number[]

// The three encodings, spelled as `demUnpack()` (hillshade-renderer.ts) resolves them.
// Written out rather than imported so a drift in the RENDERER's table is caught here
// instead of silently agreed with.
const MAPBOX = [6553.6, 25.6, 0.1, 10000]
const TERRARIUM = [256, 1, 1 / 256, 32768]
const CUSTOM = [100, 10, 1, 500]

/** A texel as textureSample returns it: byte / 255. */
const px = (r: number, g: number, b: number) => [r / 255, g / 255, b / 255]

describe('#2532 — dem_decode is the one formula, for every encoding', () => {
  it('mapbox: elevation = R·6553.6 + G·25.6 + B·0.1 − 10000', () => {
    // 0 m of Terrain-RGB is (1, 134, 160): 6553.6 + 134·25.6 + 16 − 10000 = 0
    expect(decode(px(1, 134, 160), MAPBOX)).toBeCloseTo(0, 6)
    expect(decode(px(0, 0, 0), MAPBOX)).toBeCloseTo(-10000, 6)
  })

  it('terrarium: elevation = R·256 + G + B/256 − 32768', () => {
    expect(decode(px(128, 0, 0), TERRARIUM)).toBeCloseTo(0, 6)
    expect(decode(px(0, 0, 0), TERRARIUM)).toBeCloseTo(-32768, 6)
  })

  it('the #2003 witness: mid-grey is 128.5 m as terrarium and 832 150 m as mapbox', () => {
    // The pair that made the encoding mix-up LOUD rather than subtle — a Mapzen
    // DEM decoded with the mapbox formula is not slightly off, it is saturated
    // garbage. Kept as the canonical "did the right unpack reach the shader" probe.
    const grey = px(128, 128, 128)
    expect(decode(grey, TERRARIUM)).toBeCloseTo(128.5, 6)
    expect(decode(grey, MAPBOX)).toBeCloseTo(128 * 6553.6 + 128 * 25.6 + 128 * 0.1 - 10000, 3)
  })

  it('custom factors are honoured lane by lane', () => {
    expect(decode(px(2, 3, 4), CUSTOM)).toBeCloseTo(200 + 30 + 4 - 500, 6)
  })
})

describe('#2532 — dem_sub_uv consumes the INC-1 sub-rect', () => {
  it('identity sub-rect (exact tile) returns the uv unchanged', () => {
    expect(subUv([0.25, 0.75], [1, 0, 0, 0])).toEqual([0.25, 0.75])
  })

  it('an ancestor two levels up with a NON-ZERO corner: u0 + uv·scale', () => {
    // (5,13,6) inside (3,3,1): scale 0.25, corner (0.25, 0.5) — the #2525 arm.
    // A mapping that dropped the corner would return (0.125, 0.125) here.
    const got = subUv([0.5, 0.5], [0.25, 0.25, 0.5, 0])
    expect(got[0]).toBeCloseTo(0.25 + 0.5 * 0.25, 9)
    expect(got[1]).toBeCloseTo(0.5 + 0.5 * 0.25, 9)
  })
})
