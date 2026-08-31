// line-gradient (#2117) — the RAMP CARRIER half: Mapbox style → xgis binding → IR
// StrokeValue.gradientStops → ShowCommand.strokeGradientStops. The converter arm is
// pinned separately (line-gradient-warn.test.ts); this pins that the lowered stops
// actually SURVIVE to the wire the renderer reads, which is the half a converter-only
// test cannot see.
//
// Fail-before: with lower-bindings-line.ts reverted, `stroke-gradient-[…]` reaches no
// handler, X-GIS0005 fires and `strokeGradientStops` is undefined here.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer, Parser, lower, emitCommands } from '../index'
import { optimize } from '../ir/optimize'
import { withPragma } from './_pragma'

/** The single stroke show a one-layer style emits. `ShowCommand.targetName` is the
 *  SOURCE name (not the layer id), so a one-layer fixture is addressed positionally. */
function strokeShow(xgis: string) {
  let ir = lower(new Parser(new Lexer(withPragma(xgis)).tokenize()).parse())
  ir = optimize(ir)
  const shows = emitCommands(ir).shows
  expect(shows).toHaveLength(1)
  return shows[0]!
}

function lineShowFor(gradient: unknown) {
  const xgis = convertMapboxStyle({
    version: 8,
    sources: { g: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers: [
      {
        id: 'route',
        type: 'line',
        source: 'g',
        paint: { 'line-color': '#ff0000', 'line-width': 4, 'line-gradient': gradient },
      },
    ],
  } as never)
  return strokeShow(xgis)
}

describe('line-gradient ramp reaches the wire', () => {
  it('two-stop ramp lands on ShowCommand.strokeGradientStops', () => {
    const show = lineShowFor([
      'interpolate',
      ['linear'],
      ['line-progress'],
      0,
      '#0000ff',
      1,
      '#ff0000',
    ])
    expect(show.strokeGradientStops).toEqual([
      { offset: 0, rgba: [0, 0, 1, 1] },
      { offset: 1, rgba: [1, 0, 0, 1] },
    ])
  })

  it('multi-stop ramp preserves interior positions and per-stop alpha', () => {
    const show = lineShowFor([
      'interpolate',
      ['linear'],
      ['line-progress'],
      0,
      '#00ff00',
      0.25,
      'rgba(255, 0, 0, 0.5)',
      1,
      '#0000ff',
    ])
    expect(show.strokeGradientStops).toEqual([
      { offset: 0, rgba: [0, 1, 0, 1] },
      { offset: 0.25, rgba: [1, 0, 0, 128 / 255] },
      { offset: 1, rgba: [0, 0, 1, 1] },
    ])
  })

  it('absent line-gradient leaves the field undefined (solid stroke path unchanged)', () => {
    const xgis = convertMapboxStyle({
      version: 8,
      sources: { g: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'route',
          type: 'line',
          source: 'g',
          paint: { 'line-color': '#ff0000', 'line-width': 4 },
        },
      ],
    } as never)
    expect(strokeShow(xgis).strokeGradientStops).toBeUndefined()
  })

  it('a hand-authored .xgis ramp lowers through the same binding', () => {
    // The utility is public X-GIS surface, not a converter-private spelling — the e2e
    // fixture authors it directly.
    const show = strokeShow(`
source s { type: geojson, url: "x.geojson" }
layer route {
  source: s
  | stroke-red-500 stroke-8
  | stroke-gradient-[interpolate(line_progress, 0, #00ff00ff, 1, #ff00ffff)]
}
`)
    expect(show.strokeGradientStops).toEqual([
      { offset: 0, rgba: [0, 1, 0, 1] },
      { offset: 1, rgba: [1, 0, 1, 1] },
    ])
  })
})
