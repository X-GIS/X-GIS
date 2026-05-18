// Pin top-level `version` field validation. Mapbox spec requires
// version: 8 — older versions use a different schema (paint vs
// non-paint property naming changed between v7 and v8). A v7 style
// silently passed through pre-fix and produced garbage output with
// no diagnostic.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('style version validation', () => {
  it('v8 style does NOT warn (regression guard)', () => {
    const style = { version: 8, sources: {}, layers: [] }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/version/)
  })

  it('missing version warns', () => {
    const style = { sources: {}, layers: [] }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/missing top-level "version" field/)
  })

  it('v7 style warns about unsupported version', () => {
    const style = { version: 7, sources: {}, layers: [] }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/version: 7/)
    expect(code).toMatch(/only Mapbox style v8 is supported/)
  })

  it('non-numeric version warns', () => {
    const style = { version: '8' as unknown, sources: {}, layers: [] }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/version: "8"/)
  })
})
