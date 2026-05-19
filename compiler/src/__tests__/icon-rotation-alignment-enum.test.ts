// Mapbox spec: icon-rotation-alignment enum is one of map / viewport
// / auto. Unknown values (typos like "MAP" / "screen") previously
// silently fell through to X-GIS' default (viewport-aligned icons)
// without diagnostic. Iter 81 surfaces this gap.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function warningsOf(style: unknown): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style as never, { coverage })
  return coverage.warnings
}

function buildSymbol(layout: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [{
      id: 'lbl',
      type: 'symbol',
      source: 'v',
      'source-layer': 'a',
      layout: { 'text-field': '{name}', ...layout },
      paint: { 'text-color': '#000' },
    }],
  }
}

describe('icon-rotation-alignment enum gate', () => {
  it('icon-rotation-alignment: "MAP" (case-typo) warns', () => {
    const w = warningsOf(buildSymbol({ 'icon-rotation-alignment': 'MAP' }))
    expect(w.some(s => s.includes('icon-rotation-alignment') && s.includes('MAP'))).toBe(true)
  })

  it('icon-rotation-alignment: "screen" (invalid) warns', () => {
    const w = warningsOf(buildSymbol({ 'icon-rotation-alignment': 'screen' }))
    expect(w.some(s => s.includes('icon-rotation-alignment') && s.includes('screen'))).toBe(true)
  })

  it('icon-rotation-alignment: "map" does NOT warn', () => {
    const w = warningsOf(buildSymbol({ 'icon-rotation-alignment': 'map' }))
    expect(w.some(s => s.includes('icon-rotation-alignment') && s.includes('not a valid enum'))).toBe(false)
  })

  it('icon-rotation-alignment: "viewport" does NOT warn', () => {
    const w = warningsOf(buildSymbol({ 'icon-rotation-alignment': 'viewport' }))
    expect(w.some(s => s.includes('icon-rotation-alignment') && s.includes('not a valid enum'))).toBe(false)
  })

  it('icon-rotation-alignment: "auto" does NOT warn', () => {
    const w = warningsOf(buildSymbol({ 'icon-rotation-alignment': 'auto' }))
    expect(w.some(s => s.includes('icon-rotation-alignment') && s.includes('not a valid enum'))).toBe(false)
  })
})
