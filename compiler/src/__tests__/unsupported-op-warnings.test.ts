// Pin iter 544 + earlier — Mapbox spec ops the converter doesn't
// implement should surface SPECIFIC "not yet supported" warnings,
// not the generic "Expression not converted" catch-all. Specific
// messages help users tell apart "wrong shape" from "feature gap".

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'

function convert(mapbox: unknown): { result: string | null; warnings: string[] } {
  const warnings: string[] = []
  const result = exprToXgis(mapbox as never, warnings)
  return { result, warnings }
}

describe('unsupported op warnings — specific not generic', () => {
  const cases: Array<[string, unknown[], string]> = [
    ['feature-state', ['hover'], 'Feature-state accessor'],
    ['within', [{ type: 'Polygon', coordinates: [[]] }], 'Within accessor'],
    ['resolved-locale', [['collator', {}]], 'resolved-locale accessor'],
    ['collator', [{}], 'collator object'],
    ['accumulated', [], 'Accumulated accessor'],
    ['heatmap-density', [], 'Heatmap density accessor'],
    ['line-progress', [], 'Line-progress accessor'],
    ['distance-from-center', [], 'Distance-from-center accessor'],
    // `pitch` was here — now SUPPORTED (lowers to a bare `pitch`
    // identifier, mirror of `zoom`); see expressions-pitch.test.ts.
    ['image', ['icon'], 'Image accessor'],
    ['is-supported-script', ['x'], 'is-supported-script accessor'],
    // Iter 544 additions:
    // `properties` was here — now SUPPORTED (lowers to a `properties()`
    // builtin returning the feature.properties object, mirror of the
    // `geometry-type` / `id` accessor pattern); see
    // expressions-properties.test.ts.
    ['distance', [{ type: 'Point', coordinates: [0, 0] }], 'Geometry distance accessor'],
  ]

  for (const [op, args, expectMessage] of cases) {
    it(`["${op}", …] → specific warning, returns null`, () => {
      const { result, warnings } = convert([op, ...args])
      expect(result).toBeNull()
      const matched = warnings.find(w => w.includes(`["${op}"]`) && w.includes(expectMessage))
      expect(matched, `expected warning matching "${expectMessage}" but got: ${JSON.stringify(warnings)}`).toBeDefined()
      // Must NOT fall through to the generic catch-all
      expect(warnings.some(w => w.startsWith('Expression not converted'))).toBe(false)
    })
  }

  it('truly unknown ops still get the generic catch-all', () => {
    // A spec extension or typo'd op falls through to the generic
    // warning. The catch-all is intentional for these.
    const { result, warnings } = convert(['some-future-op', 5])
    expect(result).toBeNull()
    expect(warnings[0]).toContain('Expression not converted')
  })
})
