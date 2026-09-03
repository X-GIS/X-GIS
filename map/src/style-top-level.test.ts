// ═══ Top-level style roots — the `sky` half of applyAtmosphere (#2052 T5 Phase 1) ═══
//
// `setAtmosphere`'s VALIDATE half lives in style-top-level.ts (T5 Phase 0). Phase 1 hangs
// the MapLibre `sky` root off it as a sub-block, so what is pinned here is the boundary
// that makes the phase's byte-identity invariant purchasable at all:
//
//   sky ABSENT / null  ⇒  `_atmosphere.sky === null`  ⇒  the fragment's ramp is gated OUT
//                          (`sky_params.y = 0`, atmosphere-pass.ts) and the frame is
//                          bit-identical to pre-#2052.
//
// A test that only checked "a sky patch produces a sky" would pass just as well if the
// absent case ALSO produced one, which is the whole regression — so both arms are asserted,
// and the defaults are pinned to MapLibre's own spec values rather than to whatever the
// implementation happens to hold.

import { describe, it, expect } from 'vitest'
import { Lexer, Parser, XGIS_LANGUAGE_MAJOR } from '@xgis/compiler'
import { applyAtmosphere, parseBackgroundBlock, type TopLevelStyleHost } from './style-top-level'
import {
  ATMOSPHERE_DEFAULT_INNER_COLOR,
  ATMOSPHERE_DEFAULT_OUTER_COLOR,
  SKY_DEFAULT_COLOR,
  SKY_DEFAULT_HORIZON_BLEND,
  SKY_DEFAULT_HORIZON_COLOR,
} from './render/atmosphere-uniform'

function host(): TopLevelStyleHost {
  return {
    _light: { position: [1.15, 210, 30], intensity: 0.5, color: [1, 1, 1] },
    _atmosphere: null,
    _backgroundColor: null,
    _backgroundColorFromStyle: false,
    _backgroundColorShape: null,
    _backgroundOpacityShape: null,
    _backgroundPattern: null,
  }
}

// #2306 — parse a style source string into the AST.Program parseBackgroundBlock consumes,
// the same way map.ts's run() does (`new Parser(new Lexer(src).tokenize()).parse()`). Every
// source needs the mandatory version pragma (X-GIS0008) or the parser throws before we
// ever reach a background block.
function parseProgram(src: string) {
  return new Parser(new Lexer(`xgis ${XGIS_LANGUAGE_MAJOR}\n${src}`).tokenize()).parse()
}

describe('applyAtmosphere — the `sky` root sub-block (#2052 Phase 1)', () => {
  it('leaves sky null when the patch carries none — the byte-identity arm', () => {
    const h = host()
    applyAtmosphere(h, { innerColor: [1, 0.55, 0, 0.95] })
    expect(h._atmosphere).not.toBeNull()
    expect(h._atmosphere!.sky).toBeNull()
  })

  it('leaves sky null for an EXPLICIT null (a style that dropped its sky block)', () => {
    const h = host()
    applyAtmosphere(h, { sky: null })
    expect(h._atmosphere!.sky).toBeNull()
  })

  it('adopts an authored sky verbatim', () => {
    const h = host()
    applyAtmosphere(h, {
      sky: {
        color: [0.1, 0.2, 0.3, 1],
        horizonColor: [0.9, 0.8, 0.7, 0.5],
        horizonBlend: 0.25,
      },
    })
    expect(h._atmosphere!.sky).toEqual({
      color: [0.1, 0.2, 0.3, 1],
      horizonColor: [0.9, 0.8, 0.7, 0.5],
      horizonBlend: 0.25,
    })
  })

  it('falls back per-property to the MapLibre spec defaults, not to a neighbouring value', () => {
    const h = host()
    applyAtmosphere(h, { sky: { horizonBlend: 0.4 } })
    expect(h._atmosphere!.sky).toEqual({
      color: [...SKY_DEFAULT_COLOR],
      horizonColor: [...SKY_DEFAULT_HORIZON_COLOR],
      horizonBlend: 0.4,
    })
    // MapLibre's own `sky-color` default is #88C6FC — pinned as the numeric triple so a
    // silent re-tint cannot ride in behind the constant's name.
    expect(SKY_DEFAULT_COLOR.slice(0, 3).map((c) => Math.round(c * 255))).toEqual([
      0x88, 0xc6, 0xfc,
    ])
    expect(SKY_DEFAULT_HORIZON_BLEND).toBe(0.8)
  })

  it('rejects a malformed colour to that colour’s default (not to the other colour)', () => {
    const h = host()
    applyAtmosphere(h, {
      sky: {
        color: [Number.NaN, 0, 0, 1],
        horizonColor: [0.2, 0.3, 0.4, 1],
      },
    })
    expect(h._atmosphere!.sky!.color).toEqual([...SKY_DEFAULT_COLOR])
    expect(h._atmosphere!.sky!.horizonColor).toEqual([0.2, 0.3, 0.4, 1])
  })

  it('clamps horizonBlend into the spec’s own [0, 1] range', () => {
    const h = host()
    applyAtmosphere(h, { sky: { horizonBlend: 4 } })
    expect(h._atmosphere!.sky!.horizonBlend).toBe(1)
    applyAtmosphere(h, { sky: { horizonBlend: -2 } })
    expect(h._atmosphere!.sky!.horizonBlend).toBe(0)
    applyAtmosphere(h, { sky: { horizonBlend: Number.NaN } })
    expect(h._atmosphere!.sky!.horizonBlend).toBe(SKY_DEFAULT_HORIZON_BLEND)
  })

  it('copies every authored array — a caller mutating its own input cannot reach host state', () => {
    const h = host()
    const color: [number, number, number, number] = [0.1, 0.2, 0.3, 1]
    applyAtmosphere(h, { sky: { color } })
    color[0] = 0.99
    expect(h._atmosphere!.sky!.color[0]).toBe(0.1)
  })

  it('#1258 unchanged: null turns the whole pass off, and the glow colours still default', () => {
    const h = host()
    applyAtmosphere(h, {})
    expect(h._atmosphere).toEqual({
      innerColor: [...ATMOSPHERE_DEFAULT_INNER_COLOR],
      outerColor: [...ATMOSPHERE_DEFAULT_OUTER_COLOR],
      sky: null,
    })
    applyAtmosphere(h, null)
    expect(h._atmosphere).toBeNull()
  })
})

describe('parseBackgroundBlock — _backgroundColor provenance (#2306)', () => {
  it('drops a previous STYLE background fill when the next style has no background block', () => {
    const h = host()
    parseBackgroundBlock(h, parseProgram('background { fill: #ff0000 }'))
    expect(h._backgroundColor).toEqual([1, 0, 0, 1])
    // styleB declares no background block at all.
    parseBackgroundBlock(h, parseProgram(''))
    expect(h._backgroundColor).toBeNull()
  })

  it('CONTROL: the pattern half of the same reset already works — proves the fixture is sound', () => {
    const h = host()
    parseBackgroundBlock(h, parseProgram('background { fill: #ff0000 pattern: pat }'))
    expect(h._backgroundPattern).toBe('pat')
    parseBackgroundBlock(h, parseProgram(''))
    expect(h._backgroundPattern).toBeNull()
  })

  it('does NOT clear a HOST-set fill (setBackgroundFill) on a background-less re-run', () => {
    const h = host()
    // Mirrors what map.ts's setBackgroundFill does: write the field directly, flag false —
    // this value did not come from the style parse.
    h._backgroundColor = [0, 1, 0, 1]
    h._backgroundColorFromStyle = false
    parseBackgroundBlock(h, parseProgram(''))
    expect(h._backgroundColor).toEqual([0, 1, 0, 1])
  })
})
