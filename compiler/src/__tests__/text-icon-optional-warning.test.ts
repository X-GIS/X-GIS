// Pin iter 519 text-optional / icon-optional warning gate.
// Mapbox spec defaults for both = false. X-GIS' symbol placement
// always pairs text + icon today (deferred — split collision
// arbitration would let either survive alone). The author asking
// for `text-optional: true` or `icon-optional: true` is asking for
// a behavior X-GIS doesn't deliver; the value-blind absence is
// invisible at the default.
//
// OFM authors `text-optional: true` on the `airport` symbol layer
// (all 3 OFM styles, single layer per style) and `icon-optional:
// false` on 4 label_* layers per style. Under this gate the airport
// flips converted → lossy (1 layer per style), the label_* layers
// stay converted (default value match).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../index'

function compile(layout: Record<string, unknown>): string[] {
  const style = {
    version: 8,
    sources: { v: { type: 'vector' as const, url: 'x.pmtiles' } },
    layers: [{
      id: 'sym',
      type: 'symbol' as const,
      source: 'v',
      'source-layer': 'poi',
      layout: { 'icon-image': 'marker', 'text-field': '{name}', ...layout },
    }],
  }
  const warnings: string[] = []
  convertMapboxStyle(style as never, {
    coverage: { sources: [], layers: [], warnings },
  })
  return warnings
}

describe('text-optional / icon-optional warning gate — iter 519', () => {
  describe('text-optional', () => {
    it('default false → no warning', () => {
      const warnings = compile({ 'text-optional': false })
      expect(warnings.filter(w => w.includes('text-optional'))).toEqual([])
    })

    it('omitted → no warning', () => {
      const warnings = compile({})
      expect(warnings.filter(w => w.includes('text-optional'))).toEqual([])
    })

    it('true (OFM airport shape) → warning explaining missing arbitration', () => {
      const warnings = compile({ 'text-optional': true })
      const hits = warnings.filter(w => w.includes('text-optional'))
      expect(hits.length).toBe(1)
      expect(hits[0]).toContain('text-optional: true')
      expect(hits[0]).toContain('symbol placement always pairs')
    })

    it('v8 literal-wrap [\"literal\", true] → warning fires (unwrap honoured)', () => {
      const warnings = compile({ 'text-optional': ['literal', true] })
      expect(warnings.filter(w => w.includes('text-optional')).length).toBe(1)
    })
  })

  describe('icon-optional', () => {
    it('default false → no warning (OFM label_city/town shape)', () => {
      const warnings = compile({ 'icon-optional': false })
      expect(warnings.filter(w => w.includes('icon-optional'))).toEqual([])
    })

    it('true → warning explaining missing arbitration', () => {
      const warnings = compile({ 'icon-optional': true })
      const hits = warnings.filter(w => w.includes('icon-optional'))
      expect(hits.length).toBe(1)
      expect(hits[0]).toContain('icon-optional: true')
    })

    it('does NOT warn for text-optional (no message-pair confusion)', () => {
      const warnings = compile({ 'icon-optional': true })
      expect(warnings.filter(w => /\btext-optional\b/.test(w))).toEqual([])
    })
  })

  it('both true → exactly two warnings', () => {
    const warnings = compile({ 'text-optional': true, 'icon-optional': true })
    const hits = warnings.filter(w => /optional/.test(w))
    expect(hits.length).toBe(2)
  })
})
