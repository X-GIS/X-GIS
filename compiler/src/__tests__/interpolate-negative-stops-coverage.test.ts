// Pin negative-number stop values in zoom-interpolated bindings.
// The xgis parser lowers `-N` to a UnaryExpr around NumberLiteral,
// not a NumberLiteral with negative .value. Pre-fix
// extractInterpolateZoomStops required NumberLiteral on every stop
// value and bailed when any stop carried a UnaryExpr — visible in
// styles using negative stroke-offset zoom interpolation (label
// shift along travel) or negative text-rotate zoom ramps.

import { describe, it, expect } from 'vitest'
import { Lexer, Parser, lower } from '@xgis/compiler'

function compile(src: string) {
  const tokens = new Lexer(src).tokenize()
  const ast = new Parser(tokens).parse()
  return lower(ast)
}

describe('extractInterpolateZoomStops — negative stop values', () => {
  it('positive-only stops still resolve (regression guard)', () => {
    const src = `
      source x { type: pmtiles, url: "x.pmtiles" }
      layer l {
        source: x
        sourceLayer: "transportation"
        | stroke-#000
        | stroke-[interpolate(zoom, 10, 1, 16, 8)]
      }
    `
    const scene = compile(src)
    expect(scene.renderNodes.length).toBe(1)
  })

  it('all-negative-stops interpolate(zoom, 10, -10, 16, -45) survives', () => {
    // Pre-fix the UnaryExpr around 10 / 45 made
    // extractInterpolateZoomStops bail — the binding fell through
    // to the data-driven path or dropped entirely.
    const src = `
      source x { type: pmtiles, url: "x.pmtiles" }
      layer l {
        source: x
        sourceLayer: "transportation"
        | stroke-#000
        | stroke-[interpolate(zoom, 10, -10, 16, -45)]
      }
    `
    const scene = compile(src)
    expect(scene.renderNodes.length).toBe(1)
  })

  it('mixed positive/negative stops parse + lower', () => {
    const src = `
      source x { type: pmtiles, url: "x.pmtiles" }
      layer l {
        source: x
        sourceLayer: "transportation"
        | stroke-#000
        | stroke-[interpolate(zoom, 10, -1, 14, 2, 16, 5)]
      }
    `
    const scene = compile(src)
    expect(scene.renderNodes.length).toBe(1)
  })
})
