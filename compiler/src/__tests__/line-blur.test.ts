// Mapbox `paint.line-blur` (edge feathering, CSS px) → xgis
// `stroke-blur-N` utility → IR `StrokeValue.blur` → runtime line
// shader `aa_width_px` uniform absorbs both geometry expansion AND
// smoothstep widening. Pre-fix the converter dropped the property
// silently; MapLibre's demo style + several anti-aliased basemap
// styles use it for soft road edges / glow effects.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, Lexer, Parser, lower, emitCommands } from '../index'

describe('line-blur conversion', () => {
  it('constant blur emits stroke-blur-N', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'glow',
        type: 'line',
        source: 'v',
        paint: {
          'line-color': '#ff0',
          'line-width': 4,
          'line-blur': 3,
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toContain('stroke-blur-3')
  })

  it('zero / absent blur emits nothing', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [
        {
          id: 'no-blur',
          type: 'line',
          source: 'v',
          paint: { 'line-color': '#fff', 'line-width': 2 },
        },
        {
          id: 'zero-blur',
          type: 'line',
          source: 'v',
          paint: { 'line-color': '#fff', 'line-width': 2, 'line-blur': 0 },
        },
      ],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).not.toContain('stroke-blur')
  })

  it('interpolate-by-zoom blur warns and drops (until binding-form added)', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'L',
        type: 'line',
        source: 'v',
        paint: {
          'line-color': '#fff',
          'line-width': 3,
          'line-blur': ['interpolate', ['linear'], ['zoom'], 8, 0, 14, 2],
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).not.toMatch(/stroke-blur/)
    expect(xgis).toMatch(/line-blur:.*non-constant form not yet supported/)
  })

  it('blur lowers through to RenderNode.stroke.blur', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'L',
        type: 'line',
        source: 'v',
        paint: { 'line-color': '#fff', 'line-width': 3, 'line-blur': 2.5 },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    const tokens = new Lexer(xgis).tokenize()
    const ast = new Parser(tokens).parse()
    const scene = lower(ast)
    expect(scene.renderNodes[0]!.stroke.blur).toBe(2.5)
  })

  it('blur threads through emitCommands → ShowCommand.strokeBlur', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'L',
        type: 'line',
        source: 'v',
        paint: { 'line-color': '#fff', 'line-width': 3, 'line-blur': 4 },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    const tokens = new Lexer(xgis).tokenize()
    const ast = new Parser(tokens).parse()
    const cmds = emitCommands(lower(ast))
    const show = cmds.shows[0] as unknown as { strokeBlur?: number }
    expect(show.strokeBlur).toBe(4)
  })
})
