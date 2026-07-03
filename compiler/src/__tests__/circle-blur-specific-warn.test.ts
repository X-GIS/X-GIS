// circle-blur is now supported (constant numeric form). This test verifies:
//  - A constant positive circle-blur emits a circle-blur-N utility (no gap warning).
//  - A layer without circle-blur produces no blur utility or warning.
//  - A zero-value circle-blur is a no-op (silent, no utility emitted).

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function outputOf(style: unknown): { src: string; warnings: string[] } {
  const coverage = { sources: [], layers: [] as never[], warnings: [] as string[] }
  const src = convertMapboxStyle(style as never, { coverage })
  return { src, warnings: coverage.warnings }
}

function buildCircle(paint: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'c',
        type: 'circle',
        source: 'v',
        'source-layer': 'a',
        paint: {
          'circle-color': '#000',
          'circle-stroke-color': '#000',
          'circle-stroke-width': 1,
          'circle-radius': 4,
          ...paint,
        },
      },
    ],
  }
}

describe('circle-blur supported (constant numeric)', () => {
  it('circle-blur: 0.5 → emits circle-blur-0.5 utility (no gap warning)', () => {
    const { src, warnings } = outputOf(buildCircle({ 'circle-blur': 0.5 }))
    // Utility must appear in the emitted xgis source.
    expect(src).toContain('circle-blur-0.5')
    // No old-style gap warning about Plan §4 / per-feature blur attr.
    expect(warnings.some((s) => s.includes('Plan §4') && s.includes('circle-blur'))).toBe(false)
    // Should NOT surface in the generic ignored-properties blob.
    expect(
      warnings.some((s) => s.includes('ignored properties') && s.includes('circle-blur')),
    ).toBe(false)
  })

  it('circle-blur: 0 → silent (no utility, no warning)', () => {
    const { src, warnings } = outputOf(buildCircle({ 'circle-blur': 0 }))
    expect(src).not.toContain('circle-blur')
    expect(warnings.some((s) => s.includes('circle-blur'))).toBe(false)
  })

  it('layer WITHOUT circle-blur → no utility, no warning', () => {
    const { src, warnings } = outputOf(buildCircle({}))
    expect(src).not.toContain('circle-blur')
    expect(warnings.some((s) => s.includes('circle-blur'))).toBe(false)
  })
})
