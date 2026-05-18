// Mapbox `text-opacity` paint property: constant form is now folded
// into label-color's alpha channel during conversion (Phase B
// follow-up from the 2026-05-18 compat plan). Pre-fix the value
// silently dropped and labels rendered at full opacity regardless
// of the style's authored fade.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function symbolWith(paint: Record<string, unknown>, layout?: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { t: { type: 'vector', tiles: ['x'] } },
    layers: [{
      id: 'q',
      type: 'symbol',
      source: 't',
      'source-layer': 'p',
      layout: { 'text-field': '{name}', ...(layout ?? {}) },
      paint,
    }],
  }
}

function extractLabelColor(xgisSource: string): string | null {
  const m = xgisSource.match(/label-color-[^ \n]+/)
  return m ? m[0] : null
}

function hasWarning(xgisSource: string, sub: string): boolean {
  // Conversion notes are emitted as a trailing block comment.
  return xgisSource.includes(sub)
}

describe('text-opacity → label-color alpha fold (constant form)', () => {
  it('text-color: #fff + text-opacity: 0.5 → #ffffff80', () => {
    const out = convertMapboxStyle(symbolWith({
      'text-color': '#fff', 'text-opacity': 0.5,
    }) as Parameters<typeof convertMapboxStyle>[0])
    expect(extractLabelColor(out)).toBe('label-color-#ffffff80')
  })

  it('default text-color (#000) * text-opacity: 0.3 → #0000004d', () => {
    const out = convertMapboxStyle(symbolWith({
      'text-opacity': 0.3,
    }) as Parameters<typeof convertMapboxStyle>[0])
    expect(extractLabelColor(out)).toBe('label-color-#0000004d')
  })

  it('text-color: rgba(255,255,255,0.8) + text-opacity: 0.5 → #ffffff66', () => {
    // Composes: text-color alpha 0.8 × text-opacity 0.5 = 0.4
    // → 102/255 ≈ 0x66
    const out = convertMapboxStyle(symbolWith({
      'text-color': 'rgba(255,255,255,0.8)', 'text-opacity': 0.5,
    }) as Parameters<typeof convertMapboxStyle>[0])
    expect(extractLabelColor(out)).toBe('label-color-#ffffff66')
  })

  it('text-opacity: 1 is a no-op (passes hex through)', () => {
    const out = convertMapboxStyle(symbolWith({
      'text-color': '#abc', 'text-opacity': 1,
    }) as Parameters<typeof convertMapboxStyle>[0])
    expect(extractLabelColor(out)).toBe('label-color-#abc')
  })

  it('no text-opacity authored: text-color hex passes through unchanged', () => {
    const out = convertMapboxStyle(symbolWith({
      'text-color': '#abc',
    }) as Parameters<typeof convertMapboxStyle>[0])
    expect(extractLabelColor(out)).toBe('label-color-#abc')
  })

  it('constant text-opacity does NOT trigger the spurious "ignored property" warning', () => {
    const out = convertMapboxStyle(symbolWith({
      'text-color': '#fff', 'text-opacity': 0.5,
    }) as Parameters<typeof convertMapboxStyle>[0])
    expect(hasWarning(out, 'ignored properties (Batch 1d/1e+): text-opacity')).toBe(false)
    expect(hasWarning(out, 'ignored properties (Batch 1d/1e+)')).toBe(false)
  })

  it('non-constant text-opacity (zoom interp) still warns since alpha-fold needs constant', () => {
    const out = convertMapboxStyle(symbolWith({
      'text-color': '#fff',
      'text-opacity': ['interpolate', ['linear'], ['zoom'], 0, 1, 22, 0.5],
    }) as Parameters<typeof convertMapboxStyle>[0])
    // Color emits without folded alpha — the zoom interpolation
    // can't collapse to a single hex.
    expect(extractLabelColor(out)).toBe('label-color-#fff')
    expect(hasWarning(out, 'text-opacity')).toBe(true)
  })

  it('text-opacity = 0 collapses to fully transparent (#rrggbb00)', () => {
    const out = convertMapboxStyle(symbolWith({
      'text-color': '#fff', 'text-opacity': 0,
    }) as Parameters<typeof convertMapboxStyle>[0])
    expect(extractLabelColor(out)).toBe('label-color-#ffffff00')
  })
})
