// Pin per-source error isolation. Pre-fix a throw inside convertSource
// (rare but possible if source body has unexpected runtime state) or
// a coverage-side `src.type` access on a null body crashed the whole
// convertMapboxStyle call.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('source convert throw isolation', () => {
  it('null source body + coverage option does not crash', () => {
    const coverage = { sources: [] as unknown[], layers: [], warnings: [] as string[] }
    const style = {
      version: 8,
      sources: { bad: null as unknown, good: { type: 'vector', url: 'https://x.pmtiles' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never, { coverage } as never)
    expect(code).toContain('source good {')
    expect(coverage.sources.length).toBe(2)
  })

  it('coverage records both bad and good sources', () => {
    const coverage = { sources: [] as { id: string }[], layers: [], warnings: [] as string[] }
    const style = {
      version: 8,
      sources: { bad: 'not-an-object' as unknown, good: { type: 'vector', url: 'https://x.pmtiles' } },
      layers: [],
    }
    convertMapboxStyle(style as never, { coverage } as never)
    expect(coverage.sources.map(s => s.id).sort()).toEqual(['bad', 'good'])
  })

  it('regression: well-formed sources still emit', () => {
    const style = {
      version: 8,
      sources: { a: { type: 'vector', url: 'https://a.pmtiles' } },
      layers: [],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toContain('source a {')
  })
})
