// Pin wrapped get-field on expand-color-match. Pre-fix the typeof
// === 'string' gate rejected `['get', ['literal', 'kind']]` and the
// whole expand bailed; the layer fell back to lower.ts's pick-first-
// stop fallback and rendered every feature in the SAME colour
// regardless of the per-country palette match.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('expand-color-match wrapped get field', () => {
  it('wrapped get-field still expands into per-colour layers', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'https://x.pmtiles' } },
      layers: [
        {
          id: 'countries',
          type: 'fill',
          source: 's',
          'source-layer': 'country',
          paint: {
            'fill-color': ['match', ['get', ['literal', 'code']],
              'us', '#f00',
              'cn', '#0f0',
              '#eee',
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    // Expand should produce one layer per unique colour + a default.
    expect(code).toContain('countries__c0')
    expect(code).toContain('countries__c1')
    expect(code).toContain('countries__cd')
    expect(code).toContain('fill-#f00')
    expect(code).toContain('fill-#0f0')
    expect(code).toContain('fill-#eee')
  })

  it('regression: bare get-field still expands', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'https://x.pmtiles' } },
      layers: [
        {
          id: 'countries',
          type: 'fill',
          source: 's',
          'source-layer': 'country',
          paint: {
            'fill-color': ['match', ['get', 'code'], 'us', '#f00', 'cn', '#0f0', '#eee'],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('countries__c0')
  })
})
