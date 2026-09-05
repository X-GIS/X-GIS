// #2224 — `text-rotation-alignment: "viewport-glyph"` is spec-valid.
//
// The pinned @maplibre/maplibre-gl-style-spec defines FOUR values for the
// property (map | viewport | viewport-glyph | auto); the converter recognised
// three and rejected the fourth as "not a valid enum". That is worse than a
// wrong warning: rejecting it emitted NO utility, so the layer reached the
// runtime with `rotationAlignment` undefined and took the PLACEMENT default —
// `map` on a line layer, i.e. tangent-rotated AND ground-projected, while
// MapLibre keeps `pitchWithMap` false for the value and billboards it.
//
// The control arms are what keep this from being satisfied by a converter that
// accepts anything: a genuine typo must still warn and still emit nothing, and
// the three original values must be untouched.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function convert(layout: Record<string, unknown>): { src: string; warnings: string[] } {
  const warnings: string[] = []
  const src = convertMapboxStyle(
    {
      version: 8,
      sources: { s: { type: 'vector', url: 'https://example.com/tiles.json' } },
      layers: [
        {
          id: 'roads',
          type: 'symbol',
          source: 's',
          'source-layer': 'road',
          layout: { 'text-field': ['get', 'name'], 'symbol-placement': 'line', ...layout },
        },
      ],
    } as never,
    { coverage: { sources: [], layers: [], warnings } },
  )
  return { src, warnings }
}

const enumWarnings = (w: string[]): string[] =>
  w.filter((m) => m.includes('text-rotation-alignment') && m.includes('not a valid enum'))

describe('#2224 — the converter accepts the fourth rotation-alignment value', () => {
  it('FAIL-BEFORE: viewport-glyph emits its utility and warns nothing', () => {
    const { src, warnings } = convert({ 'text-rotation-alignment': 'viewport-glyph' })
    expect(src).toContain('label-rotation-alignment-viewport-glyph')
    expect(enumWarnings(warnings)).toEqual([])
  })

  it('the emitted utility is the four-value one, not the plain viewport utility', () => {
    // An exact-match pair, not a prefix pair — the lowering reads them as two
    // distinct utilities, so a `viewport-glyph` layer must NOT emit the
    // `-viewport` spelling that would resolve identically today but diverge the
    // moment the per-glyph residual is implemented.
    const { src } = convert({ 'text-rotation-alignment': 'viewport-glyph' })
    expect(src).not.toMatch(/label-rotation-alignment-viewport(?!-glyph)/)
  })

  it('control: the three original values are unchanged', () => {
    for (const v of ['map', 'viewport', 'auto'] as const) {
      const { src, warnings } = convert({ 'text-rotation-alignment': v })
      expect(src).toContain(`label-rotation-alignment-${v}`)
      expect(enumWarnings(warnings)).toEqual([])
    }
  })

  it('control: a typo still warns, still emits no utility, and names all four values', () => {
    const { src, warnings } = convert({ 'text-rotation-alignment': 'viewport-glyphs' })
    expect(src).not.toContain('label-rotation-alignment-')
    const hits = enumWarnings(warnings)
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('viewport-glyphs')
    expect(hits[0]).toContain("'map' | 'viewport' | 'viewport-glyph' | 'auto'")
  })

  it('control: an absent property emits nothing and warns nothing', () => {
    const { src, warnings } = convert({})
    expect(src).not.toContain('label-rotation-alignment-')
    expect(enumWarnings(warnings)).toEqual([])
  })
})
