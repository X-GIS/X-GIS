// Iter 90: promote text-writing-mode + text-max-angle from generic
// ignoredText aggregator to specific layer-level warnings naming
// the runtime gap. Parallel to icon-color (iter 88) and icon-halo
// / icon-text-fit (iter 89).

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

describe('text-writing-mode + text-max-angle specific gap warnings', () => {
  it('text-writing-mode: ["vertical"] → specific warn', () => {
    const w = warningsOf(buildSymbol({ 'text-writing-mode': ['vertical'] }))
    expect(w.some(s =>
      s.includes('text-writing-mode')
      && s.includes('vertical text')
      && s.includes('Plan §4'),
    )).toBe(true)
  })

  it('text-writing-mode: ["horizontal", "vertical"] → specific warn', () => {
    const w = warningsOf(buildSymbol({ 'text-writing-mode': ['horizontal', 'vertical'] }))
    expect(w.some(s =>
      s.includes('text-writing-mode')
      && s.includes('Plan §4'),
    )).toBe(true)
  })

  it('text-writing-mode: ["horizontal"] (default) does NOT warn', () => {
    const w = warningsOf(buildSymbol({ 'text-writing-mode': ['horizontal'] }))
    expect(w.some(s => s.includes('text-writing-mode'))).toBe(false)
  })

  it('text-max-angle: 30 (non-default) → specific warn', () => {
    const w = warningsOf(buildSymbol({ 'text-max-angle': 30 }))
    expect(w.some(s =>
      s.includes('text-max-angle')
      && s.includes('Plan §4'),
    )).toBe(true)
  })

  it('text-max-angle: 45 (spec default) does NOT warn', () => {
    const w = warningsOf(buildSymbol({ 'text-max-angle': 45 }))
    expect(w.some(s => s.includes('text-max-angle'))).toBe(false)
  })

  it('layer without these properties does NOT warn', () => {
    const w = warningsOf(buildSymbol({}))
    expect(w.some(s =>
      s.includes('text-writing-mode')
      || s.includes('text-max-angle'),
    )).toBe(false)
  })
})
