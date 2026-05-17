// Pin isOmitted multi-level literal-wrap unwrap. The helper gates
// every paint accessor; pre-fix only handled single-level
// ['literal', null]. v8 strict preprocessor chains can emit
// ['literal', ['literal', null]] — the gate missed this, the null
// leaked through to exprToXgis as a `null` identifier binding, and
// the property emitted `fill-[null]` / `opacity-[null]` etc. instead
// of falling to the Mapbox spec default.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('isOmitted multi-level literal-wrap unwrap', () => {
  it('fill-color = ["literal", ["literal", null]] falls to no utility', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': ['literal', ['literal', null]] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    // Property fully omitted: NO fill-[null] / fill-null emitted.
    expect(code).not.toContain('fill-[null]')
    expect(code).not.toContain('fill-null')
  })

  it('fill-opacity = ["literal", ["literal", null]] falls to no utility', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': '#000', 'fill-opacity': ['literal', ['literal', null]] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toContain('opacity-[null]')
    expect(code).not.toContain('opacity-null')
  })

  it('single-wrap null still treated as omitted (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': '#000', 'fill-opacity': ['literal', null] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toContain('opacity-[null]')
  })

  it('non-null wrap still emits utility (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'fill',
          source: 's',
          paint: { 'fill-color': '#000', 'fill-opacity': ['literal', 0.5] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('opacity-50')
  })
})
