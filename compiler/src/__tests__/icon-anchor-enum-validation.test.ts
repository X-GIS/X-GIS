// Pin iter 520 icon-anchor enum validation. Mapbox spec defines a
// 9-way enum; lower.ts:1254 silently drops unknown values, so a typo
// like "centre" (British) or "middle" would land as
// `label-icon-anchor-centre` in xgis, the lower pass would reject it,
// and the icon would render at the default 'center' anchor with NO
// diagnostic to the style author. Mirror of the symbol-placement
// (layers.ts:989) and text-transform (layers.ts:647) enum
// validators.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../index'

function compile(iconAnchor: unknown): { xgis: string; warnings: string[] } {
  const style = {
    version: 8,
    sources: { v: { type: 'vector' as const, url: 'x.pmtiles' } },
    layers: [
      {
        id: 'sym',
        type: 'symbol' as const,
        source: 'v',
        'source-layer': 'poi',
        layout: { 'icon-image': 'marker', 'icon-anchor': iconAnchor },
      },
    ],
  }
  const warnings: string[] = []
  const xgis = convertMapboxStyle(style as never, {
    coverage: { sources: [], layers: [], warnings },
  })
  return { xgis, warnings }
}

describe('icon-anchor enum validation — iter 520', () => {
  describe('valid enum values pass through', () => {
    for (const v of [
      'center',
      'top',
      'bottom',
      'left',
      'right',
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
    ]) {
      it(`"${v}" → no warning`, () => {
        const { warnings } = compile(v)
        expect(warnings.filter((w) => w.includes('icon-anchor'))).toEqual([])
      })
    }

    it('center (default) does NOT emit a utility', () => {
      const { xgis } = compile('center')
      expect(xgis).not.toContain('label-icon-anchor-')
    })

    it('top-right emits label-icon-anchor-top-right utility', () => {
      const { xgis } = compile('top-right')
      expect(xgis).toContain('label-icon-anchor-top-right')
    })
  })

  describe('typos / unknown values warn', () => {
    it('"centre" (British) → warning + utility NOT emitted', () => {
      const { xgis, warnings } = compile('centre')
      const hits = warnings.filter((w) => w.includes('icon-anchor'))
      expect(hits.length).toBe(1)
      expect(hits[0]).toContain('"centre"')
      expect(hits[0]).toContain('not a valid enum')
      // Critical: don't emit the typo'd utility — lower would silently
      // drop it anyway, and the convert-time warning is the user's only
      // signal that their declaration was rejected.
      expect(xgis).not.toContain('label-icon-anchor-centre')
    })

    it('"middle" → warning', () => {
      const { warnings } = compile('middle')
      expect(warnings.filter((w) => w.includes('icon-anchor')).length).toBe(1)
    })

    it('camelCase "topRight" → warning (Mapbox is kebab-case)', () => {
      const { warnings } = compile('topRight')
      expect(warnings.filter((w) => w.includes('icon-anchor')).length).toBe(1)
    })

    it('empty string → warning', () => {
      const { warnings } = compile('')
      expect(warnings.filter((w) => w.includes('icon-anchor')).length).toBe(1)
    })
  })

  describe('non-string forms', () => {
    it('null → no warning (omitted = default applied)', () => {
      const { warnings } = compile(null)
      expect(warnings.filter((w) => w.includes('icon-anchor'))).toEqual([])
    })

    it('omitted → no warning', () => {
      const style = {
        version: 8,
        sources: { v: { type: 'vector' as const, url: 'x.pmtiles' } },
        layers: [
          {
            id: 'sym',
            type: 'symbol' as const,
            source: 'v',
            'source-layer': 'poi',
            layout: { 'icon-image': 'marker' },
          },
        ],
      }
      const warnings: string[] = []
      convertMapboxStyle(style as never, {
        coverage: { sources: [], layers: [], warnings },
      })
      expect(warnings.filter((w) => w.includes('icon-anchor'))).toEqual([])
    })

    it('v8 literal-wrap ["literal", "top"] → no warning (unwrap honoured)', () => {
      const { xgis, warnings } = compile(['literal', 'top'])
      expect(warnings.filter((w) => w.includes('icon-anchor'))).toEqual([])
      expect(xgis).toContain('label-icon-anchor-top')
    })
  })
})
