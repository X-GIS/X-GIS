// Pin multi-level literal-wrap unwrap across the FINAL sweep of
// per-element sites: get field, colorToXgis rgba/hsla channels,
// expand-color-match per-element value, addStrokeDash per-element,
// text-variable-anchor / text-anchor / text-font per-element,
// text-offset / icon-offset / VAO offset per-scalar. All previously
// single-pass — pre-fix multi-wrapped scalars from v8 strict
// preprocessor chains landed wrapped, broke the downstream type
// gate, and the property silently dropped.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { exprToXgis } from '../convert/expressions'
import { colorToXgis } from '../convert/colors'

describe('converter multi-wrap final sweep', () => {
  it('get field doubly-wrapped → bare field access', () => {
    const w: string[] = []
    const out = exprToXgis(['get', ['literal', ['literal', 'name']]], w)
    expect(out).toBe('.name')
  })

  it('rgba doubly-wrapped channels hex-encode', () => {
    const w: string[] = []
    const out = colorToXgis(
      ['rgba',
        ['literal', ['literal', 255]],
        ['literal', ['literal', 0]],
        ['literal', ['literal', 0]],
        ['literal', ['literal', 1]],
      ],
      w,
    )
    // rgba(255, 0, 0, 1) — opaque red.
    expect(out).toMatch(/#ff0000(ff)?/i)
  })

  it('line-dasharray doubly-wrapped scalar still clamps + emits', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'line',
          source: 's',
          paint: {
            'line-color': '#000',
            'line-dasharray': ['literal', [
              ['literal', ['literal', 4]],
              ['literal', ['literal', 2]],
            ]],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('stroke-dasharray-4-2')
  })

  it('text-font doubly-wrapped entries still emit utilities', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: {
            'text-field': '{name}',
            'text-font': ['literal', [
              ['literal', ['literal', 'Noto Sans Bold']],
            ]],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('label-font-Noto-Sans')
  })

  it('text-variable-anchor doubly-wrapped entries still emit anchor utilities', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: {
            'text-field': '{name}',
            'text-variable-anchor': ['literal', [
              ['literal', ['literal', 'top']],
              ['literal', ['literal', 'bottom']],
            ]],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('label-anchor-top')
    expect(code).toContain('label-anchor-bottom')
  })

  it('text-offset doubly-wrapped scalars still emit offset utilities', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: {
            'text-field': '{name}',
            'text-offset': ['literal', [
              ['literal', ['literal', 0]],
              ['literal', ['literal', -2]],
            ]],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('label-offset-y-[-2]')
  })
})
