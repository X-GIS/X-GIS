// Pin multi-wrap null treatment on layer-level colour gates
// (text-color, text-halo-color, circle-color, circle-stroke-color).
// Pre-fix these used a plain `!== undefined && !== null` check and
// let `['literal', ['literal', null]]` (any depth) flow through to
// exprToXgis. The case-literal path now lowers null to the 'null'
// identifier, so the emit produced 'fill-[null]' /
// 'label-color-[null]' instead of falling to the spec default.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('layer colour gates — multi-wrap null treated as omit', () => {
  it('text-color = ["literal", ["literal", null]] falls to spec default', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': '{name}' },
          paint: { 'text-color': ['literal', ['literal', null]] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toContain('label-color-[null]')
    // Spec default emitted instead.
    expect(code).toContain('label-color-#000')
  })

  it('circle-color multi-wrap null falls to spec default', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          paint: { 'circle-color': ['literal', ['literal', null]] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toContain('fill-[null]')
    expect(code).toContain('fill-#000')
  })

  it('text-halo-color multi-wrap null silently drops (no halo utility)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': '{name}' },
          paint: { 'text-halo-color': ['literal', ['literal', null]] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toContain('label-halo-color-[null]')
  })

  it('circle-stroke-color multi-wrap null silently drops', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          paint: {
            'circle-color': '#000',
            'circle-stroke-color': ['literal', ['literal', null]],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toContain('stroke-[null]')
  })
})
