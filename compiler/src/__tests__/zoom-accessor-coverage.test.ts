// Pin Mapbox `["zoom"]` accessor lowering to the bare `zoom`
// identifier that the X-GIS evaluator special-cases. Pre-fix the
// converter only handled zoom via the dedicated paint-path
// (interpolateZoomCall); any `["zoom"]` nested inside a case /
// match / coalesce / arithmetic expression fell to "Expression not
// converted" and the containing expression collapsed to null.

import { describe, it, expect } from 'vitest'
import { exprToXgis, filterToXgis } from '../convert/expressions'

describe('["zoom"] accessor lowering', () => {
  it('bare ["zoom"] lowers to xgis `zoom` identifier', () => {
    const w: string[] = []
    expect(exprToXgis(['zoom'], w)).toBe('zoom')
    expect(w).toEqual([])
  })

  it('["zoom"] inside arithmetic emits inline identifier', () => {
    const w: string[] = []
    expect(exprToXgis(['*', ['zoom'], 2], w)).toBe('zoom * 2')
    expect(exprToXgis(['+', ['zoom'], -8], w)).toBe('zoom + -8')
  })

  it('["zoom"] inside a comparison routes for zoom-gate filters', () => {
    // Mapbox uses `[">=", ["zoom"], 14]` to gate labels by zoom.
    // Pre-fix the whole filter dropped because ["zoom"] returned null.
    const w: string[] = []
    expect(filterToXgis(['>=', ['zoom'], 14], w)).toBe('zoom >= 14')
  })

  it('["zoom"] inside ["case"] works as a condition input', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['case',
        ['<', ['zoom'], 10], '#aaa',
        ['<', ['zoom'], 14], '#bbb',
        '#ccc',
      ],
      w,
    )
    expect(out).toContain('zoom <')
    expect(out).toContain('"#ccc"')
  })

  it('["zoom"] inside ["coalesce"] passes through', () => {
    const w: string[] = []
    expect(exprToXgis(['coalesce', ['zoom'], 0], w)).toBe('zoom ?? 0')
  })
})
