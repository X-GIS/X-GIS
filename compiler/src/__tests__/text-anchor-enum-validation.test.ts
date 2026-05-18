// Pin iter 521 text-anchor / text-variable-anchor enum validation.
// Mirror of iter 520 icon-anchor gate. Pre-fix:
//   layers.ts:626 `VALID_ANCHORS.has(anchor)` → silent skip on typo
//   layers.ts:622 same in the variable-anchor array branch
// A British "centre", camelCase "topRight", a non-9-way value like
// "middle" — all silently fell to the IR default with NO diagnostic.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../index'

function compile(layout: Record<string, unknown>): { xgis: string; warnings: string[] } {
  const style = {
    version: 8,
    sources: { v: { type: 'vector' as const, url: 'x.pmtiles' } },
    layers: [{
      id: 'sym',
      type: 'symbol' as const,
      source: 'v',
      'source-layer': 'poi',
      layout: { 'text-field': '{name}', 'icon-image': 'm', ...layout },
    }],
  }
  const warnings: string[] = []
  const xgis = convertMapboxStyle(style as never, {
    coverage: { sources: [], layers: [], warnings },
  })
  return { xgis, warnings }
}

describe('text-anchor enum validation — iter 521', () => {
  describe('text-anchor scalar form', () => {
    for (const v of [
      'center', 'top', 'bottom', 'left', 'right',
      'top-left', 'top-right', 'bottom-left', 'bottom-right',
    ]) {
      it(`"${v}" → no warning`, () => {
        const { warnings } = compile({ 'text-anchor': v })
        expect(warnings.filter(w => w.includes('text-anchor'))).toEqual([])
      })
    }

    it('typo "centre" → warning + utility NOT emitted', () => {
      const { xgis, warnings } = compile({ 'text-anchor': 'centre' })
      const hits = warnings.filter(w => w.includes('text-anchor'))
      expect(hits.length).toBe(1)
      expect(hits[0]).toContain('"centre"')
      expect(hits[0]).toContain('invalid enum')
      expect(xgis).not.toContain('label-anchor-centre')
    })

    it('typo "middle" → warning', () => {
      const { warnings } = compile({ 'text-anchor': 'middle' })
      expect(warnings.filter(w => w.includes('text-anchor')).length).toBe(1)
    })

    it('camelCase "topRight" → warning (Mapbox is kebab-case)', () => {
      const { warnings } = compile({ 'text-anchor': 'topRight' })
      expect(warnings.filter(w => w.includes('text-anchor')).length).toBe(1)
    })
  })

  describe('text-variable-anchor array form', () => {
    it('all valid → no warning, all utilities emit', () => {
      const { xgis, warnings } = compile({
        'text-variable-anchor': ['top', 'bottom', 'left'],
      })
      expect(warnings.filter(w => w.includes('text-anchor'))).toEqual([])
      expect(xgis).toContain('label-anchor-top')
      expect(xgis).toContain('label-anchor-bottom')
      expect(xgis).toContain('label-anchor-left')
    })

    it('one invalid → single warning naming the bad value, valid utilities still emit', () => {
      const { xgis, warnings } = compile({
        'text-variable-anchor': ['top', 'middle', 'bottom'],
      })
      const hits = warnings.filter(w => w.includes('text-anchor'))
      expect(hits.length).toBe(1)
      expect(hits[0]).toContain('"middle"')
      expect(xgis).toContain('label-anchor-top')
      expect(xgis).toContain('label-anchor-bottom')
      expect(xgis).not.toContain('label-anchor-middle')
    })

    it('multiple invalid → single warning listing both', () => {
      const { warnings } = compile({
        'text-variable-anchor': ['centre', 'middle'],
      })
      const hits = warnings.filter(w => w.includes('text-anchor'))
      expect(hits.length).toBe(1)
      expect(hits[0]).toContain('"centre"')
      expect(hits[0]).toContain('"middle"')
    })

    it('v8 per-element literal-wrap unwrap (["literal", "top"]) → no warning', () => {
      const { xgis, warnings } = compile({
        'text-variable-anchor': [['literal', 'top'], ['literal', 'bottom']],
      })
      expect(warnings.filter(w => w.includes('text-anchor'))).toEqual([])
      expect(xgis).toContain('label-anchor-top')
      expect(xgis).toContain('label-anchor-bottom')
    })
  })

  describe('non-string / empty', () => {
    it('omitted → no warning', () => {
      const { warnings } = compile({})
      expect(warnings.filter(w => w.includes('text-anchor'))).toEqual([])
    })

    it('null → no warning', () => {
      const { warnings } = compile({ 'text-anchor': null })
      expect(warnings.filter(w => w.includes('text-anchor'))).toEqual([])
    })

    it('legacy array form ["top", "bottom"] in text-anchor → split into per-element validation', () => {
      // Legacy v0/v1 styles use array shape for text-anchor (= modern
      // text-variable-anchor). Each element passes through the enum
      // gate identically.
      const { warnings } = compile({ 'text-anchor': ['top', 'bogus'] })
      const hits = warnings.filter(w => w.includes('text-anchor'))
      expect(hits.length).toBe(1)
      expect(hits[0]).toContain('"bogus"')
    })
  })
})
