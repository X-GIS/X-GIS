// Focused compiler test: circle-translate + circle-translate-anchor +
// circle-blur emit the expected utilities (or warn appropriately).
// Proves the converter emits these properties end-to-end.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function convert(paint: Record<string, unknown>): { src: string; warnings: string[] } {
  const coverage = { sources: [], layers: [] as never[], warnings: [] as string[] }
  const src = convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [{
      id: 'c',
      type: 'circle',
      source: 'v',
      'source-layer': 'p',
      paint: {
        'circle-color': '#ff0000',
        'circle-radius': 6,
        ...paint,
      },
    }],
  } as never, { coverage })
  return { src, warnings: coverage.warnings }
}

describe('circle-translate emit', () => {
  it('positive [dx, dy] → circle-translate-x-N circle-translate-y-M utilities', () => {
    const { src, warnings } = convert({ 'circle-translate': [5, 10] })
    expect(src).toContain('circle-translate-x-5')
    expect(src).toContain('circle-translate-y-10')
    expect(warnings.some(w => w.includes('dropped') || w.includes('no per-frame'))).toBe(false)
  })

  it('negative values use bracket form', () => {
    const { src } = convert({ 'circle-translate': [-3, -7] })
    expect(src).toContain('circle-translate-x-[-3]')
    expect(src).toContain('circle-translate-y-[-7]')
  })

  it('[0, 0] → no utility emitted (no-op default)', () => {
    const { src } = convert({ 'circle-translate': [0, 0] })
    expect(src).not.toContain('circle-translate-x')
    expect(src).not.toContain('circle-translate-y')
  })

  it('absent → no utility emitted', () => {
    const { src } = convert({})
    expect(src).not.toContain('circle-translate')
  })

  it('literal-wrapped form is handled', () => {
    const { src } = convert({ 'circle-translate': ['literal', [4, 8]] })
    expect(src).toContain('circle-translate-x-4')
    expect(src).toContain('circle-translate-y-8')
  })
})

describe('circle-translate-anchor emit', () => {
  it("viewport anchor with translate → no warning (spec default, honoured)", () => {
    const { warnings } = convert({
      'circle-translate': [2, 2],
      'circle-translate-anchor': 'viewport',
    })
    expect(warnings.some(w => w.includes('circle-translate-anchor'))).toBe(false)
  })

  it("map anchor with translate → warning (unsupported mode)", () => {
    const { warnings } = convert({
      'circle-translate': [2, 2],
      'circle-translate-anchor': 'map',
    })
    expect(warnings.some(w => w.includes('circle-translate-anchor'))).toBe(true)
  })

  it("anchor without translate → silent no-op", () => {
    const { warnings } = convert({ 'circle-translate-anchor': 'map' })
    expect(warnings.some(w => w.includes('circle-translate-anchor'))).toBe(false)
  })
})

describe('circle-blur emit', () => {
  it('positive value → circle-blur-N utility', () => {
    const { src, warnings } = convert({ 'circle-blur': 2 })
    expect(src).toContain('circle-blur-2')
    expect(warnings.some(w => w.includes('circle-blur') && w.includes('dropped'))).toBe(false)
  })

  it('fractional value → circle-blur-0.75 utility', () => {
    const { src } = convert({ 'circle-blur': 0.75 })
    expect(src).toContain('circle-blur-0.75')
  })

  it('0 → no utility (no-op default)', () => {
    const { src } = convert({ 'circle-blur': 0 })
    expect(src).not.toContain('circle-blur')
  })

  it('absent → no utility', () => {
    const { src } = convert({})
    expect(src).not.toContain('circle-blur')
  })

  it('negative value → clamped to 0, warning emitted', () => {
    const { src, warnings } = convert({ 'circle-blur': -1 })
    expect(src).not.toContain('circle-blur-')
    expect(warnings.some(w => w.includes('circle-blur') && w.includes('negative'))).toBe(true)
  })

  it('no gap warning about Plan §4 for a valid constant blur', () => {
    const { warnings } = convert({ 'circle-blur': 1 })
    expect(warnings.some(w => w.includes('Plan §4') && w.includes('circle-blur'))).toBe(false)
  })
})
