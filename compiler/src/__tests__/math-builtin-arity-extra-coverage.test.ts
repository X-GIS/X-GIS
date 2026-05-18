// Pin arity warnings for pow (^) + zero-arg constants pi / e / ln2.
// Pre-fix `["pow"]` returned null silently (no warning) and `["pi",
// 1]` dropped the extra arg with no diagnostic.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('pow + zero-arg constant arity warnings', () => {
  it('["^"] with wrong arity warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          paint: { 'circle-radius': ['^', 2] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["\^"\] expression: expected 2 arguments, got 1/)
  })

  it('["pi", 1] (extra arg on zero-arg constant) warns', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          paint: { 'circle-radius': ['*', 2, ['pi', 1]] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/Malformed \["pi"\] expression: zero-arg constant takes no arguments, got 1/)
  })

  it('correct ^ + pi arity does NOT warn (regression guard)', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l',
          type: 'circle',
          source: 's',
          paint: { 'circle-radius': ['*', ['^', 2, 4], ['pi']] },
        },
      ],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/Malformed/)
  })
})
