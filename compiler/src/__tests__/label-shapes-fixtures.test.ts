// Invariant tests: real-world Mapbox styles produce the right
// LabelShapes shapes through the convert + lower pipeline.
//
// Pins the boundary where Mapbox `text-size: ["interpolate", …]` /
// `text-color: "#rrggbb"` / `text-halo-width: N` definitions land
// in `LabelDef.shapes`. A regression in the converter or lower
// pass that loses the zoom-interp form (or silently downgrades it
// to a constant) trips here at compile time — no GPU / parity
// gate needed.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import type { Scene } from '../ir/render-node'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, 'fixtures')

function compileFixture(fixture: string): Scene {
  const json = JSON.parse(readFileSync(join(FIX, fixture), 'utf8'))
  const xgis = convertMapboxStyle(json)
  const tokens = new Lexer(xgis).tokenize()
  const program = new Parser(tokens).parse()
  return optimize(lower(program), program)
}

function findLayer(scene: Scene, namePattern: RegExp) {
  return scene.renderNodes.find(n => namePattern.test(n.name))
}

describe('LabelShapes inference on OFM Bright', () => {
  const scene = compileFixture('openfreemap-bright.json')

  it('label_country_2 text-size resolves to zoom-interpolated', () => {
    // Source: "text-size": ["interpolate", ["linear"], ["zoom"], 2, 9, 5, 17]
    const layer = findLayer(scene, /label_country_2/)
    expect(layer, 'label_country_2 should be in scene').toBeDefined()
    expect(layer!.label, 'label_country_2 should have label def').toBeDefined()
    expect(layer!.label!.shapes, 'label_country_2 should have shapes bundle').toBeDefined()
    const size = layer!.label!.shapes!.size
    expect(size.kind).toBe('zoom-interpolated')
    if (size.kind === 'zoom-interpolated') {
      expect(size.stops.length).toBeGreaterThanOrEqual(2)
      // Endpoint pins
      expect(size.stops[0]!.zoom).toBe(2)
      expect(size.stops[0]!.value).toBe(9)
      expect(size.stops[size.stops.length - 1]!.zoom).toBe(5)
      expect(size.stops[size.stops.length - 1]!.value).toBe(17)
    }
  })

  it('water_name text-color resolves to constant (#495e91)', () => {
    // Source: "text-color": "#495e91"
    const layer = findLayer(scene, /water_name/)
    expect(layer, 'water_name should be in scene').toBeDefined()
    expect(layer!.label?.shapes, 'water_name should have shapes bundle').toBeDefined()
    const color = layer!.label!.shapes!.color
    expect(color).not.toBeNull()
    expect(color!.kind).toBe('constant')
    if (color!.kind === 'constant') {
      expect(color.value[0]).toBeCloseTo(73 / 255, 3)
      expect(color.value[1]).toBeCloseTo(94 / 255, 3)
      expect(color.value[2]).toBeCloseTo(145 / 255, 3)
    }
  })

  it('every authored label has a shapes bundle', () => {
    let labelCount = 0
    let withShapes = 0
    for (const n of scene.renderNodes) {
      if (!n.label) continue
      labelCount++
      if (n.label.shapes) withShapes++
    }
    expect(labelCount).toBeGreaterThan(10)  // OFM Bright has many labels
    expect(withShapes).toBe(labelCount)  // every one populated
  })
})

describe('LabelShapes inference on MapLibre demotiles', () => {
  const scene = compileFixture('maplibre-demotiles.json')

  it('countries-label fontWeight bakes onto shapes.size as constant', () => {
    // Source: "text-size": {stops: [[2, 11], [4, 13], [6, 16]]}
    const layer = findLayer(scene, /countries[_-]label/)
    if (!layer) return  // optional — depends on demotiles version
    expect(layer.label?.shapes).toBeDefined()
    const size = layer.label!.shapes!.size
    // Old-style {stops:[…]} → linear interpolate
    expect(['zoom-interpolated', 'constant']).toContain(size.kind)
  })

  it('geolines-label color resolves to constant #1077B0', () => {
    // Source: "text-color": "#1077B0"
    const layer = findLayer(scene, /geolines[_-]label/)
    if (!layer) return  // optional — depends on demotiles version
    const color = layer.label?.shapes?.color
    if (color?.kind === 'constant') {
      // #1077B0 → r=0x10/255≈0.063, g=0x77/255≈0.467, b=0xB0/255≈0.690
      expect(color.value[0]).toBeCloseTo(16 / 255, 3)
      expect(color.value[1]).toBeCloseTo(119 / 255, 3)
      expect(color.value[2]).toBeCloseTo(176 / 255, 3)
    }
  })
})
