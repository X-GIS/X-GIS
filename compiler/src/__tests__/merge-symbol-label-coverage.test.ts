// Pin merge-layers preserving symbol layer labels. Symbol layers
// frequently share source-layers (place_city / place_town / place_
// village all read 'place'), so adjacent symbol layers could fold
// into a single compound. The merge collapses N RenderNodes into
// ONE — only the first layer's label survived, so every absorbed
// label dropped from the render.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer, Parser, lower, optimize } from '@xgis/compiler'

function compileAndOptimize(mapbox: unknown) {
  const xgis = convertMapboxStyle(mapbox as never)
  const tokens = new Lexer(xgis).tokenize()
  const ast = new Parser(tokens).parse()
  return optimize(lower(ast))
}

describe('merge-layers: symbol label preservation', () => {
  it('two label-bearing layers DO NOT merge (regression guard)', () => {
    // Pre-fix isMergeableNode didn't check label !== undefined. Two
    // symbol layers reading the same source-layer with constant
    // fill: 'none' fell into the merge path; the compound kept
    // first.label only and absorbed-layer labels disappeared.
    const scene = compileAndOptimize({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'place_city',
          type: 'symbol', source: 'v', 'source-layer': 'place',
          filter: ['==', ['get', 'class'], 'city'],
          layout: { 'text-field': '{name}', 'text-size': 14 },
        },
        {
          id: 'place_town',
          type: 'symbol', source: 'v', 'source-layer': 'place',
          filter: ['==', ['get', 'class'], 'town'],
          layout: { 'text-field': '{name}', 'text-size': 12 },
        },
      ],
    })
    // Both labels survive — no compound emitted.
    expect(scene.renderNodes.length).toBe(2)
    expect(scene.renderNodes[0]!.label).toBeDefined()
    expect(scene.renderNodes[1]!.label).toBeDefined()
  })

  it('label + label-less fill still keeps both separate', () => {
    // A label-bearing symbol followed by a non-label fill — same
    // source-layer. Pre-fix the symbol's label-presence didn't
    // block isMergeableNode; the merge gated on other invariants
    // but a symbol with fill: none + label could still collide.
    const scene = compileAndOptimize({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'place_label',
          type: 'symbol', source: 'v', 'source-layer': 'place',
          filter: ['==', ['get', 'class'], 'city'],
          layout: { 'text-field': '{name}' },
        },
        {
          id: 'place_dot',
          type: 'fill', source: 'v', 'source-layer': 'place',
          filter: ['==', ['get', 'class'], 'town'],
          paint: { 'fill-color': '#000' },
        },
      ],
    })
    // Symbol layer with label survives unmerged.
    expect(scene.renderNodes.find(n => n.label !== undefined)).toBeDefined()
  })
})
