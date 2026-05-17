// Pin sanitizeId placeholder for empty input. Pre-fix an empty id
// emitted `layer  {` (two spaces, no name), the xgis parser failed
// at lex time, and the host's load step crashed on every other
// layer in the style.

import { describe, it, expect } from 'vitest'
import { sanitizeId } from '../convert/utils'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('sanitizeId empty', () => {
  it('empty string becomes "unnamed"', () => {
    expect(sanitizeId('')).toBe('unnamed')
  })

  it('layer with empty id still has a valid emitted block', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        { id: '', type: 'fill', source: 's', paint: { 'fill-color': '#000' } },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('layer unnamed {')
    expect(code).not.toContain('layer  {')
  })

  it('regression: non-empty id unchanged', () => {
    expect(sanitizeId('water')).toBe('water')
  })
})
