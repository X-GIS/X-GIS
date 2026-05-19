// Iter 91: promote symbol-z-order + symbol-avoid-edges from generic
// ignoredText aggregator to specific layer-level warnings naming the
// runtime model dependency. Parallel to icon-color (iter 88),
// icon-halo / icon-text-fit (iter 89), text-writing-mode / text-max-
// angle (iter 90) promotions.

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

describe('symbol-z-order + symbol-avoid-edges specific gap warnings', () => {
  it('symbol-z-order: "viewport-y" → specific warn', () => {
    const w = warningsOf(buildSymbol({ 'symbol-z-order': 'viewport-y' }))
    expect(w.some(s =>
      s.includes('symbol-z-order')
      && s.includes('viewport-y')
      && s.includes('Plan §4'),
    )).toBe(true)
  })

  it('symbol-z-order: "source" → specific warn', () => {
    const w = warningsOf(buildSymbol({ 'symbol-z-order': 'source' }))
    expect(w.some(s =>
      s.includes('symbol-z-order')
      && s.includes('Plan §4'),
    )).toBe(true)
  })

  it('symbol-z-order: "auto" (default) does NOT warn', () => {
    const w = warningsOf(buildSymbol({ 'symbol-z-order': 'auto' }))
    expect(w.some(s => s.includes('symbol-z-order'))).toBe(false)
  })

  it('symbol-avoid-edges: true → specific warn (moot for cross-tile collision)', () => {
    const w = warningsOf(buildSymbol({ 'symbol-avoid-edges': true }))
    expect(w.some(s =>
      s.includes('symbol-avoid-edges')
      && s.includes('cross-tile collision'),
    )).toBe(true)
  })

  it('symbol-avoid-edges: false (default) does NOT warn', () => {
    const w = warningsOf(buildSymbol({ 'symbol-avoid-edges': false }))
    expect(w.some(s => s.includes('symbol-avoid-edges'))).toBe(false)
  })

  it('layer without these properties does NOT warn', () => {
    const w = warningsOf(buildSymbol({}))
    expect(w.some(s =>
      s.includes('symbol-z-order')
      || s.includes('symbol-avoid-edges'),
    )).toBe(false)
  })
})
