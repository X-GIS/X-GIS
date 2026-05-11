// Mapbox `paint.line-offset` → xgis `stroke-offset-right-N` /
// `stroke-offset-left-N`. The xgis line renderer already threads
// `strokeOffset` end-to-end (IR → vertex shader, including offset-
// aware miter/join geometry); the converter just needs to pick the
// right utility variant so the sign convention matches.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, Lexer, Parser, lower } from '../index'

describe('line-offset conversion', () => {
  it('positive Mapbox offset (right of travel) emits stroke-offset-right-N', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'road-casing',
        type: 'line',
        source: 'v',
        paint: {
          'line-color': '#888',
          'line-width': 3,
          'line-offset': 4,
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toContain('stroke-offset-right-4')
    expect(xgis).not.toContain('stroke-offset-left')
  })

  it('negative Mapbox offset (left of travel) emits stroke-offset-left-N', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'road-casing',
        type: 'line',
        source: 'v',
        paint: { 'line-color': '#888', 'line-width': 3, 'line-offset': -2.5 },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toContain('stroke-offset-left-2.5')
    expect(xgis).not.toMatch(/stroke-offset-right/)
  })

  it('zero offset emits no utility', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'road',
        type: 'line',
        source: 'v',
        paint: { 'line-color': '#888', 'line-width': 3, 'line-offset': 0 },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).not.toMatch(/stroke-offset/)
  })

  it('absent offset emits no utility', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'road',
        type: 'line',
        source: 'v',
        paint: { 'line-color': '#888', 'line-width': 3 },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).not.toMatch(/stroke-offset/)
  })

  it('interpolate-by-zoom offset warns + drops (until binding-form is added)', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'road',
        type: 'line',
        source: 'v',
        paint: {
          'line-color': '#888',
          'line-width': 3,
          'line-offset': ['interpolate', ['linear'], ['zoom'], 10, 0, 14, 3],
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).not.toMatch(/stroke-offset/)
    expect(xgis).toMatch(/line-offset:.*non-constant form not yet supported/)
  })

  it('positive offset lowers through to RenderNode.stroke.offset with correct sign', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'r',
        type: 'line',
        source: 'v',
        paint: { 'line-color': '#888', 'line-width': 3, 'line-offset': 4 },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    const tokens = new Lexer(xgis).tokenize()
    const ast = new Parser(tokens).parse()
    const scene = lower(ast)
    const node = scene.renderNodes[0]
    // xgis convention: right-of-travel = NEGATIVE strokeOffset
    // (matches the existing `stroke-offset-right-N → -N` mapping at
    // lower.ts:907). Pin the actual sign so a future flip would
    // fail this test loudly.
    expect(node!.stroke.offset).toBe(-4)
  })

  it('negative Mapbox offset lowers to positive strokeOffset (left of travel)', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'r',
        type: 'line',
        source: 'v',
        paint: { 'line-color': '#888', 'line-width': 3, 'line-offset': -3 },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    const tokens = new Lexer(xgis).tokenize()
    const ast = new Parser(tokens).parse()
    const scene = lower(ast)
    const node = scene.renderNodes[0]
    expect(node!.stroke.offset).toBe(3)
  })
})
