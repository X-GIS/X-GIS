// End-to-end propagation test for circle-pitch-scale (Phase S Batch 3).
// Mapbox style → convertMapboxStyle → Lexer → Parser → lower →
// optimize → emitCommands → ShowCommand.circlePitchScaleMap. The
// runtime (PointRenderer) reads the flag and packs it into the point
// frame uniform's circle_params.w; the point VS scales the on-screen
// circle radius by w_ref / clip.w so circles foreshorten with the map
// perspective (Mapbox `circle-pitch-scale: map`).
//
// circle-pitch-scale 'viewport' (spec default) is the byte-identical
// path: the converter emits NOTHING, lower leaves circlePitchScaleMap
// undefined, and the runtime renders viewport-scaled circles exactly as
// it does today. Defaults must NOT change any existing render.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function convert(mapboxStyle: unknown): string {
  return convertMapboxStyle(mapboxStyle as Parameters<typeof convertMapboxStyle>[0])
}

function compileToShows(mapboxStyle: unknown): ReturnType<typeof emitCommands>['shows'] {
  const tokens = new Lexer(convert(mapboxStyle)).tokenize()
  const ast = new Parser(tokens).parse()
  return emitCommands(optimize(lower(ast), ast)).shows
}

function circleLayer(paint: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { t: { type: 'vector', tiles: ['x'] } },
    layers: [
      {
        id: 'c',
        type: 'circle',
        source: 't',
        'source-layer': 'p',
        paint: { 'circle-radius': 4, 'circle-color': '#08f', ...paint },
      },
    ],
  }
}

describe('circle-pitch-scale — converter emit', () => {
  it("'map' → emits circle-pitch-scale-map utility", () => {
    const src = convert(circleLayer({ 'circle-pitch-scale': 'map' }))
    expect(src).toContain('circle-pitch-scale-map')
  })

  it("'viewport' (explicit default) → NO utility (byte-identical screen-scale)", () => {
    const src = convert(circleLayer({ 'circle-pitch-scale': 'viewport' }))
    expect(src).not.toContain('circle-pitch-scale')
  })

  it('absent → NO utility (byte-identical default)', () => {
    const src = convert(circleLayer({}))
    expect(src).not.toContain('circle-pitch-scale')
  })

  it('["literal", "map"] wrap → unwrapped + emits the flag', () => {
    const src = convert(circleLayer({ 'circle-pitch-scale': ['literal', 'map'] }))
    expect(src).toContain('circle-pitch-scale-map')
  })
})

describe('circle-pitch-scale → ShowCommand.circlePitchScaleMap (IR carry)', () => {
  it("'map' → ShowCommand.circlePitchScaleMap === true", () => {
    const shows = compileToShows(circleLayer({ 'circle-pitch-scale': 'map' }))
    expect(shows[0]!.circlePitchScaleMap).toBe(true)
  })

  it("'viewport' → circlePitchScaleMap undefined (DEFAULT reproduces today's behaviour)", () => {
    const shows = compileToShows(circleLayer({ 'circle-pitch-scale': 'viewport' }))
    expect(shows[0]!.circlePitchScaleMap).toBeUndefined()
  })

  it('absent → circlePitchScaleMap undefined (DEFAULT reproduces today)', () => {
    const shows = compileToShows(circleLayer({}))
    expect(shows[0]!.circlePitchScaleMap).toBeUndefined()
  })
})
