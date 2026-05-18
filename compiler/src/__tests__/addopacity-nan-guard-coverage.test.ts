// Pin defensive NaN/Infinity rejection in addOpacity. Pre-fix
// `typeof NaN === 'number'` let NaN slip past the type gate; then
// `Math.max(0, Math.min(1, NaN))` propagated NaN, `Math.round(NaN
// * 100)` returned NaN, and the emitted utility was `opacity-NaN`
// which the runtime lex-rejected — the whole paint-utility set
// silently dropped.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('addOpacity NaN/Infinity rejection', () => {
  it('NaN fill-opacity does not emit opacity-NaN', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': '#abc', 'fill-opacity': NaN as unknown },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/opacity-NaN/)
  })

  it('Infinity fill-opacity does not emit opacity-Infinity', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': '#abc', 'fill-opacity': Infinity as unknown },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/opacity-Infinity/)
    expect(code).not.toMatch(/opacity-NaN/)
  })

  it('normal opacity emits correctly (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': '#abc', 'fill-opacity': 0.5 },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('opacity-50')
  })
})
