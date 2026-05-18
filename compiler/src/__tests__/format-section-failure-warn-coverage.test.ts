// Pin precise warning when a ["format"] section fails to convert.
// Pre-fix the whole format expression silently collapsed to null and
// the label dropped from rendering with no hint that only ONE inner
// section was unconvertible — the author had to bisect the format
// chain manually.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('format section failure warning', () => {
  it('section with unsupported expression warns with section index', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: {
            'text-field': [
              'format',
              ['get', 'name'], {},
              ['image', 'flag-x'], {}, // section 2 — unsupported image accessor
              ['get', 'pop'], {},
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/\["format"\] section 2 .* failed to convert/)
  })

  it('all-valid format does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 's',
          layout: {
            'text-field': [
              'format',
              ['get', 'name'], {},
              ' — ', {},
              ['get', 'class'], {},
            ],
          },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/\["format"\] section \d+ .* failed to convert/)
  })
})
