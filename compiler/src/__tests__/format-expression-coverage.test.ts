// Pin Mapbox `["format", text1, opts1, text2, opts2, …]` lowering.
// X-GIS labels are one-style-per-layer, so we drop the per-span opts
// and concatenate the text. Pre-fix the whole format expression
// collapsed to null at "Expression not converted" and the symbol
// layer's text-field dropped silently — OFM Bright's road-shield +
// place-name layers use this shape for primary + secondary-locale
// text.

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'

describe('["format", …] expression lowering', () => {
  it('single (text, {}) pair drops to bare text', () => {
    const w: string[] = []
    const out = exprToXgis(['format', 'Hello', {}], w)
    expect(out).toBe('"Hello"')
    expect(w).toEqual([])
  })

  it('multi-span format concatenates text args', () => {
    // The typical Mapbox idiom for primary + fallback name:
    //   ["format", ["get", "name:en"], {}, " — ", {}, ["get", "name"], {}]
    const w: string[] = []
    const out = exprToXgis(
      ['format',
        ['get', 'name_en'], {},
        ' — ', {},
        ['get', 'name'], {},
      ],
      w,
    )
    expect(out).toBe('concat(.name_en, " — ", .name)')
    expect(w).toEqual([])
  })

  it('format with per-span opts warns once but still emits concat', () => {
    // Rich-text shape: span-level overrides dropped.
    const w: string[] = []
    const out = exprToXgis(
      ['format',
        'Big', { 'font-scale': 1.4, 'text-color': '#f00' },
        'small', {},
      ],
      w,
    )
    expect(out).toBe('concat("Big", "small")')
    expect(w.length).toBe(1)
    expect(w[0]).toMatch(/format.*options.*dropped/)
  })

  it('empty format args returns null', () => {
    const w: string[] = []
    expect(exprToXgis(['format'], w)).toBeNull()
  })

  it('odd-arity format (missing opts) warns and returns null', () => {
    const w: string[] = []
    const out = exprToXgis(['format', 'a', {}, 'b'], w)
    expect(out).toBeNull()
    expect(w[0]).toMatch(/text\+opts pairs required/)
  })

  it('format with a non-convertible inner expression bails to null', () => {
    // Inner returns null → whole format returns null. Caller
    // (textFieldToXgisExpr) treats that as "drop the label" so the
    // entire layer's text-field doesn't render with a half-converted
    // form.
    const w: string[] = []
    const out = exprToXgis(['format', ['nonexistent-op'], {}], w)
    expect(out).toBeNull()
  })
})
