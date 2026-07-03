// Mapbox spec: text-font is "Array of strings" — each entry a font
// face name. A single string (typo'd as bare scalar instead of
// `["Noto Sans Regular"]`) silently falls through the Array.isArray
// gate, the authored font drops, and labels render with the runtime
// fallback font with no diagnostic. Iter 80 surfaces this gap.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function warningsOf(style: unknown): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style as never, { coverage })
  return coverage.warnings
}

function buildSymbolLayer(layout: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'lbl',
        type: 'symbol',
        source: 'v',
        'source-layer': 'a',
        layout: { 'text-field': '{name}', ...layout },
        paint: { 'text-color': '#000' },
      },
    ],
  }
}

describe('text-font not-array spec gate', () => {
  it('text-font as a single string warns', () => {
    const w = warningsOf(buildSymbolLayer({ 'text-font': 'Noto Sans Regular' }))
    expect(w.some((s) => s.includes('text-font') && s.includes('array of strings'))).toBe(true)
  })

  it('text-font as a number warns', () => {
    const w = warningsOf(buildSymbolLayer({ 'text-font': 12 }))
    expect(w.some((s) => s.includes('text-font') && s.includes('array of strings'))).toBe(true)
  })

  it('text-font as an object warns', () => {
    const w = warningsOf(buildSymbolLayer({ 'text-font': { family: 'X' } }))
    expect(w.some((s) => s.includes('text-font') && s.includes('array of strings'))).toBe(true)
  })

  it('text-font as a valid array does NOT warn', () => {
    const w = warningsOf(buildSymbolLayer({ 'text-font': ['Noto Sans Regular'] }))
    expect(w.some((s) => s.includes('text-font') && s.includes('array of strings'))).toBe(false)
  })

  it('text-font wrapped as `["literal", ["..."]]` (v8 strict) does NOT warn', () => {
    // The literal-tuple unwrap should peel the outer literal and
    // recognize the inner array as a valid font stack.
    const w = warningsOf(
      buildSymbolLayer({
        'text-font': ['literal', ['Noto Sans Regular']],
      }),
    )
    expect(w.some((s) => s.includes('text-font') && s.includes('array of strings'))).toBe(false)
  })
})
