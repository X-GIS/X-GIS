// Pin convertMapboxStyle tolerance of malformed input. Pre-fix:
// - invalid JSON string → JSON.parse threw, error propagated up
// - null/non-object body → style.name crashed at the first access

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('convertMapboxStyle malformed input', () => {
  it('invalid JSON string returns error comment, does not throw', () => {
    expect(() => convertMapboxStyle('{ this is not json')).not.toThrow()
    const out = convertMapboxStyle('{ this is not json')
    expect(out).toMatch(/^\/\*.*invalid JSON.*\*\/$/)
  })

  it('null style object returns error comment', () => {
    expect(() => convertMapboxStyle(null as never)).not.toThrow()
    const out = convertMapboxStyle(null as never)
    expect(out).toMatch(/expected an object/)
  })

  it('non-object style (array) returns error comment', () => {
    expect(() => convertMapboxStyle([] as never)).not.toThrow()
    const out = convertMapboxStyle([] as never)
    expect(out).toMatch(/expected an object/)
  })

  it('regression: valid object style still converts', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: {},
      layers: [],
    } as never)
    expect(out).not.toMatch(/conversion failed/)
  })

  it('regression: valid JSON string still parses', () => {
    const out = convertMapboxStyle('{"version":8,"sources":{},"layers":[]}')
    expect(out).not.toMatch(/conversion failed/)
  })
})
