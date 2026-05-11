// Regression for the Mapbox `layer.minzoom` / `layer.maxzoom`
// pass-through. The bug:
//
//   convert/layers.ts emits `minzoom: 5` text into the xgis source,
//   but lower.ts did NOT parse it, so every show command landed at
//   the runtime without zoom-range info. Multi-zoom Mapbox styles
//   (OFM Bright: label_city minz=3, label_state minz=5, label_town
//   minz=6, label_village minz=9, label_other minz=8, all POIs
//   minz=15+) rendered at every zoom level simultaneously, piling
//   every OMT place feature onto a low-zoom view.
//
// This test pins the contract: a `layer { minzoom: N maxzoom: M ... }`
// xgis source flows minzoom/maxzoom through lower → emit-commands
// → ShowCommand. The runtime gate (map.ts label submission) reads
// these fields to skip below/above their range — exercised
// implicitly by every OFM Bright re-render after this lands.

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { emitCommands } from '../ir/emit-commands'
import { optimize } from '../ir/optimize'

interface ShowLike {
  targetName: string
  minzoom?: number
  maxzoom?: number
}

function emit(xgis: string): ShowLike[] {
  const tokens = new Lexer(xgis).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  const cmds = emitCommands(optimize(scene, ast))
  return cmds.shows as unknown as ShowLike[]
}

describe('Mapbox layer.minzoom / layer.maxzoom pass-through', () => {
  it('layer with both minzoom and maxzoom emits ShowCommand with both fields', () => {
    const shows = emit(`
      source s { type: pmtiles, url: "x.pmtiles" }
      layer label_state {
        source: s
        sourceLayer: "place"
        minzoom: 5
        maxzoom: 8
        | label-[.name]
      }
    `)
    expect(shows).toHaveLength(1)
    expect(shows[0].minzoom).toBe(5)
    expect(shows[0].maxzoom).toBe(8)
  })

  it('layer with only minzoom emits the lower bound and leaves maxzoom undefined', () => {
    const shows = emit(`
      source s { type: pmtiles, url: "x.pmtiles" }
      layer label_city {
        source: s
        sourceLayer: "place"
        minzoom: 3
        | label-[.name]
      }
    `)
    expect(shows[0].minzoom).toBe(3)
    expect(shows[0].maxzoom).toBeUndefined()
  })

  it('layer with only maxzoom emits the upper bound and leaves minzoom undefined', () => {
    const shows = emit(`
      source s { type: pmtiles, url: "x.pmtiles" }
      layer label_country {
        source: s
        sourceLayer: "place"
        maxzoom: 9
        | label-[.name]
      }
    `)
    expect(shows[0].minzoom).toBeUndefined()
    expect(shows[0].maxzoom).toBe(9)
  })

  it('layer without either emits both undefined (unconditional visibility)', () => {
    const shows = emit(`
      source s { type: pmtiles, url: "x.pmtiles" }
      layer always_on {
        source: s
        sourceLayer: "place"
        | label-[.name]
      }
    `)
    expect(shows[0].minzoom).toBeUndefined()
    expect(shows[0].maxzoom).toBeUndefined()
  })
})
