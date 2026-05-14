import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'

function compileLabel(layer: Record<string, unknown>): {
  iconImage?: string
  iconSize?: number
  iconAnchor?: string
  iconOffset?: [number, number]
  iconRotate?: number
} {
  const style = {
    version: 8,
    sprite: 'https://example/sprites/foo',
    sources: { src: { type: 'vector', tiles: ['https://x/{z}/{x}/{y}.pbf'] } },
    layers: [layer],
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const xgis = convertMapboxStyle(style as any)
  const tokens = new Lexer(xgis).tokenize()
  const program = new Parser(tokens).parse()
  const scene = lower(program)
  for (const n of scene.renderNodes) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const label = (n as any).label
    if (label) return label
  }
  return {}
}

describe('Mapbox icon-* → LabelDef.icon* round-trip', () => {
  it('extracts icon-image constant string', () => {
    const def = compileLabel({
      id: 'poi', type: 'symbol', source: 'src', 'source-layer': 'poi',
      layout: { 'icon-image': 'aerialway', 'text-field': '{name}' },
    })
    expect(def.iconImage).toBe('aerialway')
  })

  it('text-less icon-only layers compile to an empty-text label with iconImage', () => {
    const def = compileLabel({
      id: 'poi', type: 'symbol', source: 'src', 'source-layer': 'poi',
      layout: { 'icon-image': 'bus_stop' },
    })
    expect(def.iconImage).toBe('bus_stop')
  })

  it('icon-size constant numbers other than 1.0 propagate', () => {
    const def = compileLabel({
      id: 'poi', type: 'symbol', source: 'src', 'source-layer': 'poi',
      layout: { 'icon-image': 'x', 'icon-size': 1.5 },
    })
    expect(def.iconSize).toBe(1.5)
  })

  it('icon-size = 1.0 is treated as default (utility omitted)', () => {
    const def = compileLabel({
      id: 'poi', type: 'symbol', source: 'src', 'source-layer': 'poi',
      layout: { 'icon-image': 'x', 'icon-size': 1 },
    })
    expect(def.iconSize).toBeUndefined()
  })

  it('icon-anchor + icon-offset + icon-rotate all propagate', () => {
    const def = compileLabel({
      id: 'poi', type: 'symbol', source: 'src', 'source-layer': 'poi',
      layout: {
        'icon-image': 'x',
        'icon-anchor': 'bottom',
        'icon-offset': [0, -12],
        'icon-rotate': 45,
      },
    })
    expect(def.iconAnchor).toBe('bottom')
    expect(def.iconOffset).toEqual([0, -12])
    expect(def.iconRotate).toBe(45)
  })
})
