// Halo defaults verification — pins X-GIS' halo behaviour to the
// Mapbox style spec defaults. User reported 2026-05-18 "라벨에
// 할로 기본값이 누락되는듯 싶음" (label halo defaults seem missing)
// + asked for spec verification.
//
// Mapbox spec text-halo defaults (per layers/symbol.json in the
// mapbox-gl-style-spec repo):
//   text-halo-color: rgba(0, 0, 0, 0)  // fully transparent black
//   text-halo-width: 0                  // no halo
//   text-halo-blur:  0                  // sharp halo edge
//
// X-GIS aligned text-halo-width default 1→0 in iter 487 to match
// spec. text-halo-color and text-halo-blur already defaulted to
// spec values.
//
// Critical observation for OFM corpus (audited iter 504):
//   - 18 bright + 18 liberty + 14 positron symbol layers author
//     BOTH halo-color + halo-width → produce visible halos
//   - 2 bright + 2 liberty + 2 positron layers (highway-name-minor,
//     highway-name-major) author halo-width=1 WITHOUT halo-color →
//     spec default rgba(0,0,0,0) = INVISIBLE halo. This matches
//     MapLibre's render exactly (transparent-color halos draw
//     nothing). The "halo defaults missing" symptom for these
//     layers is spec-correct behaviour, not a bug.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function compileToShows(style: unknown): ReturnType<typeof emitCommands>['shows'] {
  const xgis = convertMapboxStyle(style as Parameters<typeof convertMapboxStyle>[0])
  const tokens = new Lexer(xgis).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  return emitCommands(optimize(scene)).shows
}

function symbolLayer(paint: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { t: { type: 'vector', tiles: ['x'] } },
    layers: [
      {
        id: 'l',
        type: 'symbol',
        source: 't',
        'source-layer': 'p',
        layout: { 'text-field': '{name}' },
        paint,
      },
    ],
  }
}

describe('halo defaults — Mapbox spec compliance', () => {
  it('no halo authored → label.halo undefined (no draw)', () => {
    const shows = compileToShows(symbolLayer({ 'text-color': '#000' }))
    expect(shows[0]!.label!.halo).toBeUndefined()
  })

  it('text-halo-width authored without text-halo-color → halo width=1 color=transparent black (spec)', () => {
    // OFM highway-name-minor / -major pattern. Spec says halo-color
    // defaults to rgba(0,0,0,0) — fully transparent. Width=1 paints
    // an INVISIBLE halo (alpha 0 on every halo pixel). Match
    // MapLibre exactly.
    const shows = compileToShows(
      symbolLayer({
        'text-color': '#000',
        'text-halo-width': 1,
      }),
    )
    const halo = shows[0]!.label!.halo
    expect(halo).toBeDefined()
    expect(halo!.width).toBe(1)
    // Spec default — transparent black.
    expect(halo!.color).toEqual([0, 0, 0, 0])
  })

  it('text-halo-color authored without text-halo-width → halo width=0 (spec, no halo render)', () => {
    // Iter 487 fix: pre-fix default was 1 → painted 1 px halo even
    // when style omitted width. Now defaults to spec 0 → no render.
    const shows = compileToShows(
      symbolLayer({
        'text-color': '#000',
        'text-halo-color': '#fff',
      }),
    )
    const halo = shows[0]!.label!.halo
    expect(halo).toBeDefined()
    expect(halo!.width).toBe(0)
    expect(halo!.color).toEqual([1, 1, 1, 1])
  })

  it('both halo-color + halo-width → visible halo with authored values', () => {
    // OFM common pattern. Verify both axes land verbatim.
    const shows = compileToShows(
      symbolLayer({
        'text-color': '#000',
        'text-halo-color': '#fff',
        'text-halo-width': 1.5,
      }),
    )
    const halo = shows[0]!.label!.halo
    expect(halo!.color).toEqual([1, 1, 1, 1])
    expect(halo!.width).toBe(1.5)
  })

  it('text-halo-blur authored without width or color → halo width=0 (no render — blur is moot)', () => {
    // Authoring blur alone with no width is semantically "soften
    // the (nonexistent) halo by N px" — same as no halo. Spec
    // default width 0 + blur 0.5 = no render.
    const shows = compileToShows(
      symbolLayer({
        'text-color': '#000',
        'text-halo-blur': 0.5,
      }),
    )
    const halo = shows[0]!.label!.halo
    expect(halo!.width).toBe(0)
    expect(halo!.blur).toBe(0.5)
  })

  it('OFM water_name shape: rgba(255,255,255,0.7) + width 1.5 — alpha preserves', () => {
    const shows = compileToShows(
      symbolLayer({
        'text-color': '#0080ff',
        'text-halo-color': 'rgba(255,255,255,0.7)',
        'text-halo-width': 1.5,
      }),
    )
    const halo = shows[0]!.label!.halo!
    expect(halo.width).toBe(1.5)
    expect(halo.color[0]).toBe(1)
    expect(halo.color[1]).toBe(1)
    expect(halo.color[2]).toBe(1)
    // 70% → 179/255 ≈ 0.7019; toBeCloseTo handles byte quantisation.
    expect(halo.color[3]).toBeCloseTo(0.7, 2)
  })

  it('OFM POI shape: #fff + width 1 + blur 0.5 — all 3 axes land', () => {
    const shows = compileToShows(
      symbolLayer({
        'text-color': '#000',
        'text-halo-color': '#fff',
        'text-halo-width': 1,
        'text-halo-blur': 0.5,
      }),
    )
    const halo = shows[0]!.label!.halo!
    expect(halo.color).toEqual([1, 1, 1, 1])
    expect(halo.width).toBe(1)
    expect(halo.blur).toBe(0.5)
  })

  it('SPEC COMPLIANCE: text-halo-color absent default is transparent black (NOT white or opaque)', () => {
    // Regression gate. Pre-iter-487 era this defaulted to [0,0,0,1]
    // (opaque black) which painted hard black outlines around every
    // label that authored a width without a color (Bright highway-
    // name-major at z>12.2). Spec is [0,0,0,0] = invisible.
    const shows = compileToShows(
      symbolLayer({
        'text-color': '#666',
        'text-halo-width': 2,
      }),
    )
    expect(shows[0]!.label!.halo!.color).toEqual([0, 0, 0, 0])
  })
})
