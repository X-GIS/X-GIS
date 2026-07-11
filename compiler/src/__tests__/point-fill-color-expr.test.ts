// #732 S5 — a data-driven POINT fill colour must surface as
// ShowCommand.fillColorExpr, the fill-axis mirror of strokeColorExpr
// (stroke-binding-routing.test.ts). Without it the GeoJSON point path in
// map.ts has no per-feature colour AST to evaluate and every point collapses
// to the layer-constant default arm — exactly the class of silent-default bug
// the stroke-colour routing test guards against.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, Lexer, Parser, lower, emitCommands } from '../index'

describe('#732 S5 — per-feature point fill colour AST', () => {
  it('circle-color match() lands on node.fill (data-driven) and ShowCommand.fillColorExpr', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'cities_by_class',
          type: 'circle',
          source: 'v',
          'source-layer': 'place',
          paint: {
            'circle-color': [
              'match',
              ['get', 'class'],
              'city',
              '#ff0000',
              'town',
              '#00ff00',
              '#888888',
            ],
            'circle-radius': 5,
          },
        },
      ],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis, 'converter emits a data-driven fill utility for circle-color match').toMatch(
      /fill-\[/,
    )
    const scene = lower(new Parser(new Lexer(xgis).tokenize()).parse())
    const node = scene.renderNodes.find((n) => n.name === 'cities_by_class')
    expect(node, 'render node survives lower').toBeDefined()
    // The lowered ColorValue must carry the data-driven expr (not collapse to
    // a constant default arm), so emitFillFields can surface it.
    expect(node!.fill.kind, 'fill kind').toBe('data-driven')
    // And it must flow through emit-commands onto the ShowCommand.
    const cmds = emitCommands(scene)
    const show = cmds.shows.find((s) => s.layerName === 'cities_by_class')
    expect(show, 'ShowCommand must exist').toBeDefined()
    expect(
      show!.fillColorExpr,
      'ShowCommand.fillColorExpr (consumed by the GeoJSON point path)',
    ).toBeDefined()
  })

  it('constant circle-color ships NO fillColorExpr (constant path byte-identical)', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'cities_const',
          type: 'circle',
          source: 'v',
          'source-layer': 'place',
          paint: { 'circle-color': '#ff0000', 'circle-radius': 5 },
        },
      ],
    }
    const xgis = convertMapboxStyle(style as never)
    const cmds = emitCommands(lower(new Parser(new Lexer(xgis).tokenize()).parse()))
    const show = cmds.shows.find((s) => s.layerName === 'cities_const')
    expect(show, 'ShowCommand must exist').toBeDefined()
    expect(show!.fillColorExpr, 'constant fill → no per-feature expr').toBeUndefined()
  })
})
