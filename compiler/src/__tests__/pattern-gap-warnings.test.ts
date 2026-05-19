// Regression gate: every bitmap-pattern paint property emits a
// specific gap warning naming the Batch 2 sprite-atlas dependency,
// with TWO distinct messages depending on whether a colour fallback
// is also authored:
//   * pattern alone → empty layer / uncoloured walls
//   * pattern + colour → pattern dropped, colour fallback renders
//
// Catches a future refactor that re-buckets one of these into
// surfaceIgnoredPaint and loses the specificity. Covers iters
// 43 (line-pattern), 44 (fill-pattern), 45 (fill-extrusion-pattern).

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

interface Case {
  property: string
  layerType: string
  colourProp: string
  alone: { message: string }
  withColour: { message: string }
}

const CASES: Case[] = [
  { property: 'line-pattern', layerType: 'line', colourProp: 'line-color',
    alone:      { message: 'declared without line-color' },
    withColour: { message: 'set alongside line-color' } },
  { property: 'fill-pattern', layerType: 'fill', colourProp: 'fill-color',
    alone:      { message: 'declared without fill-color' },
    withColour: { message: 'set alongside fill-color' } },
  { property: 'fill-extrusion-pattern', layerType: 'fill-extrusion', colourProp: 'fill-extrusion-color',
    alone:      { message: 'declared without fill-extrusion-color' },
    withColour: { message: 'set alongside fill-extrusion-color' } },
]

function buildStyle(c: Case, includeColour: boolean): Record<string, unknown> {
  const paint: Record<string, unknown> = { [c.property]: 'my-pattern' }
  if (includeColour) paint[c.colourProp] = '#fff'
  if (c.layerType === 'fill-extrusion') paint['fill-extrusion-height'] = 10
  if (c.layerType === 'line') paint['line-width'] = 1
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [{
      id: 'l', type: c.layerType, source: 'v', 'source-layer': 'a', paint,
    }],
  }
}

describe('pattern-property gap warning specificity', () => {
  for (const c of CASES) {
    it(`${c.property} alone → "${c.alone.message}" warning`, () => {
      const coverage = { sources: [], layers: [], warnings: [] as string[] }
      convertMapboxStyle(buildStyle(c, false) as never, { coverage })
      const w = coverage.warnings.find(w => w.includes(c.alone.message))
      expect(w, `expected warning for ${c.property} alone`).toBeDefined()
      // Must NOT also surface via the generic ignored-properties blob.
      expect(coverage.warnings.some(
        w => w.includes('ignored paint properties') && w.includes(c.property),
      )).toBe(false)
    })

    it(`${c.property} + ${c.colourProp} → "${c.withColour.message}" warning`, () => {
      const coverage = { sources: [], layers: [], warnings: [] as string[] }
      convertMapboxStyle(buildStyle(c, true) as never, { coverage })
      const w = coverage.warnings.find(w => w.includes(c.withColour.message))
      expect(w, `expected warning for ${c.property} + colour`).toBeDefined()
      expect(coverage.warnings.some(
        w => w.includes('ignored paint properties') && w.includes(c.property),
      )).toBe(false)
    })
  }
})
